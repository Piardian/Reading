import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / 'runtime'


def status():
    try:
        return json.loads((RUNTIME / 'status.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def fresh(s):
    return s.get('state') in ['STARTING', 'RUNNING'] and time.time() * 1000 - s.get('updated_utc_ms', 0) < 15000


def launch_silent(cmd_args, cwd, log_path):
    """Launches a Python worker invisibly on Windows without spawning cmd.exe or PowerShell consoles."""
    flags = 0
    if hasattr(subprocess, 'CREATE_NO_WINDOW'):
        flags |= subprocess.CREATE_NO_WINDOW
    if hasattr(subprocess, 'CREATE_NEW_PROCESS_GROUP'):
        flags |= subprocess.CREATE_NEW_PROCESS_GROUP
    log_fp = open(log_path, 'ab')
    try:
        child = subprocess.Popen(
            cmd_args,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
        )
        return child.pid
    finally:
        log_fp.close()


def is_pid_alive(pid):
    if not pid or pid <= 0:
        return False
    if sys.platform == 'win32':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return exit_code.value == STILL_ACTIVE
                return True
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    RUNTIME.mkdir(exist_ok=True)

    if action == 'start':
        s = status()
        if fresh(s) and is_pid_alive(s.get('pid')):
            print('READING zaten calisiyor. PID:', s.get('pid'))
            return
        for lock_name in ['STOP', 'instance.lock', 'mt5_candles.lock']:
            lp = RUNTIME / lock_name
            if lp.exists():
                try:
                    lp.unlink()
                except OSError:
                    pass

        log_path = RUNTIME / 'process.log'
        pid = launch_silent([sys.executable, str(HERE / 'service.py')], HERE, log_path)

        for _ in range(80):
            s = status()
            if fresh(s):
                print('READING SHADOW basladi. PID:', s.get('pid'))
                return
            time.sleep(0.25)
        print('Baslatma henuz dogrulanamadi. PID:', pid)

    elif action == 'stop':
        (RUNTIME / 'STOP').touch()
        for _ in range(120):
            s = status()
            if s and s.get('state') in ['STOPPED', 'FAILED']:
                print('READING durdu:', s['state'])
                return
            time.sleep(0.25)
        print('Durdurma istendi; sonuc henuz dogrulanamadi.')

    elif action == 'status':
        s = status()
        print(json.dumps(s, ensure_ascii=True, indent=2))
        if s.get('state') == 'RUNNING' and not fresh(s):
            print('UYARI: Durum kaydi bayat.')

    elif action == 'watchdog_start':
        # Check if watchdog already running
        lock_file = RUNTIME / 'watchdog.pid'
        if lock_file.exists():
            try:
                old_pid = int(lock_file.read_text().strip())
                if is_pid_alive(old_pid):
                    print('Watchdog zaten calisiyor. PID:', old_pid)
                    return
            except Exception:
                pass
        log_path = RUNTIME / 'watchdog.log'
        w_pid = launch_silent([sys.executable, str(HERE / 'watchdog.py')], HERE, log_path)
        lock_file.write_text(str(w_pid), encoding='utf-8')
        print('Watchdog baslatildi. PID:', w_pid)

    elif action == 'watchdog_stop':
        lock_file = RUNTIME / 'watchdog.pid'
        if lock_file.exists():
            try:
                old_pid = int(lock_file.read_text().strip())
                subprocess.run(
                    ['taskkill', '/T', '/F', '/PID', str(old_pid)],
                    capture_output=True,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                lock_file.unlink(missing_ok=True)
                print('Watchdog durduruldu.')
                return
            except Exception as e:
                print('Watchdog durdurulamadi:', e)
        print('Watchdog calismiyor.')

    else:
        raise SystemExit('start|stop|status|watchdog_start|watchdog_stop')


if __name__ == '__main__':
    main()
