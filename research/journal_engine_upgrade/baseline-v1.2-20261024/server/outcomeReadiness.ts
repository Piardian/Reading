import { MacroOutcomeEvidenceRecord } from './macroOutcomeEvidence';
import { generateMacroOutcomeAnalytics } from './macroOutcomeAnalytics';
import * as fs from 'fs';

export function countSignalCandidates(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const ids = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line);
    return row.metadata?.signalId ?? row.signalId;
  }).filter(id => typeof id === 'string' && !id.startsWith('test_') && !id.includes('demo'));
  return new Set(ids).size;
}

export function buildOutcomeReadiness(records: readonly MacroOutcomeEvidenceRecord[], candidateSignalsLogged: number) {
  const summary = generateMacroOutcomeAnalytics(records);
  const eligible = records.filter(r => r.executionSource === 'PAPER' && r.measurementVersion === 3 &&
    r.executionPolicyId && r.entryConfirmed && ['TP', 'SL', 'BE'].includes(r.outcome) &&
    Number.isFinite(r.realizedR) && Number.isFinite(r.netRealizedR) &&
    r.macroSnapshot.pointInTimeVerified && r.evidenceScope === 'SMC_PAPER_WITH_ECONOMIC_MACRO' &&
    !r.signalId.startsWith('test_') && !r.signalId.includes('demo') &&
    !r.dataQualityIssues?.includes('INCONSISTENT_GROSS_NET_COST'));
  const blocked = eligible.filter(r => r.macroGatingCohort === 'MACRO_BLOCKED');
  return {
    candidate_signals_logged: candidateSignalsLogged,
    outcome_candidates_logged: summary.overall.candidateCount,
    confirmed_filled_trades_logged: summary.overall.filledTradesCount,
    resolved_filled_trades_logged: summary.overall.resolvedTradesCount,
    unresolved_filled_trades_logged: summary.overall.unresolvedFilledCount,
    verified_v3_economic_macro_trades: eligible.length,
    verified_macro_holdout_trades: eligible.filter(r => Boolean(r.independentHoldoutId)).length,
    required_minimum_filled_trades: 50,
    independent_weeks: summary.overall.independentWeeks,
    statistical_significance_status: 'REQUIRES_FROZEN_INDEPENDENT_HOLDOUT',
    causal_macro_ablation_status: blocked.length ? 'PENDING_MATCHED_POLICY_HOLDOUT_REVIEW' : 'PENDING_VERIFIED_COUNTERFACTUAL_FILLS',
    block_reason: `Observed fills=${summary.overall.filledTradesCount}; verified v3 economic-macro fills=${eligible.length}. Historical 4H trend-proxy research is not economic-macro validation. Minimum counts do not activate promotion.`,
    promotion_eligible: false,
  };
}
