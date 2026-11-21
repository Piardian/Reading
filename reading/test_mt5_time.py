import unittest
from mt5_time import WINTER_START,WINTER_END,quote_clock_offset,normalize_closed_rates

class ClockTests(unittest.TestCase):
    def test_documented_offset_requires_live_residual(self):
        now=WINTER_START+86400000
        self.assertEqual(quote_clock_offset(now+7200000-100,now),7200000)
        self.assertIsNone(quote_clock_offset(now+7200000-3000,now))
        self.assertIsNone(quote_clock_offset(now+10800000,now))
    def test_cached_two_hour_old_quote_cannot_masquerade_as_native_utc(self):
        now=WINTER_START+86400000
        self.assertIsNone(quote_clock_offset(now,now))
    def test_outside_winter_window_stays_unknown(self):
        for now in [WINTER_START-1,WINTER_END]:
            self.assertIsNone(quote_clock_offset(now+7200000,now))
    def test_only_closed_winter_history_and_original_ohlc(self):
        start=WINTER_START
        raw=[{'time':(start+i*60000+7200000)//1000,'open':100,'high':102,'low':99,'close':101} for i in range(-1,22)]
        bars=normalize_closed_rates(raw,60000,7200000,start+20*60000)
        self.assertEqual(len(bars),20)
        self.assertEqual(bars[0]['timestamp'],start)
        self.assertEqual(bars[-1]['timestamp'],start+19*60000)
        changed=raw+[{'time':(start+30*60000+7200000)//1000,'open':999,'high':1000,'low':998,'close':999}]
        self.assertEqual(bars,normalize_closed_rates(changed,60000,7200000,start+20*60000))
    def test_short_history_does_not_create_bars(self):
        with self.assertRaises(ValueError):normalize_closed_rates([],60000,7200000,WINTER_START+86400000)

if __name__=='__main__':unittest.main()
