# READİNG — BEGONYA + tape gözlem motoru

## Kripto bağlantısı

Binance spot BTCUSDT/ETHUSDT/SOLUSDT/XRPUSDT verisi bağlandı. Mumlar, gerçek işlemler, BBO ve top-20 defter aynı piyasadan alınır. Mevcut makro onayı → SMC/kutu → otomatik READING korunur. Makro veto varsa giriş üretilmez. CRYPTO_DURUM.cmd bağlantı ve veto nedenlerini gösterir; ayrıntılar reading/CRYPTO_READING.md içindedir. Emir gönderimi kapalıdır.

## READİNG gölge işlem ve Telegram

Kullanıcı tercihiyle yalnızca READİNG'in yeni otomatik giriş önerileri gölge deftere alınır ve BEGONYA'nın mevcut Telegram hedefine `READING — GÖLGE` etiketiyle açılış/sonuç mesajı gönderilir. Eski kontrol kuralı ve başka projelerin işlemleri bu toplamlara katılmaz. READİNG_GOLGE_RAPOR.cmd toplamları yeniler. Ayrıntılar reading/SHADOW_TELEGRAM.md içindedir.

## Güncel Forex bağlantısı: Quantower / AMP-CQG

Yeni otomatik araştırma kuralı temas sonrası hız artışı ve absorption adayını, ardından fiyat/agresif akış dönüşünü arar. Eski giriş kuralı ayrı kontrol olarak korunur. İnsan bant onayı gerekmez; emir açılmaz. L2 yoksa spoofing şüphesi tespiti ölçülemez. Ayrıntılar `reading/AUTOMATIC_READING.md` içindedir.

NinjaTrader yerine `reading/quantower/ReadingQuantowerBridge.dll` veri bağlantısı kullanılıyor. Yerel `autostart.json` ile etkinleştirilen arka plan hostu, Quantower açıkken AMP/CQG'ye bağlanır; hesap veya emir erişimi yoktur. Makro → SMC/kutu → READİNG sırası korunur.

`QUANTOWER_DURUM.cmd` ham köprü heartbeat/olay sayısını; `FOREX_DURUM.cmd` parite kapsamını gösterir. `BASLAT_QUANTOWER_KOPRU.cmd` ve `DURDUR_QUANTOWER_KOPRU.cmd` yalnızca veri kaydedicisini yönetir. Python alıcısı ayrı BASLAT/DURDUR_READING komutlarıyla yönetilir. FeedLabel UNVERIFIED kaldığından veri değerlendirmesi henüz giriş teyidine yükseltilmez. [Ayrıntılı bağlantı rehberi](reading/quantower/KURULUM.md).

READİNG, BEGONYA klasörünün dosya içerikleri SHA256 ile doğrulanmış bağımsız kopyası üzerine kuruldu. Başlangıçta 38.314 dosya, 971.587.807 bayt kopyalandı. Üç `node_modules` bağlantısı bağımsız dosyalara dönüştürüldü; orijinale yazan bağlantı bırakılmadı. Kopya canlı dizinden dosya dosya alındığından tek bir ana ait atomik sistem görüntüsü değildir.

İlk kopyanın özetleri üst klasördeki `READING_copy_manifest.json` dosyasındadır. Daha sonra yapılan entegrasyon değişiklikleri `reading/integration_changes.json` içinde listelenir. Değiştirilen başlangıç dosyalarının ilk halleri `reading/baseline_startup_archive` içinde `.txt` olarak saklanır. Derleme çıktıları yeni kaynaktan yeniden üretilmiştir.

## Başlatma ve durdurma

- **BASLAT_READING.cmd:** READİNG gözlem servisini ve kopyadaki SMC aday gözlemcisini açar.
- **DURUM_READING.cmd:** bağlantı, veri uygunluğu, PAXG özellikleri ve SMC durumunu gösterir.
- **DURDUR_READING.cmd:** yalnızca READİNG ve ona ait SMC alt sürecini durdurur.

