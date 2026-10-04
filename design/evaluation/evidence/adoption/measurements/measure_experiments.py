"""Reference counts of saved evaluation artifacts, not model usage or correctness."""
from pathlib import Path
import difflib
import hashlib
import json
import tiktoken

ROOT = Path(__file__).resolve().parents[1] / "experiments"
ENCODINGS = {name: tiktoken.get_encoding(name) for name in ("o200k_base", "cl100k_base")}
SOURCE = {".can", ".py", ".html", ".mjs", ".css", ".js"}


def counts(paths):
    rows = []
    for path in sorted(paths):
        text = path.read_text()
        rows.append({"path": str(path.relative_to(ROOT)), "bytes": len(text.encode()),
                     "lines": len(text.splitlines()), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                     **{name: len(enc.encode(text)) for name, enc in ENCODINGS.items()}})
    return {"files": rows, "total": {key: sum(r[key] for r in rows)
                                      for key in ("bytes", "lines", *ENCODINGS)}}


def stage(path):
    files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    return {"source": counts(p for p in files if p.suffix in SOURCE),
            "other_artifacts": counts(p for p in files if p.suffix not in SOURCE)}


def source_map(path):
    if path.is_file():
        return {"app.can": path.read_text()}
    files = [p for p in path.rglob("*") if p.is_file() and p.suffix in SOURCE and "__pycache__" not in p.parts]
    # C stage file renaming is a file-layout change; preserve it rather than guess semantic correspondence.
    return {str(p.relative_to(path)): p.read_text() for p in files}


out = {"method": "tiktoken 0.12.0 reference encodings; saved artifact sizes only. Neither exact GPT6 tokens nor full prompt/reasoning/output usage. Context excerpts differ in completeness; no total-task token ratio. Source includes behavior examples/tests; whole snapshots are not newly authored text. No equivalence inferred from counts.",
       "variants": {}, "layout": {}}
for variant in ("C", "D"):
    parent = ROOT / variant
    stages = [("initial", parent / ("initial.can" if variant == "C" else "initial"))]
    stages += [(f"change-{n}", parent / f"change-{n}") for n in range(1, 4)]
    out["variants"][variant] = {name: stage(path) for name, path in stages if path.exists()}
    out["variants"][variant]["saved_context"] = counts(p for p in parent.glob("*context.md"))
    out["variants"][variant]["notes_and_provenance"] = counts(p for p in parent.glob("*") if p.is_file() and p.suffix in {".md", ".json"} and not p.name.endswith("context.md"))
for variant in ("single", "packages"):
    parent = ROOT / "layout" / variant
    out["layout"][variant] = {name: stage(parent / name) for name in ("before", "after") if (parent / name).exists()}
    out["layout"][variant]["saved_context"] = counts(p for p in parent.glob("*context.md"))
    if (parent / "after").exists():
        before, after = source_map(parent / "before"), source_map(parent / "after")
        changes = []
        for file in sorted(set(before) | set(after)):
            if before.get(file) == after.get(file):
                continue
            diff = list(difflib.ndiff(before.get(file, "").splitlines(), after.get(file, "").splitlines()))
            changes.append({"file": file, "added_lines": sum(s.startswith("+ ") for s in diff),
                            "removed_lines": sum(s.startswith("- ") for s in diff)})
        out["layout"][variant]["text_changes"] = changes
out["provider"] = stage(ROOT / "provider")
(Path(__file__).parent / "experiments.json").write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps({"variants": {v: {s: d["source"]["total"] for s, d in rows.items() if "source" in d}
                                  for v, rows in out["variants"].items()},
                  "layout": {v: {s: d["source"]["total"] for s, d in rows.items() if "source" in d}
                             for v, rows in out["layout"].items()}}, indent=2))
