"""Read-only local bridge diagnostics. Never queries accounts or sends data."""
from collections import Counter
import json
from pathlib import Path
import time
import re
from quantower_feed import CQG_ROOTS

HERE=Path(__file__).resolve().parent
def report():
    config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))
    folder=Path(config['quantower_feed_directory']);now=time.time_ns()//1000000
    counts=Counter();roots={};last_heartbeat=None;errors=[];bad=0;last=None
    # Last two days, capped at 16 MiB per file: this is diagnostics, not a full audit.
    for path in sorted(folder.glob('*.jsonl'))[-2:]:
        with path.open('rb') as f:
            if path.stat().st_size>16*1024*1024:
                f.seek(-16*1024*1024,2);f.readline()
            for line in f:
                if not line.endswith(b'\n'):continue
                try:e=json.loads(line)
                except ValueError:bad+=1;continue
                if e.get('source')!='QUANTOWER_DESKTOP':continue
                counts[e.get('kind','UNKNOWN')]+=1;last=e
                if e.get('kind')=='heartbeat':last_heartbeat=e
                if e.get('kind')=='subscription_error':errors.append(e)
                if e.get('root'):
                    item=roots.setdefault(e['root'],{'provider_symbol':e.get('provider_symbol'),'trade_events':0,'quote_events':0,'depth_events':0})
                    if e['kind']=='trade':item['trade_events']+=1
                    if e['kind']=='quote':item['quote_events']+=1
                    if e['kind'] in {'depth_delta','depth_snapshot'}:item['depth_events']+=1
    age=now-last_heartbeat['received_utc_ms'] if last_heartbeat else None
    fresh=age is not None and 0<=age<=10000
    refusals={}
    # Read only public market-data refusal messages, never connection credentials.
    provider_log=Path(r'C:\AMP Quantower\Logs\Serilog')/time.strftime('%Y%m%d.slog',time.gmtime())
    if provider_log.exists():
        with provider_log.open(encoding='utf-8-sig') as f:
            for line in f:
                try:row=json.loads(line)
                except ValueError:continue
                msg=str(row.get('ev',''))
                if 'Real-time data subscription for instrument ' not in msg or 'is not enabled' not in msg:continue
                for root,cqg in CQG_ROOTS.items():
                    if re.search(r'F\.US\.'+re.escape(cqg)+r'(?:\s|\()',msg):
                        refusals[root]={'provider_root':cqg,'last_observed_utc':row.get('@t'),
                            'status':'REFUSAL_OBSERVED_IN_TODAYS_PLATFORM_LOG_NOT_A_FRESH_ENTITLEMENT_QUERY'}
    result={'generated_utc_ms':now,'state':'BRIDGE_HEARTBEAT_FRESH' if fresh else 'WAITING_OR_STALE_QUANTOWER',
        'heartbeat_age_ms':age,'connection_state':last_heartbeat.get('connection_state') if last_heartbeat else None,
        'feed_label':last_heartbeat.get('feed_label') if last_heartbeat else None,
        'observed_event_counts':dict(counts),'roots':roots,'recent_subscription_errors':errors[-20:],
        'malformed_lines':bad,'dropped_total':last_heartbeat.get('dropped_total') if last_heartbeat else None,
        'provider_refusals_observed':refusals,
        'live_verified':False,'order_routing':False,'execution_allowed':False,'net_pnl':None,
        'diagnostic_scope':'LATEST_TWO_FILES_MAX_16_MIB_EACH_NOT_ENTITLEMENT_OR_CLOCK_PROOF'}
    (HERE/'quantower/STATUS.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# Quantower → READİNG','','Akış: Makro → SMC/kutu → READİNG. Emir açılmaz.',
        '',f"Köprü: {result['state']}",f"Bağlantı: {result['connection_state']}",f"Veri etiketi: {result['feed_label']}",
        '', '| Kontrat | CQG sembolü | İşlem olayı | Kotasyon | Derinlik olayı |','|---|---|---:|---:|---:|']
    for root,s in roots.items():lines.append(f"| {root} | {s['provider_symbol']} | {s['trade_events']} | {s['quote_events']} | {s['depth_events']} |")
    lines+=['','Heartbeat yalnızca köprünün çalıştığını gösterir. Canlı bant, gecikme, saat ve abonelik ayrıca doğrulanır. Net PnL ölçülmedi.']
    if refusals:lines+=['','Bugünkü platform günlüğünde gerçek zamanlı veri reddi görülen kökler: '+', '.join(refusals)+'. Bunlar anlık abonelik sorgusu değildir; piyasa açılışında yeniden kontrol edilir.']
    (HERE.parent/'QUANTOWER_DURUM.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True,indent=2))
    return result
if __name__=='__main__':report()
