import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaperOutcomeTracker } from '../server/paperOutcomeTracker';
import { NotificationCandidate } from '../server/pipeline';
import { FileSignalLedger } from '../server/signalLedger';
import { computeGroupMetrics, generateMacroOutcomeAnalytics } from '../server/macroOutcomeAnalytics';
import { normalizeMacroOutcomeRecord, verifyMacroProvenance, createFallbackMacroSnapshot,
  MacroOutcomeEvidenceRecord, FileMacroOutcomeStore } from '../server/macroOutcomeEvidence';
import { weeklyBootstrap, holmAdjusted } from '../server/outcomeStatistics';
import { buildOutcomeReadiness } from '../server/outcomeReadiness';
import { calculateTradeExpectancyPlan } from '../src/tradeExpectancyEngine';

const time = Date.UTC(2026, 0, 1);
const minute = 60000;
const base = (overrides: Record<string, unknown> = {}) => normalizeMacroOutcomeRecord({
  signalId: 'real_candidate', symbol: 'EURUSD', direction: 'long', signalTimestamp: time,
  exitTimestamp: time + 60 * minute, entryTimestamp: time + 15 * minute, entryConfirmed: true,
  executionSource: 'PAPER', outcome: 'TP', realizedR: 2, totalCostR: 0.2, netRealizedR: 1.8,
  ...overrides,
});

