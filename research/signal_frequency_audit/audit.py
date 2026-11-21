"""Read-only production-log audit. Writes only research artifacts next to this script."""
from __future__ import annotations
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
UTC = dt.timezone.utc


def timestamp(value):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return dt.datetime.fromtimestamp(value / 1000 if value > 1e11 else value, UTC)
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def distribution(values):
    values = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v) and v >= 0)
    def q(p):
        return round(values[min(len(values) - 1, int((len(values) - 1) * p))], 2) if values else None
    return {'n': len(values), 'p50': q(.5), 'p95': q(.95), 'max': q(1)}


def real_id(value):
    return isinstance(value, str) and '_15m_' in value and not value.startswith(('test_', 'demo'))


def delivery_counts(rows, start, end):
    selected = {}
    for row in rows:
        t = timestamp(row.get('telegramSentAt'))
        if t and start <= t <= end and real_id(row.get('signalId')) and row.get('state') in {'SENT', 'SCREENSHOT_FAILED'}:
            selected[row['signalId']] = row
    return {'text_signals': len(selected), 'complete_deliveries': sum(r['state'] == 'SENT' for r in selected.values()),
            'image_failures_after_text': sum(r['state'] == 'SCREENSHOT_FAILED' for r in selected.values())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--as-of', help='Explicit UTC cutoff; default is capture time.')
    args = parser.parse_args()
    end = timestamp(args.as_of) if args.as_of else dt.datetime.now(UTC)
    if end is None:
        raise ValueError('Timezone-aware --as-of required')
    start = end - dt.timedelta(days=7)
    sources = {}

    def rows(name):
        p = ROOT / 'smc_engine/telemetry' / name
        content = p.read_bytes()  # one byte snapshot per live file; subsequent appends are excluded
        good, bad, first, last = 0, 0, None, None
        for line in content.decode('utf-8-sig').splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                bad += 1
                continue
            good += 1
            t = timestamp(row.get('timestamp'))
            if t:
                first = min(first, t) if first else t
                last = max(last, t) if last else t
            yield row, t
        sources[name] = {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content), 'rows': good,
                         'malformed_lines': bad, 'first': first.isoformat() if first else None,
                         'last': last.isoformat() if last else None,
                         'full_week_retained': bool(first and first <= start)}

    queue_bytes = (ROOT / 'smc_engine/data/signal_delivery_queue.json').read_bytes()
    queue = json.loads(queue_bytes.decode('utf-8-sig'))
    monthly = {}
    for row in queue:
        t = timestamp(row.get('telegramSentAt'))
        if not t or t > end:
            continue
        month = t.astimezone(dt.timezone(dt.timedelta(hours=3))).strftime('%Y-%m')
        monthly.setdefault(month, [])
        monthly[month].append(row)
    deliveries = {'window': delivery_counts(queue, start, end),
                  'monthly': {k: delivery_counts(v, dt.datetime.min.replace(tzinfo=UTC), end) for k, v in sorted(monthly.items())},
                  'weekly_items': [{k: r.get(k) for k in ['signalId', 'symbol', 'state', 'telegramSentAt', 'failureReason']}
                                   for r in queue if timestamp(r.get('telegramSentAt')) and start <= timestamp(r['telegramSentAt']) <= end],
                  'queue_snapshot_sha256': hashlib.sha256(queue_bytes).hexdigest()}
    completed_events, image_failed_events = set(), set()
    for r, t in rows('delivery-queue.jsonl'):
        if t and start <= t <= end and real_id(r.get('signalId')):
            if r.get('event') == 'SENT':
                completed_events.add(r['signalId'])
            elif r.get('event') == 'SCREENSHOT_FAILED':
                image_failed_events.add(r['signalId'])
    deliveries['weekly_event_log_complete'] = len(completed_events)
    deliveries['weekly_event_log_image_failure'] = len(image_failed_events - completed_events)
    deliveries['weekly_status_conflicts'] = [r['signalId'] for r in deliveries['weekly_items']
        if r['state'] == 'SENT' and r['signalId'] in image_failed_events - completed_events]
    provider = collections.Counter()
    failed_pairs = collections.Counter()
    for r, t in rows('provider.jsonl'):
        if not t or not start <= t <= end:
            continue
        provider['attempts'] += 1
        provider['success' if r.get('success') else 'failed'] += 1
        if not r.get('success'):
            message = str(r.get('errorMessage', '')).lower()
            category = 'daily_credit_limit' if 'for the day' in message else 'minute_credit_limit' if 'current minute' in message else str(r.get('errorType'))
            provider[category] += 1
            failed_pairs[f"{r.get('symbol')}:{r.get('timeframe')}"] += 1
    enqueued, started = {}, {}
    queue_waits, service = [], []
    queue_events = collections.Counter()
    max_queue = 0
    for r, t in rows('provider-queue.jsonl'):
        if not t or not start <= t <= end:
            continue
        key = (r.get('jobId'), r.get('symbol'), r.get('timeframe'))
        event = r.get('event')
        queue_events[event] += 1
        max_queue = max(max_queue, r.get('queueLength', 0))
        if event == 'ENQUEUED':
            enqueued[key] = t
        elif event == 'STARTED':
            started[key] = t
            if key in enqueued:
                queue_waits.append((t - enqueued.pop(key)).total_seconds())
        elif event in {'COMPLETED', 'FAILED'}:
            if key in started:
                service.append((t - started.pop(key)).total_seconds())
    provider_result = {'counts': dict(provider), 'most_failed_symbol_timeframes': failed_pairs.most_common(10),
                       'queue_events': dict(queue_events), 'max_queue_length': max_queue,
                       'queue_wait_seconds': distribution(queue_waits), 'active_job_seconds': distribution(service),
                       'waiting_over_15m': sum(v > 900 for v in queue_waits)}
    scans, rejects, singles = 0, collections.Counter(), collections.Counter()
    daily, by_symbol = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)
    for r, t in rows('pipeline-filter.jsonl'):
        if not t or not start <= t <= end:
            continue
        scans += 1
        rejects.update(r.get('rejectionCounts', {}))
        singles.update(r.get('singleRuleAblationCandidates', {}))
        daily[t.date().isoformat()]['scans'] += 1
        daily[t.date().isoformat()]['candidate_emissions'] += r.get('candidatesCreated', 0)
        by_symbol[r.get('symbol')]['scans'] += 1
        by_symbol[r.get('symbol')]['candidate_emissions'] += r.get('candidatesCreated', 0)
    # Lifecycle logs report the FIRST blocking stage. A single entry in this list does not mean
    # every later gate passed. Do not relabel it a single-filter counterfactual.
    poi_by_reason = collections.defaultdict(set)
    invalid_by_reason = collections.defaultdict(set)
    observations, first_distance, later_candidates = 0, {}, {}
    for r, t in rows('poi-lifecycle.jsonl'):
        if not t or not start <= t <= end:
            continue
        observations += 1
        ident = r.get('poiId')
        for reason in r.get('whyNotCandidateYet', []):
            poi_by_reason[reason].add(ident)
            if r.get('isInvalidated') or r.get('poiInvalidatedAt') is not None:
                invalid_by_reason[reason].add(ident)
        if 'distance_exceeds_threshold' in r.get('whyNotCandidateYet', []):
            first_distance[ident] = min(first_distance.get(ident, t), t)
        if r.get('candidateEligible'):
            later_candidates[ident] = max(later_candidates.get(ident, t), t)
    reason_counts = {k: {'unique_pois': len(v), 'also_invalidation_observed': len(v & invalid_by_reason[k])}
                     for k, v in sorted(poi_by_reason.items(), key=lambda kv: -len(kv[1]))}
    lifecycle = {'retained_observations': observations, 'first_block_reason_unique_pois': reason_counts,
                 'distance_rejections_later_candidate_observed': sum(k in later_candidates and later_candidates[k] > t for k, t in first_distance.items()),
                 'single_filter_quality_effect_identifiable': False}
    poll = collections.Counter()
    durations = []
    for r, t in rows('polling.jsonl'):
        if not t or not start <= t <= end:
            continue
        poll['rows'] += 1
        poll['success' if r.get('success') else 'failed'] += 1
        if r.get('timeframe') == '15m':
            durations.append(r.get('durationMs', 0) / 1000)
    # Only approved environment keys are read; credentials are never emitted.
    settings = {}
    allow = {'CANDLE_DATA_DIR', 'ENABLE_KILLZONE', 'ENABLE_PVP_SIGNAL_ACCELERATION', 'ENABLE_PVP_KILLZONE_BYPASS'}
    env = ROOT / 'smc_engine/.env'
    if env.exists():
        for line in env.read_text(encoding='utf-8-sig').splitlines():
            if '=' in line:
                k, v = line.split('=', 1)
                if k.strip() in allow:
                    settings[k.strip()] = v.strip().strip('"').strip("'")
    candle_dir = Path(settings.get('CANDLE_DATA_DIR', str(ROOT / 'smc_engine/data')))
    coverage = []
    for symbol in ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD']:
        for tf in ['15m', '1h', '4h']:
            p = candle_dir / f'{symbol}_{tf}.json'
            if not p.exists():
                continue
            bars = json.loads(p.read_text(encoding='utf-8-sig'))
            coverage.append({'symbol': symbol, 'timeframe': tf, 'count': len(bars),
                             'first': timestamp(bars[0]['timestamp']).isoformat() if bars else None,
                             'last': timestamp(bars[-1]['timestamp']).isoformat() if bars else None,
                             'covers_week_start': bool(bars and timestamp(bars[0]['timestamp']) <= start)})
    result = {'captured_at_utc': end.isoformat(), 'window_start_utc': start.isoformat(),
              'deliveries': deliveries, 'provider': provider_result,
              'pipeline': {'scans': scans, 'daily': daily, 'per_symbol': by_symbol, 'rejection_events': rejects,
                           'grade_stage_single_rule_opportunities_including_repeats': singles},
              'lifecycle': lifecycle, 'polling': {'counts': poll, '15m_duration_seconds': distribution(durations)},
              'disk_settings_not_attested_runtime_env': settings, 'configured_candle_cache_coverage': coverage,
              'sources': sources,
              'limits': ['Rolling logs have different retention windows; all row counts are retained samples.',
                         'Repeated scans and first-failure lists do not measure unique lost qualified signals.',
                         'Shadow midpoint fills, fixed 2R and retrospective confirmation are not manual hybrid trades.',
                         'Archived-candidate geometry sensitivity is not a full replay or realized PnL.',
                         'Current source rules cannot explain a historical runtime before their deployment.']}
    result['code_fingerprints'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [
        ROOT / 'smc_engine/server/pipeline.ts', ROOT / 'smc_engine/server/providerQueue.ts',
        ROOT / 'smc_engine/server/index.ts', ROOT / 'smc_engine/server/shadowCohortTracker.ts',
        ROOT / 'smc_engine/src/tradeExpectancyEngine.ts']}
    (OUT / 'audit_results.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'window': [start.isoformat(), end.isoformat()], 'delivery': deliveries['window'],
                      'provider': provider_result, 'lifecycle': lifecycle, 'polling': result['polling']}, ensure_ascii=True))


if __name__ == '__main__':
    main()
