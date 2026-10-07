#!/usr/bin/env python3
"""Replay saved mechanical receipts without rerunning production workloads.

Raw hashes include all whitespace. Historical inputs are compared with their
recorded Git revision, never with today's source. This is evidence consistency,
not semantic completeness, independent timing reproduction, or release approval.
"""
import copy
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
import statistics
import subprocess
import sys
from urllib.parse import unquote


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
ERRORS = []
CHECKS = {}


def check(condition, label):
    if not condition:
        ERRORS.append(label)


def read_json(path):
    return json.loads(path.read_bytes())


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def pin(path, expected, label):
    try:
        check(sha(path.read_bytes()) == expected, label + ": SHA256 mismatch")
    except OSError as error:
        ERRORS.append(label + ": " + str(error))


def git_blob(ref, path):
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT)


def guard(label, action):
    try:
        action()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        ERRORS.append(label + ": " + str(error))


def release():
    receipt = read_json(HERE / "release-receipt.json")
    check((len(receipt["input_pins"]), len(receipt["stream_pins"])) == (117, 100),
          "release declared input/stream closure")
    for name, expected in receipt["input_pins"].items():
        pin(ROOT / name, expected, "release input " + name)
    for name, expected in receipt["stream_pins"].items():
        pin(HERE / name, expected, "release stream " + name)
    CHECKS["release_pins"] = {
        "input": len(receipt["input_pins"]), "stream": len(receipt["stream_pins"]),
        "source_head": receipt["source_head"],
        "receipt_sha256": sha((HERE / "release-receipt.json").read_bytes()),
    }
    raw = (HERE / "evidence/compiler-tests.stdout").read_text()
    rows = re.findall(
        r"test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; "
        r"(\d+) measured; (\d+) filtered out", raw)
    totals = {"compiler_harnesses": len(rows),
              "compiler_passed": sum(int(row[1]) for row in rows),
              "compiler_failed": sum(int(row[2]) for row in rows),
              "compiler_ignored": sum(int(row[3]) for row in rows)}
    check(all(row[0] == "ok" for row in rows), "compiler result contains failure")
    check(totals == {"compiler_harnesses": 52, "compiler_passed": 1070,
                     "compiler_failed": 0, "compiler_ignored": 0}, "compiler raw totals")
    check(all(receipt["results"][key] == value for key, value in totals.items()),
          "release results differ from compiler raw totals")
    stderr = (HERE / "evidence/compiler-tests.stderr").read_text()
    skips = [line for line in stderr.splitlines() if line.startswith("SKIP ")]
    check(skips == ["SKIP mode 4750: this host did not retain the requested fixture bits"],
          "compiler actual body skip list")
    check(receipt["results"]["actual_permission_body_skips"] == len(skips),
          "permission skip count differs from receipt")
    markers = ["BDD bindings:", "OUT-R01:", "EXECUTED source-built equality;",
               "EXECUTED actual catalog loader and fresh CLI check:",
               "PASS typed policy:", "PASS typed reference:", "C03U:"]
    for marker in markers:
        check(marker in stderr, "actual consumer marker missing: " + marker)
    check(stderr.count("OUT-R01:") == 2, "actual OUT-R01 body count")
    check(len(re.findall(r"^C01 witness [0-5]:", stderr, re.M)) == 6,
          "actual C01 vector body count")
    CHECKS["compiler_raw_results"] = dict(totals, body_skips=skips,
                                         measured=sum(int(row[4]) for row in rows),
                                         filtered=sum(int(row[5]) for row in rows))
    editor = read_json(HERE / receipt["editor_evidence"]["metadata"])
    expected_editor = {"strict-typescript": 0, "protocol-39": 39,
                       "startup-11": 11, "currentness-5": 5}
    check({row["label"]: row["PASS_lines"] for row in editor} == expected_editor
          and len(editor) == 4, "editor exported execution closure")
    check((receipt["results"]["editor_startup_checks"],
           receipt["results"]["editor_protocol_checks"],
           receipt["results"]["editor_currentness_groups"]) == (11, 39, 5),
          "editor exported checks differ from receipt")
    for row in editor:
        check(row["exit_code"] == 0 and row["source_session_line"] > 0
              and row["execution_id"] and row["utc_timestamp"] and row["command"],
              "editor retained execution metadata " + row["label"])
        for channel in ["stdout", "stderr"]:
            path = HERE / f"evidence/can-editor-final-receipts-{row['label']}.{channel}.session-export.txt"
            pin(path, row[channel + "_sha256"], "editor session export " + row["label"] + channel)
        stdout = (HERE / f"evidence/can-editor-final-receipts-{row['label']}.stdout.session-export.txt").read_text()
        check(len(re.findall(r"^PASS(?:\s|$)", stdout, re.M)) == row["PASS_lines"],
              "editor exported PASS body count " + row["label"])
    CHECKS["editor_session_exports"] = {
        "executions": len(editor), "PASS_lines": expected_editor,
        "origin": receipt["editor_evidence"]["origin"],
        "limit": "Retained session exports; no new native raw redirection or execution",
    }


