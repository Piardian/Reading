import * as fs from 'fs';
import * as path from 'path';
import { JsonlEvidenceStore, EvidenceStore } from './evidenceStore';
import type { NotificationCandidate } from './pipeline';
import type { StoredCandle } from './candleStore';
import type { OrderBlock, FVG } from '../src/types';
import type { FeasibleEntryRange } from '../src/tradeExpectancyEngine';
import { recordSignalFlowEvent } from './signalFlowMeasurement';
import { detectAssetClass, getPipSize } from '../src/assetMetrics';
import { selectPaperTarget } from '../src/paperOutcomeTracker';
import { FileSignalLedger } from './signalLedger';
import {
  captureMacroSnapshot,
  createFallbackMacroSnapshot,
  FileMacroOutcomeStore,
  MacroOutcomeEvidenceRecord,
  MacroOutcomeStore,
  MacroSnapshot,
  estimateDynamicTransactionCost,
  ForecastHorizonType,
  MacroGatingCohortType,
  classifyPlannedHorizon,
} from './macroOutcomeEvidence';

export type PaperOutcomeType = 'TP' | 'SL' | 'BE' | 'EXPIRED' | 'CANCELLED' | 'UNKNOWN';
type Direction = NotificationCandidate['tradeDirection'];

export interface TrackedSignal {
  signalId: string;
  symbol: string;
  direction: Direction;
  signalTimestamp: number;
  poiType?: 'OB' | 'FVG';
  grade?: string;
  smcScore?: number;
  macroSnapshot?: MacroSnapshot;
  liquidityMagnet?: NotificationCandidate['liquidityMagnet'];
  opposingObstacle?: NotificationCandidate['opposingObstacle'];
  zoneLow: number;
  zoneHigh: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskDistance: number | null;
  targetR?: number;
  entryTriggeredAt: number | null;
  lastProcessedCandleTimestamp: number;
  beArmed: boolean;
  partialTpTaken?: boolean;
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  status: 'WAITING_ENTRY' | 'OPEN' | 'CLOSED';
  outcome?: PaperOutcomeType;
  exitTimestamp?: number;
  exitReason?: string;

  // Measurement & Provenance extensions
  exAnteForecastHorizon: ForecastHorizonType;
  macroGatingCohort: MacroGatingCohortType;
  macroDecisionAtSignal: 'PROCEED' | 'WAIT' | 'BLOCK';
  isShadowCounterfactual: boolean;
  ambiguousIntracandleConflict: boolean;
  signalGeneratedAt: string;
  signalAvailableAtMs?: number;
  candleClosedAt?: string;
  plannedHoldingTimeMs?: number;
  executionPolicyId?: string;
  partialTpEnabled?: boolean;
  executionConfig?: PaperOutcomeTrackerConfig;
  plannedStopLoss?: number;
  plannedTakeProfit?: number;
  plannedEntryRange?: FeasibleEntryRange;
}

interface TrackerState {
  version: 1;
  signals: Record<string, TrackedSignal>;
}

export interface PaperOutcomeTrackerConfig {
  readonly entryExpiryMs: number;
  readonly maxHoldBars: number;
  readonly riskReward: number;
  readonly breakEvenAtR: number;
  readonly stopBufferPips: number;
  readonly partialTpAtR?: number;
  readonly partialTpRatio?: number;
  readonly enablePartialTp?: boolean;
}

const DEFAULT_CONFIG: PaperOutcomeTrackerConfig = Object.freeze({
  entryExpiryMs: 16 * 15 * 60 * 1000,
  maxHoldBars: 32,
  riskReward: 2,
  breakEvenAtR: 1.35,
  stopBufferPips: 2,
  partialTpAtR: 1.2,
  partialTpRatio: 0.5,
  enablePartialTp: false,
});

export function calculateAssetCalibratedStopBuffer(symbol: string, zoneLow: number, zoneHigh: number): number {
  const assetClass = detectAssetClass(symbol);
  const upper = symbol.toUpperCase();
  const zoneWidth = Math.abs(zoneHigh - zoneLow);

  switch (assetClass) {
    case 'FOREX':
      return 2.0 * 0.0001; // 2.0 pips
    case 'FOREX_JPY':
      return 2.5 * 0.01; // 2.5 pips
    case 'COMMODITY':
      if (upper.startsWith('XAU')) {
        return Math.max(1.50, zoneWidth * 0.10);
      }
      return Math.max(0.15, zoneWidth * 0.10);
    case 'INDEX':
      return Math.max(10.0, zoneWidth * 0.10);
    case 'CRYPTO':
      if (upper.startsWith('BTC')) {
        return Math.max(35.0, zoneWidth * 0.10);
      }
      if (upper.startsWith('ETH')) {
        return Math.max(3.50, zoneWidth * 0.10);
      }
      if (upper.startsWith('SOL')) {
        return Math.max(0.35, zoneWidth * 0.10);
      }
      return Math.max(getPipSize(symbol) * 5, zoneWidth * 0.10);
    default:
      return 2.0 * getPipSize(symbol);
  }
}

