//! Build-time commit hash for `can --version` (VERGEN-free).
//!
//! Sets `CAN_BUILD_COMMIT` to the short git HEAD, or `"unknown"` when git
//! is missing, fails, or the tree has no HEAD (release tarball builds).
//! Watches Git-resolved metadata, including worktree and packed-ref layouts.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if let Some(head) = git_path("HEAD").filter(|path| path.exists()) {
        watch(&head);
        if let Some(target) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
            if let Some(mut path) = git_path(&target) {
                // A packed ref has no loose file. Watch its nearest existing
                // parent so a later commit creating that file also invalidates.
                while !path.exists() {
                    if !path.pop() {
                        break;
                    }
                }
                if path.exists() {
                    watch(&path);
                }
            }
            if let Some(path) = git_path("packed-refs").filter(|path| path.exists()) {
                watch(&path);
            }
        }
    }
    let commit = short_head().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CAN_BUILD_COMMIT={commit}");
}

fn watch(path: &std::path::Path) {
    println!("cargo:rerun-if-changed={}", path.display());
}

fn git_path(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(git_output(&["rev-parse", "--git-path", name])?);
    std::fs::canonicalize(&path)
        .ok()
        .or_else(|| std::env::current_dir().ok().map(|cwd| cwd.join(path)))
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?;
    let sha = sha.trim().to_string();
    if sha.is_empty() {
        return None;
    }
    Some(sha)
}

fn short_head() -> Option<String> {
    git_output(&["rev-parse", "--short", "HEAD"])
}
