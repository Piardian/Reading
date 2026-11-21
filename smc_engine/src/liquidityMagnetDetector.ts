import { SwingPoint } from './types';
import { getPipSize, detectAssetClass, getEstimatedSpreadPips, getDecimalPrecision } from './assetMetrics';

export interface InducementMagnetOptions {
  readonly atr15mPips?: number | null;
  readonly maxDistancePips?: number;
}

export interface LiquidityMagnet {
  type: 'EQH' | 'EQL';
  priceLevel: number;
  pointsCount: number;
  distancePips: number;
  isActive: boolean;
  status?: 'ACTIVE' | 'TAKEN' | 'INVALIDATED';
  firstTakenAt?: number | null;
  sourceSwingTimestamps?: readonly number[];
  description: string;
}
function getTolerance(symbol: string, refPrice: number): number {
  const assetClass = detectAssetClass(symbol);
  const pip = getPipSize(symbol);
  switch (assetClass) {
    case 'FOREX':
      return 2.5 * pip;
    case 'FOREX_JPY':
      return 3.5 * pip;
    case 'CRYPTO':
    case 'INDEX':
    case 'COMMODITY':
      return refPrice * 0.002;
    default:
      return 3.0 * pip;
  }
}
export function detectLiquidityMagnet(
  swings: readonly SwingPoint[],
  currentPrice: number,
  tradeDirection: 'long' | 'short',
  symbol: string,
  candles?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex?: number,
  minDistancePips?: number
): LiquidityMagnet | null {
  if (!swings || swings.length < 2) return null;

  const pip = getPipSize(symbol);
  const tolerance = getTolerance(symbol, currentPrice);

  if (tradeDirection === 'long') {
    const highs = swings.filter(s => s.type === 'high' && s.price > currentPrice);
    if (highs.length < 2) return null;

    const candidates: LiquidityMagnet[] = [];
    for (let i = 0; i < highs.length; i++) {
      const cluster = [highs[i]];
      for (let j = i + 1; j < highs.length; j++) {
        if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
          cluster.push(highs[j]);
        }
      }

      if (cluster.length >= 2) {
        const avgPrice = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const distancePips = Math.round(((avgPrice - currentPrice) / pip) * 10) / 10;
        if (minDistancePips !== undefined && distancePips < minDistancePips) {
          continue;
        }
        const firstTakenAt = findTakenAt('EQH', avgPrice, cluster, candles, currentIndex);
        candidates.push({
          type: 'EQH',
          priceLevel: avgPrice,
          pointsCount: cluster.length,
          distancePips,
          isActive: firstTakenAt === null,
          status: firstTakenAt === null ? 'ACTIVE' : 'TAKEN',
          firstTakenAt,
          sourceSwingTimestamps: cluster.map(point => point.timestamp),
          description: `EQH (Esit Tepeler - BSL Miknatisi): ${cluster.length} tepe @ ${avgPrice.toFixed(4)} (${distancePips} pip yukarida)`,
        });
      }
    }
    return selectBestMagnet(candidates);
  } else {
    const lows = swings.filter(s => s.type === 'low' && s.price < currentPrice);
    if (lows.length < 2) return null;

    const candidates: LiquidityMagnet[] = [];
    for (let i = 0; i < lows.length; i++) {
      const cluster = [lows[i]];
      for (let j = i + 1; j < lows.length; j++) {
        if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
          cluster.push(lows[j]);
        }
      }

      if (cluster.length >= 2) {
        const avgPrice = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const distancePips = Math.round(((currentPrice - avgPrice) / pip) * 10) / 10;
        if (minDistancePips !== undefined && distancePips < minDistancePips) {
          continue;
        }
        const firstTakenAt = findTakenAt('EQL', avgPrice, cluster, candles, currentIndex);
        candidates.push({
          type: 'EQL',
          priceLevel: avgPrice,
          pointsCount: cluster.length,
          distancePips,
          isActive: firstTakenAt === null,
          status: firstTakenAt === null ? 'ACTIVE' : 'TAKEN',
          firstTakenAt,
          sourceSwingTimestamps: cluster.map(point => point.timestamp),
          description: `EQL (Esit Dipler - SSL Miknatisi): ${cluster.length} dip @ ${avgPrice.toFixed(4)} (${distancePips} pip asagida)`,
        });
      }
    }
    return selectBestMagnet(candidates);
  }

  return null;
}

