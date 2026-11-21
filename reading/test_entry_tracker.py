import json
from pathlib import Path
import tempfile
import unittest
from entry_tracker import EntryTracker

START=100000
def candidate(direction='long'):
    return {'signalId':'test-zone','symbol':'XAUUSD','tradeDirection':direction,'poiType':'OB',
        'poi':{'low':100,'high':110},'gradeResult':{'entryAllowed':True},
        'macroEvaluation':{'allowed':True,'macroGateMultiplier':1,'isStale':False},
        'expectancyPlan':{'entryPrice':105,'stopLoss':95 if direction=='long' else 115,
            'tp1':{'price':130 if direction=='long' else 80}}}
def context(now=START,items=None):
    return {'observed_utc_ms':now,'state':'CANDIDATES_OBSERVED','candidates':items if items is not None else [candidate()]}
def quote(now,bid,ask):
    return {'kind':'xauusd_broker_tick','received_utc_ms':now,'data':{'bid':bid,'ask':ask,'time_msc':now}}
def tape(now,pressure='BUY'):
    return {'generated_utc_ms':now,'paxg_features_usable':True,'research_pressure':pressure}

class EntryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)
        self.t=EntryTracker(self.path);self.t.sync(context(),START)
    def tearDown(self):self.tmp.cleanup()
    def feed(self,offset,bid,ask,pressure='BUY',snapshot=None):
        now=START+offset;self.t.tick(quote(now,bid,ask),snapshot if snapshot is not None else tape(now,pressure),now)
    def state(self):return self.t.state['setups']['test-zone']
    def test_lifecycle_uses_actual_ask_not_box_bottom(self):
        self.feed(100,115,116);self.assertEqual(self.state()['state'],'APPROACHING')
        self.feed(200,104,105);self.assertEqual(self.state()['state'],'TOUCHED')
        self.feed(300,104,105,'SELL');self.feed(400,105,106);self.feed(500,107,108)
        s=self.state();self.assertEqual(s['state'],'RESEARCH_ENTRY_PROPOSAL')
        self.assertEqual(s['reference_observations']['reading_proposal']['entry_quote'],108)
        events=[json.loads(l) for l in (self.path/'entry_events.jsonl').read_text().splitlines()]
        self.assertTrue(any(e['kind']=='OPPOSING_PROXY_FLOW_WITH_LOW_XAU_PROGRESS' for e in events))
        self.assertTrue(all(e['executed'] is False and e['net_pnl'] is None for e in events))
    def test_short_uses_bid_and_correct_response_sign(self):
        self.t=EntryTracker(self.path/'short');self.t.sync(context(items=[candidate('short')]),START)
        self.feed(100,105,106,'SELL');self.feed(200,106,107,'SELL');self.feed(300,105,106,'SELL');self.feed(400,103,104,'SELL')
        self.assertEqual(self.state()['state'],'RESEARCH_ENTRY_PROPOSAL')
        self.assertEqual(self.state()['reference_observations']['reading_proposal']['entry_quote'],103)
    def test_spread_cannot_fake_a_touch(self):
        self.feed(100,109,112);self.assertNotEqual(self.state()['state'],'TOUCHED')
    def test_future_tape_cannot_confirm(self):
        self.feed(100,104,105)
        for i in [200,300,400]:self.feed(i,108,109,snapshot=tape(START+10000))
        self.assertEqual(self.state()['state'],'WAITING_RESPONSE')
    def test_quote_before_registration_and_stale_broker_quote_rejected(self):
        self.t.tick(quote(START-1,104,105),tape(START-1),START)
        self.assertEqual(self.state()['state'],'REGISTERED')
        q=quote(START+100,104,105);q['data']['time_msc']=START-10000
        self.t.tick(q,tape(START+100),START+100)
        self.assertEqual(self.state()['state'],'REGISTERED')
    def test_stop_invalidates(self):
        self.feed(100,94,95);self.assertEqual(self.state()['state'],'INVALIDATED')
    def test_withdrawn_and_revoked_macro(self):
        self.t.sync(context(START+1,[]),START+1);self.assertEqual(self.state()['state'],'CANCELLED')
        other=EntryTracker(self.path/'other');other.sync(context(),START)
        c=candidate();c['macroEvaluation']['allowed']=False
        other.sync(context(START+1,[c]),START+1)
        self.assertEqual(other.state['setups']['test-zone']['reason'],'MACRO_APPROVAL_REVOKED')
    def test_missing_macro_never_registers_as_approved(self):
        c=candidate();del c['macroEvaluation']
        t=EntryTracker(self.path/'missing');t.sync(context(items=[c]),START)
        self.assertEqual(t.state['setups']['test-zone']['state'],'REJECTED')
    def test_touched_box_grace_cannot_bypass_new_macro_veto_without_candidate(self):
        self.t.config['withdrawn_grace_ms']=1800000
        self.feed(100,104,105)
        c=context(START+200,[])
        c['macro_preflight']={'long':{'multiplier':0,'isStale':False}}
        self.t.sync(c,START+200)
        self.assertEqual(self.state()['state'],'CANCELLED')
        self.assertEqual(self.state()['reason'],'MACRO_APPROVAL_REVOKED')
    def test_gap_resets_touch_and_does_not_invent_response(self):
        self.feed(100,104,105);self.feed(7000,115,116)
        self.assertNotIn('touch_utc_ms',self.state());self.assertNotEqual(self.state()['state'],'RESEARCH_ENTRY_PROPOSAL')
    def test_stale_context_suspends_and_ttl_expires(self):
        self.t.advance(START+40000);self.assertEqual(self.state()['state'],'SUSPENDED')
        self.t.advance(START+3600001);self.assertEqual(self.state()['state'],'EXPIRED')
    def test_restart_preserves_dedupe_and_lifecycle(self):
        self.feed(100,104,105);self.t.save();other=EntryTracker(self.path)
        other.sync(context(START+200),START+200)
        self.assertEqual(len(other.state['setups']),1)
        self.assertEqual(other.state['setups']['test-zone']['touch_utc_ms'],START+100)
    def test_reference_mark_includes_spread_but_not_unknown_costs(self):
        self.feed(100,104,105)
        s=self.state();s['reference_observations']['first_touch']['last_mark_ms']=START+60000
        self.t.tick(quote(START+60100,106,107),tape(START+60100),START+60100)
        mark=s['reference_observations']['first_touch']['marks']['60000']
        self.assertEqual(mark['quote_price_change'],1);self.assertIsNone(mark['net_pnl'])
    def test_gap_makes_reference_label_unavailable(self):
        self.feed(100,104,105);self.feed(60100,106,107)
        mark=self.state()['reference_observations']['first_touch']['marks']['60000']
        self.assertIsNone(mark['quote_price_change'])
    def test_retouch_never_replaces_original_control_quote(self):
        self.feed(100,104,105);self.feed(7000,115,116);self.feed(7100,106,107)
        self.assertEqual(self.state()['reference_observations']['first_touch']['entry_quote'],105)
    def test_future_context_cannot_register_setups(self):
        t=EntryTracker(self.path/'future');t.sync(context(START+1000),START)
        self.assertEqual(len(t.state['setups']),0)
    def test_transient_data_not_ready_preserves_fresh_context_and_active_touch(self):
        self.feed(100,104,105)
        self.assertEqual(self.state()['state'],'TOUCHED')
        for off in range(4000,16000,4000):
            self.feed(off,104,105)
        self.assertEqual(self.state()['state'],'WAITING_RESPONSE')
        self.t.sync({'observed_utc_ms':START+15000,'state':'DATA_NOT_READY','candidates':[]},START+15000)
        self.assertTrue(self.t.context_fresh(START+15000))
        self.assertEqual(self.state()['state'],'WAITING_RESPONSE')
        self.assertEqual(self.state()['touch_utc_ms'],START+100)
        for off in range(16000,50000,4000):
            self.feed(off,104,105)
        self.t.advance(START+50000)
        self.assertEqual(self.state()['state'],'WAITING_RESPONSE')
        self.assertEqual(self.state()['touch_utc_ms'],START+100)
    def test_cross_legs_context_only_confirms_with_stall_and_price_response(self):
        t=EntryTracker(self.path/'euraud',config={'require_patterns':True},symbol='EURAUD')
        c={'symbol':'EURAUD','signalId':'euraud-cross','tradeDirection':'long','poiType':'OB',
            'poi':{'low':1.6000,'high':1.6020},'gradeResult':{'entryAllowed':True},
            'macroEvaluation':{'allowed':True,'macroGateMultiplier':1,'isStale':False},
            'expectancyPlan':{'entryPrice':1.6010,'stopLoss':1.5950,'tp1':{'price':1.6200}}}
        t.sync(context(START,[c]),START)
        def cross_tick(offset,bid,ask):
            stamp=START+offset
            cross_tape={'generated_utc_ms':stamp,'state':'CROSS_LEGS_CONTEXT_ONLY','tape_features_usable':False,
                'mapping':{'mode':'CROSS_LEGS_CONTEXT_ONLY','legs':['6E','6A']},
                'reading_patterns':{'state':'UNAVAILABLE_NO_DIRECT_TAPE','absorption_candidates':[],
                    'liquidity_pulls':{'state':'UNAVAILABLE_NO_DIRECT_TAPE','candidates':[]},'source_usable':False}}
            t.tick({'kind':'broker_quote_tick','received_utc_ms':stamp,
                'data':{'symbol':'EURAUD','time_msc':stamp,'bid':bid,'ask':ask}},cross_tape,stamp)
        cross_tick(100,1.6009,1.6010)
        cross_tick(200,1.6009,1.6010)
        cross_tick(300,1.6011,1.6012)
        cross_tick(400,1.6014,1.6015)
        s=t.state['setups']['euraud-cross']
        self.assertEqual(s['state'],'RESEARCH_ENTRY_PROPOSAL')
        self.assertTrue(s.get('stall_observed'))
        self.assertEqual(s['pattern_assessment']['state'],'AUTOMATIC_PATTERN_CONFIRMATION_RESEARCH_ONLY')

if __name__=='__main__':unittest.main()
