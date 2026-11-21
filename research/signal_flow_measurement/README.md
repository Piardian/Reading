# Begonya sinyal akışı ileri ölçümü

Amaç: yeni kota/kuyruk uygulamasını ve sabit stop/hedefle net 2R giriş aralığının etkisini gözlemek. Çalışma gerçek zamanlı M15 **paper** verisidir; kullanıcının gerçek M1 işlemleri değildir.

## Kayıt sözleşmesi

- Her çalışma kendi klasöründe `protocol.json`, `activation.json`, `events.jsonl`, `status.json`, `REPORT.md` ve `report.json` tutar. Protokol kaynak/derleme hash'lerini, ilgili konfigürasyonu ve inceleme koşullarını dondurur.
- Kayıt yalnızca yeni SMC süreci protokol hash'lerini doğrulayıp etkinleştirdiğinde başlar. Bir protokolü dosya düzenleyerek yeni kurallara dönüştürmeyin; yeni çalışma açın.
- Eski haftanın audit ve geometri çıktıları `baseline_*` adıyla kopyalanır. Bunlar ileri örneklem değildir. Yeni tarihsel geometri çıktısı da ayrı `historical-geometry-*` dosyasına gider; kâr/zarar üretmez.
- Gerçek gözlem anındaki kapalı M15/H1/H4 mumları sıkıştırılmış olarak, aynı anda okunan ham makro kapı sürümü hash ile arşivlenir. Bu, alttaki ekonomik verilerin yayın/vintage doğruluğunu tek başına kanıtlamaz.
- Plan aşaması, diğer önceki SMC kapılarını geçen POI'leri net R:R reddinden önce kaydeder. Aynı POI/mum tekrarı ayrı sinyal sayılmaz. İlk kabul REFERENCE veya CONDITIONAL_ENTRY olarak korunur.
- Plan uygunluğu, paper kayıt, dolum ve kapanış ayrı olaylardır. Her filtrelenmiş kutu teslim edilmiş sinyal veya kaçırılmış kazanç sayılmaz.
- Makro izinli REFERENCE ve CONDITIONAL_ENTRY paper kohortları ayrı raporlanır. Makro engelliler performans kohortlarına eklenmez; eksik, eski, girişi teyitsiz ve maliyeti tutarsız sonuçlar TP/SL kanıtına dönüşmez.
- TP oranının paydası kapanmış ve net sonucu hesaplanabilen TP+SL+BE paper dolumlarıdır. Açık/bilinmeyen dolumlar ayrıca görünür. Sıfır örnekte oran ve ortalama getiri `null` kalır.
- Sağlayıcı ağ denemeleri, ağ hataları, hiç ağ isteği yapılmadan yerel günlük kota ertelemesi, kuyruk zaman aşımı ve bekleme p95 ayrı sayılır. Daha az istek atarak hata adedinin düşmesi tek başına kapsamın iyileştiğini göstermez.
- Rapor ve heartbeat süreç çalışırken dakikada bir yenilenir. Heartbeat üç dakikadan eskiyse veri kalitesi uyarısı oluşur. Kayıt hataları raporu DEGRADED yapar.

## İnceleme

İlk inceleme kapısı: en az **28 takvim günü**, toplam **100 kapanmış paper dolumu** ve her iki kohortta **4 UTC haftası**. Bunlar istatistiksel yeterlilik veya kazanç garantisi değildir. Koşullu kohort azsa değerlendirme daha uzun sürer.

Kohortların piyasa koşulları farklıdır; aralarındaki TP/SL farkı rastgele deneyin nedensel sonucu sayılamaz. Wilson aralığı betimseldir; aynı piyasa hareketinden gelen işlemlerin bağımsızlığını garanti etmez. Canlı terfi her zaman kapalıdır. Gerçek manuel sonuç için kullanıcının zaman damgalı giriş/çıkış, maliyet ve dolum kayıtları gerekir.

## Komutlar

`smc_engine` dizininden:

```powershell
# Bir kez, derleme ve kontroller tamamlandıktan sonra:
node -r ts-node/register scripts/signalFlowMeasurement.ts --init

# Salt okunur arşiv geometri karşılaştırması:
node -r ts-node/register scripts/signalFlowMeasurement.ts --history

# Mevcut raporu yenilemek:
node -r ts-node/register scripts/signalFlowMeasurement.ts --report
```

Etkin çalışma işaretçisi `smc_engine/data/signal_flow_measurement_active.json` dosyasıdır. `--init` var olan işaretçiyi ezmez. Başlatma/raporlama tarihçesi çalışma klasöründe kalır. Bu altyapı test amacıyla Telegram mesajı veya emir göndermez.
