export interface ManagementTarget {
  id: string; price: number; fraction: number; basis: 'LIQUIDITY' | 'PLANNED_MAIN';
}

export interface TradeManagementPlan {
  version: 'management-v1.3'; direction: 'long' | 'short';
  entryPrice: number; initialStop: number; riskDistance: number;
  nominalCostDistance: number; stopBufferDistance: number;
  targets: ManagementTarget[];
  estimatedNetBreakEvenPrice: number;
  protection: 'AFTER_PARTIAL_CLOSED_BAR_THEN_CONFIRMED_SWING';
  costModel: 'ESTIMATED';
}

export interface ManagementExit {
  id: string; timestamp: number; price: number; fraction: number;
  reason: string; costDistance: number;
}

export interface ManagementState {
  plan: TradeManagementPlan; entryTimestamp: number; remainingFraction: number;
  exits: ManagementExit[]; activeStop: number; protectionActive: boolean;
  lastProcessedBarTimestamp: number; maximumFavorableR: number; maximumAdverseR: number;
  ambiguousIntracandleConflict: boolean; closed: boolean;
}

const signOf = (direction: 'long' | 'short') => direction === 'long' ? 1 : -1;

export function createManagementPlan(input: {
  direction: 'long' | 'short'; entryPrice: number; stopLoss: number; primaryTarget: number;
  nominalCostDistance: number; stopBufferDistance: number; liquidityPrices?: readonly number[];
  maximumTargetPrice?: number;
}): TradeManagementPlan {
  const sign = signOf(input.direction), entry = input.entryPrice;
  if (![entry, input.stopLoss, input.primaryTarget, input.nominalCostDistance, input.stopBufferDistance].every(Number.isFinite)
    || entry <= 0 || sign * (entry - input.stopLoss) <= 0 || sign * (input.primaryTarget - entry) <= 0
    || input.nominalCostDistance < 0 || input.stopBufferDistance < 0) throw new Error('Invalid management geometry');
  const riskDistance = Math.abs(entry - input.stopLoss);
  const prices = [...new Set(input.liquidityPrices ?? [])].filter(price => Number.isFinite(price)
    && sign * (price - entry) > 0 && (input.maximumTargetPrice === undefined
      || sign * (price - input.maximumTargetPrice) <= 0)).sort((a, b) => sign * (a - b));
  const inner = prices.find(price => sign * (price - input.primaryTarget) < -entry * 1e-12);
  const runner = prices.find(price => sign * (price - input.primaryTarget) > entry * 1e-12);
  const targets: ManagementTarget[] = [];
  if (inner !== undefined) targets.push({ id: 'TP1', price: inner, fraction: .5, basis: 'LIQUIDITY' });
  targets.push({ id: 'MAIN', price: input.primaryTarget,
    fraction: (inner !== undefined ? .5 : 1) - (runner !== undefined ? .2 : 0), basis: 'PLANNED_MAIN' });
  if (runner !== undefined) targets.push({ id: 'RUNNER', price: runner, fraction: .2, basis: 'LIQUIDITY' });
  return { version: 'management-v1.3', direction: input.direction, entryPrice: entry,
    initialStop: input.stopLoss, riskDistance, nominalCostDistance: input.nominalCostDistance,
    stopBufferDistance: input.stopBufferDistance, targets,
    estimatedNetBreakEvenPrice: entry + sign * input.nominalCostDistance,
    protection: 'AFTER_PARTIAL_CLOSED_BAR_THEN_CONFIRMED_SWING', costModel: 'ESTIMATED' };
}

export function rebaseManagementToFill(plan: TradeManagementPlan, fillPrice: number, nominalCostDistance = plan.nominalCostDistance): TradeManagementPlan {
  const sign = signOf(plan.direction);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(nominalCostDistance) || nominalCostDistance < 0
      || sign * (fillPrice - plan.initialStop) <= 0
      || plan.targets.some(target => sign * (target.price - fillPrice) <= 0))
    throw new Error('Reported fill is beyond the frozen stop or a planned target; create a new setup instead');
  return { ...plan, targets: plan.targets.map(target => ({ ...target })), entryPrice: fillPrice,
    riskDistance: Math.abs(fillPrice - plan.initialStop), nominalCostDistance,
    estimatedNetBreakEvenPrice: fillPrice + sign * nominalCostDistance };
}

export function createManagementState(plan: TradeManagementPlan, entryTimestamp: number): ManagementState {
  if (!Number.isFinite(entryTimestamp) || entryTimestamp <= 0) throw new Error('Invalid entry timestamp');
  return { plan, entryTimestamp, remainingFraction: 1, exits: [], activeStop: plan.initialStop,
    protectionActive: false, lastProcessedBarTimestamp: entryTimestamp - 1, maximumFavorableR: 0,
    maximumAdverseR: 0, ambiguousIntracandleConflict: false, closed: false };
}

export function recordManagementExit(state: ManagementState, exit: ManagementExit): void {
  const existing = state.exits.find(value => value.id === exit.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(exit)) throw new Error('Exit id already belongs to a different fill');
    return;
  }
  if (state.closed || !exit.id || !Number.isFinite(exit.timestamp) || exit.timestamp < state.entryTimestamp
      || (state.exits.length > 0 && exit.timestamp < state.exits[state.exits.length - 1].timestamp)
      || !Number.isFinite(exit.price) || exit.price <= 0 || !Number.isFinite(exit.fraction)
      || exit.fraction <= 0 || exit.fraction > state.remainingFraction + 1e-9
      || !Number.isFinite(exit.costDistance) || exit.costDistance < 0) throw new Error('Invalid or excessive exit fill');
  state.exits.push({ ...exit, fraction: Math.min(exit.fraction, state.remainingFraction) });
  state.remainingFraction = Math.max(0, 1 - state.exits.reduce((sum, value) => sum + value.fraction, 0));
  state.closed = state.remainingFraction < 1e-9;
}

