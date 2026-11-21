import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / 'runtime'


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


def status():
    try:
        return json.loads((RUNTIME / 'status.json').read_text(encoding='utf-8'))
    except Exception:
        return {}


def log(msg):
    ts = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
    line = f"[{ts}] {msg}\n"
    if sys.stdout is not None:
        try:
            print(line, end='', flush=True)
        except Exception:
            pass
    try:
        with (RUNTIME / 'watchdog.log').open('a', encoding='utf-8') as f:
            f.write(line)
    except Exception:
        pass


def main():
    RUNTIME.mkdir(exist_ok=True)
    log("READING Watchdog supervisor started.")
    while True:
        try:
            time.sleep(10)
            stop_file = RUNTIME / 'STOP'
            if stop_file.exists():
                # User explicitly stopped the service
                continue

            s = status()
            pid = s.get('pid')
            updated = s.get('updated_utc_ms', 0)
            now_ms = time.time() * 1000

            is_stale = (now_ms - updated) > 30000
            is_dead = not is_pid_alive(pid) if pid else True

            if is_dead or is_stale:
                log(f"ALERT: Reading service unhealthy (pid={pid}, is_dead={is_dead}, is_stale={is_stale}). Auto-recovering...")
                res = subprocess.run(
                    [sys.executable, str(HERE / 'manage.py'), 'start'],
                    capture_output=True,
                    text=True,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                log(f"Restart attempt finished: {res.stdout.strip()} {res.stderr.strip()}")
        except Exception as e:
            log(f"Watchdog internal loop error: {e}")


if __name__ == '__main__':
    main()
