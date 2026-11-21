import unittest
from quantower_feed import QuantowerFeed

NOW=200000
def event(seq,kind='trade',**kw):
    return {'schema':1,'source':'QUANTOWER_DESKTOP','session_id':'q','sequence':seq,
        'received_utc_ms':NOW-1000,'kind':kind,'root':'6E','contract':'6E 12-26',
        'provider_symbol':'F.US.EU6Z26','feed_label':'LIVE','connection_state':'Connected',
        'provider_delay_ms':0,'price':1.1,'volume':10,'aggressor_flag':'Buy',**kw}
def ready(**kw):
    n=QuantowerFeed();n.ingest(event(1,'heartbeat'),NOW)
    for i in range(2,7):n.ingest(event(i,**kw),NOW)
    return n

class QuantowerTests(unittest.TestCase):
    def test_provider_flag_works_without_callback_bbo(self):
        s=ready().snapshot('EURUSD',NOW)
        self.assertTrue(s['tape_features_usable']);self.assertEqual(s['research_pressure'],'BUY')
        self.assertFalse(s['execution_allowed']);self.assertFalse(s['absorption_confirmed'])
    def test_unknown_flag_cannot_be_filled_from_bbo(self):
        s=ready(aggressor_flag='None',bid=1.0999,ask=1.1).snapshot('EURUSD',NOW)
        self.assertFalse(s['tape_features_usable']);self.assertEqual(s['unknown_side_contracts'],50)
    def test_mini_cannot_impersonate_standard_contract(self):
        n=ready(provider_symbol='F.US.EEUZ26')
        self.assertEqual(n.faults['CQG_SYMBOL_MAPPING_INVALID'],5)
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_expiry_mismatch_is_rejected(self):
        n=ready(provider_symbol='F.US.EU6H27')
        self.assertEqual(n.faults['CQG_SYMBOL_MAPPING_INVALID'],5)
    def test_delay_even_with_live_label_blocks(self):
        self.assertFalse(ready(provider_delay_ms=900000).snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_unverified_declaration_blocks(self):
        self.assertFalse(ready(feed_label='UNVERIFIED').snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_disconnection_resets_window(self):
        n=ready();n.ingest(event(7,'reset',connection_state='Disconnected'),NOW)
        s=n.snapshot('EURUSD',NOW)
        self.assertIn('CQG_CONNECTION_NOT_CONNECTED',s['reasons']);self.assertFalse(s['tape_features_usable'])
    def test_other_exporter_not_accepted(self):
        n=ready(source='NINJATRADER_DESKTOP')
        self.assertEqual(n.faults['INVALID_SOURCE'],5)
    def test_past_snapshot_excludes_future_trade(self):
        n=ready();n.ingest(event(7,received_utc_ms=NOW,aggressor_flag='Sell',volume=500),NOW)
        self.assertEqual(n.snapshot('EURUSD',NOW-500)['research_pressure'],'BUY')
    def test_newer_heartbeat_cannot_invalidate_prior_fresh_quote(self):
        n=ready()
        n.ingest(event(7,'heartbeat',received_utc_ms=NOW),NOW)
        self.assertTrue(n.snapshot('EURUSD',NOW-500)['tape_features_usable'])
    def test_future_disconnect_does_not_rewrite_earlier_decision(self):
        n=ready()
        n.ingest(event(7,'reset',received_utc_ms=NOW,connection_state='Disconnected'),NOW)
        before=n.snapshot('EURUSD',NOW-500)
        self.assertTrue(before['tape_features_usable'])
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_future_heartbeat_cannot_rescue_missing_prior_heartbeat(self):
        n=QuantowerFeed()
        for i in range(1,6):n.ingest(event(i),NOW)
        n.ingest(event(6,'heartbeat',received_utc_ms=NOW),NOW)
        self.assertIn('BRIDGE_HEARTBEAT_NOT_FRESH',n.snapshot('EURUSD',NOW-500)['reasons'])
    def test_future_gap_does_not_hide_a_prior_gap(self):
        n=ready()
        n.ingest(event(9,received_utc_ms=NOW-800),NOW)
        n.ingest(event(12,received_utc_ms=NOW),NOW)
        self.assertIn('GAP_RESET_OR_CONTRACT_CHANGE_IN_WINDOW',n.snapshot('EURUSD',NOW-500)['reasons'])
    def test_inverse_and_cross_semantics_unchanged(self):
        n=QuantowerFeed();n.ingest(event(1,'heartbeat'),NOW)
        for i in range(2,7):n.ingest(event(i,root='6J',contract='6J 12-26',provider_symbol='F.US.JY6Z26'),NOW)
        self.assertEqual(n.snapshot('USDJPY',NOW)['research_pressure'],'SELL')
        self.assertFalse(n.snapshot('EURJPY',NOW)['tape_features_usable'])

if __name__=='__main__':unittest.main()
