# Quantower köprü doğrulaması — 7 Kasım 2026

## Doğrulananlar

- Gerçek kurulu Quantower 1.146.7 API DLL'sine karşı C# derlemesi başarılı. Bir uyarı: mevcut platform eski OnGetMetrics metodunu deprecated işaretliyor; derleme hatası yok.
- Quantower özel script kataloğunda sınıfı tanıdı. GUI üzerinden strateji örneği oluşturma adımı tamamlanamadı; buna bağlı kalmayan, yerel autostart.json ile açıkça etkinleştirilmiş veri hostu kullanıldı. GUI sorununun kök nedeni kesinleştirilmedi.
- Gerçek uygulama içinden BACKGROUND_EXPORT_STARTED kaydı, 8 doğru kontrat kimliğiyle abonelik isteği ve artan sıra numaralı heartbeat oluştu.
- Python READİNG gerçek ham dosyayı okudu: feed_provider=quantower, bridge_state=HEARTBEAT_FRESH. Test kaydı veya sahte işlem üretilmedi.
- Yerel stop komutundan sonra session_stop oluştu; READİNG WAITING_QUANTOWER durumuna geçti. Start komutundan sonra farklı oturumda heartbeat tekrar geldi. 2 başlangıç / 1 kapanış gözlendi.
- Aktif kayıtçının FileShare.None kilidi başka bir süreçte salt okunur açma isteğini reddetti. Gerçek iki exporter örneğini GUI'den başlatma testi yapılmadı.
- Kuyruk kaybı bildirimi 0, bozuk satır 0. Yeniden başlatma nedeniyle 8 kökte CONTRACT_OR_SESSION_CHANGE sayacı beklenen şekilde arttı; bu veri kalitesi kontrolü kayıtları hata olarak gizlenmedi.
- Python 44 test geçti. Bunlar kârlılık kanıtı değildir.
- READİNG Python alıcısı ve kendisine ait SMC yardımcı süreci çalışıyor. Orijinal BEGONYA değiştirilmedi. Emir ve Telegram gönderimi kapalı.

## Doğrulanmayanlar / bekleyenler

- Cumartesi: gerçekleşmiş yeni futures işlem olayı yok. GC'den iki oturumda toplam 4 kotasyon olayı görüldü; sağlayıcı zamanları önceki güne ait önbellek görüntüleriydi. Canlı işlem bandı olarak sayılmadı.
- 8 abonelik isteği, 8 canlı veri yetkisi demek değildir. Bugünkü Quantower günlüğünde NE6/6N için gerçek zamanlı abonelik reddi bulundu; son kayıt 2026-11-07 13:05:23 UTC. Bu, yeni bir abonelik sorgusu değildir; piyasa açıkken doğrulanmalı.
- FeedLabel UNVERIFIED; bant giriş teyidine yükseltilmez. Sağlayıcının QuoteDelay=0 bildirimi canlılık veya lisans kanıtı sayılmaz.
- Level 2 kapalı; derinlik/MBO, absorption veya spoofing doğrulanmadı. Agresör bayrağının sağlayıcı/borsa kökeni henüz doğrulanmadı.
- SMC/makro kaynaklarında eksik veya bayat veri varsa adaylar DATA_NOT_READY kalır. Veri köprüsünün çalışması bu motorların canlı setup ürettiğini kanıtlamaz.
- 14 çapraz parite doğrudan bant teyidi almıyor; mevcut iki bacak bağlamı doğrudan çapraz bandı yerine geçmiyor.
- Saat, futures/spot baz farkı, kayma/komisyon ve ileri dönem sonuçları ölçülmedi. Net PnL null, edge kanıtlanmadı.

Güncel durum: köprü ve alıcı çalışıyor; canlı piyasa doğrulaması bekleniyor. QUANTOWER_DURUM.cmd anlık dosya/heartbeat kontrolünü yeniler. Uygulama ve PC açık kalmalıdır.
