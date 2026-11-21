# Kripto → Makro → SMC → READING

Kapsam: **Binance spot BTCUSDT, ETHUSDT, SOLUSDT ve XRPUSDT**. Mevcut BEGONYA motorunda strateji isimleri BTCUSD / ETHUSD / SOLUSD / XRPUSD olduğu için yalnızca motor içi alias kullanılır. Mumlar, işlem bandı ve Bid/Ask aynı Binance USDT piyasasından gelir. USD broker kotasyonu veya dolumu olduğu iddia edilmez.

## Otomatik akış

1. API anahtarı kullanmadan kamuya açık gerçek işlem, en iyi Bid/Ask ve 100 ms top-20 fiyat seviyesi anlık görüntüsü alınır. Bu, yalnızca Binance spot piyasasıdır; tüm kripto borsalarının ortak bandı değildir.
2. 1m, 15m, 1h ve 4h için en çok 500 kapanmış mum tutulur. Açık mum kullanılmaz; eksik aralık doldurulmaz. Kaynak meta verisi ve SHA256 kaydedilir. 15 saniyelik döngü yalnızca yeni kapanmış bar gerektiğinde ilgili REST serisini yeniler.
3. Mevcut makro motorun iki yön için izni kontrol edilir. İki yön de veto ise SMC taraması bu turda çalıştırılmaz; status=MACRO_BLOCKED olur. Makro onaylanırsa mevcut SMC pipeline'ı çalışır; adayın kendi teknik skoru ve makro değerlendirmesi tekrar zorunludur. Rotasyon/hafta sonu filtresi veya başka veto kaldırılmaz.
4. SMC kutusu oluşursa gerçek Binance Bid/Ask kutuya temas ettiğinde READING otomatik hız artışı + absorption adayı + fiyat/agresif akış dönüşünü arar. İnsan bant onayı gerekmez.
5. Doğrulanmış top-20 seviyelerde hızlı likidite çekilmesi şüphesi varsa geçici bekleme uygulanır. Bunun spoofing niyetinin kanıtı olduğu söylenmez. Tekil emir kimliği/MBO yoktur; görüntü sınırından kaybolan seviyeler iptal sayılmaz.
6. Şartlar tamamsa yalnızca araştırma önerisi kaydedilir. Emir, hesap sorgusu, broker bağlantısı, API anahtarı veya Telegram gönderimi yoktur.

## Saat, süreklilik ve miktar

Gerçek işlem yönü Binance buyer-is-maker alanından türetilir. Trade stream kullanılır; birleşik işlemler tekil işlem gibi sayılmaz. İşlem kimliği boşluğu veya yeniden bağlantı sonrası 60 saniye yeniden ısınma gerekir. BBO ve top-20 payload'larında borsa saati bulunmadığından yerel alınış saati açıkça etiketlenir; sahte broker time_msc üretilmez. Sunucu-yerel saat farkı ve HTTP RTT ölçülür. Fiyat/işlem/bağlantı eskirse teyit engellenir.

Derinlik miktarı kontrat değil baz varlık miktarıdır. Kripto çekilme hipotezinde minimum duvar 0,01 BTC / 0,1 ETH / 1 SOL / 100 XRP ve en az 3x tipik büyüklüktür. Farklı akışlardan gecikmiş işlemleri yanlışlıkla iptal saymamak için 500 ms yerleşme süresi kullanılır. Özellikler aynı anda veya daha önce oluşturulmuş en çok 500 ms yaşındaki önbellekten alınabilir; ilerideki özellik geçmiş bir kotasyona uygulanmaz. Eski veya geç işlenmiş kotasyonlar giriş için reddedilir. Bunlar optimize edilmemiş araştırma ayarlarıdır; edge kanıtı değildir.

Ham kamu verisi runtime/crypto_raw altında günlük gzip JSONL; toplam 5 GiB, günlük 1 GiB, en az 2 GiB boş disk sınırı vardır. Sınırda kripto kaydedici durur, veri silinmez. 20.000 olay kuyruğunun taşması hata sayılır. Yeniden bağlanma sessizce tam veri sayılmaz. Orijinal BEGONYA dizinine yazılmaz.

## İzleme

- CRYPTO_DURUM.cmd: bağlantıyı, son 60 saniye işlem sayısını, makro/SMC durumunu ve veto nedenlerini yeniler.
- runtime/crypto_status.json: canlı veri ve otomatik giriş araştırması.
- runtime/crypto_smc_status.json: makro ön kontrolü, SMC ve kaynak hataları.
- runtime/crypto_patterns/<alias>: yeni giriş kuralı ve olay kayıtları.
- runtime/crypto_control/<alias>: eski fiyat tepkisi + baskı kuralı.
- runtime/crypto_inputs: kapanmış mumlar ve kaynak meta verisi.

Mevcut makro politikasının DEFENSIVE_HOLD veya hafta sonu/rotasyon vetosu vermesi bağlantı arızası değildir. Tarama aktif kalır; veto varken giriş üretilmez. Net PnL ve gerçek dolumlar ölçülmedi.

Resmî veri tanımları:
- https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
# 9 Kasım 2026 açılış bakım notu

Ham trade/BBO/top-20 derinlik olayları kaydedilmeye devam eder. Giriş motoru, her servis turunda her sembolün son kotasyonunu değerlendirir; tur içindeki ara fiyat temasları giriş için kaçabilir. Açık gölge kayıtların çıkışları alınan bütün kotasyonlarla izlenir. Eski her-kotasyon hesaplaması artık karşılaştırma için aynı protokol sayılmaz. Şartlar ve kârlılık doğrulanmış değildir.

MT5 geçmiş indirmesi ayrı veri sürecinde çalışır. Kripto ham gzip kaydında sıkıştırma düzeyi 1 kullanılır, disk bütçesi iki saniyede bir kontrol edilir. Gecikmiş trade, kopuş ve saat kontrolleri gevşetilmez.

