#!/usr/bin/env python3
"""Check frozen source/data/metadata; never run package implementation."""
import argparse
import collections
import csv
import hashlib
import json
import pathlib
import re
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--write", action="store_true")
args = parser.parse_args()
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
scope = json.loads((HERE / "scope.json").read_text())
pin = scope["source_checkpoint"]
errors, drift, cache, byte_cache = [], [], {}, {}
counts = collections.Counter()


def check(condition, label):
    if not condition:
        errors.append(label)


for item in json.loads((HERE / "source-index.json").read_text()):
    path = item["path"]
    result = subprocess.run(["git", "show", f"{pin}:{path}"], cwd=ROOT, capture_output=True)
    check(result.returncode == 0, "missing frozen input: " + path)
    data = result.stdout
    byte_cache[path] = data
    check(hashlib.sha256(data).hexdigest() == item["sha256"], "frozen hash: " + path)
    check(len(data) == item["bytes"], "frozen size: " + path)
    if not item["binary"]:
        text = data.decode("utf8")
        check(len(text.splitlines()) == item["lines"], "line count: " + path)
        cache[path] = text
    if not (ROOT / path).exists() or (ROOT / path).read_bytes() != data:
        drift.append(path)
    counts["frozen_inputs"] += 1


def visit(item):
    if isinstance(item, dict):
        path = item.get("path")
        line = item.get("line")
        if isinstance(path, str) and isinstance(line, int) and not path.startswith("/"):
            check(path in cache, "unindexed anchor: " + path)
            if path in cache:
                lines = cache[path].splitlines()
                check(1 <= line <= len(lines), "anchor range: " + path + ":" + str(line))
                if 1 <= line <= len(lines):
                    actual = lines[line - 1].strip()
                    if item.get("source_line"):
                        check(actual == item["source_line"].strip(), "anchor text: " + path + ":" + str(line))
                    if item.get("needle"):
                        check(item["needle"] in lines[line - 1], "anchor needle: " + path + ":" + str(line))
                    counts["source_anchors"] += 1
        for value in item.values():
            visit(value)
    elif isinstance(item, list):
        for value in item:
            visit(value)


reports = {}
for name in ["values", "work", "preparation", "review-values-preparation", "review-work", "evidence-reconciliation"]:
    reports[name] = json.loads((HERE / (name + ".json")).read_text())
    visit(reports[name])

coverage = [json.loads(line) for line in (HERE / "coverage.jsonl").read_text().splitlines()]
prior = [json.loads(line) for line in cache["docs/research/package-library-audit-20261006/responsibility-callers/responsibilities.jsonl"].splitlines()]
check(len(coverage) == 316, "responsibility count")
check(len({r["id"] for r in coverage}) == len(coverage), "duplicate crosswalk ID")
check({r["id"] for r in coverage} == {r["id"] for r in prior}, "responsibility ID drift")
check(collections.Counter(r["owner"] for r in coverage) == collections.Counter(r["owner"] for r in prior), "owner drift")
inventory = list(csv.DictReader((HERE / "file-coverage.tsv").open(), delimiter="\t"))
check(len(inventory) == 395, "inventory count")
check(len({r["path"] for r in inventory}) == len(inventory), "duplicate inventory path")
for row in inventory:
    check(set(row["responsibility_ids"].split(",")) <= {r["id"] for r in coverage}, "file crosswalk: " + row["path"])
    check(hashlib.sha256(byte_cache[row["path"]]).hexdigest() == row["source_sha256"], "inventory hash: " + row["path"])

values = reports["values"]
exact = cache["packages/values/semantics/src/transport/exact.rs"].split("pub fn dispatch(", 1)[1].split("pub fn handle_line(", 1)[0]
native_ops = re.findall(r'^\s*"([a-z0-9.-]+)"\s*=>', exact, re.M)
reference = cache["packages/values/conformance/ports/exact/differential.mjs"].split("const TS_OPS = {", 1)[1].split("\n};", 1)[0]
reference_ops = re.findall(r'^\s*"([a-z0-9.-]+)"\s*:', reference, re.M)
host = cache["packages/values/bindings/backend.ts"].split("const TS_OPS:", 1)[1].split("\n};", 1)[0]
host_ops = re.findall(r'^\s*"([a-z0-9.-]+)"\s*:', host, re.M)
check(len(native_ops) == len(set(native_ops)) == 69, "native exact registry count")
check(set(native_ops) == {o["op"] for o in values["operations"]}, "exact mapping")
check(set(native_ops) == set(reference_ops), "exact reference names")
check(len(host_ops) == 6 and set(host_ops) == {o["op"] for o in values["operations"] if o["common_smoke_registry"]}, "six-name host intersection")
structural = cache["packages/values/semantics/src/profiles.rs"].split("pub fn handle_line(", 1)[1]
structural_ops = re.findall(r'^\s*"([a-z0-9.-]+)"\s*=>', structural, re.M)
check(len(structural_ops) == 6 and set(structural_ops) == {o["op"] for o in values["structural_operations"]}, "scaffold registry")

