"""Bounded Pass 0 evidence capture. No compiler/runtime edits or library installs."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[6]
PASS = Path(__file__).resolve().parents[2]
OUT = PASS / "evidence" / "root"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run(argv, *, check=True):
    result = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{argv!r} failed: {result.stderr}")
    return {"argv": argv, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


parser = argparse.ArgumentParser()
parser.add_argument("--binary-dir", default="/private/tmp/canlang-compiler-pass0-38c0370/debug")
parser.add_argument("--compiler-build-head", default="38c0370087909dc89386849fec48e6f937aa0d13", help="full repository revision used for the supplied prebuilt compiler")
args = parser.parse_args()
binary_dir = Path(args.binary_dir)
profile = {"date": datetime.datetime.now().astimezone().isoformat(), "evidence_capture_head": run(["git", "rev-parse", "HEAD"])["stdout"].strip(), "compiler_build_head": args.compiler_build_head, "compiler_code_baseline": "309644a6881909d8dba32560bc6711f67e00a7ab", "revision_scope": "capture HEAD may include later documentation commits; supplied compiler build and unchanged compiler code hashes are recorded separately", "commands": []}
for argv in [["uname", "-sm"], ["sw_vers", "-productVersion"], ["rustc", "-Vv"], ["cargo", "-V"], ["node", "-p", "JSON.stringify({node:process.version,icu:process.versions.icu,v8:process.versions.v8})"], ["bun", "--version"], [str(binary_dir / "can"), "--version"]]:
    profile["commands"].append(run(argv))
profile["build"] = {"argv": ["cargo", "build", "--locked", "--manifest-path", "compiler/Cargo.toml", "--lib", "--bin", "can", "--target-dir", str(binary_dir.parent)], "exit": 0, "record": "root fresh build completed before this capture; not rerun by verify.py"}
profile["binaries"] = [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in [binary_dir / "can", binary_dir / "libcanlang_compiler.rlib"]]
execution_inputs = [OUT / "verify.py", OUT / "boundary-probe.rs", OUT / "map-probe.mjs", PASS / "evidence/values/export-probe.mjs", PASS.parent / "evidence/codegen/string-and-columns-probe.rs"] + sorted((PASS / "witnesses").glob("*.json"))
profile["execution_inputs"] = [{"path":str(path.relative_to(ROOT)),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()} for path in execution_inputs]
save(OUT / "profile.json", profile)

tracked = run(["git", "ls-files", "compiler", "packages/values", "packages/contracts"])["stdout"].splitlines()
extras = ["package.json", "bun.lock", "scripts/run-tasks.mjs", ".github/workflows/lane-01.yml", ".github/workflows/release.yml", "docs/specification/DESIGN.md", "docs/specification/GRAMMAR.md", "implementation/DIAGNOSTICS.md", "packages/cloudflare/src/runtime/sourcemap.ts", "packages/cloudflare/src/runtime/invoke.ts", "packages/cloudflare/test/sourcemap.test.ts", "packages/cloudflare/dist/runtime/sourcemap.js"]
inputs = {ROOT / path for path in tracked + extras}
inputs.update(execution_inputs)
for owner in ["values", "contracts"]:
    inputs.update(path for path in (ROOT / "packages" / owner / "dist").rglob("*") if path.is_file())
entries = [{"path": str(path.relative_to(ROOT)), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(inputs) if path.is_file()]
catalog = ROOT / "packages/values/dist/catalog.json"
catalog_data = json.loads(catalog.read_text())
save(OUT / "input-manifest.json", {"evidence_capture_head": profile["evidence_capture_head"], "compiler_build_head": profile["compiler_build_head"], "compiler_code_baseline": profile["compiler_code_baseline"], "scope": "tracked compiler/values/contracts plus current built values/contracts and named consumer/tool inputs; whole owner snapshots are conservative input pins, not claims every file executed", "catalog": {"path":str(catalog.relative_to(ROOT)),"language_version":catalog_data["language_version"],"catalog_version":catalog_data["catalog_version"],"sha256":hashlib.sha256(catalog.read_bytes()).hexdigest()}, "entries": entries})

commands = []
for stem in ["boundary", "string"]:
    source = PASS / "evidence/root/boundary-probe.rs" if stem == "boundary" else PASS.parent / "evidence/codegen/string-and-columns-probe.rs"
    executable = f"/private/tmp/canlang-pass0-{stem}-probe"
    commands.append(run(["rustc", "--edition=2024", str(source), "--extern", f"canlang_compiler={binary_dir}/libcanlang_compiler.rlib", "-L", f"dependency={binary_dir}/deps", "-o", executable]))
    observation = run([executable])
    commands.append(observation)
    (OUT / f"{stem}-observations.txt").write_text(observation["stdout"])

strings = json.loads((PASS / "witnesses/strings.json").read_text())
string_checks = []
for test in strings["cases"]:
    token = test["input"]["token"]
    try:
        value = json.loads(token)
        independent = {"valid": True, "codepoints": [ord(c) for c in value]}
        if any(0xD800 <= c <= 0xDFFF for c in independent["codepoints"]):
            independent = {"valid": False, "reason": "Unicode scalar contract rejects unpaired surrogate"}
    except ValueError:
        independent = {"valid": False}
    lexer = json.loads(run(["/private/tmp/canlang-pass0-boundary-probe", "--token", token])["stdout"])
    expected = test["expected"]
    valid = expected.get("valid", True)
    matches = independent["valid"] == valid and lexer["valid"] == valid
    if valid:
        matches = matches and independent["codepoints"] == expected["codepoints"] and lexer["codepoints"] == expected["codepoints"]
    string_checks.append({"id": test["id"], "independent": independent, "lexer": lexer, "matches_expected": matches})
save(OUT / "string-witness-results.json", string_checks)

hash_checks = []
for line in (OUT / "boundary-observations.txt").read_text().splitlines():
    if line.startswith("hash_bytes="):
        raw, actual = line.removeprefix("hash_bytes=").split(" sha256=")
        data = bytes(json.loads(raw))
    elif line.startswith("hash_repeat_a="):
        raw, actual = line.removeprefix("hash_repeat_a=").split(" sha256=")
        data = b"a" * int(raw)
    else:
        continue
    expected = hashlib.sha256(data).hexdigest()
    hash_checks.append({"bytes":len(data), "actual":actual, "expected":expected, "matches_expected":actual == expected})
save(OUT / "hash-results.json", hash_checks)

diagnostic_line = next(line for line in (OUT / "boundary-observations.txt").read_text().splitlines() if line.startswith("diagnostic="))
diagnostic = json.loads(diagnostic_line.removeprefix("diagnostic="))
expected_fields = json.loads((PASS / "witnesses/serialization-maps.json").read_text())["cases"][0]["expected"]["required_fields"]
assert list(diagnostic) == expected_fields
assert diagnostic["schema_version"] == 1 and diagnostic["tool"] == "can"
assert diagnostic["sources"][0]["sha256"] == hashlib.sha256("é😀x\r\n".encode()).hexdigest()
assert diagnostic["diagnostics"][0]["primary"] == {"file":0,"start":6,"end":7}
assert diagnostic["diagnostics"][0]["message"] == "controls \x08\x0c and 😀"
save(OUT / "diagnostic-results.json", {"scope":"independent JSON parsing, fixed key order, source bytes and decoded string values; CLI newline is an existing caller contract, not exercised by this public serializer probe", "matches_expected":True, "parsed":diagnostic})

for script, destination in [(PASS / "evidence/values/export-probe.mjs", PASS / "evidence/values/export-results.json"), (PASS / "evidence/root/map-probe.mjs", OUT / "map-results.json")]:
    captured = run(["node", str(script)])
    commands.append(captured)
    save(destination, json.loads(captured["stdout"]))

file_results = []
with tempfile.TemporaryDirectory(prefix="canlang-pass0-fmt-") as directory:
    directory = Path(directory)
    for kind in ["rewrite", "noop", "symlink", "hardlink"]:
        before = "app F\nGiven\nWhen\nThen\n" if kind == "noop" else "app F   \nGiven\nWhen\nThen"
        path = directory / f"{kind}.can"
        peer = directory / f"{kind}-peer.can"
        if kind == "symlink":
            peer.write_text(before)
            peer.chmod(0o600)
            path.symlink_to(peer.name)
        else:
            path.write_text(before)
            path.chmod(0o600)
            if kind == "hardlink":
                os.link(path, peer)
        inode_before = path.stat().st_ino
        result = subprocess.run([str(binary_dir / "can"), "fmt", str(path)], text=True, capture_output=True, preexec_fn=lambda: os.umask(0o022))
        item = {"case":kind,"exit":result.returncode,"stdout":result.stdout,"stderr":result.stderr,"mode_before":"0600","mode_after":f"{stat.S_IMODE(path.stat().st_mode):04o}","bytes_after":path.read_text(),"inode_unchanged":path.stat().st_ino == inode_before,"symlink_after":path.is_symlink()}
        if peer.exists():
            item["peer_bytes_after"] = peer.read_text()
        item["classification"] = "observed mode-preservation defect" if kind == "rewrite" and item["mode_after"] != "0600" else "existing behavior; link policy remains gated" if kind in ["symlink","hardlink"] else "established no-op invariant"
        file_results.append(item)
save(OUT / "file-results.json", {"host_scope":"macOS only, subprocess umask 0022, local regular/link fixtures; no ACL/durability/race or alternate-host qualification", "results":file_results})

baseline = json.loads((PASS.parent / "evidence/baseline.json").read_text())
drift = [e["path"] for e in baseline["entries"] if hashlib.sha256((ROOT / e["path"]).read_bytes()).hexdigest() != e["sha256"]]
assert not drift
assert all(item["matches_expected"] for item in string_checks + hash_checks)
save(OUT / "commands.json", commands)
print(json.dumps({"compiler_files_unchanged":len(baseline["entries"]),"string_owner_vectors":len(string_checks),"hash_comparisons":len(hash_checks),"value_vectors":len(json.loads((PASS / "evidence/values/export-results.json").read_text())["results"]),"file_observations":len(file_results),"new_build":"locked lib+can; no dependencies added","limits":"known broken emission/mode outcomes recorded rather than claimed fixed; no full suites, Rust candidate or installed/browser qualification"},indent=2))
