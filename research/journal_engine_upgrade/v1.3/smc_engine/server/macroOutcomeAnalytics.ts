import { MacroOutcomeEvidenceRecord } from './macroOutcomeEvidence';
import { weeklyBootstrap, holmAdjusted } from './outcomeStatistics';

export interface GroupPerformanceMetrics {
  readonly groupKey: string;
  readonly candidateCount: number;
  readonly filledTradesCount: number;
  readonly fillRatePct: number;
  readonly expiredCount: number;
  readonly cancelledCount: number;

  // Realized execution metrics (computed strictly on confirmed filled trades)
  readonly totalTrades: number; // Alias for filledTradesCount for backward compatibility
  readonly tpCount: number;
  readonly slCount: number;
  readonly beCount: number;
  readonly winRatePct: number;
  readonly winRateExcludingBePct: number;
  readonly stopOutRatePct: number;
  readonly totalRealizedR: number;
  readonly expectancyR: number;
  readonly totalNetRealizedR: number;
  readonly netExpectancyR: number;
  readonly avgCostR: number;
  readonly avgMfeR: number;
  readonly avgMaeR: number;
  readonly avgHoldingTimeHours: number;

  // Statistical Rigor & Uncertainty Bounds (95% Confidence Intervals)
  readonly winRateLower95: number | null;
  readonly winRateUpper95: number | null;
  readonly netExpectancyLower95: number | null;
  readonly netExpectancyUpper95: number | null;
  readonly sampleAdequacy: 'INSUFFICIENT' | 'LOW' | 'ADEQUATE' | 'ROBUST';
  readonly pValueWinRate: number | null;
  readonly pValueExpectancy: number | null;

  readonly resolvedTradesCount: number;
  readonly unresolvedFilledCount: number;
  readonly netMeasuredCount: number;
  readonly independentWeeks: number;
  readonly inferenceMethod: 'WEEK_CLUSTER_BOOTSTRAP';
  readonly exploratory: true;
  readonly adjustedPValueExpectancy?: number | null;
  // Descriptive attribution; causal claims require a separately frozen holdout.
  readonly avoidedLossR?: number;
}

export interface MacroOutcomeReportSummary {
  readonly overall: GroupPerformanceMetrics;
  readonly byMacroContribution: readonly GroupPerformanceMetrics[];
  readonly byAssetClass: readonly GroupPerformanceMetrics[];
  readonly byForecastHorizon: readonly GroupPerformanceMetrics[];
  readonly byExecutionSource: readonly GroupPerformanceMetrics[];
  readonly byRegime: readonly GroupPerformanceMetrics[];
  readonly byVixBucket: readonly GroupPerformanceMetrics[];
  readonly byScoreTier: readonly GroupPerformanceMetrics[];
  readonly byNewsProximity: readonly GroupPerformanceMetrics[];
  readonly byDerivativesRegime: readonly GroupPerformanceMetrics[];
  readonly byCryptoSector: readonly GroupPerformanceMetrics[];
  readonly bySymbolDirection: readonly GroupPerformanceMetrics[];
  readonly byCryptoFactors?: readonly GroupPerformanceMetrics[];
}

export interface AnalyticsFilterOptions {
  readonly allowSources?: readonly ('TEST' | 'PAPER' | 'LIVE')[];
  readonly requireEntryConfirmed?: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, digits = 2): number => Number(v.toFixed(digits));

