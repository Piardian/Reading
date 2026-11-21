import * as fs from 'fs';
import * as path from 'path';
import { LtfExecutionStateMachine, LtfExecutionPhase } from '../src/executionStateMachine1m';
import { Candle } from '../src/types';
import { getPipSize, getEstimatedSpreadPips, formatPrice, isRolloverSpreadWindow } from '../src/assetMetrics';
import type { NotificationCandidate } from './pipeline';
import type { Symbol } from './universe';
import { fetchCandles } from './twelveDataClient';
import { NewsGuard } from './newsGuard';
import { MacroGateAdapter } from './macroGateAdapter';
import { sendTelegramMessage } from './telegramSender';

/**
 * M1 Confirmation Watcher (Begonya v2 - Otomatik 1M Teyit Bildirimi)
 *
 * The 15M pipeline finds the POI. This watcher follows the POI on closed 1M candles and
 * only reports an ENTRY when the LTF sequence (zone touch -> 1M sweep -> displacement/CHoCH
 * -> 1M FVG) is complete. It never places orders; the final decision stays with the user.
 *
 * Modes:
 *  - FOLLOW_UP:          the user already received the 15M setup card. The watcher sends the
 *                        ENTRY confirmation, or a cancel note when the zone is sliced through.
 *  - CONFIRMATION_ONLY:  HTF premium/discount context is opposite to the trade. No 15M card is
 *                        sent; the user only hears about it if 1M confirmation arrives, and the
 *                        suggested risk is reduced (default 0.5x).
 *
 * Every confirmed ENTRY must still pass: net R:R >= M1_MIN_NET_RR (target = 15M plan target that is
 * already capped in front of the opposing zone), macro gate, news freeze/upcoming red news,
 * rollover window, weak-session block and the same-currency exposure cap.
 */

export type M1WatchMode = 'FOLLOW_UP' | 'CONFIRMATION_ONLY';
export type M1WatchStatus =
  | 'WATCHING'
  | 'ENTRY_SENT'
  | 'CONFIRMED_BLOCKED'
  | 'MISSED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'CLOSED';

export interface M1EntryPlan {
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly netRR: number;
  readonly riskPct: number;
  readonly sentAt: number;
}

export interface M1WatchRecord {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  poiType: 'OB' | 'FVG';
  zoneLow: number;
  zoneHigh: number;
  invalidationLevel: number;
  planTargetPrice: number | null;
  baseRiskPct: number;
  riskMultiplier: number;
  mode: M1WatchMode;
  reason: string;
  grade: string;
  score: number;
  registeredAt: number;
  expiresAt: number;
  status: M1WatchStatus;
  phase: LtfExecutionPhase;
  candles: Candle[];
  lastFetchAt: number;
  lastPrice: number | null;
  entry?: M1EntryPlan;
  blockReason?: string;
  outcome?: string;
  newsAlertsSent: string[];
}

export interface M1WatcherConfig {
  readonly maxActiveWatches: number;
  readonly ttlHours: number;
  readonly minNetRR: number;
  readonly htfConflictRiskMultiplier: number;
  readonly blockedHoursTsi: readonly [number, number] | null;
  readonly maxSameCurrencyExposure: number;
  readonly exposureWindowHours: number;
  readonly newsAlertMinutes: number;
}

export interface M1WatcherDependencies {
  fetch1m: (symbol: string, outputSize: number) => Promise<Candle[]>;
  send: (text: string, signalId: string) => Promise<boolean>;
  now: () => number;
  macroAllowed: (symbol: string, direction: 'long' | 'short', score: number) => boolean;
  newsStatus: (symbol: string, nowMs: number) => { frozen: boolean; upcoming?: { id: string; name: string; minutes: number; impact: string } };
  storePath: string | null;
  outcomeLogPath: string | null;
}

const ONE_MINUTE = 60_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseHourWindow(raw: string | undefined, fallback: string): readonly [number, number] | null {
  const value = (raw ?? fallback).trim();
  if (value === '' || value.toLowerCase() === 'off') return null;
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return [start, end];
}

