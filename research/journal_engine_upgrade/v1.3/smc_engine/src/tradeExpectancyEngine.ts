import { getPipSize, detectAssetClass, getEstimatedSpreadPips, getDecimalPrecision } from './assetMetrics';
import { SwingPoint } from './types';
import { LiquidityMagnet, resolveDisplayLiquidityMagnet } from './liquidityMagnetDetector';
import { OpposingObstacle } from './opposingObstacleDetector';
import { MacroGateEvaluation } from '../server/macroGateAdapter';
import { estimateDynamicTransactionCost } from '../server/macroOutcomeEvidence';
import { assessPoiRisk, PoiRiskContext } from './poiRiskContext';
import { SetupHierarchy, collectUntakenTargetPrices } from './setupHierarchy';
import { TradeManagementPlan, createManagementPlan } from './tradeManagement';

export interface TradeTargetStep {
  readonly price: number;
  readonly pips: number;
  readonly rr: number;
  readonly label: string;
  readonly action?: string;
  readonly actionable?: boolean;
}

export interface TradeExpectancyPlan {
  readonly version: 'v1.0' | 'v1.1' | 'v1.2' | 'v1.3';
  readonly symbol: string;
  readonly direction: 'long' | 'short';
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly riskDistancePips: number;
  readonly smartStopBufferPips: number;

  readonly tp1: TradeTargetStep;
  readonly tp2: TradeTargetStep;
  readonly tp3: TradeTargetStep;

  readonly primaryRR: number;
  readonly winProbability: number | null;
  readonly expectedValueR: number | null;
  readonly kellyFraction: number | null;
  readonly recommendedRiskPct: number;

  readonly isAdmissible: boolean;
  readonly rejectionReason?: string;
  readonly propFirmGuardPassed?: boolean;
  readonly resolvedLiquidityMagnet?: LiquidityMagnet;
  readonly estimatedCostR?: number;
  readonly netRewardR?: number;
  readonly netRiskRewardRatio?: number;
  readonly probabilityBasis?: 'UNMEASURED';
  readonly targetConstraint?: 'LIQUIDITY' | 'OBSTACLE' | 'SYNTHETIC_FALLBACK';
  readonly stopVolatilitySource?: 'ATR' | 'CANDLE_RANGE' | 'FALLBACK';
  readonly poiRiskFlags?: readonly string[];
  readonly referenceEntryPrice?: number;
  readonly referenceNetRiskRewardRatio?: number;
  readonly admissionBasis?: 'REFERENCE' | 'CONDITIONAL_ENTRY' | 'REJECTED';
  readonly entryRange?: FeasibleEntryRange | null;
  readonly management?: TradeManagementPlan;
  readonly setupHierarchy?: SetupHierarchy;
  readonly liquidityPath?: readonly number[];
}

export interface FeasibleEntryRange {
  readonly low: number;
  readonly high: number;
  readonly minimumNetRR: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly nominalCostDistance: number;
  readonly costBasis: 'FROZEN_ZONE_MAX_ESTIMATE';
}

/** With fixed S, T and cost C: long E <= (T + m*S)/(m+1) - C; short is symmetric. */
export function calculateFeasibleEntryRange(input: {
  direction: 'long' | 'short'; zoneLow: number; zoneHigh: number;
  stopLoss: number; targetPrice: number; nominalCostDistance: number; minimumNetRR: number;
}): FeasibleEntryRange | null {
  const { direction, zoneLow, zoneHigh, stopLoss, targetPrice, nominalCostDistance: cost, minimumNetRR: rr } = input;
  if (![zoneLow, zoneHigh, stopLoss, targetPrice, cost, rr].every(Number.isFinite)
    || zoneLow <= 0 || zoneHigh < zoneLow || cost < 0 || rr <= 0) return null;
  const long = direction === 'long';
  if (long ? stopLoss >= zoneLow || targetPrice <= zoneLow : stopLoss <= zoneHigh || targetPrice >= zoneHigh) return null;
  const boundary = (targetPrice + rr * stopLoss) / (rr + 1) + (long ? -cost : cost);
  // Keep the boundary inside the admissible side despite floating-point cancellation.
  const inward = Math.max(zoneHigh * Number.EPSILON * 8, Number.MIN_VALUE);
  const low = long ? zoneLow : Math.max(zoneLow, boundary + inward);
  const high = long ? Math.min(zoneHigh, boundary - inward) : zoneHigh;
  if (low > high) return null;
  return { low, high, stopLoss, targetPrice, minimumNetRR: rr, nominalCostDistance: cost,
    costBasis: 'FROZEN_ZONE_MAX_ESTIMATE' };
}

