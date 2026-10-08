#!/usr/bin/env python3
"""Verify the frozen compiler notice inputs and copy the selected release text."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

TARGETS = ("aarch64-apple-darwin", "x86_64-unknown-linux-gnu")
ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(target, output):
    notices = ROOT / "compiler/third-party-notices"
    manifest = json.loads((notices / "manifest.json").read_text())
    if (not isinstance(manifest, dict)
            or type(manifest.get("schema")) is not int
            or manifest["schema"] != 1
            or not isinstance(manifest.get("targets"), dict)
            or set(manifest["targets"]) != set(TARGETS)):
        raise ValueError("unsupported notice manifest schema or targets")
    inputs = manifest["inputs"]
    if not isinstance(inputs, dict) or set(inputs) != {"compiler/Cargo.toml", "compiler/Cargo.lock"}:
        raise ValueError("notice manifest must pin compiler manifest and lock")
    for path, expected in inputs.items():
        if digest(ROOT / path) != expected:
            raise ValueError(f"stale notice inputs: {path}")
    # Check both frozen bundles so a partial or stale manifest fails closed.
    contents = {}
    for triple in TARGETS:
        entry = manifest["targets"][triple]
        name = f"THIRD-PARTY-NOTICES-{triple}.txt"
        if not isinstance(entry, dict) or entry["file"] != name:
            raise ValueError(f"invalid notice entry: {triple}")
        contents[triple] = (notices / name).read_bytes()
        if hashlib.sha256(contents[triple]).hexdigest() != entry["sha256"]:
            raise ValueError(f"changed notice content: {triple}")
    data = contents[target]
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "THIRD-PARTY-NOTICES.txt"
    destination.write_bytes(data)
    print(f"{target}: {hashlib.sha256(data).hexdigest()}  {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=TARGETS, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        prepare(args.target, args.output_dir)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"compiler release notices rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
