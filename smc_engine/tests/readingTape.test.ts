import { assessReadingTape } from '../server/readingTape';

const now=100000;
const fixture={schema:1,source:'BINANCE_SPOT_PAXGUSDT_PROXY',generated_utc_ms:now-1,
  cutoff_received_utc_ms:now-1,paxg_features_usable:true,research_pressure:'BUY',reasons:['PROXY_TO_XAU_NOT_VALIDATED']};
test('aligned proxy remains unavailable for execution',()=>{
  const r=assessReadingTape('XAUUSD','long',now,fixture);
  expect(r.researchAlignment).toBe('ALIGNED');expect(r.treatmentAllowed).toBeNull();expect(r.controlChanged).toBe(false);
});
test('opposed pressure recorded without changing baseline',()=>{
  expect(assessReadingTape('XAUUSD','short',now,fixture).researchAlignment).toBe('OPPOSED');
});
test.each([null,{...fixture,generated_utc_ms:now+1},{...fixture,generated_utc_ms:now-10001},
  {...fixture,cutoff_received_utc_ms:now+1}])('missing stale and future snapshots are refused',snapshot=>{
  expect(assessReadingTape('XAUUSD','long',now,snapshot).state).toBe('DATA_UNAVAILABLE');
});
test('gold proxy is not borrowed for forex',()=>{
  expect(assessReadingTape('EURUSD','long',now,fixture).state).toBe('UNSUPPORTED_SYMBOL');
});
test('unusable feature window has no direction vote',()=>{
  expect(assessReadingTape('XAUUSD','long',now,{...fixture,paxg_features_usable:false}).researchAlignment).toBe('UNKNOWN');
});
