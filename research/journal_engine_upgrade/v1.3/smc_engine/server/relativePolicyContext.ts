export interface RelativePolicyContext {
  status: 'ALIGNED' | 'CONFLICT' | 'NEUTRAL' | 'UNAVAILABLE';
  relativeRepriceBps: number | null;
  horizon: string | null;
  riskMultiplier: number;
}

export function evaluateRelativePolicyContext(panel: any, symbol: string, direction: 'long' | 'short', nowMs: number): RelativePolicyContext {
  const unavailable: RelativePolicyContext = { status: 'UNAVAILABLE', relativeRepriceBps: null, horizon: null, riskMultiplier: 1 };
  if (!/^(EUR|USD|GBP|JPY|CHF|CAD|AUD|NZD){2}$/.test(symbol)) return unavailable;
  const timestamp = Date.parse(panel?.as_of_utc ?? '');
  const row = panel?.pairs?.[symbol];
  if (panel?.status !== 'AVAILABLE' || !Number.isFinite(timestamp) || timestamp > nowMs || nowMs - timestamp > 36 * 3600000 ||
      row?.status !== 'AVAILABLE' || !Number.isFinite(row.relative_reprice_bps) || !row.horizon ||
      !Array.isArray(row.sources) || row.sources.length !== 2 || row.sources.some((s: unknown) => typeof s !== 'string' || !s)) return unavailable;
  const change = row.relative_reprice_bps;
  const status = Math.abs(change) < 3 ? 'NEUTRAL' : (change > 0) === (direction === 'long') ? 'ALIGNED' : 'CONFLICT';
  return { status, relativeRepriceBps: change, horizon: row.horizon, riskMultiplier: status === 'CONFLICT' ? 0.75 : 1 };
}
