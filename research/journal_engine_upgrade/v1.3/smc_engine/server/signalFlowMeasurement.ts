import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import type { CandleStore, Symbol, Timeframe } from './candleStore';
import type { TradeExpectancyPlan } from '../src/tradeExpectancyEngine';

export interface SignalFlowProtocol {
  version: 1;
  runId: string;
  createdAt: string;
  repositoryRoot: string;
  codeHashes: Record<string, string>;
  minimumNetRR: number;
  reviewGate: { minimumCalendarDays: number; minimumClosedPaperFills: number; minimumIndependentWeeks: number };
  automaticPromotion: false;
  outcomeScope: 'FORWARD_M15_PAPER_NOT_MANUAL_M1';
  planVersion?: 'v1.2' | 'v1.3';
  runtimeConfig?: Record<string, string | null>;
  baselineFiles?: Record<string, string>;
}

export interface FlowEvent {
  type: string;
  observedAt: string;
  pid: number;
  protocolHash: string;
  data: Record<string, any>;
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function readFlowEvents(directory: string): { events: FlowEvent[]; malformedLines: number } {
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return { events: [], malformedLines: 0 };
  const events: FlowEvent[] = [];
  let malformedLines = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed.type !== 'string' || !Number.isFinite(Date.parse(parsed.observedAt))
          || typeof parsed.protocolHash !== 'string' || !Number.isInteger(parsed.pid)
          || !parsed.data || typeof parsed.data !== 'object') throw new Error('Malformed event schema');
      events.push(parsed);
    } catch { malformedLines += 1; }
  }
  return { events, malformedLines };
}

export class SignalFlowMeasurement {
  readonly protocol: SignalFlowProtocol;
  readonly protocolHash: string;
  readonly activatedAt: string;
  private readonly observationIds = new Set<string>();
  private readonly snapshotBySymbol = new Map<string, string>();
  private writeErrors = 0;

  constructor(readonly directory: string, expectedHash?: string, verifyCode = true) {
    const raw = fs.readFileSync(path.join(directory, 'protocol.json'));
    this.protocolHash = sha256(raw);
    if (expectedHash && expectedHash !== this.protocolHash) throw new Error('Signal-flow protocol hash mismatch');
    this.protocol = JSON.parse(raw.toString('utf8'));
    if (this.protocol.version !== 1 || this.protocol.automaticPromotion !== false)
      throw new Error('Unsupported signal-flow protocol');
    if (verifyCode) {
      for (const [relativePath, expected] of Object.entries(this.protocol.codeHashes)) {
        if (sha256(fs.readFileSync(path.join(this.protocol.repositoryRoot, relativePath))) !== expected)
          throw new Error(`Frozen signal-flow code changed: ${relativePath}`);
      }
      for (const [name, value] of Object.entries(this.protocol.runtimeConfig ?? {})) {
        if ((process.env[name] ?? null) !== value) throw new Error(`Frozen runtime configuration changed: ${name}`);
      }
    }
    const activationPath = path.join(directory, 'activation.json');
    if (!fs.existsSync(activationPath)) fs.writeFileSync(activationPath, JSON.stringify({
      activatedAt: new Date().toISOString(), pid: process.pid, protocolHash: this.protocolHash,
    }, null, 2) + '\n', { flag: 'wx' });
    const activation = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
    if (activation.protocolHash !== this.protocolHash) throw new Error('Activation belongs to a different protocol');
    this.activatedAt = activation.activatedAt;
    for (const event of readFlowEvents(directory).events) {
      if (event.type === 'PLAN' && event.protocolHash === this.protocolHash && event.data.observationId)
        this.observationIds.add(event.data.observationId);
    }
  }