describe('Outcome measurement regressions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'begonya-measurement-'));
  afterAll(() => {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Invalid test cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('file normalization does not turn unverified legacy records into PAPER evidence', async () => {
    const file = path.join(dir, 'legacy.jsonl');
    fs.writeFileSync(file, JSON.stringify({ signalId: 'legacy', symbol: 'EURUSD' }) + '\n');
    const rows = await new FileMacroOutcomeStore(file).readAllRecords();
    expect(rows[0].executionSource).toBe('UNVERIFIED');
    expect(generateMacroOutcomeAnalytics(rows).overall.candidateCount).toBe(0);
  });

  test('reading preserves recorded costs and net returns without recalibrating history', () => {
    const r = base({ realizedR: 1, totalCostR: 0.9, netRealizedR: 0.1 });
    expect(r.totalCostR).toBe(0.9);
    expect(r.netRealizedR).toBe(0.1);
    expect(base({ netRealizedR: undefined }).netRealizedR).toBe(1.8);
    expect(base({ totalCostR: undefined, netRealizedR: undefined }).netRealizedR).toBeNull();
    expect(base({ totalCostR: 0.9, netRealizedR: 1.8 }).dataQualityIssues).toContain('INCONSISTENT_GROSS_NET_COST');
  });

  test('filled expired and unknown positions are censored, never zero-return observations', () => {
    const m = computeGroupMetrics('TEST', [base(), base({ outcome: 'EXPIRED', realizedR: null, netRealizedR: null }),
      base({ outcome: 'UNKNOWN', realizedR: 0, netRealizedR: 0 })]);
    expect(m.filledTradesCount).toBe(3);
    expect(m.resolvedTradesCount).toBe(1);
    expect(m.unresolvedFilledCount).toBe(2);
    expect(m.netMeasuredCount).toBe(1);
    expect(m.netExpectancyR).toBe(1.8);
  });

  test('a generated timestamp alone cannot establish point-in-time availability', () => {
    expect(verifyMacroProvenance({ generated_at_utc: new Date(time).toISOString() }, time).pointInTimeVerified).toBe(false);
    const payload = { generated_at_utc: new Date(time).toISOString(), input_availability_complete: true,
      input_availability: [{ source: 'rates', availableAt: new Date(time - minute).toISOString(), vintageAt: new Date(time - minute).toISOString() }] };
    expect(verifyMacroProvenance(payload, time).pointInTimeVerified).toBe(true);
    expect(verifyMacroProvenance(payload, time - 2 * minute).pointInTimeVerified).toBe(false);
    expect(base({ macroSnapshot: { ...createFallbackMacroSnapshot('EURUSD', 'long', time), pointInTimeVerified: true } }).macroSnapshot.pointInTimeVerified).toBe(false);
  });

  test('legacy realized holding buckets cannot become ex-ante forecast horizons', () => {
    expect(base({ forecastHorizon: 'MULTI_DAY' }).exAnteForecastHorizon).toBe('UNKNOWN');
    expect(base({ plannedHoldingTimeMs: 8 * 3600000 }).exAnteForecastHorizon).toBe('SWING_4H_24H');
  });

  test('many correlated trades in one week do not produce adequate sample or significance', () => {
    const m = computeGroupMetrics('CLUSTERED', Array.from({ length: 120 }, () => base()));
    expect(m.sampleAdequacy).toBe('INSUFFICIENT');
    expect(m.netExpectancyLower95).toBeNull();
    expect(m.pValueExpectancy).toBeNull();
    const rows = Array.from({ length: 20 }, (_, i) => ({ signalTimestamp: time + i * 7 * 86400000, value: i % 2 ? 2 : -1 }));
    expect(weeklyBootstrap(rows)).toEqual(weeklyBootstrap(rows));
    expect(holmAdjusted([0.01, 0.04, null, 0.03])).toEqual([0.03, 0.06, null, 0.06]);
  });

  test('legacy results are descriptive only and distinct execution policies cannot be pooled for macro attribution', () => {
    const a = base({ measurementVersion: 3, executionPolicyId: 'policy-a', macroGatingCohort: 'MACRO_APPROVED' });
    const b = base({ measurementVersion: 3, executionPolicyId: 'policy-b', macroGatingCohort: 'MACRO_BLOCKED' });
    const report = generateMacroOutcomeAnalytics([a, b, base()]);
    expect(report.overall.totalTrades).toBe(3);
    expect(report.byMacroContribution.filter(g => g.groupKey.startsWith('ALL_SMC_BASELINE'))).toHaveLength(2);
    expect(report.byMacroContribution.some(g => g.groupKey.includes('MACRO_ONLY'))).toBe(false);
  });

  function tracker(id: string, config: Record<string, unknown> = {}) {
    const output: MacroOutcomeEvidenceRecord[] = [];
    const ledger = { ensureSignalIssued: jest.fn(async () => undefined), recordEntry: jest.fn(async () => undefined),
      recordExit: jest.fn(async () => undefined), recordCancelled: jest.fn(async () => undefined) };
    const engine = new PaperOutcomeTracker({ statePath: path.join(dir, `${id}.json`),
      signalLedger: ledger as unknown as FileSignalLedger,
      evidenceStore: { appendOutcomeEvidence: async () => undefined, appendSignalEvidence: async () => undefined },
      macroOutcomeStore: { appendRecord: async r => { output.push(r); }, readAllRecords: async () => output },
      config: { breakEvenAtR: 100, ...config },
    });
    const candidate = { symbol: 'EURUSD', tradeDirection: 'long', poiType: 'OB', uniqueKey: id, marketDataTimestamp: time,
      poi: { low: 1.1, high: 1.1001 }, gradeResult: { totalScore: 85, grade: 'A' } } as NotificationCandidate;
    return { engine, candidate, output, ledger };
  }
  const entry = { timestamp: time + 15 * minute, open: 1.10005, low: 1.09999, high: 1.10012, close: 1.10007 };

  test('R uses the actual stop distance and entry-bar favorable extremes cannot produce TP', () => {
    const { engine, candidate, output } = tracker('entry-risk');
    engine.registerCandidate(candidate, createFallbackMacroSnapshot('EURUSD', 'long', time), { observedAtMs: time });
    engine.update('EURUSD', [{ ...entry, high: 1.105 }]);
    const s = engine.get(candidate.uniqueKey)!;
    expect(s.riskDistance).toBeCloseTo(Math.abs(s.entryPrice! - s.stopLoss!), 12);
    expect(s.riskDistance).toBeCloseTo(0.00025, 10);
    expect(s.status).toBe('OPEN');
    expect(s.exAnteForecastHorizon).toBe('SWING_4H_24H');
    engine.update('EURUSD', [{ ...entry, timestamp: time + 30 * minute, high: 1.1001, low: 1.0997 }]);
    expect(output[0].realizedR).toBe(-1);
    expect(output[0].fillModel).toBe('CONSERVATIVE_SL_FIRST');
    expect(output[0].costModel).toBe('ESTIMATED');
  });

  test('macro blocked and approved candidates have identical partial-TP behavior and policy IDs', () => {
    const a = tracker('approved'), b = tracker('blocked');
    for (const [t, shadow] of [[a, false], [b, true]] as const) {
      const snapshot = createFallbackMacroSnapshot('EURUSD', 'long', time);
      t.engine.registerCandidate(t.candidate, { ...snapshot, macroAction: shadow ? 'VETO' : 'PROCEED' }, { isShadowCounterfactual: shadow, observedAtMs: time });
      t.engine.update('EURUSD', [entry]);
      t.engine.update('EURUSD', [{ ...entry, timestamp: time + 30 * minute, high: 1.1004, low: 1.10006 }]);
      t.engine.update('EURUSD', [{ ...entry, timestamp: time + 45 * minute, high: 1.1001, low: 1.0997 }]);
    }
    expect(a.output[0].realizedR).toBe(-1);
    expect(b.output[0].realizedR).toBe(-1);
    expect(a.output[0].executionPolicyId).toBe(b.output[0].executionPolicyId);
  });

  test('paper tracker never masquerades as LIVE and unresolved expiry has no fabricated exit', () => {
    const old = process.env.EXECUTION_SOURCE;
    process.env.EXECUTION_SOURCE = 'LIVE';
    try {
      const { engine, candidate, output } = tracker('expiry', { maxHoldBars: 1 });
      engine.registerCandidate(candidate, createFallbackMacroSnapshot('EURUSD', 'long', time), { observedAtMs: time });
      engine.update('EURUSD', [entry, { ...entry, timestamp: time + 30 * minute }]);
      expect(output[0].executionSource).not.toBe('LIVE');
      expect(output[0].outcome).toBe('EXPIRED');
      expect(output[0].exitPrice).toBeNull();
      expect(output[0].realizedR).toBeNull();
    } finally { if (old === undefined) delete process.env.EXECUTION_SOURCE; else process.env.EXECUTION_SOURCE = old; }
  });

  test('readiness counts real ledger fills without auto-promoting incomplete economic macro evidence', () => {
    const readiness = buildOutcomeReadiness([base()], 162);
    expect(readiness.confirmed_filled_trades_logged).toBe(1);
    expect(readiness.verified_macro_holdout_trades).toBe(0);
    expect(readiness.promotion_eligible).toBe(false);
  });

  test('paper measurement preserves the planned structural stop and bounded target', () => {
    const { engine, candidate, output } = tracker('planned-target');
    const plan = calculateTradeExpectancyPlan({ symbol: 'EURUSD', direction: 'long', zoneLow: 1.1,
      zoneHigh: 1.1001, currentPrice: 1.10005, grade: 'A', totalScore: 85, atr15mPips: 10 });
    engine.registerCandidate({ ...candidate, expectancyPlan: plan }, createFallbackMacroSnapshot('EURUSD', 'long', time), { observedAtMs: time });
    engine.update('EURUSD', [entry]);
    const tracked = engine.get(candidate.uniqueKey)!;
    expect(tracked.stopLoss).toBe(plan.stopLoss);
    expect(tracked.takeProfit).toBeCloseTo(plan.tp2.price, 12);
    expect(tracked.executionPolicyId).toContain('plan-v1.2:fixed-entry-band:closed-m15');
    engine.update('EURUSD', [{ ...entry, timestamp: time + 30 * minute, high: plan.tp2.price + 0.0001, low: plan.entryPrice + 0.00001 }]);
    expect(output[0].realizedR).toBeCloseTo(plan.primaryRR, 8);
  });

  test('a touch of the original box outside the feasible band is not a paper fill', () => {
    const { engine, candidate, ledger } = tracker('band-not-reached');
    const plan = calculateTradeExpectancyPlan({ symbol: 'EURUSD', direction: 'long', zoneLow: 1.1,
      zoneHigh: 1.102, currentPrice: 1.101, grade: 'A', totalScore: 85, atr15mPips: 10,
      opposingObstacle: { hasObstacle: true, obstacleType: 'OB', timeframe: '1h',
        level: { low: 1.1025, high: 1.103 }, distancePips: 15, warningText: '' } });
    expect(plan.admissionBasis).toBe('CONDITIONAL_ENTRY');
    const wide = { ...candidate, poi: { ...candidate.poi, low: 1.1, high: 1.102 }, expectancyPlan: plan } as NotificationCandidate;
    engine.registerCandidate(wide, createFallbackMacroSnapshot('EURUSD', 'long', time), { observedAtMs: time });
    engine.update('EURUSD', [{ timestamp: time + 15 * minute, open: 1.1014, high: 1.1018, low: 1.1008, close: 1.1015 }]);
    expect(engine.get(candidate.uniqueKey)!.status).toBe('WAITING_ENTRY');
    expect(ledger.recordEntry).not.toHaveBeenCalled();
  });

  test('an unfinished M15 candle cannot fill or invalidate a v1.2 paper setup', () => {
    const { engine, candidate, ledger } = tracker('band-open-candle');
    const plan = calculateTradeExpectancyPlan({ symbol: 'EURUSD', direction: 'long', zoneLow: 1.1,
      zoneHigh: 1.1001, currentPrice: 1.10005, grade: 'A', totalScore: 85, atr15mPips: 10 });
    engine.registerCandidate({ ...candidate, expectancyPlan: plan }, createFallbackMacroSnapshot('EURUSD', 'long', time), { observedAtMs: time });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(time + 16 * minute);
    try {
      engine.update('EURUSD', [{ ...entry, close: 1.099 }]);
      expect(engine.get(candidate.uniqueKey)!.status).toBe('WAITING_ENTRY');
      expect(ledger.recordEntry).not.toHaveBeenCalled();
      expect(ledger.recordCancelled).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  test('an approved caution or reduced-risk macro decision is not misclassified as vetoed', () => {
    const { engine, candidate } = tracker('macro-caution');
    engine.registerCandidate({ ...candidate, macroEvaluation: { allowed: true } as any },
      { ...createFallbackMacroSnapshot('EURUSD', 'long', time), macroAction: 'NEUTRAL_CAUTION' }, { observedAtMs: time });
    const tracked = engine.get(candidate.uniqueKey)!;
    expect(tracked.macroGatingCohort).toBe('MACRO_APPROVED');
    expect(tracked.macroDecisionAtSignal).toBe('PROCEED');
    expect(tracked.isShadowCounterfactual).toBe(false);
  });
});