export function resolveMaxInducementDistancePips(
  symbol: string,
  zone: { low: number; high: number },
  candles?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex?: number,
  options?: InducementMagnetOptions
): number {
  if (options?.maxDistancePips !== undefined && Number.isFinite(options.maxDistancePips) && options.maxDistancePips >= 0) {
    return options.maxDistancePips;
  }

  const pip = getPipSize(symbol);
  const assetClass = detectAssetClass(symbol);
  const midPrice = Math.max(pip, (zone.low + zone.high) / 2);
  const zoneHeightPips = Math.max(0, (zone.high - zone.low) / pip);

  let effectiveAtrPips: number;
  if (options?.atr15mPips !== undefined && options.atr15mPips !== null && Number.isFinite(options.atr15mPips) && options.atr15mPips > 0) {
    effectiveAtrPips = options.atr15mPips;
  } else {
    const endSlice = currentIndex !== undefined && currentIndex >= 0 ? currentIndex + 1 : (candles?.length ?? 0);
    const ranges = (candles ?? [])
      .slice(0, endSlice)
      .slice(-20)
      .map(c => (c.high - c.low) / pip)
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    if (ranges.length >= 5) {
      effectiveAtrPips = ranges[Math.floor(ranges.length / 2)];
    } else {
      switch (assetClass) {
        case 'FOREX':
          effectiveAtrPips = 12.0;
          break;
        case 'FOREX_JPY':
          effectiveAtrPips = 18.0;
          break;
        case 'COMMODITY':
          effectiveAtrPips = (midPrice * 0.0018) / pip;
          break;
        case 'INDEX':
          effectiveAtrPips = (midPrice * 0.0020) / pip;
          break;
        case 'CRYPTO':
          effectiveAtrPips = (midPrice * 0.0038) / pip;
          break;
        default:
          effectiveAtrPips = 12.0;
      }
    }
  }

  const spreadPips = getEstimatedSpreadPips(symbol);
  const smartStopBufferPips = Math.max(2, effectiveAtrPips * 0.35, spreadPips * 1.5 + 1);
  const stopSweepReachPips = Math.max(effectiveAtrPips * 0.90, zoneHeightPips * 0.75);
  const dynamicMaxPips = smartStopBufferPips + stopSweepReachPips;

  let floorPips: number;
  let ceilingPips: number;
  switch (assetClass) {
    case 'FOREX':
      floorPips = 10.0;
      ceilingPips = 25.0;
      break;
    case 'FOREX_JPY':
      floorPips = 12.0;
      ceilingPips = 35.0;
      break;
    case 'COMMODITY':
      floorPips = (midPrice * 0.0012) / pip;
      ceilingPips = (midPrice * 0.0040) / pip;
      break;
    case 'INDEX':
      floorPips = (midPrice * 0.0012) / pip;
      ceilingPips = (midPrice * 0.0045) / pip;
      break;
    case 'CRYPTO':
      floorPips = (midPrice * 0.0025) / pip;
      ceilingPips = (midPrice * 0.0085) / pip;
      break;
    default:
      floorPips = 10.0;
      ceilingPips = 25.0;
  }

  const clamped = Math.min(ceilingPips, Math.max(floorPips, dynamicMaxPips));
  return Math.round(clamped * 10) / 10;
}

