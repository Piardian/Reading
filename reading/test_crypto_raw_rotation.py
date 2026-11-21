import gzip
import json
from pathlib import Path
import tempfile
from unittest.mock import patch
import unittest
from crypto_live import CryptoLive

class RawRotationTests(unittest.TestCase):
    def test_closed_gzip_fragments_retain_every_trade_and_never_append_to_old_daily(self):
        with tempfile.TemporaryDirectory() as d:
            c=CryptoLive({'BTCUSD':'BTCUSDT'},Path(d))
            try:
                for i in range(2):
                    with patch('crypto_live.time.time',return_value=1000+i*301):
                        c.emit({'kind':'trade','symbol':'BTCUSD','trade_id':i})
                c.writer.close();c.writer=None
                files=sorted(c.raw.glob('*.part*.jsonl.gz'))
                self.assertEqual(len(files),2)
                values=[]
                for p in files:
                    with gzip.open(p,'rt') as f:values.extend(json.loads(x) for x in f)
                self.assertEqual([v['trade_id'] for v in values],[0,1])
            finally:
                if c.writer:c.writer.close()
                c.http.close()

if __name__=='__main__':unittest.main()
