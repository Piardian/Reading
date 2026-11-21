"""Causal receipt-time tape patterns; hypotheses, not market intent or execution."""
import hashlib
import math
from bisect import bisect_left,bisect_right
from statistics import median

PROTOCOL={
    'version':'READING_PATTERNS_V1',
    'recent_ms':5000,'baseline_ms':30000,'min_baseline_events':10,
    'min_recent_events':5,'event_rate_multiple':1.5,'volume_rate_multiple':1.3,
    'min_known_volume_fraction':.8,'aggressor_dominance':.60,
    'stall_max_range_bps':8.0,'response_flow_ms':5000,'response_min_events':2,
    'response_imbalance':.2,'pattern_lifetime_ms':60000,
    'depth_warmup_ms':30000,'min_depth_baseline_values':20,
    'wall_multiple':3.0,'wall_min_contracts':20,'wall_max_lifetime_ms':3000,
    'wall_remaining_fraction':.2,'max_executed_fraction':.2,
    'threshold_status':'PREDECLARED_RESEARCH_NOT_OPTIMIZED_NOT_EDGE_PROOF'}

def number(v):
    return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)

def direction(side,inverse):
    return ('SELL' if side=='BUY' else 'BUY') if inverse else side

def identity(row,kind):
    text='|'.join(str(row.get(k,'')) for k in ('session_id','root','contract','sequence'))+'|'+kind
    return hashlib.sha256(text.encode()).hexdigest()[:24]

def flow(trades,classify,inverse):
    buy=sell=unknown=0
    for e in trades:
        side=classify(e)
        if side=='BUY':buy+=e['volume']
        elif side=='SELL':sell+=e['volume']
        else:unknown+=e['volume']
    known=buy+sell;total=known+unknown
    imbalance=(buy-sell)/known if known else None
    if inverse and imbalance is not None:imbalance=-imbalance
    return {'buy':buy,'sell':sell,'unknown':unknown,'total':total,
        'known_fraction':known/total if total else 0,'imbalance':imbalance}

