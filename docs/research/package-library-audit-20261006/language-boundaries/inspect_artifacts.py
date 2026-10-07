#!/usr/bin/env python3
"""Read committed bytes/metadata only; never compile or instantiate Wasm."""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
PIN = sys.argv[1] if len(sys.argv) > 1 else "b40b59e32381465faacb387df4a2ae73b0654b74"
BASE = "packages/values/bindings/generated/"


def read(path):
    return subprocess.check_output(["git", "show", f"{PIN}:{path}"], cwd=ROOT)


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, size):
        assert 0 <= size <= len(self.data) - self.pos, "truncated binary section"
        out = self.data[self.pos:self.pos + size]
        self.pos += size
        return out

    def uint(self):
        value = 0
        for shift in range(0, 35, 7):
            byte = self.take(1)[0]
            value |= (byte & 127) << shift
            if not byte & 128:
                assert value <= 0xFFFFFFFF, "u32 overflow"
                return value
        raise ValueError("invalid u32 encoding")

    def name(self):
        return self.take(self.uint()).decode("utf-8")


def exports(data):
    reader = Reader(data)
    assert reader.take(8) == b"\x00asm\x01\x00\x00\x00", "not Wasm version 1"
    sections, output = [], []
    kinds = {0: "function", 1: "table", 2: "memory", 3: "global", 4: "tag"}
    while reader.pos < len(data):
        kind = reader.take(1)[0]
        payload = reader.take(reader.uint())
        sections.append({"id": kind, "bytes": len(payload)})
        if kind == 7:
            entries = Reader(payload)
            for _ in range(entries.uint()):
                name = entries.name()
                export_kind = entries.take(1)[0]
                output.append({"name": name, "kind": kinds.get(export_kind, str(export_kind)), "index": entries.uint()})
            assert entries.pos == len(payload), "export section trailing bytes"
    return {"format": "Wasm version 1", "sections": sections, "exports": output,
            "limit": "Section/export metadata only; no validation of instructions, types, imports, semantics or runtime."}


manifest = json.loads(read(BASE + "BUILD.json"))
files = []
for name, entry in manifest["files"].items():
    data = read(BASE + name)
    digest = hashlib.sha256(data).hexdigest()
    files.append({"path": BASE + name, "sha256": digest, "bytes": len(data),
                  "manifest_equal": digest == entry["sha256"] and len(data) == entry["bytes"]})
assert len(files) == 4 and all(f["manifest_equal"] for f in files)
print(json.dumps({"source_pin": PIN, "method": "git show, SHA256/size, static binary export-section decode",
                  "runtime_execution": False, "manifest": manifest, "files": files,
                  "binary": exports(read(BASE + "values_semantics_bg.wasm")),
                  "provenance_limit": "BUILD inventory alone has binding filenames but no content/Cargo/semantic source digests. Separate historical source/reproducibility/consumer receipts must be reconciled independently."}, indent=2))
