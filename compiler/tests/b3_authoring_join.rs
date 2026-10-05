//! B3 I3: authoring join demo through the REAL `can` binary.
//!
//! One chained run over `tests/data/AuthoringDemo.can` (intentionally
//! sloppy-but-valid: the committed fixture keeps its drift so the fmt leg
//! always has something to fix; the test mutates a temp copy only):
//!
//! 1. `can fmt --check` fails (exit 10) -> `can fmt` rewrites -> `--check`
//!    passes, and the byte diff is whitespace-only.
//! 2. `can lsp` `initialize` advertises rename + completion + codeAction
//!    providers; `didOpen` the formatted text.
//! 3. `rename` on a use-site of `label` yields exactly 3 edits (decl + both
//!    uses); applied client-side, `didChange` republishes zero E-diagnostics.
//! 4. `completion` in expression scope offers the visible bindings.
//! 5. `codeAction` on the `?.` site yields exactly the safe I1002 fix, and
//!    `can lint --fix` (I4) reports the same fix — both paths agree on the
//!    bytes; after applying, `can lint` is quiet, `can check` is clean,
//!    `can fmt --check` stays clean, and the LSP range reports no actions.
//!
//! Catalog: the real `packages/values/dist/catalog.json` when present,
//! else a temp empty catalog (the fixture uses no builtins, so both load
//! clean and silence E6002). `CAN_CATALOG` is set for the LSP child,
//! which takes no `--catalog` flag.

#[path = "common/lsp_driver.rs"]
mod lsp_driver;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

/// Repo root (`compiler/../`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Path of the real `can` binary (built by `cargo build`/`cargo test`).
fn can_binary() -> PathBuf {
    option_env!("CARGO_BIN_EXE_can")
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/can"))
}

fn fixture_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join("AuthoringDemo.can")
}

