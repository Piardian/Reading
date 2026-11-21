"""Public crypto collector in its own process so pattern CPU cannot delay websocket reads."""
import multiprocessing as mp
from pathlib import Path
import queue
import time
import json
from crypto_live import CryptoLive,atomic

def collect(symbols,runtime,output,stop):
    live=CryptoLive(symbols,runtime);live.start();last_health=0
    parent=mp.parent_process();pending=[];last_emit=time.monotonic();batches=0
    try:
        while not stop.is_set() and (parent is None or parent.is_alive()):
            pending.extend(live.poll())
            if len(pending)>=2000 or time.monotonic()-last_emit>=.1:
                for i in range(0,len(pending),2000):
                    while not stop.is_set():
                        try:output.put(pending[i:i+2000],timeout=.25);batches+=1;break
                        except queue.Full:
                            if parent and not parent.is_alive():return
                pending=[];last_emit=time.monotonic()
            now=time.time()
            if now-last_health>=.5:
                h=live.health();h.update(collector_pid=mp.current_process().pid,transport='BOUNDED_MULTIPROCESS_BATCH_QUEUE',ipc_batches=batches,
                    ipc_queue_batches=output.qsize(),source_pending_events=live.events.qsize())
                atomic(Path(runtime)/'crypto_collector_status.json',h);last_health=now
                if h.get('connection')=='STOPPED':return
            stop.wait(.02)
    finally:
        live.close();output.cancel_join_thread()

class CryptoProcess:
    def __init__(self,symbols,runtime):
        self.symbols=symbols;self.runtime=Path(runtime);ctx=mp.get_context('spawn')
        self.events=ctx.Queue(maxsize=64);self.stop=ctx.Event();self.process=None;self.started_ms=0
    def start(self):
        self.started_ms=time.time_ns()//1000000
        self.process=mp.get_context('spawn').Process(target=collect,args=(self.symbols,self.runtime,self.events,self.stop),
            name='ReadingCryptoCollector',daemon=True);self.process.start()
    def poll(self):
        result=[]
        deadline=time.monotonic()+.15
        for _ in range(64):
            # multiprocessing's feeder can report an empty pipe between queued batches.
            # Give it a bounded wait instead of processing only one batch per engine tour.
            try:result.extend(self.events.get(timeout=.01))
            except queue.Empty:break
            if time.monotonic()>=deadline:break
        self.last_poll={'events':len(result),'last_received_utc_ms':max((e['received_utc_ms'] for e in result),default=None)}
        return result
    def health(self):
        if self.process is not None and not self.process.is_alive():
            return {'connection':'STOPPED','updated_utc_ms':time.time_ns()//1000000,'errors':{'collector':'PROCESS_EXITED'},'collector_pid':self.process.pid}
        try:
            h=json.loads((self.runtime/'crypto_collector_status.json').read_text(encoding='utf-8'))
            if h.get('collector_pid')!=self.process.pid or h.get('updated_utc_ms',0)<self.started_ms:raise ValueError('OLD_COLLECTOR_STATUS')
            h['parent_poll']=getattr(self,'last_poll',{})
            return h
        except (OSError,ValueError):return {'connection':'STARTING','updated_utc_ms':0,'errors':{}}
    def is_alive(self):
        return self.process is not None and self.process.is_alive()
    def restart(self):
        self.close()
        ctx = mp.get_context('spawn')
        self.events = ctx.Queue(maxsize=64)
        self.stop = ctx.Event()
        self.start()
    def close(self):
        self.stop.set()
        if self.process:
            self.process.join(timeout=5)
            if self.process.is_alive():self.process.terminate();self.process.join(timeout=2)
        try:self.events.close()
        except Exception:pass
