import { shouldAllowTrendContinuationPD, TrendContinuationContext } from '../server/pipeline';
import { calculateGrade, GradeInput } from '../src/gradeCalculator';
import { evaluateSignalValidationGate } from '../src/signalValidationGate';
import { evaluateSetupIntelligenceV2 } from '../src/setupIntelligenceEvaluator';
import { SetupFamilyGuard } from '../server/setupFamilyGuard';
import { MacroGateAdapter } from '../server/macroGateAdapter';
import type { DisplacementQuality, PremiumDiscountState } from '../src/types';
import type { ModelState } from '../src/modelDeterminer';

describe('Deterministic Filter Calibration & Strict Trend Continuation Gate', () => {
  const strongBullishDq: DisplacementQuality = {
    legDirection: 'bullish',
    bodyRatioScore: 1,
    consecutiveScore: 1,
    fvgScore: 1,
    sizeScore: 1,
    totalScore: 4,
    quality: 'güçlü',
    gradePoints: 2,
  };

  const moderateBullishDq: DisplacementQuality = {
    ...strongBullishDq,
    totalScore: 3,
    quality: 'orta',
    gradePoints: 1,
  };

  const continuationModelWithSweep: ModelState = {
    model: 'model2_continuation',
    regime: 'bullish',
    triggeringSweep: { timestamp: 1000, candleIndex: 5, sweptLevel: 1.0950, type: 'sweep_low' } as any,
    triggeringBOS: {} as any,
  };

  const continuationModelNoSweep: ModelState = {
    model: 'model2_continuation',
    regime: 'bullish',
    triggeringSweep: null,
    triggeringBOS: {} as any,
  };

  const pdDiscount: PremiumDiscountState = { status: 'discount', fibValue: 0.25, rangeHigh: 1.1100, rangeLow: 1.1000 };
  const pdPremium: PremiumDiscountState = { status: 'premium', fibValue: 0.78, rangeHigh: 1.1100, rangeLow: 1.1000 };
  const pdEq: PremiumDiscountState = { status: 'eq', fibValue: 0.50, rangeHigh: 1.1100, rangeLow: 1.1000 };

  const confirmedBosContext: TrendContinuationContext = {
    structureEvents4H: [{ type: 'BOS', direction: 'bullish' }],
    structureEvents1H: [{ type: 'BOS', direction: 'bullish' }],
    currentTrend15m: 'bullish',
    poiStructureEventType: 'BOS',
    opposingObstacle: null,
    isExhaustionSweep: false,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Pillar 1–7: shouldAllowTrendContinuationPD ("Gerçek Trend Varsa" İnşası)', () => {
    it('UNLOCKS 1H Premium LONG when 4H+1H have confirmed BOS, 15M pulled back to Discount, strong displacement, and no Macro veto', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'LONG_ONLY',
        capitalPreservationMode: false,
      } as any);

      const allowed = shouldAllowTrendContinuationPD(
        'GBPUSD',
        'long',
        'bullish',
        'bullish',
        pdDiscount, // 15M pulled back to local Discount
        continuationModelWithSweep,
        strongBullishDq,
        pdPremium,  // 1H is in Premium due to strong uptrend
        confirmedBosContext
      );

      expect(allowed).toBe(true);
    });

    it('BLOCKS 1H Premium LONG if 15M has NOT pulled back to Discount (e.g. 15M is in EQ or Premium — Anti-FOMO)', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'LONG_ONLY',
        capitalPreservationMode: false,
      } as any);

      // Shallow 15M EQ while 1H is already Premium -> must block
      expect(
        shouldAllowTrendContinuationPD(
          'GBPUSD',
          'long',
          'bullish',
          'bullish',
          pdEq,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          confirmedBosContext
        )
      ).toBe(false);

      // Double Premium (1H Premium + 15M Premium) -> must block
      expect(
        shouldAllowTrendContinuationPD(
          'GBPUSD',
          'long',
          'bullish',
          'bullish',
          pdPremium,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          confirmedBosContext
        )
      ).toBe(false);
    });

    it('BLOCKS trend continuation when HTF only printed a bare initial CHoCH without any BOS confirmation (Anti-V-Spike Trap)', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'LONG_ONLY',
        capitalPreservationMode: false,
      } as any);

      const bareChochContext: TrendContinuationContext = {
        structureEvents4H: [{ type: 'CHoCH', direction: 'bullish' }],
        structureEvents1H: [{ type: 'CHoCH', direction: 'bullish' }],
        currentTrend15m: 'bullish',
        poiStructureEventType: 'CHoCH',
      };

      expect(
        shouldAllowTrendContinuationPD(
          'EURUSD',
          'long',
          'bullish',
          'bullish',
          pdDiscount,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          bareChochContext
        )
      ).toBe(false);
    });

    it('BLOCKS trend continuation if 15M structure has already flipped bearish against a bullish HTF trend', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'LONG_ONLY',
        capitalPreservationMode: false,
      } as any);

      expect(
        shouldAllowTrendContinuationPD(
          'EURUSD',
          'long',
          'bullish',
          'bullish',
          pdDiscount,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          { ...confirmedBosContext, currentTrend15m: 'bearish' }
        )
      ).toBe(false);
    });

    it('BLOCKS trend continuation immediately when Macro Gate vetoes direction (e.g. Nov 2 USDJPY SHORT_ONLY case)', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: false,
        action: 'VETO',
        macroBias: 'SHORT_ONLY',
        capitalPreservationMode: false,
      } as any);

      expect(
        shouldAllowTrendContinuationPD(
          'USDJPY',
          'long',
          'bullish',
          'bullish',
          pdDiscount,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          confirmedBosContext
        )
      ).toBe(false);
    });

    it('DOES NOT grant free pass on NEUTRAL_ALL macro when displacement is only moderate and no sweep occurred', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'NEUTRAL_ALL',
        capitalPreservationMode: false,
      } as any);

      expect(
        shouldAllowTrendContinuationPD(
          'EURUSD',
          'long',
          'bullish',
          'bullish',
          pdDiscount,
          continuationModelNoSweep,
          moderateBullishDq,
          pdPremium,
          confirmedBosContext
        )
      ).toBe(false);
    });

    it('BLOCKS trend continuation when an opposing institutional obstacle sits within 15 pips', () => {
      jest.spyOn(MacroGateAdapter.getInstance(), 'evaluateCandidate').mockReturnValue({
        allowed: true,
        action: 'PROCEED',
        macroBias: 'LONG_ONLY',
        capitalPreservationMode: false,
      } as any);

      expect(
        shouldAllowTrendContinuationPD(
          'EURUSD',
          'long',
          'bullish',
          'bullish',
          pdDiscount,
          continuationModelWithSweep,
          strongBullishDq,
          pdPremium,
          {
            ...confirmedBosContext,
            opposingObstacle: {
              hasObstacle: true,
              distancePips: 9.5,
              warningText: 'Karsi Engel: 9.5 pip yukarida 1H Bearish OB',
            } as any,
          }
        )
      ).toBe(false);
    });
  });

  describe('End-to-End Harmony Across Grade, V2 Intelligence, and Validation Gate', () => {
    it('permits a 2-touch POI with strong confluence across GradeCalculator, V2 Assessment, and SignalValidationGate while blocking 3+ touches', () => {
      const gradeInput2Touch: GradeInput = {
        tradeDirection: 'long',
        bias4H: 'bullish',
        pd4H: pdEq,
        bias1H: 'bullish',
        has15mEvent: true,
        displacementQuality15m: strongBullishDq,
        modelState: continuationModelWithSweep,
        poiTestResultForSweep: null,
        poiTimeframe: '15m',
        poiTestCount: 2,
        pd1H: pdPremium,
        pd15M: pdDiscount,
        allowTrendContinuationPD: true,
        liquidityMagnet: {
          type: 'EQH',
          priceLevel: 1.1080,
          pointsCount: 2,
          distancePips: 45,
          isActive: true,
          description: 'EQH BSL',
        },
      };

      const grade2 = calculateGrade(gradeInput2Touch);
      expect(grade2.entryAllowed).toBe(true);
      expect(grade2.grade).toBe('A');

      // Verify 3 touches is strictly blocked
      const grade3 = calculateGrade({ ...gradeInput2Touch, poiTestCount: 3 });
      expect(grade3.entryAllowed).toBe(false);
      expect(grade3.grade).toBe('B+');

      // Verify V2 intelligence admits 2-touch (A-) and rejects 3-touch (Reject)
      const baseDetector: any = {
        signalId: 'TEST_2_TOUCH',
        symbol: 'GBPUSD',
        timeframe: '15m',
        direction: 'long',
        detectedAt: 1717300000000,
        htfBias: { fourHour: 'bullish', oneHour: 'bullish' },
        structure: {
          event: { type: 'BOS', direction: 'bullish', breakCandleIndex: 12, breakTimestamp: 1717300000000, breakClosePrice: 1.2750, brokenSwing: {} },
          eventType: 'BOS',
          trend15m: 'bullish',
        },
        sweep: { present: true, type: 'Range Low', timestamp: 1717299000000, source: 'detector' },
        poi: {
          type: 'Order Block',
          orderBlock: { direction: 'bullish', candleIndex: 10, low: 1.2700, high: 1.2715, formedAtIndex: 10, relatedEvent: {} },
          fairValueGap: null,
          zoneLow: 1.2700,
          zoneHigh: 1.2715,
          formedAt: 10,
          testCount: 2,
        },
        premiumDiscount: { fourHour: pdEq, oneHour: pdPremium, fifteenMinute: pdDiscount },
        displacement: strongBullishDq,
        session: { name: 'London', timestamp: 1717300000000, timezone: 'Europe/Istanbul' },
        liquidity: { events: ['Range Low'], notes: [] },
      };

      const v2TwoTouch = evaluateSetupIntelligenceV2({ detector: baseDetector, v1Grade: grade2 });
      expect(v2TwoTouch.decision.hardReject).toBe(false);
      expect(['A+', 'A', 'A-']).toContain(v2TwoTouch.grade.value);

      const v2ThreeTouch = evaluateSetupIntelligenceV2({
        detector: { ...baseDetector, poi: { ...baseDetector.poi, testCount: 3 } },
        v1Grade: grade3,
      });
      expect(v2ThreeTouch.grade.value).toBe('Reject');

      // Verify SignalValidationGate passes 1H Premium + 4H EQ when allowTrendContinuationPD is true
      const gatePass = evaluateSignalValidationGate(
        {
          symbol: 'GBPUSD',
          tradeDirection: 'long',
          poiType: 'OB',
          poi: {
            direction: 'bullish',
            low: 1.2700,
            high: 1.2715,
            relatedEvent: { direction: 'bullish', breakTimestamp: 1717300000000 },
          } as any,
          gradeResult: grade2,
          uniqueKey: 'gbpusd_test',
          currentPrice: 1.2710,
          poiFormedTimestamp: 1717295000000,
          bias4H: 'bullish',
          bias1H: 'bullish',
          poiTestCount: 2,
          pd4H: 'eq',
          pd1H: 'premium',
          pd15M: 'discount',
          allowTrendContinuationPD: true,
        },
        { decisionCalibration: { status: 'ELIGIBLE', reason: { code: 'OK', message: 'ok' }, checks: [] } } as any
      );
      expect(gatePass.validationDecision).toBe('PASS');

      // Verify SetupFamilyGuard uses 3h default
      const guard = new SetupFamilyGuard({ dataDir: undefined });
      expect((guard as any).zoneOverlapCooldownMs).toBe(3 * 60 * 60 * 1000);

      // Verify SignalValidationGate blocks close inducement magnets behind stop (6 pips) but does NOT cancel for distant ones (90 pips)
      const baseCandidate: any = {
        symbol: 'GBPUSD',
        tradeDirection: 'long',
        poiType: 'OB',
        poi: {
          direction: 'bullish',
          low: 1.2700,
          high: 1.2715,
          relatedEvent: { direction: 'bullish', breakTimestamp: 1717300000000 },
        },
        gradeResult: grade2,
        uniqueKey: 'gbpusd_inducement_test',
        currentPrice: 1.2710,
        poiFormedTimestamp: 1717295000000,
        bias4H: 'bullish',
        bias1H: 'bullish',
        poiTestCount: 1,
        pd4H: 'discount',
        pd1H: 'discount',
        pd15M: 'discount',
        atr15mPips: 12,
      };
      const execStub: any = { decisionCalibration: { status: 'ELIGIBLE', reason: { code: 'OK', message: 'ok' }, checks: [] } };

      const nearGate = evaluateSignalValidationGate(
        {
          ...baseCandidate,
          inducementMagnet: {
            type: 'EQL',
            priceLevel: 1.2694,
            pointsCount: 2,
            distancePips: 6,
            isActive: true,
            description: 'Close EQL behind stop',
          },
        },
        execStub
      );
      expect(nearGate.validationDecision).toBe('FAIL');

      const farGate = evaluateSignalValidationGate(
        {
          ...baseCandidate,
          inducementMagnet: {
            type: 'EQL',
            priceLevel: 1.2610,
            pointsCount: 2,
            distancePips: 90,
            isActive: true,
            description: 'Distant old EQL 90 pips away',
          },
        },
        execStub
      );
      expect(farGate.validationDecision).toBe('PASS');
    });
  });
});
