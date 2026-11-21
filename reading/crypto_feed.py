"""Same-venue crypto trade/BBO validation and automatic reading features."""
from collections import Counter,deque
from reading_patterns import snapshot as patterns,number
WALL_MIN_UNITS={
    'BTCUSDT':.01,'ETHUSDT':.1,'SOLUSDT':1.,'XRPUSDT':100.,
    'LTCUSDT':2.,'BNBUSDT':.2,'SUIUSDT':100.,'AVAXUSDT':10.,'NEARUSDT':30.,'APTUSDT':150.,
    'SEIUSDT':2000.,'ARBUSDT':500.,'OPUSDT':1000.,'ADAUSDT':500.,'DASHUSDT':2.,'BCHUSDT':.5,
    'LINKUSDT':10.,'DOTUSDT':100.,'FETUSDT':500.,'RENDERUSDT':50.,'TAOUSDT':.5,'VIRTUALUSDT':200.,
    'WLDUSDT':300.,'ARKMUSDT':1000.,'IOUSDT':800.,'UNIUSDT':15.,'AAVEUSDT':1.,'PENDLEUSDT':50.,
    'INJUSDT':10.,'CHZUSDT':10000.,'RVNUSDT':50000.,'GALAUSDT':50000.,'SANDUSDT':2000.,
    'DOGEUSDT':1000.,'PEPEUSDT':10000000.,'SHIBUSDT':10000000.,'WIFUSDT':500.,'BONKUSDT':20000000.,
    'FLOKIUSDT':5000000.,'PENGUUSDT':15000.
}