static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Temp working copy of the fixture; removed when the guard drops.
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn copy_of(name: &str, text: &str) -> Self {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("can-b3-i3-{}-{id}-{name}", std::process::id()));
        std::fs::write(&path, text).unwrap();
        Self { path }
    }

    fn arg(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Minimal catalog that loads clean: the fixture uses no builtins, so an
/// empty entry list silences E6002 (same trick as `tests/authoring.rs`).
const EMPTY_CATALOG_JSON: &str =
    "{\"language_version\":\"1.0\",\"catalog_version\":\"b3-i3-empty-0\",\"entries\":[]}";

/// Real catalog when the producer emitted it, else a temp empty catalog
/// (hermetic: the fixture uses no builtins). The temp guard is returned
/// alongside so it outlives the test.
fn ensure_catalog(root: &Path) -> (PathBuf, Option<TempFile>) {
    let real = root
        .join("packages")
        .join("values")
        .join("dist")
        .join("catalog.json");
    if real.exists() {
        return (real, None);
    }
    let empty = TempFile::copy_of("empty-catalog.json", EMPTY_CATALOG_JSON);
    eprintln!(
        "B3-I3: no producer catalog; using empty catalog {}",
        empty.arg()
    );
    (empty.path.clone(), Some(empty))
}

/// 0-based LSP `(line, character)` of a byte `offset` (ASCII fixture, so
/// UTF-16 columns equal byte columns).
fn offset_to_position(text: &str, offset: usize) -> (u32, u32) {
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (i, byte) in text.bytes().enumerate() {
        if i >= offset {
            break;
        }
        if byte == b'\n' {
            line += 1;
            line_start = i + 1;
        }
    }
    (line, (offset - line_start) as u32)
}

/// Replace whole-word `word` with `replacement` (`label` must not match
/// inside a longer identifier).
fn replace_word(text: &str, word: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i < bytes.len() {
        if text[i..].starts_with(word)
            && (i == 0 || !is_word(bytes[i - 1]))
            && (i + word.len() == bytes.len() || !is_word(bytes[i + word.len()]))
        {
            out.push_str(replacement);
            i += word.len();
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

/// Count whole-word occurrences of `word`.
fn count_word(text: &str, word: &str) -> usize {
    let bytes = text.as_bytes();
    let mut count = 0usize;
    let mut i = 0usize;
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i + word.len() <= bytes.len() {
        if text[i..].starts_with(word)
            && (i == 0 || !is_word(bytes[i - 1]))
            && (i + word.len() == bytes.len() || !is_word(bytes[i + word.len()]))
        {
            count += 1;
            i += word.len();
        } else {
            i += 1;
        }
    }
    count
}

fn run_can(args: &[String]) -> std::process::Output {
    Command::new(can_binary())
        .args(args)
        .output()
        .expect("spawn real can binary")
}

/// Extract the first fix's `(start, end, replacement)` from
/// `can lint --fix --format=json` output (I4 fix-JSON shape).
fn parse_first_fix_span(stdout: &str) -> (usize, usize, String) {
    let span_key = "\"span\":{\"start\":";
    let span_at = stdout
        .find(span_key)
        .unwrap_or_else(|| panic!("no fix span in: {stdout}"));
    let rest = &stdout[span_at + span_key.len()..];
    let start: usize = rest
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let end_key = "\"end\":";
    let end_at = rest.find(end_key).unwrap();
    let end: usize = rest[end_at + end_key.len()..]
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let repl_key = "\"replacement\":\"";
    let repl_at = stdout.find(repl_key).unwrap();
    let repl_rest = &stdout[repl_at + repl_key.len()..];
    let replacement = repl_rest[..repl_rest.find('"').unwrap()].to_string();
    (start, end, replacement)
}

#[test]
fn authoring_join_demo() {
    let root = repo_root();
    let (catalog, _catalog_guard) = ensure_catalog(&root);
    run_join_demo(&catalog);
}

/// The same chain against a forced-empty catalog: proves the hermetic CI
/// path (no producer catalog) rather than trusting the fallback.
#[test]
fn authoring_join_demo_empty_catalog() {
    let empty = TempFile::copy_of("empty-catalog.json", EMPTY_CATALOG_JSON);
    run_join_demo(&empty.path);
}

fn run_join_demo(catalog: &Path) {
    let sloppy =
        std::fs::read_to_string(fixture_source()).expect("read tests/data/AuthoringDemo.can");
    assert!(
        sloppy.contains("task?.title"),
        "fixture keeps its I1002 site"
    );
    assert_eq!(
        count_word(&sloppy, "label"),
        3,
        "fixture keeps decl + 2 uses of label"
    );
    let catalog_arg = format!("--catalog={}", catalog.display());
    // The LSP child takes no --catalog flag: it resolves via CAN_CATALOG.
    // Both join tests write this; a crossed value is harmless because
    // every value written is a catalog both chains accept.
    unsafe {
        std::env::set_var("CAN_CATALOG", catalog);
    }
    let work = TempFile::copy_of("AuthoringDemo.can", &sloppy);

    // --- Leg 1: fmt through the real binary. ---
    let check_before = run_can(&["fmt".to_string(), "--check".to_string(), work.arg()]);
    assert_eq!(
        check_before.status.code(),
        Some(10),
        "fmt --check must fail on the sloppy fixture: {}",
        String::from_utf8_lossy(&check_before.stderr)
    );
    assert!(
        String::from_utf8_lossy(&check_before.stdout).contains("AuthoringDemo.can"),
        "--check must list the drifted file"
    );
    let fmt_run = run_can(&["fmt".to_string(), work.arg()]);
    assert_eq!(
        fmt_run.status.code(),
        Some(0),
        "fmt must rewrite: {}",
        String::from_utf8_lossy(&fmt_run.stderr)
    );
    let formatted = std::fs::read_to_string(&work.path).unwrap();
    assert_ne!(formatted, sloppy, "fmt must change the sloppy bytes");
    let squeeze = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    assert_eq!(
        squeeze(&formatted),
        squeeze(&sloppy),
        "fmt diff must be whitespace-only"
    );
    let check_after = run_can(&["fmt".to_string(), "--check".to_string(), work.arg()]);
    assert_eq!(
        check_after.status.code(),
        Some(0),
        "fmt --check passes after fmt"
    );
    assert!(
        check_after.stdout.is_empty(),
        "clean --check prints nothing"
    );
    // The formatted text keeps every later leg's site.
    assert!(formatted.contains("task?.title"), "{formatted}");
    assert_eq!(count_word(&formatted, "label"), 3, "{formatted}");

    // --- Leg 2: LSP initialize + didOpen. ---
    let uri = "file:///AuthoringDemo.can";
    let mut driver = lsp_driver::LspDriver::spawn().expect("spawn can lsp");
    let init = driver.initialize().expect("initialize");
    for provider in ["renameProvider", "completionProvider", "codeActionProvider"] {
        assert!(init.contains(provider), "missing {provider}: {init}");
    }
    driver.did_open(uri, 1, &formatted).expect("didOpen");

    // --- Leg 3: rename on a use-site of `label` -> `caption`. ---
    let use_site = formatted
        .find("return label")
        .expect("return-site use of label")
        + "return ".len()
        + 1;
    let (rename_line, rename_char) = offset_to_position(&formatted, use_site);
    let rename = driver
        .rename(uri, rename_line, rename_char, "caption")
        .expect("rename");
    assert_eq!(
        rename.matches("\"newText\":\"caption\"").count(),
        3,
        "rename must cover decl + both uses: {rename}"
    );
    let renamed = replace_word(&formatted, "label", "caption");
    assert_eq!(count_word(&renamed, "caption"), 3);
    assert_eq!(count_word(&renamed, "label"), 0);
    driver.did_change(uri, 2, &renamed).expect("didChange");

    // --- Leg 4: completion in expression scope (renamed text). ---
    let complete_at = renamed.find("return caption").expect("renamed return") + "return ".len();
    let (complete_line, complete_char) = offset_to_position(&renamed, complete_at);
    let completion = driver
        .completion(uri, complete_line, complete_char)
        .expect("completion");
    for expected in [
        "\"label\":\"task\"",
        "\"label\":\"caption\"",
        "\"label\":\"and\"",
    ] {
        assert!(
            completion.contains(expected),
            "missing {expected}: {completion}"
        );
    }
    // The open + rename republishes were buffered aside; neither may
    // carry an error diagnostic.
    let notifications = driver.take_notifications();
    assert!(
        notifications
            .iter()
            .any(|n| n.contains("publishDiagnostics") && n.contains("\"version\":2")),
        "expected a version-2 republish, got: {notifications:?}"
    );
    for notification in &notifications {
        if notification.contains("publishDiagnostics") {
            assert!(
                !notification.contains("\"severity\":1"),
                "zero E-diagnostics on republish: {notification}"
            );
        }
    }

    // --- Leg 5a: codeAction on the `?.` site yields exactly the safe fix. ---
    let fix_offset = renamed.find("?.").expect("I1002 site survives rename");
    let (fix_line, fix_char) = offset_to_position(&renamed, fix_offset);
    let actions = driver
        .code_action(uri, (fix_line, fix_char), (fix_line, fix_char + 2))
        .expect("codeAction");
    assert_eq!(
        actions.matches("\"title\":").count(),
        1,
        "exactly the safe fix: {actions}"
    );
    assert!(actions.contains("redundant"), "{actions}");
    assert!(actions.contains("\"newText\":\".\""), "{actions}");

    // --- Leg 5b: `can lint --fix` reports the same fix; both paths agree. ---
    std::fs::write(&work.path, &renamed).unwrap();
    let lint_fix = run_can(&[
        "lint".to_string(),
        "--fix".to_string(),
        "--format=json".to_string(),
        catalog_arg.clone(),
        work.arg(),
    ]);
    assert_eq!(
        lint_fix.status.code(),
        Some(0),
        "lint --fix exits 0: {}",
        String::from_utf8_lossy(&lint_fix.stderr)
    );
    let lint_fix_stdout = String::from_utf8_lossy(&lint_fix.stdout).into_owned();
    assert!(lint_fix_stdout.contains("\"fixes\":["), "{lint_fix_stdout}");
    assert!(
        lint_fix_stdout.contains("\"rule\":\"redundant-null-marker\""),
        "{lint_fix_stdout}"
    );
    assert!(
        lint_fix_stdout.contains("\"replacement\":\".\""),
        "{lint_fix_stdout}"
    );
    let (start, end, replacement) = parse_first_fix_span(&lint_fix_stdout);
    let mut via_cli = renamed.clone();
    via_cli.replace_range(start..end, &replacement);
    let via_lsp = renamed.replacen("?.", ".", 1);
    assert_eq!(via_cli, via_lsp, "CLI fix and codeAction must agree");
    assert_eq!(via_cli.matches("?.").count(), 0);

    // --- Leg 6: apply the fix; lint quiet, check clean, fmt clean. ---
    std::fs::write(&work.path, &via_cli).unwrap();
    let lint = run_can(&[
        "lint".to_string(),
        "--format=json".to_string(),
        catalog_arg.clone(),
        work.arg(),
    ]);
    assert_eq!(lint.status.code(), Some(0));
    let lint_stdout = String::from_utf8_lossy(&lint.stdout).into_owned();
    assert!(!lint_stdout.contains("I1002"), "{lint_stdout}");
    let check = run_can(&[
        "check".to_string(),
        "--format=json".to_string(),
        catalog_arg.clone(),
        work.arg(),
    ]);
    assert_eq!(
        check.status.code(),
        Some(0),
        "check clean: {}",
        String::from_utf8_lossy(&check.stderr)
    );
    assert!(
        String::from_utf8_lossy(&check.stdout).contains("\"diagnostics\":[]"),
        "{}",
        String::from_utf8_lossy(&check.stdout)
    );
    let fmt_clean = run_can(&["fmt".to_string(), "--check".to_string(), work.arg()]);
    assert_eq!(fmt_clean.status.code(), Some(0), "fix keeps fmt clean");
    driver
        .did_change(uri, 3, &via_cli)
        .expect("didChange fixed");
    let no_actions = driver
        .code_action(uri, (fix_line, fix_char), (fix_line, fix_char + 2))
        .expect("codeAction after fix");
    assert!(no_actions.contains("\"result\":[]"), "{no_actions}");

    // --- Leg 7: clean shutdown. ---
    let status = driver.shutdown().expect("shutdown");
    assert!(status.success(), "lsp exit clean: {status}");
}

/// Hermetic guard (no catalog, no binary): the committed fixture parses
/// clean with full coverage, so the corpus tests stay green.
#[test]
fn fixture_parses_clean_in_process() {
    let sloppy =
        std::fs::read_to_string(fixture_source()).expect("read tests/data/AuthoringDemo.can");
    let (tree, diags) =
        canlang_compiler::syntax::parse_source(canlang_compiler::source::SourceId(0), &sloppy);
    assert!(diags.is_empty(), "{diags:?}");
    assert!(tree.verify_coverage(sloppy.len() as u32).is_ok());
}
