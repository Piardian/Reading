import { calculateGrade, GradeInput } from '../src/gradeCalculator';
import { acceptsEntryGrade, readingMinimumGrade } from '../src/entryGradePolicy';

const fixture = (): GradeInput => ({
  tradeDirection: 'long', bias4H: 'bullish', bias1H: 'bullish',
  pd4H: { status: 'eq', fibValue: .5, rangeHigh: 100, rangeLow: 50 },
  pd1H: { status: 'discount', fibValue: .2, rangeHigh: 100, rangeLow: 50 },
  has15mEvent: true,
  displacementQuality15m: { legDirection: 'bullish',bodyRatioScore:1,consecutiveScore:1,fvgScore:0,sizeScore:0,totalScore:2,quality:'orta',gradePoints:1 },
  modelState: { model:'model2_continuation',regime:'bullish',triggeringSweep:null,triggeringBOS:{} as any },
  poiTestResultForSweep:null,poiTimeframe:'15m',poiTestCount:1,
});

describe('READING B+ admission',()=>{
  test('qualified B+ is admitted only with explicit lower threshold',()=>{
    const old=calculateGrade(fixture());const updated=calculateGrade(fixture(),'B+');
    expect(updated.grade).toBe('B+');expect(updated.blockReasons).toEqual([]);
    expect(old.entryAllowed).toBe(false);expect(updated.entryAllowed).toBe(true);
    expect(updated.totalScore).toBe(old.totalScore);
  });
  test('hard quality blocks survive the threshold change',()=>{
    const input=fixture();input.has15mEvent=false;
    expect(calculateGrade(input,'B+').entryAllowed).toBe(false);
    const tested=fixture();tested.poiTestCount=3;
    expect(calculateGrade(tested,'B+').entryAllowed).toBe(false);
    const conflict=fixture();conflict.bias4H='bearish';
    expect(calculateGrade(conflict,'B+').entryAllowed).toBe(false);
  });
  test('B and C cannot enter; V2 A- handling is preserved',()=>{
    expect(acceptsEntryGrade('B','B+')).toBe(false);expect(acceptsEntryGrade('C','B+')).toBe(false);
    expect(acceptsEntryGrade('A-','A',true)).toBe(true);
    expect(acceptsEntryGrade('B+','A',true)).toBe(false);
    expect(acceptsEntryGrade('B+','B+',true)).toBe(true);
  });
  test('non-READING process keeps A even if minimum env is present',()=>{
    const oldShadow=process.env.READING_TAPE_SHADOW,oldMin=process.env.READING_MINIMUM_SMC_GRADE;
    try {
      process.env.READING_MINIMUM_SMC_GRADE='B+';delete process.env.READING_TAPE_SHADOW;
      expect(readingMinimumGrade()).toBe('A');process.env.READING_TAPE_SHADOW='true';
      expect(readingMinimumGrade()).toBe('B+');
    } finally {
      if(oldShadow===undefined)delete process.env.READING_TAPE_SHADOW;else process.env.READING_TAPE_SHADOW=oldShadow;
      if(oldMin===undefined)delete process.env.READING_MINIMUM_SMC_GRADE;else process.env.READING_MINIMUM_SMC_GRADE=oldMin;
    }
  });
});
