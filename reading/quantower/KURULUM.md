# Quantower → READİNG

Akış: Makro onayı → SMC onayı/kutu → spot fiyat kutuya gelir → READİNG bant ve fiyat tepkisini değerlendirir. Veri toplama sürekli yapılır. Emir, hesap sorgusu ve Telegram gönderimi yoktur.

## Yerleştirilen eklenti

Kaynak `ReadingQuantowerBridge.cs`, derlenmiş dosya `ReadingQuantowerBridge.dll`.
Kurulu Quantower 1.146.7'nin gerçek `TradingPlatform.BusinessLayer.dll` dosyası ve bu PC'deki .NET 10.0.14 kullanılarak derlendi. Quantower eklentiyi Custom listesinde tanıdı. Bu, canlı veri yetkisi veya gerçek zamanlılık kanıtı değildir.

Yerel eklenti klasörü: `C:\AMP Quantower\Settings\Scripts\Strategies\ReadingQuantowerBridge`.
Quantower güncellenirken sürüme özel bin klasörüne bağımlı kopya tutulmaz. Yeni API sürümünde yeniden derleme gerekebilir.

## Arka planda otomatik veri bağlantısı (etkin)

Arayüzde strateji örneği oluşturma adımı güvenilir çalışmadığından, yerel `autostart.json` ile açıkça etkinleştirilen veri kaydedici kullanılır. Quantower özel script kataloğunu yüklediğinde bu sınıfın yapıcısı bir veri hostu kaydeder. Host, AMP/CQG bağlantısı açık olduğunda en geç yaklaşık 5 saniyelik yoklama aralığında abonelik ister. Strateji tablosunda Working satırı görünmesi gerekmez; doğrulama `QUANTOWER_DURUM.cmd` ve ham dosyadaki heartbeat ile yapılır.

- `BASLAT_QUANTOWER_KOPRU.cmd`: yerel etkinlik ayarını açar, STOP işaretini kaldırır. Quantower açık kalmalıdır.
- `DURDUR_QUANTOWER_KOPRU.cmd`: etkinliği kapatır ve STOP işareti bırakır; arka plan hostu abonelikleri kapatıp kuyruğu boşaltır.
- `DURDUR_READING.cmd` Python alıcısını durdurur; Quantower kaydedicisini ayrıca yukarıdaki komutla durdur.
- `autostart.json` silinir veya enabled=false yapılırsa host veri dışa aktarımını durdurur. Hesap, emir veya ağ sunucusu açılmaz.
- Açılışta FeedLabel her zaman UNVERIFIED kalır. Piyasa açıkken zaman/baz ve abonelik kontrolleri yapılmadan LIVE'a yükseltilmez. Bu sürümde otomatik araştırma teyidinin engelli kalması bilinçli bir veri doğrulama sınırıdır.
- Elle strateji ekleyip Run yapılırsa aynı çıktı klasöründeki dosya kilidi ikinci yazıcıyı reddeder. İki örnek çalıştırmaya gerek yoktur.

## İsteğe bağlı elle çalıştırma (arka plan hostu kapalıyken)

1. AMP/CQG bağlantısı açık olmalı. Sol üst AMP logosu → TRADING → StM / Strategies Manager.
2. ＋ → Custom → ReadingQuantowerBridge → READING - DATA ONLY satırına çift tıkla.
3. Ayarlarda connection name gerçek bağlantı adıyla aynı olmalı: mevcut varsayılan `AMP/CQG`.
4. Varsayılan kontratlar: `EU6Z26,BP6Z26,DA6Z26,NE6Z26,JY6Z26,CA6Z26,SF6Z26,GCEZ26`. Bunlar Aralık 2026 açık vade örnekleridir; sağlayıcı erişimi ve likiditesi ayrıca kontrol edilir. Her kökte yalnızca bir vade kabul edilir. Otomatik rollover yoktur.
5. ExportDepth başlangıçta false; Level 2 yetkisi doğrulandıktan sonra isteğe bağlı true. FeedLabel başlangıçta UNVERIFIED; canlılık doğrulanmadan LIVE yapılmaz. LIVE yalnızca kullanıcı beyanıdır.
6. Yalnızca READING satırındaki Run düğmesiyle başlat. Hesap seçimi gerekmez; başka stratejiler çalıştırılmaz.
7. `QUANTOWER_DURUM.cmd` köprü heartbeat ve olay sayılarını, `FOREX_DURUM.cmd` makro/SMC/bant durumunu gösterir.

