import datetime as dt
import unittest
from preprocessing.relative_policy import build_relative_policy_repricing
from preprocessing.crypto_rotation import derivatives_data_issues


class RelativePolicyTests(unittest.TestCase):
    now = dt.datetime(2026, 10, 23, 12, tzinfo=dt.timezone.utc)

    def market(self):
        def row(currency, rate, old):
            return {"source": currency + " OIS", "as_of": self.now.isoformat(),
                    "previous_as_of": (self.now - dt.timedelta(days=1)).isoformat(),
                    "implied_rate_pct": rate, "previous_implied_rate_pct": old,
                    "instrument_id": currency + "-2027-04", "previous_instrument_id": currency + "-2027-04",
                    "horizon": "6M", "maturity_date": "2027-04-23"}
        return {"POLICY_RATE_EXPECTATIONS": {"EUR": row("EUR", 2.1, 2), "USD": row("USD", 4.05, 4)}}

    def test_matched_bilateral_changes_and_inverse_pair_have_opposite_signs(self):
        panel = build_relative_policy_repricing(self.market(), self.now)
        self.assertEqual(panel["pairs"]["EURUSD"]["relative_reprice_bps"], 5)
        self.assertEqual(panel["pairs"]["USDEUR"]["relative_reprice_bps"], -5)
        self.assertEqual(panel, build_relative_policy_repricing(self.market(), self.now))

    def test_missing_leg_is_not_assumed_unchanged(self):
        market = self.market()
        del market["POLICY_RATE_EXPECTATIONS"]["USD"]
        self.assertEqual(build_relative_policy_repricing(market, self.now)["pairs"], {})

    def test_no_explicit_clock_or_future_observations_produces_no_signal(self):
        self.assertEqual(build_relative_policy_repricing(self.market(), None)["status"], "UNAVAILABLE")
        self.assertEqual(build_relative_policy_repricing(self.market(), self.now - dt.timedelta(hours=1))["pairs"], {})

    def test_contract_roll_staleness_and_horizon_mismatch_are_rejected(self):
        for key, value in [("previous_instrument_id", "old-contract"), ("as_of", (self.now - dt.timedelta(days=3)).isoformat()), ("horizon", "1Y"), ("implied_rate_pct", float('nan')), ("maturity_date", "2025-01-01")]:
            market = self.market()
            market["POLICY_RATE_EXPECTATIONS"]["EUR"][key] = value
            self.assertEqual(build_relative_policy_repricing(market, self.now)["pairs"], {})

    def test_insufficient_derivative_inputs_do_not_become_neutral_confirmation(self):
        self.assertIn("FUNDING_UNAVAILABLE", derivatives_data_issues({}))
        self.assertIn("OI_24H_HISTORY_UNAVAILABLE", derivatives_data_issues({"funding_rate": 0, "oi_history_1h": [{"sum_open_interest": 100}] * 5}))


if __name__ == '__main__':
    unittest.main()
