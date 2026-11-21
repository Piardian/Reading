# Begonya v1.3 — journal kaynaklı motor geliştirmeleri

## Kullanım ve çalışma kapsamı

Bu sürüm ayrı bir **gölge gözlemci ve manuel dolum günlüğüdür**. Canlı Telegram motoru mevcut dondurulmuş v1.2 ölçümünü sürdürür. v1.3 ortak mum dosyalarını ve mevcut makro/haber girdilerini okur; sağlayıcıdan veri istemez ve emir göndermez. Yeni sinyal uygunluk filtresi eklenmedi. M1 giriş kararı kullanıcıdadır; orijinal kutuyu geçersiz kılan kapalı M15 kuralı korunur.

Yerel ekran: **http://127.0.0.1:3021**. Yeni kabul edilen kurulumlar ekrana geldikçe listelenir. Eski journal anlatımlarından gerçek dolum üretilmez.

Çalışan gözlemcinin PID ve çıktı klasörü `active-observer.json` içindedir. Başlatma:

```powershell
& .\research\journal_engine_upgrade\start-observer.ps1
```

Aynı klasörden devam etmek için `-RunDirectory <mutlak-klasör>` kullanılabilir. Kod/protokol uyuşmazlığında başlangıç reddedilir. Bilgisayar yeniden başladığında bu betiği yeniden çalıştırmak gerekir; Windows servisi kurulmadı. Aynı anda ikinci gözlemci açılmamalı.

## Uygulanan geliştirmeler

1. **Tek yönetim sözleşmesi:** `src/tradeManagement.ts` bildirim önizlemesi, paper takip ve manuel hesapların ortak kaynağıdır. Kademelerin oranı ilk pozisyona göre ağırlıklandırılır. Kısmi sonuç ile kapanmış toplam sonuç ayrılır; açık pozisyonun nihai R'si `null` kalır.
2. **Yapısal stop:** Kök OB, iç OB/FVG ve kırılım anında teyitli korunan swing aynı `setupId` altında bağlanır. Kullanılabilir yapısal ankraja mevcut ATR/spread tamponu uygulanır. Genişleyen stop için aynı para riskiyle miktar yeniden hesaplanır. Açılmış işlemin ilk riski sonradan değiştirilmez. Bu ilişki bir fiyat yapısı hipotezidir; likidite emirlerinin varlığını kanıtlamaz.
3. **Gerçek doluma göre plan:** Manuel fiyat, zaman, ilk stop ve miktar bildirilir. Fiziksel hedefler korunarak risk mesafesi, net R:R, maliyetli BE ve miktar hesaplanır. Kullanıcının farklı ilk stopu ayrıca hesaba katılır. Uygunluk dışı gerçekleşmiş dolumlar sapma etiketiyle kaydedilebilir. Kayıtlar `USER_REPORTED_NOT_BROKER_VERIFIED` olarak işaretlenir.
4. **Likiditeye bağlı kademeler ve koruma:** En yakın teyitli, alınmamış M15/H1 likiditesi ve karşı engel hedef yolunu belirler. Ara fiziksel hedef varsa ilk miktarın %50'si; ana hedef sonrası gerçek runner alanı varsa %20 runner kullanılır. Ara hedef yoksa ana hedef %80 veya %100 olabilir. Uzak runner yoksa yeni runner fiyatı uydurulmaz. Mevcut sentetik ana hedef yedeği açıkça `SYNTHETIC_FALLBACK` olarak etiketlenir.
5. **Maliyetli BE ve teyitli swing takibi:** İlk kısmi çıkıştan sonraki M15 kapanışında, gerçekleşmiş kâr ve kalan miktar üzerinden toplam pozisyonun tahmini net başabaşı hesaplanır. Girişten sonra oluşup teyit edilen uygun swing stopu daha da sıkılaştırabilir. Yeni seviye sonraki mumdan itibaren geçerlidir; stop uzaklaştırılmaz. Manuel ekrandaki `managementAdvice` öneridir: stopun brokerda taşındığı veya çıkış gerçekleştiği varsayılmaz.
6. **Kurulum revizyonları:** Bekleyen kurulumun hedefi, karşı engeli, makro izni, ATR'si ve orijinal hedefin alınıp alınmadığı her yeni kapalı M15'te güncellenir. `originalPlan` saklanır; açık manuel/paper pozisyonun başlangıç geometrisi yeniden yazılmaz.

