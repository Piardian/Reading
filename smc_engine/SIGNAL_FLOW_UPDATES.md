# Sinyal akışı ve hibrit giriş aralığı — 23 Ekim 2026

Bu güncelleme `research/signal_frequency_audit/REPORT.md` bulgularının uygulamasıdır. Geçmiş araştırma JSON'ları yeniden üretilmedi. TP/SL oranı veya pozitif net edge artışı kanıtlanmış değildir.

## Kota ve kuyruk

- Günlük kota hatası dakikalık hatadan ayrılır. İlgili anahtar UTC gün resetine kadar kullanılmaz; varsa daha sonra gelen `Retry-After` korunur. Son başarısız denemede de cooldown uygulanır.
- Bütün anahtarlar günlük kotaya takıldıysa mevcut iş ertesi güne kadar kuyruğu tutmaz; açık `ProviderRateLimitError` ile başarısız olur. Sonraki taramalar reset sonrasında yeniden veri ister. Başarısız tarama, cache ile başarılıymış gibi gösterilmez.
- Aynı endpoint/sembol/timeframe/outputsize/kuyruk-süresi/mum dilimindeki bekleyen talepler tek ağ isteğini paylaşır. Yeni mum dilimi eski taleple birleştirilmez.
- Kuyruk son kullanma süreleri M1 için 50 saniye, M15 için 14 dakika, H1 için 55 dakika, H4 için 230 dakikadır. Süresi geçen iş `ProviderRequestExpiredError` üretir; eski sinyal değerlendirmesi çalıştırılmaz. Bunlar fırsat sayacı değildir.
- Bekleyen H1/H4 işleri zamanla öncelik kazanır. Aynı öncelikte FIFO uygulanır; sabit sembol sırası kaldırıldı.
- Yanıtın dakika kullanım başlıkları yerel sayacı günceller. Tekrarlanan aynı API anahtarları ayıklanır. Anahtarların ayrı hesaplara/bağımsız günlük kotalara ait olduğu varsayılmaz; her biri sağlayıcının gerçek yanıtıyla durdurulur.
- Kuyruk metriklerine birleştirilen istek, zaman aşımı, günlük bloke anahtar ve yeniden deneme zamanı eklendi. FAILED kayıtları hata türünü ve DAY/MINUTE ayrımını taşır. Ağ denenmeden yerel olarak ertelenen iş, provider ağ hata sayısına eklenmez.