def snapshot(rows,now,classify,inverse=False,source_usable=False,protocol=None):
    p={**PROTOCOL,**(protocol or {})}
    # Every feature is recomputed as of this decision, so appending future rows
    # cannot change it. The feed validator owns source/session/sequence checks.
    rows=sorted((r for r in rows if number(r.get('received_utc_ms')) and now-120000<=r['received_utc_ms']<=now),
        key=lambda r:(r['received_utc_ms'],r.get('sequence',0)))
    trades=[r for r in rows if r.get('kind')=='trade' and number(r.get('price')) and r['price']>0 and number(r.get('volume')) and r['volume']>0]
    cutoff=now-p['recent_ms'];start=cutoff-p['baseline_ms']
    baseline=[r for r in trades if start<=r['received_utc_ms']<cutoff]
    recent=[r for r in trades if cutoff<=r['received_utc_ms']<=now]
    b=flow(baseline,classify,inverse);r=flow(recent,classify,inverse)
    baseline_rate=len(baseline)/(p['baseline_ms']/1000);recent_rate=len(recent)/(p['recent_ms']/1000)
    rate_ratio=recent_rate/baseline_rate if baseline_rate else None
    expected_volume=b['total']*p['recent_ms']/p['baseline_ms']
    volume_ratio=r['total']/expected_volume if expected_volume else None
    coverage=bool(trades) and trades[0]['received_utc_ms']<=start
    enough=coverage and len(baseline)>=p['min_baseline_events'] and len(recent)>=p['min_recent_events']
    observed_burst=bool(enough and rate_ratio>=p['event_rate_multiple'] and volume_ratio>=p['volume_rate_multiple'])
    speed={'state':'DATA_NOT_READY' if not enough else 'BURST_CANDIDATE' if observed_burst else 'NO_BURST',
        'detected':observed_burst and source_usable,'observed_pattern':observed_burst,
        'baseline_events':len(baseline),'recent_events':len(recent),'event_rate_ratio':rate_ratio,
        'volume_rate_ratio':volume_ratio,'window_start_utc_ms':cutoff,'window_end_utc_ms':now,
        'clock':'LOCAL_RECEIPT_TIME_NOT_EXCHANGE_LATENCY'}
    absorptions=[]
    if recent:
        prices=[e['price'] for e in recent]
        span=(max(prices)-min(prices))/prices[0]*10000
        raw=flow(recent,classify,False)
        dominant='BUY' if raw['buy']>=raw['sell'] else 'SELL'
        dominant_fraction=max(raw['buy'],raw['sell'])/(raw['buy']+raw['sell']) if raw['buy']+raw['sell'] else 0
        if observed_burst and r['known_fraction']>=p['min_known_volume_fraction'] and dominant_fraction>=p['aggressor_dominance'] and span<=p['stall_max_range_bps']:
            passive='SELL' if dominant=='BUY' else 'BUY'
            absorptions.append({'id':identity(recent[-1],'ABSORPTION_CANDIDATE'),
                'kind':'ABSORPTION_CANDIDATE','direction':direction(passive,inverse),
                'aggressor_direction':direction(dominant,inverse),'usable':bool(source_usable),
                'window_start_utc_ms':recent[-1]['received_utc_ms'],'detected_utc_ms':recent[-1]['received_utc_ms'],
                'valid_until_utc_ms':recent[-1]['received_utc_ms']+p['pattern_lifetime_ms'],'range_bps':span,
                'dominant_known_volume_fraction':dominant_fraction,'known_volume_fraction':r['known_fraction'],
                'trade_events':len(recent),'volume':r['total'],'event_rate_ratio':rate_ratio,
                'volume_rate_ratio':volume_ratio,'confirmed':False,
                'meaning':'AGGRESSIVE_FLOW_WITH_LOW_PRICE_RANGE_NOT_PROOF_OF_PASSIVE_ABSORPTION'})
    response=[e for e in trades if now-p['response_flow_ms']<=e['received_utc_ms']<=now]
    rf=flow(response,classify,inverse)
    enough_response=len(response)>=p['response_min_events'] and rf['known_fraction']>=p['min_known_volume_fraction']
    pressure='UNKNOWN' if not enough_response else 'BUY' if rf['imbalance']>=p['response_imbalance'] else 'SELL' if rf['imbalance']<=-p['response_imbalance'] else 'NEUTRAL'
    pulls=depth_pulls(rows,trades,now,inverse,p,source_usable)
    return {'version':p['version'],'generated_utc_ms':now,'source_usable':bool(source_usable),
        'speed':speed,'absorption_candidates':absorptions,
        'response_flow':{'direction':pressure,'usable':bool(source_usable and enough_response),
            'events':len(response),'known_volume_fraction':rf['known_fraction'],'signed_imbalance':rf['imbalance'],
            'window_start_utc_ms':now-p['response_flow_ms'],'window_end_utc_ms':now},
        'liquidity_pulls':pulls,'absorption_confirmed':False,'spoofing_confirmed':False,
        'execution_allowed':False,'edge_proven':False}

