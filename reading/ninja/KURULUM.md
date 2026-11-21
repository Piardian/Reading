# NinjaTrader → READİNG bağlantısı

## Akış ve mevcut kapsam

**Makro onayı → SMC onayı/kutu → canlı spot fiyatın kutuya gelişi → READİNG bant ve fiyat tepkisi → araştırma önerisi veya iptal.**

Veri toplama bu onaylardan bağımsız, sürekli yapılır. Giriş değerlendirmesi onaylı setup için yapılır. READİNG tek BEGONYA SMC/makro aday akışını kullanır; ikinci SMC eklenmiş değildir. Orijinal BEGONYA dosyaları değiştirilmez ve yeni makro sağlayıcı/LLM çağrısı yapılmaz.

21 mevcut Forex paritesi yapılandırılmıştır. EURUSD/6E, GBPUSD/6B, AUDUSD/6A, NZDUSD/6N, USDJPY/6J, USDCAD/6C, USDCHF/6S doğrudan vadeli vekil eşleşmeleridir. Son üçünde baskı yönü çevrilir. 14 çapraz parite kutu/fiyat takibine dahildir; iki döviz bacağı doğrudan çapraz bandı sayılmaz. Bu çaprazlarda durum CROSS_LEGS_CONTEXT_ONLY kalır ve bant teyidi verilmez. Yeni pariteler forex_routes.py ve config.json üzerinden genişletilebilir.

Gold/PAXG gözlem hattı korunmuştur. Ninja köprüsü GC verisini de kaydeder; bu veriyi mevcut XAUUSD PAXG giriş motorunun yerine otomatik geçirmez.

## Şu an hazır olanlar

- ReadingMarketBridge.cs: tek grafikte çalıştırılan çoklu kontrat veri dışa aktarım göstergesi.
- Level 1 işlem/Bid/Ask olayları; hesapta derinlik varsa isteğe bağlı pozisyon bazlı Level 2 değişimleri.
- Kuyruk, tek kopya kilidi, oturum kimliği, artan sıra numarası, heartbeat ve düşen kayıt sayısı.
- Python alıcısı: yanlış kontrat, gelecekteki kayıt, sıra boşluğu, yeniden bağlantı ve kontrat değişimi kontrolleri.
- Forex kutu takipçileri: her parite ayrı kalıcı durum ve olay dosyasında; makro/SMC onayı zorunlu.

## NinjaTrader kurulunca

1. NinjaTrader Desktop'ı resmî sağlayıcıdan kur ve uygun deneme bağlantısına giriş yap. Kayıt ve deneme başlangıç koşulları sağlayıcıya bağlıdır. Şu an NinjaTrader hesabı açılmadı.
2. Control Center → New → NinjaScript Editor. Indicators üzerinde sağ tık → New Indicator. Sınıf adını ReadingMarketBridge yap. Editörde otomatik oluşturulan kaynak yerine teslim edilen ReadingMarketBridge.cs içeriğini koy ve Compile/F5 çalıştır. NinjaTrader'ın kendisinin ürettiği generated-code bölümünü elle ekleme.
3. Bağlantıyı aç ve güncel 6E kontratının gerçek zamanlı fiyat aldığını doğrula. Playback, Simulated Data Feed veya gecikmeli fiyat akışını canlı veri gibi etiketleme. Simülasyon işlem hesabı, piyasa veri akışının sentetik olmasıyla aynı şey değildir; ayrıca kontrol edilir.
4. Canlı veri alan bir grafik aç, Indicators → ReadingMarketBridge ekle. Tek grafik/tek gösterge yeterlidir; ikinci kopya aynı çıktı klasöründe engellenir. Grafik açık kalmalıdır.
5. Contracts alanına hesabında erişimi olan açık vadeleri yaz. İlk testte yalnızca 6E ile başla; sonra diğer kökleri ekle. Kodda 7 Kasım 2026 için örnek olarak Aralık 2026 adları vardır: `6E 12-26,6B 12-26,6A 12-26,6N 12-26,6J 12-26,6C 12-26,6S 12-26,GC 12-26`. Bu liste aktif kontrat doğrulaması değildir. Her kökte tek vade kullan; vadeyi değiştirince son 60 saniye yeniden oluşur. Vade geçişi otomatik değildir.
6. Output directory varsayılan olarak bu çalışma alanındaki work/ninjatrader_feed klasörüdür. Farklı klasör seçersen READİNG config.json içindeki ninjatrader_feed_directory ile aynı yap.
7. Level 1 ile ExportDepth=false bırak. Sadece hesapta Level 2 gerçekten mevcutsa true yap. Varsayılan FeedLabel=UNVERIFIED. Akışın canlı olduğu doğrulanmadan LIVE yapma. LIVE etiketi beyan niteliğindedir; tek başına abonelik/gerçek zamanlılık kanıtı değildir.
8. READİNG'i BASLAT_READING.cmd ile çalıştır. DURUM_READING.cmd temel servis durumunu; FOREX_DURUM.cmd tüm Forex kapsamını ve hangi verinin eksik olduğunu gösterir.