def counts():
    saved = read_json(HERE / "production-counts.json")
    counter_path = (HERE / saved["counter"]).resolve()
    counter = runpy.run_path(str(counter_path), run_name="receipt_counter")
    physical, spans = counter["physical"], counter["test_spans"]
    def count(raw):
        text = raw.decode("utf-8")
        tests = sum(physical(text[a:b]) for a, b in spans(text))
        total = physical(text)
        return {"production": total - tests, "inline_test": tests, "physical": total}
    before = after = 0
    paths = [row["path"] for row in saved["rows"]]
    check(len(paths) == len(set(paths)), "production count duplicate file")
    check(set(paths) == {str(path.relative_to(ROOT)) for path in (ROOT / "compiler/src").rglob("*.rs")},
          "production count file closure")
    for row in saved["rows"]:
        old = git_blob(saved["before_ref"], row["path"])
        current = (ROOT / row["path"]).read_bytes()
        check(sha(old) == row["before_sha256"], "count historical pin " + row["path"])
        check(sha(current) == row["after_sha256"], "count current pin " + row["path"])
        old_count, current_count = count(old), count(current)
        check(old_count == row["before"], "count historical split " + row["path"])
        check(current_count == row["after"], "count current split " + row["path"])
        before += old_count["production"]
        after += current_count["production"]
    check((before, after) == (saved["before_production"], saved["after_production"]),
          "aggregate count replay differs from receipt")
    check((before, after, after - before, after - saved["original_programme_production"])
          == (69255, 69416, 161, 297), "declared compiler production counts")
    check(saved["compiler_net"] == after - before, "compiler net")
    check(saved["versus_original_net"] == after - saved["original_programme_production"],
          "original programme net")
    closure_net = 0
    closure_rows = saved["closure_accounting"]
    check({row["commit"] for row in closure_rows} == {"c84b815", "cdfd1ed", "25263de"}
          and len(closure_rows) == 3, "bounded commit closure")
    for row in closure_rows:
        net = 0
        changed = subprocess.check_output(
            ["git", "diff", "--name-only", row["commit"] + "^", row["commit"]], cwd=ROOT
        ).decode().splitlines()
        source_closure = {path for path in changed if path.startswith("compiler/src/")
                          or path == "packages/testkit/src/runner/steps.ts"}
        check(source_closure == set(row["files"]), "bounded complete production closure " + row["commit"])
        for path, declared in row["files"].items():
            old = git_blob(row["commit"] + "^", path)
            new = git_blob(row["commit"], path)
            metric = (lambda raw: count(raw)["production"]) if path.endswith(".rs") else physical
            # The published physical counter accepts text; Rust count accepts bytes.
            old_count = metric(old) if path.endswith(".rs") else metric(old.decode())
            new_count = metric(new) if path.endswith(".rs") else metric(new.decode())
            check({"before": old_count, "after": new_count} == declared,
                  "bounded closure file replay " + row["commit"] + ":" + path)
            net += new_count - old_count
        check(net == row["net"], "bounded closure net " + row["commit"])
        closure_net += net
    check(closure_net == -26 and saved["bounded_simplification_net_removed"] == -closure_net,
          "bounded simplification commit metric")
    CHECKS["production_counts"] = {
        "files": len(paths), "before_ref": saved["before_ref"],
        "before": before, "after": after, "net": after - before,
        "versus_original": after - saved["original_programme_production"],
        "counter_sha256": sha(counter_path.read_bytes()),
        "bounded_simplification_replayed": -closure_net,
        "closure_accounting": closure_rows,
        "bounded_scope_attribution": "Complete selected changed production closures at each commit; semantic attribution reviewed separately",
    }


