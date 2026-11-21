"""Sample current broker FX BBO for zone monitoring, NOT a complete transaction tape."""
import time
import os
import json
import hashlib
from pathlib import Path
import MetaTrader5 as mt5
from mt5_time import quote_clock_offset,normalize_closed_rates,POLICY,SOURCE

class ForexQuotes:
    def __init__(self,symbols,terminal,candle_directory=None):
        self.symbols=symbols;self.terminal=terminal;self.connected=False;self.previous={};self.health={};self.retry=0
        self.candle_directory=Path(candle_directory) if candle_directory else None
        self.candle_health={};self.candle_cursor=0;self.candle_last={}
        self.clock_confirmation=None
        self.candle_jobs=[(s,tf,api,ms) for s in dict.fromkeys([*symbols,'XAUUSD']) for tf,api,ms in
            [('4h',mt5.TIMEFRAME_H4,14400000),('1h',mt5.TIMEFRAME_H1,3600000),('15m',mt5.TIMEFRAME_M15,900000),('1m',mt5.TIMEFRAME_M1,60000)]]
        if self.candle_directory:self.candle_directory.mkdir(parents=True,exist_ok=True)

    def poll(self):
        now=time.time()
        if not self.connected:
            if now<self.retry:return []
            self.retry=now+15
            if not mt5.initialize(path=self.terminal,timeout=5000):
                self.health={'connection':'MT5_UNAVAILABLE','error':str(mt5.last_error())};return []
            self.connected=True
            info=mt5.terminal_info()
            if not info or os.path.normcase(info.path)!=os.path.normcase(str(Path(self.terminal).parent)):
                self.connected=False;mt5.shutdown();self.health={'connection':'UNEXPECTED_TERMINAL'};return []
            for symbol in self.symbols:
                info=mt5.symbol_info(symbol)
                if info and not info.visible:mt5.symbol_select(symbol,True)
        events=[];by_symbol={}
        terminal=mt5.terminal_info()
        if not terminal or not terminal.connected:
            self.connected=False;mt5.shutdown();self.health={'connection':'DISCONNECTED'};return []
        for symbol in self.symbols:
            q=mt5.symbol_info_tick(symbol);received=time.time_ns()//1000000
            if not q or not q.time_msc or q.bid<=0 or q.ask<q.bid:
                by_symbol[symbol]={'state':'SYMBOL_OR_QUOTE_UNAVAILABLE'};continue
            offset=quote_clock_offset(q.time_msc,received)
            age=received-q.time_msc
            if offset is None:
                by_symbol[symbol]={'state':'STALE_OR_CLOCK_UNVALIDATED','broker_quote_age_ms':age};continue
            by_symbol[symbol]={'state':'QUOTE_FRESH','raw_broker_quote_age_ms':age,'normalized_quote_age_ms':age+offset,
                'applied_offset_ms':offset,'clock_policy':POLICY if offset else 'NATIVE_UTC_OBSERVED'}
            self.clock_confirmation=(received,offset)
            key=(q.time_msc,q.bid,q.ask)
            if self.previous.get(symbol)==key:continue
            self.previous[symbol]=key
            events.append({'kind':'broker_quote_tick','received_utc_ms':received,
                           'data':{'symbol':symbol,'time_msc':int(q.time_msc)-offset,'raw_broker_time_msc':int(q.time_msc),
                                   'applied_offset_ms':offset,'clock_policy':POLICY if offset else 'NATIVE_UTC_OBSERVED','bid':q.bid,'ask':q.ask,
                                   'source':'MT5_BBO_SAMPLE_NOT_TRANSACTION_TAPE'}})
        self.refresh_one_candle_series()
        self.health={'connection':'CONNECTED','symbols':by_symbol,'timestamp_provenance_validated':False,
            'clock_scope':'CURRENT_WINTER_POLICY_WITH_LIVE_QUOTE_CROSSCHECK_NOT_END_TO_END_LATENCY_PROOF',
            'candle_series':self.candle_health}
        return events

    def refresh_one_candle_series(self):
        if not self.candle_directory:return
        symbol,tf,api,interval=self.candle_jobs[self.candle_cursor%len(self.candle_jobs)];self.candle_cursor+=1
        key=symbol+'_'+tf
        try:
            q=mt5.symbol_info_tick(symbol);now=time.time_ns()//1000000
            offset=quote_clock_offset(q.time_msc,now) if q else None
            if offset is None and self.clock_confirmation and 0<=now-self.clock_confirmation[0]<=10000:
                offset=self.clock_confirmation[1]
            if offset is None:raise ValueError('LIVE_QUOTE_REQUIRED_FOR_CLOCK_CROSSCHECK')
            raw=mt5.copy_rates_from_pos(symbol,api,1,500)
            if raw is None:raise ValueError('CANDLE_HISTORY_UNAVAILABLE')
            bars=normalize_closed_rates(raw,interval,offset,now)
            path=self.candle_directory/(key+'.json')
            if self.candle_last.get(key)!=bars[-1]['timestamp']:
                payload=json.dumps(bars,separators=(',',':')).encode('utf-8')
                meta={'symbol':symbol,'timeframe':tf,'fetched_utc_ms':now,'available_at_ms':now,'closed_only':True,
                    'clock_policy':POLICY if offset else 'NATIVE_UTC_OBSERVED','source':SOURCE,'applied_offset_ms':offset,
                    'historical_scope':'2026-11-02_ONWARD_ONLY_NO_SUMMER_OR_DST_RECONSTRUCTION',
                    'bars':len(bars),'last_closed_open_ms':bars[-1]['timestamp'],'sha256':hashlib.sha256(payload).hexdigest()}
                self.atomic(path,payload);self.atomic(path.with_suffix('.meta.json'),json.dumps(meta).encode('utf-8'))
                self.candle_last[key]=bars[-1]['timestamp']
            self.candle_health[key]={'state':'CLOSED_HISTORY_UPDATED','bars':len(bars),'last_closed_open_ms':bars[-1]['timestamp'],'checked_utc_ms':now}
        except Exception as e:self.candle_health[key]={'state':'DATA_NOT_READY','error':str(e),'checked_utc_ms':time.time_ns()//1000000}

    @staticmethod
    def atomic(path,payload):
        tmp=path.with_suffix('.tmp')
        try:
            tmp.write_bytes(payload)
        except Exception:
            return
        for i in range(15):
            try:
                os.replace(tmp,path)
                return
            except (PermissionError,OSError):
                time.sleep(.02*(i+1))
        try:
            path.write_bytes(payload)
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

    def close(self):
        if self.connected:mt5.shutdown();self.connected=False
