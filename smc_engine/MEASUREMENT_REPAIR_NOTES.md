# Ölçüm düzeltmeleri — 23 Ekim 2026

Bu çalışma ölçüm ve paper sonuç modelini düzeltir. TP oranının yükseldiği veya ekonomik makro motorunun pozitif edge ürettiği iddia edilmez.

| Açık | Uygulanan düzeltme |
|---|---|
| Eski kaydın PAPER sayılması | Kaynak yoksa UNVERIFIED; varsayılan analitikten çıkarılır. |
| Karşılaştırmada farklı çıkışlar | Shadow işareti kısmi kârı açmaz. Politika ve konfigürasyon kayıt anında dondurulur. Makro onaylı/engelli adaylar downstream risk ve bildirim seçiminden önce ortak paper defterine alınır. |
| Stop/R mesafesi | R paydası giriş ile gerçek yapısal stop arasındaki mesafedir. |
| Belirsiz işlemin sıfır getirisi | Dolum, çözülmüş işlem, net ölçülebilen işlem ve belirsiz dolum ayrı sayılır. EXPIRED/UNKNOWN getiri ve kazanma oranı paydasına girmez. Belirsiz çıkış fiyatı null kalır. |
| Fazla güçlü yürütme etiketi | Tracker yalnızca PAPER/TEST üretir. Model CONSERVATIVE_SL_FIRST, maliyet ESTIMATED olarak işaretlenir. Giriş mumunda olumlu uç hareket TP sayılmaz; TP/SL ve TP/BE çakışmalarında aktif stop önceliklidir. |
| Geçmişin okuma sırasında yeniden fiyatlanması | Kayıtlı maliyet ve net R korunur. Net eksikse yalnızca kayıtlı toplam maliyetten türetilir. Tutarsız brüt/net/maliyet net analitiğinden çıkarılır. |
| Makro zaman bilgisi | Payload hash'i, kaynak kullanılabilirlik/vintaj bilgileri ve eksiklik nedenleri saklanır. Generated timestamp tek başına PIT doğrulaması değildir. Sinyal oluşturma, mum kapanışı, kayıt zamanı ayrılır; bilinmeyen gecikme null olur. |
| İstatistik ve ufuk | Sabit tohumlu UTC hafta kümesi bootstrap kullanılır; aynı haftadaki semboller birlikte örneklenir. Yetersiz haftada anlamlılık üretilmez. Segmentler Holm düzeltmesi alır ve keşifsel kalır. Tahmin ufku önceden dondurulan maksimum tutma planından gelir; eski sonuç sonrası ufuklar UNKNOWN olur. |
| Kanıt ve promosyon | Rapor güncel defterden hazır oluş sayacı üretir. PROMOTION_STATUS yenileme komutu eklendi. 4H fiyat trendi araştırması ekonomik makro holdout kanıtı sayılmaz. |

## Kapsam ve veri gereksinimleri

- M15 OHLC yürütmesi hâlâ yaklaşık ve muhafazakâr bir simülasyondur. Gerçek broker dolumu, bid/ask veya gerçekleşmiş slippage ölçümü değildir. Sonraki mumda doğrulanan bir olaydan önceki mum içi fiyat yolu bilinmez.
- Eski kanıt satırları yeniden yazılmadı. Eski politikayla üretilen sonuçlar betimsel raporda kalır; v3 makro gölge karşılaştırmasına girmez. Kısmi kâr ve stop aralıklarının geçmişteki hatalarını sonuç satırlarından güvenilir şekilde geri hesaplamak mümkün değildir.
- Makro karşılaştırması aynı v3 paper politikası ve aynı aday evreninde yapılır. Bu, kendi başına nedensellik veya bağımsız holdout başarısı kanıtı değildir. MACRO_ONLY yerine DIRECTION_ALIGNED_SMC adı kullanılır.
- Gelecekteki PIT doğrulaması için üretici tüm kullanılan girdileri kapsayan `input_availability_complete: true` ve `input_availability: [{source, availableAt, vintageAt}]` sağlamalıdır. Kullanılabilirlik ve vintaj zamanları karar anını aşamaz. Bu kayıtlar yoksa doğrulama false kalır; zaman damgaları tahmin edilmez.
- Tutma sınırı dolan açık işlemler sansürlü gözlemdir; gerçekleşmemiş PnL sıfıra çevrilmez. Bu işlemler çoksa çözülmüş işlemlerin beklentisi de tek başına tüm stratejiyi temsil etmez.
- Haftalık bootstrap, haftalar arasındaki bağımlılığı bütünüyle ortadan kaldırmaz. Yeterlilik etiketleri örnek kapsamıdır; anlamlılık/edge sertifikası değildir. Dondurulmuş bağımsız holdout hâlâ gereklidir.
- `independentHoldoutId` bulunmayan gözlemler holdout sayılmaz. İstatistik eşiğinin geçilmesi otomatik promosyon açmaz.

## Kullanım

`smc_engine` içinden:

```text
npm run report:macro-outcomes -- --json
npm run report:outcome-readiness
npm run report:outcome-readiness -- --write
```

İlk komut güncel analitik ve hazır oluş sayaçlarını döndürür. Son komut yalnızca promosyon dosyasının ölçüm sayaçlarını yeniler; canlı kapıları aktive etmez.

Bu checkout'ta yenileme anında 162 benzersiz sinyal kanıtı, 96 outcome adayı, 35 dolum, 34 çözülmüş sonuç ve 1 belirsiz dolum vardır. Doğrulanmış v3 ekonomik makro holdout kaydı sıfırdır. Tarihsel örnek, yeni düzeltmelerin TP/SL etkisini göstermez.
