import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import requests
from unittest.mock import patch
from shadow_ledger import ShadowLedger
from reading_telegram import ReadingTelegram,connect

class DummyTelegram:
    def __init__(self):self.messages={}
    def has(self,key):return key in self.messages
    def enqueue(self,key,text):self.messages.setdefault(key,text)

def proposed(now):
    return SimpleNamespace(symbol='BTCUSD',state={'setups':{'setup':{'id':'setup','state':'RESEARCH_ENTRY_PROPOSAL',
        'direction':'long','stop':90.,'target':120.,'reference_observations':{'reading_proposal':{
            'entry_quote':100.,'observed_utc_ms':now,'quote_received_utc_ms':now}}}}})
def quote(stamp,bid,ask):return {'kind':'crypto_quote_tick','received_utc_ms':stamp,'data':{'bid':bid,'ask':ask}}

class LedgerTests(unittest.TestCase):
    def test_tp_is_quote_model_not_filled_net_profit(self):
        with tempfile.TemporaryDirectory() as d:
            n=DummyTelegram();l=ShadowLedger(Path(d),n);now=l.created+10;l.register([proposed(now)],now)
            l.quote('BTCUSD',quote(now+100,121,122),now+100)
            s=l.summary();self.assertEqual(s['tp'],1);self.assertAlmostEqual(s['gross_r'],2.1)
            self.assertIsNone(s['net_pnl']);self.assertIsNone(s['commission']);self.assertIsNone(s['slippage'])
            self.assertEqual(len(n.messages),2)
    def test_stop_overshoot_is_not_assumed_minus_one_r(self):
        with tempfile.TemporaryDirectory() as d:
            l=ShadowLedger(Path(d),DummyTelegram());now=l.created+10;l.register([proposed(now)],now)
            l.quote('BTCUSD',quote(now+100,88,89),now+100)
            self.assertAlmostEqual(l.summary()['gross_r'],-1.2);self.assertEqual(l.summary()['sl'],1)
    def test_data_gap_is_unresolved_not_tp(self):
        with tempfile.TemporaryDirectory() as d:
            l=ShadowLedger(Path(d),DummyTelegram());now=l.created+10;l.register([proposed(now)],now)
            l.quote('BTCUSD',quote(now+61000,125,126),now+61000)
            s=l.summary();self.assertEqual(s['unresolved'],1);self.assertEqual(s['tp'],0);self.assertEqual(s['closed'],0)
    def test_register_and_restart_deduplicate_open_notifications(self):
        with tempfile.TemporaryDirectory() as d:
            n=DummyTelegram();l=ShadowLedger(Path(d),n);now=l.created+10;t=proposed(now)
            l.register([t],now);l.register([t],now)
            other=ShadowLedger(Path(d),n);other.register([t],now)
            self.assertEqual(other.summary()['total'],1);self.assertEqual(len(n.messages),1)
    def test_existing_pre_reporting_proposals_are_not_broadcast(self):
        with tempfile.TemporaryDirectory() as d:
            n=DummyTelegram();l=ShadowLedger(Path(d),n);l.register([proposed(l.created-1000)],l.created)
            self.assertEqual(l.summary()['total'],0);self.assertFalse(n.messages)
    def test_be_does_not_mean_commission_free_net_zero(self):
        with tempfile.TemporaryDirectory() as d:
            l=ShadowLedger(Path(d),DummyTelegram());now=l.created+10;l.register([proposed(now)],now)
            t=next(iter(l.open.values()));t['stop']=t['entry'];l.save(t)
            l.quote('BTCUSD',quote(now+100,100,101),now+100)
            self.assertEqual(l.summary()['be'],1);self.assertIsNone(l.summary()['net_pnl'])

class NotificationTests(unittest.TestCase):
    def run_once(self,n,response=None,error=None,retry=False):
        n.token='unit-test-not-a-secret';n.chat='unit-test'
        n.enqueue('unit-delivery','unit message')
        waits=[False,True,True] if retry else [False,True]
        with patch.object(n.stop,'wait',side_effect=waits),patch('reading_telegram.requests.post',return_value=response,side_effect=error):n.run()
    def test_http_200_with_ok_false_is_not_delivery(self):
        with tempfile.TemporaryDirectory() as d:
            n=ReadingTelegram(Path(d),'unused',False)
            self.run_once(n,SimpleNamespace(status_code=200,json=lambda:{'ok':False,'error_code':400}))
            self.assertEqual(n.status()['outbox'],{'FAILED':1});self.assertIsNone(n.status()['last_confirmed_delivery'])
    def test_timeout_is_uncertain_and_token_is_not_logged(self):
        with tempfile.TemporaryDirectory() as d:
            n=ReadingTelegram(Path(d),'unused',False)
            self.run_once(n,error=requests.ReadTimeout('https://api.telegram.org/botSECRET/sendMessage'))
            self.assertEqual(n.status()['outbox'],{'UNKNOWN':1})
            self.assertNotIn('SECRET',(Path(d)/'reading_telegram_delivery.jsonl').read_text())
    def test_rate_limit_is_pending_and_not_claimed_delivered(self):
        with tempfile.TemporaryDirectory() as d:
            n=ReadingTelegram(Path(d),'unused',False)
            self.run_once(n,SimpleNamespace(status_code=429,json=lambda:{'ok':False,'error_code':429,'parameters':{'retry_after':1}}),retry=True)
            self.assertEqual(n.status()['outbox'],{'PENDING':1});self.assertIsNone(n.status()['last_confirmed_delivery'])
    def test_outbox_stable_ids_do_not_duplicate(self):
        with tempfile.TemporaryDirectory() as d:
            n=ReadingTelegram(Path(d),'unused',False);n.enqueue('same','one');n.enqueue('same','two')
            self.assertEqual(n.status()['outbox'],{'PENDING':1})
    def test_restart_during_send_is_uncertain_and_not_retried(self):
        with tempfile.TemporaryDirectory() as d:
            n=ReadingTelegram(Path(d),'unused',False);n.enqueue('one','text')
            with connect(n.db) as c:c.execute("UPDATE outbox SET state='SENDING'")
            other=ReadingTelegram(Path(d),'unused',False)
            self.assertEqual(other.status()['outbox'],{'UNKNOWN':1})

if __name__=='__main__':unittest.main()