export function isSliceThroughCandle(
  direction: 'long' | 'short',
  candle: StoredCandle,
  zoneLow: number,
  zoneHigh: number
): boolean {
  if (direction === 'long') {
    return candle.open > zoneLow && candle.close < zoneLow;
  } else {
    return candle.open < zoneHigh && candle.close > zoneHigh;
  }
}

export function evaluateEntryCandleReaction(
  direction: 'long' | 'short',
  candle: StoredCandle,
  zoneLow: number,
  zoneHigh: number
): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return true;

  if (direction === 'long') {
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const lowerWickRatio = lowerWick / range;
    const isBullClose = candle.close >= candle.open;
    // Adverse knife drop: closed bearish with less than 15% lower wick deep in zone
    if (!isBullClose && lowerWickRatio < 0.15 && candle.close <= zoneLow + (zoneHigh - zoneLow) * 0.4) {
      return false;
    }
    return true;
  } else {
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const upperWickRatio = upperWick / range;
    const isBearClose = candle.close <= candle.open;
    // Adverse spike: closed bullish with less than 15% upper wick deep in zone
    if (!isBearClose && upperWickRatio < 0.15 && candle.close >= zoneHigh - (zoneHigh - zoneLow) * 0.4) {
      return false;
    }
    return true;
  }
}

export function touchesZoneWithSpread(
  candle: StoredCandle,
  zoneLow: number,
  zoneHigh: number,
  direction: Direction,
  symbol: string
): boolean {
  const pip = getPipSize(symbol);
  // Spread buffer: Long entry needs Ask <= zoneHigh (Bid <= zoneHigh - spread)
  const spreadDist = pip * 1.0;
  if (direction === 'long') {
    return candle.low + spreadDist <= zoneHigh && candle.high >= zoneLow;
  } else {
    return candle.high - spreadDist >= zoneLow && candle.low <= zoneHigh;
  }
}

export class PaperOutcomeTracker {
  private static instance: PaperOutcomeTracker | null = null;

  private readonly config: PaperOutcomeTrackerConfig;
  private readonly statePath: string;
  private readonly evidenceStore: EvidenceStore;
  private readonly macroOutcomeStore: MacroOutcomeStore;
  private readonly signalLedger: FileSignalLedger;
  private state: TrackerState;

