# Hibrit motor geliştirmeleri — 23 Ekim 2026

M1 giriş kararı kullanıcıya aittir. Bu çalışma yeni M1 teyit şartı veya emir otomasyonu eklemez. Kutu geçersizliği yönüne göre tamamlanmış M15 kapanışıyla değerlendirilir; fitil tek başına kapanış değildir.

## SMC

- Engel taraması dizi sırasından bağımsız olarak en yakın M15/H1 OB veya FVG'yi seçer. Kapanışla geçersizleşmiş karşı bölgeler taramadan çıkarılır. Tarama hedef planının azami fiyat alanıyla sınırlıdır.
- Plan, yakındaki likiditeyi atlayarak büyük R göstermek için uzak havuz seçmez. Hedefler karşı bölgenin önünde, tahmini spread payı bırakarak sınırlandırılır. TP1 ana hedefi geçmez; ek alan yoksa ayrı runner önerisi gösterilmez.
- Giriş ve stop mesafesi aynı fiyat geometrisinden hesaplanır. Volatilite kaynağı sırasıyla sağlanan ATR, mevcut kapalı mumların medyan aralığı ve açıkça işaretlenmiş ölçekli varsayımdır. Spread tamponu korunur.
- Uygunluk kontrolü tahmini maliyeti hem kazançtan hem zarar tarafındaki riskten hesaba katar: `net R:R = (brüt hedef R - maliyet R) / (1 + maliyet R)`. Varsayılan minimum oran 2'dir. Alan yetersizse sinyal filtrelenebilir; bu değişiklik sinyal sayısını azaltabilir.
- Yaş, retest sayısı ve gerçekten bölgeye doğru hızlı yaklaşım birlikte POI risk bayrakları üretir. Bunlar kutu invalidasyonu veya yeni M1 veto kuralı değildir. JPY/kripto mesafesi sabit EURUSD pip'iyle ölçülmez.
- Kural puanından başarı olasılığı ve Kelly hesabı üretilmez. Ölçülmüş olasılık, beklenti ve Kelly alanları null kalır. Görünen hedef R ile ölçülmüş getiri beklentisi ayrılır. Varsayılan referans risk bütçesi %0.5'tir; makro izin yoksa sıfırdır, makro risk çarpanı bütçeyi artırmaz.
- Paper model v1.1 planının stop ve ana hedef fiyatlarını saklar. Dolum anındaki R gerçek simüle girişe göre yeniden hesaplanır. Plan sürümü politika kimliğinde ayrılır. Bu, kullanıcının gerçek M1 dolumunun taklidi değildir.

## Ekonomik makro

`policy_expectations.relative_repricing` iki para biriminin aynı vadeli beklentilerindeki değişimi karşılaştırır. Tahvil getirisini OIS yerine kullanmaz; eksik para birimi bacağını sıfır varsaymaz.

Üretici `market_data.POLICY_RATE_EXPECTATIONS` altında her para birimi için şu gözlemleri sağlamalıdır:

```text
source, as_of, previous_as_of,
implied_rate_pct, previous_implied_rate_pct,
instrument_id, previous_instrument_id,
horizon, maturity_date
```

Kaynaklar belirtilmiş, sayılar sonlu, sözleşme kimliği aynı, vade gelecekte ve iki bacağın vadesi aynı olmalıdır. Gözlemler karar anından sonra olamaz; son gözlem en fazla 36 saat, karşılaştırma aralığı en fazla 7 gündür. Bacakların gözlem zamanları en fazla bir saat farklı olabilir. Koşul karşılanmazsa UNAVAILABLE döner. Yeni ücretli veri sağlayıcısı bağlanmamıştır; mevcut opsiyonel panel veri verilmedikçe eksik kalır.

Göreli değişim 3 bp'nin altındaysa yönsüzdür. Ters yöndeki geçerli beklenti değişimi mevcut onaylı kararı NEUTRAL_CAUTION'a ve risk çarpanını 0.75'e indirir. Uyumlu veri riski büyütmez; mevcut sert makro veto aşılmaz. 3 bp ve 0.75 değerleri deterministik temkin kurallarıdır; optimize edilmiş veya pozitif edge'i kanıtlanmış eşikler değildir. Risk azaltılmış ama izinli işlem, ölçümde makro engelli sayılmaz.

## Kripto

Python makro ve TypeScript rotasyon motorlarında aynı yorum kullanılır:

- Eksik funding, 24 saat için yetersiz OI geçmişi veya eksik spot/vadeli hacmi türev teyidi sayılmaz. Eksik funding, veri alımında sıfıra çevrilmez; gerçek sıfır funding geçerlidir.
- Sağlanan OI zamanları varsa saatlik pencere ve kronolojik sıra doğrulanır. 24 saatlik değişim 25 gözlemden hesaplanır; on saatlik veri 24 saat diye etiketlenmez.
- Fiyat yükselirken OI geriliyorsa short covering, fiyat düşerken OI geriliyorsa liquidation bağlamı ayrılır. Bunlar yeni organik giriş veya yeni short birikimi puanı almaz.
- Mevcut squeeze/capitulation korumaları korunur. Veri eksikliği on-demand SMC aktarımını durdurur. Yeni rejimler ve OI/hacim bağlamı outcome snapshot'ına yazılır.

## Kanıt sınırı

Kod doğruluğu için regresyon testleri eklenmiştir. Bu değişikliklerin TP oranını artırdığı veya SL oranını azalttığı henüz bağımsız örneklem dışında gösterilmemiştir. Tarihsel sonuç dosyaları yeni kurallarla yeniden yazılmamıştır. Takipte TP/SL/BE, dolum oranı, maliyet sonrası beklenti ve maksimum düşüş birlikte değerlendirilmelidir.
