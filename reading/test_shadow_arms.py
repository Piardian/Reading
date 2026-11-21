import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from shadow_arms import ShadowArms
from test_shadow_ledger import DummyTelegram,proposed,quote
from benchmark_recorder import BenchmarkRecorder
from benchmark_reporter import arm_metrics


class ShadowArmTests(unittest.TestCase):
    def test_independent_results_restart_and_only_control_notifications(self):
        with tempfile.TemporaryDirectory() as d:
            runtime=Path(d);notifications=DummyTelegram()
            arms=ShadowArms(runtime,notifications)
            now=max(l.created for l in arms.ledgers.values())+100
            arms.register({'A':proposed(now),'B':proposed(now+1)},now+1)
            self.assertEqual(len(notifications.messages),1)
            arms.quote('BTCUSD',quote(now+100,121,122),now+100)
            self.assertEqual(len(notifications.messages),2)
            restored=ShadowArms(runtime,notifications)
            self.assertEqual(restored.summary()['A']['tp'],1)
            self.assertEqual(restored.summary()['B']['tp'],1)
            self.assertEqual(restored.summary()['C']['total'],0)
            self.assertNotEqual(restored.ledgers['A'].path,restored.ledgers['B'].path)
            restored.register({'D':proposed(now-10000)},now)
            self.assertEqual(restored.summary()['D']['total'],0)

    def test_benchmark_joins_only_its_own_arm_and_never_invents_no_entry_pnl(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);rec=BenchmarkRecorder(root/'runtime',root,interval_ms=0)
            setup={'id':'same','state':'EXPIRED','reason':'NO_RESPONSE_WITHIN_WINDOW','registered_utc_ms':1000}
            tracker=SimpleNamespace(state={'setups':{'same':setup}})
            trade={'id':'b','symbol':'BTCUSD','setup_id':'same','state':'CLOSED','outcome':'SL',
                   'gross_r':-1.2,'model_gross_usd':-120.}
            empty=SimpleNamespace(read_all=lambda:[])
            ledger=SimpleNamespace(read_all=lambda:[{'data':json.dumps(trade)}])
            rec.sync_multi_arms(2000,{'A':{'BTCUSD':tracker},'B':{'BTCUSD':tracker}}, {}, {'A':empty,'B':ledger})
            a=rec.records_by_id['A|BTCUSD|same'];b=rec.records_by_id['B|BTCUSD|same']
            self.assertIsNone(a['shadow_ledger_trade'])
            self.assertIsNone(a['post_trade_audit']['realized_r'])
            self.assertEqual(b['post_trade_audit']['realized_r'],-1.2)
            self.assertIsNone(b['post_trade_audit']['net_r'])
            self.assertIsNone(rec._build_macro_records([a])[0]['post_trade_macro_attribution']['macro_directional_accuracy'])

    def test_zero_trade_pf_is_unknown_and_unknown_net_is_preserved(self):
        m=arm_metrics([{'post_trade_audit':{'realized_r':10,'realized_usd':1000}}])
        self.assertEqual(m['total'],0)
        self.assertIsNone(m['gross_profit_factor'])
        self.assertIsNone(m['net_pnl'])
        self.assertEqual(m['gross_r'],0)

    def test_stale_or_future_proposal_quote_cannot_be_booked_as_an_entry(self):
        with tempfile.TemporaryDirectory() as d:
            arms=ShadowArms(Path(d),DummyTelegram())
            now=max(l.created for l in arms.ledgers.values())+10000
            for arm,offset in [('A',-2500),('B',1)]:
                tracker=proposed(now)
                tracker.state['setups']['setup']['reference_observations']['reading_proposal']['quote_received_utc_ms']=now+offset
                arms.register({arm:tracker},now)
                self.assertEqual(arms.summary()[arm]['total'],0)


if __name__=='__main__':unittest.main()