## Kayıtların anlamı

Ham olaylar UTC gününe göre work/ninjatrader_feed/YYYY-MM-DD.jsonl içine yazılır. received_utc_ms PC'de NinjaTrader callback'inin alınış anıdır. platform_time_raw özgün platform saatidir; UTC sayılıp zorla dönüştürülmez. Yerel dosya aktarımı ek gecikme yaratır; günlük yazıcı normal akışta yaklaşık 100–200 ms aralıklarla boşaltır. Bu, düşük gecikmeli borsa altyapısı veya garantili üst gecikme sınırı değildir.

İşlem yönü, Last işlem fiyatının sağlayıcının aynı olayda verdiği Bid/Ask ile karşılaştırılmasından **tahmin edilir**. Bu, borsanın doğrulanmış agresör bayrağı değildir. İçeride/çapraz kotasyonda kalan işlemler UNKNOWN olur. Son 60 saniyede en az 5 işlem, hacmin en az %80'inde yön sınıflandırması, taze heartbeat/işlem ve kesintisiz pencere aranır. Baskı ±0,30 eşiğiyle araştırma etiketi alır. Bunlar optimize edilmiş/kârlılığı kanıtlanmış eşikler değildir.

Derinlik olayları tekil emir kimliği içermez. MBO, spoofing veya kesin absorption tespiti iddia edilmez. İlk abonelikte verilen önbellek görüntüleri ve gerçek zamanlılık ayrıca NinjaTrader içinde test edilmelidir.

Forex spot kutu teması MT5'in örneklenmiş Bid/Ask fiyatıyla izlenir; MT5 kaydı tüm işlemlerin bandı değildir. Broker saati yerel saatle uyuşmazsa fiyat teyidi engellenir. Futures/spot baz farkı, saat uyumu, komisyon, kayma ve gerçek dolumlar doğrulanmadığı için her öneri actionable=false ve executed=false kalır. Net PnL bilinmiyor.

## Sınırlar ve doğrulama

NinjaTrader bu PC'de henüz kurulu olmadığı için gerçek NinjaScript derlemesi, hesap erişimi, denemenin Level 1/2 kapsamı ve canlı veri aktarımı doğrulanmadı. Offline C# biçim kontrolü gerçek NinjaTrader SDK derlemesi yerine geçmez. Python tarafındaki testler canlı piyasa sinyali değildir.

Gösterge günlük 512 MiB, toplam 4 GiB ham günlük veya 2 GiB altı boş disk sınırında dışa aktarımı durdurur; dosya silmez. Durdurma nedeni EXPORT_FAILED.txt içine yazılır. Önceki hata dosyası duruyor olabilir; dosya tarihiyle heartbeat birlikte kontrol edilir. Kuyruk dolarsa kayıt kaybı sıra boşluğu/dropped_total ile işaretlenir; bant teyidi engellenir.

Resmî API kaynakları:
- https://static.ninjatrader.com/support/helpGuides/nt8/marketdata.htm
- https://static.ninjatrader.com/support/helpGuides/nt8/marketdataeventargs.htm
- https://static.ninjatrader.com/support/helpGuides/nt8/marketdepth.htm
