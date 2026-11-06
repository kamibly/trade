"""
One-off check: is each voter right more often than chance on the daily charts
the ML trains on? The work is in voters_check.mjs; this only hands it your
watchlist and settings. Nothing is saved.
    docker exec trade-service python voters_check.py            (a few minutes)
    docker exec trade-service python voters_check.py --weights  (weights set on the older half, graded on the newer)
"""
import json
import os
import subprocess
import sys

import service


def main() -> None:
    profile = service.load_state().get("profile")
    if not profile:
        sys.exit("No profile on the server yet")
    job = {"items": service.watch_items(profile), "settings": service.engine_settings(profile),
           "total": service.TRAIN_SYMBOLS, "cryptoTotal": service.TRAIN_CRYPTO}
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voters_check.mjs")
    proc = subprocess.run([service.NODE, script, *sys.argv[1:]], input=json.dumps(job), capture_output=True, text=True, timeout=3600)
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0:
        sys.exit((proc.stderr or "voters check failed").strip()[-500:])


if __name__ == "__main__":
    main()