export function detectInducementMagnet(
  swings: readonly SwingPoint[],
  zone: { low: number; high: number },
  tradeDirection: 'long' | 'short',
  symbol: string,
  candles?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex?: number,
  options?: InducementMagnetOptions
): LiquidityMagnet | null {
  if (!swings || swings.length < 2) return null;

  const pip = getPipSize(symbol);
  const precision = getDecimalPrecision(symbol);
  const midPrice = (zone.low + zone.high) / 2;
  const tolerance = getTolerance(symbol, midPrice);
  const maxDistancePips = resolveMaxInducementDistancePips(symbol, zone, candles, currentIndex, options);

  if (tradeDirection === 'long') {
    // For LONG: Invalidation stop is below zone.low.
    // Inducement trap is an untaken EQL cluster situated right behind zone.low / stop loss (within maxDistancePips).
    const lows = swings.filter(s => s.type === 'low' && s.price < zone.low);
    if (lows.length < 2) return null;

    const candidates: LiquidityMagnet[] = [];
    for (let i = 0; i < lows.length; i++) {
      const cluster = [lows[i]];
      for (let j = i + 1; j < lows.length; j++) {
        if (Math.abs(lows[i].price - lows[j].price) <= tolerance) {
          cluster.push(lows[j]);
        }
      }

      if (cluster.length >= 2) {
        const avgPrice = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const distancePips = Math.round(((zone.low - avgPrice) / pip) * 10) / 10;
        if (distancePips > maxDistancePips) {
          continue;
        }
        const firstTakenAt = findTakenAt('EQL', avgPrice, cluster, candles, currentIndex);
        candidates.push({
          type: 'EQL',
          priceLevel: avgPrice,
          pointsCount: cluster.length,
          distancePips,
          isActive: firstTakenAt === null,
          status: firstTakenAt === null ? 'ACTIVE' : 'TAKEN',
          firstTakenAt,
          sourceSwingTimestamps: cluster.map(point => point.timestamp),
          description: `EQL Inducement Tuzagi: ${cluster.length} dip @ ${avgPrice.toFixed(precision)} (${distancePips} pip stop altinda)`,
        });
      }
    }
    return selectBestMagnet(candidates);
  } else {
    // For SHORT: Invalidation stop is above zone.high.
    // Inducement trap is an untaken EQH cluster situated right behind zone.high / stop loss (within maxDistancePips).
    const highs = swings.filter(s => s.type === 'high' && s.price > zone.high);
    if (highs.length < 2) return null;

    const candidates: LiquidityMagnet[] = [];
    for (let i = 0; i < highs.length; i++) {
      const cluster = [highs[i]];
      for (let j = i + 1; j < highs.length; j++) {
        if (Math.abs(highs[i].price - highs[j].price) <= tolerance) {
          cluster.push(highs[j]);
        }
      }

      if (cluster.length >= 2) {
        const avgPrice = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
        const distancePips = Math.round(((avgPrice - zone.high) / pip) * 10) / 10;
        if (distancePips > maxDistancePips) {
          continue;
        }
        const firstTakenAt = findTakenAt('EQH', avgPrice, cluster, candles, currentIndex);
        candidates.push({
          type: 'EQH',
          priceLevel: avgPrice,
          pointsCount: cluster.length,
          distancePips,
          isActive: firstTakenAt === null,
          status: firstTakenAt === null ? 'ACTIVE' : 'TAKEN',
          firstTakenAt,
          sourceSwingTimestamps: cluster.map(point => point.timestamp),
          description: `EQH Inducement Tuzagi: ${cluster.length} tepe @ ${avgPrice.toFixed(precision)} (${distancePips} pip stop ustunde)`,
        });
      }
    }
    return selectBestMagnet(candidates);
  }
}

