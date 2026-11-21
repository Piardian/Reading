"""Public Binance SPOT data only. No keys, account methods, trades or broker routing."""
import asyncio
from datetime import datetime,timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import threading
import time
import uuid
import requests
import websockets

TF={'1m':60000,'15m':900000,'1h':3600000,'4h':14400000}
API='https://data-api.binance.vision/api/v3'
SUPPORTED_CRYPTO_VENUES={
    'BTCUSDT','ETHUSDT','LTCUSDT','SOLUSDT','BNBUSDT',
    'SUIUSDT','AVAXUSDT','NEARUSDT','APTUSDT','SEIUSDT','ARBUSDT','OPUSDT',
    'XRPUSDT','ADAUSDT','DASHUSDT','BCHUSDT','LINKUSDT','DOTUSDT',
    'FETUSDT','RENDERUSDT','TAOUSDT','VIRTUALUSDT','WLDUSDT','ARKMUSDT','IOUSDT',
    'UNIUSDT','AAVEUSDT','PENDLEUSDT','INJUSDT','CHZUSDT','RVNUSDT','GALAUSDT','SANDUSDT',
    'DOGEUSDT','PEPEUSDT','SHIBUSDT','WIFUSDT','BONKUSDT','FLOKIUSDT','PENGUUSDT',
    'ZECUSDT','ENAUSDT','TRXUSDT','HBARUSDT','ONDOUSDT',
    'FILUSDT','ZROUSDT','ICPUSDT','POLUSDT','CAKEUSDT',
    'STRKUSDT','RAYUSDT','BLURUSDT','TIAUSDT','CRVUSDT',
    'ALGOUSDT','ATOMUSDT','MANAUSDT','AXSUSDT','DYDXUSDT',
    'JTOUSDT','PYTHUSDT','JUPUSDT','RUNEUSDT','KAVAUSDT',
}

def atomic(path,data):
    tmp=path.with_suffix('.tmp')
    try:
        tmp.write_text(json.dumps(data,separators=(',',':')),encoding='utf-8')
    except Exception:
        return
    for i in range(15):
        try:
            os.replace(tmp,path)
            return
        except (PermissionError,OSError):
            time.sleep(.02*(i+1))
    try:
        path.write_text(json.dumps(data,separators=(',',':')),encoding='utf-8')
        tmp.unlink(missing_ok=True)
    except Exception:
        pass

