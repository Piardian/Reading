"""READING sidecar: isolated tape features + cloned BEGONYA candidate observer."""
import argparse
import gzip
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from collections import deque
from tape_engine import TapeEngine, LogTail
from entry_tracker import EntryTracker, DEFAULTS,TERMINAL
from ninja_feed import NinjaFeed
from quantower_feed import QuantowerFeed
from reading_patterns import PROTOCOL as PATTERN_PROTOCOL
from crypto_process import CryptoProcess
from crypto_feed import CryptoFeed
from crypto_feed import WALL_MIN_UNITS
from reading_telegram import ReadingTelegram
from shadow_arms import ShadowArms
from storage_maintenance import StorageMaintenance
from benchmark_recorder import BenchmarkRecorder

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
RUNTIME=HERE/'runtime'


def auto_archive_runtime_jsonl(runtime_dir):
    """Automatically and safely moves closed historical daily jsonl and gz files to historical_archive.
    Zero data loss: all historical records are preserved in reading/historical_archive.
    """
    try:
        archive_dir = runtime_dir.parent / 'historical_archive'
        archive_dir.mkdir(exist_ok=True)
        today = time.strftime('%Y-%m-%d', time.gmtime())
        date_pattern = re.compile(r'(\d{4}-\d{2}-\d{2})')
        moved_count = 0
        for ext in ('*.jsonl', '*.gz'):
            for p in list(runtime_dir.rglob(ext)):
                match = date_pattern.search(p.name)
                if match:
                    file_date = match.group(1)
                    if file_date != today:
                        rel = p.relative_to(runtime_dir)
                        dest = archive_dir / rel
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        try:
                            if p.suffix == '.jsonl':
                                gz_dest = dest.with_suffix('.jsonl.gz')
                                with open(p, 'rb') as f_in, gzip.open(gz_dest, 'wb', compresslevel=3) as f_out:
                                    shutil.copyfileobj(f_in, f_out, length=1024*1024)
                                p.unlink()
                            else:
                                shutil.move(str(p), str(dest))
                            moved_count += 1
                        except Exception:
                            pass
        return moved_count
    except Exception:
        return 0


def write_json(path,data):
    tmp=path.with_suffix('.tmp')
    try:
        tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    except Exception:
        return
    for attempt in range(15):
        try:
            os.replace(tmp,path)
            return
        except (PermissionError,OSError):
            time.sleep(.02*(attempt+1))
    try:
        path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
        tmp.unlink(missing_ok=True)
    except Exception:
        pass


def read_json(path):
    for attempt in range(5):
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (PermissionError, OSError):
            time.sleep(0.02 * (attempt + 1))
        except (json.JSONDecodeError, ValueError):
            time.sleep(0.05 * (attempt + 1))
    return json.loads(path.read_text(encoding='utf-8'))


