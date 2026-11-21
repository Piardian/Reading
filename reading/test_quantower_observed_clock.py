import unittest
from datetime import datetime,timezone
from quantower_feed import QuantowerFeed
from test_quantower_feed import NOW,event

def observed():
    n=QuantowerFeed()
    for i in range(22):
        stamp=NOW-40000+i*1800
        explicit=i%2==1
        value=datetime.fromtimestamp((stamp-100)/1000,timezone.utc).isoformat()
        if not explicit:value=value.replace('+00:00','')
        n.ingest(event(i+1,received_utc_ms=stamp,feed_label='UNVERIFIED',platform_time_raw=value,
            platform_time_kind='Utc' if explicit else 'Unspecified'),NOW)
    n.ingest(event(23,'heartbeat',received_utc_ms=NOW-100),NOW)
    return n

class ObservedClockTests(unittest.TestCase):
    def test_empirical_research_gate_keeps_raw_label_and_no_orders(self):
        n=observed();r=n.snapshot('EURUSD',NOW)
        self.assertTrue(r['tape_features_usable'])
        self.assertEqual(r['observed_feed_validation']['state'],'OBSERVED_FRESH_RESEARCH')
        self.assertEqual({x['feed_label'] for x in n.windows['6E']},{'UNVERIFIED'})
        self.assertFalse(r['execution_allowed']);self.assertFalse(r['observed_feed_validation']['entitlement_verified'])
    def test_unspecified_only_is_not_a_utc_proof(self):
        n=observed()
        for x in n.windows['6E']:
            x['platform_time_kind']='Unspecified';x['platform_time_raw']=x['platform_time_raw'].replace('+00:00','')
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_delayed_trade_blocks_entire_window(self):
        n=observed();n.windows['6E'][5]['platform_time_raw']='1970-01-01T00:00:00+00:00'
        self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_replay_or_reported_delay_is_not_promoted(self):
        for key,value in [('feed_label','REPLAY'),('provider_delay_ms',900000)]:
            n=observed();n.windows['6E'][0][key]=value
            self.assertFalse(n.snapshot('EURUSD',NOW)['tape_features_usable'])
    def test_future_rows_do_not_change_past_validation(self):
        n=observed();before=n.snapshot('EURUSD',NOW-500)
        n.ingest(event(24,received_utc_ms=NOW,feed_label='DELAYED'),NOW)
        self.assertEqual(before,n.snapshot('EURUSD',NOW-500))
    def test_cross_stays_context_only(self):
        self.assertFalse(observed().snapshot('EURJPY',NOW)['tape_features_usable'])

if __name__=='__main__':unittest.main()
