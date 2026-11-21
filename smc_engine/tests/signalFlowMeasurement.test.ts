import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SignalFlowMeasurement, buildSignalFlowReport, sha256 } from '../server/signalFlowMeasurement';
import { calculateTradeExpectancyPlan, calculateFeasibleEntryRange } from '../src/tradeExpectancyEngine';
import { nextAlignedPollAt } from '../server/pollSchedule';
import { DeterministicProviderQueue } from '../server/providerQueue';
import { ProviderRateLimitError, ProviderRequest, ProviderRequestExpiredError, ProviderSuccess } from '../server/providerTypes';

const now = Date.UTC(2026, 9, 23, 15);
const request: ProviderRequest = { endpoint: '/time_series', symbol: 'EURUSD', timeframe: '15m', outputSize: 10 };
const success = (): ProviderSuccess => ({ candles: [], metadata: { requestTimestamp: new Date(now).toISOString(),
  responseTimestamp: new Date(now).toISOString(), latencyMs: 0, endpoint: '/time_series', symbol: 'EURUSD', timeframe: '15m',
  httpStatus: 200, retryCount: 0, apiCreditsUsed: null, apiCreditsLeft: null } });

describe('Signal-flow forward measurement and frozen rules', () => {
  let directory: string;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'begonya-forward-'));
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ version: 1, runId: 'unit', createdAt: new Date(now).toISOString(),
      repositoryRoot: directory, codeHashes: {}, minimumNetRR: 2, automaticPromotion: false,
      outcomeScope: 'FORWARD_M15_PAPER_NOT_MANUAL_M1',
      reviewGate: { minimumCalendarDays: 28, minimumClosedPaperFills: 100, minimumIndependentWeeks: 4 } }));
  });
  afterEach(() => {
    jest.useRealTimers();
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Invalid cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('a protocol cannot be silently edited after hashing', () => {
    expect(() => new SignalFlowMeasurement(directory, sha256('different'))).toThrow('hash mismatch');
  });

  test('deduplicates a POI/bar across restarts and never turns repeats into extra candidates', () => {
    const plan = calculateTradeExpectancyPlan({ symbol: 'EURUSD', direction: 'long', zoneLow: 1.1, zoneHigh: 1.102,
      currentPrice: 1.101, atr15mPips: 10, grade: 'A', totalScore: 85 });
    const input = { symbol: 'EURUSD', poiId: 'poi', marketDataTimestamp: now - 900_000, plan };
    const writer = new SignalFlowMeasurement(directory);
    writer.observePlan(input); writer.observePlan(input);
    new SignalFlowMeasurement(directory).observePlan(input);
    expect(buildSignalFlowReport(directory).eligibility.planObservations).toBe(1);
  });

  test('old closes, unresolved exits and missing entry events cannot become forward wins', () => {
    const writer = new SignalFlowMeasurement(directory);
    const plan = { version: 'v1.2', isAdmissible: true, entryRange: { low: 1, high: 2 }, admissionBasis: 'CONDITIONAL_ENTRY' };
    const register = (signalId: string, timestamp = now) => writer.append('PAPER_REGISTERED', { signalId,
      signalGeneratedAt: new Date(timestamp).toISOString(), executionPolicyId: 'plan-v1.2', plan, macroAllowed: true });
    const close = (signalId: string, overrides = {}) => writer.append('PAPER_CLOSED', { signalId, entryConfirmed: true,
      outcome: 'TP', realizedR: 2, netRealizedR: 1.8, totalCostR: .2, costModel: 'ESTIMATED',
      entryTimestamp: now, exitTimestamp: now, ...overrides });
    register('old', now - 1000); close('old');
    register('no_entry'); close('no_entry');
    register('unknown'); writer.append('PAPER_ENTERED', { signalId: 'unknown' }); close('unknown', { outcome: 'UNKNOWN' });
    register('valid'); writer.append('PAPER_ENTERED', { signalId: 'valid' }); close('valid');
    const report = buildSignalFlowReport(directory);
    expect(report.paper.conditional.closedFilled).toBe(1);
    expect(report.paper.conditional.tp).toBe(1);
    expect(report.paper.conditional.meanEstimatedNetR).toBe(1.8);
    expect(report.reviewGate.automaticPromotion).toBe(false);
    expect(report.reviewGate.closedFillsMet).toBe(false);
  });

  test('no filled outcomes means an unknown success rate, not zero or perfect success', () => {
    new SignalFlowMeasurement(directory).heartbeat();
    const report = buildSignalFlowReport(directory);
    expect(report.paper.reference.tpRateAmongClosedFilled).toBeNull();
    expect(report.paper.conditional.meanEstimatedNetR).toBeNull();
    expect(report.reviewGate.conclusion).toBe('INSUFFICIENT_FORWARD_EVIDENCE');
  });

  test('malformed evidence and stale heartbeat block a clean data verdict', () => {
    const writer = new SignalFlowMeasurement(directory); writer.heartbeat();
    fs.appendFileSync(path.join(directory, 'events.jsonl'), '{broken}\n');
    const report = buildSignalFlowReport(directory, now + 181_000);
    expect(report.dataQualityIssues).toContain('MALFORMED_EVENTS:1');
    expect(report.dataQualityIssues).toContain('STALE_RUNTIME_HEARTBEAT');
    expect(report.reviewGate.conclusion).toBe('DATA_QUALITY_REVIEW_REQUIRED');
  });

  test('long and short bands satisfy fixed target/stop/cost at their worst entry', () => {
    for (const direction of ['long', 'short'] as const) {
      const stopLoss = direction === 'long' ? 90 : 110;
      const targetPrice = direction === 'long' ? 130 : 70;
      const range = calculateFeasibleEntryRange({ direction, zoneLow: 98, zoneHigh: 102,
        stopLoss, targetPrice, nominalCostDistance: 1, minimumNetRR: 2 })!;
      const entry = direction === 'long' ? range.high : range.low;
      const reward = direction === 'long' ? targetPrice - entry : entry - targetPrice;
      expect((reward - 1) / (Math.abs(entry - stopLoss) + 1)).toBeGreaterThanOrEqual(2);
    }
  });

  test('a daily quota does not sleep or keep making network attempts before reset', async () => {
    let calls = 0;
    const sleep = jest.fn();
    const queue = new DeterministicProviderQueue({ now: () => now, sleep, transport: async (req, retry) => {
      calls += 1; throw new ProviderRateLimitError('API credits for the day exhausted', req, retry, null, 8, 0);
    } });
    const first = queue.enqueue(request);
    await Promise.resolve(); // fake timer environments require explicitly flushing queueMicrotask
    jest.runAllTicks();
    await expect(first).rejects.toBeInstanceOf(ProviderRateLimitError);
    const second = queue.enqueue({ ...request, symbol: 'GBPUSD' }); jest.runAllTicks();
    await expect(second).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(1); expect(sleep).not.toHaveBeenCalled();
    expect(queue.getMetrics().dailyBlockedKeys).toBe(1);
  });

  test('expired queue jobs are rejected before another network request is made', async () => {
    let time = now, calls = 0;
    const queue = new DeterministicProviderQueue({ creditsPerMinute: 1, safetyMargin: 0, now: () => time,
      sleep: async duration => { time += duration; }, transport: async () => { calls += 1; return success(); } });
    const first = queue.enqueue(request); jest.runAllTicks(); await first;
    const second = queue.enqueue({ ...request, symbol: 'GBPUSD', maxQueueAgeMs: 1000 }); jest.runAllTicks();
    await expect(second).rejects.toBeInstanceOf(ProviderRequestExpiredError);
    expect(calls).toBe(1);
  });

  test('00:14:50 reaches the 00:15:35 scan instead of skipping a slot', () => {
    const time = Date.UTC(2026, 9, 23, 0, 14, 50);
    expect(nextAlignedPollAt(time, 35_000)).toBe(Date.UTC(2026, 9, 23, 0, 15, 35));
  });
});
