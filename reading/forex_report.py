import json
from pathlib import Path
import time
from forex_routes import SYMBOLS,route

ROOT=Path(__file__).resolve().parent
def report():
    p=ROOT/'runtime/forex_status.json'
    status=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
    config=json.loads((ROOT/'config.json').read_text(encoding='utf-8'))
    provider=config.get('futures_feed','ninjatrader')
    contexts_path=ROOT/'runtime/forex_candidates.json'
    contexts=json.loads(contexts_path.read_text(encoding='utf-8')).get('symbols',{}) if contexts_path.exists() else {}
    rows=[]
    for symbol in SYMBOLS:
        s=status.get('symbols',{}).get(symbol,{})
        mapping=route(symbol);t=s.get('tape',{});entry=s.get('entry',{})
        rows.append({'symbol':symbol,'coverage':mapping['mode'],'root':mapping.get('root'),
            'smc':contexts.get(symbol,{}).get('state','WAITING_SMC'),
            'tape':t.get('state','WAITING_'+provider.upper()),
            'setups':entry.get('total_setups',0),'states':entry.get('states',{}),
            'entry_rule':s.get('entry_rule','WAITING_RESTART'),
            'speed':t.get('reading_patterns',{}).get('speed',{}).get('state','UNAVAILABLE'),
            'absorption_candidates':len(t.get('reading_patterns',{}).get('absorption_candidates',[])),
            'liquidity_pull_detection':t.get('reading_patterns',{}).get('liquidity_pulls',{}).get('state','UNAVAILABLE')})
    result={'generated_utc_ms':time.time_ns()//1000000,'flow':'MACRO -> SMC -> READING',
            'symbols':rows,'order_routing':False,'futures_provider':provider,'live_connection_verified':False,'net_pnl':None}
    (ROOT/'FOREX_REPORT.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# READİNG Forex bağlantı durumu','','Akış: Makro → SMC → READİNG. Emir gönderimi kapalı.',
        '', '| Parite | Bant kapsamı | Kontrat kökü | SMC | Tape | Setup |','|---|---|---|---|---|---:|']
    for r in rows:lines.append(f"| {r['symbol']} | {r['coverage']} | {r['root'] or 'Çapraz bacaklar'} | {r['smc']} | {r['tape']} | {r['setups']} |")
    lines+=['',f'Seçili veri bağlantısı: {provider}. Canlı bandın gerçek zamanlılığı henüz doğrulanmadı. Çapraz bacaklar, paritenin kendi bandı sayılmaz. Net PnL ölçülmedi.']
    lines+=['','Otomatik giriş araştırması: temas sonrası hız artışı + absorption adayı + fiyat ve agresif akış dönüşü. Eski kural ayrı kontrol olarak kaydedilir. L2 veya doğrulanmış defter anlamı yoksa likidite çekilmesi/spoofing şüphesi ölçülemez.']
    (ROOT.parent/'FOREX_DURUM.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=True,indent=2))
if __name__=='__main__':report()
