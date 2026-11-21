export function closedCandles<T extends { timestamp: number }>(candles: readonly T[], durationMs: number, asOfMs: number): T[] {
  if (!Number.isFinite(asOfMs) || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  return candles.filter(c => Number.isFinite(c.timestamp) && c.timestamp + durationMs <= asOfMs);
}
