# READİNG Forex bağlantı durumu

Akış: Makro → SMC → READİNG. Emir gönderimi kapalı.

| Parite | Bant kapsamı | Kontrat kökü | SMC | Tape | Setup |
|---|---|---|---|---|---:|
| EURUSD | DIRECT_FUTURES_PROXY | 6E | NO_SETUP | DATA_NOT_READY | 0 |
| GBPUSD | DIRECT_FUTURES_PROXY | 6B | NO_SETUP | DATA_NOT_READY | 0 |
| AUDUSD | DIRECT_FUTURES_PROXY | 6A | NO_SETUP | DATA_NOT_READY | 0 |
| NZDUSD | DIRECT_FUTURES_PROXY | 6N | NO_SETUP | DATA_NOT_READY | 0 |
| USDJPY | DIRECT_FUTURES_PROXY | 6J | NO_SETUP | DATA_NOT_READY | 0 |
| USDCAD | DIRECT_FUTURES_PROXY | 6C | NO_SETUP | DATA_NOT_READY | 0 |
| USDCHF | DIRECT_FUTURES_PROXY | 6S | NO_SETUP | DATA_NOT_READY | 0 |
| AUDCAD | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| EURGBP | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| EURJPY | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| GBPJPY | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| CADJPY | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| AUDJPY | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 1 |
| EURAUD | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| NZDCAD | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| EURCHF | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 1 |
| GBPCHF | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| AUDCHF | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| CADCHF | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| NZDCHF | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |
| CHFJPY | CROSS_LEGS_CONTEXT_ONLY | Çapraz bacaklar | NO_SETUP | CROSS_LEGS_CONTEXT_ONLY | 0 |

Seçili veri bağlantısı: quantower. Canlı bandın gerçek zamanlılığı henüz doğrulanmadı. Çapraz bacaklar, paritenin kendi bandı sayılmaz. Net PnL ölçülmedi.

Otomatik giriş araştırması: temas sonrası hız artışı + absorption adayı + fiyat ve agresif akış dönüşü. Eski kural ayrı kontrol olarak kaydedilir. L2 veya doğrulanmış defter anlamı yoksa likidite çekilmesi/spoofing şüphesi ölçülemez.
