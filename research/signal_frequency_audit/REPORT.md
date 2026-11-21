# Begonya sinyal sıklığı ve filtre araştırması

Tarih: 23 Ekim 2026. Sabit araştırma kesiti: **2026-10-16T14:16:24.212202+00:00 – 2026-10-23T14:16:24.212202+00:00**.

Bu çalışma canlı filtre, M1 giriş kararı, M15 invalidasyon kuralı veya çalışan servisi değiştirmedi. Kaynakları okuyup yalnızca bu araştırma klasörüne çıktı yazdı. Sonuçlar bir kârlılık veya kaçırılmış kazanç raporu değildir.

## 1. Araştırmanın kararı

**İlk öncelik filtre gevşetmek değil, veri kuyruğu ve kota yönetimidir.** Bunlarda gözlenen operasyonel sorun var. Filtre tarafında ise en somut tasarım riski, manuel hibrit giriş beklenen bir kutuyu tek bir M15 referans fiyatındaki net R:R ile tamamen elemek.

| Başlık | Bulgu | Karar |
|---|---|---|
| Veri/kota | 6011 istek denemesinin 1932'si başarısız; 1597 günlük, 327 dakikalık kota hatası | Operasyonel sorun doğrulandı. Kaç benzersiz sinyal kaybettirdiği bilinmiyor. |
| Bekleme | Kuyruk p95 21.6 dakika; en uzun 4.03 saat; 261 iş 15 dakikadan fazla bekledi | Önce güncellik ve kota kaybı azaltılmalı. |
| Net R:R | Kayıtlı ATR olan 25 referansın 16'sı net 2R'yi geçiyor; 8'inde referans elenirken kutu kenarındaki varsayımsal giriş geçebiliyor | Hibrit girişle uyumsuz sert ön eleme riski var. Bunlar kazanılmış veya gerçekleşmiş işlem değildir. |
| Bölge yaşı | Etiket 48 saat, mevcut kod sınırı 72 piyasa saati | Körlemesine genişletme önerilmiyor. Telemetri etiketi yanıltıcı. |
| Uzaklık | Elde kalan yaşam döngüsü örneğinde 108 ayrı POI'da uzaklık reddi; 52'sinde ayrıca invalidasyon bilgisi var | Kaliteli fırsat kaybı için kanıt yetersiz. |
| Diğer sert kurallar | M15 kapanış invalidasyonu ve açık veri geçersizliği | Bu araştırma bunları gevşetmek için gerekçe üretmedi. |

## 2. Bildirim sayısı ve kayıt uyuşmazlığı

- Kalıcı kuyruk kesitinde son hafta **4 zaman damgalı metin sinyali** var: 19 Ekim GBPUSD ve SOLUSD, 20 Ekim IOUSD, 22 Ekim GBPUSD.
- Olay logunda **3 SENT** ve IOUSD için **1 SCREENSHOT_FAILED** var. Kalıcı kuyruk IOUSD'yi SENT gösteriyor. Bu iki kayıt aynı sonucu söylemiyor; grafik teslimini dört sinyalin hepsinde kesin başarılı saymıyoruz.
- IOUSD'deki grafik sorunu, metin sinyalinin hiç gönderilmediği anlamına gelmiyor. Metin başarı kaydı mevcut.
- Kalıcı kuyrukta zaman damgasız iki eski SCREENSHOT_FAILED kaydı var; bunlar dönem hesabına katılmadı.
- Önceki aylık sayılar kalıcı kuyrukta Eylül 59, 1–23 Ekim 23'tür. Bu adetler strateji sürümleri ve veri kapsamı değiştiği için sabit gelecek frekansı değildir.

## 3. Operasyonel darboğazın kanıtı

Kota başarısızlıkları bütün pipeline taramalarının değil **sağlayıcı istek denemelerinin** sayısıdır. Denemeler tekrar içerebilir. Günlük kota hatası başarısız denemelerin yaklaşık %82.7'ini oluşturuyor. Yalnızca dakikalık pacing düzeltmesi günlük tavan sorununu çözmez.

