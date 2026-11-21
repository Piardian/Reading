"""Windows process-lifetime singleton, including pre-upgrade running processes."""
import ctypes
from ctypes import wintypes
import hashlib
import os
from pathlib import Path
import psutil

_handles = []

def acquire(script):
    if os.name != "nt":
        raise RuntimeError("This deployment guard requires Windows")
    target = Path(script).resolve()
    key = str(target).lower()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    handle = kernel.CreateMutexW(None, False, "Local\\TradingSingleton_" + hashlib.sha256(key.encode()).hexdigest())
    error = ctypes.get_last_error()
    if not handle:
        raise ctypes.WinError(error)
    _handles.append(handle)
    if error == 183:
        print("INSTANCE_ALREADY_RUNNING: " + str(target), flush=True)
        raise SystemExit(0)
    # Compatibility with workers started before this guard was deployed.
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        proc_name = (proc.info.get("name") or "").lower()
        if proc.pid == os.getpid() or proc_name not in ("python.exe", "pythonw.exe"):
            continue
        try:
            args = proc.info.get("cmdline") or []
            try:
                cwd = Path(proc.cwd())
            except (psutil.AccessDenied, OSError):
                cwd = None
            candidates = []
            for i, arg in enumerate(args[1:], 1):
                if arg == "-m" and i + 1 < len(args) and cwd is not None:
                    candidates.append(cwd / (args[i + 1].replace(".", "/") + ".py"))
                elif arg.lower().endswith(".py"):
                    arg_path = Path(arg)
                    if arg_path.is_absolute():
                        candidates.append(arg_path)
                    elif cwd is not None:
                        candidates.append(cwd / arg_path)
            if any(str(p.resolve()).lower() == key for p in candidates):
                print("INSTANCE_ALREADY_RUNNING pid=" + str(proc.pid) + ": " + str(target), flush=True)
                raise SystemExit(0)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            continue
