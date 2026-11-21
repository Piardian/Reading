"""Venue-specific tape features. PAXG is a proxy, never global XAUUSD order flow."""
from collections import deque
import json
import math
from pathlib import Path


class TapeEngine:
    def __init__(self, window_ms=60000, min_trades=5, threshold=.3):
        self.window_ms = window_ms
        self.min_trades = min_trades
        self.threshold = threshold
        self.events = deque()
        self.trade_ids = set()
        self.future_rejected = 0
        self.invalid_rejected = 0

    def ingest(self, event, now_ms):
        received = event.get('received_utc_ms')
        if not isinstance(received, (int, float)) or received > now_ms:
            self.future_rejected += 1
            return
        if received < now_ms - self.window_ms:
            return
        kind = event.get('kind')
        if kind not in {'paxg_agg_trade', 'paxg_depth5', 'stream_session', 'trade_gap',
                        'trade_sequence_error', 'health_error', 'clock_check'}:
            return
        if kind == 'paxg_agg_trade':
            try:
                raw = event['data']['raw']
                if raw.get('s') != 'PAXGUSDT' or not isinstance(raw.get('m'), bool):
                    raise ValueError('Wrong source')
                if not all(math.isfinite(float(raw[k])) and float(raw[k]) > 0 for k in ['p', 'q']):
                    raise ValueError('Bad price/size')
                key = raw['a']
            except (KeyError, TypeError, ValueError):
                self.invalid_rejected += 1
                return
            if key in self.trade_ids:
                return
            self.trade_ids.add(key)
        self.events.append(event)

    def snapshot(self, now_ms, recorder_status):
        # Filtering rather than relying on monotone source-file ordering also excludes late/future rows.
        self.events = deque(e for e in self.events if now_ms-self.window_ms <= e['received_utc_ms'] <= now_ms)
        self.trade_ids = {e['data']['raw']['a'] for e in self.events if e['kind']=='paxg_agg_trade'}
        rows = sorted(self.events, key=lambda e:e['received_utc_ms'])
        trades = [e for e in rows if e['kind']=='paxg_agg_trade']
        depths = [e for e in rows if e['kind']=='paxg_depth5']
        gaps = [e for e in rows if e['kind'] in {'stream_session','trade_gap','trade_sequence_error','health_error'}]
        buy = sum(float(e['data']['raw']['q']) for e in trades if not e['data']['raw']['m'])
        sell = sum(float(e['data']['raw']['q']) for e in trades if e['data']['raw']['m'])
        total=buy+sell
        imbalance=(buy-sell)/total if total else None
        direction='INSUFFICIENT_TRADES'
        if len(trades)>=self.min_trades and imbalance is not None:
            direction='BUY' if imbalance>=self.threshold else 'SELL' if imbalance<=-self.threshold else 'NEUTRAL'
        book_imbalance=None;spread=None;book_error=None
        if depths:
            try:
                raw=depths[-1]['data']['raw']
                bids=[(float(p),float(q)) for p,q in raw['bids']]
                asks=[(float(p),float(q)) for p,q in raw['asks']]
                if not bids or not asks or not all(math.isfinite(p) and math.isfinite(q) and p>0 and q>=0 for p,q in bids+asks):
                    raise ValueError('Invalid book')
                spread=asks[0][0]-bids[0][0]
                if spread<0:raise ValueError('Crossed book')
                b=sum(q for p,q in bids);a=sum(q for p,q in asks)
                book_imbalance=(b-a)/(b+a) if b+a else None
            except (KeyError,TypeError,ValueError) as e:
                book_error=str(e);book_imbalance=None;spread=None
        heartbeat_age=(now_ms-recorder_status.get('updated_utc_ms',0))/1000
        depth_age=(now_ms-depths[-1]['received_utc_ms'])/1000 if depths else None
        reasons=[]
        if recorder_status.get('state')!='RUNNING' or not 0<=heartbeat_age<=15:reasons.append('RECORDER_NOT_FRESH')
        if not recorder_status.get('paxg_ws_connected'):reasons.append('PAXG_DISCONNECTED')
        if depth_age is None or depth_age>5:reasons.append('DEPTH_NOT_FRESH')
        if book_error:reasons.append('INVALID_BOOK')
        if gaps:reasons.append('GAP_OR_SESSION_TRANSITION_IN_WINDOW')
        if len(trades)<self.min_trades:reasons.append('INSUFFICIENT_TRADE_EVENTS')
        xau_age=recorder_status.get('xauusd_last_tick_age_seconds')
        if isinstance(xau_age,(int,float)):
            xau_age += max(0,heartbeat_age)
        xau_fresh=isinstance(xau_age,(int,float)) and -2<=xau_age<=2 and recorder_status.get('mt5_connected',False)
        if not xau_fresh:reasons.append('XAU_QUOTE_NOT_FRESH')
        reasons+=['PROXY_TO_XAU_NOT_VALIDATED','BROKER_CLOCK_NOT_VALIDATED','USDT_USD_BASIS_NOT_VALIDATED']
        return {
            'schema':1,'generated_utc_ms':now_ms,'cutoff_received_utc_ms':now_ms,
            'window_start_utc_ms':now_ms-self.window_ms,'window_ms':self.window_ms,
            'source':'BINANCE_SPOT_PAXGUSDT_PROXY','target':'XAUUSD',
            'aggregate_trade_events':len(trades),'buy_quantity_paxg':buy,'sell_quantity_paxg':sell,
            'signed_quantity_imbalance':imbalance,
            'aggregate_events_per_second':len(trades)/(self.window_ms/1000),
            'research_pressure':direction,'top5_quantity_imbalance':book_imbalance,
            'top_of_book_spread_usdt':spread,
            'trade_price_change_usdt':float(trades[-1]['data']['raw']['p'])-float(trades[0]['data']['raw']['p']) if len(trades)>=2 else None,
            'paxg_depth_age_seconds':depth_age,'source_heartbeat_age_seconds':heartbeat_age,
            'xau_quote_age_seconds':xau_age,'reasons':reasons,
            'paxg_features_usable':not any(r in reasons for r in ['RECORDER_NOT_FRESH','PAXG_DISCONNECTED','DEPTH_NOT_FRESH','INVALID_BOOK','GAP_OR_SESSION_TRANSITION_IN_WINDOW','INSUFFICIENT_TRADE_EVENTS']),
            'xau_confirmation_valid':False,'order_routing':False,'signals_enabled':False,
            'edge_proven':False,'absorption':'NOT_IDENTIFIABLE_FROM_THIS_DATA',
            'future_rows_rejected':self.future_rejected,'invalid_rows_rejected':self.invalid_rejected}


class LogTail:
    def __init__(self, directory,initial_max_bytes=None):
        self.directory=Path(directory)
        self.offsets={}
        self.initial_max_bytes=initial_max_bytes;self.bootstrap_skipped_bytes=0

    def poll(self):
        # Only current and previous UTC day can affect a 60-second feature window.
        paths=sorted(self.directory.glob('*.jsonl'))[-2:]
        rows=[]
        for path in paths:
            offset=self.offsets.get(str(path),0)
            if path.stat().st_size<offset:raise RuntimeError('Source log truncated; refused silent reset')
            with path.open('rb') as f:
                if str(path) not in self.offsets and self.initial_max_bytes and path.stat().st_size>self.initial_max_bytes:
                    f.seek(-self.initial_max_bytes,2);f.readline()
                    self.bootstrap_skipped_bytes+=f.tell()
                else:f.seek(offset)
                while True:
                    start=f.tell();line=f.readline()
                    if not line:break
                    if not line.endswith(b'\n'):
                        f.seek(start);break
                    rows.append(json.loads(line))
                self.offsets[str(path)]=f.tell()
        return rows
