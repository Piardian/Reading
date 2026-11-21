"""Observed-BBO shadow ledger. Not fills, broker PnL or assumed trading costs."""
import hashlib
import json
import sqlite3
import time
import math
from reading_telegram import connect
from trade_management import management_plan,POLICY

def summarize_records(values):
    closed=[v for v in values if v['state']=='CLOSED']
    gross=sum(v['gross_r'] for v in closed if v.get('gross_r') is not None)
    partial=sum(v.get('realized_r',0) for v in values if v['state']!='CLOSED')
    usd_closed=sum(v['gross_r']*v['management']['risk_usd'] for v in closed if v.get('gross_r') is not None and v.get('management'))
    usd_partial=sum(v.get('realized_r',0)*v['management']['risk_usd'] for v in values if v['state']!='CLOSED' and v.get('management'))
    return {'total':len(values),'open':sum(v['state']=='OPEN' for v in values),'closed':len(closed),
        'tp':sum(v.get('outcome')=='TP' for v in closed),'sl':sum(v.get('outcome')=='SL' for v in closed),
        'be':sum(v.get('outcome')=='BE' for v in closed),'unresolved':sum(v['state']=='UNRESOLVED' for v in values),
        'gross_r':gross,'gross_profit_r':sum(max(v['gross_r'],0) for v in closed if v.get('gross_r') is not None),
        'gross_loss_r':sum(min(v['gross_r'],0) for v in closed if v.get('gross_r') is not None),
        'tp1_hits':sum(bool(v.get('tp1_done')) for v in values),'partial_realized_r_not_closed':partial,
        'realized_total_gross_r':gross+partial,'closed_model_gross_usd':usd_closed,
        'realized_model_gross_usd':usd_closed+usd_partial,'usd_unavailable_records':sum(not bool(v.get('management')) for v in values),
        'commission':None,'slippage':None,'net_pnl':None,'broker_verified':False}

