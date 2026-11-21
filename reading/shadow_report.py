import json
from pathlib import Path
from reading_telegram import ReadingTelegram
from shadow_ledger import summarize_records

HERE=Path(__file__).resolve().parent
def report():
    # Read-only report: do not instantiate the live notifier or mutate outbox states.
    import sqlite3
    path=HERE/'runtime/reading_shadow.sqlite3';rows=[]
    if path.exists():
        c=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
        try:rows=[json.loads(r[0]) for r in c.execute('SELECT data FROM trades')]
        finally:c.close()
    summary={'scope':'OBSERVED_BBO_SHADOW_NOT_BROKER_VERIFIED',**summarize_records(rows)}
    (HERE/'SHADOW_REPORT.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# READING gölge işlem özeti','','Yeni politika: $100 varsayımsal risk; +1R %50 kapanış, kalan stop girişe; ikinci hedef aktif likidite havuzu ve en az +2R. Gerçek emir/dolum veya broker lot hesabı değildir.',
        '',f"Toplam kayıt: {summary['total']} | Açık: {summary['open']}",
        f"TP1: {summary['tp1_hits']} | TP2: {summary['tp']} | SL: {summary['sl']} | Kalan BE: {summary['be']} | Belirsiz: {summary['unresolved']}",
        f"Gerçekleşmiş varsayımsal brüt (kısmi kapanışlar dahil): ${summary['realized_model_gross_usd']:+.2f}",
        f"Kotasyon bazlı toplam brüt: {summary['gross_r']:+.3f}R",'Komisyon: ölçülmedi','Kayma: ölçülmedi','Gerçek net toplam: ölçülmedi',
        '', 'Her işlem kendi ilk riskine göre normalize edilir. R toplamı hesap getirisi değildir. Spread kullanılan Bid/Ask referanslarında bulunur. Eksik veri kazanç veya sıfır maliyet sayılmaz.']
    (HERE.parent/'READING_GOLGE_RAPOR.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=True,indent=2));return summary
if __name__=='__main__':report()
