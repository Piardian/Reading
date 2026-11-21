# 11 Kasım veri onarımı

Doğrulama: 127 READİNG ve 5 PAXG testi geçti. Canlı izleme sırasında Forex'in 21 paritesinde mum veri hatası kalmadığı, kriptoda BTC BBO yaşının yaklaşık 0,1–0,2 saniyeye indiği ve kaynak sıra/saat hata sayacının sıfır kaldığı gözlendi. Seyrek işlem gören sembollerin uygunluğu her pencereye göre değişir; bütün 40 sembole sürekli hazır etiketi verilmez.

IPC tüketicisinde, multiprocessing besleyicisinin henüz boruya aktarmadığı sıradaki mesajı `get_nowait` ile kaçırıp sadece tek paketi alma sorunu düzeltildi. Okuyucu toplam 150 ms bütçe içinde paket başına en çok 10 ms bekleyerek kuyruğu boşaltır. Olay atma veya daha geniş tazelik eşiği kullanılmaz.

XAU'nun taze olmayan kotasyonu artık yanlışlıkla yetkilendirme/terminal kopuşu olarak bildirilmez. Terminal bağlı kalır, kotasyon durumu STALE_OR_CLOCK_UNVALIDATED olur ve taze fiyat olmadan işlem üretilmez. The5ers resmi seans saatleri: https://the5ers.com/faqs/market-trading-hours/ — kışın metaller için Türkiye saati 00.50–02.05 arası günlük kapanışa karşılık gelir; Forex için 00.55–01.05 arasıdır. Bunlar seans açıklamasıdır; gerçek kotasyonun gelmiş olduğu varsayılmaz.

## MT5 kaynak seçimi

Genel MetaTrader terminali Authorization failed (-6) veriyordu. The5ers terminalinde salt-okunur API bağlantısı ve güncel fiyatlar doğrulandı. `forex_mt5_terminal` açıkça bu terminale ayarlandı; `ForexQuotes` içindeki The5ers yolunu başka terminale sessizce çeviren kod kaldırıldı. Başka terminale otomatik geçiş yapılmaz. Beklenen terminal yolu kontrolü, mevcut kış saat dönüşümü ve tazelik şartları korunur. Kaynak değişikliği metadata girdileriyle ileriye dönük kaydedilir; eski bayat mumlardan işlem uydurulmaz.

## PAXG kayıtları

PAXG gözlemcisinin günlük 250 MiB sınırı kaldırılıp 64 MiB veya beş dakikalık parçalara dönme düzeni getirildi. Eski günlük dosyalar korunur, kapanmış parçalar ayrı işçide SHA256 doğrulamasıyla kayıpsız sıkıştırılır. 2 GiB boş alan, ham toplam ve 8 GiB arşiv korumaları geçerlidir; arşivler otomatik silinmez. MT5 kaynağı aynı The5ers terminalidir. Tick sorgu aralığı broker saatine çevrilir; ham broker zamanı ayrıca saklanır ve kayıt zamanı UTC'ye dönüştürülür. Bu dönüşüm tek başına PAXG'nin global altın bandı veya kurumsal absorption kanıtı olduğu anlamına gelmez.

## 40 sembollük kripto veri alımı

Mevcut 40 sembollük evren korunur. Websocket/REST toplayıcısı ayrı Python sürecinde çalışır; ana motorun hesap yükü websocket okumasını aynı GIL üzerinde bekletemez. İletim, 100 ms veya 2.000 olaylık parçalara ayrılmış sınırlı bir multiprocessing kuyruğudur. Kuyruk birikmesi ve kaynak bekleyen olay sayısı sağlık kaydına eklenir. Önceki kolektör PID'sine ait sağlık dosyası canlı bağlantı sayılmaz. Kaynak süreci kapanırsa tazelik kapalı kalır.

Ham işlemler toplanmaya devam eder. Makro/SMC onaylı aktif setup yokken pahalı örüntü hesabı yapılmaz; fiyat, işlem yönü, hacim, sıra, boşluk ve saat sağlığı yine izlenir. Aynı iki dakikalık geçmiş tutulur. Onaylı kutu varsa otomatik READING şartları tam olarak hesaplanır. Böylece hız/absorption eşikleri veya tazelik sınırları gevşetilmeden boşta hesap yükü azaltılır. Seyrek işlem gören sembolün beş saniyelik trade/BBO şartını geçmemesi veri uydurularak düzeltilmez.

Kripto gzip kayıtları da 64 MiB veya beş dakikada yeni dosyaya döner; eski günlük dosyaya eklenerek yeniden sınıra takılmaz. Toplam 5 GiB ve 2 GiB boş alan korumaları kalır. Mevcut raw BBO/derinlik arşiv örneklemesi bir saniyedir; canlı tüketici daha sık gelen olayları alır. Arşiv, bütün canlı defter olaylarının birebir yeniden oynatımı sayılmaz.

## Korunan işlem kuralları

Mevcut minimum SMC notu A ve 40 kripto sembolü korunur. Makro vetoları, 100 USD varsayımsal risk, +1R %50 TP, kalan stop girişe ve likidite TP2 >= 2R politikası değişmez. Gerçek emir gönderimi kapalıdır. Yeni veri bağlantısı kârlılık kanıtı değildir. Canlı sonuçlar DATA_REPAIR_20261111_VALIDATION.json dosyasına kaydedilir.