def run(seconds=0):
    RUNTIME.mkdir(exist_ok=True)
    lock=(RUNTIME/'instance.lock').open('a+b');lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:
        print('INSTANCE_ALREADY_RUNNING');lock.close();return 2
    if not os.fstat(lock.fileno()).st_size:
        lock.write(b'0');lock.flush()
    (RUNTIME/'STOP').unlink(missing_ok=True)
    config=read_json(HERE/'config.json')
    management=config.get('trade_management')
    t_cfg=config.get('tracker_config',{})
    tape=TapeEngine(config['window_ms'],config['min_aggregate_trades'],config['imbalance_threshold'])
    tail=LogTail(config['recorder_data'],initial_max_bytes=8*1024*1024)
    ARMS = {
        'A': {'response_timeout_ms': 600000, 'apply_macro_gate': True, 'desc': 'Ana Bot (Makro Aktif + 600s / 10dk)'},
        'B': {'response_timeout_ms': 300000, 'apply_macro_gate': True, 'desc': 'Orta Süre (Makro Aktif + 300s / 5dk)'},
        'C': {'response_timeout_ms': 300000, 'apply_macro_gate': False, 'desc': 'Makro Kapalı (300s / 5dk)'},
        'D': {'response_timeout_ms': 600000, 'apply_macro_gate': False, 'desc': 'Kombine Serbest (Makro Kapalı + 600s / 10dk)'},
    }
    forex_symbols=config.get('forex_symbols',[])
    crypto_symbols=config.get('crypto_symbols',{})

    arms_gold = {}
    arms_forex = {}
    arms_crypto = {}
    for arm_id, arm_params in ARMS.items():
        arm_dir = RUNTIME / 'arms' / arm_id
        arm_t_cfg = {**t_cfg, **arm_params}
        arms_gold[arm_id] = EntryTracker(arm_dir / 'gold_patterns', config={'require_patterns': True, 'management': management, **arm_t_cfg})
        arms_forex[arm_id] = {s: EntryTracker(arm_dir / 'forex_patterns' / s, config={'require_patterns': True, 'management': management, **arm_t_cfg}, symbol=s) for s in forex_symbols}
        arms_crypto[arm_id] = {s: EntryTracker(arm_dir / 'crypto_patterns' / s, config={'require_patterns': True, 'management': management, **arm_t_cfg}, symbol=s) for s in crypto_symbols}

    tracker=EntryTracker(RUNTIME,config=t_cfg)
    gold_pattern_tracker = arms_gold['A']
    pattern_trackers = arms_forex['A']
    crypto_trackers = arms_crypto['A']

    forex_trackers={s:EntryTracker(RUNTIME/'forex'/s,config=t_cfg,symbol=s) for s in forex_symbols}
    crypto_controls={s:EntryTracker(RUNTIME/'crypto_control'/s,config=t_cfg,symbol=s) for s in crypto_symbols}
    crypto_live=CryptoProcess(crypto_symbols,RUNTIME) if crypto_symbols else None
    crypto_tape=CryptoFeed(crypto_symbols)
    notifier=ReadingTelegram(RUNTIME,Path(config['begonya_source'])/'smc_engine/.env',config.get('telegram_enabled',False))
    shadow_arms=ShadowArms(RUNTIME,notifier,management=management)
    shadow_ledger=shadow_arms.ledgers['A']
    benchmark_recorder=BenchmarkRecorder(RUNTIME,ROOT)
    selected_feed=config.get('futures_feed','ninjatrader')
    storage=StorageMaintenance(config['quantower_feed_directory'])
    if selected_feed not in {'ninjatrader','quantower'}:raise ValueError('Unsupported futures feed')
    ninja=QuantowerFeed() if selected_feed=='quantower' else NinjaFeed()
    ninja_tail=LogTail(config[selected_feed+'_feed_directory'],initial_max_bytes=16*1024*1024)
    forex_quote_tail=LogTail(RUNTIME/'mt5_quotes',initial_max_bytes=4*1024*1024)
    last_feed_bootstrap_skip=0
    health_history=deque(maxlen=80)
    crypto_health_history=deque(maxlen=160)
    last_save=0
    started=time.time();child=None;child_log=None;candle_child=None;candle_log=None;last_evidence=0;errors=[]
    status={'state':'STARTING','pid':os.getpid(),'started_utc_ms':int(started*1000),
            'trade_management':management,
            'order_routing':False,'telegram_enabled':config.get('telegram_enabled',False),'provider_calls_enabled':False,
            'mode':'READ_ONLY_SHADOW','source_project':'BEGONYA','source_recorder':config['recorder_data']}
    try:
        notifier.start()
        storage.start()
        if crypto_live:crypto_live.start()
        # Recorder is shared with the earlier experiment; READİNG never stops it.
        manager=Path(config['recorder_manager'])
        if manager.exists():
            r=subprocess.run([sys.executable,str(manager),'start'],capture_output=True,text=True,timeout=20,
                             creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode:errors.append('RECORDER_MANAGER_START_FAILED')
        node=shutil.which('node')
        if not node:raise RuntimeError('Node.js unavailable')
        child_log=(RUNTIME/'smc_worker.log').open('ab')
        env=os.environ.copy()
        env['READING_BEGONYA_SOURCE']=config['begonya_source']
        child=subprocess.Popen([node,str(HERE/'smc_shadow.js')],cwd=RUNTIME,env=env,
                               stdout=child_log,stderr=child_log,creationflags=subprocess.CREATE_NO_WINDOW)
        status['smc_pid']=child.pid
        candle_log=(RUNTIME/'mt5_candles.log').open('ab')
        candle_child=subprocess.Popen([sys.executable,str(HERE/'mt5_candles.py')],cwd=HERE,
            stdout=candle_log,stderr=candle_log,creationflags=subprocess.CREATE_NO_WINDOW)
        status['mt5_candles_pid']=candle_child.pid
        manifest={'created_utc_ms':int(time.time()*1000),'config':config,
                  'code_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.glob('*') if p.is_file()},
                  'quantower_bridge_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (HERE/'quantower').glob('*') if p.suffix in {'.cs','.dll','.json'}},
                  'stage':'SHADOW_ENTRY_TRACKING_NO_EXECUTION','strategy_pnl':None,'edge_proven':False,
                  'automatic_patterns_protocol':PATTERN_PROTOCOL,
                  'automatic_entry_settings':{**DEFAULTS,'require_patterns':True},
                  'crypto_data_protocol':{'market':'BINANCE_SPOT','aliases':crypto_symbols,
                    'closed_candle_intervals':['1m','15m','1h','4h'],'book':'TOP_20_AGGREGATED_PRICE_LEVELS_NOT_MBO',
                    'pattern_cache_max_ms':500,'liquidity_pull_settle_ms':500,'wall_min_base_units':WALL_MIN_UNITS,
                    'macro_policy':'EXISTING_BEGONYA_GATE_UNCHANGED_NO_NEUTRAL_SUBSTITUTION'},
                  'automatic_patterns_mode':'RESEARCH_ONLY_WITH_SEPARATE_UNCHANGED_CONTROL',
                  'entry_protocol':{'settings':DEFAULTS,'control_reference':'FIRST_TOUCH_EXECUTABLE_QUOTE_NOT_ORIGINAL_BEGONYA_FILL',
                    'proposal_rule':'Three post-touch quotes; reversal >= max(10% zone width, 2 spreads); aligned usable proxy flow; original entryRange if present; original stop and targets retained',
                    'outcome_scope':'60s/300s quote marks; no simulated fills, slippage or commissions; net PnL unavailable'}}
        write_json(RUNTIME/'run_manifest.json',manifest)
        last_archive_check = 0
        while not (RUNTIME/'STOP').exists():
            loop_started=time.monotonic()
            if seconds and time.time()-started>=seconds:break
            if shutil.disk_usage(RUNTIME).free<2*1024**3:
                auto_archive_runtime_jsonl(RUNTIME)
                if shutil.disk_usage(RUNTIME).free<1*1024**3:
                    loop_errors.append('LOW_DISK_WARNING_UNDER_1GB')
                    time.sleep(2.0)
                    continue
            now=int(time.time()*1000)
            if now - last_archive_check > 300_000:
                last_archive_check = now
                auto_archive_runtime_jsonl(RUNTIME)
            if sum(p.stat().st_size for p in RUNTIME.rglob('*.jsonl'))>3*1024**3:
                auto_archive_runtime_jsonl(RUNTIME)
            if sum(p.stat().st_size for p in RUNTIME.rglob('*.jsonl'))>10*1024**3:
                loop_errors.append('EVIDENCE_STORAGE_LIMIT_WARNING')
                time.sleep(2.0)
                continue
            loop_errors=list(errors)
            status['storage']=dict(storage.health)
            if storage.health.get('state')=='FAILED':loop_errors.append('QUANTOWER_ARCHIVE_FAILED')
            if candle_child.poll() is not None:
                loop_errors.append('MT5_CANDLE_WORKER_RESTARTING')
                try:
                    if candle_log: candle_log.close()
                    candle_log = (RUNTIME/'mt5_candles.log').open('ab')
                    candle_child = subprocess.Popen([sys.executable, str(HERE/'mt5_candles.py')], cwd=HERE,
                                                    stdout=candle_log, stderr=candle_log, creationflags=subprocess.CREATE_NO_WINDOW)
                    status['mt5_candles_pid'] = candle_child.pid
                except Exception as respawn_err:
                    loop_errors.append('MT5_CANDLE_RESPAWN_FAILED_' + str(respawn_err))
            if crypto_live and not crypto_live.is_alive():
                loop_errors.append('CRYPTO_COLLECTOR_RESTARTING')
                try:
                    crypto_live.restart()
                except Exception as respawn_err:
                    loop_errors.append('CRYPTO_COLLECTOR_RESPAWN_FAILED_' + str(respawn_err))
            try:
                events=tail.poll()
                ninja_events=ninja_tail.poll()
                spot_events=forex_quote_tail.poll()
                try:spot_health=read_json(RUNTIME/'mt5_candles_status.json')
                except (OSError,ValueError):spot_health={'connection':'WAITING_MT5_WORKER'}
                now=int(time.time()*1000)
                crypto_events=crypto_live.poll() if crypto_live else []
                now=int(time.time()*1000)
                crypto_health=crypto_live.health() if crypto_live else {}
                now=int(time.time()*1000)
                crypto_health_history.append((now,crypto_health))
                try:crypto_contexts=read_json(RUNTIME/'crypto_candidates.json').get('symbols',{})
                except (OSError,ValueError):crypto_contexts={}
                for symbol in crypto_symbols:
                    c=crypto_contexts.get(symbol,{})
                    for arm_id in ARMS:
                        arms_crypto[arm_id][symbol].sync(c,now)
                    crypto_controls[symbol].sync(c,now)
                latest_crypto_quotes={}
                for event in crypto_events:
                    spot=crypto_tape.ingest(event,now)
                    if spot:
                        symbol=event['symbol'];latest_crypto_quotes[symbol]=spot
                        # Preserve all observed quotes for exits; entry evaluation is sampled per poll.
                        shadow_arms.quote(symbol,spot,now)
                for symbol,spot in latest_crypto_quotes.items():
                    asof_health=next((h for available,h in reversed(crypto_health_history) if available<=spot['received_utc_ms']),{})
                    has_active_setup=any(s['state'] not in TERMINAL for arm_trackers in arms_crypto.values() for s in arm_trackers[symbol].state.get('setups',{}).values()) or any(s['state'] not in TERMINAL for s in crypto_controls[symbol].state.get('setups',{}).values())
                    features=crypto_tape.snapshot(symbol,spot['received_utc_ms'],asof_health) if has_active_setup else {}
                    for arm_id in ARMS:
                        arms_crypto[arm_id][symbol].tick(spot,features,now)
                    crypto_controls[symbol].tick(spot,features,now)
                    # Live Telegram notifications strictly bound to Arm A
                    shadow_arms.register({a:arms_crypto[a][symbol] for a in ARMS},now)
                crypto_state={s:{'tape':crypto_tape.snapshot(s,now,crypto_health,include_patterns=any(x['state'] not in TERMINAL for w2 in [w,crypto_controls[s]] for x in w2.state.get('setups',{}).values())),
                    'entry':w.advance(now),'control_entry':crypto_controls[s].advance(now)} for s,w in crypto_trackers.items()}
                write_json(RUNTIME/'crypto_status.json',{'updated_utc_ms':now,'symbols':crypto_state,'feed_health':crypto_health,
                    'flow':'MACRO_THEN_SMC_THEN_READING','order_routing':False})
                status['crypto']={'symbols':crypto_symbols,'connection':crypto_health.get('connection'),
                    'feed_errors':crypto_health.get('errors'),'entry_rule':'AUTOMATIC_PATTERNS_V1','order_routing':False}
                if crypto_live and (crypto_health.get('connection')!='CONNECTED' or now-crypto_health.get('updated_utc_ms',0)>10000):
                    loop_errors.append('CRYPTO_SOURCE_NOT_CONNECTED_OR_NOT_FRESH')
                if crypto_health.get('errors',{}).get('history'):loop_errors.append('CRYPTO_CANDLE_SOURCE_ERROR')
                for event in sorted(ninja_events,key=lambda e:e.get('received_utc_ms',0)):
                    ninja.ingest(event,now)
                if ninja_tail.bootstrap_skipped_bytes!=last_feed_bootstrap_skip:
                    ninja.mark_gap(now);last_feed_bootstrap_skip=ninja_tail.bootstrap_skipped_bytes
                try:forex_contexts=read_json(RUNTIME/'forex_candidates.json').get('symbols',{})
                except (OSError,ValueError):forex_contexts={}
                for symbol,watcher in forex_trackers.items():
                    context=forex_contexts.get(symbol,{})
                    watcher.sync(context,now)
                    for arm_id in ARMS:
                        arms_forex[arm_id][symbol].sync(context,now)
                fresh_spot_events=[e for e in spot_events if 0<=now-e.get('received_utc_ms',0)<=2000]
                if fresh_spot_events:
                    day=time.strftime('%Y-%m-%d',time.gmtime())
                    with (RUNTIME/f'forex_quotes_{day}.jsonl').open('a',encoding='utf-8') as f:
                        for event in fresh_spot_events:f.write(json.dumps(event,separators=(',',':'))+'\n')
                for event in fresh_spot_events:
                    symbol=event['data']['symbol'];received=event['received_utc_ms']
                    # Startup tails include archived quotes. Never recompute entry features for an old quote.
                    if not 0<=now-received<=2000:continue
                    # Futures features include only events received by the time this spot quote arrived.
                    features=ninja.snapshot(symbol,received)
                    if symbol=='XAUUSD':
                        for arm_id in ARMS:
                            arms_gold[arm_id].tick(event,features,now)
                        shadow_arms.register(arms_gold,now);shadow_arms.quote(symbol,event,now)
                        continue
                    forex_trackers[symbol].tick(event,features,now)
                    for arm_id in ARMS:
                        arms_forex[arm_id][symbol].tick(event,features,now)
                    shadow_arms.register({a:arms_forex[a][symbol] for a in ARMS},now);shadow_arms.quote(symbol,event,now)
                forex_state={s:{'tape':ninja.snapshot(s,now),'entry':pattern_trackers[s].advance(now),
                    'control_entry':w.advance(now),'entry_rule':'AUTOMATIC_PATTERNS_V1'} for s,w in forex_trackers.items()}
                write_json(RUNTIME/'forex_status.json',{'updated_utc_ms':now,'symbols':forex_state,
                    'spot_feed':spot_health,'flow':'MACRO_THEN_SMC_THEN_READING','order_routing':False})
                heartbeat_age=now-ninja.last_heartbeat if ninja.last_heartbeat is not None else None
                status['forex']={'symbols':len(forex_symbols),'feed_provider':selected_feed,
                    'bridge_state':('WAITING_'+selected_feed.upper()) if heartbeat_age is None else ('HEARTBEAT_FRESH' if 0<=heartbeat_age<=10000 else 'HEARTBEAT_STALE'),
                    'heartbeat_age_ms':heartbeat_age,'feed_faults':dict(ninja.faults),
                    'entry_rule':'AUTOMATIC_PATTERNS_V1','human_confirmation_required':False,
                    'macro_smc_gated':True,'order_routing':False}
                if heartbeat_age is None or not 0<=heartbeat_age<=10000:
                    loop_errors.append('FOREX_BRIDGE_HEARTBEAT_NOT_FRESH')
                recorder_status=read_json(Path(config['recorder_data'])/'status.json')
                now=int(time.time()*1000)
                if recorder_status.get('state')!='RUNNING' or not 0<=now-recorder_status.get('updated_utc_ms',0)<=15000:
                    loop_errors.append('PAXG_RECORDER_FAILED_OR_NOT_FRESH')
                elif not recorder_status.get('paxg_ws_connected'):
                    loop_errors.append('PAXG_SOURCE_DISCONNECTED')
                # Health observations become usable only after this process has actually read them.
                health_history.append((now,dict(recorder_status)))
                try:context=read_json(RUNTIME/'entry_candidates.json')
                except (OSError,ValueError):context={}
                tracker.sync(context,now)
                for arm_id in ARMS:
                    arms_gold[arm_id].sync(context,now)
                for event in sorted(events,key=lambda e:e.get('received_utc_ms',0)):
                    tape.ingest(event,now)
                    if event.get('kind')=='xauusd_broker_tick':
                        received=event.get('received_utc_ms',0)
                        health=next((h for available,h in reversed(health_history) if available<=received),{})
                        asof_tape=tape.snapshot(received,health)
                        tracker.tick(event,asof_tape,now)
                snapshot=tape.snapshot(now,recorder_status)
                write_json(RUNTIME/'tape_snapshot.json',snapshot)
                entry_status=tracker.advance(now)
                write_json(RUNTIME/'entry_status.json',{'updated_utc_ms':now,**entry_status})
                status['entry_tracker']=entry_status
                shadow_arms.advance(now)
                status['shadow_ledger']=shadow_ledger.summary()
                status['shadow_experiments']=shadow_arms.summary()
                # Unified 4-arm sync across Gold, Forex, and Crypto
                arms_trackers_map = {
                    arm_id: {'XAUUSD': arms_gold[arm_id], **arms_forex[arm_id], **arms_crypto[arm_id]}
                    for arm_id in ARMS
                }
                for trackers in arms_trackers_map.values():
                    for watcher in trackers.values():watcher.advance(now)
                benchmark_recorder.sync_multi_arms(now, arms_trackers_map,
                    {'XAUUSD':tracker,**forex_trackers,**crypto_controls},shadow_arms.ledgers)
                status['benchmark_recorder']={'records':len(benchmark_recorder.records_by_id),
                    'last_macro_sha256':benchmark_recorder.last_macro_hash}
                status['telegram']=notifier.status()
                if config.get('telegram_enabled') and (status['telegram']['state'] in {'CREDENTIALS_MISSING','FAILED','UNKNOWN','WORKER_FAILED'} or
                    status['telegram']['outbox'].get('FAILED',0) or status['telegram']['outbox'].get('UNKNOWN',0)):
                    loop_errors.append('READING_TELEGRAM_DELIVERY_NOT_CONFIRMED')
                status['automatic_gold_entry']=gold_pattern_tracker.advance(now)
                if now-last_save>=1000:
                    tracker.save();last_save=now
                    for arm_id in ARMS:
                        arms_gold[arm_id].save()
                        for watcher in arms_forex[arm_id].values(): watcher.save()
                        for watcher in arms_crypto[arm_id].values(): watcher.save()
                    for watcher in forex_trackers.values():watcher.save()
                    for watcher in crypto_controls.values():watcher.save()
                if now-last_evidence>=5000:
                    day=time.strftime('%Y-%m-%d',time.gmtime())
                    with (RUNTIME/f'tape_features_{day}.jsonl').open('a',encoding='utf-8') as f:
                        f.write(json.dumps(snapshot,ensure_ascii=False,separators=(',',':'))+'\n')
                    with (RUNTIME/f'forex_pattern_features_{day}.jsonl').open('a',encoding='utf-8') as f:
                        for symbol,state in forex_state.items():
                            f.write(json.dumps({'observed_utc_ms':now,'symbol':symbol,
                                'source_state':state['tape']['state'],'reading_patterns':state['tape']['reading_patterns'],
                                'entry_rule':state['entry_rule'],'order_routing':False},separators=(',',':'))+'\n')
                    with (RUNTIME/f'crypto_pattern_features_{day}.jsonl').open('a',encoding='utf-8') as f:
                        for symbol,state in crypto_state.items():
                            f.write(json.dumps({'observed_utc_ms':now,'symbol':symbol,'features':state['tape'],'order_routing':False},separators=(',',':'))+'\n')
                    last_evidence=now
                status['tape_research_pressure']=snapshot['research_pressure']
                status['paxg_aggregate_events_60s']=snapshot['aggregate_trade_events']
                status['signed_quantity_imbalance']=snapshot['signed_quantity_imbalance']
                status['xau_confirmation_valid']=False
                status['tape_reasons']=snapshot['reasons']
            except Exception as e:
                loop_errors.append(str(e));status['xau_confirmation_valid']=False
            if child.poll() is not None:
                if (RUNTIME/'STOP').exists() and child.returncode==0:break
                loop_errors.append('SMC_SHADOW_WORKER_RESTARTING_' + str(child.returncode))
                try:
                    if child_log: child_log.close()
                    child_log = (RUNTIME/'smc_worker.log').open('ab')
                    child = subprocess.Popen([node, str(HERE/'smc_shadow.js')], cwd=RUNTIME, env=env,
                                             stdout=child_log, stderr=child_log, creationflags=subprocess.CREATE_NO_WINDOW)
                    status['smc_pid'] = child.pid
                except Exception as respawn_err:
                    loop_errors.append('SMC_RESPAWN_FAILED_' + str(respawn_err))
            try:status['smc']=read_json(RUNTIME/'smc_status.json')
            except (OSError,ValueError):status['smc']={'state':'INITIALIZING'}
            if now-status['smc'].get('updated_utc_ms',0)>180000:loop_errors.append('SMC_STATUS_STALE')
            status.update({'state':'RUNNING','updated_utc_ms':int(time.time()*1000),'errors':loop_errors,
                'loop_duration_ms':round((time.monotonic()-loop_started)*1000)})
            write_json(RUNTIME/'status.json',status)
            time.sleep(.25)
        status['state']='STOPPED'
    except KeyboardInterrupt:
        status['state']='STOPPED'
    except Exception as e:
        status.update({'state':'FAILED','fatal':str(e),'updated_utc_ms':int(time.time()*1000)})
        write_json(RUNTIME/'status.json',status)
        print(type(e).__name__,str(e),flush=True)
    finally:
        storage.close()
        notifier.close()
        if crypto_live:crypto_live.close()
        tracker.save()
        for arm_id in ARMS:
            arms_gold[arm_id].save()
            for watcher in arms_forex[arm_id].values(): watcher.save()
            for watcher in arms_crypto[arm_id].values(): watcher.save()
        for watcher in forex_trackers.values():watcher.save()
        for watcher in crypto_controls.values():watcher.save()
        if status.get('state') == 'STOPPED':
            (RUNTIME/'STOP').touch()
        if child and child.poll() is None:
            try:child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.terminate();child.wait(timeout=10)
        if child_log:child_log.close()
        if candle_child and candle_child.poll() is None:
            try:candle_child.wait(timeout=10)
            except subprocess.TimeoutExpired:candle_child.terminate();candle_child.wait(timeout=5)
        if candle_log:candle_log.close()
        status['updated_utc_ms']=int(time.time()*1000)
        write_json(RUNTIME/'status.json',status)
        lock.close()
    return 1 if status['state']=='FAILED' else 0


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--seconds',type=float,default=0)
    raise SystemExit(run(parser.parse_args().seconds))
