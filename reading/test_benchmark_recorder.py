import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from benchmark_recorder import BenchmarkRecorder


class BenchmarkRecorderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runtime = self.root / 'runtime'
        self.shared = self.root / 'shared'
        self.shared.mkdir(parents=True, exist_ok=True)
        (self.shared / 'macro_bias_gate.json').write_text(
            json.dumps({
                'timestamp': '2026-11-09T20:00:00+03:00',
                'global_regime': 'RISK_ON',
                'currency_scores': {'USD': 0.5, 'JPY': -0.8},
            }),
            encoding='utf-8',
        )
        self.rec = BenchmarkRecorder(self.runtime, self.root, interval_ms=0)

    def tearDown(self):
        self.tmp.cleanup()

    def test_archives_macro_gate_on_change_and_dedupes_identical_payload(self):
        snap1 = self.rec.archive_macro_gate(1000)
        self.assertIsNotNone(snap1.get('sha256'))
        lines1 = (self.runtime / 'benchmark' / 'macro_gate_history.jsonl').read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines1), 1)

        # Identical payload within 15 minutes should not duplicate
        self.rec.archive_macro_gate(2000)
        lines2 = (self.runtime / 'benchmark' / 'macro_gate_history.jsonl').read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines2), 1)

        # Changed payload appends a new snapshot
        (self.shared / 'macro_bias_gate.json').write_text(
            json.dumps({
                'timestamp': '2026-11-09T20:15:00+03:00',
                'global_regime': 'NEUTRAL',
                'currency_scores': {'USD': 0.1, 'JPY': -0.2},
            }),
            encoding='utf-8',
        )
        self.rec.archive_macro_gate(3000)
        lines3 = (self.runtime / 'benchmark' / 'macro_gate_history.jsonl').read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines3), 2)

    def test_sync_builds_benchmark_and_macro_records(self):
        setup = {
            'id': 'sig-1',
            'state': 'RESEARCH_ENTRY_PROPOSAL',
            'direction': 'long',
            'low': 100.0,
            'high': 105.0,
            'stop': 95.0,
            'target': 125.0,
            'registered_utc_ms': 1000,
            'updated_utc_ms': 1500,
            'plan': {'targetConstraint': 'LIQUIDITY', 'primaryRR': 3.0},
            'original_candidate': {
                'poiType': 'OB',
                'gradeResult': {'grade': 'A', 'totalScore': 8},
                'macroEvaluation': {'allowed': True, 'macroGateMultiplier': 1, 'macroBias': 'LONG_ONLY'},
            },
            'reference_observations': {
                'first_touch': {'entry_quote': 104.5},
                'reading_proposal': {'entry_quote': 105.0},
            },
        }
        tracker = SimpleNamespace(state={'setups': {'sig-1': setup}})
        ledger_row = {
            'data': json.dumps({
                'id': 't1',
                'symbol': 'USDCAD',
                'setup_id': 'sig-1',
                'state': 'CLOSED',
                'outcome': 'BE',
                'gross_r': 0.5,
                'model_gross_usd': 50.0,
            })
        }
        ledger = SimpleNamespace(read_all=lambda: [ledger_row])
        self.rec.sync(2000, {'USDCAD': tracker}, {}, ledger)

        records = json.loads((self.runtime / 'benchmark' / 'benchmark_records.json').read_text(encoding='utf-8'))
        macro_records = json.loads((self.runtime / 'benchmark' / 'macro_records.json').read_text(encoding='utf-8'))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['post_trade_audit']['actual_outcome'], 'WIN_PARTIAL_TP_AND_BE')
        self.assertEqual(records[0]['post_trade_audit']['realized_usd'], 50.0)
        self.assertEqual(len(macro_records), 1)
        self.assertTrue(macro_records[0]['post_trade_macro_attribution']['macro_directional_accuracy'])


if __name__ == '__main__':
    unittest.main()