def depth_pulls(rows,trades,now,inverse,p,source_usable):
    depth=[e for e in rows if e.get('kind') in {'depth_delta','depth_snapshot'}]
    if not depth:return {'state':'UNAVAILABLE_NO_LEVEL2','candidates':[],'confirmed':False}
    # Deltas do not establish whether Size refers to one order, one LP or a
    # whole price level. Do not invent an order book from that ambiguity.
    depth_lookback=p['depth_warmup_ms']+p['wall_max_lifetime_ms']+p['pattern_lifetime_ms']+p.get('pull_settle_ms',0)+2000
    snapshots=[e for e in depth if e['received_utc_ms']>=now-depth_lookback and e.get('kind')=='depth_snapshot'
        and e.get('depth_semantics')=='AGGREGATED_CONTIGUOUS_PRICE_LEVELS'
        and e.get('depth_stream_verified') is True]
    if not snapshots:return {'state':'UNAVAILABLE_DEPTH_SEMANTICS_UNVERIFIED','candidates':[],'confirmed':False}
    # Price/time prefix sums keep repeated full-book scans bounded. A slow scan
    # must not turn a fresh quote into an old entry input.
    executions={}
    for trade in trades:
        times,quantities=executions.setdefault(trade['price'],([], [0]))
        times.append(trade['received_utc_ms']);quantities.append(quantities[-1]+trade['volume'])
    previous={};pending={};sizes=[];out=[];first=snapshots[0]['received_utc_ms'];last_valid=None;warmed=False
    for e in snapshots:
        stamp=e['received_utc_ms'];current={};bands={};valid=True
        for side,key in [('BUY','bids'),('SELL','asks')]:
            values=e.get(key)
            if not isinstance(values,list) or len(values)<3:valid=False;break
            valid_rows=all(isinstance(v,list) and len(v)==2 and all(number(x) and x>0 for x in v) for v in values)
            if not valid_rows:valid=False;break
            prices=[v[0] for v in values]
            if len(set(prices))!=len(prices) or prices!=sorted(prices,reverse=side=='BUY'):valid=False;break
            bands[side]=(min(prices),max(prices))
            for price,size in values:current[(side,price)]=size
        if not valid or bands.get('BUY',(0,0))[1]>=bands.get('SELL',(0,0))[0]:
            previous={};pending={};sizes=[];first=stamp;last_valid=None;warmed=False;continue
        last_valid=stamp
        typical=median(sizes[-500:]) if len(sizes)>=p['min_depth_baseline_values'] else None
        for key,wall in list(pending.items()):
            side,price=key;lo,hi=bands[side]
            # An absent boundary level can merely have fallen outside a capped
            # snapshot. Only interior levels in the visible band are comparable.
            if not lo<price<hi:pending.pop(key);continue
            if stamp-wall['start']>p['wall_max_lifetime_ms']:pending.pop(key);continue
            size=current.get(key,0)
            if size<=wall['peak']*p['wall_remaining_fraction']:
                if now-stamp>p['pattern_lifetime_ms']:
                    pending.pop(key);continue
                settle=p.get('pull_settle_ms',0)
                times,quantities=executions.get(price,([], [0]))
                executed=quantities[bisect_right(times,min(now,stamp+settle))]-quantities[bisect_left(times,wall['start'])]
                if now-stamp>=settle and executed<=wall['peak']*p['max_executed_fraction'] and now-stamp<=p['pattern_lifetime_ms']:
                    out.append({'id':identity(e,'LIQUIDITY_PULL_'+str(key)),
                        'kind':'RAPID_DISPLAYED_LIQUIDITY_PULL','liquidity_side':direction(side,inverse),
                        'usable':bool(source_usable),'detected_utc_ms':stamp,'appeared_utc_ms':wall['start'],
                        'valid_until_utc_ms':stamp+p['pattern_lifetime_ms'],'price':price,'peak_size':wall['peak'],
                        'remaining_size':size,'observed_executed_volume_at_price':executed,'confirmed':False,
                        'meaning':'SPOOFING_SUSPICION_NOT_ORDER_ID_OR_INTENT_PROOF'})
                pending.pop(key)
        if typical and stamp-first>=p['depth_warmup_ms']:
            warmed=True
            for key,size in current.items():
                if key not in previous:continue # initial visibility is not an order addition
                if previous[key]<=typical*1.5 and size>=max(p['wall_min_contracts'],typical*p['wall_multiple']):
                    pending[key]={'start':stamp,'peak':size}
        previous=current;sizes.extend(current.values())
    ready=last_valid is not None and now-last_valid<=2000 and warmed
    if not ready:
        for item in out:item['usable']=False
    return {'state':'UNAVAILABLE_DEPTH_STALE_INVALID_OR_WARMING' if not ready else 'RESEARCH_PULL_CANDIDATES' if out else 'NO_PULL_CANDIDATE',
        'candidates':out,'confirmed':False,'mbo_available':False}
