/** First strictly future slot; offset is relative to the candle boundary. */
export function nextAlignedPollAt(nowMs: number, offsetMs: number, intervalMs = 15 * 60_000): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(offsetMs) || !Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error('Invalid poll schedule inputs');
  const offset = ((offsetMs % intervalMs) + intervalMs) % intervalMs;
  return (Math.floor((nowMs - offset) / intervalMs) + 1) * intervalMs + offset;
}
