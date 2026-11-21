import json
from pathlib import Path
import time

HERE=Path(__file__).resolve().parent
def read(name):
    p=HERE/'runtime'/name
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
def report():
    status=read('crypto_status.json');smc=read('crypto_smc_status.json').get('symbols',{})
    h=status.get('feed_health',{});now=time.time_ns()//1000000
    rows=[]
    for alias,v in status.get('symbols',{}).items():
        tape=v.get('tape',{});p=tape.get('reading_patterns',{});m=smc.get(alias,{})
        rows.append({'strategy_alias':alias,'market_identity':tape.get('market_identity'),
            'tape_state':tape.get('state'),'tape_reasons':tape.get('reasons'),
            'trade_events_60s':tape.get('trade_events'),'macro_smc_state':m.get('state'),
            'macro_preflight':m.get('macro_preflight'),'smc_errors':m.get('errors'),
            'speed':p.get('speed'),'absorption_candidates':len(p.get('absorption_candidates',[])),
            'liquidity_pulls':p.get('liquidity_pulls'),
            'automatic_entry':v.get('entry'),'control_entry':v.get('control_entry')})
    out={'checked_utc_ms':now,'status_age_ms':now-status.get('updated_utc_ms',0),'connection':h.get('connection'),
        'clock':h.get('clock'),'feed_errors':h.get('errors'),'raw_counts':h.get('counts'),
        'closed_candle_series':list(h.get('candles',{})),'symbols':rows,
        'order_routing':False,'edge_proven':False,'net_pnl':None}
    (HERE/'CRYPTO_REPORT.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# READİNG kripto durumu','','Akış: Makro → SMC/kutu → otomatik READING. Emir açılmaz.',
        '',f"Bağlantı: {out['connection']}; durum yaşı: {out['status_age_ms']} ms.",
        '', '| Piyasa | Bant | Son 60s işlem olayı | Makro/SMC | Setup |','|---|---|---:|---|---:|']
    for r in rows:
        venue=(r['market_identity'] or {}).get('venue_symbol',r['strategy_alias'])
        lines.append(f"| Binance spot {venue} | {r['tape_state']} | {r['trade_events_60s']} | {r['macro_smc_state']} | {(r['automatic_entry'] or {}).get('total_setups',0)} |")
        for direction,m in (r['macro_preflight'] or {}).items():
            if m.get('multiplier')!=1:lines.append(f"\n{venue} {direction}: {m.get('message')}")
    lines+=['','USDT kotasyonları broker USD fiyatı değildir. Top-20 defter fiyat seviyesidir; tekil emir kimliği ve spoofing niyeti doğrulanamaz. Makro veto kaldırılmaz. Kârlılık ve gerçek dolumlar ölçülmedi.']
    (HERE.parent/'CRYPTO_DURUM.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(out,ensure_ascii=True,indent=2));return out
if __name__=='__main__':report()
