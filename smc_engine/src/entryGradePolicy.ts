export type MinimumEntryGrade = 'A' | 'B+';

/** Opt-in belongs only to the isolated READİNG worker; defaults stay unchanged. */
export function readingMinimumGrade(): MinimumEntryGrade {
  return process.env.READING_TAPE_SHADOW === 'true' && process.env.READING_MINIMUM_SMC_GRADE === 'B+' ? 'B+' : 'A';
}

export function acceptsEntryGrade(grade: string, minimum: MinimumEntryGrade, allowAMinus = false): boolean {
  if (grade === 'A+' || grade === 'A') return true;
  if (grade === 'A-' && allowAMinus) return true;
  return minimum === 'B+' && grade === 'B+';
}