Bilgisayar yeniden açıldığında otomatik başlamaz. Aynı proje ikinci kez açılırsa dosya kilidiyle engellenir. Orijinal BEGONYA/Swing-BOS süreçleri yönetilmez. Daha önce kurulan ortak MT5/PAXG veri kaydedicisi gerekirse başlatılır; READİNG durdurulunca ortak kaydedici çalışmaya devam eder.

Kopyadaki eski BEGONYA başlatıcıları READİNG başlatıcısına yönlendirildi. Eski Python orkestratörüne veya Node bildirim sunucusuna doğrudan giriş engellendi; bunlar kopyalanmış PID kilitleriyle orijinal süreçlere müdahale edebilirdi. Orijinal projelerin başlatıcıları değiştirilmedi.

## Motorun yaptığı iş

Son 60 saniyede, yerel alınış zamanı karar anından önce olan Binance PAXGUSDT kayıtlarından:

- Agresif alış/satış miktarı ve miktar dengesizliği.
- Saniye başına birleştirilmiş işlem olayı sayısı.
- İlk beş alış/satış seviyesindeki miktar dengesizliği ve en iyi alış–satış farkı.
- PAXG işlem fiyatının pencere içindeki değişimi.
- Eski veri, kesinti, tekrar, gelecekteki kayıt ve bozuk miktar kontrolleri.

Araştırma etiketi için en az 5 birleştirilmiş işlem olayı ve ±0,30 miktar dengesizliği eşiği kullanılır. Bunlar önceden belirlenmiş ilk araştırma ayarlarıdır; optimize edilmiş veya kârlılığı gösterilmiş eşikler değildir. Sıfır işlemde dengesizlik bilinmiyor (`null`) kalır.

**PAXG, XAUUSD'nin kurumsal bandı değildir.** Burada hesaplananlar yalnızca Binance PAXG verisidir. Emir sahiplerinin kurumsal olup olmadığı bilinmez. İlk beş seviye görüntüsüyle absorption veya iceberg doğrulanmaz. MT5 tikleri broker kotasyonlarıdır; küresel gerçekleşen hacim değildir. USDT/USD farkı ve broker saat uyumu doğrulanmadı.

Bu nedenle `xau_confirmation_valid=false` ve `treatmentAllowed=null` korunur. Motorun BUY/SELL etiketi emir veya teyit değildir. EURUSD gibi diğer sembollere altın vekili uygulanmaz; `UNSUPPORTED_SYMBOL` üretilir.

## BEGONYA entegrasyonu

Klondaki `smc_engine/server/pipeline.ts` içinde adaylar tamamlandığında tape değerlendirmesi eklenir. BEGONYA'nın mevcut aday kabulü, puanı, yönü, stopu veya hedefleri tape tarafından değiştirilmez. Eski mumlar güncel aday diye kullanılmaz.

9 Kasım bakımından sonra Forex ve altın mumları ayrı, salt-okunur `reading/mt5_candles.py` sürecinden alınır; eski BEGONYA mum dosyaları kullanılmaz. 21 Forex paritesi ve XAUUSD için 4H/1H/15M/1M serileri vardır. Kış dönemi saat dönüşümü ve kapsam sınırı `reading/MT5_CLOCK_POLICY.md` içinde açıklanır. Kripto mumları Binance spot kaynağından gelir. Orijinal BEGONYA makro/haber çıktıları yalnızca okunur. SMC/makro aday akışı klonun kodundan çalışır; minimum SMC notu B+ olur. Bağımsız yeni makro sağlayıcı/LLM çağrıları yapılmaz; dış kardeş projeler ikinci kez başlatılmaz.

Her yeni aday için `reading/runtime/candidate_pairs.jsonl` dosyasında ortak kimlikle:

1. Kontrol: BEGONYA'nın aday kaydı.
2. Ek gözlem: tape uyumu (`ALIGNED`, `OPPOSED`, `NEUTRAL`, `UNKNOWN`) ve veri uygunluğu.