export function managementResult(state: ManagementState) {
  const sign = signOf(state.plan.direction), risk = state.plan.riskDistance;
  const grossR = state.exits.reduce((sum, exit) => sum + exit.fraction * sign * (exit.price - state.plan.entryPrice) / risk, 0);
  const costR = state.exits.reduce((sum, exit) => sum + exit.fraction * exit.costDistance / risk, 0);
  const bookedDistance = grossR * risk;
  const expectedTotalCostDistance = costR * risk + state.remainingFraction * state.plan.nominalCostDistance;
  const netBreakEvenForRemaining = state.remainingFraction > 1e-9
    ? state.plan.entryPrice + sign * (expectedTotalCostDistance - bookedDistance) / state.remainingFraction : null;
  return { grossBookedR: grossR, bookedCostR: costR, netBookedR: grossR - costR,
    realizedR: state.closed ? grossR : null, netRealizedR: state.closed ? grossR - costR : null,
    totalCostR: state.closed ? costR : null, remainingFraction: state.remainingFraction,
    netBreakEvenForRemaining, costModel: 'ESTIMATED' as const };
}

/** Advice only: no exit is inferred and no order is submitted. Caller supplies closed-bar evidence. */
export function managementProtectionPrice(state: ManagementState, bar: { timestamp: number; close: number },
  confirmedSwing?: { price: number; formedTimestamp: number; confirmedTimestamp: number }): number | null {
  if (state.closed || state.exits.length === 0 || state.exits.some(exit => exit.timestamp > bar.timestamp + 900_000)) return null;
  const sign = signOf(state.plan.direction);
  let price = managementResult(state).netBreakEvenForRemaining!;
  if (confirmedSwing && confirmedSwing.formedTimestamp > state.entryTimestamp
      && confirmedSwing.confirmedTimestamp <= bar.timestamp + 900_000
      && confirmedSwing.confirmedTimestamp > state.entryTimestamp) {
    const structural = confirmedSwing.price - sign * state.plan.stopBufferDistance;
    if (sign * (structural - price) > 0) price = structural;
  }
  return sign * (price - state.activeStop) > 0 && sign * (bar.close - price) > 0 ? price : null;
}

/** Completed M15 only. Existing stop executes first; newly armed protection starts next bar. */
export function processManagementBar(state: ManagementState,
  bar: { timestamp: number; open: number; high: number; low: number; close: number }, nowMs: number,
  confirmedSwing?: { price: number; formedTimestamp: number; confirmedTimestamp: number }): void {
  if (state.closed || bar.timestamp <= state.lastProcessedBarTimestamp || bar.timestamp + 900_000 > nowMs
      || bar.timestamp < state.entryTimestamp) return;
  if (![bar.open, bar.high, bar.low, bar.close].every(price => Number.isFinite(price) && price > 0)
      || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close))
    throw new Error('Invalid OHLC for management');
  const sign = signOf(state.plan.direction), entry = state.plan.entryPrice;
  const hit = (price: number) => sign === 1 ? bar.high >= price : bar.low <= price;
  const stopped = sign === 1 ? bar.low <= state.activeStop : bar.high >= state.activeStop;
  const entryBar = bar.timestamp === state.entryTimestamp;
  const pending = state.plan.targets.filter(target => !state.exits.some(exit => exit.id === target.id));
  if (stopped) {
    state.ambiguousIntracandleConflict ||= pending.some(target => hit(target.price));
    const price = sign === 1 ? Math.min(bar.open, state.activeStop) : Math.max(bar.open, state.activeStop);
    state.maximumAdverseR = Math.max(state.maximumAdverseR, Math.max(0, sign * (entry - price) / state.plan.riskDistance));
    recordManagementExit(state, { id: `STOP:${bar.timestamp}`, timestamp: bar.timestamp,
      price, fraction: state.remainingFraction, reason: state.protectionActive ? 'PROTECTED_STOP' : 'INITIAL_STOP',
      costDistance: state.plan.nominalCostDistance });
  } else if (!entryBar) {
    state.maximumFavorableR = Math.max(state.maximumFavorableR,
      Math.max(0, sign * ((sign === 1 ? bar.high : bar.low) - entry) / state.plan.riskDistance));
    state.maximumAdverseR = Math.max(state.maximumAdverseR,
      Math.max(0, sign * (entry - (sign === 1 ? bar.low : bar.high)) / state.plan.riskDistance));
    for (const target of pending) {
      if (!hit(target.price) || state.closed) break;
      recordManagementExit(state, { id: target.id, timestamp: bar.timestamp, price: target.price,
        fraction: Math.min(target.fraction, state.remainingFraction), reason: target.id,
        costDistance: state.plan.nominalCostDistance });
    }
    if (!state.closed && state.exits.length > 0) {
      const protectiveStop = managementProtectionPrice(state, bar, confirmedSwing);
      if (protectiveStop !== null) {
        state.activeStop = protectiveStop;
        state.protectionActive = true;
      }
    }
  }
  state.lastProcessedBarTimestamp = bar.timestamp;
}

export function sizeForCashRisk(plan: TradeManagementPlan, riskCash: number, cashPerPriceUnitPerQuantity: number): number {
  if (!Number.isFinite(riskCash) || riskCash <= 0 || !Number.isFinite(cashPerPriceUnitPerQuantity)
      || cashPerPriceUnitPerQuantity <= 0) throw new Error('Cash risk and explicit instrument/account conversion are required');
  return riskCash / ((plan.riskDistance + plan.nominalCostDistance) * cashPerPriceUnitPerQuantity);
}
