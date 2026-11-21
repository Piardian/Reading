import * as fs from 'fs';
import * as path from 'path';
import { FileMacroOutcomeStore } from '../server/macroOutcomeEvidence';
import { buildOutcomeReadiness, countSignalCandidates } from '../server/outcomeReadiness';

async function main() {
  const root = path.resolve(__dirname, '../..');
  const evidenceDir = process.env.EVIDENCE_DIRECTORY ?? path.join(root, 'smc_engine/evidence');
  const records = await new FileMacroOutcomeStore(process.env.MACRO_OUTCOME_LEDGER_PATH ??
    path.join(evidenceDir, 'outcomes/macro-outcome-evidence.jsonl')).readAllRecords();
  const signalsFile = path.join(evidenceDir, 'signals/signal-evidence.jsonl');
  const file = path.join(root, 'macro_engine/calibration/PROMOTION_STATUS.json');
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...prior, gate_readiness_checklist: buildOutcomeReadiness(records, countSignalCandidates(signalsFile)) };
  // Evidence refresh is never authorization to activate a trading policy.
  if (process.argv.includes('--write')) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(temp, file);
  }
  console.log(JSON.stringify(next, null, 2));
}
main().catch(err => { console.error(err); process.exitCode = 1; });
