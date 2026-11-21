from pathlib import Path
import tempfile
import json
import queue
from types import SimpleNamespace
from unittest.mock import patch
import unittest
from forex_quotes import ForexQuotes
from crypto_process import CryptoProcess
from test_crypto_feed import ready,health,NOW

class SourceTests(unittest.TestCase):
    def test_ipc_poll_waits_for_feeder_and_drains_batches_without_loss(self):
        with tempfile.TemporaryDirectory() as d:
            p=CryptoProcess({'BTCUSD':'BTCUSDT'},d);real=p.events
            class DelayedPipe:
                def __init__(self):self.rows=[[{'received_utc_ms':10}],[{'received_utc_ms':20}]]
                def get(self,timeout):
                    if not self.rows:raise queue.Empty()
                    return self.rows.pop(0)
            p.events=DelayedPipe()
            self.assertEqual([x['received_utc_ms'] for x in p.poll()],[10,20])
            self.assertEqual(p.last_poll['events'],2);real.close()
    def test_lazy_patterns_preserve_health_and_full_evaluation_when_requested(self):
        feed=ready();light=feed.snapshot('BTCUSD',NOW,health(),include_patterns=False)
        full=feed.snapshot('BTCUSD',NOW,health())
        self.assertEqual(light['tape_features_usable'],full['tape_features_usable'])
        self.assertEqual(light['trade_events'],full['trade_events'])
        self.assertEqual(light['reading_patterns']['state'],'NOT_EVALUATED_NO_APPROVED_SETUP')
        self.assertNotIn('state',full['reading_patterns'])
    def test_explicit_terminal_is_never_silently_redirected(self):
        terminal=r'C:\Program Files\Five Percent Online MetaTrader 5\terminal64.exe'
        q=ForexQuotes(['EURUSD'],terminal)
        with patch('forex_quotes.mt5.initialize',return_value=False) as start,patch('forex_quotes.mt5.last_error',return_value=(-6,'test')):
            q.poll()
        self.assertEqual(start.call_args.kwargs['path'],terminal)
    def test_other_terminal_path_is_rejected(self):
        q=ForexQuotes([],r'C:\Expected\terminal64.exe')
        with patch('forex_quotes.mt5.initialize',return_value=True),patch('forex_quotes.mt5.terminal_info',return_value=SimpleNamespace(path=r'C:\Other')),patch('forex_quotes.mt5.shutdown'):
            self.assertEqual(q.poll(),[])
        self.assertEqual(q.health['connection'],'UNEXPECTED_TERMINAL')
    def test_previous_collector_status_is_not_live_health(self):
        with tempfile.TemporaryDirectory() as d:
            p=CryptoProcess({'BTCUSD':'BTCUSDT'},d);p.started_ms=100;p.process=SimpleNamespace(pid=2,is_alive=lambda:True)
            Path(d,'crypto_collector_status.json').write_text(json.dumps({'collector_pid':1,'updated_utc_ms':999,'connection':'CONNECTED'}))
            self.assertEqual(p.health()['connection'],'STARTING');p.events.close()
    def test_dead_collector_cannot_report_connected(self):
        with tempfile.TemporaryDirectory() as d:
            p=CryptoProcess({'BTCUSD':'BTCUSDT'},d);p.process=SimpleNamespace(pid=2,is_alive=lambda:False)
            self.assertEqual(p.health()['connection'],'STOPPED');p.events.close()

if __name__=='__main__':unittest.main()
