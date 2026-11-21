"""Durable notification outbox for the explicitly authorised BEGONYA channel."""
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
from contextlib import contextmanager
import requests
from dotenv import dotenv_values

@contextmanager
def connect(path):
    c=sqlite3.connect(path,timeout=5);c.row_factory=sqlite3.Row;c.execute('PRAGMA journal_mode=WAL')
    try:
        with c:yield c
    finally:c.close()

class ReadingTelegram:
    def __init__(self,runtime,credential_file,enabled):
        self.runtime=Path(runtime);self.db=self.runtime/'reading_notifications.sqlite3';self.enabled=enabled
        self.stop=threading.Event();self.thread=None
        env=dotenv_values(credential_file) if enabled else {}
        self.token=env.get('TELEGRAM_BOT_TOKEN');self.chat=env.get('TELEGRAM_CHAT_ID')
        self.health={'state':'DISABLED' if not enabled else 'READY' if self.token and self.chat else 'CREDENTIALS_MISSING'}
        with connect(self.db) as c:
            c.execute('CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,text TEXT NOT NULL,state TEXT NOT NULL,created_ms INTEGER,updated_ms INTEGER,message_id INTEGER,http_status INTEGER,reason TEXT)')
            # Telegram has no client message-id idempotency key. An interrupted
            # in-flight request is uncertain; never automatically duplicate it.
            c.execute("UPDATE outbox SET state='UNKNOWN',reason='PROCESS_RESTART_DURING_SEND' WHERE state='SENDING'")
            self.known={r['id'] for r in c.execute('SELECT id FROM outbox')}
    def has(self,key):return key in self.known
    def enqueue(self,key,text):
        if self.has(key):return
        now=time.time_ns()//1000000
        with connect(self.db) as c:c.execute('INSERT OR IGNORE INTO outbox(id,text,state,created_ms,updated_ms) VALUES(?,?,?,?,?)',(key,text,'PENDING',now,now))
        self.known.add(key)
    def start(self):
        if self.enabled and self.token and self.chat:
            self.thread=threading.Thread(target=self.supervised_run,name='ReadingTelegram',daemon=True);self.thread.start()
    def supervised_run(self):
        try:self.run()
        except Exception as e:self.health={'state':'WORKER_FAILED','reason':type(e).__name__}
    def run(self):
        while not self.stop.wait(1.1):
            with connect(self.db) as c:
                row=c.execute("SELECT * FROM outbox WHERE state='PENDING' ORDER BY created_ms LIMIT 1").fetchone()
                if not row:continue
                c.execute("UPDATE outbox SET state='SENDING',updated_ms=? WHERE id=?",(time.time_ns()//1000000,row['id']))
            state='UNKNOWN';reason=None;http=None;mid=None;retry_after=0
            try:
                response=requests.post('https://api.telegram.org/bot'+self.token+'/sendMessage',
                    json={'chat_id':self.chat,'text':row['text'],'disable_web_page_preview':True},timeout=(5,10))
                http=response.status_code
                try:body=response.json()
                except ValueError:body={}
                if http==200 and body.get('ok') is True and isinstance(body.get('result',{}).get('message_id'),int):
                    state='DELIVERED';mid=body['result']['message_id']
                elif body.get('ok') is False:
                    if body.get('error_code')==429:
                        state='PENDING';reason='RATE_LIMIT_RETRY_LATER';retry_after=min(300,max(1,body.get('parameters',{}).get('retry_after',5)))
                    else:state='FAILED';reason='TELEGRAM_API_REJECTED_'+str(body.get('error_code',http))
                else:reason='UNCONFIRMED_HTTP_RESPONSE'
            except requests.RequestException as e:
                # Do not log exception URLs, which contain bot credentials.
                reason=type(e).__name__+'_DELIVERY_UNCERTAIN'
            now=time.time_ns()//1000000
            with connect(self.db) as c:c.execute('UPDATE outbox SET state=?,updated_ms=?,message_id=?,http_status=?,reason=? WHERE id=?',(state,now,mid,http,reason,row['id']))
            audit={'observed_utc_ms':now,'notification_id':row['id'],'state':state,'http_status':http,
                'ok':state=='DELIVERED','message_id':mid,'reason':reason,
                'message_sha256':hashlib.sha256(row['text'].encode()).hexdigest()}
            with (self.runtime/'reading_telegram_delivery.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(audit,separators=(',',':'))+'\n')
            self.health={'state':state,'last_notification_id':row['id'],'last_success_ms':now if state=='DELIVERED' else None,'reason':reason}
            if retry_after:self.stop.wait(retry_after)
    def status(self):
        with connect(self.db) as c:
            counts={r['state']:r['n'] for r in c.execute('SELECT state,count(*) n FROM outbox GROUP BY state')}
            last=c.execute("SELECT updated_ms,message_id,http_status FROM outbox WHERE state='DELIVERED' ORDER BY updated_ms DESC LIMIT 1").fetchone()
        return {**self.health,'outbox':counts,'last_confirmed_delivery':dict(last) if last else None}
    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(timeout=16)
