from pathlib import Path
import tempfile
import unittest
from crypto_feed import CryptoFeed
from crypto_live import closed_candles
from entry_tracker import EntryTracker

NOW=200000
def e(t,kind='trade',**kw):
    return {'source':'BINANCE_SPOT_PUBLIC','schema':1,'received_utc_ms':t,'kind':kind,
        'symbol':'BTCUSD','venue_symbol':'BTCUSDT','session_id':'unit','trade_id':1,
        'exchange_utc_ms':t,'transaction_utc_ms':t,'price':100.,'volume':1.,'aggressor':'BUY',**kw}
def health():
    return {'connection':'CONNECTED','updated_utc_ms':NOW-1000,
        'clock':{'server_minus_local_midpoint_ms':0,'rtt_ms':10,'measured_utc_ms':NOW-1000}}
def ready():
    c=CryptoFeed({'BTCUSD':'BTCUSDT'});c.ingest(e(NOW-70000,'reset'),NOW)
    for i in range(1,11):c.ingest(e(NOW-1000+i*50,trade_id=i),NOW)
    c.ingest(e(NOW-100,'quote',update_id=100,bid=99.9,ask=100.1,timestamp_source='LOCAL_RECEIPT_TIME_NO_EXCHANGE_TIMESTAMP_IN_BOOKTICKER'),NOW)
    return c

class CryptoTests(unittest.TestCase):
    def test_same_venue_tape_ready_without_broker_or_cme(self):
        s=ready().snapshot('BTCUSD',NOW,health())
        self.assertTrue(s['tape_features_usable']);self.assertEqual(s['market_identity']['quote_asset'],'USDT')
        self.assertFalse(s['execution_allowed']);self.assertFalse(s['market_identity']['broker_usd_execution_equivalent'])
    def test_duplicate_trade_not_counted_twice(self):
        c=ready();c.ingest(e(NOW-100,trade_id=10),NOW)
        self.assertEqual(c.snapshot('BTCUSD',NOW,health())['trade_events'],10)
    def test_id_gap_blocks_entry_features(self):
        c=ready();c.ingest(e(NOW-50,trade_id=12),NOW)
        self.assertIn('CRYPTO_WARMUP_OR_GAP',c.snapshot('BTCUSD',NOW,health())['reasons'])
    def test_future_or_wrong_venue_rejected(self):
        c=ready();c.ingest(e(NOW+1,trade_id=11),NOW);c.ingest(e(NOW,trade_id=11,venue_symbol='BTCUSD'),NOW)
        self.assertEqual(c.snapshot('BTCUSD',NOW,health())['trade_events'],10)
    def test_stale_quote_or_clock_blocks(self):
        c=ready();c.quotes['BTCUSD']['received_utc_ms']=NOW-3000
        self.assertFalse(c.snapshot('BTCUSD',NOW,health())['tape_features_usable'])
        c=ready();h=health();h['clock']['server_minus_local_midpoint_ms']=3000
        self.assertIn('CRYPTO_CLOCK_NOT_VALIDATED',c.snapshot('BTCUSD',NOW,h)['reasons'])
    def test_reconnect_clears_old_quote_and_tape(self):
        c=ready();c.ingest(e(NOW,'reset'),NOW)
        self.assertEqual(c.snapshot('BTCUSD',NOW,health())['trade_events'],0)
    def test_full_top_book_snapshot_ids_may_jump_without_inventing_trade_gap(self):
        c=ready()
        for uid in [100,200]:
            c.ingest(e(NOW-50,'depth_snapshot',depth_update_id=uid,
                bids=[[99.9,1],[99.8,2],[99.7,1]],asks=[[100.1,1],[100.2,2],[100.3,1]],
                depth_semantics='AGGREGATED_CONTIGUOUS_PRICE_LEVELS',depth_stream_verified=True),NOW)
        self.assertEqual(c.depth_ids['BTCUSD'],200)
        self.assertTrue(c.snapshot('BTCUSD',NOW,health())['tape_features_usable'])
    def test_crossed_depth_is_rejected(self):
        c=ready();c.ingest(e(NOW-50,'depth_snapshot',depth_update_id=100,
            bids=[[100.2,1],[100.1,2],[100.,1]],asks=[[100.1,1],[100.2,2],[100.3,1]],
            depth_semantics='AGGREGATED_CONTIGUOUS_PRICE_LEVELS',depth_stream_verified=True),NOW)
        self.assertEqual(c.faults['CROSSED_DEPTH'],1)
        self.assertNotIn('BTCUSD',c.depth_ids)
    def test_pattern_cache_never_reuses_a_later_snapshot_for_an_earlier_quote(self):
        c=ready();later=c.snapshot('BTCUSD',NOW,health())
        earlier=c.snapshot('BTCUSD',NOW-200,health())
        self.assertLessEqual(earlier['reading_patterns']['generated_utc_ms'],NOW-200)
    def test_only_closed_complete_candles_are_written(self):
        raw=[[t,'100','102','99','101','2',t+59999] for t in [1680000,1740000,1800000]]
        out=closed_candles(raw,1800000,60000)
        self.assertEqual([b['timestamp'] for b in out],[1680000,1740000])
    def test_missing_closed_bar_is_not_filled(self):
        with self.assertRaises(ValueError):closed_candles([[1680000,'100','102','99','101','2',1739999]],1800000,60000)
    def test_crypto_quote_does_not_fabricate_broker_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            t=EntryTracker(Path(d),symbol='BTCUSD')
            c={'symbol':'BTCUSD','signalId':'crypto-unit','tradeDirection':'long','poiType':'OB',
                'poi':{'low':99,'high':101},'gradeResult':{'entryAllowed':True},
                'macroEvaluation':{'allowed':True,'macroGateMultiplier':1,'isStale':False},
                'expectancyPlan':{'stopLoss':98,'tp1':{'price':105}}}
            t.sync({'state':'CANDIDATES_OBSERVED','observed_utc_ms':NOW,'candidates':[c]},NOW)
            raw=e(NOW+100,'quote',update_id=101,bid=99.9,ask=100.1,timestamp_source='LOCAL_RECEIPT_TIME_NO_EXCHANGE_TIMESTAMP_IN_BOOKTICKER')
            f=CryptoFeed({'BTCUSD':'BTCUSDT'});q=f.ingest(raw,NOW+100)
            self.assertNotIn('time_msc',q['data'])
            t.tick(q,{},NOW+100)
            self.assertEqual(t.state['setups']['crypto-unit']['state'],'TOUCHED')
    def test_macro_veto_is_not_bypassed_for_crypto(self):
        with tempfile.TemporaryDirectory() as d:
            t=EntryTracker(Path(d),symbol='BTCUSD')
            c={'symbol':'BTCUSD','signalId':'veto','tradeDirection':'long','poiType':'OB','poi':{'low':99,'high':101},
                'gradeResult':{'entryAllowed':True},'macroEvaluation':{'allowed':False,'macroGateMultiplier':0},
                'expectancyPlan':{'stopLoss':98,'tp1':{'price':105}}}
            t.sync({'state':'CANDIDATES_OBSERVED','observed_utc_ms':NOW,'candidates':[c]},NOW)
            self.assertEqual(t.state['setups']['veto']['reason'],'MACRO_NOT_APPROVED')

if __name__=='__main__':unittest.main()
