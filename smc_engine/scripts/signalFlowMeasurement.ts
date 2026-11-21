import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { buildSignalFlowReport, writeSignalFlowReport, sha256, SignalFlowProtocol } from '../server/signalFlowMeasurement';
import { calculateTradeExpectancyPlan } from '../src/tradeExpectancyEngine';

const root = path.resolve(__dirname, '../../..');
const actualRoot = fs.existsSync(path.join(root, 'smc_engine')) ? root : path.resolve(__dirname, '../..');
const pointer = path.join(actualRoot, 'smc_engine/data/signal_flow_measurement_active.json');
const command = process.argv[2] ?? '--report';
const runArg = process.argv[3];

function filesIn(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? ['node_modules', '.venv', 'venv', '__pycache__', '.git'].includes(entry.name)
      ? [] : filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

if (command === '--init') {
  if (fs.existsSync(pointer)) throw new Error('An active measurement pointer already exists; do not overwrite a frozen run.');
  const runId = `signal-flow-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = path.join(actualRoot, 'research/signal_flow_measurement', runId);
  fs.mkdirSync(directory, { recursive: true });
  const codeFiles = ['smc_engine/server', 'smc_engine/src', 'smc_engine/scripts', 'macro_engine',
    'smc_engine/dist/server', 'smc_engine/dist/src', 'smc_engine/dist/scripts'].flatMap(folder =>
      fs.existsSync(path.join(actualRoot, folder)) ? filesIn(path.join(actualRoot, folder)) : [])
    .filter(file => /\.(ts|js|py)$/.test(file));
  const baselineFiles: Record<string, string> = {};
  for (const name of ['audit_results.json', 'geometry_results.json']) {
    const source = path.join(actualRoot, 'research/signal_frequency_audit', name);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(directory, `baseline_${name}`), bytes, { flag: 'wx' });
    baselineFiles[`baseline_${name}`] = sha256(bytes);
  }
  const configNames = ['CANDLE_DATA_DIR', 'ENABLE_EXPECTANCY_FILTER', 'ENABLE_KILLZONE', 'ENABLE_PVP_KILLZONE_BYPASS',
    'TWELVE_DATA_CREDITS_PER_MINUTE', 'TWELVE_DATA_RATE_LIMIT_SAFETY_MARGIN', 'TWELVE_DATA_MAX_RETRIES',
    'TWELVE_DATA_RATE_LIMIT_WINDOW_BUFFER_MS', 'TWELVE_DATA_PRIORITY_AGING_MS', 'POLL_ALIGN_OFFSET_MS',
    'ON_DEMAND_MAX_SYMBOLS_PER_CYCLE', 'LONDON', 'NEWYORK', 'NY_CLOSE', 'LONDON_START', 'LONDON_END',
    'NEWYORK_START', 'NEWYORK_END', 'NY_CLOSE_START', 'NY_CLOSE_END'];
  const protocol: SignalFlowProtocol = { version: 1, runId, createdAt: new Date().toISOString(),
    repositoryRoot: actualRoot, minimumNetRR: 2,
    reviewGate: { minimumCalendarDays: 28, minimumClosedPaperFills: 100, minimumIndependentWeeks: 4 },
    automaticPromotion: false, outcomeScope: 'FORWARD_M15_PAPER_NOT_MANUAL_M1', baselineFiles,
    codeHashes: Object.fromEntries(codeFiles.map(file => [path.relative(actualRoot, file).replace(/\\/g, '/'), sha256(fs.readFileSync(file))])),
    runtimeConfig: Object.fromEntries(configNames.map(name => [name, process.env[name] ?? null])) };
  const raw = JSON.stringify(protocol, null, 2) + '\n';
  fs.writeFileSync(path.join(directory, 'protocol.json'), raw, { flag: 'wx' });
  fs.writeFileSync(pointer, JSON.stringify({ directory, protocolHash: sha256(raw) }, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(buildSignalFlowReport(directory), null, 2) + '\n');
  console.log(JSON.stringify({ state: 'ARMED_AWAITING_RUNTIME_RESTART', directory, protocolHash: sha256(raw) }));
} else if (command === '--report') {
  const directory = runArg ? path.resolve(runArg) : JSON.parse(fs.readFileSync(pointer, 'utf8')).directory;
  const report = writeSignalFlowReport(directory);
  console.log(JSON.stringify({ directory, ...report }, null, 2));
} else if (command === '--history') {
  const directory = runArg ? path.resolve(runArg) : JSON.parse(fs.readFileSync(pointer, 'utf8')).directory;
  const queuePath = path.join(actualRoot, 'smc_engine/data/signal_delivery_queue.json');
  const bytes = fs.readFileSync(queuePath);
  const queue = JSON.parse(bytes.toString('utf8'));
  const rows: any[] = [];
  for (const item of queue) {
    if (!Number.isFinite(Date.parse(item.telegramSentAt ?? ''))) continue;
    const c = item.candidate;
    const zoneLow = c.poiType === 'OB' ? c.poi.low : c.poi.gapLow;
    const zoneHigh = c.poiType === 'OB' ? c.poi.high : c.poi.gapHigh;
    try {
      const plan = calculateTradeExpectancyPlan({ symbol: c.symbol, direction: c.tradeDirection, zoneLow, zoneHigh,
        currentPrice: c.currentPrice, grade: c.gradeResult.grade, totalScore: c.gradeResult.totalScore,
        atr15mPips: c.atr15mPips, liquidityMagnet: c.liquidityMagnet, opposingObstacle: c.opposingObstacle,
        macroEvaluation: c.macroEvaluation });
      const ref = plan.referenceEntryPrice!;
      const nominalCost = plan.estimatedCostR! * Math.abs(plan.entryPrice - plan.stopLoss);
      const refNet = ((c.tradeDirection === 'long' ? 1 : -1) * (plan.tp2.price - ref) - nominalCost)
        / (Math.abs(ref - plan.stopLoss) + nominalCost);
      rows.push({ signalId: item.signalId, symbol: c.symbol, archivedAt: item.telegramSentAt,
        atrStored: plan.stopVolatilitySource === 'ATR', previousPlanVersion: c.expectancyPlan?.version ?? null,
        referencePasses2: refNet >= 2, admissionBasis: plan.admissionBasis, plan });
    } catch (error) { rows.push({ signalId: item.signalId, error: String(error) }); }
  }
  const summarize = (data: any[]) => ({ n: data.length, referencePasses2: data.filter(r => r.referencePasses2).length,
    conditional: data.filter(r => r.admissionBasis === 'CONDITIONAL_ENTRY').length,
    admissible: data.filter(r => r.plan?.isAdmissible).length, rejected: data.filter(r => !r.plan?.isAdmissible).length });
  const usable = rows.filter(r => !r.error);
  const output = { capturedAt: new Date().toISOString(), sourceHash: sha256(bytes), scope: 'ARCHIVED_GEOMETRY_NOT_FORWARD_OR_PNL',
    summary: summarize(usable), storedAtr: summarize(usable.filter(r => r.atrStored)),
    storedLegacyPlan: summarize(usable.filter(r => r.previousPlanVersion === 'v1.0')), errors: rows.filter(r => r.error), rows };
  const target = path.join(directory, `historical-geometry-${Date.now()}.json`);
  fs.writeFileSync(target, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ target, summary: output.summary, storedAtr: output.storedAtr, storedLegacyPlan: output.storedLegacyPlan }));
} else throw new Error('Use --init, --report [runDirectory], or --history [runDirectory]');
