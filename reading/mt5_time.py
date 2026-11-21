"""Explicit, bounded The5ers winter clock policy. No historical DST guesses."""
from datetime import datetime,timezone
import math

WINTER_START=int(datetime(2026,11,2,tzinfo=timezone.utc).timestamp()*1000)
WINTER_END=int(datetime(2027,3,1,tzinfo=timezone.utc).timestamp()*1000)
POLICY='THE5ERS_WINTER_2026_UTC_PLUS_2_OBSERVED_AND_DOCUMENTED'
SOURCE='https://the5ers.com/faqs/market-trading-hours/'

def quote_clock_offset(raw_ms,received_ms):
    if not isinstance(raw_ms,(int,float)) or not math.isfinite(raw_ms):return None
    if WINTER_START<=received_ms<WINTER_END and -2000<=received_ms-(raw_ms-7200000)<=2000:
        return 7200000
    return None

def normalize_closed_rates(raw,interval_ms,offset_ms,now_ms):
    """Drop bars before the documented common winter window, never shift summer history."""
    out=[]
    for row in raw:
        stamp=int(row['time'])*1000-offset_ms
        if stamp<WINTER_START or stamp>=WINTER_END:continue
        if stamp+interval_ms>now_ms:continue
        bar={'timestamp':stamp,**{k:float(row[k]) for k in ['open','high','low','close']}}
        if not all(math.isfinite(v) for v in bar.values()):raise ValueError('NON_FINITE_CANDLE')
        if not 0<bar['low']<=min(bar['open'],bar['close'])<=max(bar['open'],bar['close'])<=bar['high']:
            raise ValueError('INVALID_CANDLE_OHLC')
        if out and stamp<=out[-1]['timestamp']:raise ValueError('CANDLE_ORDER_INVALID')
        out.append(bar)
    if len(out)<15:raise ValueError('INSUFFICIENT_CLOSED_WINTER_CANDLES')
    return out[-500:]
