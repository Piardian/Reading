# READİNG gölge işlem karnesi

Kayıt: 84 kol-kurulum; farklı piyasa kurulumu: 24.
A ana kontrol hesabıdır. B/C/D bağımsız deneylerdir; sonuçları ana hesabın kazancına eklenmez.
Gerçek emir/dolum yoktur. Komisyon ve kayma ölçülmediği için net PnL ölçülmedi.
İşleme dönüşmeyen, reddedilen veya süresi dolan kutular kâr ya da korunmuş zarar sayılmaz.

| Kol | Kural | Kurulum | Temas | İşlem | Açık | Kapalı | TP2 | SL | Kalan BE | Belirsiz | Kapalı brüt R | Brüt PF |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | Kontrol: makro + 90 sn | 24 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | +0.000 | hesaplanamaz |
| B | Makro + 300 sn | 20 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | +0.000 | hesaplanamaz |
| C | Araştırma: makro kapalı + 90 sn | 20 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | +0.000 | hesaplanamaz |
| D | Araştırma: makro kapalı + 300 sn | 20 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | +0.000 | hesaplanamaz |

Ana hesap gerçekleşmiş model brüt: +0.000R / $+0.00.
Açık/belirsiz kayıtlardaki gerçekleşmiş kısmi brüt: +0.000R.
PF yalnızca tamamlanmış ve sonucu ölçülmüş gölge işlemlerden hesaplanır; zarar toplamı yoksa tanımsızdır.
Net R / net USD / komisyon / kayma: ölçülmedi. 1R = varsayımsal $100; broker kazancı değildir.

## Kurulumların son engelleri (kollar aynı kurulumu tekrar içerebilir)

- CANCELLED_BY_SETUP_WITHDRAWN_BY_FRESH_SMC: 44
- NEVER_TOUCHED_WITHIN_TTL: 14
- REJECTED_BY_MACRO_NOT_APPROVED: 13
- TOUCHED_BUT_BLOCKED_BY_PATTERN_SOURCE_NOT_VALIDATED: 11
- TOUCHED_BUT_BLOCKED_BY_WAITING_POST_TOUCH_SPEED_AND_ABSORPTION_CANDIDATE: 2