Para hesabı için **1 tam fiyat birimi × 1 miktarın hesap para birimindeki değeri** açıkça girilmelidir. Bilinmiyorsa boş bırakılır; nakit sonuç `null` olur. Varsayılan maliyetler tahminidir. Broker miktar adımı, minimum lot, marjin ve gerçek kayma otomatik doğrulanmaz. Önerilen miktar matematiksel miktardır; gap zararları bütçeyi aşabilir.

## Ölçüm

- Her çalışmanın `protocol.json` dosyasında v1.2 karşılaştırıcı ve v1.3 kaynak/derleme hash'leri bulunur. Aynı dosyaların `frozen-code/` kopyaları saklanır. `runtime-info.json` Node ve bağımlılık kilidi bilgisini kaydeder.
- `market/` mum anlık görüntülerini, `macro/` kapı görüntülerini saklar. Mum görüntüleri sembol eşlemesi ve haber dosyalarının o anda okunan içeriklerini de içerir.
- `events.jsonl`: aynı yukarı akış adayının v1.2 ve v1.3 planları, kayıt ve paper olayları. Karşılaştırma net R:R elemesi ve konsolidasyondan önce kaydedilir; sonradan yalnızca v1.3'ün kabul ettikleri seçilmez.
- `common-population-comparison.json`: dondurulmuş v1.2 paper takipçisi ve v1.3 takipçisi aynı aday akışını ayrı dosyalarda izler. Kabul, stop, hedef, giriş bandı ve yönetim birlikte değişebilir. Bu birleşik politika karşılaştırması tek bir değişikliğin nedensel etkisini ayırmaz. Maliyet dahil eşit başlangıç para riski için ayrıca normalize getiri yazılır.
- `journal/setup-revisions.jsonl`: kurulum revizyonları. `journal/manual-executions.jsonl`: append-only manuel dolumlar; tekrar gönderim kimliğiyle çoğaltma önlenir. Paper ve kullanıcı bildirimleri ayrı kalır.
- `notification-previews.jsonl`: ortak yönetimden üretilen yerel bildirimler. Bunlar Telegram'a gönderilmez. Gölge aday sayıları canlı teslim edilen sinyal sayısı değildir; sembol kapsamı ve bildirim geçmişi farklıdır.
- İlk gözden geçirme eşiği 28 gün / 100 kapanmış paper dolumu / 4 bağımsız UTC haftasıdır; karşılaştırma kollarının ayrı örneklem yeterliliği ayrıca incelenir. Bu eşikler başarı veya istatistiksel anlamlılık garantisi değildir. Otomatik canlı terfi yoktur.

M15 paper dolumu gerçek M1 dolumu değildir. Aynı mumda hedef ve stop varsa stop önce sayılır; giriş mumunda olumlu hedef hareketi yazılmaz. Kısmi çıkıştan sonra paper gözlem süresi biterse kalan miktar için çıkış uydurulmaz; işlem sansürlü/çözümlenmemiş olarak raporlanır. BE etiketi net sıfır garantisi değildir; gerçekleşen ağırlıklı net R esas alınır. Kapanmış sonuçların ortalaması, sansürlü pozisyonlar ve açık risk incelenmeden edge kanıtı sayılamaz.

## Kontrol ve sınırlar

TypeScript derlemesi başarılıdır. Bu uygulama turunda davranış testleri eklenmedi/çalıştırılmadı. Yerel sağlık uçları, süreç kayıtları ve hash bütünlüğü üzerinden operasyonel kontrol yapılır. **TP oranının yükseldiği veya SL oranının düştüğü henüz kanıtlanmadı.** Makro motor için bu journal'dan desteklenmeyen yeni bir tahmin kuralı çıkarılmadı.

İlk kısa başlangıç `journal-v13-20261024T095341980Z`, sıfır dolumla `SUPERSEDED.json` işaretlenerek kapatıldı. Yönetim açıklaması ve farklı manuel stopun net R:R hesabı sonrasında yeni protokol açıldı; eski kayıtlar ve kaynak kopyaları korundu.
