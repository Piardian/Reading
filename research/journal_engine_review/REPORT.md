# Begonya journal: yeni filtre eklemeden motor geliştirme incelemesi

24 Ekim 2026. Kaynaklar: `smc_engine/evidence/signals/smc-journal.md`, makro/paper outcome ledger'ı, çalışan uygulamanın kaynak kodu ve ayrı ileri ölçüm raporu. Kaynak hash'leri ve ayrıştırılmış bulgular `audit.json` içindedir. Bu inceleme çalışan motoru veya dondurulmuş ileri protokolü değiştirmez.

## Sonuç

Geliştirme alanı var. Öncelik, kurulumun gerçek yapısını stop/hedef/giriş planına doğru taşımak ve kullanıcının uyguladığı yönetimle ölçülen yönetimi eşlemek. Mevcut kayıtlar bir değişikliğin TP oranını kesin artıracağını veya SL oranını kesin düşüreceğini kanıtlamıyor.

## Kaynakların sınırı

- Journal 89 numaralı gözlem ve H1–H5 tarihsel not içeriyor. Son numaralı kayıt 9 Ekim sinyaline ilişkin; anlatımında 11 Ekim fiyat hareketi var. Bu dosya 24 Ekim'e kadar eksiksiz, güncel bir işlem hesabı değildir.
- Aynı kurulum farklı kayıtlarda bulunuyor (#15/#22); bekleyen, girilmeyen, benchmark ve kullanıcının bildirdiği sonuçlar birlikte yazılmış. Bunlardan doğrudan başarı oranı hesaplanmadı.
- Ledger kesitinde 97 ayrı sinyal sonucu var; 96'sında politika kimliği yok. Kapanmış ve giriş teyidi işaretlenmiş 34 eski sonuç: 7 TP, 17 SL, 10 BE. Bunlar yeni v1.2'nin performansı değildir.
- Aynı EURJPY sinyali #76'da kullanıcı SL ve benchmark SL olarak anlatılırken ledger'da aynı mumda +2R TP yazıyor. Giriş ve çıkış fiyatları da journal ile farklı. Doğru işlem akışı ham kayıtlarla çözülmeden bu örnek başarı hesabında kullanılamaz.
- Yeni ileri raporun incelenen kesitinde bir kabul edilmiş aday, sıfır dolum ve sıfır kapanmış dolum var; aday dolmadan iptal/sona ermiş. Bu örneklem yeni politikanın TP/SL etkisini henüz söylemez.

## Öneri 1 — Yapısal bölge hiyerarşisini geliştirmek

**Journal bulgusu:** #12 ve #16 LTCUSD aynı harekette daha aşağıdaki FVG/iç OB ve üstteki 50 civarı tepe/kök bölgesini farklı işlem gibi ele alıyor. Her ikisi HTF düşüş yönüyle uyumlu olsa da iç kutular önce aşılıyor. Bu anlatım nedensel bir likidite kanıtı değildir; bölge ve stop hiyerarşisinin incelenmesi için somut örnektir.

**Mevcut kod:** OB tek mumdan, displacement başlangıcının hemen öncesinden türetiliyor. Consolidator önce en yeni kırılımı seçiyor; OB varsa aynı kırılımın FVG'sini bastırıyor. İki aday seçildikten sonra fiyat derinliğine göre sıralama yapılması, kök bölge ve iç bölge ilişkisinin kurulduğu anlamına gelmiyor. Stopta ATR/spread tamponu zaten var; yeniden aynı öneri yapılmıyor.

**Geliştirme:** Aynı displacement içindeki kök OB, iç OB/FVG ve korunan swing'i kimlikli bir kurulum ağacında bağlamak. Giriş kutusu ile fikrin gerçek yapısal geçersizlik seviyesi ayrı alanlar olsun. Bölge seçimi yalnızca OB etiketi veya güncellik yerine bu ilişkiyi kullansın. Stop, işlem açılmadan önce bu açık geometriden türesin; aynı parasal riskte pozisyon miktarı ve net R:R yeniden hesaplansın.

**Beklenti:** Yanlış iç kutu/stop eşleşmesini azaltabilecek en doğrudan SL geliştirme hipotezi. Her stopu genişletmek veya kaybeden pozisyonda stopu uzaklaştırmak önerilmiyor. Daha geniş stopun ortalama R'yi düşürebileceği ve maliyet/pozisyon büyüklüğü etkisi ayrıca ölçülmeli.

## Öneri 2 — Gerçek giriş fiyatına bağlı tek işlem planı

**Journal bulgusu:** #71'de kullanıcı SL, benchmark TP; #78'de kullanıcı TP, midpoint benchmark EXPIRED; #84'te teyit anlatılmasına rağmen gerçek emir/dolum yok. #70'te de kullanıcı +4R anlatımıyla midpoint benchmark ayrışıyor. Bunlar eşit girişli karşılaştırmalar değildir.

**Mevcut durum:** v1.2 ile maliyet sonrası uygun giriş aralığı zaten eklendi. Ancak bu, kullanıcının fiilen hangi fiyattan, ne zaman ve hangi stopla girdiğini kendiliğinden ölçmez.

**Geliştirme:** Kullanıcının gerçek dolum fiyatı ve zamanı girildiğinde sabit yapısal stop ve fiziksel hedeflerden gerçek risk mesafesi, kademeli hedefler ve pozisyon miktarı hesaplansın. Aynı `setupId` altında sinyal planı, manuel dolum ve paper karşılaştırması bağlansın. M1 kararını otomatikleştirmek veya yeni bir M1 kuralı eklemek gerekmiyor.

**Beklenti:** Planlanan 2R ile gerçek girişte sağlanan 2R'nin karışmasını azaltır; doğru işlem uygulamasını ve sonuçların açıklanmasını iyileştirir. Tek başına fiyat tahmin gücü kanıtı değildir.

## Öneri 3 — Hedef, kademeli çıkış ve BE'yi tek sözleşmeye bağlamak

**Doğrulanmış uyumsuzluk:** Bildirim +1.5R'de BE ve %50 kapama, sonra %30/%20 dağılımı söylüyor. Paper varsayılanı 1.35R BE ve `enablePartialTp: false`. Plan fonksiyonunda TP1 ise `min(1.5R, ana hedefin %60'ı)`; aynı senaryo ölçülmüyor.

**Journal aritmetiği:** #75 anlatımındaki yarısı 1R, yarısı 2.3R çıkışın toplamı maliyet öncesi **1.65R**; 2.3R toplam getiri değildir. #78 için yarısı 1R, yarısı 2R toplam **1.50R** yapar. Bunlar anlatımdaki ilk pozisyonun yarısı varsayımıyla hesaplanır; gerçek broker sonucu bilinmiyor. Ayrıca 0.75% hesap riski ile -0.75R aynı birim değildir.

**Geliştirme:** Bir yönetim nesnesi bildirim, paper takip ve journal'a aynı kademeleri, miktarları ve BE kuralını versin. Kalan pozisyon ve gerçekleşen nakit getiri lot/fiyat ağırlıklarıyla hesaplansın. TP1 ve runner alanı gerçek likidite/engel yoluyla ilişkilendirilsin; her pozisyon için metin olarak sabit oran şablonu kullanılmasın.

**Maliyetli BE:** Eski 10 BE sonucunun 8'i kaydedilmiş maliyetlerden sonra negatif. Nominal girişe stop taşımak net başabaş değildir. Tahmini masrafı karşılayan fiyat ayrı gösterilsin; stopun taşınma anı mevcut M15 yapısı ve kalan pozisyonla birlikte tanımlansın. Yeni seviye gerçek dolum ve kaymayla tekrar kontrol edilmeli; net sıfır garanti edilemez.

**Beklenti:** En güçlü doğrulanmış yazılım/yönetim uyumsuzluğunu giderir. Kârın geri verilmesini azaltabilecek çıkış varyantları ancak aynı giriş/stop/riskle karşılaştırıldığında performans sonucu sayılabilir.

## Öneri 4 — Kurulumun canlı durumunu ve hedef yolunu güncellemek

**Journal bulgusu:** #88 SOLUSD'de cuma sinyali pazar günü işlem olarak uygulanmış, benchmark ise cuma günü 4 saat sonra sona ermiş. Sonuç farkının bir bölümü farklı işlem penceresinden geliyor. #76'da da reteste yaklaşan yapının değişimi anlatılıyor.

**Geliştirme:** Aynı kutu `oluştu / yaklaşılıyor / test edildi / kullanıcı girdi / M15 ile geçersiz / kapandı` durumlarıyla tek kimlikte izlensin. Her kapalı M15'te güncel H1/M15 yapı, en yakın karşı engel, hedefin önceden alınıp alınmadığı ve kalan hedef mesafesi yeni plan sürümü olarak işlensin. Kullanıcıya son durum yansısın. Aktif pozisyonda ilk stop/risk ve gerçekleşmiş kademeler değişmez geçmiş olarak saklansın.

Bu, yeni bir yaş eşiği, hafta sonu filtresi veya M1 veto önerisi değildir. Orijinal M15 kapanış invalidasyonu korunur. Kullanıcının kutuyu takip ettiği süre ile paper modelin gözlem penceresi açıkça ayrılır; paper EXPIRED, otomatik kullanıcı emri iptali diye sunulmaz.

## Ne önerilmiyor?

- Journal'daki eski TP/SL etiketlerine göre topluca stop genişletmek veya tüm hedefleri küçültmek.
- Daha fazla TP etiketi elde etmek için ortalama kazancı ve maliyeti göz ardı etmek.
- Eski SL kayıtlarının MFE'sinden kesin BE/trailing sonucu çıkarmak. 17 SL'nin kaydedilmiş MFE'si 1R altında; 5 TP/SL kaydı aynı mumda kapanmış ve bütün 34 eski dolumda politika kimliği eksik. Bunlar güvenilir mum sırası/müdahale deneyi değildir.
- Ek makro filtresi çıkarmak. Bu journal'da ekonomik makro girdilerinin yeterli zaman damgalı karşılaştırması yok; makro tarafında kanıtlanmış yeni bir edge önerilemiyor.

## Öncelik ve başarı ölçütü

1. Tek yönetim sözleşmesi ve gerçek doluma bağlı R/nakit hesabı: doğrulanmış uyumsuzluklar.
2. Kök/iç bölge ve korunan swing hiyerarşisi: SL azaltma için en anlamlı motor hipotezi.
3. Likiditeye bağlı kademeli hedef, maliyetli BE ve güncellenen kurulum durumu: kârın korunması ve uygulanabilir plan.

Deneyler ayrı araştırma sürümünde, aynı adaylar ve ilk parasal risk korunarak yürütülmeli. Birincil ölçüt yalnızca TP yüzdesi değil: maliyet sonrası ortalama R, kuyruk zararları, maksimum düşüş ve dolum oranı birlikte. Mevcut dondurulmuş ileri çalışma sessizce değiştirilmedi.