class ShadowLedger:
    def __init__(self,runtime,notifier,management=None,max_quote_gap_ms=60000):
        self.path=runtime/'reading_shadow.sqlite3';self.notifier=notifier
        self.max_quote_gap_ms=max_quote_gap_ms
        if management is not None and management!=POLICY:raise ValueError('UNSUPPORTED_MANAGEMENT_POLICY')
        self.management=management;self.policy_since=0
        with connect(self.path) as c:
            c.execute('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)')
            c.execute('INSERT OR IGNORE INTO meta VALUES(?,?)',('created_ms',str(time.time_ns()//1000000)))
            self.created=int(c.execute("SELECT value FROM meta WHERE key='created_ms'").fetchone()[0])
            if management:
                c.execute('INSERT OR IGNORE INTO meta VALUES(?,?)',(management['version']+'_since_ms',str(time.time_ns()//1000000)))
                self.policy_since=int(c.execute('SELECT value FROM meta WHERE key=?',(management['version']+'_since_ms',)).fetchone()[0])
            c.execute('CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY,symbol TEXT,state TEXT,data TEXT)')
        self.open={r['id']:json.loads(r['data']) for r in self.read_all() if r['state']=='OPEN'}
        self.last_saved={};self.last_recovery=0
    def read_all(self):
        with connect(self.path) as c:return c.execute('SELECT * FROM trades').fetchall()
    def summary(self):
        return summarize_records([json.loads(r['data']) for r in self.read_all()])
    def save(self,t):
        with connect(self.path) as c:c.execute('UPDATE trades SET state=?,data=? WHERE id=?',(t['state'],json.dumps(t),t['id']))
    def register(self,trackers,now):
        for tracker in trackers:
            for s in tracker.state['setups'].values():
                if s['state']!='RESEARCH_ENTRY_PROPOSAL':continue
                ref=s.get('reference_observations',{}).get('reading_proposal',{})
                stamp=ref.get('observed_utc_ms',0)
                if stamp<max(self.created,self.policy_since):continue # no retrospective signals or fabricated entries
                if not 0<=now-stamp<=2000 or not 0<=now-ref.get('quote_received_utc_ms',0)<=2000:
                    continue # entry and exit accounting must use the same fresh-quote contract
                tid=hashlib.sha256((tracker.symbol+'|'+s['id']).encode()).hexdigest()[:24]
                t={'id':tid,'symbol':tracker.symbol,'setup_id':s['id'],'state':'OPEN','direction':s['direction'],
                    'entry':ref['entry_quote'],'stop':s['stop'],'target':s['target'],'opened_ms':stamp,
                    'last_quote_ms':ref['quote_received_utc_ms'],'risk':abs(ref['entry_quote']-s['stop']),
                    'scope':'OBSERVED_BBO_SHADOW_NOT_FILLED','gross_r':None,'net_pnl':None,'commission':None,'slippage':None}
                if not all(math.isfinite(t[k]) and t[k]>0 for k in ['entry','stop','target','risk']):continue
                if not (t['stop']<t['entry']<t['target'] if t['direction']=='long' else t['target']<t['entry']<t['stop']):continue
                if self.management:
                    try:m=management_plan(s,t['entry'],self.management)
                    except ValueError:continue
                    t.update(management=m,target=m['tp2'],initial_stop=t['stop'],tp1=m['tp1'],
                        remaining_fraction=1.,realized_r=0.,tp1_done=False)
                with connect(self.path) as c:
                    inserted=c.execute('INSERT OR IGNORE INTO trades VALUES(?,?,?,?)',(tid,tracker.symbol,'OPEN',json.dumps(t))).rowcount
                if inserted:self.open[tid]=t
        # Stable outbox keys also recover a crash between the ledger insert and enqueue.
        for t in self.open.values():
            key='reading-open-'+t['id']
            if not self.notifier.has(key):self.notifier.enqueue(key,self.message(t,False))
    def quote(self,symbol,event,now):
        received=event.get('received_utc_ms',0);q=event.get('data',{})
        if not 0<=now-received<=2000:return
        if event.get('kind') in {'broker_quote_tick','xauusd_broker_tick'} and not -2000<=now-q.get('time_msc',0)<=2000:return
        bid,ask=q.get('bid'),q.get('ask')
        if not isinstance(bid,(int,float)) or not isinstance(ask,(int,float)) or not 0<bid<=ask:return
        for tid,t in list(self.open.items()):
            if t['symbol']!=symbol or received<=t['last_quote_ms'] or received<t['opened_ms']:continue
            if received-t['last_quote_ms']>self.max_quote_gap_ms:
                self.finish(t,'UNRESOLVED','DATA_GAP',None,now);continue
            t['last_quote_ms']=received
            price=bid if t['direction']=='long' else ask
            stop=price<=t['stop'] if t['direction']=='long' else price>=t['stop']
            tp=price>=t['target'] if t['direction']=='long' else price<=t['target']
            if stop or tp:
                outcome='TP' if tp else 'BE' if t['stop']==t['entry'] else 'SL'
                if t.get('management') and tp and not t['tp1_done']:self.partial(t,price,now)
                self.finish(t,'CLOSED',outcome,price,now)
            elif t.get('management') and not t['tp1_done'] and (price>=t['tp1'] if t['direction']=='long' else price<=t['tp1']):
                self.partial(t,price,now)
            elif now-self.last_saved.get(tid,0)>=1000:self.save(t);self.last_saved[tid]=now

    def partial(self,t,price,now):
        if t['tp1_done']:return
        fraction=t['management']['partial_fraction'];sign=1 if t['direction']=='long' else -1
        t.update(tp1_done=True,tp1_quote=price,tp1_ms=now,remaining_fraction=1.-fraction,
            realized_r=fraction*(price-t['entry'])*sign/t['risk'],stop=t['entry'])
        self.save(t)
        self.notifier.enqueue('reading-partial-'+t['id'],self.partial_message(t))
    def advance(self,now):
        for t in list(self.open.values()):
            if now-t['last_quote_ms']>self.max_quote_gap_ms:self.finish(t,'UNRESOLVED','DATA_GAP',None,now)
        # Recover close notifications after a restart without duplicate sends.
        if now-self.last_recovery>=5000:
            for row in self.read_all():
                t=json.loads(row['data']);key='reading-close-'+t['id']
                if t.get('tp1_done') and not self.notifier.has('reading-partial-'+t['id']):
                    self.notifier.enqueue('reading-partial-'+t['id'],self.partial_message(t))
                if t['state']!='OPEN' and not self.notifier.has(key):self.notifier.enqueue(key,self.message(t,True))
            self.last_recovery=now
    def finish(self,t,state,outcome,price,now):
        t.update(state=state,outcome=outcome,closed_ms=now,exit_quote=price)
        if price is not None:
            leg=(price-t['entry'])*(1 if t['direction']=='long' else -1)/t['risk']
            t['gross_r']=t.get('realized_r',0)+t.get('remaining_fraction',1)*leg
            if t.get('management'):t['model_gross_usd']=t['gross_r']*t['management']['risk_usd']
        self.save(t);self.open.pop(t['id'],None)
        self.notifier.enqueue('reading-close-'+t['id'],self.message(t,True))
    def message(self,t,closed):
        s=self.summary();header='READING — GÖLGE İŞLEM '+('SONUÇ' if closed else 'AÇILIŞ')
        result=('\nSonuç: '+t.get('outcome','')+' | Brüt: '+(f"{t['gross_r']:+.3f}R" if t.get('gross_r') is not None else 'ölçülemedi')) if closed else ''
        if t.get('management'):
            m=t['management'];model=(f"\nModel brüt: ${t['model_gross_usd']:+.2f}" if t.get('model_gross_usd') is not None else '')
            return (header+'\n'+t['symbol']+' '+t['direction'].upper()+
                f"\nVarsayımsal ilk risk: ${m['risk_usd']:.2f}\nGiriş: {t['entry']} | İlk SL: {t['initial_stop']} | Güncel SL: {t['stop']}"+
                f"\nTP1: {t['tp1']} (+1R, %50); kalan SL girişe\nTP2: {t['target']} (likidite, {m['target_rr']:.2f}R)"+result+model+
                f"\nToplam gerçekleşmiş model brüt: ${s['realized_model_gross_usd']:+.2f}"+
                f"\nTP1: {s['tp1_hits']} | TP2: {s['tp']} | SL: {s['sl']} | Kalan BE: {s['be']} | Belirsiz: {s['unresolved']} | Açık: {s['open']}"+
                '\nKomisyon: ölçülmedi\nKayma: ölçülmedi\nGerçek net toplam: ölçülmedi\nGölge kotasyon modeli; gerçek emir, dolum veya lot hesabı değildir. BE kalan yarının stopudur; toplam sonuç sıfır olmayabilir.')
        return (header+'\n'+t['symbol']+' '+t['direction'].upper()+
            f"\nGiriş referansı: {t['entry']}\nSL: {t['stop']} | TP1: {t['target']}"+result+
            f"\n\nToplam gölge kayıt: {s['total']} | Açık: {s['open']}\nTP: {s['tp']} | SL: {s['sl']} | BE: {s['be']} | Belirsiz: {s['unresolved']}"+
            f"\nToplam kotasyon bazlı brüt: {s['gross_r']:+.3f}R\nKomisyon: ölçülmedi\nKayma: ölçülmedi\nGerçek net toplam: ölçülmedi"+
            '\nGerçek emir/dolum değildir. Spread referans fiyatlarda bulunur; BE taşıma kapalı. TP1 ilk gözlenen kotasyonda tam kapanış modeli.')

    def partial_message(self,t):
        amount=t['realized_r']*t['management']['risk_usd']
        return ('READING — GÖLGE TP1 / BE\n'+t['symbol']+' '+t['direction'].upper()+
            f"\n%50 kapanış referansı: {t['tp1_quote']}\nGerçekleşmiş model brüt: {t['realized_r']:+.3f}R / ${amount:+.2f}"+
            f"\nKalan %50 SL → giriş: {t['stop']}\nTP2 likidite hedefi: {t['target']}"+
            '\nGerçek emir/dolum değildir. Komisyon, kayma ve gerçek net ölçülmedi.')