def flat():
    debug = read_json(HERE / "flat-evidence/final-results.json")
    for name, expected in debug["pins"].items():
        pin(Path(name) if Path(name).is_absolute() else ROOT / name, expected, "debug input " + name)
    for name, expected in debug["compiler_sources"].items():
        pin(ROOT / name, expected, "debug source " + name)
    expected_debug = {("all", 64): 0, ("all", 512): 0, ("all", 1024): -6,
                      ("all", 2048): -6, ("all", 3000): -6,
                      ("lower", 512): 0, ("lower", 1024): -6,
                      ("clone", 512): 0, ("clone", 1024): 0}
    check({(row["mode"], row["terms"]): row["exit"] for row in debug["results"]}
          == expected_debug and len(debug["results"]) == 9, "debug flat outcomes")
    for row in debug["results"]:
        pin(ROOT / row["source"], row["source_sha256"], "debug authored input")
        for channel in ["stdout", "stderr"]:
            pin(HERE / "flat-evidence" / row[channel], row[channel + "_sha256"], "debug raw " + row[channel])
        text = (HERE / "flat-evidence" / row["stderr"]).read_bytes().decode()
        check(text == row["stages"], "debug stages not exact raw stderr")
        check(("all stages complete" in text) == (row["exit"] == 0), "debug completion/exit")
        if row["exit"] == -6:
            check("overflowed its stack" in text, "debug abort stack evidence")
    release = read_json(HERE / "flat-evidence/release-results.json")
    pin(Path(release["binary"]), release["binary_sha256"], "release flat binary")
    pin(ROOT / "packages/values/dist/catalog.json", release["catalog_sha256"], "release flat catalog")
    check({(row["terms"], row["stage"]) for row in release["results"]}
          == {(terms, stage) for terms in [1024, 2048, 3000] for stage in ["check", "compile"]}
          and len(release["results"]) == 6, "release flat case closure")
    for row in release["results"]:
        source = HERE.parent / "responsibility-map/failure-evidence" / f"source-flat-{row['terms']}.can"
        pin(source, row["source_sha256"], "release flat authored input")
        check(row["exit"] == 0, "release flat nonzero exit")
        for channel in ["stdout", "stderr"]:
            pin(HERE / "flat-evidence" / row[channel], row[channel + "_sha256"], "release flat raw " + row[channel])
        payload = read_json(HERE / "flat-evidence" / row["stdout"])
        check(payload.get("complete") is True if row["stage"] == "check"
              else payload.get("artifact_version") == 1, "release flat payload admission")
    CHECKS["flat_cases"] = {"debug": len(debug["results"]), "debug_aborts": 4,
                            "release": len(release["results"]), "release_all_exit_zero": True}


