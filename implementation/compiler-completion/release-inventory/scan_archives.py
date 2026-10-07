#!/usr/bin/env python3
"""Inventory cached locked archives without downloading or extracting files."""
import hashlib
import json
from pathlib import Path
import re
import tarfile
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = Path.home() / ".cargo/registry/cache"
LICENSE_NAME = re.compile(r"^(?:licen[sc]e|copying|notice)(?:$|[._-])", re.I)


def scan():
    rows = []
    lock = tomllib.loads((ROOT / "compiler/Cargo.lock").read_text())
    for package in lock["package"]:
        if not package.get("source", "").startswith("registry+"):
            continue
        name, version = package["name"], package["version"]
        archives = list(CACHE.glob(f"*/{name}-{version}.crate"))
        assert len(archives) <= 1, f"Ambiguous cached archive: {name} {version}"
        row = {
            "name": name, "version": version,
            "lock_checksum": package["checksum"],
            "archive_present": bool(archives), "archive_sha256": None,
            "checksum_matches": None, "declared_license": None,
            "declared_rust_version": None, "license_notice_files": [],
        }
        if archives:
            archive = archives[0]
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            row.update(archive_sha256=digest,
                       checksum_matches=digest == package["checksum"])
            with tarfile.open(archive, "r:gz") as tar:
                manifest = tar.extractfile(f"{name}-{version}/Cargo.toml")
                metadata = tomllib.loads(manifest.read().decode())["package"]
                row["declared_license"] = metadata.get("license")
                row["declared_rust_version"] = metadata.get("rust-version")
                for member in tar:
                    if member.isfile() and LICENSE_NAME.match(Path(member.name).name):
                        row["license_notice_files"].append({
                            "path": member.name,
                            "sha256": hashlib.sha256(tar.extractfile(member).read()).hexdigest(),
                        })
            row["license_notice_files"].sort(key=lambda entry: entry["path"])
        rows.append(row)
    return {"schema": 1, "package_count": len(rows), "packages": rows}


if __name__ == "__main__":
    inventory = scan()
    (HERE / "manifest.json").write_text(json.dumps(inventory, indent=2) + "\n")
    available = [row for row in inventory["packages"] if row["archive_present"]]
    print(json.dumps({
        "packages": inventory["package_count"], "available": len(available),
        "checksum_matches": sum(row["checksum_matches"] for row in available),
        "without_recognized_license_file": sum(not row["license_notice_files"] for row in available),
        "recognized_license_files": sum(len(row["license_notice_files"]) for row in available),
    }))
