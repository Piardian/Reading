"""Forward shadow account report. Candidate outcomes are not trade PnL."""
import json
import sys
from pathlib import Path
from collections import Counter
from shadow_ledger import summarize_records

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
BENCH_DIR=HERE/'runtime'/'benchmark'
RECORDS_FILE=BENCH_DIR/'benchmark_records.json'
MACRO_HISTORY_FILE=BENCH_DIR/'macro_gate_history.jsonl'
REPORT_MD_FILE=ROOT/'READING_BENCHMARK_RAPOR.md'


def load_json_list(path):
    if not path.exists():return []
    data=json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data,list):raise ValueError('BENCHMARK_RECORDS_NOT_A_LIST')
    return data


def arm_metrics(records):
    trades={}
    for record in records:
        t=record.get('shadow_ledger_trade')
        if t:trades[t['id']]=t
    summary=summarize_records(list(trades.values()))
    loss=abs(summary['gross_loss_r'])
    summary['gross_profit_factor']=summary['gross_profit_r']/loss if loss else None
    summary['setups']=len(records)
    summary['touched_setups']=sum(bool((r.get('reading_microstructure_layer') or {}).get('touch_utc_ms')) for r in records)
    summary['no_entry_setups']=sum(not r.get('shadow_ledger_trade') for r in records)
    return summary


def generate_report():
    records=load_json_list(RECORDS_FILE)
    definitions={'A':'Kontrol: makro + 90 sn','B':'Makro + 300 sn',
                 'C':'Araştırma: makro kapalı + 90 sn','D':'Araştırma: makro kapalı + 300 sn'}
    metrics={a:arm_metrics([r for r in records if r.get('arm','A')==a]) for a in definitions}
    diagnostics=Counter((r.get('post_trade_audit') or {}).get('error_diagnosis','UNKNOWN') for r in records)
    unique=len({(r.get('symbol'),r.get('setup_id')) for r in records})
    lines=['# READİNG gölge işlem karnesi','',
        f'Kayıt: {len(records)} kol-kurulum; farklı piyasa kurulumu: {unique}.',
        'A ana kontrol hesabıdır. B/C/D bağımsız deneylerdir; sonuçları ana hesabın kazancına eklenmez.',
        'Gerçek emir/dolum yoktur. Komisyon ve kayma ölçülmediği için net PnL ölçülmedi.',
        'İşleme dönüşmeyen, reddedilen veya süresi dolan kutular kâr ya da korunmuş zarar sayılmaz.','',
        '| Kol | Kural | Kurulum | Temas | İşlem | Açık | Kapalı | TP2 | SL | Kalan BE | Belirsiz | Kapalı brüt R | Brüt PF |',
        '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for arm,desc in definitions.items():
        m=metrics[arm];pf=f"{m['gross_profit_factor']:.2f}" if m['gross_profit_factor'] is not None else 'hesaplanamaz'
        lines.append(f"| {arm} | {desc} | {m['setups']} | {m['touched_setups']} | {m['total']} | {m['open']} | {m['closed']} | {m['tp']} | {m['sl']} | {m['be']} | {m['unresolved']} | {m['gross_r']:+.3f} | {pf} |")
    a=metrics['A']
    lines += ['',f"Ana hesap gerçekleşmiş model brüt: {a['realized_total_gross_r']:+.3f}R / ${a['realized_model_gross_usd']:+.2f}.",
        f"Açık/belirsiz kayıtlardaki gerçekleşmiş kısmi brüt: {a['partial_realized_r_not_closed']:+.3f}R.",
        'PF yalnızca tamamlanmış ve sonucu ölçülmüş gölge işlemlerden hesaplanır; zarar toplamı yoksa tanımsızdır.',
        'Net R / net USD / komisyon / kayma: ölçülmedi. 1R = varsayımsal $100; broker kazancı değildir.','',
        '## Kurulumların son engelleri (kollar aynı kurulumu tekrar içerebilir)','']
    lines += [f'- {reason}: {count}' for reason,count in diagnostics.most_common()]
    REPORT_MD_FILE.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    result={'total_records':len(records),'unique_setups':unique,'arms':metrics,
            'net_r':None,'net_usd':None,'diagnoses':dict(diagnostics)}
    (BENCH_DIR/'performance_summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    if sys.platform=='win32':sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(lines))
    return result


if __name__=='__main__':generate_report()
