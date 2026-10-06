#!/usr/bin/env python3
"""Reproduce protocol decoding and fmt metadata gaps without touching sources.

Run from the repository root after building compiler/target/debug/can:
  python3 docs/research/compiler-library-audit-20261006/evidence/protocol-cli/probe.py
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def probe_lsp(binary, body):
    wire = b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
    result = subprocess.run(
        [str(binary), "lsp"], input=wire,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    return {
        "request_hex": body.hex(),
        "exit": result.returncode,
        "stdout": result.stdout.decode(),
        "stderr": result.stderr.decode(),
    }


def main():
    root = Path(__file__).resolve().parents[5]
    binary = root / "compiler/target/debug/can"
    cases = [
        ("wrong_rpc_bool_id", b'{"jsonrpc":"1.0","id":true,"method":"initialize","params":{}}'),
        ("null_id", b'{"jsonrpc":"2.0","id":null,"method":"initialize","params":{}}'),
        ("invalid_utf8", b'{"jsonrpc":"2.0","id":"\xff","method":"initialize","params":{}}'),
    ]
    report = {
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip(),
        "probes": {name: probe_lsp(binary, body) for name, body in cases},
    }
    with tempfile.TemporaryDirectory(prefix="can-cli-audit-") as directory:
        path = Path(directory) / "probe.can"
        path.write_text("app A\nGiven\nWhen\nThen")
        os.chmod(path, 0o600)
        before = oct(path.stat().st_mode & 0o777)
        result = subprocess.run(
            [str(binary), "fmt", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        report["fmt_mode"] = {
            "before": before,
            "after": oct(path.stat().st_mode & 0o777),
            "exit": result.returncode,
            "stdout": result.stdout.decode(),
            "stderr": result.stderr.decode(),
            "formatted_text": path.read_text(),
        }
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
