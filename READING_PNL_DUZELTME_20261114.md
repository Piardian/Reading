# READİNG: sıfır işlem ve PnL teşhisi — 14 Kasım 2026

Ana defterde açılmış veya kapanmış işlem yok: TP/SL/BE = 0, brüt = 0R. Net PnL ve profit faktör ölçülmedi. Eski rapordaki NET etiketi, maliyetsiz brüt toplamı yanlış adlandırıyordu.

Ana kolda 24 kurulum kaydı ve 5 temas var:
- EURAUD: iki temas; bu çaprazın doğrudan bandı yok. Bacak verisi bağlamdır, giriş teyidi değildir.
- USDJPY ve DASH: iki temas; bant kaynağı doğrulanamadı. Eski kayıtlarda alt nedenler tutulmadığından bu iki olayı tek bir arızaya kesin bağlayamayız.
- TAO: bir temas; gerekli temas sonrası hız/emilim adayı oluşmadı.

## Uygulanan düzeltmeler

- Daha yeni heartbeat/reset, önceki bir kotasyonun veri doğrulamasını artık bozamıyor. Pozitif ve negatif zamanlama senaryoları test edildi.
- B/C/D araştırma kollarının kendi kalıcı işlem defterleri bağlandı. Sonuçlar ayrı tutuluyor; Telegram yalnızca A için. Geçmiş adaylara işlem veya kâr eklenmedi.
- Gölge deftere girişte de çıkıştaki 2 saniyelik kotasyon tazeliği zorunlu. Eski/future kotasyonla giriş yazılamıyor.
- Forex ve altın kutularının güncel makro veto kontrolü tamamlandı. B+ ve ana makro kapısı gevşetilmedi.
- Her deney kolunun süre aşımı kontrolü çalışıyor. Bant reddinin ayrıntılı nedeni bundan sonra kaydediliyor.
- İşleme dönüşmeyen kutular artık korunmuş zarar veya kazanç sayılmıyor. Brüt ve ölçülmemiş net ayrıldı; PF işlemsizken tanımsız.

## Devreye alma ve kalan sınırlar

136 Python testi ve JavaScript sözdizimi kontrolü geçti. Tek READİNG servisi yeniden başlatıldı; çalışan dosyaların hashleri başlangıç manifestiyle doğrulandı. Orijinal BEGONYA değiştirilmedi. order_routing=false; $100 varsayımsal risk, +1R'da yarım TP/BE ve en az 2R son hedef korundu.

Quantower yeniden açıldı; CQG bağlantısı ve heartbeat güncel. Cumartesi seansında yeni CME işlemi yok: canlı bant ve yetki doğrulaması açılış sonrası gerçek olay gerektirir. 14 Forex çaprazının doğrudan bant kapsamı halen yok; bunları hazır kabul etmiyoruz. Kriptoda 60 saniyelik ısınma sonrası taze veri olan semboller kullanılabilir, sessiz/eski veri olanlar engelli kalır. Anlık sayılar PNL_DIAGNOSIS_20261114.json içindedir.

Bu düzeltmeler veri ve muhasebe kusurlarını giderir. Kârlılık kanıtı üretmez; doğrulanmış yeni adaylar ve ileri gölge sonuçlar gerekir. Sırf mesaj gelsin diye giriş üretilmedi, test Telegram mesajı gönderilmedi.
