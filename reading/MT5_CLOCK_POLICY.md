# READİNG MT5 kış verisi — 9 Kasım 2026

Orijinal BEGONYA mum dosyaları güncel değildi; READİNG artık kendi salt-okunur MT5 mum toplayıcısını kullanır. `mt5_candles.py`, ana süreç tarafından tek kopya olarak başlatılır ve `STOP` ile durur. İndirme yavaşlığı ana bant döngüsünü bekletmez. Emir veya hesap işlemi yapmaz.

The5ers resmi saat açıklaması: https://the5ers.com/faqs/market-trading-hours/ — kış UTC+2, yaz UTC+3. Bu terminalde canlı Forex tick saatleri yerel UTC'den yaklaşık 7.200 saniye ileride gözlendi. `mt5_time.py` yalnızca 2 Kasım 2026–1 Mart 2027 aralığında, ham tickten 7.200 saniye çıkarıldığında iki saniyelik tazelik kontrolü geçiyorsa bu dönüşümü kabul eder. Ham tick saati korunur. Otomatik olarak başka saat dilimi tahmin edilmez; bayat bir server ticki yerel UTC sanılıp kabul edilmez.

Mum indirmesi yalnızca kapanmış barları alır ve aynı kış aralığındaki barları kullanır. Yaz ve DST geçiş geçmişi yeniden oluşturulmaz. OHLC değerleri korunur; mum zamanı milisaniye UTC'ye çevrilir. Metadata kaynak, offset, elde edilme zamanı ve SHA256 içerir. Geçmişi eksik sembol, kapanmamış/bayat HTF mumu veya bayat canlı kotasyon girişe uygun sayılmaz. Hafta sonu kapanışındaki son 4H mumunun açılıştan sonra eski görünmesi, tazelik şartını kaldırma gerekçesi değildir.

Bu, broker gecikmesinin uçtan uca ispatı değildir. Forex BBO, gerçekleşmiş global Forex işlem bandı değildir. Vadeli veri ve çapraz parite vekil sınırlamaları korunur.
