# Otomatik READING — önceden belirlenmiş araştırma kuralları

Akış: **Makro onayı → SMC onayı ve kutu → spot kotasyonun kutuya teması → otomatik bant/fiyat değerlendirmesi.** İnsan bandı okuyup onaylamak zorunda değildir. Bu sürüm emir açmaz; araştırma önerisi kaydeder.

## Minimum SMC notu

READİNG için `config.json` içindeki `minimum_smc_grade` değeri **B+** olarak ayarlandı. V1 not filtresi B+, A ve A+ adaylarını değerlendirmeye alır; B ve C elenir. V2 değerlendirmesindeki mevcut A- kabulü korunur. Not tek başına giriş onayı değildir: zorunlu kalite kontrolleri, V2 retleri, makro vetoları, veri geçerliliği, risk/ödül ve temas sonrası READING şartları geçerlidir. Bu ayar yalnızca READİNG gölge sürecinde etkinleşir; orijinal BEGONYA değiştirilmez. Eşiğin indirilmesi kârlılık kanıtı değildir.

## Motorun taradığı örüntüler

### Hız ve miktar artışı

Son 5 saniyedeki gerçekleşmiş işlem olaylarının sıklığı, önceki 30 saniyeye kıyaslanır. Önceki dönemde en az 20, son dönemde en az 10 olay; en az 3 kat olay hızı ve 2 kat hacim hızı gerekir. Kotasyon değişimi işlem sayılmaz. Tam başlangıç kapsaması ve geçerli kaynak gerekir.

### Absorption adayı

Yukarıdaki yoğunluk sırasında, bilinen yönlü hacmin en az %75'i tek agresif yönde olmalı ve işlem fiyatlarının aralığı ilk işlem fiyatının en fazla 1 baz puanı olmalıdır. Hacmin en az %80'inde yön bilinmelidir. Örneğin agresif satış + dar fiyat aralığı pasif alış/emilim **adayıdır**. Karşı tarafın kimliği, gizli emri veya gerçek niyeti bilinmez. Bu nedenle absorption_confirmed=false kalır.

USDJPY/USDCAD/USDCHF vekillerinde yön ters çevrilir. Eşikler bu prototip için önceden belirlenmiş araştırma ayarlarıdır; enstrümanlar arasında geçerlilikleri ve kârlılıkları kanıtlanmadı.

### Hızlı likidite çekilmesi / spoofing şüphesi

Yalnızca doğrulanmış, fiyat seviyesinde birleştirilmiş ve kesintisiz görünen seviyeleri kapsayan L2 anlık görüntüleri kullanılabilir. Kimliği/semantiği belirsiz delta kayıtlarından defter uydurulmaz.

En az 30 saniye ve 20 derinlik büyüklüğü gözleminden sonra, daha önce görülen iç fiyat seviyesinde tipik büyüklüğün en az 3 katına ve en az 20 kontrata çıkan duvar izlenir. En çok 3 saniyede en az %80 küçülür ve o fiyattaki gözlenen işlem hacmi duvarın %20'sini aşmazsa hızlı çekilme adayı kaydedilir. Görüntünün sınırından kaybolan kademe, ilk kez görülen büyük duvar veya işlemlerle açıklanan küçülme aday değildir.

Bu, **spoofing niyetinin kanıtı değildir**. Meşru emir iptali, yeniden fiyatlama ve başka nedenler mümkündür. Tekil emir kimliği/MBO da bu sürümde doğrulanmamıştır.

**Mevcut bağlantı Level 1 modunda.** Derinlik yoksa UNAVAILABLE_NO_LEVEL2; ham L2 var ama anlamı doğrulanmadıysa UNAVAILABLE_DEPTH_SEMANTICS_UNVERIFIED gösterilir. Mevcut Quantower dışa aktarımı doğrulanmış derinlik bayrağı vermediğinden bu tespit canlı teyit olarak kullanılamaz. Bir veri satın alımı veya izin değişikliği yapılmadı.

## Yeni otomatik giriş araştırması

1. Makro ve SMC onayını al; mevcut stop ve hedefleri koru.
2. Gerçek spot Bid/Ask kutuya temas etsin. Temastan önceki bir absorption adayı kullanılamaz.
3. Temas sonrası oluşmuş, hız artışı şartlarını da taşıyan absorption adayı işlem yönünü desteklesin. Aday en fazla 10 saniye geçerli.
4. Son 2 saniyede en az 3 işlem, en az %80 yönü bilinen hacim ve en az ±0,30 dengesizlikle agresif akış işlem yönüne dönsün.
5. Spot fiyatın en az 3 temas sonrası kotasyonda verdiği dönüş tepkisi, kutu genişliğinin %10'u ile güncel spread'in 2 katından büyük olanını aşsın. Varsa orijinal entryRange'e uyulsun; stop/target yönünde risk ve ödül pozitif olsun.
6. Doğrulanmış derinlikte temas sonrası taze hızlı likidite çekilme şüphesi varsa bekle. L2 yokluğu gizlenmez; bu sürümün L1 giriş hipotezi kesin spoofing kontrolü sağlamaz.
7. Şartlar tamamsa RESEARCH_ENTRY_PROPOSAL kaydet: actionable=false, executed=false. 90 saniyede cevap yoksa temas fırsatı sona erer.

Eski fiyat tepkisi + 60 saniyelik baskı kuralı ayrı kontrol olarak aynı veriyle izlenir. Yeni mekanizma son 2 saniyelik akış dönüşünü kullanır; eski kuralın 60 saniyelik baskısına zorlanmaz. Bu iki kuralın üstünlüğü henüz ölçülmedi.

## İzleme ve kapsam

- `reading/runtime/forex/<parite>`: eski kontrol.
- `reading/runtime/forex_patterns/<parite>`: yeni otomatik READING araştırması.
- `reading/runtime/gold_patterns`: GC verisiyle XAUUSD için yeni araştırma; eski PAXG kontrolü korunur.
- `reading/runtime/forex_status.json`: yeni entry ve control_entry ayrı görünür.
- `reading/runtime/forex_pattern_features_YYYY-MM-DD.jsonl`: 5 saniyelik özellik gözlemleri. Adaylar ve kararlar ayrıca ilgili entry_events.jsonl dosyalarındadır.

14 çapraz parite kendi doğrudan bandı bağlı olmadığı için onay üretmez. Ana döviz vekilleri ve GC için veri kalitesi/saat/baz koşulları doğrulanmalıdır. FeedLabel şu an UNVERIFIED olduğundan gerçek giriş teyidi engellidir. Hafta sonu geçmiş kotasyonları canlı işlem sayılmaz. Yalnızca yerel alınış anında bilinen olaylar kullanılır; kesinti/kontrat değişiminde yeniden ısınma gerekir.

Kaynak protokol `reading_patterns.PROTOCOL`, başlangıç manifestinde hash ve ayarlarıyla kaydedilir. Gerçek dolumlar, komisyon/kayma ve net PnL ölçülmedi; edge kanıtlanmadı.
