"""Isolated read-only candle download: slow MT5 history cannot stall tape ingestion."""
import json
import msvcrt
import os
from pathlib import Path
import time
from forex_quotes import ForexQuotes

HERE=Path(__file__).resolve().parent
def main():
    runtime=HERE/'runtime';lock=(runtime/'mt5_candles.lock').open('a+b');lock.seek(0)
    try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:return 2
    config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))
    collector=ForexQuotes([*config['forex_symbols'],'XAUUSD'],config['forex_mt5_terminal'],runtime/'mt5_inputs')
    quotes=runtime/'mt5_quotes';quotes.mkdir(exist_ok=True)
    try:
        while not (runtime/'STOP').exists():
            events=collector.poll()
            if events:
                path=quotes/(time.strftime('%Y-%m-%d',time.gmtime())+'.jsonl')
                with path.open('a',encoding='utf-8') as f:
                    for event in events:f.write(json.dumps(event,separators=(',',':'))+'\n')
            collector.atomic(runtime/'mt5_candles_status.json',json.dumps({'pid':os.getpid(),
                'updated_utc_ms':time.time_ns()//1000000,'order_routing':False,**collector.health}).encode('utf-8'))
            time.sleep(.5)
    finally:collector.close();lock.close()
    return 0
if __name__=='__main__':raise SystemExit(main())
