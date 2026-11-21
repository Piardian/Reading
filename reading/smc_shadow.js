'use strict';
// No dotenv loader, no original runtime startup, no transport modules.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const runtime=path.join(__dirname,'runtime');
const dotenv=require(path.join(root,'smc_engine/node_modules/dotenv'));
const baselineEnv=dotenv.parse(fs.readFileSync(path.join(root,'smc_engine/.env')));
for(const [key,value] of Object.entries(baselineEnv)) {
  if(!/TOKEN|SECRET|PASSWORD|API.?KEY|CHAT|URL|PATH|DIRECTORY|DIR$|PORT/i.test(key)) process.env[key]=value;
}
fs.mkdirSync(runtime,{recursive:true});
process.chdir(runtime);
process.env.TELEMETRY_DIRECTORY=path.join(runtime,'telemetry');
process.env.DATA_DIR=path.join(runtime,'data');
process.env.READING_TAPE_SNAPSHOT=path.join(runtime,'tape_snapshot.json');
process.env.READING_TAPE_SHADOW='true';
// Runtime network ban, including accidentally imported notification/provider paths.
const blocked=()=>{throw new Error('READING_SHADOW_NETWORK_DISABLED');};
for(const name of ['http','https']) {
  const lib=require(name);lib.request=blocked;lib.get=blocked;
}
const net=require('net');net.connect=blocked;net.createConnection=blocked;
global.fetch=blocked;
const source=process.env.READING_BEGONYA_SOURCE;
if(!source) throw new Error('READING_BEGONYA_SOURCE missing');
const readingConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
const minimumGrade=readingConfig.minimum_smc_grade||'A';
if(!['A','B+'].includes(minimumGrade))throw new Error('Unsupported READİNG minimum SMC grade');
process.env.READING_MINIMUM_SMC_GRADE=minimumGrade;
const forexSymbols=readingConfig.forex_symbols||[];
const cryptoSymbols=Object.keys(readingConfig.crypto_symbols||{});
const {MacroGateAdapter}=require(path.join(root,'smc_engine/dist/server/macroGateAdapter'));
const {CandleStore}=require(path.join(root,'smc_engine/dist/server/candleStore'));
const {NotifiedStore}=require(path.join(root,'smc_engine/dist/server/notifiedStore'));
const {runPipeline}=require(path.join(root,'smc_engine/dist/server/pipeline'));
const input=path.join(runtime,'inputs');fs.mkdirSync(input,{recursive:true});
const candleStore=new CandleStore(input);
const notified=new NotifiedStore(path.join(runtime,'data'));
const output=path.join(runtime,'candidate_pairs.jsonl');
const seen=new Set();
if(fs.existsSync(output)) for(const line of fs.readFileSync(output,'utf8').split(/\r?\n/).filter(Boolean)) {
  const row=JSON.parse(line);seen.add(row.candidate_key);
}
const atomic=(file,data)=>{
  const content=JSON.stringify(data,null,2);
  const tmp=file+'.tmp';
  try {fs.writeFileSync(tmp,content);}catch(e){try{fs.writeFileSync(file,content);return;}catch(_){return;}}
  for(let attempt=0;attempt<25;attempt++) {
    try {fs.renameSync(tmp,file);return;}
    catch(e) {
      if(!['EPERM','EACCES','EBUSY'].includes(e.code) || attempt>=24) {
        try {fs.writeFileSync(file,content);try{fs.unlinkSync(tmp);}catch(_){};return;}
        catch(fallbackErr){return;}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30*(attempt+1));
    }
  }
};
function evaluateSymbol(symbol,isCrypto=false) {
  const now=Date.now();let inputHashes={};
  let entryCandidates=[];
  const status={updated_utc_ms:now,mode:'SMC_CANDIDATE_SHADOW',order_routing:false,telegram_enabled:false,
    minimum_smc_grade:minimumGrade,
    provider_calls_enabled:false,symbol:symbol,candidate_count:0,errors:[],input_hashes:inputHashes};
  try {
    for(const tf of ['4h','1h','15m']) {
      const name=`${symbol}_${tf}.json`;
      const sourceFile=path.join(runtime,isCrypto?'crypto_inputs':'mt5_inputs',name);
      if(!fs.existsSync(sourceFile)) {
        status.errors.push('MISSING_CANDLE_INPUT_'+tf);
        continue;
      }
      const bytes=fs.readFileSync(sourceFile);
      const candles=JSON.parse(bytes.toString('utf8'));
      if(!Array.isArray(candles)) throw new Error('Invalid candle input');
      fs.writeFileSync(path.join(input,name),bytes);
      inputHashes[name]=crypto.createHash('sha256').update(bytes).digest('hex');
      const last=candles[candles.length-1];
      const interval=tf==='4h'?14400000:tf==='1h'?3600000:tf==='15m'?900000:60000;
      if(!last || !Number.isFinite(last.timestamp) || last.timestamp>now || now-last.timestamp>interval*3) {
        status.errors.push('STALE_OR_FUTURE_CANDLES_'+tf);
      }
    }
    for(const name of ['macro_bias_gate.json','economic_events.json']) {
      const file=path.join(source,'shared',name);
      if(fs.existsSync(file)) {
        const bytes=fs.readFileSync(file);JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
        fs.writeFileSync(path.join(root,'shared',name),bytes);
        inputHashes['shared/'+name]=crypto.createHash('sha256').update(bytes).digest('hex');
      }
    }
    let macroBlocked=false;
    if(isCrypto) {
      status.data_market={market:'BINANCE_SPOT',venue_symbol:readingConfig.crypto_symbols[symbol],quote_asset:'USDT',strategy_alias:symbol};
    }
    {
      // Retained Forex/gold boxes need current macro revocation too, not only crypto.
      const adapter=MacroGateAdapter.getInstance();
      status.macro_preflight={};
      for(const direction of ['long','short']) {
        const m=adapter.evaluateCandidate(symbol,direction,0);
        status.macro_preflight[direction]={allowed:m.allowed,multiplier:m.macroGateMultiplier,
          isStale:m.isStale,message:m.gateStatusMessage,macroBias:m.macroBias,
          scope:'DIRECTIONAL_PREFLIGHT_TECHNICAL_SCORE_ZERO_NOT_AN_ENTRY_APPROVAL'};
      }
      macroBlocked=Object.values(status.macro_preflight).every(m=>m.multiplier!==1 || m.isStale===true);
    }
    if(status.errors.length) {
      status.state='DATA_NOT_READY';
    } else {
      // In 4-arm experiment: pipeline runs even if macro preflight is defensive, so Arms C & D can evaluate setups.
      // Macro evaluation per candidate is preserved inside candidate.macroEvaluation.
      // Arms A & B strictly enforce candidate.macroEvaluation, while Arms C & D evaluate macro-independent research.
      const candidates=runPipeline(symbol,candleStore,notified,now);
      entryCandidates=candidates.map(c=>isCrypto?{...c,readingMarket:status.data_market}:c);
      status.candidate_count=candidates.length;
      status.state=candidates.length?'CANDIDATES_OBSERVED':(macroBlocked?'MACRO_BLOCKED':'NO_SETUP');
      for(const c of candidates) {
        const key=c.signalId||c.uniqueKey;
        if(!key) throw new Error('Candidate without stable key');
        if(seen.has(key))continue;
        fs.appendFileSync(output,JSON.stringify({observed_utc_ms:Date.now(),candidate_key:key,
          scope:'SMC_MACRO_POI_CANDIDATE_NOT_EXECUTED_ORDER',symbol:c.symbol,direction:c.tradeDirection,
          control:{candidate:c,executed:false},treatment:{tape:c.readingTape,executed:false},
          input_hashes:inputHashes,net_pnl:null})+'\n');
        seen.add(key);
      }
    }
  } catch(e) {
    status.state='DATA_OR_PIPELINE_ERROR';status.errors.push(String(e.message||e));
  }
  return {status:status,context:{schema:1,observed_utc_ms:Date.now(),
    evaluation_started_utc_ms:now,state:status.state==='MACRO_BLOCKED'?'NO_SETUP':status.state,
    macro_preflight:status.macro_preflight,data_market:status.data_market,input_hashes:inputHashes,candidates:entryCandidates}};
}
function cycle() {
  const gold=evaluateSymbol('XAUUSD');
  atomic(path.join(runtime,'smc_status.json'),gold.status);
  atomic(path.join(runtime,'entry_candidates.json'),gold.context);
  const contexts={};const statuses={};
  for(const symbol of forexSymbols) {
    const result=evaluateSymbol(symbol);contexts[symbol]=result.context;statuses[symbol]=result.status;
  }
  atomic(path.join(runtime,'forex_candidates.json'),{schema:1,updated_utc_ms:Date.now(),symbols:contexts});
  atomic(path.join(runtime,'forex_smc_status.json'),{schema:1,updated_utc_ms:Date.now(),symbols:statuses});
  const cryptoContexts={},cryptoStatuses={};
  for(const symbol of cryptoSymbols){const result=evaluateSymbol(symbol,true);cryptoContexts[symbol]=result.context;cryptoStatuses[symbol]=result.status;}
  atomic(path.join(runtime,'crypto_candidates.json'),{schema:1,updated_utc_ms:Date.now(),symbols:cryptoContexts});
  atomic(path.join(runtime,'crypto_smc_status.json'),{schema:1,updated_utc_ms:Date.now(),symbols:cryptoStatuses});
}
try { cycle(); } catch(e) { console.error('READING_INITIAL_CYCLE_FAILED', e.code||e.message); }
if(!process.argv.includes('--once')) {
  const timer=setInterval(()=>{
    if(fs.existsSync(path.join(runtime,'STOP'))) {clearInterval(timer);process.exit(0);}
    try {cycle();} catch(e) {console.error('READING_CYCLE_WRITE_FAILED',e.code||e.message);}
  },15000);
}
