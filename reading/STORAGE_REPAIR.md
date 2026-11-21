# Quantower kayıt onarımı — 9 Kasım 2026

Önceki günlük 512 MiB sınırı 04.37 Türkiye saatinde yazıcıyı durdurdu. Süreç çalışıyor görünse de Forex bandı bayattı. 1.0.3 köprüsü bu günlük sınırı kaldırır: JSONL kayıtları 64 MiB veya beş dakika dolunca yeni parçaya döner. Gece yarısı ve yeniden başlatma yeni dosya üretir; eski dosyalara dokunmaz. Parça numarası sıkıştırılmış arşivleri de dikkate alır.

Gerçekleşmiş bütün işlemler korunur. Yalnızca vadeli BBO kotasyonu sembol başına en fazla 250 ms'de bir dışa aktarılır. Trade hız/hacim/yön hesapları bu kotasyon örneklemesine dayanmaz. Spot kutu temas fiyatları ayrı MT5 kaynağından gelir. Heartbeat, toplam kotasyon çağrıları ile kaydedilmiş kotasyon sayısını ayrı gösterir. Emir veya hesap erişimi eklenmedi.

READİNG servisindeki ayrı arşiv işçisi dakikada bir, en az 120 saniyedir değişmemiş ve ACTIVE_FILE.txt ile aktif gösterilmeyen kayıtları gzip düzeyi 1 ile sıkıştırır. Kaynak SHA256 ve sıkıştırılmış dosyanın açılmış SHA256 değeri eşleşmeden ham dosya kaldırılmaz. Aynı adla farklı arşiv varsa ham veri korunur ve hata verilir. Arşiv metadata ve audit.jsonl, ham boyutu, sıkıştırılmış boyutu ve özeti tutar. Okuma veya arşivleme hatası görünürdür.

Arşivler otomatik silinmez. Boş disk için 2 GiB, aktif ham klasör için 4 GiB ve arşivler için 8 GiB korumaları kalır. Arşiv bütçesi dolarsa arşivleme hata verir ve ham veri korunur; ileride bu bütçe için saklama/yeni disk kararı gerekir. Bu sınırsız depolama iddiası değildir.

Forex köprüsünün heartbeat'i bayatlarsa servis artık FOREX_BRIDGE_HEARTBEAT_NOT_FRESH hatası da gösterir. Başarılı bağlantı, her kontratın araştırma doğrulamasını veya veri aboneliğini otomatik onaylamaz. Minimum B+, makro vetoları, 14 çaprazın bağlam sınırı ve gölge mod korunur.

Yeniden başlarken saatlerce eski kotasyonu belleğe alma sorunu da giderildi. İlk okumada kaynak başına sınırlandırılmış bir kuyruk alınır (vadeli 16 MiB, MT5 kotasyon 4 MiB, PAXG 8 MiB; dosya başına). Atlanan eski arşiv içeriği diskten silinmez. Vadeli başlangıcında bir ön ek atlandıysa 60 saniyelik yeniden ısınma gerekir. Bayat MT5 kotasyonları yeniden karar hesaplamasına veya ikinci bir günlüğe yazılmaz.

Doğrulama: 106 Python testi; gerçek derlenmiş C# yazıcısında boyut/süre/gün rotasyonu, eski dosya koruması ve arşivli numaradan devam testi. Canlı kanıt STORAGE_REPAIR_VALIDATION.json içinde tutulur.
