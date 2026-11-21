import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { SetupPlanRegistry } from './setupPlanRegistry';
import { ManagementState, createManagementState, rebaseManagementToFill, recordManagementExit,
  managementResult, sizeForCashRisk, managementProtectionPrice } from '../src/tradeManagement';
import { recordSignalFlowEvent } from './signalFlowMeasurement';
import { detectSwings } from '../src/swingDetector';
import type { StoredCandle } from './candleStore';

export interface ManualPosition {
  id: string; nodeId: string; setupId: string; symbol: string; direction: 'long' | 'short';
  quantity: number; cashPerPriceUnitPerQuantity: number | null;
  source: 'USER_REPORTED_NOT_BROKER_VERIFIED'; recordedAt: number; entryTimestamp: number;
  originalStopLoss: number; actualStopLoss: number;
  deviations: string[]; state: ManagementState;
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name}: positive finite number required`);
  return value;
}
function timestamp(value: unknown): number {
  const time = typeof value === 'string' ? Date.parse(value) : value;
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0 || time > Date.now())
    throw new Error('A valid fill timestamp at or before now is required');
  return time;
}

export class ManualExecutionJournal {
  private readonly positions = new Map<string, ManualPosition>();
  private readonly requests = new Map<string, { hash: string; result: ManualPosition }>();
  private readonly file: string;
  constructor(directory: string, private readonly setups: SetupPlanRegistry,
    private readonly readClosedMarket?: (symbol: string) => readonly StoredCandle[]) {
    fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, 'manual-executions.jsonl');
    if (fs.existsSync(this.file)) for (const line of fs.readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      this.positions.set(record.position.id, record.position);
      this.requests.set(record.eventId, { hash: record.requestHash, result: record.position });
    }
  }
  list() { return [...this.positions.values()].map(position => this.view(position)); }
  preview(input: Record<string, unknown>) {
    const node = this.setups.get(String(input.nodeId));
    if (!node?.plan.management) throw new Error('No current management plan for this setup node');
    const price = positive(input.fillPrice, 'fillPrice');
    const frozen = { ...node.plan.management,
      initialStop: input.actualStopLoss == null ? node.plan.management.initialStop : positive(input.actualStopLoss, 'actualStopLoss') };
    const plan = rebaseManagementToFill(frozen, price);
    const sign = plan.direction === 'long' ? 1 : -1;
    const actualNetRR = (sign * (node.plan.tp2.price - price) - plan.nominalCostDistance)
      / (plan.riskDistance + plan.nominalCostDistance);
    const quantity = input.riskCash !== undefined && input.cashPerPriceUnitPerQuantity !== undefined
      ? sizeForCashRisk(plan, positive(input.riskCash, 'riskCash'), positive(input.cashPerPriceUnitPerQuantity, 'cash conversion')) : null;
    return { plan, actualNetRR, recommendedQuantity: quantity, nodePhase: node.phase, macroAllowed: node.macroAllowed,
      executableRecommendation: node.phase !== 'INVALIDATED' && node.macroAllowed === true && node.plan.isAdmissible
        && !!node.plan.entryRange && price >= node.plan.entryRange.low && price <= node.plan.entryRange.high
        && actualNetRR >= node.plan.entryRange.minimumNetRR,
      note: 'Calculation only. No order is created or routed.' };
  }
  entry(input: Record<string, unknown>) {
    return this.mutate('ENTRY', input, () => {
      const node = this.setups.get(String(input.nodeId));
      if (!node?.plan.management) throw new Error('Unknown setup or unavailable management geometry');
      const fill = positive(input.fillPrice, 'fillPrice'), time = timestamp(input.fillTimestamp);
      const quantity = positive(input.quantity, 'quantity');
      const conversion = input.cashPerPriceUnitPerQuantity == null ? null
        : positive(input.cashPerPriceUnitPerQuantity, 'cash conversion');
      const actualStop = input.actualStopLoss == null ? node.plan.stopLoss : positive(input.actualStopLoss, 'actualStopLoss');
      const sign = node.direction === 'long' ? 1 : -1;
      if (sign * (fill - actualStop) <= 0) throw new Error('The reported initial stop must be on the risk side of entry');
      const deviations: string[] = [];
      if (time < node.firstObservedAt) deviations.push('RETROSPECTIVELY_REPORTED_ENTRY');
      if (node.invalidatedAt && time >= node.invalidatedAt) deviations.push('ENTRY_AFTER_ORIGINAL_M15_INVALIDATION');
      if (actualStop !== node.plan.stopLoss) deviations.push('USER_STOP_DIFFERS_FROM_PLAN');
      if (!node.plan.entryRange || fill < node.plan.entryRange.low || fill > node.plan.entryRange.high) deviations.push('ENTRY_OUTSIDE_NET_RR_BAND');
      let plan = { ...node.plan.management, initialStop: actualStop };
      try { plan = rebaseManagementToFill(plan, fill); } catch {
        deviations.push('FROZEN_TARGETS_NOT_VALID_FOR_REPORTED_FILL');
        // Record the factual execution without inventing a new target or rewriting its risk.
        plan = { ...plan, entryPrice: fill, riskDistance: Math.abs(fill - actualStop), targets: [],
          estimatedNetBreakEvenPrice: fill + sign * plan.nominalCostDistance };
      }
      if ((sign * (node.plan.tp2.price - fill) - plan.nominalCostDistance)
          / (plan.riskDistance + plan.nominalCostDistance) < (node.plan.entryRange?.minimumNetRR ?? 2))
        deviations.push('ACTUAL_STOP_AND_FILL_BELOW_PLANNED_MINIMUM_NET_RR');
      return { id: String(input.eventId), nodeId: node.nodeId, setupId: node.setupId, symbol: node.symbol,
        direction: node.direction, quantity, cashPerPriceUnitPerQuantity: conversion,
        source: 'USER_REPORTED_NOT_BROKER_VERIFIED' as const, recordedAt: Date.now(), entryTimestamp: time,
        originalStopLoss: node.plan.stopLoss, actualStopLoss: actualStop, deviations,
        state: createManagementState(plan, time) };
    });
  }
  exit(input: Record<string, unknown>) {
    return this.mutate('EXIT', input, () => {
      const existing = this.positions.get(String(input.positionId));
      if (!existing) throw new Error('Unknown manual position');
      const position: ManualPosition = JSON.parse(JSON.stringify(existing));
      const quantity = positive(input.quantity, 'exit quantity');
      let costDistance = position.state.plan.nominalCostDistance;
      if (input.costCash !== undefined) {
        if (typeof input.costCash !== 'number' || !Number.isFinite(input.costCash) || input.costCash < 0
            || position.cashPerPriceUnitPerQuantity === null) throw new Error('Observed cost requires nonnegative cash and explicit conversion');
        costDistance = input.costCash / (quantity * position.cashPerPriceUnitPerQuantity);
      }
      recordManagementExit(position.state, { id: String(input.eventId), timestamp: timestamp(input.fillTimestamp),
        price: positive(input.fillPrice, 'exit fillPrice'), fraction: quantity / position.quantity,
        costDistance, reason: 'USER_REPORTED_EXIT' });
      return position;
    });
  }
  private mutate(type: string, input: Record<string, unknown>, build: () => ManualPosition) {
    const id = String(input.eventId ?? '');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new Error('A stable eventId (max 128 characters) is required');
    const hash = createHash('sha256').update(type + canonical(input)).digest('hex');
    const previous = this.requests.get(id);
    if (previous) {
      if (previous.hash !== hash) throw new Error('eventId cannot be reused for a different execution');
      return this.view(previous.result);
    }
    const position = build();
    fs.appendFileSync(this.file, JSON.stringify({ version: 'manual-journal-v1.3', eventId: id, requestHash: hash,
      recordedAt: new Date().toISOString(), type, position }) + '\n');
    this.positions.set(position.id, position); this.requests.set(id, { hash, result: position });
    recordSignalFlowEvent(`MANUAL_REPORTED_${type}`, { eventId: id, positionId: position.id,
      setupId: position.setupId, source: position.source, result: managementResult(position.state) });
    return this.view(position);
  }
  private view(position: ManualPosition) {
    const result = managementResult(position.state);
    const conversion = position.cashPerPriceUnitPerQuantity;
    return { ...position, result, managementAdvice: this.advice(position),
      netBookedPerInitialCostInclusiveRisk: result.netBookedR / (1 + position.state.plan.nominalCostDistance / position.state.plan.riskDistance),
      initialCashRisk: conversion === null ? null : position.quantity * position.state.plan.riskDistance * conversion,
      estimatedNetCashRisk: conversion === null ? null : position.quantity
        * (position.state.plan.riskDistance + position.state.plan.nominalCostDistance) * conversion,
      grossBookedCash: conversion === null ? null : result.grossBookedR * position.quantity * position.state.plan.riskDistance * conversion,
      estimatedNetBookedCash: conversion === null ? null : result.netBookedR * position.quantity * position.state.plan.riskDistance * conversion };
  }
  private advice(position: ManualPosition) {
    const now = Date.now(), bars = (this.readClosedMarket?.(position.symbol) ?? [])
      .filter(bar => bar.timestamp + 900_000 <= now).sort((a, b) => a.timestamp - b.timestamp);
    const last = bars[bars.length - 1];
    const base = { orderRouting: false, actualStopMoveConfirmed: false, automaticExitAssumed: false,
      note: 'Yalnızca yönetim önerisi. Brokerdaki mevcut stop bilinmiyor; uygulanırsa stop yalnızca sıkılaştırılmalı.' };
    if (position.state.closed) return { ...base, status: 'POSITION_REPORTED_CLOSED', suggestedStop: null };
    if (!last || last.timestamp < Math.floor(now / 900_000) * 900_000 - 900_000)
      return { ...base, status: 'NO_FRESH_COMPLETED_M15', suggestedStop: null };
    const eligibleExits = position.state.exits.filter(exit => exit.timestamp <= last.timestamp + 900_000);
    if (!eligibleExits.length) return { ...base, status: 'AWAIT_REPORTED_PARTIAL_AND_M15_CLOSE', suggestedStop: null };
    const state = { ...position.state, exits: eligibleExits,
      remainingFraction: Math.max(0, 1 - eligibleExits.reduce((sum, exit) => sum + exit.fraction, 0)) };
    const swings = detectSwings(bars).filter(swing => swing.type === (position.direction === 'long' ? 'low' : 'high')
      && swing.timestamp > position.entryTimestamp && swing.confirmedAtIndex < bars.length)
      .sort((a, b) => b.formedAtIndex - a.formedAtIndex);
    const swing = swings[0];
    const confirmed = swing ? { price: swing.price, formedTimestamp: swing.timestamp,
      confirmedTimestamp: bars[swing.confirmedAtIndex].timestamp + 900_000 } : undefined;
    return { ...base, status: 'CLOSED_M15_ADVICE_ONLY', basedOnCloseTimestamp: last.timestamp + 900_000,
      suggestedStop: managementProtectionPrice(state, last, confirmed),
      estimatedNetBreakEvenForRemaining: managementResult(state).netBreakEvenForRemaining,
      confirmedSwing: confirmed ?? null };
  }
}
