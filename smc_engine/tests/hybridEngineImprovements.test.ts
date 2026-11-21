import { calculateTradeExpectancyPlan } from '../src/tradeExpectancyEngine';
import { detectOpposingObstacle } from '../src/opposingObstacleDetector';
import { assessPoiRisk } from '../src/poiRiskContext';
import { evaluateSignalQuality } from '../src/signalQualityEngine';
import { assessDerivativesData } from '../server/cryptoRotationEngine';
import { evaluateRelativePolicyContext } from '../server/relativePolicyContext';
import { Candle, OrderBlock } from '../src/types';
import { closedCandles } from '../src/closedCandles';

const planInput = { symbol: 'EURUSD', direction: 'long' as const, zoneLow: 1.1, zoneHigh: 1.102,
  currentPrice: 1.101, grade: 'A+', totalScore: 90, atr15mPips: 10 };
const ob = (low: number, high: number): OrderBlock => ({ direction: 'bearish', low, high, formedAtIndex: 0,
  relatedEvent: { breakCandleIndex: 0 } } as OrderBlock);

describe('Hybrid SMC and economic macro improvements', () => {
  test('an unfinished M15 bar cannot contribute a box invalidation close', () => {
    const now = Date.UTC(2026, 9, 23, 12);
    const bars = [{ timestamp: now - 15 * 60000, close: 1.101 }, { timestamp: now, close: 1.09 }];
    expect(closedCandles(bars, 15 * 60000, now)).toEqual([bars[0]]);
    expect(closedCandles(bars, 15 * 60000, now + 15 * 60000)).toEqual(bars);
  });
  test('selects the nearest opposing zone across OB, FVG and H1 instead of array order', () => {
    const input = { symbol: 'EURUSD', tradeDirection: 'long' as const, entryZone: { low: 1.1, high: 1.101 },
      activeOrderBlocks15m: [ob(1.104, 1.105), ob(1.103, 1.104)], activeFVGs15m: [],
      activeOrderBlocks1h: [ob(1.102, 1.103)], minClearancePips: 100 };
    expect(detectOpposingObstacle(input).level?.low).toBe(1.102);
    expect(detectOpposingObstacle(input).timeframe).toBe('1h');
    expect(detectOpposingObstacle({ ...input, activeOrderBlocks15m: [...input.activeOrderBlocks15m].reverse() })).toEqual(detectOpposingObstacle(input));
  });

  test('a wick preserves an opposing box; a completed close beyond its distal edge removes it', () => {
    const obstacle = ob(1.102, 1.103);
    const candle = { timestamp: 1000, open: 1.102, low: 1.101, high: 1.105, close: 1.1025 };
    const input = { symbol: 'EURUSD', tradeDirection: 'long' as const, entryZone: { low: 1.1, high: 1.101 },
      activeOrderBlocks15m: [obstacle], activeFVGs15m: [], minClearancePips: 100 };
    expect(detectOpposingObstacle({ ...input, closedCandles15m: [candle, candle] }).hasObstacle).toBe(true);
    expect(detectOpposingObstacle({ ...input, closedCandles15m: [candle, { ...candle, close: 1.104 }] }).hasObstacle).toBe(false);
  });

  test('caps long and short targets and accepts only a feasible net-RR entry band', () => {
    const obstacle = { hasObstacle: true, obstacleType: 'OB' as const, timeframe: '1h' as const,
      level: { low: 1.1025, high: 1.103 }, distancePips: 15, warningText: '' };
    const long = calculateTradeExpectancyPlan({ ...planInput, opposingObstacle: obstacle });
    expect(long.tp2.price).toBeLessThan(obstacle.level.low);
    expect(long.tp1.price).toBeLessThan(long.tp2.price);
    expect(long.tp3.price).toBeLessThan(obstacle.level.low);
    expect(long.referenceNetRiskRewardRatio).toBeLessThan(2);
    expect(long.admissionBasis).toBe('CONDITIONAL_ENTRY');
    expect(long.entryRange!.high).toBeLessThan(planInput.currentPrice);
    expect(long.netRiskRewardRatio).toBeGreaterThanOrEqual(2);
    expect(long.targetConstraint).toBe('OBSTACLE');
    const short = calculateTradeExpectancyPlan({ ...planInput, direction: 'short', opposingObstacle: {
      ...obstacle, level: { low: 1.099, high: 1.0995 } } });
    expect(short.tp2.price).toBeGreaterThan(1.0995);
    expect(short.tp1.price).toBeGreaterThan(short.tp2.price);
    expect(short.referenceNetRiskRewardRatio).toBeLessThan(2);
    expect(short.admissionBasis).toBe('CONDITIONAL_ENTRY');
    expect(short.entryRange!.low).toBeGreaterThan(planInput.currentPrice);
    expect(short.netRiskRewardRatio).toBeGreaterThanOrEqual(2);
  });

  test('never turns grade or macro approval into an empirical win rate or Kelly risk budget', () => {
    const plan = calculateTradeExpectancyPlan(planInput);
    expect(plan.winProbability).toBeNull();
    expect(plan.expectedValueR).toBeNull();
    expect(plan.kellyFraction).toBeNull();
    const vetoed = calculateTradeExpectancyPlan({ ...planInput, macroEvaluation: { allowed: false, macroGateMultiplier: 0 } as any });
    expect(vetoed.recommendedRiskPct).toBe(0);
    expect(plan.riskDistancePips * 0.0001).toBeCloseTo(plan.entryPrice - plan.stopLoss, 12);
  });

  test('net RR includes execution costs on both the profit and loss sides', () => {
    const plan = calculateTradeExpectancyPlan({ ...planInput, zoneHigh: 1.1001, currentPrice: 1.10005 });
    expect(plan.netRewardR).toBeGreaterThan(2);
    expect(plan.netRiskRewardRatio).toBeLessThan(2);
    expect(plan.netRiskRewardRatio).toBeCloseTo((plan.primaryRR - plan.estimatedCostR!) / (1 + plan.estimatedCostR!), 3);
    expect(plan.isAdmissible).toBe(false);
  });

  test('POI compound warnings preserve the box and do not add minute entry or new invalidation rules', () => {
    const context = { ageBars: 40, testCount: 2, approachAtrMultiple: 2.5 };
    expect(assessPoiRisk(context)).toEqual(['AGED_RETESTED_POI', 'RETEST_WITH_FAST_APPROACH']);
    const before = calculateTradeExpectancyPlan(planInput);
    const after = calculateTradeExpectancyPlan({ ...planInput, poiContext: context });
    expect(after.stopLoss).toBe(before.stopLoss);
    expect(after.isAdmissible).toBe(before.isAdmissible);
    expect(after.entryPrice).toBe(before.entryPrice);
  });

  test('quality distance uses JPY and crypto symbol units instead of a fixed FX pip', () => {
    const make = (symbol: string, price: number, low: number, high: number, atr: number) => evaluateSignalQuality({
      symbol, poiType: 'OB', poi: { ...ob(low, high), relatedEvent: { breakCandleIndex: 0 } } as OrderBlock,
      currentIndex: 10, currentPrice: price, currentTimestamp: Date.UTC(2026, 9, 23), poiTestCount: 0, atr15mPips: atr,
    });
    expect(make('USDJPY', 150.2, 150, 150.1, 20).metrics.distanceToPoiPips).toBeCloseTo(10);
    expect(make('BTCUSD', 65010, 64900, 65000, 100).metrics.distanceToPoiPips).toBe(10);
    expect(make('BTCUSD', 65010, 64900, 65000, 100).metrics.distanceAtrMultiple).toBe(0.1);
  });

  test('relative repricing requires fresh bilateral observations and cannot increase risk', () => {
    const now = Date.UTC(2026, 9, 23);
    const panel = { status: 'AVAILABLE', as_of_utc: new Date(now).toISOString(), pairs: {
      EURUSD: { status: 'AVAILABLE', relative_reprice_bps: -8, horizon: '6M', sources: ['ECB OIS', 'USD OIS'] },
    } };
    expect(evaluateRelativePolicyContext(panel, 'EURUSD', 'long', now).status).toBe('CONFLICT');
    expect(evaluateRelativePolicyContext(panel, 'EURUSD', 'long', now).riskMultiplier).toBe(0.75);
    expect(evaluateRelativePolicyContext(panel, 'EURUSD', 'short', now).riskMultiplier).toBe(1);
    expect(evaluateRelativePolicyContext(panel, 'EURUSD', 'long', now - 1).status).toBe('UNAVAILABLE');
    expect(evaluateRelativePolicyContext(panel, 'EURUSD', 'long', now + 37 * 3600000).status).toBe('UNAVAILABLE');
    expect(evaluateRelativePolicyContext(panel, 'BTCUSD', 'long', now).status).toBe('UNAVAILABLE');
  });

  test('zero funding is valid but absent funding and short OI windows cannot earn derivative confirmation', () => {
    const data = { funding_rate: 0, spot_quote_volume_24h: 10, futures_quote_volume_24h: 20,
      oi_history_1h: Array.from({ length: 25 }, (_, i) => ({ timestamp: 10000000 + i * 3600000, sum_open_interest: 100, sum_open_interest_value: 1000 })) };
    expect(assessDerivativesData(data)).toEqual([]);
    expect(assessDerivativesData({ ...data, funding_rate: undefined })).toContain('FUNDING_UNAVAILABLE');
    expect(assessDerivativesData({ ...data, oi_history_1h: data.oi_history_1h.slice(-5) })).toContain('OI_24H_HISTORY_UNAVAILABLE');
    expect(assessDerivativesData({ ...data, oi_history_1h: [...data.oi_history_1h].reverse() })).toContain('OI_WINDOW_MISALIGNED');
  });
});
