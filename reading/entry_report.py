"""Descriptive coverage report; missing fills and costs remain unknown."""
from collections import Counter
import json
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parent
def report():
    file=ROOT/'runtime/entry_state.json'
    state=json.loads(file.read_text(encoding='utf-8')) if file.exists() else {'setups':{}}
    setups=list(state['setups'].values())
    states=Counter(s['state'] for s in setups)
    touched=[s for s in setups if 'first_touch' in s['reference_observations']]
    proposed=[s for s in setups if 'reading_proposal' in s['reference_observations']]
    pairs=[]
    for s in proposed:
        refs=s['reference_observations'];a=refs['first_touch'];b=refs['reading_proposal']
        improvement=a['entry_quote']-b['entry_quote'] if s['direction']=='long' else b['entry_quote']-a['entry_quote']
        pairs.append({'setup_id':s['id'],'first_touch_quote':a['entry_quote'],'proposal_quote':b['entry_quote'],
                      'quote_entry_improvement':improvement,'delay_ms':b['observed_utc_ms']-a['observed_utc_ms'],
                      'first_touch_marks':a['marks'],'proposal_marks':b['marks'],'net_pnl':None})
    result={'generated_utc_ms':int(time.time()*1000),'setups':len(setups),'states':dict(states),
            'touched_setups':len(touched),'proposal_setups':len(proposed),
            'touched_without_proposal':len(touched)-len(proposed),'paired_quote_observations':pairs,
            'control_scope':'FIRST_TOUCH_QUOTE_REFERENCE_NOT_ORIGINAL_BEGONYA_ENTRY_STRATEGY',
            'slippage':None,'commission':None,'net_pnl':None,'edge_proven':False,
            'warning':'Paired proposals alone are selection-biased; include no-entry cases and unknown outcomes. No broker fills.'}
    (ROOT/'entry_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# READİNG giriş takipçisi ölçümü','',f"Kayıtlı setup: {len(setups)}",f"Kutu teması: {len(touched)}",
           f"Araştırma giriş önerisi: {len(proposed)}",f"Temas var, öneri yok: {len(touched)-len(proposed)}",'',
           'Durumlar: '+json.dumps(dict(states),ensure_ascii=False),'',
           'İlk temas fiyatı bir referanstır; orijinal BEGONYA stratejisinin gerçekleşmiş girişi değildir.',
           'Girişler ve 60/300 saniyelik fiyat değişimleri yalnızca gözlenen alış–satış kotasyonlarıdır.',
           'Spread fiyatlara dahildir. Kayma, komisyon ve gerçekleşen dolum bilinmiyor; net PnL ölçülmedi.',
           'Öneri verilmeyen setup’lar da sayılır. Henüz edge kanıtı yok.']
    (ROOT.parent/'ENTRY_RAPORU.md').write_text('\n\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':report()
