#!/usr/bin/env python3
"""Capture the local, non-provider portion of the Can help comparison."""

import hashlib
import json
from pathlib import Path
import subprocess
from time import perf_counter_ns

from run_rank_probe import HERE, ROOT, help_cards


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    binary = ROOT / "compiler/target/debug/can"
    catalog = ROOT / "packages/values/dist/catalog.json"
    corpus = ROOT / "design/evaluation/can-dev-novice-20261009/raw"
    frozen = json.loads((HERE / "cases.json").read_text())
    cards = help_cards()
    source_checks = []
    for source in sorted(corpus.glob("*.can")):
        command = [str(binary), "check", "--format=json", "--catalog", str(catalog), str(source)]
        start = perf_counter_ns()
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        elapsed_ms = round((perf_counter_ns() - start) / 1_000_000, 3)
        envelope = json.loads(result.stdout)
        diagnostics = envelope["diagnostics"]
        source_checks.append({
            "source": source.name,
            "source_sha256": digest(source),
            "exit_code": result.returncode,
            "complete": envelope["complete"],
            "omitted": envelope["omitted"],
            "diagnostic_count": len(diagnostics),
            "first_code": diagnostics[0]["code"] if diagnostics else None,
            "first_message": diagnostics[0]["message"] if diagnostics else None,
            "check_elapsed_ms": elapsed_ms,
        })
    reference_compile_checks = []
    for name in ("TeamTasks.can", "ExpenseFlow.can"):
        source = ROOT / "examples" / name
        command = [str(binary), "compile", "--format=json", "--catalog", str(catalog), str(source)]
        start = perf_counter_ns()
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        elapsed_ms = round((perf_counter_ns() - start) / 1_000_000, 3)
        envelope = json.loads(result.stdout)
        diagnostics = envelope.get("diagnostics", [])
        reference_compile_checks.append({
            "source": name,
            "source_sha256": digest(source),
            "exit_code": result.returncode,
            "diagnostic_count": len(diagnostics),
            "E6008_count": sum(item["code"] == "E6008" for item in diagnostics),
            "elapsed_ms": elapsed_ms,
        })
    menus = []
    for case in frozen["cases"]:
        start = perf_counter_ns()
        rows = [{
            "id": ident,
            "signature": cards[ident]["signature"],
            "meaning": cards[ident]["meaning"],
            "link": "docs/specification/CONSTRUCT-HELP.md#" + ident.replace(".", "-"),
        } for ident in sorted(case["candidates"])]
        guidance = {
            "occurrence": case["id"],
            "guess": case["guess"],
            "kind": "neutral_grammar_position_menu",
            "selected_id": None,
            "candidates": rows,
            "notes": "These are documented alternatives, not a verified working replacement for this malformed draft.",
        }
        serialized = json.dumps(guidance, ensure_ascii=False, separators=(",", ":"))
        elapsed_ms = round((perf_counter_ns() - start) / 1_000_000, 3)
        menus.append({
            "case": case["id"],
            "selected_id": None,
            "candidate_count": len(rows),
            "gold_in_menu": case["gold"] in case["candidates"] or case["gold"] in ("none", "unclear"),
            "output_utf8_bytes": len(serialized.encode()),
            "format_elapsed_ms": elapsed_ms,
            "output": guidance,
        })
    report = {
        "status": "local_offline_baseline_only",
        "compiler_binary_sha256": digest(binary),
        "catalog_sha256": digest(catalog),
        "source_checks": source_checks,
        "reference_compile_checks": reference_compile_checks,
        "deterministic_menus": menus,
        "note": "Menus use manually frozen candidates from extracted source phrases. The current compiler does not emit this help; initial diagnostics are structural. Formatting times exclude compiler checks and process startup.",
    }
    (HERE / "local-baseline.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("Checked", len(source_checks), "first drafts; built", len(menus), "offline menus")


if __name__ == "__main__":
    main()
