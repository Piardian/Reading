import copy
import tempfile
from pathlib import Path
import unittest
from reading_patterns import snapshot
from entry_tracker import EntryTracker

NOW=200000
def trade(t,seq,side='Sell',price=1.1,volume=1):
    return {'kind':'trade','received_utc_ms':t,'sequence':seq,'session_id':'unit-fixture',
        'root':'6E','contract':'6E 12-26','aggressor_flag':side,'price':price,'volume':volume}
def sample():
    baseline=[trade(NOW-35000+i*950,i+1,'Buy') for i in range(30)]
    recent=[trade(NOW-4900+i*200,31+i,'Sell',1.1+(i%2)*.00001,5) for i in range(20)]
    return baseline+recent
def evaluate(rows,**kw):
    return snapshot(rows,NOW,lambda e:{'Buy':'BUY','Sell':'SELL'}.get(e.get('aggressor_flag')),source_usable=True,**kw)
def depth(t,seq,size=2,verified=True):
    return {'kind':'depth_snapshot','received_utc_ms':t,'sequence':seq,'root':'6E','contract':'6E 12-26',
        'session_id':'depth-unit','depth_stream_verified':verified,
        'depth_semantics':'AGGREGATED_CONTIGUOUS_PRICE_LEVELS',
        'bids':[[1.0999,2],[1.0998,size],[1.0997,2]],'asks':[[1.1001,2],[1.1002,2],[1.1003,2]]}
def walls():
    return [depth(NOW-35000+i*5000,i+1) for i in range(7)]+[depth(NOW-1500,8,100),depth(NOW-500,9,2)]

class PatternTests(unittest.TestCase):
    def test_burst_plus_stall_identifies_passive_buy_candidate(self):
        s=evaluate(sample())
        self.assertTrue(s['speed']['detected']);self.assertEqual(len(s['absorption_candidates']),1)
        self.assertEqual(s['absorption_candidates'][0]['direction'],'BUY')
        self.assertFalse(s['absorption_confirmed']);self.assertFalse(s['execution_allowed'])
    def test_progressing_price_is_not_absorption(self):
        rows=sample()
        for i,e in enumerate(rows[-20:]):e['price']=1.1-i*.0001
        self.assertTrue(evaluate(rows)['speed']['detected'])
        self.assertEqual(evaluate(rows)['absorption_candidates'],[])
    def test_no_baseline_no_burst(self):
        self.assertFalse(evaluate(sample()[-20:])['speed']['detected'])
    def test_quotes_cannot_be_counted_as_trades(self):
        rows=sample()
        for e in rows[-20:]:e['kind']='quote'
        self.assertFalse(evaluate(rows)['speed']['detected'])
    def test_unknown_aggressor_cannot_create_absorption(self):
        rows=sample()
        for e in rows[-20:]:e['aggressor_flag']='None'
        self.assertEqual(evaluate(rows)['absorption_candidates'],[])
    def test_inverse_side_is_explicit(self):
        self.assertEqual(evaluate(sample(),inverse=True)['absorption_candidates'][0]['direction'],'SELL')
    def test_future_mutation_does_not_change_past_features(self):
        a=evaluate(sample());future=trade(NOW+1,999,'Buy',1000000,1e9)
        self.assertEqual(a,evaluate(sample()+[future]))
    def test_unverified_source_is_observation_only(self):
        s=snapshot(sample(),NOW,lambda e:'SELL',source_usable=False)
        self.assertFalse(s['speed']['detected']);self.assertTrue(s['speed']['observed_pattern'])
        self.assertFalse(s['absorption_candidates'][0]['usable'])
    def test_level1_does_not_invent_spoofing(self):
        self.assertEqual(evaluate(sample())['liquidity_pulls']['state'],'UNAVAILABLE_NO_LEVEL2')
    def test_unverified_depth_semantics_cannot_create_suspicion(self):
        rows=walls()
        for e in rows:e['depth_stream_verified']=False
        self.assertEqual(evaluate(rows)['liquidity_pulls']['state'],'UNAVAILABLE_DEPTH_SEMANTICS_UNVERIFIED')
    def test_verified_rapid_wall_pull_is_suspicion_not_intent(self):
        s=evaluate(walls())['liquidity_pulls']
        self.assertEqual(len(s['candidates']),1)
        self.assertFalse(s['confirmed']);self.assertFalse(s['mbo_available'])
    def test_execution_at_wall_explains_size_drop(self):
        rows=walls()+[trade(NOW-1000,99,'Sell',1.0998,90)]
        self.assertEqual(evaluate(rows)['liquidity_pulls']['candidates'],[])
    def test_initial_large_wall_is_not_order_appearance(self):
        rows=[depth(NOW-35000+i*5000,i+1,100) for i in range(8)]
        rows.append(depth(NOW-500,9,2))
        self.assertEqual(evaluate(rows)['liquidity_pulls']['candidates'],[])
    def test_snapshot_clipping_cannot_fake_pull(self):
        rows=walls();rows[-1]['bids']=[[1.0999,2],[1.09985,2],[1.09982,2]]
        self.assertEqual(evaluate(rows)['liquidity_pulls']['candidates'],[])

