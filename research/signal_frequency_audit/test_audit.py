import datetime as dt
import unittest
from research.signal_frequency_audit.audit import timestamp, distribution, delivery_counts


class AuditTests(unittest.TestCase):
    start = dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc)
    end = dt.datetime(2026, 10, 23, tzinfo=dt.timezone.utc)

    def test_text_success_and_graph_failure_are_distinct_and_signal_ids_are_unique(self):
        base = {'signalId': 'EURUSD_15m_OB_100_200', 'telegramSentAt': '2026-10-20T12:00:00Z', 'state': 'SENT'}
        failed = {**base, 'signalId': 'GBPUSD_15m_OB_100_200', 'state': 'SCREENSHOT_FAILED'}
        result = delivery_counts([base, base, failed], self.start, self.end)
        self.assertEqual(result, {'text_signals': 2, 'complete_deliveries': 1, 'image_failures_after_text': 1})

    def test_missing_timestamps_test_fixtures_and_out_of_window_rows_are_excluded(self):
        rows = [{'signalId': 'test_x_15m_fixture', 'state': 'SENT', 'telegramSentAt': '2026-10-20T12:00:00Z'},
                {'signalId': 'EURUSD_15m_OB_100_200', 'state': 'SENT'},
                {'signalId': 'EURUSD_15m_OB_100_200', 'state': 'SENT', 'telegramSentAt': '2026-10-01T12:00:00Z'}]
        self.assertEqual(delivery_counts(rows, self.start, self.end)['text_signals'], 0)

    def test_distribution_excludes_invalid_negative_samples(self):
        result = distribution([1, 10, -1, float('nan'), None])
        self.assertEqual(result['n'], 2)
        self.assertEqual(result['max'], 10)
        self.assertIsNone(distribution([])['p95'])

    def test_epoch_and_iso_timestamp_agree_and_naive_dates_are_not_silently_localized(self):
        self.assertEqual(timestamp(1792497600000), timestamp('2026-10-20T12:00:00Z'))
        self.assertIsNone(timestamp('2026-10-20T12:00:00'))

    def test_scheduler_offset_can_skip_an_available_future_slot(self):
        import math
        now_seconds = 14 * 60 + 50  # 00:14:50 within an hour
        observed_formula = math.ceil((now_seconds + 35) / 900) * 900 + 35
        next_future_slot = math.ceil((now_seconds - 35) / 900) * 900 + 35
        self.assertEqual(observed_formula, 30 * 60 + 35)
        self.assertEqual(next_future_slot, 15 * 60 + 35)

    def test_net_two_rr_threshold_with_synthetic_2_5r_target_has_cost_ceiling(self):
        self.assertAlmostEqual((2.5 - 1 / 6) / (1 + 1 / 6), 2)
        self.assertLess((2.5 - .2) / 1.2, 2)


if __name__ == '__main__':
    unittest.main()
