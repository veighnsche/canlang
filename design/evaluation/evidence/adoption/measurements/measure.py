"""One-shot corpus measurement; not a Can parser or behavior verifier."""
from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import Path
import importlib.metadata
import json
import os
import re

os.environ.setdefault("TIKTOKEN_CACHE_DIR", "/tmp/canlang-eval-tokenizer-20261004/cache")
import tiktoken

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[4]
BASE = ROOT / "design/evaluation/baseline-20261004T041647Z"
SNAP = BASE / "snapshot"
ENCODINGS = {name: tiktoken.get_encoding(name) for name in ("o200k_base", "cl100k_base")}
NAMES = ("production", "description", "translation", "bdd", "comment")


def categories(source):
    """Label source spans by observable notation; do not infer semantic necessity."""
    labels = [0] * len(source)
    offset = 0
    bdd_indent = None
    for line in source.splitlines(keepends=True):
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if stripped.strip() and bdd_indent is not None and indent <= bdd_indent:
            bdd_indent = None
        if re.match(r"(?:export )?(?:fixture|examples)\b", stripped):
            bdd_indent = indent
        category = 3 if bdd_indent is not None else 0
        if category == 0 and stripped.startswith("##"):
            category = 4
        elif category == 0 and stripped.startswith("#"):
            category = 1
        labels[offset:offset + len(line)] = [category] * len(line)
        offset += len(line)
    # Translation suffixes take precedence over their containing line category.
    pos = 0
    while (start := source.find("@{", pos)) >= 0:
        cursor, depth, quoted, escaped = start + 2, 1, False, False
        while cursor < len(source) and depth:
            char = source[cursor]
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
            cursor += 1
        if depth:
            raise ValueError(f"Unclosed translation span at {start}")
        labels[start:cursor] = [2] * (cursor - start)
        pos = cursor
    return labels


def token_partition(source, encoding, labels):
    # Boundary-spanning tokens are assigned to their first UTF-8 byte's category.
    byte_labels = [label for char, label in zip(source, labels)
                   for _ in char.encode("utf-8")]
    counts = Counter()
    cursor = 0
    for token in encoding.encode(source, disallowed_special=()):
        counts[NAMES[byte_labels[cursor]]] += 1
        cursor += len(encoding.decode_single_token_bytes(token))
    assert cursor == len(source.encode("utf-8"))
    return {name: counts[name] for name in NAMES}


def file_group(path):
    rel = path.relative_to(SNAP)
    if path.suffix == ".can":
        if rel.parts[0] == "examples":
            return "example_can"
        return "app_can" if len(rel.parts) == 2 else "shared_can"
    if path.suffix == ".mjs":
        return "handwritten_mjs"
    if rel.parts[0] == "draft" and path.stem.startswith("Can"):
        return "app_requirements_md"
    return "design_or_support_md"


rows = []
patterns = Counter()
pattern_files = defaultdict(set)
exact_lines = Counter()
line_files = defaultdict(set)
identifiers = Counter()
for path in sorted(SNAP.rglob("*")):
    if not path.is_file():
        continue
    source = path.read_text()
    rel = str(path.relative_to(SNAP))
    row = {"path": rel, "group": file_group(path), "bytes": len(path.read_bytes()),
           "lines": len(source.splitlines()), "sha256": sha256(path.read_bytes()).hexdigest(),
           "tokens": {name: len(enc.encode(source, disallowed_special=())) for name, enc in ENCODINGS.items()}}
    if path.suffix == ".can":
        labels = categories(source)
        row["can_token_partition"] = {name: token_partition(source, enc, labels) for name, enc in ENCODINGS.items()}
        production = "".join(char if label == 0 else ("\n" if char == "\n" else " ") for char, label in zip(source, labels))
        # Remove ordinary JSON string contents before lexical pattern counting.
        lexical = re.sub(r'"(?:[^"\\]|\\.)*"', '""', production)
        identifiers.update(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", lexical))
        for pattern in re.findall(r"\b(?:by|delete|display|scope|read|on)=[A-Za-z_][A-Za-z0-9_.]*|\bcan_work\(actor,[A-Za-z0-9_.]+\)", lexical):
            patterns[pattern] += 1
            pattern_files[pattern].add(rel)
        for line in production.splitlines():
            line = line.strip()
            if line:
                exact_lines[line] += 1
                line_files[line].add(rel)
    rows.append(row)

groups = defaultdict(lambda: {"files": 0, "bytes": 0, "lines": 0, "tokens": Counter(), "can_token_partition": defaultdict(Counter)})
for row in rows:
    g = groups[row["group"]]
    g["files"] += 1
    for k in ("bytes", "lines"):
        g[k] += row[k]
    g["tokens"].update(row["tokens"])
    for enc, counts in row.get("can_token_partition", {}).items():
        g["can_token_partition"][enc].update(counts)

by_path = {row["path"]: row for row in rows}
pairs = []
for row in rows:
    if row["group"] == "handwritten_mjs":
        other = by_path[str(Path(row["path"]).with_suffix(".can"))]
        pairs.append({"app": Path(row["path"]).stem, "can_tokens": other["tokens"], "handwritten_mjs_tokens": row["tokens"],
                      "o200k_mjs_over_can": round(row["tokens"]["o200k_base"] / other["tokens"]["o200k_base"], 4)})

manifest = BASE / "SHA256SUMS"
failures = []
for line in manifest.read_text().splitlines():
    expected, rel = line.split("  ", 1)
    if sha256((BASE / rel).read_bytes()).hexdigest() != expected:
        failures.append(rel)
assert not failures
result = {"baseline": BASE.name, "manifest_sha256": sha256(manifest.read_bytes()).hexdigest(),
          "snapshot_hash_mismatches": failures, "tiktoken_version": importlib.metadata.version("tiktoken"),
          "encodings": list(ENCODINGS), "not_actual_gpt6_usage": True,
          "groups": groups, "files": rows, "source_target_pairs": pairs}
OUT.joinpath("corpus.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
repetition = {
    "method": "Lexical occurrences in production category, excluding descriptions, translations, fixtures/examples and comment lines; JSON string contents removed for identifiers/attributes. Counts are not removable obligations or token savings.",
    "identifiers": identifiers.most_common(70),
    "patterns": [{"text": k, "count": n, "files": sorted(pattern_files[k])} for k, n in patterns.most_common()],
    "repeated_lines": [{"text": k, "count": n, "files": sorted(line_files[k])} for k, n in exact_lines.most_common() if n > 1][:100],
}
OUT.joinpath("repetition.json").write_text(json.dumps(repetition, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"files": len(rows), "groups": groups, "top_patterns": patterns.most_common(12)}, indent=2))
