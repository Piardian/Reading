import gzip
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from storage_maintenance import archive_closed
from tape_engine import LogTail

class ArchiveTests(unittest.TestCase):
    def setup_folder(self,folder):
        active=folder/'2026-11-09.part00000001.jsonl';active.write_text('{"seq":2}\n')
        (folder/'ACTIVE_FILE.txt').write_text(active.name)
        old=folder/'2026-11-09.part00000000.jsonl';old.write_bytes(b'{"seq":1}\n'*100)
        os.utime(old,(time.time()-300,time.time()-300));return old,active
    def test_verified_archive_retains_exact_bytes_and_active_file(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);old,active=self.setup_folder(folder);payload=old.read_bytes()
            result=archive_closed(folder)
            self.assertEqual(result['archived'],1);self.assertFalse(old.exists());self.assertTrue(active.exists())
            with gzip.open(folder/'archive'/(old.name+'.gz'),'rb') as f:self.assertEqual(f.read(),payload)
            self.assertEqual(archive_closed(folder)['archived'],0)
    def test_recent_closed_fragment_is_not_archived(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);old,active=self.setup_folder(folder);os.utime(old,None)
            self.assertEqual(archive_closed(folder)['archived'],0);self.assertTrue(old.exists())
    def test_bad_existing_archive_keeps_original(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);old,_=self.setup_folder(folder);(folder/'archive').mkdir()
            with gzip.open(folder/'archive'/(old.name+'.gz'),'wb') as f:f.write(b'wrong')
            with self.assertRaises(RuntimeError):archive_closed(folder)
            self.assertTrue(old.exists())
    def test_archive_budget_preserves_raw_file(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);old,_=self.setup_folder(folder)
            with self.assertRaises(RuntimeError):archive_closed(folder,archive_budget=1)
            self.assertTrue(old.exists())
    def test_active_marker_cannot_escape_directory(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);old,_=self.setup_folder(folder);(folder/'ACTIVE_FILE.txt').write_text('../outside.jsonl')
            with self.assertRaises(ValueError):archive_closed(folder)
            self.assertTrue(old.exists())
    def test_reader_continues_rotation_without_duplicates_or_partial_lines(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);p=folder/'2026-11-09.part00000000.jsonl';p.write_bytes(b'{"seq":1}\n{"seq":')
            tail=LogTail(folder);self.assertEqual(tail.poll(),[{'seq':1}])
            with p.open('ab') as f:f.write(b'2}\n')
            n=folder/'2026-11-09.part00000001.jsonl';n.write_text('{"seq":3}\n')
            self.assertEqual(tail.poll(),[{'seq':2},{'seq':3}]);self.assertEqual(tail.poll(),[])
    def test_bounded_bootstrap_skips_archived_prefix_but_reads_new_events_once(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);p=folder/'2026-11-09.jsonl'
            p.write_text(''.join(json.dumps({'seq':i})+'\n' for i in range(100)))
            tail=LogTail(folder,initial_max_bytes=80);rows=tail.poll()
            self.assertGreater(tail.bootstrap_skipped_bytes,0);self.assertLess(len(rows),100)
            self.assertEqual(rows[-1]['seq'],99);self.assertEqual(tail.poll(),[])
            with p.open('a') as f:f.write('{"seq":100}\n')
            self.assertEqual(tail.poll(),[{'seq':100}])

if __name__=='__main__':unittest.main()
