import unittest
from tape_engine import TapeEngine

NOW=100000
def trade(identifier,received=NOW-1000,buyer_maker=False,quantity='1'):
    return {'kind':'paxg_agg_trade','received_utc_ms':received,
            'data':{'raw':{'a':identifier,'s':'PAXGUSDT','q':quantity,'p':'4000','m':buyer_maker}}}
def book():
    return {'kind':'paxg_depth5','received_utc_ms':NOW-100,
            'data':{'raw':{'bids':[['3999','2']],'asks':[['4000','1']]}}}
STATUS={'state':'RUNNING','updated_utc_ms':NOW,'mt5_connected':True,'paxg_ws_connected':True,
        'xauusd_last_tick_age_seconds':0}
class TapeTests(unittest.TestCase):
    def test_duplicate_future_and_old_rows(self):
        t=TapeEngine();t.ingest(trade(1),NOW);t.ingest(trade(1),NOW)
        t.ingest(trade(2,NOW+1),NOW);t.ingest(trade(3,NOW-60001),NOW)
        s=t.snapshot(NOW,STATUS)
        self.assertEqual(s['aggregate_trade_events'],1);self.assertEqual(s['future_rows_rejected'],1)
    def test_pressure_is_not_xau_permission(self):
        t=TapeEngine()
        for i in range(5):t.ingest(trade(i),NOW)
        t.ingest(book(),NOW);s=t.snapshot(NOW,STATUS)
        self.assertEqual(s['research_pressure'],'BUY');self.assertTrue(s['paxg_features_usable'])
        self.assertFalse(s['xau_confirmation_valid']);self.assertFalse(s['order_routing'])
    def test_sell_sign(self):
        t=TapeEngine()
        for i in range(5):t.ingest(trade(i,buyer_maker=True),NOW)
        self.assertEqual(t.snapshot(NOW,STATUS)['research_pressure'],'SELL')
    def test_stale_quote_and_gap(self):
        t=TapeEngine();t.ingest({'kind':'trade_gap','received_utc_ms':NOW,'data':{}},NOW)
        s=t.snapshot(NOW,{**STATUS,'xauusd_last_tick_age_seconds':100})
        self.assertIn('XAU_QUOTE_NOT_FRESH',s['reasons']);self.assertIn('GAP_OR_SESSION_TRANSITION_IN_WINDOW',s['reasons'])
    def test_no_trades_is_unknown(self):
        self.assertIsNone(TapeEngine().snapshot(NOW,STATUS)['signed_quantity_imbalance'])
    def test_invalid_size_rejected(self):
        t=TapeEngine();t.ingest(trade(1,quantity='nan'),NOW)
        self.assertEqual(t.snapshot(NOW,STATUS)['invalid_rows_rejected'],1)
if __name__=='__main__':unittest.main()
