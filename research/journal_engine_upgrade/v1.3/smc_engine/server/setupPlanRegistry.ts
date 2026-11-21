import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { NotificationCandidate } from './pipeline';
import type { StoredCandle, Symbol } from './candleStore';
import { detectSwings } from '../src/swingDetector';
import { detectStructure } from '../src/structureDetector';
import { detectAllOrderBlocks } from '../src/obDetector';
import { detectAllFVGs } from '../src/fvgDetector';
import { detectOpposingObstacle } from '../src/opposingObstacleDetector';
import { calculateTradeExpectancyPlan, applyMacroRiskToPlan } from '../src/tradeExpectancyEngine';
import { MacroGateAdapter } from './macroGateAdapter';
import { getPipSize } from '../src/assetMetrics';

export interface SetupNodeRecord {
  nodeId: string; setupId: string; signalId: string; symbol: string; direction: 'long' | 'short';
  zoneLow: number; zoneHigh: number; firstObservedAt: number; observedAt: number;
  phase: 'WAITING_RETEST' | 'TOUCHED' | 'INVALIDATED'; invalidatedAt?: number;
  plan: NonNullable<NotificationCandidate['expectancyPlan']>;
  originalPlan: NonNullable<NotificationCandidate['expectancyPlan']>;
  grade: string; score: number; atr15mPips?: number | null;
  revision: number; macroAllowed: boolean | null; lastMarketTimestamp: number;
  targetAlreadyTaken?: boolean;
}

export class SetupPlanRegistry {
  private nodes: Record<string, SetupNodeRecord> = {};
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'setup-revisions.jsonl');
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line); this.nodes[record.node.nodeId] = record.node;
    }
  }
  list(): SetupNodeRecord[] { return Object.values(this.nodes).sort((a, b) => b.observedAt - a.observedAt); }
  get(nodeId: string): SetupNodeRecord | undefined { return this.nodes[nodeId]; }
  register(candidate: NotificationCandidate, nowMs: number): void {
    const plan = candidate.expectancyPlan, hierarchy = candidate.setupHierarchy;
    if (!plan?.management || !hierarchy) return;
    const existing = this.nodes[hierarchy.nodeId];
    if (existing?.phase === 'INVALIDATED') return;
    const node: SetupNodeRecord = { nodeId: hierarchy.nodeId, setupId: hierarchy.setupId,
      signalId: candidate.signalId ?? candidate.uniqueKey, symbol: candidate.symbol, direction: candidate.tradeDirection,
      zoneLow: hierarchy.originalZone.low, zoneHigh: hierarchy.originalZone.high,
      firstObservedAt: existing?.firstObservedAt ?? nowMs, observedAt: nowMs,
      phase: existing?.phase ?? 'WAITING_RETEST', plan, originalPlan: existing?.originalPlan ?? plan,
      grade: candidate.gradeResult.grade, score: candidate.gradeResult.totalScore, atr15mPips: candidate.atr15mPips,
      revision: (existing?.revision ?? 0) + 1, macroAllowed: candidate.macroEvaluation?.allowed ?? null,
      lastMarketTimestamp: candidate.marketDataTimestamp ?? 0 };
    this.save(node);
  }
  refresh(symbol: Symbol, candles15m: readonly StoredCandle[], candles1h: readonly StoredCandle[], nowMs: number): void {
    const m15 = candles15m.filter(c => c.timestamp + 900_000 <= nowMs);
    const h1 = candles1h.filter(c => c.timestamp + 3_600_000 <= nowMs);
    if (m15.length < 5) return;
    const last = m15[m15.length - 1];
    const recentRanges = m15.slice(Math.max(1, m15.length - 14)).map((bar, index) => {
      const previous = m15[Math.max(1, m15.length - 14) + index - 1].close;
      return Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    });
    const currentAtr = recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length / getPipSize(symbol);
    const sw15 = detectSwings(m15), sw1 = detectSwings(h1);
    const st15 = detectStructure(m15, sw15), st1 = detectStructure(h1, sw1);
    const obs = detectAllOrderBlocks(m15, st15.events), fvgs = detectAllFVGs(m15, st15.events, symbol, '15m');
    const obs1 = detectAllOrderBlocks(h1, st1.events), fvgs1 = detectAllFVGs(h1, st1.events, symbol, '1h');
    for (const old of this.list().filter(n => n.symbol === symbol && n.phase !== 'INVALIDATED' && n.lastMarketTimestamp < last.timestamp)) {
      const fresh = m15.filter(c => c.timestamp > old.lastMarketTimestamp);
      const broken = fresh.find(c => old.direction === 'long' ? c.close < old.zoneLow : c.close > old.zoneHigh);
      const touched = fresh.some(c => c.low <= old.zoneHigh && c.high >= old.zoneLow);
      const node: SetupNodeRecord = { ...old, observedAt: nowMs, revision: old.revision + 1, lastMarketTimestamp: last.timestamp,
        phase: broken ? 'INVALIDATED' : touched ? 'TOUCHED' : old.phase,
        invalidatedAt: broken ? broken.timestamp + 900_000 : undefined };
      if (!broken) {
        node.atr15mPips = currentAtr;
        const obstacle = detectOpposingObstacle({ symbol, tradeDirection: old.direction,
          entryZone: { low: old.zoneLow, high: old.zoneHigh }, activeOrderBlocks15m: obs, activeFVGs15m: fvgs,
          activeOrderBlocks1h: obs1, activeFVGs1h: fvgs1, closedCandles15m: m15, closedCandles1h: h1 });
        const macro = MacroGateAdapter.getInstance().evaluateCandidate(symbol, old.direction, old.score);
        node.macroAllowed = macro.allowed;
        node.plan = calculateTradeExpectancyPlan({ symbol, direction: old.direction, zoneLow: old.zoneLow, zoneHigh: old.zoneHigh,
          currentPrice: last.close, grade: old.grade, totalScore: old.score, atr15mPips: currentAtr,
          setupHierarchy: old.originalPlan.setupHierarchy, opposingObstacle: obstacle,
          swings15m: sw15, candles15m: m15, currentIndex15m: m15.length - 1,
          swings1h: sw1, candles1h: h1, currentIndex1h: h1.length - 1, macroEvaluation: macro });
        node.plan = applyMacroRiskToPlan(node.plan, macro);
      }
      const originalTarget = old.originalPlan.tp2.price;
      node.targetAlreadyTaken = old.targetAlreadyTaken || fresh.some(c => old.direction === 'long' ? c.high >= originalTarget : c.low <= originalTarget);
      this.save(node);
    }
  }
  private save(node: SetupNodeRecord): void {
    const digest = createHash('sha256').update(JSON.stringify(node.plan)).digest('hex');
    fs.appendFileSync(path.join(this.directory, 'setup-revisions.jsonl'), JSON.stringify({ recordedAt: new Date().toISOString(),
      planHash: digest, node }) + '\n');
    this.nodes[node.nodeId] = node;
  }
}