export interface CalculateExpectancyInput {
  symbol: string;
  direction: 'long' | 'short';
  zoneLow: number;
  zoneHigh: number;
  currentPrice: number;
  grade: string; // 'A+' | 'A' | 'B+' | 'B'
  totalScore: number; // 0-100
  atr15mPips?: number | null;
  liquidityMagnet?: LiquidityMagnet | null;
  opposingObstacle?: OpposingObstacle | null;
  macroEvaluation?: MacroGateEvaluation | null;
  minimumAcceptableRR?: number; // default 2.0
  swings15m?: readonly SwingPoint[];
  candles15m?: readonly { high: number; low: number; timestamp: number }[];
  currentIndex15m?: number;
  swings1h?: readonly SwingPoint[];
  candles1h?: readonly { high: number; low: number; timestamp: number }[];
  currentIndex1h?: number;
  observedSpreadPips?: number;
  riskBudgetPct?: number;
  poiContext?: PoiRiskContext;
  setupHierarchy?: SetupHierarchy;
}

function getDefaultAtrPips(symbol: string): number {
  const assetClass = detectAssetClass(symbol);
  switch (assetClass) {
    case 'FOREX':
      return 14.0;
    case 'FOREX_JPY':
      return 22.0;
    case 'CRYPTO':
      return 350.0;
    case 'INDEX':
      return 45.0;
    case 'COMMODITY':
      return 28.0;
    default:
      return 15.0;
  }
}

