"""Hold an actual compiler source read for [DIAG-ANALYSIS-CANCELLATION]."""
import json
import signal
import sys
import time
from pathlib import Path

source, original, opened, release, released = map(Path, sys.argv[1:])
payload = original.read_bytes()


def restore():
    if source.exists():
        source.unlink()
    source.write_bytes(payload)


def timeout(signum, frame):
    restore()
    released.write_text(json.dumps({"releasedAt": time.time(), "reason": "alarm"}))
    raise SystemExit(2)


signal.signal(signal.SIGALRM, timeout)
signal.alarm(50)
with source.open("wb", buffering=0) as writer:
    opened.write_text(json.dumps({"openedAt": time.time()}))
    deadline = time.monotonic() + 20
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    # Restore the regular path before EOF, so a later read cannot reopen the FIFO.
    restore()
    try:
        writer.write(payload)
    except BrokenPipeError:
        pass  # The compiler can close the abandoned read after cancellation.
released.write_text(json.dumps({"releasedAt": time.time()}))