export function resolveDisplayLiquidityMagnet(
  swings15m: readonly SwingPoint[],
  currentPrice: number,
  tradeDirection: 'long' | 'short',
  symbol: string,
  candles15m?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex15m?: number,
  swings1h?: readonly SwingPoint[],
  candles1h?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex1h?: number,
  minDistancePips?: number
): LiquidityMagnet | null {
  const magnet15m = detectLiquidityMagnet(swings15m, currentPrice, tradeDirection, symbol, candles15m, currentIndex15m, minDistancePips);
  if (magnet15m && magnet15m.isActive) {
    return magnet15m;
  }

  if (swings1h && swings1h.length >= 2) {
    const magnet1h = detectLiquidityMagnet(swings1h, currentPrice, tradeDirection, symbol, candles1h, currentIndex1h, minDistancePips);
    if (magnet1h && magnet1h.isActive) {
      return {
        ...magnet1h,
        description: `${magnet1h.description} [1H]`,
      };
    }
  }

  const single15m = detectNearestActiveSwingMagnet(swings15m, currentPrice, tradeDirection, symbol, candles15m, currentIndex15m, '', minDistancePips);
  if (single15m) {
    return single15m;
  }

  if (swings1h && swings1h.length > 0) {
    const single1h = detectNearestActiveSwingMagnet(swings1h, currentPrice, tradeDirection, symbol, candles1h, currentIndex1h, ' [1H]', minDistancePips);
    if (single1h) {
      return single1h;
    }
  }

  // 5. Evaluate Institutional Session Liquidity Pools (PDH / PDL / Asia High / Asia Low)
  if (candles15m && candles15m.length > 0) {
    try {
      const { extractSessionLiquidityPools } = require('./sessionLiquidityDetector');
      const poolsMap = extractSessionLiquidityPools(candles15m as any);
      const evalIndex = currentIndex15m !== undefined ? currentIndex15m : candles15m.length - 1;
      const pools = poolsMap.get(evalIndex);
      if (pools) {
        const pip = getPipSize(symbol);
        if (tradeDirection === 'long') {
          // Look for PDH or Asia High above current price
          const sessionHighs: { level: number; label: string }[] = [];
          if (pools.pdh !== null && pools.pdh > currentPrice) sessionHighs.push({ level: pools.pdh, label: 'PDH' });
          if (pools.asiaHigh !== null && pools.asiaHigh > currentPrice) sessionHighs.push({ level: pools.asiaHigh, label: 'Asia High' });
          sessionHighs.sort((a, b) => a.level - b.level);
          for (const sh of sessionHighs) {
            const distPips = Math.round(((sh.level - currentPrice) / pip) * 10) / 10;
            if (minDistancePips === undefined || distPips >= minDistancePips) {
              return {
                type: 'EQH',
                priceLevel: sh.level,
                pointsCount: 1,
                distancePips: distPips,
                isActive: true,
                status: 'ACTIVE',
                firstTakenAt: null,
                description: `Kurumsal Seans Likidite Miknatisi (${sh.label}): @ ${sh.level.toFixed(4)} (${distPips} pip yukarida)`,
              };
            }
          }
        } else {
          // Look for PDL or Asia Low below current price
          const sessionLows: { level: number; label: string }[] = [];
          if (pools.pdl !== null && pools.pdl < currentPrice) sessionLows.push({ level: pools.pdl, label: 'PDL' });
          if (pools.asiaLow !== null && pools.asiaLow < currentPrice) sessionLows.push({ level: pools.asiaLow, label: 'Asia Low' });
          sessionLows.sort((a, b) => b.level - a.level);
          for (const sl of sessionLows) {
            const distPips = Math.round(((currentPrice - sl.level) / pip) * 10) / 10;
            if (minDistancePips === undefined || distPips >= minDistancePips) {
              return {
                type: 'EQL',
                priceLevel: sl.level,
                pointsCount: 1,
                distancePips: distPips,
                isActive: true,
                status: 'ACTIVE',
                firstTakenAt: null,
                description: `Kurumsal Seans Likidite Miknatisi (${sl.label}): @ ${sl.level.toFixed(4)} (${distPips} pip asagida)`,
              };
            }
          }
        }
      }
    } catch {
      // Fallback safely if sessionLiquidityDetector is not reachable
    }
  }

  return magnet15m;
}

