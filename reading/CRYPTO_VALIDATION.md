# Kripto bağlantı doğrulaması — 8 Kasım 2026

## Kapsam ve uygulama

Binance spot BTCUSDT/ETHUSDT kamu verisi bağlandı. API anahtarı veya hesap açılmadı. Mumlar, gerçek işlem bandı, Bid/Ask ve top-20 fiyat seviyeleri aynı borsadan alınıyor. SMC için yalnızca BTCUSD/ETHUSD dahili alias'ları kullanılır; USD broker fiyatı olduğu söylenmez. Short önerisi gerçekleşmiş spot açığa satış değildir.

Mevcut makro motorundan onay → mevcut SMC pipeline'ı/kutu → otomatik READING. İki yönün makro çarpanı 0 ise SMC bu turda taranmaz; MACRO_BLOCKED kaydedilir. Kontrol ve yeni otomatik giriş ayrı izlenir. İnsan bant onayı yok; emirler/Telegram kapalı.

## Doğrulananlar

- 77 Python testi geçti; kripto venue kimliği, trade ID boşluğu, tekrar, gelecekteki olay, saat/bbo eskiliği, kapanmış mum, eksik mum, BTC kotasyonunun sahte broker saati üretmemesi, makro veto ve L2 snapshot doğrulaması kapsandı.
- Node sözdizimi ve Python modülleri kontrol edildi.
- Gerçek API üzerinden 8 kapanmış mum serisi (iki sembol × 1m/15m/1h/4h) alındı; meta verisi ve hash kaydedildi.
- Gerçek WebSocket bağlantısında işlem, kotasyon ve top-20 derinlik mesajları oluştu. Önceki bağlantı oturumunda iki sembol de RESEARCH_FEATURES_READY durumuna ulaştı. Yeniden başlatma sonrası 60 saniye yeniden ısınma zorunlu; yeniden bağlantı sessizce tam veri sayılmadı.
- Gerçek makro ön kontrolü iki sembolde de onay vermedi. Long yönünde motorun margin-call/korunma vetosu, short yönünde mevcut hafta sonu/rotasyon koşulları görüldü. Bunlar motorun etiketleridir; dışarıdaki ekonomik olayların bağımsız doğrulaması değildir. Veto kaldırılmadı, eksik bias nötrle doldurulmadı.
- İlk yükleme sırasında geç işlenen az sayıdaki kotasyon reddedildi. Eski/future kotasyonlar geçerli giriş sayılmadı. Defter taraması zaman/fiyat prefix toplamlarıyla ve yalnızca gerekli yakın geçmişle sınırlandı; kripto özellik önbelleği en çok 500 ms.
- Gerçek yaklaşık 13 bin olaylık veriyle 8 özellik hesaplaması 0,48 saniye civarında tamamlandı; bu garantili gecikme sınırı veya borsa gecikmesi ölçümü değildir.

## Henüz kanıtlanmayanlar

Gerçek dolum, emir yönlendirmesi, ücret/kayma ve net PnL yok. Absorption adayları ve hızlı likidite çekilmeleri niyet/kurumsal kimlik veya kesin spoofing kanıtı değildir. Top-20 fiyat seviyeleri tam defter/MBO değildir. Ham kayıt alınış zamanındaki hız, ağ paketlenmesinden etkilenebilir. Makro onaylı gerçek SMC setup'ında ileri dönem giriş başarısı henüz ölçülmedi; edge kanıtlanmadı.