İki kol için de `executed=false`, net PnL bilinmiyor kalır. Henüz karşılaştırmalı getiri veya broker işlem takibi yoktur. Bu aday kaydı performans kanıtı değildir.

## Çalışma dosyaları

- `reading/config.json`: kaynaklar ve araştırma ayarları.
- `reading/runtime/status.json`: READİNG servisinin güncel durumu.
- `reading/runtime/tape_snapshot.json`: son 60 saniyenin özellikleri.
- `reading/runtime/tape_features_YYYY-MM-DD.jsonl`: özellik gözlemleri.
- `reading/runtime/smc_status.json`: mum uygunluğu, aday sayısı, girdi özetleri.
- `reading/runtime/candidate_pairs.jsonl`: gerçek aday oluştuğunda kontrol/tape karşılaştırması.
- `reading/runtime/run_manifest.json`: son çalıştırmanın kaynak/config özetleri.
- `reading/runtime/smc_worker.log`: SMC alt süreç hataları.

Hafta sonu `RUNNING` ile birlikte `DATA_NOT_READY` görülmesi mümkündür: süreç çalışır, altın verisi karşılaştırmaya uygun değildir. İlk açık piyasa gününde yeni MT5 tikleri, BEGONYA mum güncelliği ve saat uyumu ayrıca doğrulanmalıdır.

Özellik günlüğü yaklaşık beş saniyede bir yazılır. READİNG delil dosyaları toplam 5 GiB'yi aşarsa veya boş disk 2 GiB altına düşerse servis durur. Kaynak veri kaydedicisinin ayrıca günlük boyut sınırı vardır. Kayıtlar otomatik silinmez.

## Durum

### NinjaTrader / Forex hazırlığı

Akış **makro → SMC → READİNG** olarak 21 mevcut Forex paritesine genişletildi. Güncel aday onayları ve broker Bid/Ask fiyatları parite başına ayrı takip edilir. READİNG'in kendi MT5 mumları eksik/eskiyse ilgili parite veri bekler; geçmiş veya mum uydurulmaz. GBPCHF gibi kaynak stratejinin engellediği pariteler otomatik serbest bırakılmaz. Yedi majörde doğrudan vadeli vekili, 14 çaprazda yalnızca bacak bağlamı vardır; çaprazlara doğrudan bant onayı verilmez.

`reading/ninja/ReadingMarketBridge.cs`, NinjaTrader Desktop içinde çalıştırılacak çoklu kontrat veri göstergesidir. PC tarafındaki alıcı hazırdır; NinjaTrader bu PC'de henüz kurulmadığı için uygulama içinde gerçek derleme/bağlantı doğrulanmadı. Durum `WAITING_NINJATRADER` kalabilir. [Kurulum](reading/ninja/KURULUM.md) dosyasına bakın. FOREX_DURUM.cmd kapsam raporunu yeniler.

Yedi ana parite uygun döviz vadeli kontratına eşlenir; ters kotasyonlu üçünde baskı yönü çevrilir. 14 çaprazda iki bacak izleme kapsamı doğrudan bant sayılmaz; teyit verilmez. Level 1 fiyat/işlem verisi ile ilerlenir. Level 2 değişimleri isteğe bağlı ham kayıttır; MBO veya spoofing tespiti iddia edilmez. Gerçekleşen işlem yönü sağlayıcının eşlik eden Bid/Ask verisinden tahmin edilir, bilinmeyenler korunur.

NinjaTrader GC kaydı XAUUSD/PAXG hattını kendiliğinden değiştirmez. Mevcut PAXG gözlemi sürer. Emir gönderimi kapalıdır. Telegram yalnızca ayrı READİNG gölge raporlayıcısında kullanıcı isteğiyle açılmıştır; eski Node bildirim sunucusu çalıştırılmaz.

### Canlı kutu takipçisi — eklenen aşama

