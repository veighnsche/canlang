//! Build-time commit hash for `can --version` (VERGEN-free).
//!
//! Sets `CAN_BUILD_COMMIT` to the short git HEAD, or `"unknown"` when git
//! is missing, fails, or the tree has no HEAD (release tarball builds).
//! Rebuilds when `.git/HEAD` moves so the hash never goes stale.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    let commit = short_head().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=CAN_BUILD_COMMIT={commit}");
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
