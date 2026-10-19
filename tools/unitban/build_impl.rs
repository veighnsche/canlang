// Shared compile-time unit-test ban (AGENTS.md): unit testing is bureaucracy.
//
// Included by every Rust crate's build script; integration tests live in
// crate-top tests/ only. Fails the build if unit-test markers appear anywhere
// else under the including crate. The whole crate directory is scanned (not
// just src/) because sources live in src/, decisions/, rust/ depending on the
// crate; directories named tests or target are skipped.
fn unitban_visit(dir: &std::path::Path, under_tests: bool, bad: &mut Vec<String>) {
    // Watch every visited directory so newly added files retrigger the ban.
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            if name == "target" {
                continue;
            }
            unitban_visit(&path, under_tests || name == "tests", bad);
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        // Watch every source file so edits retrigger the ban.
        println!("cargo:rerun-if-changed={}", path.display());
        if under_tests {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default();
        if name == "tests.rs" || name.ends_with("_tests.rs") {
            bad.push(format!("{}: test-only module", path.display()));
            continue;
        }
        // Build scripts are allowed (they implement the ban).
        if name == "build.rs" || name == "build_impl.rs" {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            if code.contains("#[test]") || code.contains("cfg(test") {
                bad.push(format!("{}:{}: {}", path.display(), n + 1, code.trim()));
            }
        }
    }
}

fn deny_unit_tests() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let mut bad = Vec::new();
    unitban_visit(std::path::Path::new(&manifest), false, &mut bad);
    assert!(
        bad.is_empty(),
        "unit tests are banned (AGENTS.md); integration tests live in crate-top tests/:\n{}",
        bad.join("\n")
    );
}
