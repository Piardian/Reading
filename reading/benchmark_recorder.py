"""Retrospective Benchmark & Macro Gate Recorder for READİNG.

Archives:
1. Every distinct Macro Gate (`macro_bias_gate.json`) and Economic Calendar (`economic_events.json`)
   payload with SHA-256 fingerprint and UTC timestamp in `runtime/benchmark/macro_gate_history.jsonl`.
2. Every setup lifecycle across all 26 symbols (Gold, 21 Forex, 4 Crypto) — including shadow trades,
   first-touch control baselines, averted losses (stop breached pre-entry), pattern rejections, and
   exact macro gate snapshots at registration time — in `runtime/benchmark/benchmark_records.json`
   and `runtime/benchmark/macro_records.json`.
"""
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


def _atomic_write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        return
    for attempt in range(15):
        try:
            os.replace(tmp, path)
            return
        except (PermissionError, OSError):
            time.sleep(0.02 * (attempt + 1))
    try:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        tmp.unlink(missing_ok=True)
    except Exception:
        pass


def _iso_utc(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


class BenchmarkRecorder:
    def __init__(self, runtime_dir: Path, root_dir: Path, interval_ms: int = 15000):
        self.runtime = Path(runtime_dir)
        self.root = Path(root_dir)
        self.bench_dir = self.runtime / 'benchmark'
        self.bench_dir.mkdir(parents=True, exist_ok=True)
        self.interval_ms = interval_ms
        self.last_sync_ms = 0
        self.last_macro_hash = None
        self.last_macro_heartbeat_ms = 0
        self.last_events_hash = None

        self.macro_history_path = self.bench_dir / 'macro_gate_history.jsonl'
        self.events_history_path = self.bench_dir / 'economic_events_history.jsonl'
        self.records_path = self.bench_dir / 'benchmark_records.json'
        self.macro_records_path = self.bench_dir / 'macro_records.json'

        self.records_by_id = {}
        if self.records_path.exists():
            try:
                loaded = json.loads(self.records_path.read_text(encoding='utf-8'))
                if isinstance(loaded, list):
                    for r in loaded:
                        rid = r.get('record_id')
                        if rid:
                            self.records_by_id[rid] = r
            except Exception:
                pass

    def archive_macro_gate(self, now_ms: int) -> dict:
        """Archive `shared/macro_bias_gate.json` and `shared/economic_events.json` whenever changed."""
        macro_file = self.root / 'shared' / 'macro_bias_gate.json'
        events_file = self.root / 'shared' / 'economic_events.json'
        latest_macro = {}

        if macro_file.exists():
            try:
                raw_bytes = macro_file.read_bytes()
                text = raw_bytes.decode('utf-8-sig')
                parsed = json.loads(text)
                canonical = json.dumps(parsed, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
                digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
                latest_macro = {'sha256': digest, 'payload': parsed}
                # Write whenever hash changes OR every 15 minutes as a liveness checkpoint
                if digest != self.last_macro_hash or (now_ms - self.last_macro_heartbeat_ms >= 900_000):
                    row = {
                        'schema': 1,
                        'kind': 'MACRO_GATE_SNAPSHOT',
                        'observed_utc_ms': now_ms,
                        'observed_iso_utc': _iso_utc(now_ms),
                        'sha256': digest,
                        'changed': digest != self.last_macro_hash,
                        'payload': parsed,
                    }
                    with self.macro_history_path.open('a', encoding='utf-8') as f:
                        f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
                    self.last_macro_hash = digest
                    self.last_macro_heartbeat_ms = now_ms
            except Exception:
                pass

        if events_file.exists():
            try:
                raw_bytes = events_file.read_bytes()
                text = raw_bytes.decode('utf-8-sig')
                parsed = json.loads(text)
                canonical = json.dumps(parsed, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
                digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
                if digest != self.last_events_hash:
                    row = {
                        'schema': 1,
                        'kind': 'ECONOMIC_EVENTS_SNAPSHOT',
                        'observed_utc_ms': now_ms,
                        'observed_iso_utc': _iso_utc(now_ms),
                        'sha256': digest,
                        'payload': parsed,
                    }
                    with self.events_history_path.open('a', encoding='utf-8') as f:
                        f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
                    self.last_events_hash = digest
            except Exception:
                pass

        return latest_macro

    def sync(self, now_ms: int, trackers_by_symbol: dict, control_trackers_by_symbol: dict, shadow_ledger, arm: str = 'A') -> None:
        if now_ms - self.last_sync_ms < self.interval_ms:
            return
        self.last_sync_ms = now_ms

        latest_macro = self.archive_macro_gate(now_ms)
        macro_payload = latest_macro.get('payload') or {}
        macro_sha = latest_macro.get('sha256')

        # Index shadow ledger trades by (symbol, setup_id)
        ledger_trades = {}
        try:
            for row in shadow_ledger.read_all():
                t = json.loads(row['data'])
                key = f"{t.get('symbol')}|{t.get('setup_id')}"
                ledger_trades[key] = t
        except Exception:
            pass

        changed = False
        for symbol, tracker in trackers_by_symbol.items():
            ctrl_tracker = control_trackers_by_symbol.get(symbol)
            ctrl_setups = (ctrl_tracker.state.get('setups') or {}) if ctrl_tracker else {}

            for setup_id, s in (tracker.state.get('setups') or {}).items():
                rec_id = f"{arm}|{symbol}|{setup_id}"
                cand = s.get('original_candidate') or {}
                grade_res = cand.get('gradeResult') or {}
                macro_eval = cand.get('macroEvaluation') or {}
                plan = s.get('plan') or {}
                ctrl_s = ctrl_setups.get(setup_id) or {}
                ledger_t = ledger_trades.get(f"{symbol}|{setup_id}")

                # Determine 5-category benchmark classification (compatible with Begonya reporter)
                outcome, category, realized_r, realized_usd, error_diagnosis = self._classify_outcome(
                    s, ctrl_s, ledger_t
                )

                existing = self.records_by_id.get(rec_id)
                macro_snap = existing.get('macro_gate_snapshot') if existing else {
                    'macro_sha256': macro_sha,
                    'macro_evaluation': macro_eval,
                    'gate_timestamp': macro_payload.get('timestamp') or macro_payload.get('generated_at'),
                    'global_regime': macro_payload.get('global_regime') or macro_payload.get('regime'),
                    'currency_scores': macro_payload.get('currency_scores') or macro_payload.get('scores') or {},
                }

                record = {
                    'record_id': rec_id,
                    'arm': arm,
                    'symbol': symbol,
                    'setup_id': setup_id,
                    'trade_direction': s.get('direction'),
                    'registered_utc_ms': s.get('registered_utc_ms'),
                    'registered_iso_utc': _iso_utc(s['registered_utc_ms']) if s.get('registered_utc_ms') else None,
                    'updated_utc_ms': s.get('updated_utc_ms') or now_ms,
                    'smc_technical_layer': {
                        'poi_type': cand.get('poiType'),
                        'entry_zone': [s.get('low'), s.get('high')],
                        'stop_loss': s.get('stop'),
                        'target_tp2': s.get('target'),
                        'grade': grade_res.get('grade'),
                        'score': grade_res.get('totalScore'),
                        'target_constraint': plan.get('targetConstraint'),
                        'planned_rr': plan.get('primaryRR'),
                        'bias_4h': cand.get('bias4H'),
                        'bias_1h': cand.get('bias1H'),
                    },
                    'macro_gate_snapshot': macro_snap,
                    'reading_microstructure_layer': {
                        'tracker_state': s.get('state'),
                        'tracker_reason': s.get('reason'),
                        'touch_utc_ms': s.get('touch_utc_ms'),
                        'touch_spread': s.get('touch_spread'),
                        'response_quotes': s.get('response_quotes'),
                        'stall_observed': bool(s.get('stall_observed')),
                        'pattern_assessment': s.get('pattern_assessment'),
                        'management': s.get('management'),
                        'first_touch_reference': (s.get('reference_observations') or {}).get('first_touch'),
                        'reading_proposal_reference': (s.get('reference_observations') or {}).get('reading_proposal'),
                        'control_tracker_state': ctrl_s.get('state'),
                        'control_tracker_reason': ctrl_s.get('reason'),
                    },
                    'shadow_ledger_trade': ledger_t,
                    'post_trade_audit': {
                        'actual_outcome': outcome,
                        'outcome_category': category,
                        'realized_r': realized_r,
                        'realized_usd': realized_usd,
                        'error_diagnosis': error_diagnosis,
                    },
                }

                if existing != record:
                    self.records_by_id[rec_id] = record
                    changed = True

        if changed or not self.records_path.exists():
            all_records = sorted(
                self.records_by_id.values(),
                key=lambda r: (r.get('registered_utc_ms') or 0, r.get('record_id') or '')
            )
            _atomic_write_json(self.records_path, all_records)
            macro_records = self._build_macro_records(all_records)
            _atomic_write_json(self.macro_records_path, macro_records)

    def sync_multi_arms(self, now_ms: int, arms_trackers: dict, control_trackers_by_symbol: dict, shadow_ledger) -> None:
        """Sync setups across all 4 experimental arms (A, B, C, D) into unified benchmark storage."""
        if now_ms - self.last_sync_ms < self.interval_ms:
            return
        self.last_sync_ms = now_ms

        latest_macro = self.archive_macro_gate(now_ms)
        macro_payload = latest_macro.get('payload') or {}
        macro_sha = latest_macro.get('sha256')

        ledger_trades = {}
        ledgers=shadow_ledger if isinstance(shadow_ledger,dict) else {'A':shadow_ledger}
        for ledger_arm,ledger in ledgers.items():
            for row in ledger.read_all():
                t=json.loads(row['data'])
                ledger_trades[(ledger_arm,t.get('symbol'),t.get('setup_id'))]=t

        changed = False
        for arm_id, trackers_by_symbol in arms_trackers.items():
            for symbol, tracker in trackers_by_symbol.items():
                ctrl_tracker = control_trackers_by_symbol.get(symbol)
                ctrl_setups = (ctrl_tracker.state.get('setups') or {}) if ctrl_tracker else {}

                for setup_id, s in (tracker.state.get('setups') or {}).items():
                    rec_id = f"{arm_id}|{symbol}|{setup_id}"
                    cand = s.get('original_candidate') or {}
                    grade_res = cand.get('gradeResult') or {}
                    macro_eval = cand.get('macroEvaluation') or {}
                    plan = s.get('plan') or {}
                    ctrl_s = ctrl_setups.get(setup_id) or {}
                    ledger_t = ledger_trades.get((arm_id,symbol,setup_id))

                    outcome, category, realized_r, realized_usd, error_diagnosis = self._classify_outcome(
                        s, ctrl_s, ledger_t
                    )

                    existing = self.records_by_id.get(rec_id)
                    macro_snap = existing.get('macro_gate_snapshot') if existing else {
                        'macro_sha256': macro_sha,
                        'macro_evaluation': macro_eval,
                        'gate_timestamp': macro_payload.get('timestamp') or macro_payload.get('generated_at'),
                        'global_regime': macro_payload.get('global_regime') or macro_payload.get('regime'),
                        'currency_scores': macro_payload.get('currency_scores') or macro_payload.get('scores') or {},
                    }

                    record = {
                        'record_id': rec_id,
                        'arm': arm_id,
                        'symbol': symbol,
                        'setup_id': setup_id,
                        'trade_direction': s.get('direction'),
                        'registered_utc_ms': s.get('registered_utc_ms'),
                        'registered_iso_utc': _iso_utc(s['registered_utc_ms']) if s.get('registered_utc_ms') else None,
                        'updated_utc_ms': s.get('updated_utc_ms') or now_ms,
                        'smc_technical_layer': {
                            'poi_type': cand.get('poiType'),
                            'entry_zone': [s.get('low'), s.get('high')],
                            'stop_loss': s.get('stop'),
                            'target_tp2': s.get('target'),
                            'grade': grade_res.get('grade'),
                            'score': grade_res.get('totalScore'),
                            'target_constraint': plan.get('targetConstraint'),
                            'planned_rr': plan.get('primaryRR'),
                            'bias_4h': cand.get('bias4H'),
                            'bias_1h': cand.get('bias1H'),
                        },
                        'macro_gate_snapshot': macro_snap,
                        'reading_microstructure_layer': {
                            'arm': arm_id,
                            'tracker_state': s.get('state'),
                            'tracker_reason': s.get('reason'),
                            'touch_utc_ms': s.get('touch_utc_ms'),
                            'touch_spread': s.get('touch_spread'),
                            'response_quotes': s.get('response_quotes'),
                            'stall_observed': bool(s.get('stall_observed')),
                            'pattern_assessment': s.get('pattern_assessment'),
                            'management': s.get('management'),
                            'first_touch_reference': (s.get('reference_observations') or {}).get('first_touch'),
                            'reading_proposal_reference': (s.get('reference_observations') or {}).get('reading_proposal'),
                            'control_tracker_state': ctrl_s.get('state'),
                            'control_tracker_reason': ctrl_s.get('reason'),
                        },
                        'shadow_ledger_trade': ledger_t,
                        'post_trade_audit': {
                            'actual_outcome': outcome,
                            'outcome_category': category,
                            'realized_r': realized_r,
                            'realized_usd': realized_usd,
                            'pnl_basis':'OBSERVED_BBO_MODEL_GROSS_NOT_NET',
                            'net_r':None,'net_usd':None,'commission':None,'slippage':None,
                            'error_diagnosis': error_diagnosis,
                        },
                    }

                    if existing != record:
                        self.records_by_id[rec_id] = record
                        changed = True

        if changed or not self.records_path.exists():
            all_records = sorted(
                self.records_by_id.values(),
                key=lambda r: (r.get('registered_utc_ms') or 0, r.get('record_id') or '')
            )
            _atomic_write_json(self.records_path, all_records)
            macro_records = self._build_macro_records(all_records)
            _atomic_write_json(self.macro_records_path, macro_records)

    @staticmethod
    def _classify_outcome(s: dict, ctrl_s: dict, ledger_t: dict | None):
        state = s.get('state')
        reason = s.get('reason') or ''

        if ledger_t:
            l_state = ledger_t.get('state')
            l_outcome = ledger_t.get('outcome')
            gross_r = ledger_t.get('gross_r')
            usd = ledger_t.get('model_gross_usd')
            if l_state == 'OPEN':
                if ledger_t.get('tp1_done'):
                    part_r = ledger_t.get('realized_r', 0.5)
                    return 'ACTIVE_RUNNER_1ST_TP_HIT', 'PROFIT_AND_RUNNER_ACTIVE', part_r, part_r * 100.0, 'NONE_OPEN_RUNNER'
                return 'ACTIVE_IN_POSITION', 'IN_PROGRESS', 0.0, 0.0, 'NONE_OPEN_TRADE'
            if l_state == 'CLOSED':
                if l_outcome == 'TP':
                    return 'WIN', 'PROFIT', gross_r, usd, 'NONE_FULL_TP2_WIN'
                if l_outcome == 'BE':
                    return 'WIN_PARTIAL_TP_AND_BE', 'PROFIT', gross_r, usd, 'REVERSED_AFTER_TP1_SAVED_BY_BE'
                if l_outcome == 'SL':
                    return 'LOSS', 'LOSS', gross_r, usd, 'POST_ABSORPTION_STOP_OUT'
            return 'UNRESOLVED', 'IN_PROGRESS', gross_r, usd, f'LEDGER_{l_state}_{l_outcome}'

        if state == 'INVALIDATED' and reason == 'ORIGINAL_STOP_BREACHED':
            if s.get('touch_utc_ms'):
                return 'INVALID_NO_ENTRY', 'NO_ENTRY', None, None, 'STOP_BREACHED_WITHOUT_ENTRY_NOT_MEASURED_SAVINGS'
            return 'INVALID_NO_ENTRY', 'NO_ENTRY', None, None, 'PRE_TOUCH_STOP_BREACHED'

        if state == 'EXPIRED':
            if s.get('touch_utc_ms'):
                pat_state = (s.get('pattern_assessment') or {}).get('state') or reason
                return 'EXPIRED_AFTER_TOUCH', 'NO_ENTRY', None, None, f'TOUCHED_BUT_BLOCKED_BY_{pat_state}'
            return 'PENDING_RETEST_EXPIRED', 'NO_ENTRY', None, None, 'NEVER_TOUCHED_WITHIN_TTL'

        if state == 'REJECTED':
            return 'REJECTED_GATE', 'NO_ENTRY', None, None, f'REJECTED_BY_{reason}'

        if state == 'CANCELLED':
            return 'CANCELLED_BY_SMC_OR_MACRO', 'NO_ENTRY', None, None, f'CANCELLED_BY_{reason}'

        return 'PENDING_RETEST', 'PENDING', None, None, f'WAITING_IN_STATE_{state}'

    @staticmethod
    def _build_macro_records(all_records: list) -> list:
        macro_list = []
        for r in all_records:
            msnap = r.get('macro_gate_snapshot') or {}
            meval = msnap.get('macro_evaluation') or {}
            audit = r.get('post_trade_audit') or {}
            outcome = audit.get('actual_outcome', '')
            allowed = meval.get('allowed') is True and meval.get('macroGateMultiplier') == 1
            alignment = 'ALIGNED' if allowed else 'CONTRARY_OR_BLOCKED'
            accurate = None
            if outcome in {'WIN','WIN_PARTIAL_TP_AND_BE','LOSS'}:
                accurate=(allowed and outcome!='LOSS') or (not allowed and outcome=='LOSS')
            macro_list.append({
                'record_id': r.get('record_id'),
                'symbol': r.get('symbol'),
                'trade_direction': r.get('trade_direction'),
                'registered_iso_utc': r.get('registered_iso_utc'),
                'macro_sha256': msnap.get('macro_sha256'),
                'currency_scores': msnap.get('currency_scores') or {},
                'cross_pair_verdict': {
                    'gate_alignment': alignment,
                    'macro_bias': meval.get('macroBias'),
                    'gate_message': meval.get('gateStatusMessage'),
                },
                'post_trade_macro_attribution': {
                    'trade_actual_outcome': outcome,
                    'macro_directional_accuracy': accurate,
                    'decoupling_detected': bool(allowed and outcome == 'LOSS'),
                },
            })
        return macro_list