export function calculateTradeExpectancyPlan(input: CalculateExpectancyInput): TradeExpectancyPlan {
  const { symbol, direction, zoneLow, zoneHigh, currentPrice, minimumAcceptableRR = 2 } = input;
  if (![zoneLow, zoneHigh, currentPrice].every(v => Number.isFinite(v) && v > 0) || zoneLow > zoneHigh)
    throw new Error('Invalid price or POI boundaries for target plan');
  if (!Number.isFinite(minimumAcceptableRR) || minimumAcceptableRR <= 0)
    throw new Error('Invalid minimum net risk/reward ratio');
  const pip = getPipSize(symbol);
  const sign = direction === 'long' ? 1 : -1;
  const referenceEntryPrice = currentPrice >= zoneLow && currentPrice <= zoneHigh ? currentPrice : (zoneLow + zoneHigh) / 2;
  const spreadPips = Number.isFinite(input.observedSpreadPips) && input.observedSpreadPips! >= 0
    ? input.observedSpreadPips! : getEstimatedSpreadPips(symbol);
  const ranges = (input.candles15m ?? []).slice(0, (input.currentIndex15m ?? -1) + 1).slice(-20)
    .map(c => (c.high - c.low) / pip).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const suppliedAtr = Number.isFinite(input.atr15mPips) && input.atr15mPips! > 0;
  const stopVolatilitySource = suppliedAtr ? 'ATR' : ranges.length >= 5 ? 'CANDLE_RANGE' : 'FALLBACK';
  const effectiveAtr = suppliedAtr ? input.atr15mPips! : ranges.length >= 5
    ? ranges[Math.floor(ranges.length / 2)] : Math.max(1, Math.min(getDefaultAtrPips(symbol), referenceEntryPrice * 0.005 / pip));
  const smartStopBufferPips = Number(Math.max(2, effectiveAtr * 0.35, spreadPips * 1.5 + 1).toFixed(1));
  const structuralAnchor = input.setupHierarchy?.structuralAnchorUsable
    ? input.setupHierarchy.structuralInvalidationPrice : sign === 1 ? zoneLow : zoneHigh;
  const anchor = sign === 1 ? Math.min(zoneLow, structuralAnchor) : Math.max(zoneHigh, structuralAnchor);
  const stopLoss = anchor - sign * smartStopBufferPips * pip;
  const referenceRisk = Math.abs(referenceEntryPrice - stopLoss);
  // A price-dependent crypto cost is bounded over the entire box, not made smaller by a better entry.
  const costInputs = { symbol, riskDistance: referenceRisk, observedSpreadPips: input.observedSpreadPips };
  const refCosts = estimateDynamicTransactionCost({ ...costInputs, entryPrice: referenceEntryPrice });
  const zoneCosts = estimateDynamicTransactionCost({ ...costInputs, entryPrice: zoneHigh });
  const nominalCostDistance = Math.max(
    refCosts.spreadDistance + refCosts.slippageDistance + refCosts.commissionDistance,
    zoneCosts.spreadDistance + zoneCosts.slippageDistance + zoneCosts.commissionDistance);
  let activeMagnet = input.liquidityMagnet;
  const bestZoneEntry = sign === 1 ? zoneLow : zoneHigh;
  // The closest actionable pool must not be skipped merely to display a larger R multiple.
  if (input.swings15m || input.swings1h) {
    const nearest = resolveDisplayLiquidityMagnet(input.swings15m ?? [], bestZoneEntry, direction, symbol,
      input.candles15m, input.currentIndex15m, input.swings1h, input.candles1h, input.currentIndex1h, 0);
    if (nearest?.isActive && sign * (nearest.priceLevel - bestZoneEntry) > 0 &&
        (!activeMagnet?.isActive || sign * (activeMagnet.priceLevel - bestZoneEntry) <= 0 ||
        Math.abs(nearest.priceLevel - bestZoneEntry) < Math.abs(activeMagnet.priceLevel - bestZoneEntry))) activeMagnet = nearest;
  }
  let targetDistance = referenceRisk * 2.5;
  const liquidityPath = collectUntakenTargetPrices({ direction, entry: bestZoneEntry,
    swings15m: input.swings15m, candles15m: input.candles15m, index15m: input.currentIndex15m,
    swings1h: input.swings1h, candles1h: input.candles1h, index1h: input.currentIndex1h });
  if (activeMagnet?.isActive && sign * (activeMagnet.priceLevel - bestZoneEntry) > 0)
    liquidityPath.push(activeMagnet.priceLevel);
  liquidityPath.sort((a, b) => sign * (a - b));
  let targetConstraint: 'LIQUIDITY' | 'OBSTACLE' | 'SYNTHETIC_FALLBACK' = 'SYNTHETIC_FALLBACK';
  if (activeMagnet?.isActive && sign * (activeMagnet.priceLevel - bestZoneEntry) > 0) {
    targetDistance = sign * (activeMagnet.priceLevel - referenceEntryPrice);
    targetConstraint = 'LIQUIDITY';
  }
  if (liquidityPath.length && (targetConstraint === 'SYNTHETIC_FALLBACK'
      || sign * (liquidityPath[0] - referenceEntryPrice) < targetDistance)) {
    targetDistance = sign * (liquidityPath[0] - referenceEntryPrice);
    targetConstraint = 'LIQUIDITY';
  }
  let obstacleTarget: number | null = null;
  if (input.opposingObstacle?.hasObstacle && input.opposingObstacle.level) {
    const level = input.opposingObstacle.level;
    const edge = sign === 1 ? level.low : level.high;
    obstacleTarget = edge - sign * spreadPips * pip;
    const obstacleRoom = sign * (obstacleTarget - referenceEntryPrice);
    if (obstacleRoom < targetDistance) { targetDistance = obstacleRoom; targetConstraint = 'OBSTACLE'; }
  }
  // Freeze the target before changing any entry reference. Never search for a farther pool to rescue R:R.
  const targetPrice = referenceEntryPrice + sign * targetDistance;
  const referenceNetRiskRewardRatio = (targetDistance - nominalCostDistance) / (referenceRisk + nominalCostDistance);
  const referenceAdmissible = referenceNetRiskRewardRatio >= minimumAcceptableRR;
  const rawRange = calculateFeasibleEntryRange({ direction, zoneLow, zoneHigh, stopLoss,
    targetPrice, nominalCostDistance, minimumNetRR: minimumAcceptableRR });
  const scale = 10 ** getDecimalPrecision(symbol);
  const roundedRange = rawRange ? { ...rawRange,
    low: Math.ceil(rawRange.low * scale) / scale, high: Math.floor(rawRange.high * scale) / scale } : null;
  const possibleRange = roundedRange && roundedRange.low <= roundedRange.high ? roundedRange : null;
  // A synthetic fallback is not physical evidence for rescuing a rejected box.
  const entryRange = referenceAdmissible || targetConstraint !== 'SYNTHETIC_FALLBACK' ? possibleRange : null;
  const isAdmissible = referenceAdmissible || entryRange !== null;
  const entryPrice = referenceAdmissible || !entryRange ? referenceEntryPrice
    : sign === 1 ? entryRange.high : entryRange.low;
  const riskDistance = Math.abs(entryPrice - stopLoss);
  const riskDistancePips = riskDistance / pip;
  const primaryRR = sign * (targetPrice - entryPrice) / riskDistance;
  const estimatedCostR = nominalCostDistance / riskDistance;
  const netRewardR = primaryRR - estimatedCostR;
  const netRiskRewardRatio = netRewardR / (1 + estimatedCostR);
  const step = (rr: number, label: string, action: string): TradeTargetStep => ({
    price: entryPrice + sign * rr * riskDistance,
    pips: Number((rr * riskDistancePips).toFixed(2)), rr: Number(rr.toFixed(3)), label, action, actionable: rr > 0,
  });
  const tp1 = step(Math.min(1.5, primaryRR * 0.6), 'TP1 (Ara Hedef)', 'Kısmi kâr ve BE kararı kullanıcıya aittir.');
  const tp2 = step(primaryRR, 'TP2 (Ana Hedef)', targetConstraint === 'OBSTACLE' ? 'Karşı bölge öncesindeki ulaşılabilir hedef.' : 'En yakın aktif likidite hedefi veya açıkça belirtilen model hedefi.');
  const obstacleRoom = obstacleTarget === null ? Infinity : Math.max(0, sign * (obstacleTarget - entryPrice));
  const runnerRR = Math.max(primaryRR, Math.min(4, obstacleRoom / riskDistance));
  const tp3 = { ...step(runnerRR, 'TP3 (Koşullu Runner)', 'Ek fiyat alanı ve trend devamı gerektirir.'), actionable: runnerRR > primaryRR };
  const macro = input.macroEvaluation;
  const macroRisk = macro?.allowed === false || macro?.macroGateMultiplier === 0 ? 0
    : Math.max(0, Math.min(1, macro?.riskMultiplier ?? 1));
  const riskBudget = Number.isFinite(input.riskBudgetPct) && input.riskBudgetPct! >= 0 ? input.riskBudgetPct! : 0.5;
  const management = isAdmissible ? createManagementPlan({ direction, entryPrice, stopLoss,
    primaryTarget: targetPrice, nominalCostDistance, stopBufferDistance: smartStopBufferPips * pip,
    liquidityPrices: liquidityPath, maximumTargetPrice: obstacleTarget ?? undefined }) : undefined;
  return {
    version: 'v1.3', symbol, direction, entryPrice, stopLoss, riskDistancePips, smartStopBufferPips,
    tp1, tp2, tp3, primaryRR,
    // A grade is a rule score, not an empirical success probability or a Kelly input.
    winProbability: null, expectedValueR: null, kellyFraction: null, probabilityBasis: 'UNMEASURED',
    recommendedRiskPct: Number((riskBudget * macroRisk).toFixed(3)),
    estimatedCostR, netRewardR: Number(netRewardR.toFixed(3)), netRiskRewardRatio: Number(netRiskRewardRatio.toFixed(3)), targetConstraint, stopVolatilitySource,
    referenceEntryPrice, referenceNetRiskRewardRatio: Number(referenceNetRiskRewardRatio.toFixed(3)), entryRange,
    management, setupHierarchy: input.setupHierarchy, liquidityPath,
    admissionBasis: !isAdmissible ? 'REJECTED' : referenceAdmissible ? 'REFERENCE' : 'CONDITIONAL_ENTRY',
    isAdmissible,
    rejectionReason: isAdmissible ? undefined : `Asimetrik R:R yetersiz: maliyet sonrası oran ${netRiskRewardRatio.toFixed(2)} < ${minimumAcceptableRR.toFixed(2)} (${targetConstraint}).`,
    propFirmGuardPassed: isAdmissible,
    poiRiskFlags: assessPoiRisk(input.poiContext),
    resolvedLiquidityMagnet: activeMagnet?.isActive ? activeMagnet : undefined,
  };
}

/** A refreshed macro gate can resize risk without silently rebuilding the frozen geometry. */
export function applyMacroRiskToPlan(plan: TradeExpectancyPlan, macro: MacroGateEvaluation, riskBudgetPct = 0.5): TradeExpectancyPlan {
  const multiplier = macro.allowed === false || macro.macroGateMultiplier === 0 ? 0
    : Number.isFinite(macro.riskMultiplier) ? Math.max(0, Math.min(1, macro.riskMultiplier)) : 0;
  return { ...plan, recommendedRiskPct: Number((riskBudgetPct * multiplier).toFixed(3)) };
}