function detectNearestActiveSwingMagnet(
  swings: readonly SwingPoint[],
  currentPrice: number,
  tradeDirection: 'long' | 'short',
  symbol: string,
  candles?: readonly { high: number; low: number; timestamp: number }[],
  currentIndex?: number,
  tfSuffix = '',
  minDistancePips?: number
): LiquidityMagnet | null {
  if (!swings || swings.length === 0) return null;
  const pip = getPipSize(symbol);

  if (tradeDirection === 'long') {
    const activeHighs = swings
      .filter(s => s.type === 'high' && s.price > currentPrice)
      .filter(s => {
        const dist = Math.round(((s.price - currentPrice) / pip) * 10) / 10;
        return minDistancePips === undefined || dist >= minDistancePips;
      })
      .filter(s => findTakenAt('EQH', s.price, [s], candles, currentIndex) === null)
      .sort((a, b) => a.price - b.price);

    if (activeHighs.length === 0) return null;
    const nearest = activeHighs[0];
    const extreme = activeHighs[activeHighs.length - 1];
    const distancePips = Math.round(((nearest.price - currentPrice) / pip) * 10) / 10;
    const majorSuffix = extreme.price > nearest.price ? ` | Ana Tepe: ${extreme.price.toFixed(4)}` : '';
    return {
      type: 'EQH',
      priceLevel: nearest.price,
      pointsCount: 1,
      distancePips,
      isActive: true,
      status: 'ACTIVE',
      firstTakenAt: null,
      sourceSwingTimestamps: [nearest.timestamp],
      description: `BSL (Tekil Tepe Likiditesi - Hedef Miknatis): 1 tepe @ ${nearest.price.toFixed(4)} (${distancePips} pip yukarida)${majorSuffix}${tfSuffix}`,
    };
  }

  const activeLows = swings
    .filter(s => s.type === 'low' && s.price < currentPrice)
    .filter(s => {
      const dist = Math.round(((currentPrice - s.price) / pip) * 10) / 10;
      return minDistancePips === undefined || dist >= minDistancePips;
    })
    .filter(s => findTakenAt('EQL', s.price, [s], candles, currentIndex) === null)
    .sort((a, b) => b.price - a.price);

  if (activeLows.length === 0) return null;
  const nearest = activeLows[0];
  const extreme = activeLows[activeLows.length - 1];
  const distancePips = Math.round(((currentPrice - nearest.price) / pip) * 10) / 10;
  const majorSuffix = extreme.price < nearest.price ? ` | Ana Dip: ${extreme.price.toFixed(4)}` : '';
  return {
    type: 'EQL',
    priceLevel: nearest.price,
    pointsCount: 1,
    distancePips,
    isActive: true,
    status: 'ACTIVE',
    firstTakenAt: null,
    sourceSwingTimestamps: [nearest.timestamp],
    description: `SSL (Tekil Dip Likiditesi - Hedef Miknatis): 1 dip @ ${nearest.price.toFixed(4)} (${distancePips} pip asagida)${majorSuffix}${tfSuffix}`,
  };
}

function selectBestMagnet(candidates: readonly LiquidityMagnet[]): LiquidityMagnet | null {
  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    // Active liquidity is actionable; taken liquidity remains fallback context.
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.distancePips !== b.distancePips) return a.distancePips - b.distancePips;
    if (a.pointsCount !== b.pointsCount) return b.pointsCount - a.pointsCount;
    return a.priceLevel - b.priceLevel;
  })[0];
}

function findTakenAt(
  type: 'EQH' | 'EQL',
  priceLevel: number,
  cluster: readonly SwingPoint[],
  candles: readonly { high: number; low: number; timestamp: number }[] | undefined,
  currentIndex: number | undefined
): number | null {
  if (!candles || currentIndex === undefined) return null;
  // The cluster becomes structurally possible once all source swings have formed.
  // Use the latest formation index so a later confirmation cannot hide an earlier take.
  const startIndex = Math.max(...cluster.map(point => point.formedAtIndex));
  for (let index = startIndex + 1; index <= currentIndex && index < candles.length; index += 1) {
    if (type === 'EQH' && candles[index].high >= priceLevel) return candles[index].timestamp;
    if (type === 'EQL' && candles[index].low <= priceLevel) return candles[index].timestamp;
  }
  return null;
}