## Sembol eşleşmeleri

| Spot | Standart CME | CQG kökü | Yön |
|---|---|---|---|
| EURUSD | 6E | EU6 | Aynı |
| GBPUSD | 6B | BP6 | Aynı |
| AUDUSD | 6A | DA6 | Aynı |
| NZDUSD | 6N | NE6 | Aynı |
| USDJPY | 6J | JY6 | Ters |
| USDCAD | 6C | CA6 | Ters |
| USDCHF | 6S | SF6 | Ters |
| XAUUSD | GC | GCE | Aynı; mevcut altın PAXG hattını otomatik değiştirmez |

EEU, E-mini Euro FX'tir; EU6 yerine kabul edilmez. Mikro/Mini işlem hacimleri standart kontrat hacmiyle karıştırılmaz. Mevcut 14 çapraz parite için doğrudan bant teyidi verilmez; CROSS_LEGS_CONTEXT_ONLY kalır.

## Kayıt ve sınırlar

Ham olaylar `work/quantower_feed/YYYY-MM-DD.jsonl` içine yazılır. READİNG config.json içindeki futures_feed=quantower bu kaynağı seçer; NinjaTrader verisiyle karıştırılmaz.

- Last: işlem fiyatı, Size, Quantower sağlayıcı agresör bayrağı. Bayrağın borsa kaynaklı olduğu doğrulanmadı; bilinmeyen yön korunur. Callback anındaki Bid/Ask ile eksik yön doldurulmaz.
- Quote: Bid/Ask ve büyüklükleri. Bunlar işlem değildir.
- İsteğe bağlı Level 2: sağlayıcının değişim olayı ve en çok 100 kademe/yan anlık görüntüsü. Tam defter veya MBO iddiası yoktur. Kesin absorption/spoofing üretilmez.
- UTC kayıt zamanı yerel seri hale getirme anıdır; ham sağlayıcı saati Kind ile saklanır. Saat/baz farkı doğrulanana kadar yürütme izni daima false.
- Heartbeat 2 saniyede bir; bağlantı durumu, sağlayıcının bildirdiği gecikme ve sayaçlar. Sıfır gecikme bildirimi tek başına canlılık kanıtı değildir.
- Kuyruk 50.000; kayıplar dropped_total ve sıra boşluğuyla görünür. Günlük 512 MiB, toplam 4 GiB, boş disk en az 2 GiB. Sınırda yazım durur, veri silinmez. Hata EXPORT_FAILED.txt içine tarihli yazılır.
- Tek yazıcı dosya kilidi; yeniden başlatma ve bağlantı değişiminde en az 60 saniye pencere yeniden oluşur. Akış yoksa bant teyidi verilmez.
- 60 saniyede en az 5 işlem, en az %80 yönü bilinen hacim, taze heartbeat/işlem, sıfır bildirilen gecikme ve LIVE beyanı araştırma özellikleri için gerekir. Bunlar kârlılığı kanıtlanmış eşikler değildir.

Kurulum sonrası gerçek akış, lisans kapsamı, hız, baz/saat uyumu ve ileri dönem sonuçları ölçülmeden edge iddia edilmez. Cumartesi boş bant normaldir; geçmiş grafik veya açık bağlantı canlı işlem bandını kanıtlamaz.

## Resmî kaynaklar

- https://help.quantower.com/quantower/quantower-algo/strategies-manager
- https://github.com/Quantower/Examples/blob/master/Common/SubscribeMarketDataExamples.cs
- https://api.quantower.com/docs/TradingPlatform.BusinessLayer.Last.html
- https://faq.ampfutures.com/hc/en-us/articles/360002351413-CQG-Exchange-Symbols-List
- https://faq.ampfutures.com/hc/en-us/articles/360002351353-CQG-List-of-available-contracts-via-Demo-Connection
