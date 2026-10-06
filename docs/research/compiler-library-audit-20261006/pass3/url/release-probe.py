#!/usr/bin/env python3
"""Finite outcome corpus for release CLI admission; no runtime substitute."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("compiler", type=Path)
parser.add_argument("catalog", type=Path)
parser.add_argument("--require-qualified", action="store_true")
args = parser.parse_args()
compiler = args.compiler.resolve()
catalog = args.catalog.resolve()
vectors = json.loads(Path(__file__).with_name("vectors.json").read_text())
records = []
with tempfile.TemporaryDirectory(prefix="can-pass3-release-probe-") as directory:
    for vector in vectors:
        token = json.dumps(vector["value"], ensure_ascii=False)
        source = f'app T\nGiven\n M {{ link:url={token} }}\nWhen\nThen\n'
        path = Path(directory) / "value.can"
        path.write_text(source)
        completed = subprocess.run(
            [str(compiler), "check", "--format=json", "--catalog", str(catalog), str(path)],
            capture_output=True, text=True, timeout=10,
        )
        try:
            envelope = json.loads(completed.stdout)
        except json.JSONDecodeError:
            # Old release builds can abort on malformed Unicode before
            # producing an envelope. Retain that observation explicitly.
            envelope = {}
        diagnostics = envelope.get("diagnostics", [])
        actual = completed.returncode == 0 and envelope.get("complete") is True and not diagnostics
        start = len(source[:source.index(token)].encode())
        end = start + len(token.encode())
        anchored = (
            completed.returncode == 10
            and envelope.get("complete") is True
            and len(diagnostics) == 1
            and diagnostics[0]["code"] == "E3001"
            and diagnostics[0]["primary"]["start"] == start
            and diagnostics[0]["primary"]["end"] == end
        )
        qualified = actual if vector["expected"] else anchored
        records.append({
            "id": vector["id"], "expected": vector["expected"], "actual": actual,
            "exit": completed.returncode, "qualified": qualified,
            "diagnostics": diagnostics, "stderr": completed.stderr,
            "stdout_without_envelope": completed.stdout if not envelope else None,
        })
print(json.dumps({
    "compiler_sha256": hashlib.sha256(compiler.read_bytes()).hexdigest(),
    "catalog_sha256": hashlib.sha256(catalog.read_bytes()).hexdigest(),
    "vectors": len(records), "qualified": sum(row["qualified"] for row in records),
    "results": records,
}, ensure_ascii=False, indent=2))
if args.require_qualified and not all(row["qualified"] for row in records):
    raise SystemExit(1)
