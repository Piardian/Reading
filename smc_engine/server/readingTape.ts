import * as fs from 'fs';

export interface ReadingTapeAssessment {
  mode: 'SHADOW_ONLY';
  source: 'BINANCE_SPOT_PAXGUSDT_PROXY';
  state: 'UNSUPPORTED_SYMBOL' | 'DATA_UNAVAILABLE' | 'PROXY_UNVALIDATED';
  researchAlignment: 'ALIGNED' | 'OPPOSED' | 'NEUTRAL' | 'UNKNOWN';
  treatmentAllowed: null;
  controlChanged: false;
  edgeProven: false;
  reasons: string[];
  snapshotCutoffMs?: number;
}

export function assessReadingTape(
  symbol: string, direction: 'long' | 'short', asOfMs: number, snapshot: any
): ReadingTapeAssessment {
  const base: ReadingTapeAssessment = { mode:'SHADOW_ONLY',source:'BINANCE_SPOT_PAXGUSDT_PROXY',
    state:'DATA_UNAVAILABLE',researchAlignment:'UNKNOWN',treatmentAllowed:null,
    controlChanged:false,edgeProven:false,reasons:[] };
  if(symbol!=='XAUUSD') return {...base,state:'UNSUPPORTED_SYMBOL',reasons:['NO_VALIDATED_TAPE_FOR_SYMBOL']};
  if(!snapshot || snapshot.schema!==1 || snapshot.source!=='BINANCE_SPOT_PAXGUSDT_PROXY'
    || !Number.isFinite(snapshot.generated_utc_ms) || !Number.isFinite(snapshot.cutoff_received_utc_ms)
    || snapshot.cutoff_received_utc_ms>snapshot.generated_utc_ms
    || snapshot.generated_utc_ms>asOfMs || asOfMs-snapshot.generated_utc_ms>10_000) {
    return {...base,reasons:['MISSING_STALE_FUTURE_OR_INVALID_TAPE_SNAPSHOT']};
  }
  let researchAlignment: ReadingTapeAssessment['researchAlignment']='UNKNOWN';
  if(snapshot.paxg_features_usable===true) {
    const pressure=snapshot.research_pressure;
    if(pressure==='NEUTRAL') researchAlignment='NEUTRAL';
    if(pressure==='BUY'||pressure==='SELL') researchAlignment=
      (direction==='long'&&pressure==='BUY')||(direction==='short'&&pressure==='SELL')?'ALIGNED':'OPPOSED';
  }
  // No configuration flag can promote this unvalidated proxy into an execution permission.
  return {...base,state:'PROXY_UNVALIDATED',researchAlignment,
    reasons:Array.isArray(snapshot.reasons)?snapshot.reasons:['PROXY_TO_XAU_NOT_VALIDATED'],
    snapshotCutoffMs:snapshot.cutoff_received_utc_ms};
}

export function readReadingTape(symbol: string, direction: 'long'|'short', asOfMs: number): ReadingTapeAssessment {
  try {
    const file=process.env.READING_TAPE_SNAPSHOT;
    return assessReadingTape(symbol,direction,asOfMs,file?JSON.parse(fs.readFileSync(file,'utf8')):null);
  } catch {
    return assessReadingTape(symbol,direction,asOfMs,null);
  }
}
