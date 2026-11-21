# READING — gölge işlem ve Telegram raporu

Kullanıcı gölge raporlama seçti. Gerçek emir açılmaz. BEGONYA'nın mevcut `smc_engine/.env` dosyasındaki Telegram hedefi kullanılır; token/sohbet kimliği loga veya rapora yazılmaz. Bu hedef API'de **private** olarak doğrulandı; kanal olduğu iddia edilmez. BEGONYA'nın ayarları değiştirilmez.

## Bildirimler ve hesaplama

- Yalnızca yeni AUTOMATIC_PATTERNS_V1 önerileri. Kontrol kuralı, eski öneriler ve başka projelerin işlemleri bildirilmez/toplama katılmaz.
- Açılışta gerçek emir yerine gölge referans pozisyon kaydı yapılır. Long giriş Ask, short giriş Bid referansıdır; gerçekleşmiş dolum değildir.
- Başlangıç protokolü: TP1 veya mevcut SL'nin **ilk gözlendiği geçerli Bid/Ask** kotasyonunda tam kapanış modeli. Fiyat stopu aşarsa otomatik -1R veya tam stop dolumu varsayılmaz; gözlenen kotasyon kullanılır. Kayıt gerçek limit/stop emri simülasyonu değildir.
- Her işlem kendi ilk stop mesafesiyle normalize edilir. Long kapanış Bid, short kapanış Ask kullanılır. Spread referans fiyatlarda yer alır. Brüt R, komisyon ve kayma öncesi kotasyon farkıdır. R toplamı eşit ilk risk normalizasyonudur; hesap bakiyesi veya dolar kazancı değildir.
- Otomatik BE'ye taşıma kuralı eklenmedi. BE sayacı tutulur; BE stop seviyesi anlamındadır, komisyon sonrası sıfır net garantisi değildir. Mevcut protokolde BE beklenmez.
- 5 saniyeden uzun kotasyon boşluğu varsa sonuç UNRESOLVED/DATA_GAP olur. TP/SL/BE veya kazanç uydurulmaz. Normal aralıklarda bile yalnızca gözlenen kotasyonlar izlenir; aradaki tüm işlemlerin yolu bilinmez.
- Açılış ve sonuç mesajlarında toplam kayıt/açık, TP, SL, BE, belirsiz ve toplam brüt R görünür. Gerçek komisyon, kayma ve net toplam **ölçülmedi/null** kalır. İşlem büyüklüğü/risk bütçesi verilmediği için dolar tutarı üretilmez.

## Teslim güvenliği

`reading_notifications.sqlite3` kalıcı outbox; sinyal/işlem kimliğine bağlı tekil mesaj anahtarları yeniden başlatmada çift gönderimi önler. `reading_shadow.sqlite3` ayrı kalıcı gölge defterdir. İşlem kapanışı ile mesaj kuyruğu arasındaki yeniden başlatmada eksik kuyruk kaydı geri oluşturulur.

Gönderim arka plan iş parçacığındadır; API beklemesi bant okuyucusunu durdurmaz. Teslim ancak HTTP 200 + JSON ok=true + message_id ile doğrulanır. Sonuç `reading_telegram_delivery.jsonl` dosyasına token/URL olmadan yazılır. Telegram 429 yanıtında belirtilen bekleme uygulanır. Kesin API reddi FAILED; zaman aşımı veya süreç gönderim sırasında kapanırsa UNKNOWN olur. UNKNOWN otomatik tekrar gönderilmez; API'nin idempotency anahtarı olmadığından çift mesaj riski gizlenmez. Bu durumlar servis durumunda hata olarak görünür.

## Doğrulama

Gerçek BEGONYA hedefine, açıkça **BİLDİRİM TESTİ — işlem sinyali değildir** yazan tek mesaj gönderildi. HTTP 200, ok=true ve message_id=499 ile doğrulandı. Sahte strateji işlemi üretilmedi. Ledger testleri yalnızca geçici test klasörlerinde çalıştı.

Kaynak: https://core.telegram.org/bots/api#sendmessage
# 9 Kasım 2026 yönetim güncellemesi

Yeni işlem politikası `TRADE_MANAGEMENT.md` içindedir: $100 varsayımsal risk, +1R %50 TP ve kalan stop girişe; en az +2R aktif likidite TP2. Açılış, kısmi TP1/BE ve son kapanış ayrı bildirilir. Model USD, gerçek broker kazancı değildir; komisyon/slipaj ve gerçek net ölçülmedi kalır. Aşağıdaki eski TP1 tam kapanış açıklamaları önceki politika içindir.

