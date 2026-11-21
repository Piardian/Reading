export interface PoiRiskContext {
  ageBars: number;
  testCount: number;
  approachAtrMultiple: number;
}

// Context warnings do not invalidate a hybrid box or replace the user's entry decision.
export function assessPoiRisk(context?: PoiRiskContext): string[] {
  if (!context || !Object.values(context).every(v => Number.isFinite(v) && v >= 0)) return [];
  const flags: string[] = [];
  if (context.ageBars > 24 && context.testCount >= 2) flags.push('AGED_RETESTED_POI');
  if (context.testCount >= 1 && context.approachAtrMultiple >= 2) flags.push('RETEST_WITH_FAST_APPROACH');
  if (context.ageBars > 72) flags.push('STALE_POI');
  return flags;
}