Günlük reset kaynağı: [Twelve Data Credits](https://support.twelvedata.com/en/articles/5615854-credits). Günlük engel bellektedir; servis yeniden başlarsa anahtarın limiti sonraki gerçek yanıttan tekrar öğrenilir. Bu koruma sağlayıcının günlük kapasitesini artırmaz ve başka uygulamaların aynı anahtarla tüketimini önceden bilemez.

## Tarama ve cache

- Sonraki M15 slotu `floor((now-offset)/interval)+1` ile seçilir. Örneğin 00:14:50, 35 saniye offset ile 00:15:35'e gider.
- Sonraki slot mevcut callback başında kurulur. On-demand döngüsü ana tarama saatini bekletmez; aynı sembolde veya on-demand döngüsünde üst üste işler biriktirilmez.
- Saatlik slot kaçırıldıysa eski H4/H1 verisi M15 değerlendirmesinden önce yenilenir. HTF güncellemesi başarısızsa o sembolün bu değerlendirmesi yapılmaz.
- Cache tazeliği dosya değişiklik zamanına ek olarak son mum zamanını da kontrol eder. Açılışta eski HTF cache'i sırf 50 satır içerdiği için taze kabul edilmez.
- Kesinti sonrasında istenen mum sayısı zaman açığına göre 10–500 arasında büyür; her zaman yalnızca son 10 mumu istemez. 500 mumun ötesindeki geçmişin tamlığı garanti edilmez.
- On-demand altcoinler Binance kullanır. Bunların kapsamı varsayılan olarak daraltılmadı. İstenirse `ON_DEMAND_MAX_SYMBOLS_PER_CYCLE` pozitif değeri döngüsel bütçe uygular; varsayılan 0 bütün listeyi korur.

Yeni opsiyonlar `.env.example` içindedir. Gerçek `.env`, anahtarlar ve sembol evreni değiştirilmedi.

## Plan v1.2: net 2R sağlayan giriş aralığı

1. Orijinal M15 referansı, yapısal stop ve en yakın kullanılabilir likidite/karşı engel belirlenir. Bölge içinde daha iyi bir girişin önüne çıkabilecek yakın havuzlar da dikkate alınır.
2. Stop ve ana hedef fiyatı sabitlenir. Başka giriş seçildiğinde uzak havuz aranmaz, hedef 2.5R'ye yeniden taşınmaz.
3. Nominal spread + kayma + komisyon tutarı kutudaki üst fiyatı da kapsayan tahminle sabitlenir. Böylece fiyatla büyüyen kripto maliyeti ucuz giriş uğruna küçültülmez. R birimine dönüşüm yuvarlanmadan yapılır.
4. `m` minimum net oran, `S` stop, `T` hedef, `C` nominal maliyet olmak üzere:
   - Long: `giriş <= (T + m*S)/(m+1) - C`.
   - Short: `giriş >= (T + m*S)/(m+1) + C`.
5. Sonuç orijinal kutuyla kesiştirilir ve gösterim hassasiyetinde içe yuvarlanır. Referansın elendiği kutu ancak fiziksel likidite/engel hedefiyle geçerli aralık varsa `CONDITIONAL_ENTRY` olur. Sentetik hedef tek başına reddedilmiş kutuyu kurtarmaz.

`referenceEntryPrice`, `referenceNetRiskRewardRatio`, `admissionBasis` ve `entryRange` kaydedilir. Koşullu planda görünen giriş referansı aralığın en temkinli sınırıdır; gerçekleşmiş dolum değildir. Aralıktaki farklı gerçek girişlerde R ve TP1 mesafesi değişir; gösterilen mesafeler referans içindir.

Makro yeniden değerlendirildiğinde yalnızca risk bütçesi güncellenir. Stop/hedef/aralık eksik mum girdileriyle sessizce yeniden hesaplanmaz. Makro veto ve diğer SMC kapıları geçerlidir. Minimum net oran 2 olarak kaldı; mesafe ve TTL eşikleri gevşetilmedi. Yanlış `ttl_48h` telemetri etiketi `ttl_72h` olarak düzeltildi; eski kayıtların isimleri değiştirilmedi.

## Bildirim ve ölçüm

- Bildirim uygun giriş aralığını, maliyetin tahmin olduğunu ve gerçek girişte yeniden kontrol gerektiğini gösterir. Aralık dışında execution kartı READY göstermez. Blokaj varsa aksiyon alanı da işlem yapılmamasını söyler.
- M1 kararı kullanıcıdadır. Yeni dakika teyidi veya otomatik emir eklenmedi. Orijinal kutunun tamamlanmış M15 kapanışıyla invalidasyonu korunur.
- Yeni paper kayıtları v1.2 stop, hedef ve aralığını saklar. Aralığa ve seçilen simüle giriş fiyatına ulaşılmadan giriş yazılmaz; güncel model maliyeti daha yüksekse net oran tekrar kontrol edilir.
- Yeni paper politikası yalnızca tamamlanmış M15 mumlarını kullanır ve giriş öncesi orijinal kutuyu bozan kapanışı CANCELLED sayar. Eski kayıtlar ve politikaları dönüştürülmez. Politika kimliğinde `plan-v1.2:fixed-entry-band:closed-m15` bulunur.
- Paper dolumları kullanıcının gerçek M1 işlemleri değildir. Sinyal adedi, aralığa ulaşılma oranı, dolum oranı ve maliyet sonrası sonuçlar ayrı değerlendirilmelidir.

## Uygulama durumu

İlk uygulama turunda TypeScript tip kontrolü ve derleme yapıldı; test veya servis yeniden başlatması yapılmadı.

Sonraki ölçüm turunda 114 benzersiz test geçti ve son derleme tamamlandı. Yalnızca Begonya SMC süreci yenilendi; ileri paper ölçümü **23 Ekim 2026 14:49:19 UTC / 17:49:19 Türkiye** saatinde etkinleşti. Servis readiness durumu doğrulandı. Çalışma: `research/signal_flow_measurement/signal-flow-2026-10-23T14-48-17-622Z`. Rapor süreç çalışırken dakikada bir yenilenir. Bu başlangıçta kapanmış ileri işlem yoktur; TP/SL etkisi henüz ölçülmemiştir. Test amacıyla Telegram mesajı veya emir gönderilmedi.

İlk ileri gözlemde takip edilecekler: gerçek sağlayıcı kota hataları, yerel kota ertelemeleri, kuyruk p95/süresi geçen işler, HTF veri tazeliği, REFERENCE ve CONDITIONAL_ENTRY aday sayıları, aralıkta dolum ve net sonuç. Frekans artışı tek başına kalite veya başarı sayılmaz.