def profile():
    saved = read_json(HERE / "profile/results.json")
    for name, expected in saved["pins"].items():
        pin(Path(name), expected, "profile input " + name)
    check((saved["warmups_per_side"], saved["samples_per_side"]) == (3, 20),
          "profile warmup/sample declarations")
    expected_order = [side for revision in range(4, 24)
                      for side in (["before", "after"] if revision % 2 else ["after", "before"])]
    check(saved["alternating_order"] == expected_order, "profile alternating order")
    medians = {}
    for key, short in [("cli_compile_ms", "cli"), ("lsp_edit_seven_queries_ms", "lsp")]:
        medians[short] = {}
        for side in ["before", "after"]:
            values = saved[key][side]
            check(len(values) == 20 and all(isinstance(x, (int, float)) and math.isfinite(x) and x > 0 for x in values),
                  "profile sample vector " + key + side)
            median = statistics.median(values)
            check(math.isclose(median, saved["median_ms"][short][side], abs_tol=1e-12),
                  "profile median replay " + key + side)
            medians[short][side] = median
    for side in ["before", "after"]:
        frames = read_json(HERE / f"profile/{side}-lsp.frames.json")
        publications = [frame for frame in frames if frame.get("method") == "textDocument/publishDiagnostics"]
        check([frame["params"]["version"] for frame in publications] == list(range(1, 24)),
              "profile 3 warmup +20 retained LSP revisions " + side)
        check(all(frame["params"]["diagnostics"] == [] for frame in publications),
              "profile clean LSP revisions " + side)
        responses = [frame for frame in frames if "id" in frame]
        check(len(responses) == 163 and all("result" in frame and "error" not in frame for frame in responses),
              "profile 23x7 queries plus initialization/shutdown " + side)
    def projection(value):
        value = copy.deepcopy(value)
        value.pop("modules")
        for item in value["callables"]:
            for key in ["module", "export", "member"]:
                item.pop(key)
        for item in value["pages"]:
            for key in ["module", "export"]:
                item.pop(key)
        for item in value["tests"]:
            item.pop("module", None)
        return value
    before = read_json(HERE / "profile/before-artifact.json")
    after = read_json(HERE / "profile/after-artifact.json")
    check(projection(before) == projection(after) and saved["artifact_projection_equal"] is True,
          "profile retained artifact semantics projection")
    historical = read_json(HERE / "profile/before-inputs.json")
    for name, expected in historical["files"].items():
        check(sha(git_blob(historical["ref"], name)) == expected, "historical profile input " + name)
    final = read_json(HERE / "profile/after-bdd-inputs.json")
    for name, expected in final["files"].items():
        # Full old build/test snapshots remain historical; production binary
        # source is the matched closure retained by this profile.
        if name.startswith("compiler/src/") or name in ["compiler/build.rs", "compiler/Cargo.toml", "compiler/Cargo.lock"]:
            pin(ROOT / name, expected, "profile final binary source " + name)
    CHECKS["matched_profile"] = {"warmups_per_side": 3, "samples_per_side": 20,
                                 "median_ms": medians, "artifact_projection_equal": True,
                                 "historical_input_pins": len(historical["files"])}


def advice():
    choices = []
    requests = []
    for number in range(1, 4):
        request = read_json(HERE / f"flat-stack-choice-{number}.request.json")
        response = read_json(HERE / f"flat-stack-choice-{number}.response.json")
        check(response["request"] == request, "JEV request/response correspondence " + str(number))
        answer = response["response"]["answers"]["repair_direction"]
        check(answer["type"] == "choice" and answer["choice"] == "iterative", "JEV direction " + str(number))
        probabilities = answer["probabilities"]
        check(set(probabilities) == {"iterative", "structural_limit", "stack_support"}
              and math.isclose(sum(probabilities.values()), 1.0, abs_tol=1e-12), "JEV probabilities " + str(number))
        requests.append(json.dumps(request, sort_keys=True))
        choices.append({"choice": answer["choice"], "confidence": answer["confidence"],
                        "iterative_probability": probabilities["iterative"]})
    check(len(set(requests)) == 3, "JEV independently worded requests")
    check([row["confidence"] for row in choices] == [0.49, 0.94, 0.86], "JEV saved confidence")
    check([row["iterative_probability"] for row in choices] == [0.66, 0.96, 0.91], "JEV saved probability")
    CHECKS["advice"] = {"requests": 3, "answers": choices, "scope": "advice only; equivalence/fairness reviewed separately"}