SMC gözlemcisi her değerlendirmede güncel aday listesini `reading/runtime/entry_candidates.json` dosyasına yazar. Python takipçisi kaydedilmiş gerçek MT5 XAUUSD bid/ask tiklerini yaklaşık 250 ms aralıklarla okur. Bu, düşük gecikmeli doğrudan borsa uygulaması değildir; veri kaydedicisinin yaklaşık 500 ms sorgu döngüsü ve ağ gecikmesi de vardır. Mum kapanışı giriş fiyatı olarak kullanılmaz.

Akış: REGISTERED → APPROACHING → TOUCHED → WAITING_RESPONSE → RESEARCH_ENTRY_PROPOSAL. Ayrıca CANCELLED, INVALIDATED, EXPIRED ve SUSPENDED durumları vardır. İlk araştırma protokolü: en çok 60 dakika kutu takibi; kutu genişliği kadar yakınlıkta yaklaşma; alışta ask/satışta bid kutunun içinde olunca temas; temastan sonra en az üç kotasyon, en az kutu genişliğinin %10'u veya iki spread kadar tepki ve aynı yönde kullanılabilir PAXG baskısı. BEGONYA'nın varsa giriş aralığı korunur. Bunlar doğrulanmış edge eşikleri değildir; run_manifest içinde sürümlenir.

Makro veya SMC onayı geri çekilirse, taze aday listesinden setup kaldırılırsa, orijinal stop aşılırsa ya da takip süresi biterse ilgili neden kaydedilir. SMC bağlamı 35 saniyeden eskiyse veya kotasyonlarda beş saniyeden fazla boşluk varsa tepki takibi askıya alınır; veri geri geldiğinde yeni temas gerekir. Tepki için temas sonrası en fazla 90 saniye beklenir. Broker tik zamanı yerel saatle uyumsuzsa tik giriş değerlendirmesine alınmaz; bu zaman filtresi saat doğrulamasının tamamlandığı anlamına gelmez.

Giriş önerisinde o andaki ask/bid, orijinal stop ve hedefler, tape kesim zamanı ve engelleyici nedenler yazılır. `actionable=false` ve `executed=false` kalır. Ters PAXG akışına rağmen XAUUSD'nin az ilerlemesi yalnızca araştırma amaçlı duraklama paterni olarak etiketlenir; absorption veya spoofing tespiti iddia edilmez. Bu sürüm tek BEGONYA SMC/makro aday akışını kullanır; ikinci SMC entegrasyonu içermez.

`entry_events.jsonl` geçişleri; `entry_state.json` kalıcı durumu; `entry_status.json` durum sayılarını tutar. Tekrar başlatma aynı setup'ı yeniden açmaz. `ENTRY_RAPORU.cmd` özeti yeniler. İlk temas kotasyonu ve tepki sonrası öneri kotasyonu karşılaştırılabilir; ilk temas referansı orijinal BEGONYA giriş stratejisinin gerçekleşmiş işlemi değildir. 60 ve 300 saniyelik kotasyon değişimleri ayrıca kaydedilir; veri boşluğunda sonuç bilinmiyor bırakılır. Spread gözlenen bid/ask fiyatlarına dahildir. Kayma/komisyon ve gerçek dolumlar bilinmediğinden net PnL hesaplanmaz.

**Gölge araştırma. READİNG etiketli gölge Telegram bildirimleri açık. Emir yönlendirme kapalı. Edge kanıtlanmadı.**

Eşzamanlı açık piyasa verisi, saat doğrulaması, gerçek maliyetler ve kullanılmamış sonraki veri olmadan tape katmanının başarıyı artırdığı söylenemez.
# Güncel gölge işlem yönetimi

9 Kasım 2026'dan itibaren yeni READİNG önerileri: $100 varsayımsal ilk risk, +1R'de %50 kapanış ve kalan stop girişe; aktif likidite havuzundaki TP2 en az +2R ise kabul. Ayrıntılar `reading/TRADE_MANAGEMENT.md`. Gerçek emir/lot hesabı yoktur; eski TP1 tam kapanış modeli yeni işlemlere uygulanmaz.

