// Deterministic calendar-week cluster bootstrap. Trades in the same week are resampled
// together, including cross-symbol positions. This is exploratory inference, not a holdout approval.
export function weeklyBootstrap(rows: readonly { signalTimestamp: number; value: number }[]): {
  lower: number | null; upper: number | null; pValue: number | null; weeks: number;
} {
  const buckets = new Map<number, number[]>();
  const weekMs = 7 * 86400000;
  for (const r of rows) {
    if (!Number.isFinite(r.signalTimestamp) || r.signalTimestamp <= 0 || !Number.isFinite(r.value)) continue;
    const week = Math.floor((r.signalTimestamp - 4 * 86400000) / weekMs); // Monday UTC
    buckets.set(week, [...(buckets.get(week) ?? []), r.value]);
  }
  const groups = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (groups.length < 2) return { lower: null, upper: null, pValue: null, weeks: groups.length };
  const values = groups.flat();
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let seed = 724531;
  const samples: number[] = [];
  let nullExceedances = 0;
  for (let i = 0; i < 2000; i++) {
    let sum = 0, count = 0;
    for (let j = 0; j < groups.length; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const selected = groups[Math.floor((seed / 4294967296) * groups.length)];
      sum += selected.reduce((s, v) => s + v, 0);
      count += selected.length;
    }
    const sampled = sum / count;
    samples.push(sampled);
    // Bootstrap under H0 mean=0, centered at the original mean.
    if (sampled - mean >= mean) nullExceedances++;
  }
  samples.sort((a, b) => a - b);
  return {
    lower: samples[49], upper: samples[1949],
    pValue: (nullExceedances + 1) / 2001, weeks: groups.length,
  };
}

export function holmAdjusted(values: readonly (number | null)[]): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  const ordered = values.map((p, i) => ({ p, i })).filter((v): v is { p: number; i: number } => v.p !== null)
    .sort((a, b) => a.p - b.p);
  let previous = 0;
  ordered.forEach(({ p, i }, rank) => {
    previous = Math.max(previous, Math.min(1, p * (ordered.length - rank)));
    result[i] = previous;
  });
  return result;
}