  append(type: string, data: Record<string, any>): void {
    const event: FlowEvent = { type, observedAt: new Date().toISOString(), pid: process.pid,
      protocolHash: this.protocolHash, data };
    fs.appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify(event) + '\n');
  }

  observePlan(data: Record<string, any> & { symbol: string; poiId: string; marketDataTimestamp: number; plan: TradeExpectancyPlan }): void {
    const observationId = sha256(`${data.poiId}:${data.marketDataTimestamp}`);
    if (this.observationIds.has(observationId)) return;
    this.append('PLAN', { ...data, observationId, snapshot: this.snapshotBySymbol.get(data.symbol) ?? null });
    this.observationIds.add(observationId);
  }

  snapshot(symbol: Symbol, store: CandleStore): void {
    const capturedAt = Date.now();
    const frames = Object.fromEntries((['15m', '1h', '4h'] as Timeframe[]).map(timeframe => {
      const duration = timeframe === '15m' ? 900_000 : timeframe === '1h' ? 3_600_000 : 14_400_000;
      return [timeframe, store.getCandles(symbol, timeframe).filter(c => c.timestamp + duration <= capturedAt)];
    }));
    const gatePath = path.join(this.protocol.repositoryRoot, 'shared/macro_bias_gate.json');
    const gateRaw = fs.existsSync(gatePath) ? fs.readFileSync(gatePath) : null;
    const gateHash = gateRaw ? sha256(gateRaw) : null;
    const context = Object.fromEntries(['config/symbol_map.json', 'config/news_events.json',
      'shared/economic_events.json', 'macro_engine/gateways/macro_bias_gate.json'].map(relative => {
      const file = path.join(this.protocol.repositoryRoot, relative);
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      return [relative, { sha256: raw === null ? null : sha256(raw), raw }];
    }));
    const snapshot = JSON.stringify({ symbol, frames, gateHash, context });
    const digest = sha256(snapshot);
    const relativePath = `market/${new Date(capturedAt).toISOString().slice(0, 10)}/${symbol}-${digest}.json.gz`;
    const target = path.join(this.directory, relativePath);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, gzipSync(JSON.stringify({ capturedAt: new Date(capturedAt).toISOString(),
        contentHash: digest, symbol, frames, gateHash, context })));
      if (gateRaw) {
        const gateArchive = path.join(this.directory, 'macro', `${gateHash}.json.gz`);
        fs.mkdirSync(path.dirname(gateArchive), { recursive: true });
        if (!fs.existsSync(gateArchive)) fs.writeFileSync(gateArchive, gzipSync(gateRaw));
      }
      this.append('MARKET_SNAPSHOT', { symbol, path: relativePath, contentHash: digest,
        rows: Object.fromEntries(Object.entries(frames).map(([tf, candles]) => [tf, candles.length])) });
    }
    this.snapshotBySymbol.set(symbol, relativePath);
  }

  heartbeat(): void {
    const target = path.join(this.directory, 'status.json');
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ runId: this.protocol.runId, activatedAt: this.activatedAt,
      heartbeatAt: new Date().toISOString(), pid: process.pid, protocolHash: this.protocolHash,
      writeErrors: this.writeErrors, state: this.writeErrors ? 'DEGRADED' : 'RECORDING' }, null, 2) + '\n');
    fs.renameSync(tmp, target);
  }

  noteError(error: unknown): void {
    this.writeErrors += 1;
    console.error('[SignalFlowMeasurement] Evidence write failed:', error);
  }
}

let active: SignalFlowMeasurement | null = null;
let planObserver: ((data: Parameters<SignalFlowMeasurement['observePlan']>[0]) => void) | null = null;
export function setSignalFlowPlanObserver(observer: typeof planObserver): void { planObserver = observer; }

export function initializeSignalFlowMeasurement(): SignalFlowMeasurement | null {
  if (process.env.NODE_ENV === 'test') return null;
  const pointer = path.resolve('data', 'signal_flow_measurement_active.json');
  if (!fs.existsSync(pointer)) return null;
  const config = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  active = new SignalFlowMeasurement(config.directory, config.protocolHash);
  active.append('RUNTIME_STARTED', { activatedAt: active.activatedAt, planVersion: active.protocol.planVersion ?? 'v1.2' });
  active.heartbeat();
  setInterval(() => {
    try {
      active?.heartbeat();
      if (active) writeSignalFlowReport(active.directory);
    } catch (error) { active?.noteError(error); }
  }, 60_000).unref();
  return active;
}

export function recordSignalFlowEvent(type: string, data: Record<string, any>): void {
  try { active?.append(type, data); } catch (error) { active?.noteError(error); }
}

export function recordSignalFlowPlan(data: Parameters<SignalFlowMeasurement['observePlan']>[0]): void {
  try { active?.observePlan(data); } catch (error) { active?.noteError(error); }
  try { planObserver?.(data); } catch (error) { active?.noteError(error); }
}

