import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from trade_management import POLICY,management_plan
from shadow_ledger import ShadowLedger
from test_shadow_ledger import DummyTelegram,quote
from entry_tracker import EntryTracker
from test_entry_tracker import candidate,context,tape,quote as spot,START

def setup(now,direction='long',target=None):
    long=direction=='long';target=target if target is not None else (120. if long else 80.)
    s={'id':'managed','state':'RESEARCH_ENTRY_PROPOSAL','direction':direction,'stop':90. if long else 110.,'target':target,
        'plan':{'tp2':{'price':target},'targetConstraint':'LIQUIDITY','resolvedLiquidityMagnet':{
            'priceLevel':target,'isActive':True,'type':'EQH' if long else 'EQL'}},
        'reference_observations':{'reading_proposal':{'entry_quote':100.,'observed_utc_ms':now,'quote_received_utc_ms':now}}}
    return SimpleNamespace(symbol='BTCUSD',state={'setups':{'managed':s}})

class ManagedLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.notifier=DummyTelegram()
        self.l=ShadowLedger(self.root,self.notifier,management=POLICY);self.now=max(self.l.created,self.l.policy_since)+10
    def tearDown(self):self.tmp.cleanup()
    def open(self,direction='long',target=None):self.l.register([setup(self.now,direction,target)],self.now)
    def tick(self,delta,bid,ask):self.l.quote('BTCUSD',quote(self.now+delta,bid,ask),self.now+delta)
    def test_half_at_one_r_then_be_produces_plus_50_model_dollars(self):
        self.open();self.tick(100,110,111)
        t=next(iter(self.l.open.values()));self.assertEqual(t['stop'],100);self.assertEqual(t['remaining_fraction'],.5)
        self.assertEqual(self.l.summary()['realized_model_gross_usd'],50)
        self.tick(200,100,101);s=self.l.summary()
        self.assertEqual(s['be'],1);self.assertEqual(s['tp1_hits'],1);self.assertEqual(s['gross_r'],.5)
        self.assertEqual(s['closed_model_gross_usd'],50);self.assertIsNone(s['net_pnl'])
    def test_two_r_liquidity_target_returns_150_not_200(self):
        self.open();self.tick(100,110,111);self.tick(200,120,121)
        self.assertEqual(self.l.summary()['tp'],1);self.assertEqual(self.l.summary()['gross_r'],1.5)
        self.assertEqual(self.l.summary()['closed_model_gross_usd'],150)
    def test_full_stop_and_observed_overshoot_are_weighted_correctly(self):
        self.open();self.tick(100,88,89)
        self.assertEqual(self.l.summary()['closed_model_gross_usd'],-120)
    def test_short_uses_exit_ask(self):
        self.open('short');self.tick(100,89,90);self.tick(200,79,80)
        self.assertEqual(self.l.summary()['closed_model_gross_usd'],150)
    def test_jump_past_both_targets_uses_same_observed_quote_not_invented_fill(self):
        self.open();self.tick(100,121,122)
        self.assertAlmostEqual(self.l.summary()['gross_r'],2.1);self.assertEqual(self.l.summary()['tp1_hits'],1)
    def test_gap_after_partial_keeps_known_50_but_remaining_is_unresolved(self):
        self.open();self.tick(100,110,111);self.tick(70000,130,131)
        s=self.l.summary();self.assertEqual(s['unresolved'],1);self.assertEqual(s['closed'],0)
        self.assertEqual(s['realized_model_gross_usd'],50);self.assertIsNone(s['net_pnl'])
    def test_restart_preserves_partial_and_does_not_repeat_notification(self):
        self.open();self.tick(100,110,111);before=len(self.notifier.messages)
        self.l=ShadowLedger(self.root,self.notifier,management=POLICY);self.l.advance(self.now+150)
        self.assertEqual(len(self.notifier.messages),before);self.tick(200,120,121)
        self.assertEqual(self.l.summary()['closed_model_gross_usd'],150)
    def test_minimum_two_r_checked_again_at_ledger(self):
        self.open(target=119.99);self.assertEqual(self.l.summary()['total'],0)
    def test_no_synthetic_or_farther_liquidity_to_rescue_trade(self):
        s=setup(self.now).state['setups']['managed'];s['plan']['targetConstraint']='SYNTHETIC_FALLBACK'
        with self.assertRaises(ValueError):management_plan(s,100,POLICY)
        # Capped target before liquidity pool (120 <= 130) is allowed, but target beyond pool (120 > 115) is rejected
        s=setup(self.now).state['setups']['managed'];s['plan']['resolvedLiquidityMagnet']['priceLevel']=130
        self.assertEqual(management_plan(s,100,POLICY)['tp2'],120)
        s=setup(self.now).state['setups']['managed'];s['plan']['resolvedLiquidityMagnet']['priceLevel']=115
        with self.assertRaises(ValueError):management_plan(s,100,POLICY)
    def test_new_policy_does_not_import_old_proposals(self):
        self.l.register([setup(self.l.policy_since-1)],self.now);self.assertEqual(self.l.summary()['total'],0)
    def test_telegram_says_shadow_and_unknown_net(self):
        self.open();self.tick(100,110,111);self.tick(200,120,121)
        texts='\n'.join(self.notifier.messages.values())
        self.assertIn('Varsayımsal ilk risk: $100.00',texts);self.assertIn('Gerçek net toplam: ölçülmedi',texts)

class EntryRRTests(unittest.TestCase):
    def test_actual_entry_gate_checks_tp2_not_original_reference_price(self):
        for target,expected in [(121.,'REJECTED'),(134.,'RESEARCH_ENTRY_PROPOSAL')]:
            with tempfile.TemporaryDirectory() as d:
                c=candidate();c['expectancyPlan'].update(tp2={'price':target},targetConstraint='LIQUIDITY',
                    resolvedLiquidityMagnet={'priceLevel':target,'isActive':True,'type':'EQH'})
                t=EntryTracker(Path(d),config={'management':POLICY});t.sync(context(items=[c]),START)
                for offset,bid,ask,pressure in [(100,104,105,'BUY'),(200,104,105,'SELL'),(300,105,106,'BUY'),(400,107,108,'BUY')]:
                    t.tick(spot(START+offset,bid,ask),tape(START+offset,pressure),START+offset)
                self.assertEqual(t.state['setups']['test-zone']['state'],expected)
                if expected=='REJECTED':self.assertEqual(t.state['setups']['test-zone']['reason'],'ACTUAL_ENTRY_RR_BELOW_2')

if __name__=='__main__':unittest.main()
