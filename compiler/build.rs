//! Build-time commit hash for `can --version` (VERGEN-free).
//!
//! Sets `CAN_BUILD_COMMIT` to the short git HEAD, or `"unknown"` when git
//! is missing, fails, or the tree has no HEAD (release tarball builds).
//! Rebuilds when `.git/HEAD` or its ref target moves so the hash never
//! goes stale (HEAD alone only changes on branch switch, not new commits).

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Some(target) = head_ref_target() {
        println!("cargo:rerun-if-changed=../.git/{target}");
    }
    let commit = short_head().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CAN_BUILD_COMMIT={commit}");
}

/// Resolve `.git/HEAD` (`ref: refs/heads/x`) to its ref path, if any.
fn head_ref_target() -> Option<String> {
    let head = std::fs::read_to_string("../.git/HEAD").ok()?;
    let head = head.trim();
    let target = head.strip_prefix("ref: ")?;
    if target.is_empty() || !target.contains(['/', '\\']) {
        return None;
    }
    if target.contains("..") {
        return None;
    }
    Some(target.to_string())
}

fn short_head() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
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