work = reports["work"]
declared = set()
for family in ["rows", "retry", "every", "lifecycle", "receipt", "recovery", "linkage"]:
    path = f"packages/work-kernel/decisions/{family}.rs"
    declared |= {(family, name) for name in re.findall(r'^pub fn ([a-z0-9_]+)', cache[path], re.M)}
mapped = {(o["family"], o["native_function"]) for o in work["operation_ownership_map"]}
grouped = {(g["family"], name) for g in work["operation_groups"] for name in g["functions"]}
check(len(declared) == 86 and declared == mapped == grouped, "work declared/map/groups")
check(len(work["operation_groups"]) == 27, "work group count")

binary = json.loads((HERE / "artifacts.json").read_text())
recheck = subprocess.check_output([sys.executable, str(HERE / "inspect_artifacts.py"), pin], cwd=ROOT)
check(json.loads(recheck) == binary, "static artifact inspection reproduction")
check(binary["runtime_execution"] is False, "binary execution flag")
exports = {item["name"] for item in binary["binary"]["exports"]}
check({"abi_version", "exact_call", "structural_abi_version", "validation_call", "memory"} <= exports, "export metadata")

receipt_path = "implementation/rust-port-orchestration/runs/codex-step9-20261007T012914Z/values-qualification-receipt.json"
receipt = json.loads(cache[receipt_path])
matches, missing = [], []
for path, digest in receipt["exact_used_non_generated_source_copy"].items():
    result = subprocess.run(["git", "show", f"{pin}:{path}"], cwd=ROOT, capture_output=True)
    if result.returncode:
        missing.append(path)
    else:
        check(hashlib.sha256(result.stdout).hexdigest() == digest, "historical source correspondence: " + path)
        matches.append(path)
check(len(matches) == 158 and set(missing) == {"packages/contracts/.turbo/turbo-build.log", "packages/values/.turbo/turbo-build.log"}, "historical source pin domain")
wasm_hash = next(f["sha256"] for f in binary["files"] if f["path"].endswith(".wasm"))
check(receipt["fresh_binary_sha256"] == wasm_hash, "current asset qualification hash")
for name, key in [("values-independent-installed.json", "loaded"), ("values-workerd-receipt.json", "installed_sha256")]:
    d = json.loads(cache[receipt_path.rsplit("/", 1)[0] + "/" + name])
    actual = d[key]["wasm"]["sha256"] if key == "loaded" else d[key]["valuesWasm"]
    check(actual == wasm_hash, "historical installed/host asset: " + name)

for path in ["README.md", "decision-record.md"]:
    for target in re.findall(r'\]\(([^)]+)\)', (HERE / path).read_text()):
        if not target.startswith(("https:", "http:", "#")):
            check((HERE / target.split("#", 1)[0]).exists(), "broken document link: " + target)
check(scope["execution_authorized"] is False, "scope execution flag")
package_drift = [path for path in drift if path.startswith("packages/")]
check(not package_drift, "package source drift: " + str(package_drift))
result = {"source_checkpoint": pin, "checks": dict(counts), "responsibilities": len(coverage),
          "inventory_files": len(inventory), "owners": len({r["owner"] for r in coverage}),
          "values_native_ops": len(native_ops), "values_reference_ops": len(reference_ops),
          "values_common_host_names": len(host_ops), "validation_scaffold_ops": len(structural_ops),
          "work_public_native_functions": len(declared), "work_groups": len(work["operation_groups"]),
          "historical_matching_source_pins": len(matches), "absent_generated_cache_pins": missing,
          "static_binary_metadata_reproduced": True, "new_runtime_acceptance": False,
          "package_inputs_equal_current": not package_drift, "non_package_drift": [p for p in drift if p not in package_drift],
          "errors": errors, "product_execution": False, "execution_authorized": False}
if args.write:
    (HERE / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
sys.exit(bool(errors))