def closed_candles(raw,server_now,interval):
    out=[]
    for x in raw:
        if int(x[6])>=server_now:continue
        if int(x[6])!=int(x[0])+interval-1:raise ValueError('CANDLE_INTERVAL_INVALID')
        bar={'timestamp':int(x[0]),'open':float(x[1]),'high':float(x[2]),'low':float(x[3]),'close':float(x[4]),'volume':float(x[5])}
        if not 0<bar['low']<=min(bar['open'],bar['close'])<=max(bar['open'],bar['close'])<=bar['high']:raise ValueError('CANDLE_OHLC_INVALID')
        if out and bar['timestamp']!=out[-1]['timestamp']+interval:raise ValueError('CANDLE_HISTORY_GAP')
        out.append(bar)
    if not out or out[-1]['timestamp']!=(server_now//interval-1)*interval:raise ValueError('LATEST_CLOSED_CANDLE_MISSING')
    return out[-500:]

class CryptoLive:
    def __init__(self,symbols,runtime):
        if not symbols or any(v not in SUPPORTED_CRYPTO_VENUES for v in symbols.values()):raise ValueError('Unsupported crypto universe')
        self.symbols=dict(symbols);self.runtime=Path(runtime);self.inputs=self.runtime/'crypto_inputs';self.raw=self.runtime/'crypto_raw'
        self.inputs.mkdir(parents=True,exist_ok=True);self.raw.mkdir(parents=True,exist_ok=True)
        self.events=queue.Queue(100000);self.stop=threading.Event();self.thread=None;self.lock=threading.Lock()
        self.state={'connection':'STARTING','updated_utc_ms':0,'clock':None,'errors':{},'counts':{},'candles':{},'source':'BINANCE_SPOT_PUBLIC','order_routing':False}
        self.writer=None;self.day=None;self.last_flush=0;self.last_budget=0;self.disk_bytes=0
        self.last_raw_write={}
        self.raw_path=None;self.raw_opened=0;self.raw_rotate_due=False
        self.http=requests.Session()
        adapter=requests.adapters.HTTPAdapter(pool_connections=16,pool_maxsize=16)
        self.http.mount('https://',adapter);self.http.mount('http://',adapter)
    def start(self):
        self.thread=threading.Thread(target=lambda:asyncio.run(self.run()),name='ReadingPublicCrypto',daemon=True);self.thread.start()
    def health(self):
        with self.lock:return json.loads(json.dumps(self.state))
    def update(self,**kw):
        with self.lock:self.state.update(kw,updated_utc_ms=time.time_ns()//1000000)
    def error(self,key,error):
        with self.lock:self.state['errors'][key]=str(error)[:300]
    def clear_error(self,key):
        with self.lock:self.state['errors'].pop(key,None)
    def emit(self,e):
        e={'source':'BINANCE_SPOT_PUBLIC','schema':1,**e}
        try:
            self.events.put_nowait(e)
        except queue.Full:
            try:
                for _ in range(1000):
                    self.events.get_nowait()
                self.events.put_nowait(e)
                self.error('queue','CRYPTO_EVENT_QUEUE_RELIEVED')
            except Exception:
                pass
        with self.lock:
            key=e['kind'];self.state['counts'][key]=self.state['counts'].get(key,0)+1
        now=time.time()
        if e['kind'] in {'depth_snapshot','quote'}:
            rk=(e.get('symbol',''),e['kind'])
            if now-self.last_raw_write.get(rk,0)<1.0:return
            self.last_raw_write[rk]=now
        day=datetime.now(timezone.utc).strftime('%Y-%m-%d')
        if now-self.last_budget>2:
            self.disk_bytes=sum(p.stat().st_size for p in self.raw.glob('*.gz'))
            if self.disk_bytes>2*1024**3:
                archive_raw = self.runtime.parent / 'historical_archive' / 'crypto_raw'
                archive_raw.mkdir(parents=True, exist_ok=True)
                for f in list(self.raw.glob('*.gz')):
                    if not f.name.startswith(day) and (not self.raw_path or f.name != self.raw_path.name):
                        try: shutil.move(str(f), str(archive_raw / f.name))
                        except Exception: pass
                self.disk_bytes=sum(p.stat().st_size for p in self.raw.glob('*.gz'))
            if self.disk_bytes>5*1024**3 or shutil.disk_usage(self.raw).free<2*1024**3:raise RuntimeError('CRYPTO_STORAGE_BUDGET_STOP')
            if self.raw_path and self.raw_path.exists() and self.raw_path.stat().st_size>=64*1024**2:self.raw_rotate_due=True
            self.last_budget=now
        if self.day!=day or now-self.raw_opened>=300 or self.raw_rotate_due:
            if self.writer:self.writer.close()
            self.raw_path=self.raw/(day+'.part'+str(time.time_ns())+'.jsonl.gz')
            self.writer=gzip.open(self.raw_path,'xb',compresslevel=1);self.day=day;self.raw_opened=now;self.raw_rotate_due=False
            with self.lock:self.state['raw_storage']={'mode':'ROTATING_GZIP_64MIB_OR_5MIN','total_budget_bytes':5*1024**3,
                'active_file':self.raw_path.name,'raw_bbo_depth_sampling_ms':1000,'all_trades_recorded':True}
        self.writer.write((json.dumps(e,separators=(',',':'))+'\n').encode())
        if now-self.last_flush>=1:self.writer.flush();self.last_flush=now
    def poll(self):
        events=[]
        for _ in range(100000):
            try:events.append(self.events.get_nowait())
            except queue.Empty:break
        return events
    def get(self,path,params=None):
        r=self.http.get(API+path,params=params,timeout=10);r.raise_for_status();return r.json()
    async def _fetch_one_history(self,sem,alias,venue,tf,interval,offset_ms):
        async with sem:
            if self.stop.is_set():return
            for attempt in range(2):
                raw=await asyncio.to_thread(self.get,'/klines',{'symbol':venue,'interval':tf,'limit':501})
                now_srv=int(time.time_ns()//1000000+offset_ms)
                try:
                    bars=closed_candles(raw,now_srv,interval);break
                except ValueError:
                    if attempt==1:raise
                    srv_resp=await asyncio.to_thread(self.get,'/time')
                    offset_ms=int(srv_resp['serverTime'])-time.time_ns()//1000000
            path=self.inputs/(alias+'_'+tf+'.json')
            atomic(path,bars)
            meta={'fetched_utc_ms':time.time_ns()//1000000,'venue_symbol':venue,'strategy_alias':alias,
                'quote_asset':'USDT','market':'BINANCE_SPOT','timeframe':tf,'closed_only':True,
                'last_closed_open_ms':bars[-1]['timestamp'],'bars':len(bars),
                'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            atomic(path.with_suffix('.meta.json'),meta)
            with self.lock:self.state['candles'][alias+'_'+tf]=meta
    async def histories(self):
        sem=asyncio.Semaphore(8)
        while not self.stop.is_set():
            try:
                before=time.time_ns()//1000000;server=int((await asyncio.to_thread(self.get,'/time'))['serverTime']);after=time.time_ns()//1000000
                offset_ms=server-(before+after)/2
                self.update(clock={'server_minus_local_midpoint_ms':offset_ms,'rtt_ms':after-before,'measured_utc_ms':after})
                tasks=[]
                for alias,venue in self.symbols.items():
                    for tf,interval in TF.items():
                        now_srv=int(time.time_ns()//1000000+offset_ms)
                        latest=(now_srv//interval-1)*interval
                        with self.lock:old=self.state['candles'].get(alias+'_'+tf,{})
                        if old.get('last_closed_open_ms')==latest:continue
                        tasks.append(self._fetch_one_history(sem,alias,venue,tf,interval,offset_ms))
                if tasks:
                    await asyncio.gather(*tasks)
                self.clear_error('history')
            except Exception as e:self.error('history',type(e).__name__+': '+str(e))
            for _ in range(15):
                if self.stop.is_set():return
                await asyncio.sleep(1)
    async def streams(self):
        reverse={v:k for k,v in self.symbols.items()}
        streams='/'.join(v.lower()+suffix for v in self.symbols.values() for suffix in ['@trade','@bookTicker','@depth20@100ms'])
        url='wss://data-stream.binance.vision/stream?streams='+streams
        while not self.stop.is_set():
            sid=uuid.uuid4().hex
            try:
                async with websockets.connect(url,open_timeout=15,close_timeout=3,ping_interval=20,max_queue=16384) as ws:
                    self.update(connection='CONNECTED',session_id=sid);self.clear_error('websocket')
                    self.emit({'kind':'reset','session_id':sid,'received_utc_ms':time.time_ns()//1000000})
                    while not self.stop.is_set():
                        try:message=await asyncio.wait_for(ws.recv(),timeout=1)
                        except asyncio.TimeoutError:continue
                        received=time.time_ns()//1000000;message=json.loads(message);data=message['data']
                        stream=message['stream'];venue=data.get('s') or stream.split('@')[0].upper()
                        if venue not in reverse:continue
                        alias=reverse[venue]
                        if data.get('e')=='trade':
                            e={'kind':'trade','symbol':alias,'venue_symbol':venue,'session_id':sid,'received_utc_ms':received,
                                'trade_id':int(data['t']),'exchange_utc_ms':int(data['E']),'transaction_utc_ms':int(data['T']),
                                'price':float(data['p']),'volume':float(data['q']),'aggressor':'SELL' if data['m'] else 'BUY'}
                        elif stream.endswith('@depth20@100ms'):
                            e={'kind':'depth_snapshot','symbol':alias,'venue_symbol':venue,'session_id':sid,'received_utc_ms':received,
                                'depth_update_id':int(data['lastUpdateId']),
                                'bids':[[float(p),float(q)] for p,q in data['bids']],
                                'asks':[[float(p),float(q)] for p,q in data['asks']],
                                'depth_semantics':'AGGREGATED_CONTIGUOUS_PRICE_LEVELS','depth_stream_verified':True,
                                'depth_scope':'BINANCE_SPOT_TOP_20_PRICE_LEVELS_NOT_MBO',
                                'timestamp_source':'LOCAL_RECEIPT_TIME_NO_EXCHANGE_TIMESTAMP_IN_PARTIAL_DEPTH'}
                        elif stream.endswith('@bookTicker'):
                            e={'kind':'quote','symbol':alias,'venue_symbol':venue,'session_id':sid,'received_utc_ms':received,
                                'update_id':int(data['u']),'bid':float(data['b']),'ask':float(data['a']),
                                'bid_size':float(data['B']),'ask_size':float(data['A']),
                                'timestamp_source':'LOCAL_RECEIPT_TIME_NO_EXCHANGE_TIMESTAMP_IN_BOOKTICKER'}
                        else:continue
                        self.emit(e)
            except Exception as e:
                self.error('websocket',type(e).__name__+': '+str(e));self.update(connection='DISCONNECTED')
                self.emit({'kind':'reset','session_id':sid,'received_utc_ms':time.time_ns()//1000000})
                if 'STORAGE' in str(e):self.stop.set();return
                await asyncio.sleep(3)
    async def run(self):
        jobs=[asyncio.create_task(self.histories()),asyncio.create_task(self.streams())]
        try:
            while not self.stop.is_set():
                if any(t.done() for t in jobs):
                    for t in jobs:
                        if t.done() and t.exception():self.error('worker',str(t.exception()))
                    self.stop.set();break
                self.update();await asyncio.sleep(1)
        finally:
            for job in jobs:job.cancel()
            await asyncio.gather(*jobs,return_exceptions=True)
            if self.writer:self.writer.close()
            self.update(connection='STOPPED')
    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(timeout=15)
