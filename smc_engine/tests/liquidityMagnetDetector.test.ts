import {
  detectLiquidityMagnet,
  detectInducementMagnet,
  resolveMaxInducementDistancePips,
} from '../src/liquidityMagnetDetector';
import { SwingPoint } from '../src/types';

describe('Liquidity Magnet Detector (EQH / EQL)', () => {
  it('detects EQH (Equal Highs) above current price for long trade', () => {
    const swings: SwingPoint[] = [
      { type: 'high', price: 1.0550, formedAtIndex: 10, confirmedAtIndex: 12, timestamp: 1000 },
      { type: 'low', price: 1.0500, formedAtIndex: 15, confirmedAtIndex: 17, timestamp: 2000 },
      { type: 'high', price: 1.0551, formedAtIndex: 20, confirmedAtIndex: 22, timestamp: 3000 }, // ~1 pip diff
    ];
    const currentPrice = 1.0520;

    const magnet = detectLiquidityMagnet(swings, currentPrice, 'long', 'EURUSD');
    expect(magnet).not.toBeNull();
    expect(magnet?.type).toBe('EQH');
    expect(magnet?.pointsCount).toBe(2);
    expect(magnet?.isActive).toBe(true);
    expect(magnet?.distancePips).toBeCloseTo(30.5, 0.5);
    expect(magnet?.description).toContain('EQH');
  });

  it('detects EQL (Equal Lows) below current price for short trade', () => {
    const swings: SwingPoint[] = [
      { type: 'high', price: 195.0, formedAtIndex: 10, confirmedAtIndex: 12, timestamp: 1000 },
      { type: 'low', price: 192.50, formedAtIndex: 15, confirmedAtIndex: 17, timestamp: 2000 },
      { type: 'low', price: 192.52, formedAtIndex: 20, confirmedAtIndex: 22, timestamp: 3000 }, // 2 points diff
    ];
    const currentPrice = 193.50;

    const magnet = detectLiquidityMagnet(swings, currentPrice, 'short', 'CHFJPY');
    expect(magnet).not.toBeNull();
    expect(magnet?.type).toBe('EQL');
    expect(magnet?.pointsCount).toBe(2);
    expect(magnet?.isActive).toBe(true);
    expect(magnet?.distancePips).toBeCloseTo(99, 1);
    expect(magnet?.description).toContain('EQL');
  });

  it('returns null when swings are too dispersed to be equal', () => {
    const swings: SwingPoint[] = [
      { type: 'high', price: 1.0550, formedAtIndex: 10, confirmedAtIndex: 12, timestamp: 1000 },
      { type: 'high', price: 1.0580, formedAtIndex: 20, confirmedAtIndex: 22, timestamp: 3000 }, // 30 pips diff
    ];
    const currentPrice = 1.0520;

    const magnet = detectLiquidityMagnet(swings, currentPrice, 'long', 'EURUSD');
    expect(magnet).toBeNull();
  });

  it('filters out EQH clusters closer than minDistancePips and selects the next cluster >= minDistancePips', () => {
    const swings: SwingPoint[] = [
      // Cluster 1 at 1.0535 (15 pips away)
      { type: 'high', price: 1.0535, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 500 },
      { type: 'high', price: 1.0536, formedAtIndex: 8, confirmedAtIndex: 10, timestamp: 800 },
      // Cluster 2 at 1.0560 (40 pips away)
      { type: 'high', price: 1.0560, formedAtIndex: 15, confirmedAtIndex: 17, timestamp: 1500 },
      { type: 'high', price: 1.0561, formedAtIndex: 20, confirmedAtIndex: 22, timestamp: 2000 },
    ];
    const currentPrice = 1.0520;

    // Without minDistancePips: selects Cluster 1 (closer, 15 pips)
    const magnetNear = detectLiquidityMagnet(swings, currentPrice, 'long', 'EURUSD');
    expect(magnetNear?.distancePips).toBeCloseTo(15.5, 0.5);

    // With minDistancePips = 30.0 (e.g. 2.0R): skips Cluster 1, selects Cluster 2 (40 pips)
    const magnetFar = detectLiquidityMagnet(swings, currentPrice, 'long', 'EURUSD', undefined, undefined, 30.0);
    expect(magnetFar).not.toBeNull();
    expect(magnetFar?.distancePips).toBeCloseTo(40.5, 0.5);
    expect(magnetFar?.priceLevel).toBeCloseTo(1.05605, 4);
  });

  describe('Stop-Proximity Inducement Magnet Trap Filter (detectInducementMagnet)', () => {
    it('flags active EQL sitting right behind the stop loss on EURUSD LONG (e.g. ~6 pips below zone.low)', () => {
      const zone = { low: 1.0842, high: 1.0850 }; // 8-pip OB
      const swings: SwingPoint[] = [
        { type: 'low', price: 1.0836, formedAtIndex: 8, confirmedAtIndex: 10, timestamp: 1000 },
        { type: 'low', price: 1.08355, formedAtIndex: 14, confirmedAtIndex: 16, timestamp: 2000 },
      ];

      const trap = detectInducementMagnet(swings, zone, 'long', 'EURUSD', undefined, undefined, { atr15mPips: 12 });
      expect(trap).not.toBeNull();
      expect(trap?.type).toBe('EQL');
      expect(trap?.isActive).toBe(true);
      expect(trap?.distancePips).toBeCloseTo(6.3, 0.5);
    });

    it('ignores distant EQL far below the stop loss on EURUSD LONG (e.g. 85 pips away) so trade is not cancelled', () => {
      const zone = { low: 1.0842, high: 1.0850 }; // 8-pip OB
      const swings: SwingPoint[] = [
        { type: 'low', price: 1.0757, formedAtIndex: 3, confirmedAtIndex: 5, timestamp: 1000 },
        { type: 'low', price: 1.0758, formedAtIndex: 7, confirmedAtIndex: 9, timestamp: 2000 },
      ];

      const maxRadius = resolveMaxInducementDistancePips('EURUSD', zone, undefined, undefined, { atr15mPips: 12 });
      expect(maxRadius).toBe(15); // 4.2 stop buffer + 10.8 sweep reach

      const trap = detectInducementMagnet(swings, zone, 'long', 'EURUSD', undefined, undefined, { atr15mPips: 12 });
      expect(trap).toBeNull();
    });

    it('flags nearby EQH behind stop on USDJPY SHORT while ignoring distant EQH 75 pips above zone.high', () => {
      const zone = { low: 152.88, high: 153.00 }; // 12-pip OB
      const nearSwings: SwingPoint[] = [
        { type: 'high', price: 153.11, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 1000 },
        { type: 'high', price: 153.12, formedAtIndex: 11, confirmedAtIndex: 13, timestamp: 2000 },
      ];
      const farSwings: SwingPoint[] = [
        { type: 'high', price: 153.75, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 1000 },
        { type: 'high', price: 153.76, formedAtIndex: 11, confirmedAtIndex: 13, timestamp: 2000 },
      ];

      const nearTrap = detectInducementMagnet(nearSwings, zone, 'short', 'USDJPY', undefined, undefined, { atr15mPips: 18 });
      expect(nearTrap).not.toBeNull();
      expect(nearTrap?.isActive).toBe(true);

      const farTrap = detectInducementMagnet(farSwings, zone, 'short', 'USDJPY', undefined, undefined, { atr15mPips: 18 });
      expect(farTrap).toBeNull();
    });

    it('scales stop-proximity dynamically across Crypto (BTCUSD & sub-dollar IOUSD) without hardcoded FX pips', () => {
      // BTCUSD @ $70,000 (pip = 1.0): $180 below zone.low is right behind stop; $2,500 below is far away
      const btcZone = { low: 69800, high: 70000 };
      const btcNearSwings: SwingPoint[] = [
        { type: 'low', price: 69620, formedAtIndex: 6, confirmedAtIndex: 8, timestamp: 1000 },
        { type: 'low', price: 69640, formedAtIndex: 12, confirmedAtIndex: 14, timestamp: 2000 },
      ];
      const btcFarSwings: SwingPoint[] = [
        { type: 'low', price: 67300, formedAtIndex: 2, confirmedAtIndex: 4, timestamp: 1000 },
        { type: 'low', price: 67320, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 2000 },
      ];

      expect(
        detectInducementMagnet(btcNearSwings, btcZone, 'long', 'BTCUSD', undefined, undefined, { atr15mPips: 220 })?.isActive
      ).toBe(true);
      expect(
        detectInducementMagnet(btcFarSwings, btcZone, 'long', 'BTCUSD', undefined, undefined, { atr15mPips: 220 })
      ).toBeNull();

      // IOUSD @ $1.80 (pip = 0.0001): $0.0050 (50 units) below zone.low is close; $0.0900 (900 units / 5%) is far
      const ioZone = { low: 1.7950, high: 1.8050 };
      const ioNearSwings: SwingPoint[] = [
        { type: 'low', price: 1.7900, formedAtIndex: 6, confirmedAtIndex: 8, timestamp: 1000 },
        { type: 'low', price: 1.7902, formedAtIndex: 12, confirmedAtIndex: 14, timestamp: 2000 },
      ];
      const ioFarSwings: SwingPoint[] = [
        { type: 'low', price: 1.7050, formedAtIndex: 2, confirmedAtIndex: 4, timestamp: 1000 },
        { type: 'low', price: 1.7052, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 2000 },
      ];

      expect(detectInducementMagnet(ioNearSwings, ioZone, 'long', 'IOUSD')?.isActive).toBe(true);
      expect(detectInducementMagnet(ioFarSwings, ioZone, 'long', 'IOUSD')).toBeNull();
    });

    it('never falls back to an untaken distant EQL when the nearby EQL behind the stop was already swept (TAKEN)', () => {
      const zone = { low: 1.0842, high: 1.0850 };
      const swings: SwingPoint[] = [
        // Distant untaken EQL 95 pips below zone.low
        { type: 'low', price: 1.0747, formedAtIndex: 2, confirmedAtIndex: 4, timestamp: 1000 },
        { type: 'low', price: 1.0748, formedAtIndex: 5, confirmedAtIndex: 7, timestamp: 2000 },
        // Nearby EQL 5 pips below zone.low (swept at timestamp 4000)
        { type: 'low', price: 1.0837, formedAtIndex: 10, confirmedAtIndex: 12, timestamp: 3000 },
        { type: 'low', price: 1.08375, formedAtIndex: 14, confirmedAtIndex: 16, timestamp: 3500 },
      ];
      const candles = Array.from({ length: 17 }, (_, idx) => ({
        high: 1.0860,
        low: idx === 16 ? 1.0830 : 1.0845, // candle 16 sweeps 1.083725 cleanly, leaves 1.07475 untouched
        timestamp: 1000 + idx * 200,
      }));

      const result = detectInducementMagnet(swings, zone, 'long', 'EURUSD', candles, 16, { atr15mPips: 12 });
      expect(result).not.toBeNull();
      expect(result?.isActive).toBe(false);
      expect(result?.status).toBe('TAKEN');
    });
  });
});
