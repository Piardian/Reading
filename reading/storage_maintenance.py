"""Lossless archival of closed Quantower fragments; no account or order methods."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import threading
import time

NAME=re.compile(r'^\d{4}-\d{2}-\d{2}(?:\.part\d+)?\.jsonl$')
def digest_stream(stream):
    h=hashlib.sha256()
    for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def archive_closed(folder,now=None,minimum_age=120,archive_budget=8*1024**3):
    folder=Path(folder).resolve();now=time.time() if now is None else now
    marker=folder/'ACTIVE_FILE.txt'
    if not marker.exists():return {'state':'WAITING_ROTATING_EXPORTER','archived':0}
    active=marker.read_text(encoding='utf-8').strip()
    if not NAME.fullmatch(active):raise ValueError('INVALID_ACTIVE_FILE_MARKER')
    archive=folder/'archive';archive.mkdir(exist_ok=True)
    if archive.resolve().parent!=folder or archive.is_symlink():raise ValueError('UNEXPECTED_ARCHIVE_PATH')
    archive_bytes=sum(p.stat().st_size for p in archive.glob('*.gz'))
    count=0;saved=0
    for source in sorted(folder.glob('*.jsonl')):
        if not NAME.fullmatch(source.name) or source.name==active:continue
        if source.resolve().parent!=folder or source.is_symlink():raise ValueError('UNEXPECTED_SOURCE_PATH')
        before=source.stat()
        if now-before.st_mtime<minimum_age:continue
        if shutil.disk_usage(folder).free<2*1024**3:raise RuntimeError('ARCHIVE_LOW_DISK')
        target=archive/(source.name+'.gz');tmp=target.with_suffix('.gz.tmp')
        with source.open('rb') as f:original=digest_stream(f)
        if not target.exists():
            with source.open('rb') as src,gzip.open(tmp,'wb',compresslevel=1) as dest:shutil.copyfileobj(src,dest,1024*1024)
            with gzip.open(tmp,'rb') as check:
                if digest_stream(check)!=original:raise RuntimeError('ARCHIVE_HASH_MISMATCH')
            if archive_bytes+tmp.stat().st_size>archive_budget:raise RuntimeError('ARCHIVE_BUDGET_REACHED_RAW_PRESERVED')
            tmp.replace(target);archive_bytes+=target.stat().st_size
        with gzip.open(target,'rb') as check:
            if digest_stream(check)!=original:raise RuntimeError('EXISTING_ARCHIVE_HASH_MISMATCH_RAW_PRESERVED')
        after=source.stat()
        if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise RuntimeError('SOURCE_CHANGED_DURING_ARCHIVAL')
        if marker.read_text(encoding='utf-8').strip()==source.name:raise RuntimeError('SOURCE_BECAME_ACTIVE')
        receipt={'source':source.name,'archive':target.name,'sha256':original,'raw_bytes':before.st_size,
            'compressed_bytes':target.stat().st_size,'verified_utc_ms':time.time_ns()//1000000}
        target.with_suffix('.gz.meta.json').write_text(json.dumps(receipt),encoding='utf-8')
        source.unlink()  # Original bytes remain in independently hash-verified gzip.
        with (archive/'audit.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(receipt)+'\n')
        count+=1;saved+=before.st_size-target.stat().st_size
    return {'state':'READY','archived':count,'bytes_saved':saved,'archive_bytes':archive_bytes,
        'archive_budget_bytes':archive_budget,'retention':'LOSSLESS_ARCHIVES_NOT_AUTO_DELETED'}

class StorageMaintenance:
    def __init__(self,folder):
        self.folder=Path(folder);self.stop=threading.Event();self.thread=None;self.health={'state':'STARTING'}
    def start(self):
        self.thread=threading.Thread(target=self.run,name='ReadingArchive',daemon=True);self.thread.start()
    def run(self):
        while not self.stop.is_set():
            try:self.health={**archive_closed(self.folder),'updated_utc_ms':time.time_ns()//1000000}
            except Exception as e:self.health={'state':'FAILED','error':type(e).__name__+': '+str(e),'updated_utc_ms':time.time_ns()//1000000}
            self.stop.wait(60)
    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(timeout=20)
