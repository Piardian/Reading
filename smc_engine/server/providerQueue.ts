import { Symbol, Timeframe } from './candleStore';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderRequestExpiredError,
  ProviderRequest,
  ProviderSuccess,
} from './providerTypes';
import {
  recordProviderQueueTelemetry,
  recordProviderTelemetry,
} from './telemetry';

export interface ProviderQueueMetrics {
  readonly queueLength: number;
  readonly activeRequest: ProviderQueueJobView | null;
  readonly waitingJobs: number;
  readonly completedJobs: number;
  readonly retryCount: number;
  readonly failedJobs: number;
  readonly coalescedRequests: number;
  readonly expiredJobs: number;
  readonly dailyBlockedKeys: number;
  readonly nextDailyRetryAt: string | null;
}

export interface ProviderQueueJobView {
  readonly id: number;
  readonly endpoint: string;
  readonly symbol: Symbol;
  readonly timeframe: Timeframe;
  readonly retryCount: number;
}

type ProviderTransport = (request: ProviderRequest, retryCount: number, keyIndex?: number) => Promise<ProviderSuccess>;

interface QueueJob {
  readonly id: number;
  readonly request: ProviderRequest;
  retryCount: number;
  networkAttempts: number;
  readonly enqueuedAtMs: number;
  readonly expiresAtMs: number;
  readonly requestKey: string;
  readonly resolve: (value: ProviderSuccess) => void;
  readonly reject: (reason: unknown) => void;
}

export interface DeterministicProviderQueueOptions {
  readonly transport: ProviderTransport;
  readonly keyCount?: number;
  readonly creditsPerMinute?: number;
  readonly safetyMargin?: number;
  readonly maxRetries?: number;
  readonly windowBufferMs?: number;
  readonly priorityAgingMs?: number;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

interface KeyWindowState {
  windowStartMs: number;
  creditsUsed: number;
  cooldownUntilMs: number;
  dailyBlockedUntilMs: number;
}

const MAX_QUEUE_AGE_MS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 50_000, '15m': 14 * 60_000, '1h': 55 * 60_000, '4h': 230 * 60_000,
});

const TIMEFRAME_PRIORITY: Readonly<Record<Timeframe, number>> = Object.freeze({
  '15m': 0,
  '1h': 1,
  '4h': 2,
  '1m': 3,
});

export class DeterministicProviderQueue {
  private readonly transport: ProviderTransport;
  private readonly keyCount: number;
  private readonly creditsPerMinute: number;
  private readonly safetyMargin: number;
  private readonly maxRetries: number;
  private readonly windowBufferMs: number;
  private readonly priorityAgingMs: number;
  private readonly now: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly waiting: QueueJob[] = [];
  private readonly keyWindows: KeyWindowState[];
  private readonly pending = new Map<string, { promise: Promise<ProviderSuccess>; jobId: number; expiresAtMs: number }>();
  private active: QueueJob | null = null;
  private drainScheduled = false;
  private sequence = 0;
  private completedJobs = 0;
  private retries = 0;
  private failedJobs = 0;
  private coalescedRequests = 0;
  private expiredJobs = 0;
  private keyRoundRobin = 0;

  constructor(options: DeterministicProviderQueueOptions) {
    this.transport = options.transport;
    this.keyCount = positiveInteger(options.keyCount, 1);
    this.creditsPerMinute = positiveInteger(options.creditsPerMinute, 8);
    this.safetyMargin = nonNegativeInteger(options.safetyMargin, 1);
    this.maxRetries = nonNegativeInteger(options.maxRetries, 2);
    this.windowBufferMs = nonNegativeInteger(options.windowBufferMs, 250);
    this.priorityAgingMs = positiveInteger(options.priorityAgingMs, 60_000);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (durationMs => new Promise(resolve => setTimeout(resolve, durationMs)));
    this.keyWindows = Array.from({ length: this.keyCount }, () => ({
      windowStartMs: -1,
      creditsUsed: 0,
      cooldownUntilMs: 0,
      dailyBlockedUntilMs: 0,
    }));
    if (this.availableCreditsPerMinute < 1) {
      throw new Error('Provider queue safety margin must leave at least one usable credit per minute.');
    }
  }

  enqueue(request: ProviderRequest): Promise<ProviderSuccess> {
    // Share only identical requests in the same bar slot; a new close needs fresh data.
    const intervalMs = request.timeframe === '1m' ? 60_000 : request.timeframe === '15m' ? 900_000
      : request.timeframe === '1h' ? 3_600_000 : 14_400_000;
    const requestKey = `${request.endpoint}:${request.symbol}:${request.timeframe}:${request.outputSize}:${request.maxQueueAgeMs ?? 'default'}:${Math.floor(this.now() / intervalMs)}`;
    const existing = this.pending.get(requestKey);
    if (existing && existing.expiresAtMs > this.now()) {
      this.coalescedRequests += 1;
      return existing.promise;
    }
    const id = ++this.sequence;
    const enqueuedAtMs = this.now();
    const expiresAtMs = enqueuedAtMs + positiveInteger(request.maxQueueAgeMs, MAX_QUEUE_AGE_MS[request.timeframe]);
    const promise = new Promise<ProviderSuccess>((resolve, reject) => {
      const job: QueueJob = {
        id,
        request,
        retryCount: 0,
        networkAttempts: 0,
        enqueuedAtMs,
        expiresAtMs,
        requestKey,
        resolve,
        reject,
      };
      this.waiting.push(job);
      this.sortWaitingJobs();
      this.emitQueueTelemetry('ENQUEUED', job);
      this.scheduleDrain();
    });
    this.pending.set(requestKey, { promise, jobId: id, expiresAtMs });
    return promise;
  }