def ledger_links():
    ledger_path = HERE.parent / "responsibility-map/coverage.jsonl"
    raw_lines = ledger_path.read_bytes().splitlines(keepends=True)
    rows = [json.loads(line) for line in raw_lines]
    historical = git_blob("7f4b26cfc6a4d8c77a012387eebf1c373d90be75",
                          str(ledger_path.relative_to(ROOT))).splitlines(keepends=True)
    check(len(historical) == 591 and len(rows) == 667, "ledger historical/current row totals")
    check(raw_lines[1:591] == historical[1:], "ledger historical raw lines retained except scope navigation")
    old_scope, scope = json.loads(historical[0]), rows[0].copy()
    scope.pop("resumption_join", None)
    check(scope == old_scope, "ledger first historical row only navigation extension")
    current = rows[591:]
    counts = collections.Counter(row["record"] for row in current)
    expected = {"resumption_disposition": 37, "resumption_lowering_duty": 11,
                "resumption_lowering_followup": 8, "resumption_cost_oracle_followup": 12,
                "resumption_repair": 4, "resumption_scope": 1,
                "resumption_integration_disposition": 1, "resumption_independent_review": 1,
                "resumption_execution": 1}
    check(dict(counts) == expected, "ledger exact appended record counts")
    keys = [(row["record"], row["id"]) for row in current]
    check(len(keys) == len(set(keys)), "ledger current record/id keys unique")
    findings = {(row["record"], row["id"]) for row in rows[:591]
                if re.fullmatch(r"(?:SYN|SEM|OUT|ED|FAIL)-R\d\d", row.get("id", ""))}
    dispositions = {(row["historical_record"], row["id"]) for row in current
                    if row["record"] == "resumption_disposition"}
    check(len(findings) == 37 and dispositions == findings, "ledger exact historical finding disposition joins")
    expected_ids = {
        "resumption_lowering_duty": {f"S9-{i:02}" for i in range(1, 12)},
        "resumption_lowering_followup": {f"S9-Q{i:02}" for i in range(1, 9)},
        "resumption_cost_oracle_followup": {f"OR-{i:02}" for i in range(1, 7)}
            | {f"DEP-{i:02}" for i in range(1, 4)} | {"COST-01", "ARCH-01", "ARCH-02"},
        "resumption_repair": {"OR-03", "OR-BDD-ID", "OR-BDD-SEQUENCE", "BDD-QUOTE"},
    }
    for record, ids in expected_ids.items():
        check({row["id"] for row in current if row["record"] == record} == ids,
              "ledger exact keys " + record)
    checked_links = 0
    def local_link(origin, target):
        nonlocal checked_links
        target = target.strip().strip("<>")
        if not target or re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
            return
        path = unquote(target.split("#", 1)[0])
        check((origin.parent / path).exists(), "local report link missing: " + str(origin.relative_to(ROOT)) + " -> " + target)
        checked_links += 1
    for report in HERE.rglob("*.md"):
        text = re.sub(r"```[^\n]*\n.*?```", "", report.read_text(), flags=re.S)
        for target in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", text):
            local_link(report, target)
    for row in current:
        for key in ["review", "evidence_join", "canonical_plan", "receipt", "production_counts", "validation"]:
            if isinstance(row.get(key), str) and ("/" in row[key] or "." in row[key]):
                local_link(ledger_path, row[key])
        for target in row.get("reviews", []):
            local_link(ledger_path, target)
    CHECKS["ledger_and_local_links"] = {
        "historical": 591, "appended": len(current), "total": len(rows),
        "record_counts": dict(counts), "exact_finding_joins": len(findings),
        "local_file_targets": checked_links, "fragment_limit": "File existence only; Markdown anchors not evaluated",
        "historical_sha256": sha(b"".join(historical)),
        "current_sha256": sha(b"".join(raw_lines)),
    }


if __name__ == "__main__":
    for label, action in [("release", release), ("production counts", counts),
                          ("flat evidence", flat), ("matched profile", profile), ("JEV", advice),
                          ("ledger/local links", ledger_links)]:
        guard(label, action)
    result = {"schema": 1, "scope": "Saved receipt/hash/count/outcome consistency; no production suites or workload executions",
              "validator_sha256": sha(Path(__file__).read_bytes()), "checks": CHECKS,
              "errors": ERRORS, "limitations": [
                  "Hash coherence is not full semantic correctness or execution provenance reconstruction",
                  "Harness passes remain distinct from raw body markers/skips and platform cfg exclusions",
                  "Stored timing samples are recomputed, not rerun; no causal or general performance inference",
                  "Bounded mechanism simplification attribution is separate from parser-free physical counts",
                  "Historical source/build pins are preserved; later test-only strengthening is not recredited to old full harness",
              ]}
    (HERE / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"errors": ERRORS, "checks": list(CHECKS)}))
    sys.exit(bool(ERRORS))
