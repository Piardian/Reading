/** Separate v1.3 observer. Reads the shared feed; never imports the Telegram delivery pipeline. */
import * as fs from 'fs';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';

const variant = path.resolve(__dirname, '../..');
const project = path.resolve(variant, '../../../..');
if (!fs.existsSync(path.join(project, 'shared/macro_bias_gate.json'))) throw new Error('Original Begonya project root not found');
loadEnv({ path: path.join(project, 'smc_engine/.env'), quiet: true });
const runArg = process.argv.indexOf('--run-dir');
if (runArg < 0 || !process.argv[runArg + 1]) throw new Error('--run-dir is required');
const runDir = path.resolve(process.argv[runArg + 1]);
const measurementRoot = path.join(project, 'research/journal_engine_upgrade/measurements');
if (!runDir.startsWith(measurementRoot + path.sep)) throw new Error('Observer output must stay in its isolated measurement directory');
fs.mkdirSync(runDir, { recursive: true });
const candleData = process.env.CANDLE_DATA_DIR;
if (!candleData || !path.isAbsolute(candleData)) throw new Error('An explicit absolute shared CANDLE_DATA_DIR is required');
process.env.BEGONYA_PROJECT_ROOT = project;
process.env.DATA_DIR = path.join(runDir, 'data');
process.env.TELEMETRY_DIRECTORY = path.join(runDir, 'telemetry');
process.env.EVIDENCE_DIRECTORY = path.join(runDir, 'evidence');
process.env.OUTCOME_LEDGER_PATH = path.join(runDir, 'data/active_outcomes.json');
process.env.MACRO_OUTCOME_LEDGER_PATH = path.join(runDir, 'evidence/outcomes/macro-outcome-evidence.jsonl');
process.chdir(runDir);

const { acquireRuntimeInstanceLock } = require('./runtimeInstanceLock') as typeof import('./runtimeInstanceLock');
const lock = acquireRuntimeInstanceLock({ dataDir: path.join(runDir, 'data') });
process.once('exit', () => lock.release());
const { sha256, initializeSignalFlowMeasurement, writeSignalFlowReport, recordSignalFlowEvent,
  archiveSignalFlowMarket, setSignalFlowPlanObserver } = require('./signalFlowMeasurement') as typeof import('./signalFlowMeasurement');
const { CandleStore } = require('./candleStore') as typeof import('./candleStore');
const { NotifiedStore } = require('./notifiedStore') as typeof import('./notifiedStore');
const { runPipeline } = require('./pipeline') as typeof import('./pipeline');
const { PaperOutcomeTracker } = require('./paperOutcomeTracker') as typeof import('./paperOutcomeTracker');
const { captureMacroSnapshot, estimateDynamicTransactionCost } = require('./macroOutcomeEvidence') as typeof import('./macroOutcomeEvidence');
const { SetupPlanRegistry } = require('./setupPlanRegistry') as typeof import('./setupPlanRegistry');
const { ManualExecutionJournal } = require('./manualExecutionJournal') as typeof import('./manualExecutionJournal');
const { createManagementApi } = require('./managementApi') as typeof import('./managementApi');
const { ActivePoiWatchlist } = require('./activePoiWatchlist') as typeof import('./activePoiWatchlist');
const { evaluateKillzoneFilter } = require('./killzone') as typeof import('./killzone');
const { ALL_SYMBOLS, ON_DEMAND_ALTCOIN_UNIVERSE } = require('./universe') as typeof import('./universe');
const { buildDefaultExecutionView } = require('./telegramFormatter') as typeof import('./telegramFormatter');
const { buildCommunicationLayer, renderCommunicationMessage } = require('./communicationLayer') as typeof import('./communicationLayer');
const { FileSignalLedger } = require('./signalLedger') as typeof import('./signalLedger');
const { JsonlEvidenceStore } = require('./evidenceStore') as typeof import('./evidenceStore');
const { FileMacroOutcomeStore } = require('./macroOutcomeEvidence') as typeof import('./macroOutcomeEvidence');

function codeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? codeFiles(path.join(directory, entry.name)) : /\.(ts|js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}
const protocolFile = path.join(runDir, 'protocol.json');
if (!fs.existsSync(protocolFile)) {
  const files = ['src', 'server', 'dist/src', 'dist/server'].flatMap(name => codeFiles(path.join(variant, name)));
  const baseline = path.join(project, 'research/journal_engine_upgrade/baseline-v1.2-20261024');
  files.push(...['src', 'server', 'dist/src', 'dist/server'].flatMap(name => codeFiles(path.join(baseline, name))));
  const frozenRuntimeKeys = ['CANDLE_DATA_DIR', 'BEGONYA_PROJECT_ROOT', 'NODE_ENV', 'ENABLE_EXPECTANCY_FILTER',
    'ENABLE_KILLZONE', 'ENABLE_PVP_KILLZONE_BYPASS', 'LONDON', 'NEWYORK', 'NY_CLOSE',
    'LONDON_START', 'LONDON_END', 'NEWYORK_START', 'NEWYORK_END', 'NY_CLOSE_START', 'NY_CLOSE_END'];
  const protocol: import('./signalFlowMeasurement').SignalFlowProtocol = {
    version: 1, runId: path.basename(runDir), createdAt: new Date().toISOString(), repositoryRoot: project,
    minimumNetRR: 2, planVersion: 'v1.3', outcomeScope: 'FORWARD_M15_PAPER_NOT_MANUAL_M1', automaticPromotion: false,
    reviewGate: { minimumCalendarDays: 28, minimumClosedPaperFills: 100, minimumIndependentWeeks: 4 },
    codeHashes: Object.fromEntries(files.map(file => [path.relative(project, file), sha256(fs.readFileSync(file))])),
    runtimeConfig: Object.fromEntries(frozenRuntimeKeys.map(key => [key, process.env[key] ?? null])),
  };
  fs.writeFileSync(protocolFile, JSON.stringify(protocol, null, 2) + '\n', { flag: 'wx' });
}
const frozenProtocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8')) as import('./signalFlowMeasurement').SignalFlowProtocol;
for (const [relative, digest] of Object.entries(frozenProtocol.codeHashes)) {
  const raw = fs.readFileSync(path.join(project, relative));
  if (sha256(raw) !== digest) throw new Error(`Frozen observer source changed: ${relative}`);
  const archived = path.join(runDir, 'frozen-code', relative);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  if (!fs.existsSync(archived)) fs.writeFileSync(archived, raw, { flag: 'wx' });
  else if (sha256(fs.readFileSync(archived)) !== digest) throw new Error(`Frozen source archive changed: ${relative}`);
}
fs.writeFileSync(path.join(runDir, 'runtime-info.json'), JSON.stringify({ node: process.version,
  platform: process.platform, architecture: process.arch, dependencyRoot: path.join(project, 'smc_engine/node_modules'),
  dependencyLockSha256: fs.existsSync(path.join(project, 'smc_engine/package-lock.json'))
    ? sha256(fs.readFileSync(path.join(project, 'smc_engine/package-lock.json'))) : null }, null, 2));
fs.mkdirSync(path.join(runDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'data/signal_flow_measurement_active.json'), JSON.stringify({
  directory: runDir, protocolHash: sha256(fs.readFileSync(protocolFile)),
}));
initializeSignalFlowMeasurement();
const store = new CandleStore(candleData), notified = new NotifiedStore(path.join(runDir, 'data'));
const setups = new SetupPlanRegistry(path.join(runDir, 'journal'));
const journal = new ManualExecutionJournal(path.join(runDir, 'journal'), setups,
  symbol => store.getCandles(symbol as import('./universe').Symbol, '15m'));