  constructor(options?: {
    readonly statePath?: string;
    readonly evidenceStore?: EvidenceStore;
    readonly macroOutcomeStore?: MacroOutcomeStore;
    readonly signalLedger?: FileSignalLedger;
    readonly config?: Partial<PaperOutcomeTrackerConfig>;
  }) {
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...(options?.config ?? {}) });
    this.statePath = options?.statePath ?? process.env.OUTCOME_LEDGER_PATH ?? (
      process.env.NODE_ENV === 'test'
        ? path.resolve(process.cwd(), 'tests', 'temp_evidence', 'active_outcomes.json')
        : path.resolve(process.cwd(), 'data', 'active_outcomes.json')
    );
    this.evidenceStore = options?.evidenceStore ?? new JsonlEvidenceStore();
    this.macroOutcomeStore = options?.macroOutcomeStore ?? new FileMacroOutcomeStore();
    this.signalLedger = options?.signalLedger ?? new FileSignalLedger();
    this.state = this.loadState();
  }

  public static getInstance(options?: {
    readonly statePath?: string;
    readonly evidenceStore?: EvidenceStore;
    readonly macroOutcomeStore?: MacroOutcomeStore;
    readonly signalLedger?: FileSignalLedger;
    readonly config?: Partial<PaperOutcomeTrackerConfig>;
  }): PaperOutcomeTracker {
    if (!PaperOutcomeTracker.instance) {
      PaperOutcomeTracker.instance = new PaperOutcomeTracker(options);
    }
    return PaperOutcomeTracker.instance;
  }

  public static resetInstance(): void {
    PaperOutcomeTracker.instance = null;
  }

  registerCandidate(
    candidate: NotificationCandidate,
    macroSnapshot?: MacroSnapshot,
    options?: { readonly isShadowCounterfactual?: boolean; readonly observedAtMs?: number }
  ): void {
    const signalId = candidate.signalId ?? candidate.uniqueKey;
    const existing = this.state.signals[signalId];
    if (existing && existing.status !== 'CLOSED') return;
    if (existing?.status === 'CLOSED') return;

    const zone = candidate.poiType === 'OB'
      ? { low: (candidate.poi as OrderBlock).low, high: (candidate.poi as OrderBlock).high }
      : { low: (candidate.poi as FVG).gapLow, high: (candidate.poi as FVG).gapHigh };
    const signalTimestamp = candidate.marketDataTimestamp ?? candidate.signalContext?.timestamp ?? Date.now();

    const registeredAt = options?.observedAtMs ?? Date.now();
    const snapshot = macroSnapshot ?? captureMacroSnapshot(candidate, registeredAt);

    // Ex-ante forecast horizon determined from timeframe structure at signal emission (NOT ex-post holding time)
    const plannedHoldingTimeMs = this.config.maxHoldBars * 15 * 60 * 1000;
    const exAnteForecastHorizon = classifyPlannedHorizon(plannedHoldingTimeMs);

    const macroAllowed = candidate.macroEvaluation?.allowed ?? !['VETO', 'WAIT'].includes(snapshot.macroAction);
    const isShadow = options?.isShadowCounterfactual ?? !macroAllowed;
    const macroGatingCohort: MacroGatingCohortType = macroAllowed
      ? 'MACRO_APPROVED'
      : 'MACRO_BLOCKED';
    const macroDecisionAtSignal = macroAllowed ? 'PROCEED'
      : snapshot.macroAction === 'WAIT' ? 'WAIT' : 'BLOCK';

    this.state.signals[signalId] = {
      signalId,
      symbol: candidate.symbol,
      direction: candidate.tradeDirection,
      signalTimestamp,
      poiType: candidate.poiType,
      grade: candidate.gradeResult?.grade ?? 'B',
      smcScore: candidate.gradeResult?.totalScore ?? 80,
      macroSnapshot: snapshot,
      liquidityMagnet: candidate.liquidityMagnet,
      opposingObstacle: candidate.opposingObstacle,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      riskDistance: null,
      targetR: undefined,
      entryTriggeredAt: null,
      lastProcessedCandleTimestamp: signalTimestamp,
      beArmed: false,
      partialTpTaken: false,
      maximumFavorableExcursion: 0,
      maximumAdverseExcursion: 0,
      status: 'WAITING_ENTRY',
      exAnteForecastHorizon,
      macroGatingCohort,
      macroDecisionAtSignal,
      isShadowCounterfactual: isShadow,
      ambiguousIntracandleConflict: false,
      signalGeneratedAt: new Date(registeredAt).toISOString(),
      signalAvailableAtMs: Math.max(signalTimestamp + 15 * 60000, registeredAt),
      candleClosedAt: new Date(signalTimestamp + 15 * 60000).toISOString(),
      plannedHoldingTimeMs,
      partialTpEnabled: Boolean(this.config.enablePartialTp),
      executionPolicyId: `paper-v3:strict-bar1:sl-first:plan-${candidate.expectancyPlan?.version ?? 'fallback'}${candidate.expectancyPlan?.version === 'v1.2' ? ':fixed-entry-band:closed-m15' : ''}:${JSON.stringify(this.config)}`,
      executionConfig: this.config,
      plannedStopLoss: candidate.expectancyPlan?.version === 'v1.1' || candidate.expectancyPlan?.version === 'v1.2' ? candidate.expectancyPlan.stopLoss : undefined,
      plannedTakeProfit: candidate.expectancyPlan?.version === 'v1.1' || candidate.expectancyPlan?.version === 'v1.2' ? candidate.expectancyPlan.tp2.price : undefined,
      plannedEntryRange: candidate.expectancyPlan?.entryRange ?? undefined,
    };
    this.persist();

    // Record base SIGNAL_ISSUED
    recordSignalFlowEvent('PAPER_REGISTERED', { signalId, symbol: candidate.symbol,
      poiId: candidate.dedupeKey ?? candidate.uniqueKey, signalGeneratedAt: new Date(registeredAt).toISOString(),
      executionPolicyId: this.state.signals[signalId].executionPolicyId, macroAllowed,
      plan: candidate.expectancyPlan ?? null, macroSnapshot: snapshot });
    void this.signalLedger.ensureSignalIssued({
      signalId,
      symbol: candidate.symbol,
      timeframe: '15m',
      direction: candidate.tradeDirection,
      poiType: candidate.poiType,
      signalTimestamp,
      marketDataTimestamp: candidate.marketDataTimestamp ?? null,
      observedMarketPrice: candidate.currentPrice ?? zone.high,
      poiFormedTimestamp: candidate.poiFormedTimestamp ?? signalTimestamp,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      grade: candidate.gradeResult?.grade ?? 'UNKNOWN',
      score: candidate.gradeResult?.totalScore ?? 0,
      entryAllowed: candidate.gradeResult?.entryAllowed ?? true,
      macro: snapshot ? {
        allowed: macroAllowed,
        action: snapshot.macroAction,
        mappedMacroKey: candidate.symbol,
        tradeDirection: candidate.tradeDirection,
        macroBias: snapshot.macroBias,
        primaryRegime: snapshot.primaryRegime,
        riskMultiplier: snapshot.riskMultiplier,
        macroGateMultiplier: snapshot.macroGateMultiplier,
        begonyaScore: snapshot.begonyaScore,
        scoreTier: snapshot.scoreTier,
      } : null,
    }).catch(err => {
      console.warn(`[PaperOutcomeTracker] Ledger ensureSignalIssued failed for ${signalId}:`, err);
    });
  }

  update(symbol: string, candles: readonly StoredCandle[]): void {
    if (candles.length === 0) return;

    let changed = false;
    for (const signal of Object.values(this.state.signals)) {
      if (signal.symbol !== symbol || signal.status === 'CLOSED') continue;

      const newCandles = candles
        .filter(candle => candle.timestamp > signal.lastProcessedCandleTimestamp &&
          candle.timestamp >= (signal.signalAvailableAtMs ?? signal.signalTimestamp) &&
          (!signal.executionPolicyId?.includes('plan-v1.2') || candle.timestamp + 15 * 60_000 <= Date.now()))
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const candle of newCandles) {
        const result = this.processCandle(signal, candle);
        signal.lastProcessedCandleTimestamp = Math.max(signal.lastProcessedCandleTimestamp, candle.timestamp);
        changed = changed || result.changed;
        if (result.closed) break;
      }
    }

    if (changed) this.persist();
  }

  get(signalId: string): TrackedSignal | undefined {
    return this.state.signals[signalId];
  }

  listOpen(): readonly TrackedSignal[] {
    return Object.freeze(Object.values(this.state.signals).filter(signal => signal.status !== 'CLOSED'));
  }

  private processCandle(signal: TrackedSignal, candle: StoredCandle): { changed: boolean; closed: boolean } {
    const config = signal.executionConfig ?? this.config;
    if (signal.status === 'WAITING_ENTRY') {
      if (candle.timestamp - signal.signalTimestamp >= config.entryExpiryMs) {
        this.close(signal, 'EXPIRED', candle.timestamp, 'Entry zone was not triggered before the configured entry window expired.');
        return { changed: true, closed: true };
      }

      const range = signal.plannedEntryRange;
      if (signal.executionPolicyId?.includes('plan-v1.2') &&
          (signal.direction === 'long' ? candle.close < signal.zoneLow : candle.close > signal.zoneHigh)) {
        this.close(signal, 'CANCELLED', candle.timestamp, 'Completed M15 close invalidated the original POI before paper entry.');
        return { changed: true, closed: true };
      }
      const entryLow = range?.low ?? signal.zoneLow;
      const entryHigh = range?.high ?? signal.zoneHigh;
      if (!touchesZoneWithSpread(candle, entryLow, entryHigh, signal.direction, signal.symbol)) {
        return { changed: false, closed: false };
      }

      // Approach Velocity Guard: If candle sliced through without entry confirmation, order was never filled!
      // Must NOT record a filled -1R loss for an unfilled/cancelled setup.
      if (isSliceThroughCandle(signal.direction, candle, signal.zoneLow, signal.zoneHigh)) {
        this.close(
          signal,
          'CANCELLED',
          candle.timestamp,
          'Entry zone sliced through aggressively on entry candle without structural rejection (Approach Velocity breach).'
        );
        return { changed: true, closed: true };
      }

      // Alt Zaman Dilimi Reaksiyon Şartı: Fitil veya absorpsiyon tepkisi olmadan kör limit emir tetiklenmez
      const hasReaction = evaluateEntryCandleReaction(signal.direction, candle, signal.zoneLow, signal.zoneHigh);
      if (!hasReaction) {
        const breached = signal.direction === 'long' ? candle.close < signal.zoneLow : candle.close > signal.zoneHigh;
        if (breached) {
          this.close(signal, 'CANCELLED', candle.timestamp, 'Entry candle breached zone without rejection wick or absorption reaction.');
          return { changed: true, closed: true };
        }
        return { changed: false, closed: false };
      }

      const entryPrice = resolveEntryPrice(signal.direction, entryLow, entryHigh, candle.open, signal.poiType);
      // A touch of part of the box is not proof that the selected paper entry traded.
      if (range && (entryPrice < candle.low || entryPrice > candle.high)) return { changed: false, closed: false };
      const buffer = calculateAssetCalibratedStopBuffer(signal.symbol, signal.zoneLow, signal.zoneHigh);
      const stopLoss = signal.plannedStopLoss ?? (signal.direction === 'long' ? signal.zoneLow - buffer : signal.zoneHigh + buffer);
      if (signal.direction === 'long' ? stopLoss >= entryPrice : stopLoss <= entryPrice) {
        this.close(signal, 'CANCELLED', candle.timestamp, 'Planned stop is no longer on the risk side of the simulated entry.');
        return { changed: true, closed: true };
      }
      const rawRiskDistance = Math.abs(entryPrice - stopLoss);
      // R must use the actual distance to the structural stop.
      const riskDistance = rawRiskDistance;

      if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
        this.close(signal, 'UNKNOWN', candle.timestamp, 'Invalid synthetic risk distance prevented deterministic outcome calculation.');
        return { changed: true, closed: true };
      }
      const initialCosts = estimateDynamicTransactionCost({
        symbol: signal.symbol, riskDistance, entryPrice,
        vixLevel: signal.macroSnapshot?.vixLevel,
        newsFreezeActive: signal.macroSnapshot?.newsFreezeActive,
        minutesToNewsEvent: signal.macroSnapshot?.minutesToNewsEvent,
      });
      const entryCostDistance = Math.max(range?.nominalCostDistance ?? 0,
        initialCosts.spreadDistance + initialCosts.slippageDistance + initialCosts.commissionDistance);
      if (range && (signal.direction === 'long' ? range.targetPrice - entryPrice : entryPrice - range.targetPrice)
          - entryCostDistance < range.minimumNetRR * (riskDistance + entryCostDistance))
        return { changed: false, closed: false };

      const targetSelection = selectPaperTarget({
        entryPrice,
        stopLossPrice: stopLoss,
        tradeDirection: signal.direction,
        symbol: signal.symbol,
        liquidityMagnet: signal.liquidityMagnet,
        opposingObstacle: signal.opposingObstacle,
      });

      const targetR = signal.plannedTakeProfit !== undefined
        ? (signal.direction === 'long' ? signal.plannedTakeProfit - entryPrice : entryPrice - signal.plannedTakeProfit) / riskDistance
        : Math.max(2.0, Math.min(5.0, targetSelection.targetR));
      if (!Number.isFinite(targetR) || targetR <= 0) {
        this.close(signal, 'CANCELLED', candle.timestamp, 'Planned target is no longer on the reward side of the simulated entry.');
        return { changed: true, closed: true };
      }
      const takeProfit = signal.direction === 'long'
        ? entryPrice + riskDistance * targetR
        : entryPrice - riskDistance * targetR;

      signal.entryPrice = entryPrice;
      signal.stopLoss = stopLoss;
      signal.takeProfit = takeProfit;
      signal.riskDistance = riskDistance;
      signal.targetR = targetR;
      signal.entryTriggeredAt = candle.timestamp;
      signal.status = 'OPEN';
      recordSignalFlowEvent('PAPER_ENTERED', { signalId: signal.signalId, symbol: signal.symbol,
        entryTimestamp: candle.timestamp, entryPrice, stopLoss, takeProfit, riskDistance,
        executionPolicyId: signal.executionPolicyId });

      void this.signalLedger.recordEntry(signal.signalId, {
        executionSource: 'PAPER',
        entryTimestamp: candle.timestamp,
        entryPrice,
        brokerOrderId: null,
        positionId: null,
        slippageBps: initialCosts.slippageBps,
      }).catch(err => {
        console.warn(`[PaperOutcomeTracker] Ledger recordEntry failed for ${signal.signalId}:`, err);
      });

      const exit = evaluateOpenCandle(signal, candle, true, config);
      if (exit) {
        this.close(signal, exit.type, candle.timestamp, exit.reason);
        return { changed: true, closed: true };
      }
      return { changed: true, closed: false };
    }

    if (signal.status !== 'OPEN' || signal.entryPrice === null || signal.stopLoss === null || signal.takeProfit === null || signal.riskDistance === null) {
      return { changed: false, closed: false };
    }

    const favorable = signal.direction === 'long'
      ? Math.max(0, candle.high - signal.entryPrice)
      : Math.max(0, signal.entryPrice - candle.low);
    const rawAdverse = signal.direction === 'long'
      ? Math.max(0, signal.entryPrice - candle.low)
      : Math.max(0, candle.high - signal.entryPrice);
    const isPartialTpActive = signal.partialTpEnabled ?? Boolean(config.enablePartialTp);
    const partialTpTarget = config.partialTpAtR ?? 1.2;
    const activeStop = signal.beArmed ? signal.entryPrice : signal.stopLoss;
    const stoppedInCandle = signal.direction === 'long' ? candle.low <= activeStop : candle.high >= activeStop;
    // Stop-bar favorable extremes may occur after the position was closed.
    if (!stoppedInCandle) signal.maximumFavorableExcursion = Math.max(signal.maximumFavorableExcursion, favorable / signal.riskDistance);
    signal.maximumAdverseExcursion = Math.max(signal.maximumAdverseExcursion, Math.min(rawAdverse / signal.riskDistance, 1));
    if (isPartialTpActive && !stoppedInCandle && !signal.partialTpTaken && favorable >= signal.riskDistance * partialTpTarget) {
      signal.partialTpTaken = true;
    }

    // Evaluate exit on candle first to prevent same-candle whipsaw from being marked as BE when hitting SL on the very same candle
    const exit = evaluateOpenCandle(signal, candle, false, config);
    if (exit) {
      this.close(signal, exit.type, candle.timestamp, exit.reason);
      return { changed: true, closed: true };
    }

    // Arm BE only if the candle closed or progressed favorably without hitting SL first
    if (!signal.beArmed && favorable >= signal.riskDistance * config.breakEvenAtR) {
      signal.beArmed = true;
    }

    const maxHoldMs = config.maxHoldBars * 15 * 60 * 1000;
    if (signal.entryTriggeredAt !== null && candle.timestamp - signal.entryTriggeredAt >= maxHoldMs) {
      this.close(signal, 'EXPIRED', candle.timestamp, 'Maximum configured holding period elapsed; outcome unresolved without an observed exit.');
      return { changed: true, closed: true };
    }

    return { changed: true, closed: false };
  }

  private close(signal: TrackedSignal, outcome: PaperOutcomeType, timestamp: number, reason: string): void {
    const config = signal.executionConfig ?? this.config;
    signal.status = 'CLOSED';
    signal.outcome = outcome;
    signal.exitTimestamp = timestamp;
    signal.exitReason = reason;

    const isFilledTrade = signal.entryTriggeredAt !== null;
    const exitPrice = resolveSyntheticExitPrice(signal, outcome);
    const targetMultiplier = signal.targetR ?? config.riskReward;
    const isPartialTpActive = signal.partialTpEnabled ?? Boolean(config.enablePartialTp);
    const partialRatio = config.partialTpRatio ?? 0.5;
    const partialR = config.partialTpAtR ?? 1.2;

    // Realized R with Partial TP (TP1) support:
    let rrAchieved: number | null = null;
    if (isFilledTrade) {
      if (outcome === 'TP') {
        rrAchieved = (isPartialTpActive && signal.partialTpTaken)
          ? Number((partialRatio * partialR + (1 - partialRatio) * targetMultiplier).toFixed(2))
          : targetMultiplier;
      } else if (outcome === 'BE') {
        rrAchieved = (isPartialTpActive && signal.partialTpTaken)
          ? Number((partialRatio * partialR).toFixed(2))
          : 0;
      } else if (outcome === 'SL') {
        rrAchieved = (isPartialTpActive && signal.partialTpTaken)
          ? Number((partialRatio * partialR - (1 - partialRatio) * 1.0).toFixed(2))
          : -1;
      }
    }

    const holdingTimeMs = isFilledTrade ? Math.max(0, timestamp - signal.entryTriggeredAt!) : null;

    // Realized holding duration ex-post
    let realizedHoldingDuration: ForecastHorizonType | undefined;
    if (holdingTimeMs !== null) {
      realizedHoldingDuration = holdingTimeMs < 4 * 3600 * 1000
        ? 'SCALP_INTRADAY'
        : (holdingTimeMs <= 24 * 3600 * 1000 ? 'SWING_4H_24H' : 'MULTI_DAY');
    }

    // Dynamic cost calculation (costs only apply to filled trades)
    const snapshot = signal.macroSnapshot ?? createFallbackMacroSnapshot(signal.symbol, signal.direction, signal.signalTimestamp);
    const dynamicCosts = isFilledTrade
      ? estimateDynamicTransactionCost({
          symbol: signal.symbol,
          riskDistance: signal.riskDistance ?? 0,
          entryPrice: signal.entryPrice,
          vixLevel: snapshot.vixLevel,
          newsFreezeActive: snapshot.newsFreezeActive,
          minutesToNewsEvent: snapshot.minutesToNewsEvent,
        })
      : {
          spreadDistance: 0,
          slippageDistance: 0,
          commissionDistance: 0,
          spreadCostR: 0,
          slippageCostR: 0,
          commissionCostR: 0,
          totalCostR: 0,
          slippageBps: 0,
          spreadPips: 0,
        };

    const netRealizedR = rrAchieved !== null
      ? Math.round((rrAchieved - dynamicCosts.totalCostR) * 100) / 100
      : null;

    // 1. Durably update Signal Ledger
    if (isFilledTrade) {
      const exitOutcome = outcome === 'TP' ? 'TAKE_PROFIT'
        : outcome === 'SL' ? 'STOP_LOSS'
        : outcome === 'BE' ? 'BREAK_EVEN'
        : outcome === 'EXPIRED' ? 'EXPIRED'
        : outcome === 'CANCELLED' ? 'CANCELLED'
        : 'UNKNOWN';

      void this.signalLedger.recordExit(signal.signalId, {
        executionSource: 'PAPER',
        exitTimestamp: timestamp,
        exitPrice,
        outcome: exitOutcome,
        realizedR: rrAchieved,
        holdingTimeMs,
        slippageBps: dynamicCosts.slippageBps,
      }).catch(err => {
        console.warn(`[PaperOutcomeTracker] Ledger recordExit failed for ${signal.signalId}:`, err);
      });
    } else {
      void this.signalLedger.recordCancelled(signal.signalId, timestamp, reason).catch(err => {
        console.warn(`[PaperOutcomeTracker] Ledger recordCancelled failed for ${signal.signalId}:`, err);
      });
    }

    // 2. Append enriched Macro Outcome Evidence Record (Schema v2)
    const executionSource: 'TEST' | 'PAPER' | 'LIVE' = process.env.NODE_ENV === 'test'
      ? 'TEST'
      : 'PAPER';

    const macroOutcomeRecord: MacroOutcomeEvidenceRecord = {
      schemaVersion: 2,
      signalId: signal.signalId,
      symbol: signal.symbol,
      direction: signal.direction,
      poiType: signal.poiType ?? 'OB',
      grade: signal.grade ?? 'B',
      smcScore: signal.smcScore ?? 80,
      signalTimestamp: signal.signalTimestamp,
      entryTimestamp: signal.entryTriggeredAt,
      exitTimestamp: timestamp,
      holdingTimeMs,
      outcome,
      realizedR: rrAchieved,
      entryPrice: signal.entryPrice,
      exitPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskDistance: signal.riskDistance,
      maximumFavorableExcursion: signal.maximumFavorableExcursion,
      maximumAdverseExcursion: signal.maximumAdverseExcursion,
      exitReason: reason,
      macroSnapshot: snapshot,

      executionSource,
      entryConfirmed: isFilledTrade,
      fillModel: 'CONSERVATIVE_SL_FIRST',
      spreadCostR: dynamicCosts.spreadCostR,
      slippageCostR: dynamicCosts.slippageCostR,
      commissionCostR: dynamicCosts.commissionCostR,
      totalCostR: dynamicCosts.totalCostR,
      netRealizedR,
      assetClass: detectAssetClass(signal.symbol),
      exAnteForecastHorizon: signal.exAnteForecastHorizon ?? 'UNKNOWN',
      realizedHoldingDuration,
      macroGatingCohort: signal.macroGatingCohort ?? 'SMC_ONLY',
      macroDecisionAtSignal: signal.macroDecisionAtSignal ?? 'PROCEED',

      signalGeneratedAt: signal.signalGeneratedAt ?? new Date(signal.signalTimestamp).toISOString(),
      candleClosedAt: signal.candleClosedAt ?? new Date(signal.signalTimestamp + 15 * 60000).toISOString(),
      entryTriggeredAt: signal.entryTriggeredAt ? new Date(signal.entryTriggeredAt).toISOString() : null,
      exitOccurredAt: new Date(timestamp).toISOString(),
      recordedAt: new Date().toISOString(),
      pipelineLatencyMs: signal.signalGeneratedAt && signal.candleClosedAt
        ? Math.max(0, Date.parse(signal.signalGeneratedAt) - Date.parse(signal.candleClosedAt)) : null,
      decisionEngineVersion: 'paper-measurement-v3',
      ambiguousIntracandleConflict: signal.ambiguousIntracandleConflict,
      measurementVersion: signal.executionPolicyId ? 3 : 2,
      executionPolicyId: signal.executionPolicyId,
      plannedHoldingTimeMs: signal.plannedHoldingTimeMs,
      costModel: 'ESTIMATED',
      evidenceScope: 'SMC_PAPER_WITH_ECONOMIC_MACRO',
    };

    recordSignalFlowEvent('PAPER_CLOSED', macroOutcomeRecord);
    void this.macroOutcomeStore.appendRecord(macroOutcomeRecord).catch(error => {
      console.warn(`[PaperOutcomeTracker] Macro outcome evidence write failed for ${signal.signalId}:`, error);
    });

    // 3. Append legacy outcome evidence
    void this.evidenceStore.appendOutcomeEvidence({
      evidenceSchemaVersion: 1,
      signalId: signal.signalId,
      appendedAt: new Date(timestamp).toISOString(),
      outcome: {
        type: (outcome === 'CANCELLED' ? 'UNKNOWN' : outcome) as any,
        holdingTimeMs,
        rrAchieved,
        maximumFavorableExcursion: signal.maximumFavorableExcursion,
        maximumAdverseExcursion: signal.maximumAdverseExcursion,
        exitTimestamp: timestamp,
        exitReason: reason,
      },
    }).catch(error => {
      console.warn(`[PaperOutcomeTracker] Outcome evidence write failed for ${signal.signalId}:`, error);
    });
  }

  private loadState(): TrackerState {
    try {
      if (!fs.existsSync(this.statePath)) {
        return { version: 1, signals: {} };
      }
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.signals) {
        return parsed as TrackerState;
      }
      return { version: 1, signals: {} };
    } catch {
      return { version: 1, signals: {} };
    }
  }

  private persist(): void {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8');
    try {
      fs.renameSync(temp, this.statePath);
    } catch {
      fs.copyFileSync(temp, this.statePath);
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function resolveEntryPrice(
  direction: Direction,
  zoneLow: number,
  zoneHigh: number,
  candleOpen: number,
  poiType?: 'OB' | 'FVG'
): number {
  if (poiType === 'FVG') {
    // FVG optimal fill: enter at proximal gap boundary for faster fills and less expiry
    return direction === 'long' ? zoneHigh : zoneLow;
  }
  if (direction === 'long') {
    if (candleOpen >= zoneHigh) return zoneHigh;
    if (candleOpen <= zoneLow) return (zoneLow + zoneHigh) / 2;
  } else {
    if (candleOpen <= zoneLow) return zoneLow;
    if (candleOpen >= zoneHigh) return (zoneLow + zoneHigh) / 2;
  }
  return (zoneLow + zoneHigh) / 2;
}

function resolveSyntheticExitPrice(signal: TrackedSignal, outcome: PaperOutcomeType): number | null {
  if (outcome === 'TP') return signal.takeProfit;
  if (outcome === 'SL') return signal.stopLoss;
  if (outcome === 'BE') return signal.entryPrice;
  return null;
}

function evaluateOpenCandle(
  signal: TrackedSignal,
  candle: StoredCandle,
  entryCandle: boolean,
  config: PaperOutcomeTrackerConfig,
): { type: PaperOutcomeType; reason: string; ambiguousConflict?: boolean } | null {
  if (signal.entryPrice === null || signal.stopLoss === null || signal.takeProfit === null) return null;

  const hitsTP = signal.direction === 'long' ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;
  const hitsSL = signal.direction === 'long' ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
  const hitsBE = signal.beArmed && (signal.direction === 'long' ? candle.low <= signal.entryPrice : candle.high >= signal.entryPrice);

  if (hitsTP && hitsSL) {
    // Institutional conservative execution rule: SL assumed hit first during high-volatility intra-candle whipsaw
    signal.ambiguousIntracandleConflict = true;
    return {
      type: signal.beArmed ? 'BE' : 'SL',
      reason: 'Intra-candle conflict: TP and SL both within candle range. Applied conservative worst-case stop execution.',
      ambiguousConflict: true,
    };
  }
  // Entry-bar favorable extremes may precede the fill. Only adverse execution is counted on that bar.
  if (hitsTP && !entryCandle && !hitsBE) return { type: 'TP', reason: `Synthetic take-profit reached at ${signal.targetR ?? config.riskReward}R (Liquidity Target).` };
  if (hitsSL) return { type: signal.beArmed ? 'BE' : 'SL', reason: signal.beArmed ? 'Break-even stop was hit after the BE threshold was armed.' : 'Synthetic stop-loss reached before break-even activation.' };
  if (hitsBE && !entryCandle) return { type: 'BE', reason: 'Break-even threshold was armed and price returned to the synthetic entry.' };
  return null;
}