export function loadM1WatcherConfig(): M1WatcherConfig {
  return {
    maxActiveWatches: Math.max(1, Math.floor(envNumber('M1_WATCH_MAX', 8))),
    ttlHours: Math.max(1, envNumber('M1_WATCH_TTL_HOURS', 12)),
    minNetRR: Math.max(1, envNumber('M1_MIN_NET_RR', 2.0)),
    htfConflictRiskMultiplier: Math.min(1, Math.max(0.1, envNumber('M1_HTF_CONFLICT_RISK_MULTIPLIER', 0.5))),
    // Shadow ledger: confirmed entries between 21:00-06:00 TSI had ~0 expectancy.
    blockedHoursTsi: parseHourWindow(process.env.M1_ENTRY_BLOCKED_HOURS_TSI, '21-6'),
    maxSameCurrencyExposure: Math.max(1, Math.floor(envNumber('M1_MAX_SAME_CURRENCY_EXPOSURE', 2))),
    exposureWindowHours: Math.max(1, envNumber('M1_EXPOSURE_WINDOW_HOURS', 8)),
    newsAlertMinutes: Math.max(5, envNumber('M1_NEWS_ALERT_MINUTES', 30)),
  };
}

/** Currency exposures of a directional trade, e.g. long EURJPY => { EUR: +1, JPY: -1 }. */
export function currencyExposures(symbol: string, direction: 'long' | 'short'): Record<string, number> {
  const sign = direction === 'long' ? 1 : -1;
  const s = symbol.toUpperCase();
  let base: string;
  let quote: string | null;
  if (/^[A-Z]{6}$/.test(s)) {
    base = s.slice(0, 3);
    quote = s.slice(3);
  } else if (s.endsWith('USDT')) {
    base = s.slice(0, -4);
    quote = 'USD';
  } else if (s.endsWith('USD') && s.length > 3) {
    base = s.slice(0, -3);
    quote = 'USD';
  } else {
    base = s;
    quote = null;
  }
  const result: Record<string, number> = { [base]: sign };
  if (quote) result[quote] = (result[quote] ?? 0) - sign;
  return result;
}

/** Hour of day in Europe/Istanbul (TSI). */
export function istanbulHour(nowMs: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: 'numeric', hour12: false });
  const hour = Number(formatter.formatToParts(new Date(nowMs)).find(p => p.type === 'hour')?.value ?? '0');
  return hour === 24 ? 0 : hour;
}