const paper = PaperOutcomeTracker.getInstance();
const frozenPaperPath = path.join(project, 'research/journal_engine_upgrade/baseline-v1.2-20261024/dist/server/paperOutcomeTracker.js');
const FrozenPaper = require(frozenPaperPath).PaperOutcomeTracker;
function comparisonOptions(name: string) {
  const dir = path.join(runDir, name);
  return { statePath: path.join(dir, 'active-outcomes.json'), signalLedger: new FileSignalLedger(path.join(dir, 'ledger')),
    evidenceStore: new JsonlEvidenceStore(path.join(dir, 'evidence')),
    macroOutcomeStore: new FileMacroOutcomeStore(path.join(dir, 'outcomes.jsonl')) };
}
const commonV12 = new FrozenPaper(comparisonOptions('common-v12')) as import('./paperOutcomeTracker').PaperOutcomeTracker;
const commonV13 = new PaperOutcomeTracker({ ...comparisonOptions('common-v13'), measurementPrefix: 'COMPARISON_V13' });
setSignalFlowPlanObserver(data => {
  const candidate = { symbol: data.symbol, tradeDirection: data.direction, poiType: data.poiType, poi: data.poi,
    gradeResult: data.gradeResult, uniqueKey: data.signalId, signalId: data.signalId,
    dedupeKey: data.poiId, currentPrice: data.currentPrice ?? data.plan.referenceEntryPrice,
    marketDataTimestamp: data.marketDataTimestamp, poiFormedTimestamp: data.poiFormedTimestamp,
    macroEvaluation: data.macroEvaluation, liquidityMagnet: data.plan.resolvedLiquidityMagnet,
    expectancyPlan: data.plan } as import('./pipeline').NotificationCandidate;
  const snapshot = captureMacroSnapshot(candidate, Date.now());
  if (data.baselineV12?.isAdmissible) commonV12.registerCandidate({ ...candidate, expectancyPlan: data.baselineV12 }, snapshot,
    { observedAtMs: Date.now() });
  if (data.plan.isAdmissible) commonV13.registerCandidate(candidate, snapshot, { observedAtMs: Date.now() });
});
ActivePoiWatchlist.getInstance(path.join(runDir, 'data'));
const app = createManagementApi(setups, journal);
const port = Number(process.env.JOURNAL_UPGRADE_PORT ?? 3021);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid observer port');
const server = app.listen(port, '127.0.0.1', () => console.log(`Journal v1.3: http://127.0.0.1:${port} | ${runDir}`));
server.on('error', error => { console.error(error); process.exit(1); });

const lastSeen = new Map<string, number>();
const previewFile = path.join(runDir, 'notification-previews.jsonl');
const previewed = new Set<string>(fs.existsSync(previewFile) ? fs.readFileSync(previewFile, 'utf8')
  .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).signalId) : []);
for (const [symbol, stamp] of Object.entries(JSON.parse(fs.existsSync(path.join(runDir, 'scan-state.json'))
    ? fs.readFileSync(path.join(runDir, 'scan-state.json'), 'utf8') : '{}'))) lastSeen.set(symbol, Number(stamp));
