"""Run the installed Hermes dashboard with bridge-scoped process ownership.

No gateway, desktop, scheduler, or globally edited environment is involved.
The bridge's stdin pipe is the lifetime lease, even if its process crashes.
"""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import sys
import threading
import time
import _thread


def own_process_tree():
    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters)] + [
            (name, ctypes.c_size_t) for name in (
                "ProcessMemoryLimit", "JobMemoryLimit", "PeakProcessMemoryUsed", "PeakJobMemoryUsed")]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise RuntimeError("Cannot create Hermes lifetime job")
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise RuntimeError("Cannot own Hermes process tree")
    # Keep the sole, non-inheritable handle open until this process exits.
    return job


def watch_owner():
    try:
        # Use an OS pipe read: Hermes or tools may redirect Python's sys.stdin.
        while os.read(0, 4096):
            pass
    finally:
        def deadline():
            time.sleep(3)
            os._exit(0)
        threading.Thread(target=deadline, daemon=True).start()
        _thread.interrupt_main()


if __name__ == "__main__":
    if sys.platform != "win32":
        raise RuntimeError("Managed Hermes runtime currently requires Windows")
    lifetime_job = own_process_tree()
    threading.Thread(target=watch_owner, daemon=True).start()
    root = Path(sys.argv[1]).resolve(strict=True)
    sys.path.insert(0, str(root))
    # Pin the chosen profile. --isolated prevents the CLI from redirecting named
    # profiles to a desktop-owned machine dashboard.
    profile = [] if Path(os.environ["HERMES_HOME"]).parent.name == "profiles" else ["--profile", "default"]
    sys.argv = ["hermes", *profile, "dashboard", "--isolated", "--no-open", "--skip-build", "--host", "127.0.0.1", "--port", "0"]
    from hermes_cli.main import main
    main()