class CryptoFeed:
    def __init__(self,symbols):
        self.symbols=dict(symbols);self.rows={s:deque() for s in symbols};self.quotes={};self.ids={};self.depth_ids={};self.gaps={};self.faults=Counter();self.pattern_cache={}
    def ingest(self,e,now):
        stamp=e.get('received_utc_ms')
        if e.get('source')!='BINANCE_SPOT_PUBLIC' or not number(stamp) or stamp>now:
            self.faults['INVALID_SOURCE_OR_FUTURE']+=1;return None
        if e.get('kind')=='reset':
            for s in self.symbols:
                self.rows[s].clear();self.quotes.pop(s,None);self.gaps[s]=stamp;self.ids.pop(s,None);self.depth_ids.pop(s,None);self.pattern_cache.pop(s,None)
            return None
        s=e.get('symbol')
        if s not in self.symbols or e.get('venue_symbol')!=self.symbols[s]:self.faults['WRONG_MARKET']+=1;return None
        if e.get('kind')=='trade':
            if not all(number(e.get(k)) and e[k]>0 for k in ['price','volume']) or e.get('aggressor') not in {'BUY','SELL'}:
                self.faults['INVALID_TRADE']+=1;return None
            tid=e.get('trade_id');previous=self.ids.get(s)
            if not isinstance(tid,int) or (previous is not None and tid<=previous):self.faults['DUPLICATE_OR_REORDERED_TRADE']+=1;return None
            if previous is not None and tid!=previous+1:self.gaps[s]=stamp;self.faults['TRADE_ID_GAP']+=1;self.pattern_cache.pop(s,None)
            self.ids[s]=tid
            if not number(e.get('exchange_utc_ms')) or not -2000<=stamp-e['exchange_utc_ms']<=2000:
                self.gaps[s]=stamp;self.faults['EXCHANGE_TIME_NOT_ALIGNED']+=1;return None
            e={**e,'sequence':tid,'root':s,'contract':self.symbols[s]};self.rows[s].append(e)
            while self.rows[s] and self.rows[s][0]['received_utc_ms']<now-120000:self.rows[s].popleft()
            if len(self.rows[s])>100000:self.rows[s].popleft();self.gaps[s]=stamp;self.faults['TRADE_WINDOW_CAP']+=1
        elif e.get('kind')=='depth_snapshot':
            uid=e.get('depth_update_id');previous=self.depth_ids.get(s)
            if not isinstance(uid,int) or (previous is not None and uid<=previous):return None
            if e.get('depth_semantics')!='AGGREGATED_CONTIGUOUS_PRICE_LEVELS' or e.get('depth_stream_verified') is not True:return None
            for key,reverse in [('bids',True),('asks',False)]:
                values=e.get(key,[])
                if not 3<=len(values)<=20 or not all(isinstance(v,list) and len(v)==2 and all(number(x) and x>0 for x in v) for v in values):
                    self.faults['INVALID_DEPTH_SNAPSHOT']+=1;return None
                prices=[v[0] for v in values]
                if len(set(prices))!=len(prices) or prices!=sorted(prices,reverse=reverse):
                    self.faults['INVALID_DEPTH_ORDER']+=1;return None
            if e['bids'][0][0]>=e['asks'][0][0]:self.faults['CROSSED_DEPTH']+=1;return None
            self.depth_ids[s]=uid
            self.rows[s].append({**e,'root':s,'contract':self.symbols[s],'sequence':uid})
            while self.rows[s] and self.rows[s][0]['received_utc_ms']<now-120000:self.rows[s].popleft()
            if len(self.rows[s])>100000:self.rows[s].popleft();self.gaps[s]=stamp;self.pattern_cache.pop(s,None);self.faults['DEPTH_WINDOW_CAP']+=1
        elif e.get('kind')=='quote':
            if not all(number(e.get(k)) and e[k]>0 for k in ['bid','ask']) or e['ask']<e['bid']:
                self.faults['INVALID_QUOTE']+=1;return None
            previous=self.quotes.get(s)
            if previous and e['update_id']<=previous['update_id']:return None
            self.quotes[s]=e
            return {'kind':'crypto_quote_tick','received_utc_ms':stamp,'data':{'symbol':s,'bid':e['bid'],'ask':e['ask'],
                'venue_symbol':e['venue_symbol'],'market':'BINANCE_SPOT','quote_asset':'USDT','timestamp_source':e['timestamp_source']}}
        return None
    def snapshot(self,symbol,now,health,include_patterns=True):
        rows=[r for r in self.rows[symbol] if now-120000<=r['received_utc_ms']<=now]
        recent=[r for r in rows if r['kind']=='trade' and now-60000<=r['received_utc_ms']];reasons=[]
        if health.get('connection')!='CONNECTED' or not 0<=now-health.get('updated_utc_ms',0)<=10000:reasons.append('CRYPTO_CONNECTION_NOT_FRESH')
        clock=health.get('clock') or {}
        if not number(clock.get('server_minus_local_midpoint_ms')) or abs(clock['server_minus_local_midpoint_ms'])>2000 or clock.get('rtt_ms',99999)>2000 or not 0<=now-clock.get('measured_utc_ms',0)<=60000:
            reasons.append('CRYPTO_CLOCK_NOT_VALIDATED')
        if symbol not in self.gaps or now-self.gaps[symbol]<60000:reasons.append('CRYPTO_WARMUP_OR_GAP')
        if len(recent)<5 or not recent or now-recent[-1]['received_utc_ms']>5000:reasons.append('CRYPTO_TRADES_NOT_FRESH')
        quote=self.quotes.get(symbol)
        if not quote or not 0<=now-quote['received_utc_ms']<=2000:reasons.append('CRYPTO_BBO_NOT_FRESH')
        buy=sum(r['volume'] for r in recent if r['aggressor']=='BUY');sell=sum(r['volume'] for r in recent if r['aggressor']=='SELL')
        imbalance=(buy-sell)/(buy+sell) if buy+sell else None
        cached=self.pattern_cache.get(symbol)
        if not include_patterns:
            pattern_features={'version':'READING_PATTERNS_V1','generated_utc_ms':now,'source_usable':not reasons,
                'state':'NOT_EVALUATED_NO_APPROVED_SETUP','speed':{'state':'NOT_EVALUATED_NO_APPROVED_SETUP','detected':False},
                'absorption_candidates':[],'response_flow':{'usable':False,'direction':'UNKNOWN'},
                'liquidity_pulls':{'state':'NOT_EVALUATED_NO_APPROVED_SETUP','candidates':[]},
                'execution_allowed':False,'edge_proven':False}
        elif cached and 0<=now-cached['generated_utc_ms']<500 and cached['source_usable']==(not reasons):
            pattern_features=cached
        else:
            pattern_features=patterns(rows,now,lambda r:r['aggressor'],source_usable=not reasons,
                protocol={'wall_min_contracts':WALL_MIN_UNITS.get(self.symbols[symbol],1.),'pull_settle_ms':500})
            pattern_features['liquidity_pulls']['quantity_unit']='BASE_ASSET_NOT_FUTURES_CONTRACTS'
            self.pattern_cache[symbol]=pattern_features
        return {'schema':1,'generated_utc_ms':now,'source':'BINANCE_SPOT_PUBLIC','state':'RESEARCH_FEATURES_READY' if not reasons else 'DATA_NOT_READY',
            'bbo_age_ms':now-quote['received_utc_ms'] if quote else None,
            'last_trade_age_ms':now-recent[-1]['received_utc_ms'] if recent else None,
            'target':symbol,'market_identity':{'market':'BINANCE_SPOT','venue_symbol':self.symbols[symbol],'strategy_alias':symbol,'quote_asset':'USDT','broker_usd_execution_equivalent':False},
            'tape_features_usable':not reasons,'trade_events':len(recent),'signed_quantity_imbalance':imbalance,
            'research_pressure':'UNKNOWN' if imbalance is None else 'BUY' if imbalance>=.3 else 'SELL' if imbalance<=-.3 else 'NEUTRAL',
            'reading_patterns':pattern_features,
            'reasons':reasons,'faults':dict(self.faults),'execution_allowed':False,'edge_proven':False,
            'execution_blockers':['RESEARCH_ONLY_NO_ORDER_ROUTING','BINANCE_SPOT_USDT_NOT_BROKER_USD','FILLS_FEES_SLIPPAGE_UNMEASURED']}
