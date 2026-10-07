"""Disposable independent Cargo consumers; no repository build or Git mutation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "compiler/build.rs"
CARGO = shutil.which("cargo")
RESULTS = []


def run(cwd, *args, env=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True,
                          text=True, capture_output=True).stdout.strip()


def project(path):
    (path / "compiler/src").mkdir(parents=True)
    (path / "compiler/Cargo.toml").write_text(
        '[package]\nname="metadata_probe"\nversion="0.0.0"\nedition="2021"\n')
    (path / "compiler/src/main.rs").write_text(
        'fn main() { println!("{}", env!("CAN_BUILD_COMMIT")); }\n')
    shutil.copyfile(SOURCE, path / "compiler/build.rs")


def git(path, *args):
    return run(path, "git", *args)


def init(path):
    git(path, "init", "-b", "main")
    git(path, "config", "user.email", "probe@example.invalid")
    git(path, "config", "user.name", "Metadata Probe")
    git(path, "config", "core.abbrev", "7")
    git(path, "add", "compiler")
    git(path, "commit", "-m", "initial")


def check(path, label, expected):
    cwd = path / "compiler"
    run(cwd, CARGO, "build", "--offline")
    actual = run(cwd, str(cwd / "target/debug/metadata_probe"))
    assert actual == expected, (label, actual, expected)
    output = next((cwd / "target/debug/build").glob("metadata_probe-*/output"))
    stamp = output.stat().st_mtime_ns
    watches = [line.split("=", 1)[1] for line in output.read_text().splitlines()
               if line.startswith("cargo:rerun-if-changed=")]
    assert all((cwd / watch).exists() for watch in watches), watches
    run(cwd, CARGO, "build", "--offline")
    assert output.stat().st_mtime_ns == stamp, label + ": unchanged rebuild"
    RESULTS.append({"case": label, "expected": expected, "actual": actual,
                    "all_watches_exist": True, "unchanged_build_fresh": True})


with tempfile.TemporaryDirectory(prefix="can-build-metadata-") as tmp:
    base = Path(tmp)
    repo = base / "repo"
    project(repo)
    init(repo)
    first = git(repo, "log", "-1", "--format=%H")
    check(repo, "ordinary", first[:7])
    git(repo, "commit", "--allow-empty", "-m", "advance ordinary branch")
    first = git(repo, "log", "-1", "--format=%H")
    check(repo, "ordinary commit", first[:7])
    git(repo, "pack-refs", "--all", "--prune")
    check(repo, "packed", first[:7])
    git(repo, "commit", "--allow-empty", "-m", "advance packed branch")
    second = git(repo, "log", "-1", "--format=%H")
    assert first != second
    check(repo, "packed to loose commit", second[:7])
    git(repo, "checkout", "--detach", first)
    check(repo, "detached", first[:7])
    git(repo, "checkout", "--detach", second)
    check(repo, "detached move", second[:7])
    worktree = base / "worktree"
    git(repo, "worktree", "add", "-b", "worktree-probe", str(worktree), second)
    check(worktree, "worktree", second[:7])
    git(worktree, "pack-refs", "--all", "--prune")
    check(worktree, "packed worktree", second[:7])
    git(worktree, "commit", "--allow-empty", "-m", "advance worktree")
    third = git(worktree, "log", "-1", "--format=%H")
    check(worktree, "worktree commit", third[:7])
    source = base / "source"
    project(source)
    check(source, "no Git source", "unknown")
    unborn = base / "unborn"
    project(unborn)
    git(unborn, "init", "-b", "main")
    check(unborn, "unborn Git HEAD", "unknown")
    executable = base / "build-script"
    run(base, "rustc", str(SOURCE), "-o", str(executable))
    env = dict(os.environ, PATH="")
    output = run(repo / "compiler", str(executable), env=env)
    assert output.splitlines() == ["cargo:rerun-if-changed=build.rs",
                                   "cargo:rustc-env=CAN_BUILD_COMMIT=unknown"]
    RESULTS.append({"case": "Git unavailable", "actual": "unknown",
                    "only_existing_build_script_watch": True})

print(json.dumps(RESULTS, indent=2))
