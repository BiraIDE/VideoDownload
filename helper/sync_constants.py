#!/usr/bin/env python3
"""Check de drift DRY: valida que helper fallback coincide com constants (SSOT).
Helper usa `from helper.stream2jd_constants import ...` com fallback inline;
este script verifica scalars criticos para CI.
Uso: python3 helper/sync_constants.py --check
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONSTANTS = ROOT / "stream2jd_constants.py"
HELPER = ROOT / "stream2jd_helper.py"

SCALARS = ["VERSION","CLICKNLOAD_REFERER","MAX_MANIFEST_SIZE","SESSION_LIFETIME","DOWNLOAD_REQUEST_COOLDOWN","SEGMENT_REQUEST_COOLDOWN","UPSTREAM_TIMEOUT","UPSTREAM_RETRIES","SEGMENT_BUFFER_LIMIT"]

def load_constants():
    import importlib.util
    spec = importlib.util.spec_from_file_location("stream2jd_constants_check", str(CONSTANTS))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def check():
    mod = load_constants()
    helper_text = HELPER.read_text(encoding="utf-8")
    mism = []
    for name in SCALARS:
        val = getattr(mod, name)
        # collect all occurrences "NAME = <expr>" in helper
        matches = re.findall(rf"^\s*{re.escape(name)}\s*=\s*(.+)$", helper_text, re.M)
        if not matches:
            mism.append(f"{name}: not found in helper")
            continue
        ok = False
        for expr in matches:
            expr = expr.strip()
            try:
                # evaluate expression safely: only literals and * / + -
                helper_val = eval(expr, {"__builtins__": {}}, {})
                if helper_val == val:
                    ok = True
                    break
                # for quoted strings eval again
                # also try direct repr match
                if repr(val) == expr:
                    ok = True
                    break
            except Exception:
                if repr(val) in expr:
                    ok = True
                    break
        if not ok:
            mism.append(f"{name}: constants={val!r} not matching any fallback {matches!r}")
    if mism:
        print("DRIFT detectado:")
        for line in mism:
            print("  -", line)
        return 1
    print("constants sync OK")
    return 0

if __name__ == "__main__":
    sys.exit(check())
