from pathlib import Path
import tempfile
import unittest
from ninja_feed import NinjaFeed
from forex_routes import SYMBOLS,route
from entry_tracker import EntryTracker

NOW=200000
def event(seq,kind='trade',root='6E',**kw):
    return {'schema':1,'source':'NINJATRADER_DESKTOP','session_id':'session','sequence':seq,
            'received_utc_ms':NOW-1000,'kind':kind,'root':root,'contract':root+' 12-26',
            'feed_label':'LIVE','price':1.1,'bid':1.0999,'ask':1.1,'volume':10,**kw}
def ready(root='6E'):
    n=NinjaFeed();n.ingest(event(1,kind='heartbeat',root=root),NOW)
    for i in range(2,7):n.ingest(event(i,root=root),NOW)
    return n

class NinjaTests(unittest.TestCase):
    def test_level1_provides_pressure_without_depth(self):
        s=ready().snapshot('EURUSD',NOW)
        self.assertTrue(s['tape_features_usable']);self.assertEqual(s['research_pressure'],'BUY')
        self.assertEqual(s['depth_events'],0);self.assertFalse(s['execution_allowed'])
    def test_inverse_contract_pressure_is_reversed(self):
        self.assertEqual(ready('6J').snapshot('USDJPY',NOW)['research_pressure'],'SELL')
    def test_cross_legs_are_never_direct_tape(self):
        s=ready().snapshot('EURJPY',NOW)
        self.assertEqual(s['state'],'CROSS_LEGS_CONTEXT_ONLY');self.assertFalse(s['tape_features_usable'])
    def test_all_existing_forex_symbols_have_explicit_coverage(self):
        self.assertEqual(len(SYMBOLS),21)
        self.assertTrue(all(route(s)['mode'] in {'DIRECT_FUTURES_PROXY','CROSS_LEGS_CONTEXT_ONLY'} for s in SYMBOLS))
    def test_wrong_contract_cannot_be_used_for_euro(self):
        n=ready('6B');self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_future_rows_and_duplicate_sequences(self):
        n=ready();n.ingest(event(6),NOW);n.ingest(event(7,received_utc_ms=NOW+1),NOW)
        self.assertEqual(n.duplicates,1);self.assertEqual(n.snapshot('EURUSD',NOW)['trade_events'],5)
    def test_sequence_gap_and_replay_disable_features(self):
        n=ready();n.ingest(event(9),NOW)
        self.assertIn('GAP_RESET_OR_CONTRACT_CHANGE_IN_WINDOW',n.snapshot('EURUSD',NOW)['reasons'])
        n=ready();n.ingest(event(7,feed_label='REPLAY'),NOW)
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_unknown_aggressor_is_not_fabricated(self):
        n=NinjaFeed();n.ingest(event(1,kind='heartbeat'),NOW)
        for i in range(2,7):n.ingest(event(i,price=1.09995),NOW)
        s=n.snapshot('EURUSD',NOW)
        self.assertEqual(s['unknown_side_contracts'],50);self.assertFalse(s['tape_features_usable'])
    def test_new_contract_resets_history(self):
        n=ready();n.ingest(event(7,contract='6E 03-27'),NOW)
        self.assertEqual(n.snapshot('EURUSD',NOW)['trade_events'],1)
    def test_invalid_contract_family_rejected(self):
        n=ready();n.ingest(event(7,contract='GC 12-26'),NOW)
        self.assertEqual(n.faults['CONTRACT_ROOT_OR_EXPIRY_INVALID'],1)
    def test_unverified_mode_does_not_pass(self):
        n=NinjaFeed();n.ingest(event(1,kind='heartbeat'),NOW)
        for i in range(2,7):n.ingest(event(i,feed_label='UNVERIFIED'),NOW)
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_macro_then_smc_before_fx_reading(self):
        with tempfile.TemporaryDirectory() as temp:
            t=EntryTracker(Path(temp),symbol='EURUSD')
            c={'symbol':'EURUSD','signalId':'fx-test','tradeDirection':'long','poiType':'OB',
                'poi':{'low':1.09,'high':1.10},'gradeResult':{'entryAllowed':True},
                'macroEvaluation':{'allowed':False,'macroGateMultiplier':0},
                'expectancyPlan':{'entryPrice':1.095,'stopLoss':1.08,'tp1':{'price':1.12}}}
            t.sync({'state':'CANDIDATES_OBSERVED','observed_utc_ms':NOW,'candidates':[c]},NOW)
            self.assertEqual(t.state['setups']['fx-test']['reason'],'MACRO_NOT_APPROVED')
            self.assertEqual(t.state['setups']['fx-test']['state'],'REJECTED')
    def test_approved_fx_box_uses_futures_tape_after_touch(self):
        with tempfile.TemporaryDirectory() as temp:
            t=EntryTracker(Path(temp),symbol='EURUSD')
            c={'symbol':'EURUSD','signalId':'approved-fx','tradeDirection':'long','poiType':'OB',
                'poi':{'low':1.09,'high':1.10},'gradeResult':{'entryAllowed':True},
                'macroEvaluation':{'allowed':True,'macroGateMultiplier':1,'isStale':False},
                'expectancyPlan':{'entryPrice':1.095,'stopLoss':1.08,'tp1':{'price':1.12}}}
            t.sync({'state':'CANDIDATES_OBSERVED','observed_utc_ms':NOW,'candidates':[c]},NOW)
            for offset,bid,ask in [(100,1.0949,1.095),(200,1.0948,1.0949),(300,1.0956,1.0957),(400,1.0962,1.0963)]:
                stamp=NOW+offset;snapshot=ready().snapshot('EURUSD',stamp)
                t.tick({'kind':'broker_quote_tick','received_utc_ms':stamp,
                        'data':{'symbol':'EURUSD','time_msc':stamp,'bid':bid,'ask':ask}},snapshot,stamp)
            setup=t.state['setups']['approved-fx']
            self.assertEqual(setup['state'],'RESEARCH_ENTRY_PROPOSAL')
            self.assertEqual(setup['reference_observations']['reading_proposal']['entry_quote'],1.0963)

if __name__=='__main__':unittest.main()
