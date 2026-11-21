import { OrderBlock, FVG, Candle } from './types';
import { getPipSize, detectAssetClass } from './assetMetrics';

export interface OpposingObstacle {
  hasObstacle: boolean;
  obstacleType: 'OB' | 'FVG' | null;
  timeframe: '15m' | '1h';
  level: { low: number; high: number } | null;
  distancePips: number;
  warningText: string;
}

export interface ObstacleCheckInput {
  symbol: string;
  tradeDirection: 'long' | 'short';
  entryZone: { low: number; high: number };
  activeOrderBlocks15m: readonly OrderBlock[];
  activeFVGs15m: readonly FVG[];
  activeOrderBlocks1h?: readonly OrderBlock[];
  activeFVGs1h?: readonly FVG[];
  minClearancePips?: number;
  closedCandles15m?: readonly Candle[];
  closedCandles1h?: readonly Candle[];
}

function getDefaultClearancePips(symbol: string): number {
  const assetClass = detectAssetClass(symbol);
  switch (assetClass) {
    case 'FOREX':
      return 25;
    case 'FOREX_JPY':
      return 35;
    case 'CRYPTO':
      return 500;
    default:
      return 30;
  }
}

export function detectOpposingObstacle(input: ObstacleCheckInput): OpposingObstacle {
  const pip = getPipSize(input.symbol);
  const clearance = input.minClearancePips ?? getDefaultClearancePips(input.symbol);
  const candidates: OpposingObstacle[] = [];
  const direction = input.tradeDirection === 'long' ? 1 : -1;
  const boundary = direction === 1 ? input.entryZone.high : input.entryZone.low;
  const add = (type: 'OB' | 'FVG', timeframe: '15m' | '1h', low: number, high: number, bullish: boolean, availableIndex: number) => {
    if (bullish === (direction === 1) || !Number.isFinite(low) || !Number.isFinite(high) || low > high) return;
    const edge = direction === 1 ? low : high;
    const candles = timeframe === '15m' ? input.closedCandles15m : input.closedCandles1h;
    if (candles && Number.isInteger(availableIndex) && candles.slice(availableIndex + 1).some(c => bullish ? c.close < low : c.close > high)) return;
    const overlaps = low <= boundary && high >= boundary;
    const distance = overlaps ? 0 : direction * (edge - boundary) / pip;
    if (distance < 0 || distance > clearance) return;
    candidates.push({ hasObstacle: true, obstacleType: type, timeframe, level: { low, high },
      distancePips: distance,
      warningText: `Karsi Engel: ${distance.toFixed(1)} pip ${direction === 1 ? 'yukarida' : 'asagida'} ${timeframe.toUpperCase()} ${bullish ? 'Bullish' : 'Bearish'} ${type} mevcut (${low.toFixed(4)} - ${high.toFixed(4)})`,
    });
  };
  for (const tf of ['15m', '1h'] as const) {
    for (const ob of (tf === '15m' ? input.activeOrderBlocks15m : input.activeOrderBlocks1h ?? []))
      add('OB', tf, ob.low, ob.high, ob.direction === 'bullish', Math.max(ob.formedAtIndex, ob.relatedEvent.breakCandleIndex));
    for (const fvg of (tf === '15m' ? input.activeFVGs15m : input.activeFVGs1h ?? []))
      add('FVG', tf, fvg.gapLow, fvg.gapHigh, fvg.direction === 'bullish', Math.max(fvg.middleCandleIndex + 1, fvg.relatedEvent.breakCandleIndex));
  }
  candidates.sort((a, b) => a.distancePips - b.distancePips || a.timeframe.localeCompare(b.timeframe) || String(a.obstacleType).localeCompare(String(b.obstacleType)));
  return candidates[0] ?? { hasObstacle: false, obstacleType: null, timeframe: '15m', level: null, distancePips: 0, warningText: '' };
}