export function computeGroupMetrics(
  groupKey: string,
  records: readonly MacroOutcomeEvidenceRecord[]
): GroupPerformanceMetrics {
  const filled = records.filter(r => r.entryConfirmed === true);
  // Unknown and timed-out positions remain censored, even if legacy rows contain placeholder zeros.
  const resolved = filled.filter(r => ['TP', 'SL', 'BE'].includes(r.outcome) && finite(r.realizedR));
  const netMeasured = resolved.filter(r => finite(r.netRealizedR) && finite(r.totalCostR) &&
    r.costModel !== 'UNKNOWN' && !r.dataQualityIssues?.includes('INCONSISTENT_GROSS_NET_COST'));
  const tpCount = resolved.filter(r => r.outcome === 'TP').length;
  const slCount = resolved.filter(r => r.outcome === 'SL').length;
  const beCount = resolved.filter(r => r.outcome === 'BE').length;
  const totalRealizedR = resolved.reduce((s, r) => s + r.realizedR!, 0);
  const totalNetRealizedR = netMeasured.reduce((s, r) => s + r.netRealizedR!, 0);
  const netStats = weeklyBootstrap(netMeasured.map(r => ({ signalTimestamp: r.signalTimestamp, value: r.netRealizedR! })));
  const winStats = weeklyBootstrap(resolved.map(r => ({ signalTimestamp: r.signalTimestamp, value: r.outcome === 'TP' ? 1 : 0 })));
  const winNull = weeklyBootstrap(resolved.map(r => ({ signalTimestamp: r.signalTimestamp, value: (r.outcome === 'TP' ? 1 : 0) - 0.5 })));
  const avg = (values: number[]): number => values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const n = netMeasured.length, weeks = netStats.weeks;
  // These labels describe coverage only; they never certify positive edge.
  const sampleAdequacy = n < 10 || weeks < 4 ? 'INSUFFICIENT'
    : n < 50 || weeks < 12 ? 'LOW' : n < 200 || weeks < 40 ? 'ADEQUATE' : 'ROBUST';
  return {
    groupKey,
    candidateCount: records.length,
    filledTradesCount: filled.length,
    fillRatePct: records.length ? round(filled.length / records.length * 100, 1) : 0,
    expiredCount: records.filter(r => r.outcome === 'EXPIRED').length,
    cancelledCount: records.filter(r => r.outcome === 'CANCELLED').length,
    totalTrades: filled.length,
    resolvedTradesCount: resolved.length,
    unresolvedFilledCount: filled.length - resolved.length,
    netMeasuredCount: n,
    tpCount, slCount, beCount,
    winRatePct: resolved.length ? round(tpCount / resolved.length * 100, 1) : 0,
    winRateExcludingBePct: tpCount + slCount ? round(tpCount / (tpCount + slCount) * 100, 1) : 0,
    stopOutRatePct: resolved.length ? round(slCount / resolved.length * 100, 1) : 0,
    totalRealizedR: round(totalRealizedR),
    expectancyR: resolved.length ? round(totalRealizedR / resolved.length) : 0,
    totalNetRealizedR: round(totalNetRealizedR),
    netExpectancyR: n ? round(totalNetRealizedR / n) : 0,
    avgCostR: round(avg(netMeasured.map(r => r.totalCostR)), 3),
    avgMfeR: round(avg(resolved.map(r => r.maximumFavorableExcursion).filter(finite))),
    avgMaeR: round(avg(resolved.map(r => r.maximumAdverseExcursion).filter(finite))),
    avgHoldingTimeHours: round(avg(resolved.map(r => r.holdingTimeMs).filter(finite).map(v => v / 3600000)), 1),
    winRateLower95: winStats.lower === null ? null : round(winStats.lower * 100, 1),
    winRateUpper95: winStats.upper === null ? null : round(winStats.upper * 100, 1),
    netExpectancyLower95: netStats.lower === null ? null : round(netStats.lower),
    netExpectancyUpper95: netStats.upper === null ? null : round(netStats.upper),
    sampleAdequacy,
    pValueWinRate: weeks >= 12 ? winNull.pValue : null,
    pValueExpectancy: weeks >= 12 && n >= 50 ? netStats.pValue : null,
    independentWeeks: weeks,
    inferenceMethod: 'WEEK_CLUSTER_BOOTSTRAP', exploratory: true,
  };
}