class AutomaticEntryTests(unittest.TestCase):
    def setup_tracker(self,path):
        t=EntryTracker(path,config={'require_patterns':True},symbol='EURUSD')
        c={'symbol':'EURUSD','signalId':'automatic-unit','tradeDirection':'long','poiType':'OB',
            'poi':{'low':1.09,'high':1.10},'gradeResult':{'entryAllowed':True},
            'macroEvaluation':{'allowed':True,'macroGateMultiplier':1,'isStale':False},
            'expectancyPlan':{'entryPrice':1.095,'stopLoss':1.08,'tp1':{'price':1.12}}}
        t.sync({'state':'CANDIDATES_OBSERVED','observed_utc_ms':NOW,'candidates':[c]},NOW)
        return t
    def q(self,t,offset,bid,flow='BUY',evidence=None,source=True,pulls=None):
        stamp=NOW+offset
        patterns={'generated_utc_ms':stamp,'source_usable':source,'absorption_candidates':evidence or [],
            'response_flow':{'direction':flow,'usable':True},
            'liquidity_pulls':pulls or {'state':'UNAVAILABLE_NO_LEVEL2','candidates':[]}}
        t.tick({'kind':'broker_quote_tick','received_utc_ms':stamp,
            'data':{'symbol':'EURUSD','time_msc':stamp,'bid':bid,'ask':bid+.0001}},
            {'generated_utc_ms':stamp,'tape_features_usable':source,'research_pressure':'BUY','reading_patterns':patterns},stamp)
    def evidence(self,pre=False):
        return [{'id':'abs-unit','direction':'BUY','usable':True,'window_start_utc_ms':NOW-100 if pre else NOW+101,
            'detected_utc_ms':NOW+200,'valid_until_utc_ms':NOW+10000}]
    def drive(self,t,**kw):
        self.q(t,100,1.0949)
        self.q(t,200,1.0948,evidence=kw.get('evidence',self.evidence()))
        self.q(t,300,1.0956,flow=kw.get('flow','BUY'),source=kw.get('source',True),pulls=kw.get('pulls'))
        self.q(t,400,1.0962,flow=kw.get('flow','BUY'),source=kw.get('source',True),pulls=kw.get('pulls'))
        return t.state['setups']['automatic-unit']
    def test_automatic_entry_needs_no_human_with_valid_pattern_sequence(self):
        with tempfile.TemporaryDirectory() as d:
            s=self.drive(self.setup_tracker(Path(d)))
            self.assertEqual(s['state'],'RESEARCH_ENTRY_PROPOSAL')
            self.assertFalse(s['pattern_assessment']['human_confirmation_required'])
    def test_pre_touch_absorption_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as d:
            s=self.drive(self.setup_tracker(Path(d)),evidence=self.evidence(True))
            self.assertEqual(s['state'],'WAITING_RESPONSE')
    def test_pressure_and_price_alone_do_not_pass_new_rule(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.drive(self.setup_tracker(Path(d)),evidence=[])['state'],'WAITING_RESPONSE')
    def test_no_flow_reversal_means_no_entry(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.drive(self.setup_tracker(Path(d)),flow='SELL')['state'],'WAITING_RESPONSE')
    def test_unverified_source_means_no_entry(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.drive(self.setup_tracker(Path(d)),source=False)['state'],'WAITING_RESPONSE')
    def test_recent_pull_causes_automatic_caution(self):
        pull={'id':'pull-unit','usable':True,'appeared_utc_ms':NOW+150,'detected_utc_ms':NOW+200,'valid_until_utc_ms':NOW+10000}
        with tempfile.TemporaryDirectory() as d:
            s=self.drive(self.setup_tracker(Path(d)),pulls={'state':'RESEARCH_PULL_CANDIDATES','candidates':[pull]})
            self.assertEqual(s['state'],'WAITING_RESPONSE')
            self.assertEqual(s['pattern_assessment']['state'],'WAITING_RECENT_LIQUIDITY_PULL_CAUTION')

if __name__=='__main__':unittest.main()
