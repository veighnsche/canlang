#!/usr/bin/env python3
"""Verify the native server's locked notice inputs for an existing release target."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {"aarch64-apple-darwin", "x86_64-unknown-linux-gnu"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(target, output):
    directory = ROOT / "dev-server/third-party-notices"
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["schema"] != 1 or set(manifest["targets"]) != TARGETS:
        raise ValueError("unsupported development-server notice manifest")
    if set(manifest["inputs"]) != {"dev-server/Cargo.toml", "dev-server/Cargo.lock"}:
        raise ValueError("notice inputs must pin the native server manifest and lock")
    for path, expected in manifest["inputs"].items():
        if digest((ROOT / path).read_bytes()) != expected:
            raise ValueError(f"stale development-server notice input: {path}")
    data = (directory / "THIRD-PARTY-NOTICES.txt").read_bytes()
    if digest(data) != manifest["noticeSha256"]:
        raise ValueError("changed development-server notice content")
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "DEV-SERVER-THIRD-PARTY-NOTICES.txt"
    destination.write_bytes(data)
    print(f"{target}: {len(manifest['targets'][target])} dependencies; {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(TARGETS))
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    prepare(args.target, args.output_dir)
