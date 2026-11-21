"""Read-only journal/source audit. Outputs only inside this research directory."""
from pathlib import Path
from datetime import datetime, timezone
import collections
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
SOURCES = [
    'smc_engine/evidence/signals/smc-journal.md',
    'smc_engine/evidence/outcomes/macro-outcome-evidence.jsonl',
    'smc_engine/server/paperOutcomeTracker.ts',
    'smc_engine/server/communicationLayer.ts',
    'smc_engine/src/tradeExpectancyEngine.ts',
    'smc_engine/src/poiConsolidator.ts',
    'smc_engine/src/obDetector.ts',
    'research/signal_flow_measurement/signal-flow-2026-10-23T14-48-17-622Z/report.json',
]
raw = {name: (ROOT / name).read_bytes() for name in SOURCES}
text = raw[SOURCES[0]].decode('utf-8')
heads = list(re.finditer(r'^### (H?\d+)\. (.+)$', text, re.M))
entries = []
for index, match in enumerate(heads):
    end = heads[index + 1].start() if index + 1 < len(heads) else len(text)
    body = text[match.end():end]
    def label(pattern):
        value = re.search(pattern, body, re.M)
        return value[1] if value else None
    entries.append({
        'number': match[1], 'header': match[2],
        'sourceLine': text[:match.start()].count('\n') + 1,
        'reportedUserLabel': label(r'^- \*\*(?:Kullanıcı Sonucu|Durum):\*\* (.+)$'),
        'reportedBenchmarkLabel': label(r'^- \*\*Botun Benchmark Takibi:\*\* (.+)$'),
        'signalIds': re.findall(r'(?:[A-Z0-9]+)_15m_(?:OB|FVG)_\d+_\d+', body),
    })
rows = [json.loads(line) for line in raw[SOURCES[1]].decode('utf-8').splitlines() if line.strip()]
resolved = [r for r in rows if r.get('entryConfirmed') and r.get('outcome') in ('TP', 'SL', 'BE')]
breakdown = {}
for outcome in ('TP', 'SL', 'BE'):
    group = [r for r in resolved if r['outcome'] == outcome]
    breakdown[outcome] = {
        'n': len(group),
        'negativeNet': sum(isinstance(r.get('netRealizedR'), (int, float)) and r['netRealizedR'] < 0 for r in group),
        'mfeAtLeast1R': sum((r.get('maximumFavorableExcursion') or 0) >= 1 for r in group),
        'sameBarExit': sum(r.get('holdingTimeMs') == 0 for r in group),
        'missingPolicyId': sum(not r.get('executionPolicyId') for r in group),
    }
conflicting_id = 'EURJPY_15m_OB_1791178200000_1791181800000'
conflict = [{k: r.get(k) for k in ('signalId', 'outcome', 'entryPrice', 'stopLoss', 'takeProfit',
                                  'entryTimestamp', 'exitTimestamp', 'holdingTimeMs', 'measurementVersion',
                                  'executionPolicyId')}
            for r in rows if r.get('signalId') == conflicting_id]
forward = json.loads(raw[SOURCES[-1]])
result = {
    'capturedAt': datetime.now(timezone.utc).isoformat(),
    'scope': 'DIAGNOSTIC_JOURNAL_AND_SOURCE_REVIEW_NOT_PROFITABILITY_VALIDATION',
    'sourceHashes': {name: hashlib.sha256(content).hexdigest() for name, content in raw.items()},
    'journal': {'numberedEntries': sum(not e['number'].startswith('H') for e in entries),
                'historicalEntries': sum(e['number'].startswith('H') for e in entries),
                'lastNumberedEntry': next(e for e in reversed(entries) if not e['number'].startswith('H'))},
    'legacyLedger': {'rows': len(rows), 'uniqueSignalIds': len(set(r['signalId'] for r in rows)),
                     'outcomes': dict(collections.Counter(r.get('outcome') for r in rows)),
                     'missingPolicyId': sum(not r.get('executionPolicyId') for r in rows),
                     'resolvedFilled': len(resolved), 'resolvedBreakdown': breakdown,
                     'journal76ConflictingLedgerRow': conflict},
    'partialExitArithmetic': [
        {'journalNumber': 75, 'statedFinalTargetR': 2.3, 'halfAt1RHalfAtFinalGrossR': .5 * 1 + .5 * 2.3},
        {'journalNumber': 78, 'statedFinalTargetR': 2, 'halfAt1RHalfAtFinalGrossR': .5 * 1 + .5 * 2},
    ],
    'forward': {'generatedAt': forward['generatedAt'], 'activatedAt': forward['activatedAt'],
                'eligibility': forward['eligibility'], 'paper': forward['paper']},
    'entries': entries,
    'limitations': [
        'Narrative outcomes include duplicates, waiting signals, hypothetical benchmarks and operator reports.',
        'No broker fill archive or verified manual M1 order lifecycle was found in the examined journal.',
        'Legacy MFE and outcomes lack policy IDs; same-bar exit examples and contradictory labels prevent parameter optimization claims.',
        'No production source, frozen forward protocol, parameters or running service changed in this audit.',
    ],
}
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: result[k] for k in ('capturedAt', 'journal', 'legacyLedger', 'partialExitArithmetic')}, ensure_ascii=True))