export function isHourBlocked(hour: number, window: readonly [number, number] | null): boolean {
  if (!window) return false;
  const [start, end] = window;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * HTF premium/discount routing (user decision A2): if 4H or 1H premium/discount is directly
 * opposite to the trade, the setup is NOT announced at 15M. It is only reported when 1M
 * confirmation arrives and with reduced risk.
 */
export function classifyHtfPdRouting(candidate: Pick<NotificationCandidate, 'tradeDirection' | 'pd4H' | 'pd1H'>): {
  requiresM1Confirmation: boolean;
  reason: string;
} {
  const long = candidate.tradeDirection === 'long';
  const opposite = long ? 'premium' : 'discount';
  const conflicts: string[] = [];
  if (candidate.pd4H === opposite) conflicts.push(`4H ${opposite}`);
  if (candidate.pd1H === opposite) conflicts.push(`1H ${opposite}`);
  return {
    requiresM1Confirmation: conflicts.length > 0,
    reason: conflicts.length > 0
      ? `HTF P/D ters (${conflicts.join(' + ')}) - sadece 1M teyidiyle, azaltılmış riskle`
      : 'HTF P/D uyumlu',
  };
}

function zoneOf(candidate: NotificationCandidate): { low: number; high: number } {
  if (candidate.poiType === 'OB') {
    const ob = candidate.poi as { low: number; high: number };
    return { low: ob.low, high: ob.high };
  }
  const fvg = candidate.poi as { gapLow: number; gapHigh: number };
  return { low: fvg.gapLow, high: fvg.gapHigh };
}

function stopBufferPips(symbol: string): number {
  return Math.max(1.5, getEstimatedSpreadPips(symbol) * 1.5);
}

function directionLabel(direction: 'long' | 'short'): string {
  return direction === 'long' ? 'AL (LONG)' : 'SAT (SHORT)';
}

export class M1ConfirmationWatcher {
  private static instance: M1ConfirmationWatcher | null = null;
  private records: M1WatchRecord[] = [];
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: M1WatcherDependencies, private readonly config: M1WatcherConfig = loadM1WatcherConfig()) {
    this.load();
  }

  public static getInstance(): M1ConfirmationWatcher {
    if (!M1ConfirmationWatcher.instance) {
      const dataDir = path.join(process.cwd(), 'data');
      const evidenceDir = path.join(process.cwd(), 'evidence');
      M1ConfirmationWatcher.instance = new M1ConfirmationWatcher({
        fetch1m: async (symbol, outputSize) => fetchCandles(symbol as Symbol, '1m', outputSize) as unknown as Candle[],
        send: (text, signalId) => sendTelegramMessage(text, { signalId, retryCount: 0 }),
        now: () => Date.now(),
        macroAllowed: (symbol, direction, score) => {
          try {
            return MacroGateAdapter.getInstance().evaluateCandidate(symbol, direction, score).allowed;
          } catch {
            return false;
          }
        },
        newsStatus: (symbol, nowMs) => {
          try {
            const guard = NewsGuard.getInstance();
            const frozen = guard.checkNewsFreeze(symbol, nowMs).isFrozen;
            const next = guard.getNearestUpcomingEvent(symbol, nowMs);
            return {
              frozen: frozen || Boolean(next?.isFrozen),
              upcoming: next ? { id: next.event.id, name: next.event.name, minutes: next.minutesToEvent, impact: next.event.impact } : undefined,
            };
          } catch {
            return { frozen: false };
          }
        },
        storePath: process.env.NODE_ENV === 'test' ? null : path.join(dataDir, 'm1_confirmation_watch.json'),
        outcomeLogPath: process.env.NODE_ENV === 'test' ? null : path.join(evidenceDir, 'm1_confirmation_outcomes.jsonl'),
      });
    }
    return M1ConfirmationWatcher.instance;
  }

  public static resetForTests(): void {
    M1ConfirmationWatcher.instance?.stop();
    M1ConfirmationWatcher.instance = null;
  }

  public start(intervalMs = ONE_MINUTE): void {
    if (this.timer || process.env.ENABLE_M1_CONFIRMATION_WATCHER === 'false') return;
    this.timer = setInterval(() => {
      void this.tick().catch(err => console.warn('[M1Watcher] tick failed:', err));
    }, intervalMs);
    this.timer.unref?.();
    console.log(`[M1Watcher] started (max=${this.config.maxActiveWatches}, minNetRR=${this.config.minNetRR}, blockedHoursTSI=${this.config.blockedHoursTsi?.join('-') ?? 'off'})`);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public list(): readonly M1WatchRecord[] {
    return this.records;
  }

  public activeCount(): number {
    return this.records.filter(r => r.status === 'WATCHING' || r.status === 'ENTRY_SENT').length;
  }

  /** Registers a 15M candidate for 1M confirmation monitoring. Returns false when not registered. */
  public register(candidate: NotificationCandidate, options: { mode: M1WatchMode; reason?: string }): boolean {
    const id = candidate.dedupeKey ?? candidate.uniqueKey;
    if (this.records.some(r => r.id === id)) return false;
    if (this.records.filter(r => r.status === 'WATCHING').length >= this.config.maxActiveWatches) {
      console.warn(`[M1Watcher] ${id} not registered: watch capacity (${this.config.maxActiveWatches}) reached`);
      return false;
    }
    const zone = zoneOf(candidate);
    const pip = getPipSize(candidate.symbol);
    const tolerance = Math.max(1, getEstimatedSpreadPips(candidate.symbol) * 1.5) * pip;
    const plan = candidate.expectancyPlan;
    const target = plan?.tp2?.price;
    const now = this.deps.now();
    const riskMultiplier = options.mode === 'CONFIRMATION_ONLY' ? this.config.htfConflictRiskMultiplier : 1;
    this.records.push({
      id,
      symbol: candidate.symbol,
      direction: candidate.tradeDirection,
      poiType: candidate.poiType,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      invalidationLevel: candidate.tradeDirection === 'long' ? zone.low - tolerance : zone.high + tolerance,
      planTargetPrice: Number.isFinite(target) ? (target as number) : null,
      baseRiskPct: plan?.recommendedRiskPct ?? 0.5,
      riskMultiplier,
      mode: options.mode,
      reason: options.reason ?? '',
      grade: candidate.gradeResult.grade,
      score: candidate.gradeResult.totalScore,
      registeredAt: now,
      expiresAt: now + this.config.ttlHours * 3_600_000,
      status: 'WATCHING',
      phase: 'WATCHING_POI_TOUCH',
      candles: [],
      lastFetchAt: 0,
      lastPrice: candidate.currentPrice ?? null,
      newsAlertsSent: [],
    });
    this.persist();
    console.log(`[M1Watcher] registered ${id} ${candidate.symbol} ${candidate.tradeDirection} mode=${options.mode} risk x${riskMultiplier}`);
    return true;
  }

  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now();
      for (const record of this.records) {
        if (record.status !== 'WATCHING' && record.status !== 'ENTRY_SENT') continue;
        try {
          await this.processRecord(record, now);
        } catch (err) {
          console.warn(`[M1Watcher] ${record.id} processing failed:`, err);
        }
      }
      await this.runNewsShield(now);
      this.prune(now);
      this.persist();
    } finally {
      this.ticking = false;
    }
  }

  private fetchIntervalMs(record: M1WatchRecord): number {
    if (record.status === 'ENTRY_SENT') return ONE_MINUTE;
    if (record.phase !== 'WATCHING_POI_TOUCH') return ONE_MINUTE;
    const price = record.lastPrice;
    const height = Math.max(record.zoneHigh - record.zoneLow, getPipSize(record.symbol));
    if (price === null) return ONE_MINUTE;
    const distance = price > record.zoneHigh ? price - record.zoneHigh : price < record.zoneLow ? record.zoneLow - price : 0;
    const zones = distance / height;
    if (zones > 2) return 15 * ONE_MINUTE;
    if (zones > 0.5) return 3 * ONE_MINUTE;
    return ONE_MINUTE;
  }

  private async processRecord(record: M1WatchRecord, now: number): Promise<void> {
    if (record.status === 'WATCHING' && now > record.expiresAt) {
      this.finish(record, 'EXPIRED', 'TTL doldu; 1M teyidi oluşmadı');
      return;
    }
    if (now - record.lastFetchAt < this.fetchIntervalMs(record) - 5_000) return;

    const lastTs = record.candles[record.candles.length - 1]?.timestamp ?? record.registeredAt - ONE_MINUTE;
    const outputSize = Math.min(300, Math.max(5, Math.ceil((now - lastTs) / ONE_MINUTE) + 2));
    record.lastFetchAt = now;
    const fetched = await this.deps.fetch1m(record.symbol, outputSize);
    const closed = fetched
      .filter(c => c.timestamp > lastTs && c.timestamp + ONE_MINUTE <= now && c.timestamp >= record.registeredAt - ONE_MINUTE)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (closed.length === 0) return;
    record.lastPrice = closed[closed.length - 1].close;

    const previousPhase = record.phase;
    record.candles.push(...closed.map(c => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    const machine = this.replay(record);
    const snapshot = machine.getSnapshot();
    record.phase = snapshot.phase;

    if (record.status === 'ENTRY_SENT') {
      if (snapshot.phase === 'EXITED' || snapshot.phase === 'INVALIDATED' || snapshot.phase === 'EXPIRED') {
        record.outcome = snapshot.outcome ?? snapshot.phase;
        this.logOutcome(record, { event: 'OUTCOME', outcome: record.outcome, rr: snapshot.rrAchieved ?? null, reason: snapshot.terminationReason ?? null });
        record.status = 'CLOSED';
      }
      return;
    }

    if (snapshot.phase === 'INVALIDATED' || snapshot.phase === 'EXPIRED') {
      const reason = snapshot.terminationReason ?? snapshot.phase;
      this.finish(record, snapshot.phase === 'INVALIDATED' ? 'INVALIDATED' : 'EXPIRED', reason);
      if (record.mode === 'FOLLOW_UP' && snapshot.phase === 'INVALIDATED') {
        await this.deps.send(this.buildCancelMessage(record, reason), `${record.id}:m1-cancel`);
      }
      return;
    }

    const armedNow = snapshot.order && previousPhase !== 'LIMIT_ARMED' && snapshot.phase !== 'IDLE';
    if (!armedNow || !snapshot.order) return;

    if (snapshot.phase === 'FILLED' || snapshot.phase === 'EXITED') {
      // Confirmation and fill both happened inside a catch-up batch: too late to act.
      this.finish(record, 'MISSED', '1M teyidi geç tespit edildi (giriş fiyatı zaten görüldü)');
      return;
    }

    await this.handleConfirmation(record, snapshot.order, now);
  }

  private replay(record: M1WatchRecord): LtfExecutionStateMachine {
    const machine = new LtfExecutionStateMachine({
      id: record.id,
      symbol: record.symbol,
      direction: record.direction,
      poiType: record.poiType,
      zoneLow: record.zoneLow,
      zoneHigh: record.zoneHigh,
      invalidationLevel: record.invalidationLevel,
      pipSize: getPipSize(record.symbol),
      maxMonitoringBars: 90,
      // Item 4 (partial/BE management) is intentionally NOT automated: BE is disabled.
      breakEvenAtR: Number.MAX_SAFE_INTEGER,
      stopBufferPips: stopBufferPips(record.symbol),
      ...(record.planTargetPrice !== null ? { targetPrice: record.planTargetPrice } : {}),
    });
    for (const candle of record.candles) machine.processCandle(candle);
    return machine;
  }

  private async handleConfirmation(
    record: M1WatchRecord,
    order: { entryPrice: number; stopLoss: number; takeProfit: number; riskDistance: number },
    now: number
  ): Promise<void> {
    const pip = getPipSize(record.symbol);
    const cost = getEstimatedSpreadPips(record.symbol) * pip;
    const long = record.direction === 'long';
    const reward = long ? order.takeProfit - order.entryPrice : order.entryPrice - order.takeProfit;
    const netRR = order.riskDistance > 0 ? (reward - cost) / (order.riskDistance + cost) : Number.NEGATIVE_INFINITY;
    const riskPct = Number((record.baseRiskPct * record.riskMultiplier).toFixed(3));

    const blockReason = this.entryBlockReason(record, netRR, now);
    const entry: M1EntryPlan = {
      entryPrice: order.entryPrice,
      stopLoss: order.stopLoss,
      targetPrice: order.takeProfit,
      netRR: Number(netRR.toFixed(2)),
      riskPct,
      sentAt: now,
    };
    record.entry = entry;

    if (blockReason) {
      record.blockReason = blockReason;
      this.finish(record, 'CONFIRMED_BLOCKED', blockReason);
      if (record.mode === 'FOLLOW_UP') {
        await this.deps.send(this.buildBlockedMessage(record, blockReason), `${record.id}:m1-blocked`);
      }
      return;
    }

    const delivered = await this.deps.send(this.buildEntryMessage(record, entry), `${record.id}:m1-entry`);
    record.status = delivered ? 'ENTRY_SENT' : 'CONFIRMED_BLOCKED';
    if (!delivered) record.blockReason = 'telegram send failed';
    this.logOutcome(record, { event: delivered ? 'ENTRY_SENT' : 'ENTRY_SEND_FAILED', entry });
  }

  /** Returns a human readable reason when the confirmed entry must not be sent. */
  public entryBlockReason(record: M1WatchRecord, netRR: number, now: number): string | null {
    if (record.planTargetPrice === null) return '15M plan hedefi yok';
    if (!Number.isFinite(netRR) || netRR < this.config.minNetRR) {
      return `net R:R ${Number.isFinite(netRR) ? netRR.toFixed(2) : 'n/a'} < ${this.config.minNetRR} (hedef karşı bölgeyle sınırlı)`;
    }
    if (!this.deps.macroAllowed(record.symbol, record.direction, record.score)) return 'makro kapı artık izin vermiyor';
    const news = this.deps.newsStatus(record.symbol, now);
    if (news.frozen) return 'haber dondurma penceresi aktif';
    if (news.upcoming && news.upcoming.minutes > 0 && news.upcoming.minutes <= this.config.newsAlertMinutes
      && (news.upcoming.impact === 'HIGH' || news.upcoming.impact === 'CRITICAL')) {
      return `${news.upcoming.minutes} dk sonra yüksek etkili haber (${news.upcoming.name})`;
    }
    if (isRolloverSpreadWindow(now)) return 'rollover spread penceresi (23:50-01:15 TSİ)';
    const hour = istanbulHour(now);
    if (isHourBlocked(hour, this.config.blockedHoursTsi)) {
      return `zayıf seans saati (${this.config.blockedHoursTsi?.join('-')} TSİ arası giriş yok)`;
    }
    const exposureBlock = this.exposureBlockReason(record, now);
    if (exposureBlock) return exposureBlock;
    return null;
  }

  private exposureBlockReason(record: M1WatchRecord, now: number): string | null {
    const mine = currencyExposures(record.symbol, record.direction);
    const windowStart = now - this.config.exposureWindowHours * 3_600_000;
    const open = this.records.filter(r => r !== record && r.entry && r.entry.sentAt >= windowStart
      && (r.status === 'ENTRY_SENT' || (r.status === 'CLOSED' && r.outcome === undefined)));
    for (const [currency, sign] of Object.entries(mine)) {
      if (sign === 0) continue;
      const same = open.filter(r => Math.sign(currencyExposures(r.symbol, r.direction)[currency] ?? 0) === Math.sign(sign));
      if (same.length >= this.config.maxSameCurrencyExposure) {
        return `korelasyon limiti: son ${this.config.exposureWindowHours} saatte ${same.length} adet aynı yönlü ${currency} pozisyonu (${same.map(r => r.symbol).join(', ')})`;
      }
    }
    return null;
  }

  /** Open-position / pending-setup news shield (item 7). */
  private async runNewsShield(now: number): Promise<void> {
    for (const record of this.records) {
      const relevant = record.status === 'ENTRY_SENT' || (record.status === 'WATCHING' && record.mode === 'FOLLOW_UP');
      if (!relevant) continue;
      const news = this.deps.newsStatus(record.symbol, now);
      const upcoming = news.upcoming;
      if (!upcoming || (upcoming.impact !== 'HIGH' && upcoming.impact !== 'CRITICAL')) continue;
      if (upcoming.minutes <= 0 || upcoming.minutes > this.config.newsAlertMinutes) continue;
      if (record.newsAlertsSent.includes(upcoming.id)) continue;
      record.newsAlertsSent.push(upcoming.id);
      await this.deps.send(this.buildNewsMessage(record, upcoming), `${record.id}:news-${upcoming.id}`);
    }
  }

  private finish(record: M1WatchRecord, status: M1WatchStatus, reason: string): void {
    record.status = status;
    record.blockReason = record.blockReason ?? reason;
    this.logOutcome(record, { event: status, reason });
    console.log(`[M1Watcher] ${record.id} -> ${status}: ${reason}`);
  }

  private prune(now: number): void {
    const keepMs = 48 * 3_600_000;
    this.records = this.records.filter(r =>
      r.status === 'WATCHING' || r.status === 'ENTRY_SENT' || now - r.registeredAt < keepMs
    );
    for (const record of this.records) {
      if (record.candles.length > 1600) record.candles = record.candles.slice(-1600);
    }
  }

  private fmt(record: M1WatchRecord, value: number): string {
    return formatPrice(value, record.symbol);
  }

  public buildEntryMessage(record: M1WatchRecord, entry: M1EntryPlan): string {
    const pip = getPipSize(record.symbol);
    const riskPips = Math.abs(entry.entryPrice - entry.stopLoss) / pip;
    const lines = [
      '━━━━━━━━━━━━━━━━━━━━━━',
      `✅ BEGONYA | 1M GİRİŞ ONAYI`,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `Parite          : ${record.symbol}`,
      `Yön             : ${directionLabel(record.direction)}`,
      `15M POI         : ${record.poiType} ${this.fmt(record, record.zoneLow)} - ${this.fmt(record, record.zoneHigh)} (Grade ${record.grade})`,
      `1M Teyit        : Kutu teması → 1M sweep → displacement/CHoCH → 1M FVG`,
      '',
      `Limit Giriş     : ${this.fmt(record, entry.entryPrice)} (1M FVG %50)`,
      `Stop            : ${this.fmt(record, entry.stopLoss)} (1M sweep fitili ötesi, ${riskPips.toFixed(1)} pip)`,
      `Hedef           : ${this.fmt(record, entry.targetPrice)} (15M plan hedefi, karşı bölge önü)`,
      `Net R:R         : 1:${entry.netRR.toFixed(2)} (tahmini spread dahil)`,
      `Önerilen Risk   : %${entry.riskPct.toFixed(2)}${record.riskMultiplier < 1 ? ` (x${record.riskMultiplier} azaltılmış)` : ''}`,
    ];
    if (record.mode === 'CONFIRMATION_ONLY') {
      lines.push('', `⚠️ Not: ${record.reason}`);
    }
    lines.push(
      '',
      'Fiyat girişi görmeden stop seviyesine giderse emri iptal et.',
      'Bu bir bildirimdir; emir otomatik açılmadı, son karar sende.'
    );
    return lines.join('\n');
  }

  private buildCancelMessage(record: M1WatchRecord, reason: string): string {
    return [
      `❌ BEGONYA | KURULUM İPTAL — ${record.symbol} ${directionLabel(record.direction)}`,
      `15M POI ${this.fmt(record, record.zoneLow)} - ${this.fmt(record, record.zoneHigh)} 1M teyidi vermeden delindi.`,
      `Sebep: ${reason}`,
      'Bu kurulumda işleme girme.',
    ].join('\n');
  }

  private buildBlockedMessage(record: M1WatchRecord, reason: string): string {
    return [
      `⛔ BEGONYA | 1M TEYİT GELDİ AMA GİRİŞ YOK — ${record.symbol} ${directionLabel(record.direction)}`,
      `Sebep: ${reason}`,
      'Bu kurulumda işleme girme.',
    ].join('\n');
  }

  private buildNewsMessage(record: M1WatchRecord, upcoming: { name: string; minutes: number }): string {
    const state = record.status === 'ENTRY_SENT'
      ? 'Bu kurulumda pozisyondaysan: kârdaysan stopu girişe çek veya kapat; zarardaysan haber öncesi riskini gözden geçir.'
      : 'Bu kurulum için haber geçene kadar yeni giriş yapma.';
    return [
      `⚠️ BEGONYA | HABER KALKANI — ${record.symbol}`,
      `${upcoming.minutes} dk sonra: ${upcoming.name}`,
      state,
    ].join('\n');
  }

  private load(): void {
    if (!this.deps.storePath) return;
    try {
      if (!fs.existsSync(this.deps.storePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.deps.storePath, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(parsed)) this.records = parsed as M1WatchRecord[];
    } catch (err) {
      console.warn('[M1Watcher] state load failed; starting empty:', err);
      this.records = [];
    }
  }

  private persist(): void {
    if (!this.deps.storePath) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
      const tmp = `${this.deps.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.records));
      fs.renameSync(tmp, this.deps.storePath);
    } catch (err) {
      console.warn('[M1Watcher] state persist failed:', err);
    }
  }

  private logOutcome(record: M1WatchRecord, payload: Record<string, unknown>): void {
    if (!this.deps.outcomeLogPath) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.outcomeLogPath), { recursive: true });
      fs.appendFileSync(this.deps.outcomeLogPath, JSON.stringify({
        timestamp: new Date(this.deps.now()).toISOString(),
        id: record.id,
        symbol: record.symbol,
        direction: record.direction,
        mode: record.mode,
        riskMultiplier: record.riskMultiplier,
        ...payload,
      }) + '\n');
    } catch {
      // measurement must never break the runtime
    }
  }
}
