import { Candle, FVG, OrderBlock, StructureEvent, SwingPoint } from './types';
import { findDisplacementLeg } from './displacementLeg';

export interface SetupHierarchy {
  version: 'structure-v1.3'; setupId: string; nodeId: string;
  role: 'ROOT_OB' | 'INNER_OB' | 'INNER_FVG';
  root: { id: string; low: number; high: number; formedTimestamp: number };
  protectedSwing: { price: number; formedTimestamp: number; confirmedTimestamp: number } | null;
  structuralInvalidationPrice: number;
  structuralAnchorUsable: boolean;
  originalZone: { low: number; high: number };
  breakTimestamp: number;
  members: { id: string; type: 'OB' | 'FVG'; low: number; high: number; formedTimestamp: number }[];
}

export function buildSetupHierarchy(input: {
  symbol: string; direction: 'long' | 'short'; poiType: 'OB' | 'FVG'; poi: OrderBlock | FVG;
  candles: readonly Candle[]; swings: readonly SwingPoint[]; orderBlocks: readonly OrderBlock[]; fvgs: readonly FVG[];
}): SetupHierarchy {
  const { candles, direction, poi } = input;
  const event = poi.relatedEvent;
  const sign = direction === 'long' ? 1 : -1;
  const leg = findDisplacementLeg([...candles], event);
  const zone = input.poiType === 'OB' ? { low: (poi as OrderBlock).low, high: (poi as OrderBlock).high }
    : { low: (poi as FVG).gapLow, high: (poi as FVG).gapHigh };
  const swing = input.swings.filter(s => s.type === (sign === 1 ? 'low' : 'high')
    && s.confirmedAtIndex <= event.breakCandleIndex && s.formedAtIndex <= leg.startIndex
    && Number.isFinite(s.price) && (sign === 1 ? s.price <= zone.low : s.price >= zone.high))
    .sort((a, b) => b.formedAtIndex - a.formedAtIndex || b.confirmedAtIndex - a.confirmedAtIndex)[0];
  const originTimestamp = swing?.timestamp ?? candles[Math.max(0, leg.startIndex - 1)].timestamp;
  const setupId = `${input.symbol}:15m:${direction}:origin:${originTimestamp}`;
  const members: SetupHierarchy['members'] = [];
  const add = (type: 'OB' | 'FVG', value: OrderBlock | FVG) => {
    const formedIndex = type === 'OB' ? (value as OrderBlock).formedAtIndex : (value as FVG).middleCandleIndex;
    const formedTimestamp = candles[formedIndex]?.timestamp;
    if (!Number.isFinite(formedTimestamp) || formedTimestamp < originTimestamp || formedTimestamp > event.breakTimestamp
      || value.relatedEvent.direction !== event.direction || value.relatedEvent.breakTimestamp > event.breakTimestamp) return;
    const low = type === 'OB' ? (value as OrderBlock).low : (value as FVG).gapLow;
    const high = type === 'OB' ? (value as OrderBlock).high : (value as FVG).gapHigh;
    members.push({ id: `${setupId}:${type}:${formedTimestamp}:${low}:${high}`, type, low, high, formedTimestamp });
  };
  input.orderBlocks.forEach(ob => add('OB', ob)); input.fvgs.forEach(fvg => add('FVG', fvg));
  const formedIndex = input.poiType === 'OB' ? (poi as OrderBlock).formedAtIndex : (poi as FVG).middleCandleIndex;
  const formedTimestamp = candles[formedIndex].timestamp;
  const nodeId = `${setupId}:${input.poiType}:${formedTimestamp}:${zone.low}:${zone.high}`;
  if (!members.some(node => node.id === nodeId)) members.push({ id: nodeId, type: input.poiType, ...zone, formedTimestamp });
  const root = members.filter(node => node.type === 'OB')
    .sort((a, b) => sign === 1 ? a.low - b.low || a.formedTimestamp - b.formedTimestamp
      : b.high - a.high || a.formedTimestamp - b.formedTimestamp)[0]
    ?? { id: nodeId, ...zone, formedTimestamp };
  const protectedSwing = swing ? { price: swing.price, formedTimestamp: swing.timestamp,
    confirmedTimestamp: candles[swing.confirmedAtIndex].timestamp + 900_000 } : null;
  const anchor = sign === 1 ? Math.min(root.low, protectedSwing?.price ?? root.low, zone.low)
    : Math.max(root.high, protectedSwing?.price ?? root.high, zone.high);
  const anchorBroken = candles.slice(event.breakCandleIndex + 1).some(c => sign === 1 ? c.close < anchor : c.close > anchor);
  return { version: 'structure-v1.3', setupId, nodeId,
    role: input.poiType === 'FVG' ? 'INNER_FVG' : root.id === nodeId ? 'ROOT_OB' : 'INNER_OB',
    root, protectedSwing, structuralInvalidationPrice: anchor, structuralAnchorUsable: !anchorBroken,
    originalZone: zone, breakTimestamp: event.breakTimestamp, members };
}

/** All targets are confirmed at decision time and not taken by a later completed candle. */
export function collectUntakenTargetPrices(input: {
  direction: 'long' | 'short'; entry: number;
  swings15m?: readonly SwingPoint[]; candles15m?: readonly Pick<Candle, 'timestamp' | 'high' | 'low'>[]; index15m?: number;
  swings1h?: readonly SwingPoint[]; candles1h?: readonly Pick<Candle, 'timestamp' | 'high' | 'low'>[]; index1h?: number;
}): number[] {
  const sign = input.direction === 'long' ? 1 : -1;
  const prices = new Set<number>();
  const add = (swings: readonly SwingPoint[] = [], candles: readonly Pick<Candle, 'timestamp' | 'high' | 'low'>[] = [],
    endIndex = candles.length - 1) => {
    for (const swing of swings) {
      if (swing.confirmedAtIndex > endIndex || swing.type !== (sign === 1 ? 'high' : 'low')
        || sign * (swing.price - input.entry) <= 0) continue;
      if (candles.slice(swing.formedAtIndex + 1, endIndex + 1).some(c => sign === 1 ? c.high >= swing.price : c.low <= swing.price)) continue;
      prices.add(swing.price);
    }
  };
  add(input.swings15m, input.candles15m, input.index15m);
  add(input.swings1h, input.candles1h, input.index1h);
  return [...prices].sort((a, b) => sign * (a - b));
}