  getMetrics(): ProviderQueueMetrics {
    return Object.freeze({
      queueLength: this.waiting.length + (this.active ? 1 : 0),
      activeRequest: this.active ? jobView(this.active) : null,
      waitingJobs: this.waiting.length,
      completedJobs: this.completedJobs,
      retryCount: this.retries,
      failedJobs: this.failedJobs,
      coalescedRequests: this.coalescedRequests,
      expiredJobs: this.expiredJobs,
      dailyBlockedKeys: this.keyWindows.filter(key => key.dailyBlockedUntilMs > this.now()).length,
      nextDailyRetryAt: this.keyWindows.some(key => key.dailyBlockedUntilMs > this.now())
        ? new Date(Math.min(...this.keyWindows.filter(key => key.dailyBlockedUntilMs > this.now()).map(key => key.dailyBlockedUntilMs))).toISOString()
        : null,
    });
  }

  private get availableCreditsPerMinute(): number {
    return this.creditsPerMinute - this.safetyMargin;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.active) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.sortWaitingJobs();
    const job = this.waiting.shift();
    if (!job) return;
    this.active = job;
    this.emitQueueTelemetry('STARTED', job);

    try {
      const result = await this.executeWithRetry(job);
      this.assertUseful(job);
      this.completedJobs += 1;
      this.emitQueueTelemetry('COMPLETED', job);
      job.resolve(result);
    } catch (error) {
      this.failedJobs += 1;
      if (error instanceof ProviderRequestExpiredError) this.expiredJobs += 1;
      this.emitQueueTelemetry('FAILED', job, error);
      job.reject(error);
    } finally {
      if (this.pending.get(job.requestKey)?.jobId === job.id) this.pending.delete(job.requestKey);
      this.active = null;
      this.scheduleDrain();
    }
  }

  private async executeWithRetry(job: QueueJob): Promise<ProviderSuccess> {
    for (;;) {
      const keyIdx = await this.acquireKeyAndCredit(job);
      this.assertUseful(job);
      try {
        job.networkAttempts += 1;
        const result = await this.transport(job.request, job.retryCount, keyIdx);
        // Provider headers reflect other consumers using the same key as well.
        const key = this.keyWindows[keyIdx];
        if (Number.isFinite(result.metadata.apiCreditsUsed) && result.metadata.apiCreditsUsed !== null)
          key.creditsUsed = Math.max(key.creditsUsed, result.metadata.apiCreditsUsed);
        if (result.metadata.apiCreditsLeft === 0)
          key.cooldownUntilMs = Math.max(key.cooldownUntilMs, minuteWindowStart(this.now()) + 60_000 + this.windowBufferMs);
        recordProviderTelemetry({
          type: 'provider',
          provider: 'TWELVE_DATA',
          ...result.metadata,
          success: true,
          errorType: null,
          errorMessage: null,
        });
        return result;
      } catch (error) {
        recordProviderTelemetry(providerFailureTelemetry(job, error));
        if (!(error instanceof ProviderRateLimitError)) throw error;
        const now = this.now();
        const key = this.keyWindows[keyIdx];
        if (error.limitScope === 'DAY') {
          // Twelve Data's daily reset is midnight UTC. Do not occupy the queue until then.
          key.dailyBlockedUntilMs = Math.max((Math.floor(now / 86_400_000) + 1) * 86_400_000 + this.windowBufferMs,
            now + (error.retryAfterMs ?? 0));
        } else {
          key.cooldownUntilMs = Math.max(minuteWindowStart(now) + 60_000 + this.windowBufferMs,
            now + (error.retryAfterMs ?? 0));
        }
        // Apply cooldown even to the last failed attempt, so following jobs do not hammer the key.
        if (job.retryCount >= this.maxRetries) throw error;

        job.retryCount += 1;
        this.retries += 1;
        this.emitQueueTelemetry('RETRY_WAIT', job);

        // acquireKeyAndCredit selects another usable key, waits briefly, or fails explicitly.
      }
    }
  }

  private async acquireKeyAndCredit(job: QueueJob): Promise<number> {
    for (;;) {
      this.assertUseful(job);
      this.refreshAllWindows();
      const now = this.now();

      const candidateKeys: number[] = [];
      for (let i = 0; i < this.keyCount; i++) {
        const k = (this.keyRoundRobin + i) % this.keyCount;
        if (!candidateKeys.includes(k)) candidateKeys.push(k);
      }

      for (const keyIdx of candidateKeys) {
        const kw = this.keyWindows[keyIdx];
        if (now >= kw.dailyBlockedUntilMs && now >= kw.cooldownUntilMs && kw.creditsUsed < this.availableCreditsPerMinute) {
          kw.creditsUsed += 1;
          this.keyRoundRobin = (keyIdx + 1) % this.keyCount;
          return keyIdx;
        }
      }

      const dailyAvailable = this.keyWindows.filter(key => now >= key.dailyBlockedUntilMs);
      if (dailyAvailable.length === 0) {
        const retryAfterMs = Math.min(...this.keyWindows.map(key => key.dailyBlockedUntilMs)) - now;
        throw new ProviderRateLimitError('All configured provider keys have exhausted their daily quota; scan deferred until reset.',
          job.request, job.retryCount, retryAfterMs, null, null, 'DAY');
      }
      const earliest = Math.min(...dailyAvailable.map(key => Math.max(key.cooldownUntilMs,
        key.creditsUsed >= this.availableCreditsPerMinute ? minuteWindowStart(now) + 60_000 + this.windowBufferMs : now)));
      await this.sleep(Math.min(Math.max(1, earliest - now), job.expiresAtMs - now));
    }
  }

  private refreshAllWindows(): void {
    const currentWindow = minuteWindowStart(this.now());
    for (const kw of this.keyWindows) {
      if (kw.windowStartMs !== currentWindow) {
        kw.windowStartMs = currentWindow;
        kw.creditsUsed = 0;
      }
    }
  }

  private assertUseful(job: QueueJob): void {
    if (this.now() >= job.expiresAtMs) throw new ProviderRequestExpiredError(job.request, job.retryCount);
  }

  private sortWaitingJobs(): void {
    const now = this.now();
    // Aging lets H1/H4 catch up; FIFO removes permanent preference for the first symbols.
    const priority = (job: QueueJob) => TIMEFRAME_PRIORITY[job.request.timeframe]
      - Math.floor((now - job.enqueuedAtMs) / this.priorityAgingMs);
    this.waiting.sort((left, right) =>
      priority(left) - priority(right) ||
      left.id - right.id
    );
  }

  private emitQueueTelemetry(
    event: 'ENQUEUED' | 'STARTED' | 'RETRY_WAIT' | 'COMPLETED' | 'FAILED',
    job: QueueJob,
    error?: unknown
  ): void {
    const metrics = this.getMetrics();
    recordProviderQueueTelemetry({
      type: 'provider_queue',
      provider: 'TWELVE_DATA',
      event,
      jobId: job.id,
      endpoint: job.request.endpoint,
      symbol: job.request.symbol,
      timeframe: job.request.timeframe,
      jobRetryCount: job.retryCount,
      networkAttempts: job.networkAttempts,
      queueLength: metrics.queueLength,
      activeRequest: metrics.activeRequest,
      waitingJobs: metrics.waitingJobs,
      completedJobs: metrics.completedJobs,
      retryCount: metrics.retryCount,
      failedJobs: metrics.failedJobs,
      queueAgeMs: Math.max(0, this.now() - job.enqueuedAtMs),
      deadlineAt: new Date(job.expiresAtMs).toISOString(),
      coalescedRequests: metrics.coalescedRequests,
      expiredJobs: metrics.expiredJobs,
      dailyBlockedKeys: metrics.dailyBlockedKeys,
      nextDailyRetryAt: metrics.nextDailyRetryAt,
      errorType: error instanceof Error ? error.name : null,
      errorMessage: error instanceof Error ? error.message : null,
      limitScope: error instanceof ProviderRateLimitError ? error.limitScope : null,
    });
  }
}