const symbols = [...new Set([...ALL_SYMBOLS, ...ON_DEMAND_ALTCOIN_UNIVERSE])];
let scanning = false;
function scan(): void {
  if (scanning) return;
  scanning = true;
  let fresh = 0, stale = 0, failures = 0;
  try {
    for (const symbol of symbols) {
      const now = Date.now();
      const m15 = store.getCandles(symbol, '15m').filter(c => c.timestamp + 900_000 <= now);
      if (!m15.length) continue;
      const stamp = m15[m15.length - 1].timestamp;
      if (stamp <= (lastSeen.get(symbol) ?? 0)) continue;
      if (stamp < Math.floor(now / 900_000) * 900_000 - 900_000) { stale += 1; continue; }
      try {
        const h1 = store.getCandles(symbol, '1h');
        const h4 = store.getCandles(symbol, '4h');
        if (!h1.some(c => c.timestamp >= Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000)
          || !h4.some(c => c.timestamp >= Math.floor(now / 14_400_000) * 14_400_000 - 14_400_000)) { stale += 1; continue; }
        paper.update(symbol, m15);
        commonV12.update(symbol, m15);
        commonV13.update(symbol, m15);
        setups.refresh(symbol, m15, h1, now);
        if (evaluateKillzoneFilter(symbol).active) {
          archiveSignalFlowMarket(symbol, store);
          const candidates = runPipeline(symbol, store, notified, now);
          for (const candidate of candidates) {
            setups.register(candidate, now);
            paper.registerCandidate(candidate, captureMacroSnapshot(candidate, now), { observedAtMs: now });
            // Text uses exactly the same management object as the paper model; saved locally only.
            if (!previewed.has(candidate.uniqueKey)) {
              const message = renderCommunicationMessage(buildCommunicationLayer({ candidate,
                executionView: buildDefaultExecutionView(candidate) }).message);
              fs.appendFileSync(previewFile, JSON.stringify({
                observedAt: new Date(now).toISOString(), signalId: candidate.uniqueKey,
                setupId: candidate.setupHierarchy?.setupId, message }) + '\n');
              previewed.add(candidate.uniqueKey);
            }
          }
        }
        lastSeen.set(symbol, stamp); fresh += 1;
      } catch (error) {
        failures += 1; recordSignalFlowEvent('SCAN_ERROR', { symbol, error: String(error) });
      }
    }
    const target = path.join(runDir, 'scan-state.json'), tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(lastSeen))); fs.renameSync(tmp, target);
    recordSignalFlowEvent('OBSERVER_SCAN', { freshSymbols: fresh, staleSymbols: stale, failures, providerRequests: 0 });
    const report = writeSignalFlowReport(runDir);
    fs.writeFileSync(path.join(runDir, 'journal-summary.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), setupNodes: setups.list().length, manualPositions: journal.list(),
      paper: report.paper, observerVersion: 'v1.3', mode: 'SHADOW', orderRouting: false,
    }, null, 2));
    const compare = (name: string) => {
      const file = path.join(runDir, name, 'outcomes.jsonl');
      const rows: import('./macroOutcomeEvidence').MacroOutcomeEvidenceRecord[] = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
      const verified = rows.filter(row => row.entryConfirmed && ['TP', 'SL', 'BE'].includes(row.outcome)
        && Number.isFinite(row.netRealizedR));
      const net = verified.reduce((sum, row) => sum + row.netRealizedR!, 0);
      const tracker = name === 'common-v12' ? commonV12 : commonV13;
      const budgetReturns = verified.map(row => {
        if (!(row.riskDistance && row.riskDistance > 0 && row.entryPrice)) return null;
        const signal = tracker.get(row.signalId);
        if (!signal) return null;
        const costs = estimateDynamicTransactionCost({ symbol: row.symbol, riskDistance: row.riskDistance,
          entryPrice: row.entryPrice, vixLevel: row.macroSnapshot?.vixLevel,
          newsFreezeActive: row.macroSnapshot?.newsFreezeActive, minutesToNewsEvent: row.macroSnapshot?.minutesToNewsEvent });
        const costDistance = row.managementPlan?.nominalCostDistance ?? Math.max(signal.plannedEntryRange?.nominalCostDistance ?? 0,
          costs.spreadDistance + costs.slippageDistance + costs.commissionDistance);
        return row.netRealizedR! / (1 + costDistance / row.riskDistance);
      }).filter((value): value is number => value !== null && Number.isFinite(value));
      return { closedFilled: verified.length, tp: verified.filter(row => row.outcome === 'TP').length,
        sl: verified.filter(row => row.outcome === 'SL').length, be: verified.filter(row => row.outcome === 'BE').length,
        meanEstimatedNetR: verified.length ? net / verified.length : null, estimatedNetR: verified.length ? net : null,
        equalCashRiskComparableFills: budgetReturns.length,
        meanEstimatedNetPerEqualCashRiskBudget: budgetReturns.length
          ? budgetReturns.reduce((sum, value) => sum + value, 0) / budgetReturns.length : null,
        censoredFilled: rows.filter(row => row.entryConfirmed && !['TP', 'SL', 'BE'].includes(row.outcome)).length,
        cancelledUnfilled: rows.filter(row => !row.entryConfirmed).length,
        open: name === 'common-v12' ? commonV12.listOpen().length : commonV13.listOpen().length };
    };
    fs.writeFileSync(path.join(runDir, 'common-population-comparison.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), scope: 'COMMON_UPSTREAM_SMC_BEFORE_CONSOLIDATION',
      baseline: compare('common-v12'), treatment: compare('common-v13'),
      limitations: ['Same upstream boxes, separate admissibility, stop, entry and management policies.',
        'Combined policy comparison; individual changes are not causally isolated.',
        'Equal cash-risk budget includes the ex-ante estimated round-trip cost; gaps may exceed that budget.',
        'Censored filled positions are excluded from closed R, so closed mean alone cannot establish an edge.',
        'Read-only shared feed; no manual M1 fills or real execution inferred.', 'No automatic production promotion.'],
    }, null, 2));
  } finally { scanning = false; }
}
const timer = setInterval(scan, 60_000);
scan();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(timer); server.close(() => { lock.release(); process.exit(0); });
});
