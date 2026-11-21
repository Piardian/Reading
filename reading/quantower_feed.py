"""Quantower CQG events. Explicit provider flags; no callback-BBO aggressor fiction."""
import re
from datetime import datetime,timezone,timedelta
from ninja_feed import NinjaFeed

CQG_ROOTS={'6E':'EU6','6B':'BP6','6A':'DA6','6N':'NE6','6J':'JY6','6C':'CA6','6S':'SF6','GC':'GCE'}
MONTHS='FGHJKMNQUVXZ'

class QuantowerFeed(NinjaFeed):
    aggressor_method='QUANTOWER_PROVIDER_FLAG_PROVENANCE_UNVERIFIED_NO_BBO_FALLBACK'
    def __init__(self):
        super().__init__('QUANTOWER_DESKTOP','QUANTOWER_CQG_CME_FUTURES_PROXY','WAITING_QUANTOWER_DATA')
        self.last_connection_state=None
    def ingest(self,e,now):
        # Each root is tied to its exact standard CQG contract, never the mini/micro.
        if e.get('root'):
            root=e['root'];contract=e.get('contract','')
            match=re.fullmatch(re.escape(root)+r' (0[1-9]|1[0-2])-(\d{2})',contract) if root in CQG_ROOTS else None
            expected=('F.US.'+CQG_ROOTS[root]+MONTHS[int(match[1])-1]+match[2]) if match else None
            if expected is None or e.get('provider_symbol')!=expected:
                self.faults['CQG_SYMBOL_MAPPING_INVALID']+=1;return
        before=dict(self.last_sequence)
        super().ingest(e,now)
        if self.last_sequence!=before and e.get('kind') in {'heartbeat','reset'}:
            self.last_connection_state=e.get('connection_state')
            self.control_history.append((e['received_utc_ms'],'connection',self.last_connection_state))
    def classify(self,r):
        # Quantower may calculate/normalise the flag. Preserve that provenance.
        return {'Buy':'BUY','Sell':'SELL'}.get(r.get('aggressor_flag'))
    def quality_reasons(self,rows,now):
        reasons=[]
        if self.control_asof('connection',now)!='Connected':reasons.append('CQG_CONNECTION_NOT_CONNECTED')
        if rows and any(r.get('connection_state')!='Connected' for r in rows):reasons.append('DISCONNECTED_EVENTS_IN_WINDOW')
        if not rows or any(r.get('provider_delay_ms')!=0 for r in rows):reasons.append('PROVIDER_DELAY_NOT_ZERO_OR_UNKNOWN')
        return reasons

    @staticmethod
    def research_validation(trades,now):
        """Measured research-only freshness, never changes the raw UNVERIFIED label."""
        result={'state':'UNVERIFIED','scope':'OBSERVED_TIMESTAMP_ALIGNMENT_NOT_EXCHANGE_LATENCY_OR_ENTITLEMENT_CERTIFICATION',
            'minimum_trades':20,'minimum_span_ms':30000,'raw_feed_label':'UNVERIFIED','order_routing':False}
        if len(trades)<20 or trades[-1]['received_utc_ms']-trades[0]['received_utc_ms']<30000:
            return {**result,'reason':'CLOCK_VALIDATION_SAMPLE_NOT_READY'}
        if any(r.get('feed_label')!='UNVERIFIED' or r.get('connection_state')!='Connected' or r.get('provider_delay_ms')!=0 for r in trades):
            return {**result,'reason':'PROVIDER_MODE_OR_DELAY_NOT_SUITABLE'}
        lags=[];anchors=[]
        for row in trades:
            try:
                value=datetime.fromisoformat(row['platform_time_raw'].replace('Z','+00:00'))
                kind=row.get('platform_time_kind')
                if kind=='Utc' and value.tzinfo is not None and value.utcoffset()==timedelta(0):
                    anchors.append(row['received_utc_ms'])
                elif kind=='Unspecified' and value.tzinfo is None:
                    # Numerically test against recent explicit UTC events; never use OS local timezone.
                    value=value.replace(tzinfo=timezone.utc)
                else:raise ValueError('UNKNOWN_PLATFORM_CLOCK')
                lag=row['received_utc_ms']-value.timestamp()*1000
                if not -250<=lag<=2000:raise ValueError('PLATFORM_TIME_NOT_ALIGNED')
                lags.append(lag)
            except (KeyError,ValueError,TypeError,OverflowError):
                return {**result,'reason':'PLATFORM_TIMESTAMP_ALIGNMENT_FAILED'}
        if len(anchors)<3 or not 0<=now-max(anchors)<=15000:
            return {**result,'reason':'RECENT_EXPLICIT_UTC_ANCHORS_MISSING'}
        return {**result,'state':'OBSERVED_FRESH_RESEARCH','observed_trades':len(trades),
            'explicit_utc_anchors':len(anchors),'max_observed_lag_ms':max(lags),'min_observed_lag_ms':min(lags),
            'unspecified_clock_policy':'NUMERIC_UTC_ALIGNMENT_CORROBORATED_BY_SAME_CONTRACT_EXPLICIT_UTC_EVENTS',
            'entitlement_verified':False,'exchange_latency_verified':False}

    def feed_mode_reasons(self,trades,now):
        if {r.get('feed_label') for r in trades}=={'LIVE'}:return []
        validation=self.research_validation(trades,now)
        return [] if validation['state']=='OBSERVED_FRESH_RESEARCH' else ['LIVE_FEED_MODE_NOT_DECLARED',validation['reason']]

    def snapshot(self,symbol,now):
        result=super().snapshot(symbol,now)
        root=result['mapping'].get('root')
        trades=[r for r in self.windows.get(root,[]) if r['kind']=='trade' and now-60000<=r['received_utc_ms']<=now]
        result['observed_feed_validation']=self.research_validation(trades,now)
        return result
