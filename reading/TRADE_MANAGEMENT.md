# READİNG gölge yönetimi — $100 risk, yarım TP1 ve BE

Yeni önerilerde başlangıç riski **100 USD varsayımsal** kabul edilir. Bu, broker lotu/kontrat adedi hesabı veya gerçek parasal dolum değildir; ilk fiyat riski 1R olarak normalize edilir, model USD = R × 100 hesaplanır. Gerçek emir gönderimi kapalıdır.

Makro → en az B+ SMC/kutu → READING onayı sonrasında gerçek gözlenen giriş referansı ile ilk stop arasındaki mesafe kullanılır. +1R'de %50 kapanış ve kalan %50 stopunun girişe taşınması uygulanır. İkinci hedef, SMC planındaki aktif ve doğru yöndeki EQH/EQL likidite havuzudur. `targetConstraint=LIQUIDITY`, `resolvedLiquidityMagnet.isActive=true` ve plan TP2 fiyatı ile havuz fiyatının aynı olması gerekir. Havuz yoksa, alınmışsa, hedef sentetik/engel tarafından belirlenmişse veya kırpılmış model hedefiyse işlem reddedilir. Daha uzaktaki bir havuz seçilerek oran kurtarılmaz.

TP2 mesafesi / gerçek giriş–ilk stop mesafesi **en az 2** olmalıdır. Bu şart giriş önerisinde ve gölge deftere kayıt sırasında tekrar denetlenir. İlk stop değiştirilerek oran yapay artırılmaz. Mevcut makro, kalite, tazelik, giriş aralığı ve READING teyitleri ayrıca geçerlidir. Kontrol kolu ve orijinal BEGONYA değiştirilmez.

Model örnekleri: tam ilk SL'de -1R = -$100; +1R'de yarı kapanıştan sonra kalan girişte kapanırsa toplam +0.5R = +$50; kalan +2R havuzuna ulaşırsa toplam +1.5R = +$150. Minimum 2R, ikinci hedefin mesafesidir; iki kapanışın ağırlıklı toplamı minimum 2R anlamına gelmez. İlk çıkış kârı ve açık kalan risk raporda ayrı tutulur. BE sayacı kalan pozisyonun giriş stopunu ifade eder, toplam işlemin sıfır kazançta kapandığı anlamına gelmez.

Çıkışlar gözlenen Bid (long) veya Ask (short) ile hesaplanır. Hedefi atlayan ilk taze kotasyonda teorik tam hedef dolumu uydurulmaz; parçalar o gözlenen referans fiyatıyla kaydedilir. Stop aşımı kaybı $100'ü aşabilir. Veri boşluğu varsa kalan kısım UNRESOLVED olur; bilinen kısmi kâr korunur, bilinmeyen kalan sıfır kâr sayılmaz. Spread kotasyonlarda yer alır; komisyon, slipaj ve gerçek net bilinmiyor kalır.

Politika her yeni işlemde dondurulur. Önceki öneriler yeni politikayla geriye dönük kaydedilmez, eski açık işlemler kendi kurallarıyla devam eder. TP1/BE değişikliği SQLite'a yazılır ve yeniden başlatmada korunur. Telegram açılış, TP1+BE ve son kapanış için farklı sabit kimlikler kullanır; sahte üretim sinyali gönderilmez. Henüz işlem oluşması veya kârlılık kanıtı yoktur.