- Kuyrukta gözlenen en yüksek iş sayısı: 74.
- Kuyruk bekleme örnek sayısı: 4673; medyan 5.22 saniye, p95 1294.40 saniye.
- Aktif iş süresi p95: 119.62 saniye. Kuyruk beklemesi ile ağ yanıt süresi aynı şey değildir.
- Sonuçlanmış M15 poll süresinin maksimumu 64.4 dakikadır; bu da tek başına kaçırılmış işlem sayısı değildir.
- Öncelik sırası M15 > H1 > H4. Sürekli M15 talebi, HTF verisinin yenilenmesini geciktirebilir; en çok başarısız eşleşmeler JSON çıktısında verilmiştir.
- Sürekli evrende 27 sembol vardır. Her sembole 96 M15 isteği teorik olarak 2.592 istek/gün eder; H1/H4, aktif watchlist ve görsellerin talepleri buna eklenir. Bu teorik brüt yük, cache ve piyasa kapalı saatlerini düşmez; gerçek faturalanan çağrı sayısı değildir. Loglarda görülen hesap/anahtar başına günlük sınır hatalarıyla birlikte kapasite planlanmalı; anahtar sayısını doğrudan bağımsız kota sayısı saymak doğru değildir.

**Koşullu zamanlama sorunu:** `index.ts` içindeki `ceil((now + offset)/15m)*15m + offset` formülü, örneğin saat 00:14:50 ve offset 35 saniyede bir sonraki uygun 00:15:35 yerine 00:30:35'i seçer. Bu matematiksel olarak yeniden üretildi. Tutulan loglardan bunun kaç gerçek döngüyü etkilediği belirlenemiyor.

Önerilen çalışma sırası: günlük kota için reset bilgisini dikkate alan bekleme; HTF/cache yeniden kullanımının ölçülmesi; eski kuyruk işlerinin tekrar tekrar taşınmasının önlenmesi; watchlist talep bütçesi; ardından hizalı zamanlama düzeltmesi. Hiçbiri bu araştırmada canlıya uygulanmadı.

## 4. Filtre sayılarının doğru yorumu

Pipeline filtreleri ilk başarısız aşamada `continue` ediyor. Örneğin uzaklıkta elenen bir POI'nin grade, makro ve R:R aşamalarını geçeceği kaydedilmiş değil. `whyNotCandidateYet` içinde tek neden bulunması, “yalnızca bu filtre engelledi” demek değildir.

Elde kalan yaşam döngüsü dosyası **yalnızca 23 Ekim sabahından itibaren** veri içeriyor; haftanın tamamını kapsamıyor. Bu kısmi kesitte:

- TTL ile karşılaşan benzersiz POI: 656; bunların 364'ünde ayrıca invalidasyon gözlenmiş.
- Uzaklık reddi görülen benzersiz POI: 108; bunların 52'sinde ayrıca invalidasyon gözlenmiş.
- Tekrarlanan tarama sayaçları, bu benzersiz bölge sayılarına eşit değildir. Yüz binlerce ret olayı yüz binlerce kaçırılan işlem değildir.
- Grade aşamasındaki tek-kural sayacında HTF P/D için 13 olay var; bunlar benzersiz, makrodan geçmiş, kullanıcı tarafından doldurulmuş 13 işlem değildir.

TTL zaten 72 piyasa saatidir; kriptoda takvim saati, diğer varlıklarda hafta sonu kapanışı düşülmüş yaştır. Gerçek sınırı doğrulamadan “48'i 72'ye çıkaralım” deneyi anlamsız olur.

## 5. Net R:R duyarlılık deneyi

Bu deney bütün geçmişi yeniden taramadı. Daha önce bildirilmiş, zaman damgalı **174 adayın saklanmış kutu, ATR, likidite ve engel alanları** yeni plan fonksiyonuyla yeniden değerlendirildi. Tarihsel makro, tüm karşı bölgeler ve kullanıcının gerçek M1 dolumu yeniden oluşturulmadı.