export function generateMacroOutcomeAnalytics(
  records: readonly MacroOutcomeEvidenceRecord[],
  options?: AnalyticsFilterOptions
): MacroOutcomeReportSummary {
  const allowedSources = options?.allowSources ?? ['PAPER', 'LIVE'];

  // Strict filtering: Exclude test fixtures, legacy unverified records, and demo signals
  const validRecords = records.filter(r => {
    if (typeof r.signalId !== 'string' || !r.signalId) return false;
    if (r.executionSource === 'UNVERIFIED' || !r.executionSource) return false;
    if (!allowedSources.includes(r.executionSource)) return false;
    if (r.signalId.startsWith('test_') || r.signalId.includes('demo')) return false;
    if (options?.requireEntryConfirmed && !r.entryConfirmed) return false;
    return true;
  });

  // Zero-fallback guarantee: If no valid records exist, return clean empty metrics (never fall back to dirty records)
  const effectiveRecords = validRecords;

  const overall = computeGroupMetrics('TOTAL', effectiveRecords);

  // A. Causal Macro Ablation (All SMC Candidates vs Macro Approved vs Macro Blocked)
  const macroMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  macroMap.set('ALL_SMC_BASELINE (Tüm SMC Sinyal Adayları)', []);
  macroMap.set('MACRO_APPROVED (Makro Onaylı SMC)', []);
  macroMap.set('MACRO_BLOCKED (Makro Tarafından Engellenen / Shadow)', []);
  macroMap.set('DIRECTION_ALIGNED_SMC (Makro Yönüyle Uyumlu SMC)', []);

  for (const r of effectiveRecords) {
    // Legacy records lack policy parity and cannot support macro ablation.
    if (r.measurementVersion !== 3 || !r.executionPolicyId || r.executionSource !== 'PAPER') continue;
    const policyKey = `POLICY:${r.executionPolicyId} | `;
    const add = (label: string) => {
      const key = label + " | " + policyKey;
      if (!macroMap.has(key)) macroMap.set(key, []);
      macroMap.get(key)!.push(r);
    };
    add('ALL_SMC_BASELINE');

    const cohort = r.macroGatingCohort ?? (r.macroSnapshot?.macroAction === 'PROCEED' ? 'MACRO_APPROVED' : 'MACRO_BLOCKED');
    if (cohort === 'MACRO_APPROVED' || (cohort as string) === 'MACRO_PLUS_SMC') {
      add('MACRO_APPROVED');
    } else if (cohort === 'MACRO_BLOCKED') {
      add('MACRO_BLOCKED');
    }

    const dir = r.direction;
    const mb = r.macroSnapshot?.macroBias;
    if ((dir === 'long' && (mb === 'LONG_ONLY' || mb === 'Bullish')) ||
        (dir === 'short' && (mb === 'SHORT_ONLY' || mb === 'Bearish'))) {
      add('DIRECTION_ALIGNED_SMC');
    }
  }

  const byMacroContribution = Array.from(macroMap.entries())
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => computeGroupMetrics(k, list));

  // B. By Asset Class (FOREX vs. CRYPTO - Never blended!)
  const assetMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const rawClass = r.assetClass || (r.macroSnapshot?.isCrypto ? 'CRYPTO' : 'FOREX');
    const label = rawClass.startsWith('FOREX') ? 'FOREX (Döviz Çiftleri)'
      : rawClass === 'CRYPTO' ? 'CRYPTO (Kripto Varlıklar)'
      : rawClass === 'COMMODITY' ? 'COMMODITY (Emtia / Altın)'
      : rawClass === 'INDEX' ? 'INDEX (Hisse Endeksleri)'
      : rawClass;
    if (!assetMap.has(label)) assetMap.set(label, []);
    assetMap.get(label)!.push(r);
  }
  const byAssetClass = Array.from(assetMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // C. By Ex-Ante Forecast Horizon (Intended duration determined at setup, NOT ex-post holding time)
  const horizonMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  horizonMap.set('SCALP_INTRADAY (< 4 Saat)', []);
  horizonMap.set('SWING_4H_24H (4 - 24 Saat)', []);
  horizonMap.set('MULTI_DAY (> 24 Saat)', []);
  horizonMap.set('UNKNOWN (Plan Kaydı Yok)', []);

  for (const r of effectiveRecords) {
    const horizon = r.exAnteForecastHorizon ?? 'UNKNOWN';
    if (horizon === 'SCALP_INTRADAY') horizonMap.get('SCALP_INTRADAY (< 4 Saat)')!.push(r);
    else if (horizon === 'SWING_4H_24H') horizonMap.get('SWING_4H_24H (4 - 24 Saat)')!.push(r);
    else if (horizon === 'MULTI_DAY') horizonMap.get('MULTI_DAY (> 24 Saat)')!.push(r);
    else horizonMap.get('UNKNOWN (Plan Kaydı Yok)')!.push(r);
  }
  const byForecastHorizon = Array.from(horizonMap.entries())
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => computeGroupMetrics(k, list));

  // D. By Execution Source
  const sourceMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const src = r.executionSource ?? 'PAPER';
    const label = src === 'LIVE' ? 'LIVE (Gerçek İcra)'
      : src === 'PAPER' ? 'PAPER (Simülasyon / Paper Trade)'
      : 'TEST (Sentetik Test)';
    if (!sourceMap.has(label)) sourceMap.set(label, []);
    sourceMap.get(label)!.push(r);
  }
  const byExecutionSource = Array.from(sourceMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 1. By Primary Regime
  const regimeMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const reg = r.macroSnapshot?.primaryRegime ?? 'Bilinmeyen Rejim';
    if (!regimeMap.has(reg)) regimeMap.set(reg, []);
    regimeMap.get(reg)!.push(r);
  }
  const byRegime = Array.from(regimeMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 2. By VIX Volatility Bucket
  const vixMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  vixMap.set('Düşük Oynaklık (VIX < 15)', []);
  vixMap.set('Normal Oynaklık (15 <= VIX <= 22)', []);
  vixMap.set('Yüksek Oynaklık (VIX > 22)', []);
  vixMap.set('VIX Verisi Yok / Kripto', []);

  for (const r of effectiveRecords) {
    const vix = r.macroSnapshot?.vixLevel;
    if (typeof vix !== 'number') vixMap.get('VIX Verisi Yok / Kripto')!.push(r);
    else if (vix < 15) vixMap.get('Düşük Oynaklık (VIX < 15)')!.push(r);
    else if (vix <= 22) vixMap.get('Normal Oynaklık (15 <= VIX <= 22)')!.push(r);
    else vixMap.get('Yüksek Oynaklık (VIX > 22)')!.push(r);
  }
  const byVixBucket = Array.from(vixMap.entries())
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => computeGroupMetrics(k, list));

  // 3. By Score Tier
  const tierMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const tier = r.macroSnapshot?.scoreTier ? `Tier ${r.macroSnapshot.scoreTier}` : 'Bilinmeyen Tier';
    if (!tierMap.has(tier)) tierMap.set(tier, []);
    tierMap.get(tier)!.push(r);
  }
  const byScoreTier = Array.from(tierMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 4. By News Proximity
  const newsMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  newsMap.set('Kritik Haber Bölgesi (<= 30 dk veya Donma)', []);
  newsMap.set('Yakın Haber (31 - 120 dk)', []);
  newsMap.set('Sakin Piyasa (> 120 dk veya Haber Yok)', []);

  for (const r of effectiveRecords) {
    const minutes = r.macroSnapshot?.minutesToNewsEvent;
    const freeze = r.macroSnapshot?.newsFreezeActive;
    if (freeze || (typeof minutes === 'number' && minutes <= 30)) {
      newsMap.get('Kritik Haber Bölgesi (<= 30 dk veya Donma)')!.push(r);
    } else if (typeof minutes === 'number' && minutes <= 120) {
      newsMap.get('Yakın Haber (31 - 120 dk)')!.push(r);
    } else {
      newsMap.get('Sakin Piyasa (> 120 dk veya Haber Yok)')!.push(r);
    }
  }
  const byNewsProximity = Array.from(newsMap.entries())
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => computeGroupMetrics(k, list));

  // 5. By Crypto Derivatives Regime
  const derivMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const dReg = r.macroSnapshot?.cryptoRotation?.derivativesRegime;
    if (!dReg) continue;
    if (!derivMap.has(dReg)) derivMap.set(dReg, []);
    derivMap.get(dReg)!.push(r);
  }
  const byDerivativesRegime = Array.from(derivMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 6. By Crypto Sector
  const sectorMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const sec = r.macroSnapshot?.cryptoRotation?.sector;
    if (!sec) continue;
    if (!sectorMap.has(sec)) sectorMap.set(sec, []);
    sectorMap.get(sec)!.push(r);
  }
  const byCryptoSector = Array.from(sectorMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 7. By Symbol & Direction
  const symMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  for (const r of effectiveRecords) {
    const key = `${r.symbol} ${r.direction.toUpperCase()}`;
    if (!symMap.has(key)) symMap.set(key, []);
    symMap.get(key)!.push(r);
  }
  const bySymbolDirection = Array.from(symMap.entries()).map(([k, list]) => computeGroupMetrics(k, list));

  // 8. Factor Isolation (Funding Rate, RVOL, RS vs BTC)
  const factorMap = new Map<string, MacroOutcomeEvidenceRecord[]>();
  factorMap.set('Funding: Negatif (< -0.01%)', []);
  factorMap.set('Funding: Nötr / Düşük Pozitif (-0.01% - +0.02%)', []);
  factorMap.set('Funding: Yüksek Pozitif (> +0.02%)', []);
  factorMap.set('RVOL: Yüksek Hacim (> 1.5x)', []);
  factorMap.set('RVOL: Normal / Düşük (<= 1.5x)', []);

  for (const r of effectiveRecords) {
    const rot = r.macroSnapshot?.cryptoRotation;
    if (rot) {
      if (rot.fundingRatePct < -0.01) factorMap.get('Funding: Negatif (< -0.01%)')!.push(r);
      else if (rot.fundingRatePct <= 0.02) factorMap.get('Funding: Nötr / Düşük Pozitif (-0.01% - +0.02%)')!.push(r);
      else factorMap.get('Funding: Yüksek Pozitif (> +0.02%)')!.push(r);

      if (rot.effectiveRvol > 1.5) factorMap.get('RVOL: Yüksek Hacim (> 1.5x)')!.push(r);
      else factorMap.get('RVOL: Normal / Düşük (<= 1.5x)')!.push(r);
    }
  }

  const byCryptoFactors = Array.from(factorMap.entries())
    .filter(([, list]) => list.length > 0)
    .map(([k, list]) => computeGroupMetrics(k, list));

  const allGroups = [overall, ...byMacroContribution, ...byAssetClass, ...byForecastHorizon,
    ...byExecutionSource, ...byRegime, ...byVixBucket, ...byScoreTier, ...byNewsProximity,
    ...byDerivativesRegime, ...byCryptoSector, ...bySymbolDirection, ...byCryptoFactors];
  const adjusted = holmAdjusted(allGroups.map(g => g.pValueExpectancy));
  allGroups.forEach((g, i) => Object.assign(g, { adjustedPValueExpectancy: adjusted[i] }));

  return {
    overall,
    byMacroContribution,
    byAssetClass,
    byForecastHorizon,
    byExecutionSource,
    byRegime,
    byVixBucket,
    byScoreTier,
    byNewsProximity,
    byDerivativesRegime,
    byCryptoSector,
    bySymbolDirection,
    byCryptoFactors,
  };
}

