#!/usr/bin/env python3
"""Finite actual CLI/child controls; all processes and files are disposable."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--expect-unreaped", action="store_true")
args = parser.parse_args()
binary = args.binary.resolve()
before = hashlib.sha256(binary.read_bytes()).hexdigest()
results = []

with tempfile.TemporaryDirectory(prefix="can-render-lifecycle-") as scratch:
    folder = Path(scratch)
    source = folder / "input.can"
    source.write_text('app Demo\nGiven\n Gadget {title:text desc="' + 'x' * 262144
                      + '"}\n policy Gadget read=members\nWhen\nThen\n')
    clean = subprocess.run([str(binary), "check", str(source)], capture_output=True, timeout=10)
    assert clean.returncode == 0, clean.stderr.decode(errors="replace")
    results.append({"case": "source-check", "exit": clean.returncode})

    cases = {
        "success": ('data=json.load(sys.stdin)\nassert "Gadget" in str(data)\nprint("# Reference")\n', 0, "# Reference\n"),
        "nonzero": ('sys.stdin.read()\nsys.stderr.write("renderer-control")\nsys.exit(3)\n', 2, "exit 3"),
        "signal": ('sys.stdin.read()\nos.kill(os.getpid(), signal.SIGTERM)\n', 2, "killed by signal"),
        "invalid-utf8": ('sys.stdin.read()\nsys.stdout.buffer.write(b"\\xff")\n', 2, "non-UTF8"),
        "empty": ('sys.stdin.read()\n', 2, "produced no output"),
        "duplex": ('sys.stdout.write("x"*262144)\nsys.stdout.flush()\nsys.stderr.write("startup-note"*32768)\nsys.stderr.flush()\nsys.stdin.read()\nprint("# Reference")\n', 0, "# Reference\n"),
        "closed-input": ('open(' + repr(str(folder / "pid")) + ',"w").write(str(os.getpid()))\nos.close(0)\ntime.sleep(15)\n', 2, "failed to pipe the reference model"),
    }
    for name, (body, code, expected) in cases.items():
        stub = folder / ("renderer-" + name + ".py")
        stub.write_text("#!/usr/bin/env python3\nimport os,sys,time,json,signal\n" + body)
        stub.chmod(0o700)
        env = {**os.environ, "CAN_PLATFORM_BIN": str(stub)}
        result = subprocess.run([str(binary), "docs", str(source)], env=env, capture_output=True, timeout=10)
        stdout, stderr = result.stdout.decode(errors="replace"), result.stderr.decode(errors="replace")
        assert result.returncode == code, (name, result.returncode, stderr)
        assert expected in (stdout if code == 0 else stderr), (name, stdout, stderr)
        if name == "success":
            assert stdout == "# Reference\n" and not stderr
        if name == "duplex":
            assert stdout == "x" * 262144 + "# Reference\n" and not stderr
        if code:
            assert not stdout and "E7004" in stderr, (name, stdout, stderr)
        row = {"case": name, "exit": result.returncode, "stdout_bytes": len(result.stdout), "stdout_sha256": hashlib.sha256(result.stdout).hexdigest(), "stderr": stderr}
        if name == "closed-input":
            pid = int((folder / "pid").read_text())
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
            if alive:
                os.kill(pid, signal.SIGKILL)
            row["renderer_alive_after_can_exit"] = alive
            row["observer_cleanup"] = "killed residual child" if alive else "none needed"
            assert alive == args.expect_unreaped, row
        results.append(row)

after = hashlib.sha256(binary.read_bytes()).hexdigest()
assert before == after, "binary changed during qualification"
receipt = {
    "binary_sha256": before,
    "source_fixture_bytes": 262226,
    "expect_unreaped": args.expect_unreaped,
    "results": results,
    "limits": "Native CLI/Python child boundary; timeout/capture policy, arbitrary renderer and other hosts are separate obligations.",
}
args.output.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"cases": len(results), "expect_unreaped": args.expect_unreaped, "saved": str(args.output)}))
