"""Validate exporter events and build per-contract tape windows; no routing or inferred MBO."""
from collections import Counter,deque
import math
import re
from forex_routes import route
from reading_patterns import snapshot as pattern_snapshot

class NinjaFeed:
    def __init__(self,source='NINJATRADER_DESKTOP',source_label='NINJATRADER_CME_FUTURES_PROXY',waiting='WAITING_NINJATRADER_DATA'):
        self.source=source;self.source_label=source_label;self.waiting=waiting
        self.windows={};self.sessions={};self.last_sequence={};self.last_heartbeat=None
        self.faults=Counter();self.last_gap_ms=None;self.duplicates=0
        # Quote decisions use an earlier as-of time than the end of a polled batch.
        # Keep control events too: the newest heartbeat/reset must not rewrite that past.
        self.control_history=deque(maxlen=20000)

    def mark_gap(self,stamp):
        self.last_gap_ms=stamp
        self.control_history.append((stamp,'gap',stamp))

    def control_asof(self,kind,now):
        for stamp,key,value in reversed(self.control_history):
            if key==kind and stamp<=now:return value
        return None

    def ingest(self,e,now):
        if e.get('schema')!=1 or e.get('source')!=self.source:
            self.faults['INVALID_SOURCE']+=1;return
        stamp=e.get('received_utc_ms');session=e.get('session_id');seq=e.get('sequence')
        if not isinstance(stamp,(int,float)) or not math.isfinite(stamp) or stamp>now or not isinstance(session,str) or not isinstance(seq,int):
            self.faults['INVALID_TIMESTAMP_OR_SEQUENCE']+=1;return
        previous=self.last_sequence.get(session)
        if previous is not None and seq<=previous:self.duplicates+=1;return
        if previous is not None and seq!=previous+1:
            self.faults['SEQUENCE_GAP']+=1;self.mark_gap(stamp)
        self.last_sequence[session]=seq
        if e['kind']=='heartbeat':
            self.last_heartbeat=stamp
            self.control_history.append((stamp,'heartbeat',stamp))
            if e.get('dropped_total',0):self.mark_gap(stamp);self.faults['EXPORTER_DROPPED_MESSAGES']+=1
        if e['kind'] in {'reset','session_start','session_stop'}:
            self.mark_gap(stamp)
            if e['kind']=='session_stop':
                self.last_heartbeat=None
                self.control_history.append((stamp,'heartbeat',None))
        root=e.get('root');contract=e.get('contract')
        if not root or not contract:return
        if root not in {'6E','6B','6A','6N','6J','6C','6S','GC'} or not re.fullmatch(re.escape(root)+r' (0[1-9]|1[0-2])-\d{2}',contract):
            self.faults['CONTRACT_ROOT_OR_EXPIRY_INVALID']+=1;return
        if self.sessions.get(root) not in [None,(session,contract)]:
            self.windows[root]=deque();self.mark_gap(stamp);self.faults['CONTRACT_OR_SESSION_CHANGE']+=1
        self.sessions[root]=(session,contract)
        if e['kind'] not in {'bid','ask','trade','depth_delta','depth_snapshot','quote'}:return
        if e['kind'] in {'trade','bid','ask'}:
            if not all(isinstance(e.get(k),(float,int)) and math.isfinite(e[k]) for k in ['price','volume']) or e['price']<=0 or e['volume']<0:
                self.faults['INVALID_PRICE_OR_VOLUME']+=1;return
        window=self.windows.setdefault(root,deque());window.append(e)
        while window and window[0]['received_utc_ms']<now-120000:window.popleft()
        if len(window)>100000:
            window.popleft();self.mark_gap(stamp);self.faults['ROOT_EVENT_CAP_REACHED']+=1

    def snapshot(self,symbol,now):
        mapping=route(symbol)
        base={'schema':1,'generated_utc_ms':now,'target':symbol,'mapping':mapping,
              'source':self.source_label,'tape_features_usable':False,
              'research_pressure':'UNKNOWN','execution_allowed':False,'edge_proven':False,
              'faults':dict(self.faults),'duplicate_events_excluded':self.duplicates}
        if mapping['mode']!='DIRECT_FUTURES_PROXY':
            return {**base,'state':mapping['mode'],'reasons':[mapping.get('reason','No direct tape')],
                'reading_patterns':{'state':'UNAVAILABLE_NO_DIRECT_TAPE','absorption_candidates':[],
                    'liquidity_pulls':{'state':'UNAVAILABLE_NO_DIRECT_TAPE','candidates':[]},'source_usable':False}}
        rows=[r for r in self.windows.get(mapping['root'],[]) if now-60000<=r['received_utc_ms']<=now]
        trades=[r for r in rows if r['kind']=='trade'];buy=sell=unknown=0;live_labels=set()
        for r in trades:
            live_labels.add(r.get('feed_label'))
            side=self.classify(r)
            if side=='BUY':buy+=r['volume']
            elif side=='SELL':sell+=r['volume']
            else:unknown+=r['volume']
        reasons=[]
        if not rows:reasons.append(self.waiting)
        heartbeat=self.control_asof('heartbeat',now)
        gap=self.control_asof('gap',now)
        if heartbeat is None or not 0<=now-heartbeat<=10000:reasons.append('BRIDGE_HEARTBEAT_NOT_FRESH')
        if gap is not None and 0<=now-gap<60000:reasons.append('GAP_RESET_OR_CONTRACT_CHANGE_IN_WINDOW')
        if len(trades)<5:reasons.append('INSUFFICIENT_TRADES')
        if not trades or now-trades[-1]['received_utc_ms']>5000:reasons.append('TRADES_NOT_FRESH')
        reasons.extend(self.feed_mode_reasons(trades,now))
        total=buy+sell+unknown;known=buy+sell
        if total==0 or known/total<.8:reasons.append('AGGRESSOR_CLASSIFICATION_INCOMPLETE')
        reasons.extend(self.quality_reasons(rows,now))
        imbalance=(buy-sell)/known if known else None
        if mapping['inverse'] and imbalance is not None:imbalance=-imbalance
        pressure='UNKNOWN' if imbalance is None else 'BUY' if imbalance>=.3 else 'SELL' if imbalance<=-.3 else 'NEUTRAL'
        patterns=pattern_snapshot(self.windows.get(mapping['root'],[]),now,self.classify,mapping['inverse'],not reasons)
        return {**base,'state':'RESEARCH_FEATURES_READY' if not reasons else 'DATA_NOT_READY',
            'contract':rows[-1].get('contract') if rows else None,'reasons':reasons,
            'tape_features_usable':not reasons,'research_pressure':pressure,
            'trade_events':len(trades),'buy_contracts':buy,'sell_contracts':sell,'unknown_side_contracts':unknown,
            'known_side_fraction':known/total if total else None,'signed_quantity_imbalance':imbalance,
            'aggressor_method':self.aggressor_method,
            'depth_events':sum(r['kind']=='depth_delta' for r in rows),'mbo_available':False,
            'reading_patterns':patterns,
            'execution_blockers':['FUTURES_SPOT_BASIS_AND_CLOCK_UNVALIDATED','FEED_ENTITLEMENT_NOT_VERIFIED',
                                  'SLIPPAGE_AND_COMMISSION_UNMEASURED'],
            'absorption_confirmed':False,'spoofing_identified':False}

    aggressor_method='TRADE_PRICE_VS_REPORTED_BBO_INFERENCE_NOT_EXCHANGE_FLAG'
    def classify(self,r):
        bid,ask=r.get('bid'),r.get('ask')
        if isinstance(bid,(int,float)) and isinstance(ask,(int,float)) and 0<bid<ask:
            return 'BUY' if r['price']>=ask else 'SELL' if r['price']<=bid else None
        return None

    def quality_reasons(self,rows,now):
        return []

    def feed_mode_reasons(self,trades,now):
        return [] if {r.get('feed_label') for r in trades}=={'LIVE'} else ['LIVE_FEED_MODE_NOT_DECLARED']