function providerFailureTelemetry(job: QueueJob, error: unknown) {
  const providerError = error instanceof Error ? error : new Error(String(error));
  const metadata = (error as { metadata?: ProviderSuccess['metadata'] } | null)?.metadata;
  return {
    type: 'provider' as const,
    provider: 'TWELVE_DATA' as const,
    requestTimestamp: metadata?.requestTimestamp ?? new Date().toISOString(),
    responseTimestamp: metadata?.responseTimestamp ?? new Date().toISOString(),
    latencyMs: metadata?.latencyMs ?? 0,
    endpoint: job.request.endpoint,
    symbol: job.request.symbol,
    timeframe: job.request.timeframe,
    httpStatus: metadata?.httpStatus ?? (error instanceof ProviderError ? error.httpStatus : null),
    retryCount: job.retryCount,
    apiCreditsUsed: error instanceof ProviderRateLimitError ? error.apiCreditsUsed : null,
    apiCreditsLeft: error instanceof ProviderRateLimitError ? error.apiCreditsLeft : null,
    success: false,
    errorType: providerError.name,
    errorMessage: providerError.message,
  };
}

function jobView(job: QueueJob): ProviderQueueJobView {
  return Object.freeze({
    id: job.id,
    endpoint: job.request.endpoint,
    symbol: job.request.symbol,
    timeframe: job.request.timeframe,
    retryCount: job.retryCount,
  });
}

function minuteWindowStart(timestampMs: number): number {
  return Math.floor(timestampMs / 60_000) * 60_000;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : fallback;
}