export function formatMacroOutcomeReport(summary: MacroOutcomeReportSummary): string {
  const lines: string[] = [];
  lines.push('═════════════════════════════════════════════════════════════════════════════════════════════════════');
  lines.push('                   BEGONYA MAKRO-SMC BETİMSEL PAPER / LIVE ÖLÇÜM RAPORU                       ');
  lines.push('═════════════════════════════════════════════════════════════════════════════════════════════════════');
  lines.push(`TOPLAM ADAY SİNYAL    : ${summary.overall.candidateCount}`);
  lines.push(`GERÇEKLEŞEN İŞLEM (Fill): ${summary.overall.filledTradesCount} (Dolum Oranı: %${summary.overall.fillRatePct})`);
  lines.push(`VADESİ DOLAN / İPTAL   : ${summary.overall.expiredCount} Expired, ${summary.overall.cancelledCount} Cancelled`);
  lines.push(`ÇÖZÜLEN / BELİRSİZ    : ${summary.overall.resolvedTradesCount} / ${summary.overall.unresolvedFilledCount} | Net ölçülen: ${summary.overall.netMeasuredCount}`);
  lines.push('Çıkarım: haftalık küme bootstrap; segmentler keşifseldir. Holm düzeltmesi uygulanır.');
  lines.push('Makro grupları yalnızca aynı v3 paper politikası içinde karşılaştırılır; bağımsız macro-only strateji içermez.');
  lines.push(`KAZANMA ORANI (WinRate): %${summary.overall.winRatePct.toFixed(1)} [95% CI: %${summary.overall.winRateLower95} - %${summary.overall.winRateUpper95}] (p=${summary.overall.pValueWinRate})`);
  lines.push(`BRÜT BEKLENTİ (Gross R): ${summary.overall.expectancyR.toFixed(2)}R | NET BEKLENTİ: ${summary.overall.netExpectancyR.toFixed(2)}R [95% CI: ${summary.overall.netExpectancyLower95}R - ${summary.overall.netExpectancyUpper95}R] (Holm p=${summary.overall.adjustedPValueExpectancy ?? "N/A"})`);
  lines.push(`İŞLEM MALİYETİ (Ort.)  : -${summary.overall.avgCostR.toFixed(2)}R | NET GERÇEKLEŞEN TOPLAM: ${summary.overall.totalNetRealizedR.toFixed(1)}R`);
  lines.push(`ÖRNEKLEM YETERLİLİĞİ  : ${summary.overall.sampleAdequacy} (Net N=${summary.overall.netMeasuredCount}, hafta=${summary.overall.independentWeeks}; edge onayı değildir)`);
  lines.push('');

  const renderTable = (title: string, groups: readonly GroupPerformanceMetrics[]) => {
    if (groups.length === 0) return;
    lines.push(`─── ${title} ───`);
    lines.push(
      'Grup / Kategori'.padEnd(38) +
      'Aday'.padStart(5) +
      'Fill'.padStart(5) +
      'TP'.padStart(4) +
      'SL'.padStart(4) +
      'Win%'.padStart(7) +
      '95% CI'.padStart(14) +
      'Maliyet'.padStart(8) +
      'Net R'.padStart(9) +
      'Net Exp'.padStart(9) +
      'Yeterlilik'.padStart(12)
    );
    lines.push('─'.repeat(115));

    for (const m of groups) {
      const netSign = m.totalNetRealizedR > 0 ? '+' : '';
      const expSign = m.netExpectancyR > 0 ? '+' : '';
      const ciStr = `[%${m.winRateLower95}-%${m.winRateUpper95}]`;
      lines.push(
        m.groupKey.padEnd(38).slice(0, 38) +
        String(m.candidateCount).padStart(5) +
        String(m.filledTradesCount).padStart(5) +
        String(m.tpCount).padStart(4) +
        String(m.slCount).padStart(4) +
        `${m.winRatePct.toFixed(1)}%`.padStart(7) +
        ciStr.padStart(14) +
        `-${m.avgCostR.toFixed(2)}R`.padStart(8) +
        `${netSign}${m.totalNetRealizedR.toFixed(1)}R`.padStart(9) +
        `${expSign}${m.netExpectancyR.toFixed(2)}R`.padStart(9) +
        m.sampleAdequacy.padStart(12)
      );
    }
    lines.push('');
  };

  renderTable('A. MAKRO GÖLGE KARŞILAŞTIRMASI (Baseline vs. Makro Onaylı vs. Engellenen)', summary.byMacroContribution);
  renderTable('B. VARLIK SINIFI AYRIMI (Forex ve Kripto Ayrı Ölçüm)', summary.byAssetClass);
  renderTable('C. EX-ANTE TAHMİN UFKUNA GÖRE PERFORMANS (Setup Anındaki Plan)', summary.byForecastHorizon);
  renderTable('D. İCRA KAYNAĞINA GÖRE PERFORMANS (Paper vs. Live)', summary.byExecutionSource);
  renderTable('E. FAKTÖR BAZINDA PERFORMANS AYRIŞTIRMASI (Funding & RVOL Katkısı)', summary.byCryptoFactors ?? []);
  renderTable('1. MAKRO PİYASA REJİMLERİNE GÖRE PERFORMANS', summary.byRegime);
  renderTable('2. VIX OYNAKLIK SEVİYELERİNE GÖRE PERFORMANS', summary.byVixBucket);
  renderTable('3. BEGONYA PUAN VE TIER KALİTESİNE GÖRE PERFORMANS', summary.byScoreTier);
  renderTable('4. NEWSGUARD HABER YAKINLIĞINA GÖRE PERFORMANS', summary.byNewsProximity);
  renderTable('5. KRİPTO 8-FAKTÖR TÜREV REJİMİNE GÖRE PERFORMANS', summary.byDerivativesRegime);
  renderTable('6. KRİPTO SEKTÖRLERİNE GÖRE PERFORMANS', summary.byCryptoSector);
  renderTable('7. ENSTRÜMAN VE YÖNLERE GÖRE PERFORMANS', summary.bySymbolDirection);

  lines.push('═════════════════════════════════════════════════════════════════════════════════════════════════════');
  return lines.join('\n').replace(/null/g, 'N/A');
}
