import express from 'express';
import { randomBytes } from 'crypto';
import { SetupPlanRegistry } from './setupPlanRegistry';
import { ManualExecutionJournal } from './manualExecutionJournal';

export function createManagementApi(setups: SetupPlanRegistry, journal: ManualExecutionJournal) {
  const app = express(), token = randomBytes(32).toString('hex');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'Local journal only' }); return;
    }
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || req.headers['x-journal-token'] !== token) {
        res.status(403).json({ error: 'Invalid local journal request' }); return;
      }
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: 'v1.3', mode: 'SHADOW_AND_MANUAL_JOURNAL', orderRouting: false }));
  app.get('/api/setups', (_req, res) => res.json(setups.list()));
  app.get('/api/manual', (_req, res) => res.json(journal.list()));
  app.post('/api/preview', (req, res) => { try { res.json(journal.preview(req.body)); } catch (e) { res.status(400).json({ error: String(e) }); } });
  app.post('/api/manual/entry', (req, res) => { try { res.json(journal.entry(req.body)); } catch (e) { res.status(400).json({ error: String(e) }); } });
  app.post('/api/manual/exit', (req, res) => { try { res.json(journal.exit(req.body)); } catch (e) { res.status(400).json({ error: String(e) }); } });
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="tr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Begonya · İşlem günlüğü</title>
<style>body{background:#111724;color:#e7edf9;font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 20px}section{background:#1c2638;padding:20px;border-radius:12px;margin:20px 0}label{display:block;margin:10px 0}input,select,button{font:inherit;padding:9px;background:#10192b;color:inherit;border:1px solid #526482;border-radius:6px;max-width:100%}input{width:240px}select{width:100%}button{cursor:pointer;background:#22457d}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}small{color:#b8c9e8}.grid{display:flex;flex-wrap:wrap;gap:16px}</style>
<h1>Begonya · İşlem günlüğü</h1><p>v1.3 · M1 giriş kararı sizde. Bu ekran yalnızca hesaplar ve bildirdiğiniz dolumları kaydeder; emir göndermez.</p>
<section><h2>Kurulum ve gerçek giriş</h2><label>Kurulum <select id="node"></select></label><div class="grid">
<label>Gerçek giriş fiyatı<br><input id="price" type="number" step="any"></label>
<label>Gerçek dolum zamanı<br><input id="time" type="datetime-local" step="1"></label>
<label>Gerçek miktar (lot / adet)<br><input id="quantity" type="number" step="any"></label>
<label>Gerçek ilk stop (boşsa plan)<br><input id="stop" type="number" step="any"></label>
<label>Hesap risk bütçesi (isteğe bağlı)<br><input id="risk" type="number" step="any"></label>
<label>1 fiyat birimi × 1 miktar için hesap para değeri<br><input id="conversion" type="number" step="any"></label></div>
<small>Para dönüşümünü bilmiyorsanız boş bırakın; nakit sonuç hesaplanmaz. Dönüşüm, pip değeri değil tam fiyat birimi başına değerdir.</small>
<p><button id="preview">Planı hesapla</button> <button id="entry">Gerçekleşen girişi kaydet</button></p><pre id="plan"></pre></section>
<section><h2>Kısmi / tam gerçekleşen çıkış</h2><label>Pozisyon <select id="position"></select></label><div class="grid">
<label>Çıkış fiyatı<br><input id="exitPrice" type="number" step="any"></label>
<label>Çıkış miktarı (ilk miktarın bir kısmı veya tamamı)<br><input id="exitQty" type="number" step="any"></label>
<label>Çıkış zamanı<br><input id="exitTime" type="datetime-local" step="1"></label>
<label>Bu kısım için toplam giriş+çıkış maliyeti (boşsa tahmin)<br><input id="cost" type="number" step="any"></label></div>
<button id="exit">Gerçekleşen çıkışı kaydet</button><pre id="result"></pre></section>
<section><h2>Kaydedilmiş manuel işlemler</h2><small>managementAdvice kapalı M15'e dayanan öneridir. Stopun brokerda taşındığı veya önerilen fiyattan çıkıldığı varsayılmaz.</small><pre id="positions"></pre></section>
<script>const token='${token}',q=id=>document.getElementById(id);let nodes=[],positions=[];
function fields(){const p={nodeId:q('node').value,fillPrice:Number(q('price').value)};if(q('risk').value)p.riskCash=Number(q('risk').value);if(q('conversion').value)p.cashPerPriceUnitPerQuantity=Number(q('conversion').value);if(q('stop').value)p.actualStopLoss=Number(q('stop').value);return p;}
function fillTime(id){const time=new Date(q(id).value);if(!q(id).value||!Number.isFinite(time.getTime()))throw new Error('Gerçek dolum zamanı gerekli.');return time.toISOString();}
async function post(url,body,out){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-journal-token':token},body:JSON.stringify(body)});const v=await r.json();q(out).textContent=JSON.stringify(v,null,2);if(r.ok)await refresh();return r.ok;}
async function submit(id,url,build,out,clear=[]){const button=q(id);button.disabled=true;try{const body=build();let key;if(id!=='preview'){key='begonya-v13-pending-'+id;const signature=JSON.stringify(body),saved=JSON.parse(sessionStorage.getItem(key)||'null');const eventId=saved&&saved.signature===signature?saved.eventId:crypto.randomUUID();sessionStorage.setItem(key,JSON.stringify({signature,eventId}));body.eventId=eventId;}if(await post(url,body,out)){if(key)sessionStorage.removeItem(key);for(const field of clear)q(field).value='';}}catch(e){q(out).textContent=String(e);}finally{button.disabled=false;}}
function options(id,items){const select=q(id),old=select.value;select.replaceChildren();for(const [value,label] of items){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}if(items.some(i=>i[0]===old))select.value=old;}
async function refresh(){nodes=await(await fetch('/api/setups')).json();positions=await(await fetch('/api/manual')).json();options('node',nodes.map(n=>[n.nodeId,n.symbol+' '+n.direction+' | '+n.phase+' | '+n.zoneLow+' - '+n.zoneHigh]));options('position',positions.filter(p=>!p.state.closed).map(p=>[p.id,p.symbol+' | kalan %'+(100*p.result.remainingFraction).toFixed(1)+' | '+p.id]));q('positions').textContent=JSON.stringify(positions,null,2);}
q('preview').onclick=()=>submit('preview','/api/preview',fields,'plan');
q('entry').onclick=()=>submit('entry','/api/manual/entry',()=>({...fields(),fillTimestamp:fillTime('time'),quantity:Number(q('quantity').value)}),'plan',['quantity','time']);
q('exit').onclick=()=>submit('exit','/api/manual/exit',()=>{const p={positionId:q('position').value,fillPrice:Number(q('exitPrice').value),fillTimestamp:fillTime('exitTime'),quantity:Number(q('exitQty').value)};if(q('cost').value)p.costCash=Number(q('cost').value);return p;},'result',['exitQty','exitTime','cost']);
refresh().catch(e=>q('plan').textContent=String(e));setInterval(()=>refresh().catch(e=>q('plan').textContent=String(e)),60000);</script></html>`));
  return app;
}