export function archiveSignalFlowMarket(symbol: Symbol, store: CandleStore): void {
  try { active?.snapshot(symbol, store); } catch (error) { active?.noteError(error); }
}

function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(fraction * sorted.length) - 1] : null;
}

function wilson(wins: number, count: number): [number, number] | null {
  if (!count) return null;
  const z = 1.959964, p = wins / count, denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const delta = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return [center - delta, center + delta];
}

export function buildSignalFlowReport(directory: string, nowMs = Date.now()) {
  const protocol: SignalFlowProtocol = JSON.parse(fs.readFileSync(path.join(directory, 'protocol.json'), 'utf8'));
  const protocolHash = sha256(fs.readFileSync(path.join(directory, 'protocol.json')));
  const activationPath = path.join(directory, 'activation.json');
  const activation = fs.existsSync(activationPath) ? JSON.parse(fs.readFileSync(activationPath, 'utf8')) : null;
  const startMs = activation ? Date.parse(activation.activatedAt) : Infinity;
  const raw = readFlowEvents(directory);
  const events = raw.events.filter(e => e.protocolHash === protocolHash && Date.parse(e.observedAt) >= startMs
    && Date.parse(e.observedAt) <= nowMs);
  const plans = events.filter(e => e.type === 'PLAN');
  const firstAdmitted = new Map<string, FlowEvent>();
  for (const event of plans) if (event.data.plan?.isAdmissible && !firstAdmitted.has(event.data.poiId))
    firstAdmitted.set(event.data.poiId, event);
  const registrations = new Map<string, FlowEvent>();
  for (const event of events.filter(e => e.type === 'PAPER_REGISTERED')) {
    const d = event.data;
    if (d.executionPolicyId?.includes(`plan-${protocol.planVersion ?? 'v1.2'}`) && Date.parse(d.signalGeneratedAt) >= startMs
        && d.plan?.isAdmissible && d.plan?.entryRange && !registrations.has(d.signalId))
      registrations.set(d.signalId, event);
  }
  const latestClose = new Map<string, FlowEvent>();
  for (const event of events.filter(e => e.type === 'PAPER_CLOSED')) {
    if (registrations.has(event.data.signalId)) latestClose.set(event.data.signalId, event);
  }
  const entryIds = new Set(events.filter(e => e.type === 'PAPER_ENTERED' && registrations.has(e.data.signalId)).map(e => e.data.signalId));
  const cohort = (basis: string) => {
    const registered = [...registrations.values()].filter(e => e.data.plan.admissionBasis === basis && e.data.macroAllowed === true);
    const ids = new Set(registered.map(e => e.data.signalId));
    const closed = [...latestClose.values()].filter(e => ids.has(e.data.signalId));
    const filled = closed.filter(e => entryIds.has(e.data.signalId) && e.data.entryConfirmed
      && ['TP', 'SL', 'BE'].includes(e.data.outcome) && Number.isFinite(e.data.realizedR)
      && Number.isFinite(e.data.netRealizedR) && e.data.costModel === 'ESTIMATED'
      && Number.isFinite(e.data.entryTimestamp) && e.data.entryTimestamp >= startMs
      && Number.isFinite(e.data.exitTimestamp) && e.data.exitTimestamp >= e.data.entryTimestamp
      && Number.isFinite(e.data.totalCostR) && e.data.totalCostR >= 0
      && Math.abs(e.data.realizedR - e.data.totalCostR - e.data.netRealizedR) <= .011);
    const tp = filled.filter(e => e.data.outcome === 'TP').length;
    const sl = filled.filter(e => e.data.outcome === 'SL').length;
    const be = filled.filter(e => e.data.outcome === 'BE').length;
    const netR = filled.reduce((sum, e) => sum + e.data.netRealizedR, 0);
    return { admittedPaperCandidates: ids.size, entered: [...entryIds].filter(id => ids.has(id)).length,
      closedFilled: filled.length, tp, sl, be, tpRateAmongClosedFilled: filled.length ? tp / filled.length : null,
      tpRateWilson95: wilson(tp, filled.length), slRateAmongClosedFilled: filled.length ? sl / filled.length : null,
      estimatedNetR: netR, meanEstimatedNetR: filled.length ? netR / filled.length : null,
      unfilledCancelledOrExpired: closed.filter(e => !entryIds.has(e.data.signalId)).length,
      unresolvedOrUnknown: [...ids].filter(id => !filled.some(e => e.data.signalId === id)
        && !closed.some(e => e.data.signalId === id && !entryIds.has(id))).length,
      ambiguousClosedFills: filled.filter(e => e.data.ambiguousIntracandleConflict).length,
      independentUtcWeeks: new Set(filled.map(e => {
        const date = new Date(e.data.entryTimestamp); date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.toISOString().slice(0, 10);
      })).size };
  };
  const reference = cohort('REFERENCE'), conditional = cohort('CONDITIONAL_ENTRY');
  const requests = events.filter(e => e.type === 'PROVIDER_REQUEST');
  const started = events.filter(e => e.type === 'PROVIDER_QUEUE' && e.data.event === 'STARTED');
  const failed = events.filter(e => e.type === 'PROVIDER_QUEUE' && e.data.event === 'FAILED');
  const polls = events.filter(e => e.type === 'POLL');
  const closedFills = reference.closedFilled + conditional.closedFilled;
  const elapsedDays = Number.isFinite(startMs) ? Math.max(0, (nowMs - startMs) / 86_400_000) : 0;
  let status: any = null;
  try { status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8')); } catch {}
  const issues = [raw.malformedLines ? `MALFORMED_EVENTS:${raw.malformedLines}` : null,
    raw.events.some(e => e.protocolHash !== protocolHash) ? 'EVENT_PROTOCOL_MISMATCH' : null,
    activation && !status ? 'MISSING_RUNTIME_HEARTBEAT' : null,
    status && status.protocolHash !== protocolHash ? 'STATUS_PROTOCOL_MISMATCH' : null,
    status?.writeErrors ? `WRITE_ERRORS:${status.writeErrors}` : null,
    status && nowMs - Date.parse(status.heartbeatAt) > 180_000 ? 'STALE_RUNTIME_HEARTBEAT' : null].filter(Boolean);
  return { runId: protocol.runId, generatedAt: new Date(nowMs).toISOString(), activatedAt: activation?.activatedAt ?? null,
    protocolHash, runtime: status, dataQualityIssues: issues,
    scope: protocol.outcomeScope, planVersion: protocol.planVersion ?? 'v1.2', elapsedCalendarDays: elapsedDays,
    pairedV12Geometry: {
      observations: plans.filter(e => e.data.baselineV12).length,
      v12Admissible: plans.filter(e => e.data.baselineV12?.isAdmissible).length,
      v13Admissible: plans.filter(e => e.data.baselineV12 && e.data.plan?.isAdmissible).length,
      interpretation: 'Same upstream SMC population; geometry observations, not realized trade results.',
    },
    eligibility: { planObservations: plans.length, uniqueObservedPois: new Set(plans.map(e => e.data.poiId)).size,
      firstAdmittedPois: firstAdmitted.size,
      reference: [...firstAdmitted.values()].filter(e => e.data.plan.admissionBasis === 'REFERENCE').length,
      conditional: [...firstAdmitted.values()].filter(e => e.data.plan.admissionBasis === 'CONDITIONAL_ENTRY').length,
      firstAdmittedMacroAllowed: [...firstAdmitted.values()].filter(e => e.data.macroAllowed === true).length,
      archivedMarketSnapshots: events.filter(e => e.type === 'MARKET_SNAPSHOT').length },
    operations: { providerAttempts: requests.length, providerFailures: requests.filter(e => !e.data.success).length,
      providerFailureRate: requests.length ? requests.filter(e => !e.data.success).length / requests.length : null,
      localDailyDeferrals: failed.filter(e => e.data.limitScope === 'DAY' && e.data.networkAttempts === 0).length,
      expiredQueueJobs: failed.filter(e => e.data.errorType === 'ProviderRequestExpiredError').length,
      queueStartedSamples: started.length, queueWaitP95Ms: percentile(started.map(e => e.data.queueAgeMs), .95),
      pollingAttempts: polls.length, pollingFailures: polls.filter(e => !e.data.success).length },
    paper: { reference, conditional, excludedRegistrations: events.filter(e => e.type === 'PAPER_REGISTERED').length - registrations.size,
      registeredMacroBlocked: [...registrations.values()].filter(e => e.data.macroAllowed === false).length },
    reviewGate: { ...protocol.reviewGate, closedPaperFills: closedFills,
      calendarDaysMet: elapsedDays >= protocol.reviewGate.minimumCalendarDays,
      closedFillsMet: closedFills >= protocol.reviewGate.minimumClosedPaperFills,
      independentWeeksMet: Math.min(reference.independentUtcWeeks, conditional.independentUtcWeeks)
        >= protocol.reviewGate.minimumIndependentWeeks,
      automaticPromotion: false, conclusion: issues.length ? 'DATA_QUALITY_REVIEW_REQUIRED'
        : elapsedDays >= protocol.reviewGate.minimumCalendarDays && closedFills >= protocol.reviewGate.minimumClosedPaperFills
          && Math.min(reference.independentUtcWeeks, conditional.independentUtcWeeks) >= protocol.reviewGate.minimumIndependentWeeks
          ? 'READY_FOR_MANUAL_REVIEW_NOT_EDGE_PROOF' : 'INSUFFICIENT_FORWARD_EVIDENCE' },
    limitations: ['M15 paper fills are not actual manual M1 execution.',
      'Cohorts are selected by geometry; differences are not randomized causal estimates.',
      'Operational before/after comparisons may differ in symbols, sessions and provider quotas.',
      'Wilson intervals assume independent trades and can understate correlated-market uncertainty.',
      'All costs are model estimates. Missing or unresolved outcomes are not wins.'] };
}

export function writeSignalFlowReport(directory: string) {
  const report = buildSignalFlowReport(directory);
  const pct = (v: number | null) => v === null ? 'Henüz ölçülemedi' : `%${(v * 100).toFixed(1)}`;
  const contents = {
    'report.json': JSON.stringify(report, null, 2) + '\n',
    'REPORT.md': [
      '# Begonya ileri ölçüm', '', `Başlangıç: ${report.activatedAt ?? 'Henüz etkin değil'}. Rapor: ${report.generatedAt}.`, '',
      '**Kapsam:** Gerçek zamanda kaydedilen M15 paper modeli. Kullanıcının gerçek M1 dolumları değildir.', '',
      '| Kohort | Paper aday | Dolum | Kapalı dolum | TP | SL | BE | TP oranı | Ortalama tahmini net R |',
      '|---|---:|---:|---:|---:|---:|---:|---|---|',
      ...([['Referans', report.paper.reference], ['Koşullu giriş', report.paper.conditional]] as const).map(([name, c]) =>
        `| ${name} | ${c.admittedPaperCandidates} | ${c.entered} | ${c.closedFilled} | ${c.tp} | ${c.sl} | ${c.be} | ${pct(c.tpRateAmongClosedFilled)} | ${c.meanEstimatedNetR?.toFixed(3) ?? 'Henüz ölçülemedi'} |`), '',
      `Benzersiz gözlenen POI: ${report.eligibility.uniqueObservedPois}; koşullu kabul: ${report.eligibility.conditional}.`,
      `Sağlayıcı denemesi: ${report.operations.providerAttempts}; hata: ${report.operations.providerFailures}; yalnızca yerel günlük kota ertelemesi: ${report.operations.localDailyDeferrals}.`,
      `Kuyruk p95: ${report.operations.queueWaitP95Ms === null ? 'Henüz ölçülemedi' : `${report.operations.queueWaitP95Ms} ms`}.`, '',
      `Veri sorunları: ${report.dataQualityIssues.join(', ') || 'Kaydedilmiş sorun yok; bu, sonuç kanıtı değildir.'}`, '',
      'İlk inceleme için en az 28 takvim günü, toplam 100 kapanmış paper dolumu ve her iki kohortta 4 UTC haftası aranır. Bu sayılar başarı veya istatistiksel anlamlılık garantisi değildir.', '',
      'Kohortlar rastgele seçilmez. TP/SL farkı nedensel iyileşme diye yorumlanamaz. Maliyetler tahminidir. Açık, eksik ve bilinmeyen işlemler kazanç sayılmaz. Otomatik canlı terfi yoktur.', '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(contents)) {
    const target = path.join(directory, name), tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  }
  return report;
}