| Örnek | N | Net 1.50 eşiğini geçen | Net 1.75 eşiğini geçen | Net 2.00 eşiğini geçen |
|---|---:|---:|---:|---:|
| Bütün saklanmış adaylar | 174 | 145 | 102 | 65 |
| Kayıtlı ATR bulunanlar | 25 | 20 | 20 | 16 |
| Önceden planı da saklanmış olanlar | 12 | 9 | 9 | 7 |

**Önemli sınır:** 149 adayda kayıtlı ATR olmadığı için varsayımsal volatilite kullanıldı. Ayrıca 119 hedef sentetik varsayıma dayandı. Toplu tablodan “filtreyi 1.75 yaparsak kaliteli sinyal şu kadar artar” sonucu çıkmaz.

Sabit 2.5R hedef için `(2.5 - maliyetR)/(1 + maliyetR) >= 2` ancak maliyetR <= 1/6 olduğunda sağlanır. Bu, giriş fiyatı ve stop paydası değiştiğinde kararın neden hassas olduğunu açıklar; bir optimum eşik kanıtı değildir.

Hedef, stop ve nominal maliyet aynı bırakılarak yalnızca kutu içindeki giriş referansı değiştirildiğinde:

- Bütün arşivde 22 aday referansta elenirken kutu kenarında 2R'ye geometrik olarak uygun hale gelebiliyor.
- Kayıtlı ATR grubunda bu sayı 8; önceden planı da kayıtlı 12 adayda 5.
- Kutu kenarına gerçek dolum, M1 teyidi, TP veya kazanç varsayılmadı. Bu nedenle bunlara “kaçırılan kazanan işlem” denmiyor.

**Hibrit sisteme uygun geliştirme adayı:** Kutu taramasında tek referans fiyatla sert ret yerine, aynı geçerli kutuda net R:R'yi sağlayan bir giriş fiyatı aralığı olup olmadığını göstermek. Gerçek giriş kararı kullanıcıda, M15 kapanış invalidasyonu aynı kalır. Bu tasarım, eşiği keyfi olarak düşürmekten farklı bir deneydir; bu araştırmada henüz uygulanmadı.

## 6. Kanıtı sınırlayan noktalar

- Canlı cache seçilen altı sembolde yalnızca 500 M15 mum saklıyor ve 18 Ekim'den başlıyor. 16–23 Ekim haftasının tamamı bu cache'ten yeniden oynatılamıyor.
- Provider ve pipeline-filter logları haftayı kapsarken polling ve POI yaşam döngüsü logları daha kısa kesitler içeriyor. Kaynak başına aralık ve hash `audit_results.json` içindedir.
- Gölge simülatörü midpoint limit girişi, 1.5 pip tampon ve sabit 2R kullanıyor. M15 barlarından “1M confirmation” türetiyor; gerçek dakika girişini gözlemlemiyor. Bu rapordaki devasa savedLosses/missedWins değerleri bu hibrit sistemin kalite kanıtı olarak kullanılmadı.
- Yeni v1.1 kapısı geçmiş hafta düşüşünün nedeni olarak gösterilemez. Arşivde yeni politika ile alınmış bir bağımsız örneklem yok.
- Bu araştırma hiçbir filtreye kanıtlanmış pozitif net edge atfetmiyor. Mesafe ve TTL için kalite etkisi **kanıt yetersiz**, net R:R için **tasarım kaynaklı gereksiz ön eleme riski**, veri akışı için **gözlenen operasyonel sorun** sonucu veriyor.

## 7. Yeniden üretme

Repo kökünden:

```powershell
python research/signal_frequency_audit/audit.py --as-of "2026-10-23T14:16:24.212202+00:00"
python -m unittest research.signal_frequency_audit.test_audit -v
```

`smc_engine` dizininden, araştırma dosyasının mutlak yolu ile:

```powershell
node -r ts-node/register/transpile-only C:/Users/piard/.gemini/antigravity/scratch/Begonya/research/signal_frequency_audit/geometry_audit.cjs
```

Canlı loglar döndürüldüğü veya yeni satır eklendiği için gelecekte aynı cutoff ile bile kaynak hash'leri değişebilir. JSON dosyaları bu araştırmanın dondurulmuş sayısal çıktılarıdır; hash'ler bütün ham geçmişin arşivlendiği anlamına gelmez.
