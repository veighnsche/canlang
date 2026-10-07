//! Slice-2a authoring tests: CLI dispatch, explain catalog, LSP transport
//! framing, server version-staleness and thin lane-7 entries.

use canlang_compiler::cli::{self, CatalogAnalyzer, StubAnalyzer, dispatch, dispatch_with};
use canlang_compiler::{exit, lsp};
use std::io::{BufReader, Read};
use std::sync::atomic::{AtomicU32, Ordering};

fn argv(words: &[&str]) -> Vec<String> {
    std::iter::once("can")
        .chain(words.iter().copied())
        .map(str::to_string)
        .collect()
}

static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Write a temp `.can` fixture; removed when the guard drops.
struct TempFile {
    path: std::path::PathBuf,
}

impl TempFile {
    fn new(name: &str, text: &str) -> Self {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("can-authoring-{}-{id}-{name}", std::process::id()));
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

#[test]
fn cli_help_and_version() {
    for args in [argv(&[]), argv(&["--help"]), argv(&["-h"])] {
        let result = dispatch(&args);
        assert_eq!(result.code, 0, "help for {args:?}");
        assert!(result.stderr.is_empty());
        for cmd in [
            "compile", "check", "lint", "fmt", "explain", "lsp", "run", "test", "build", "deploy",
        ] {
            assert!(
                result.stdout.contains(cmd),
                "help missing {cmd} in {args:?}"
            );
        }
    }
    for args in [argv(&["--version"]), argv(&["-V"])] {
        let result = dispatch(&args);
        assert_eq!(result.code, 0);
        assert!(result.stdout.starts_with("can "));
        assert!(!result.stdout.trim().is_empty());
    }
    // M7: exit 10 means errors, not warnings (warnings alone exit 0).
    let help = dispatch(&argv(&["--help"]));
    assert!(
        help.stdout.contains("10 errors reported"),
        "{}",
        help.stdout
    );
    let check_help = dispatch(&argv(&["check", "--help"]));
    assert!(
        check_help.stdout.contains("10 errors reported"),
        "{}",
        check_help.stdout
    );
}

#[test]
fn cli_unknown_command_and_flags_are_tool_failures() {
    let result = dispatch(&argv(&["frobnicate"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stdout.is_empty());
    assert!(result.stderr.contains("E7001"));
    assert!(result.stderr.contains("frobnicate"));

    let result = dispatch(&argv(&["check", "--bogus"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"));

    let result = dispatch(&argv(&["check", "--format=yaml", "x.can"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"));
}

#[test]
fn cli_every_subcommand_answers_help() {
    for cmd in ["compile", "check", "lint", "fmt", "explain", "lsp"] {
        let result = dispatch(&argv(&[cmd, "--help"]));
        assert_eq!(result.code, 0, "help for {cmd}");
        assert!(result.stdout.contains(cmd), "help body for {cmd}");
    }
    // Thin entries pass everything after the subcommand through to
    // can-platform (so `can run --help` asks the platform tool); their
    // own help is reached with the flag before the subcommand.
    for cmd in ["run", "test", "build", "deploy"] {
        let result = dispatch(&argv(&["--help", cmd]));
        assert_eq!(result.code, 0, "help for {cmd}");
        assert!(result.stdout.contains(cmd), "help body for {cmd}");
        assert!(
            result.stdout.contains("passes through verbatim"),
            "passthrough doc for {cmd}"
        );
    }
}

/// Envelope/JSON/determinism mechanics with the deterministic stub
/// backend. (PR4: production `dispatch` runs the real catalog-aware
/// pipeline — `complete=false`, `E6002` without a catalog — so these
/// backend-independent mechanics pin the [`StubAnalyzer`] seam
/// explicitly; real-backend CLI behavior is covered in `tests/analysis.rs`.)
#[test]
fn cli_check_like_commands_emit_envelope_json() {
    let file = TempFile::new("main.can", "app Main\nGiven\nWhen\nThen\n");
    let stub = StubAnalyzer;
    // `compile` and `lint` need a pipeline analyzer (see cli_compile_*
    // below); the stub keeps no checked program, so they report E7001.
    let result = dispatch_with(&argv(&["lint", "--format=json", &file.arg()]), &stub);
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"), "{}", result.stderr);
    for cmd in ["check"] {
        let result = dispatch_with(&argv(&[cmd, "--format=json", &file.arg()]), &stub);
        assert_eq!(result.code, exit::OK, "{cmd} should be clean");
        assert!(result.stderr.is_empty());
        let line = result.stdout.trim_end();
        assert!(!line.contains('\n'), "single-line JSON");
        for field in [
            "\"tool\":\"can\"",
            "\"schema_version\":1",
            "\"language_version\":\"1.0\"",
            "\"complete\":true",
            "\"diagnostics\":[]",
            "\"omitted\":0",
            "main.can",
        ] {
            assert!(line.contains(field), "{cmd} missing {field}: {line}");
        }
        // Deterministic across reruns.
        let again = dispatch_with(&argv(&[cmd, "--format=json", &file.arg()]), &stub);
        assert_eq!(result.stdout, again.stdout);
    }
    // Space-separated --format form and text default.
    let result = dispatch_with(&argv(&["check", "--format", "json", &file.arg()]), &stub);
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.contains("\"diagnostics\":[]"));
    let result = dispatch_with(&argv(&["check", &file.arg()]), &stub);
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.is_empty(), "stub text output is empty");
}

#[test]
fn cli_compile_with_stub_reports_e7001() {
    let file = TempFile::new("main.can", "app Main\nGiven\nWhen\nThen\n");
    let result = dispatch_with(&argv(&["compile", &file.arg()]), &StubAnalyzer);
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stdout.is_empty());
    assert!(result.stderr.contains("E7001"), "{}", result.stderr);
}

#[test]
fn cli_compile_teamtasks_reports_emission_diagnostics() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let catalog = root.join("packages/values/dist/catalog.json");
    if !catalog.exists() {
        eprintln!("SKIP cli_compile_teamtasks: no packages/values/dist/catalog.json");
        return;
    }
    let example = root.join("examples/TeamTasks.can");
    let analyzer = CatalogAnalyzer::new(Some(catalog), None, root);
    let result = dispatch_with(
        &argv(&["compile", "--format=json", &example.to_string_lossy()]),
        &analyzer,
    );
    // TeamTasks checks clean but has unlowerable UI factories: emission
    // diagnostics, exit 10, no artifact.
    assert_eq!(result.code, exit::DIAGNOSTICS, "{}", result.stdout);
    assert!(result.stderr.is_empty());
    assert!(
        result.stdout.contains("\"code\":\"E6008\""),
        "{}",
        result.stdout
    );
}

#[test]
fn cli_check_rejects_missing_operand_and_unreadable_file() {
    let result = dispatch(&argv(&["check"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"));

    let missing =
        std::env::temp_dir().join(format!("can-authoring-{}-missing.can", std::process::id()));
    let result = dispatch(&argv(&["check", &missing.to_string_lossy()]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7002"));
}

#[test]
fn cli_explain_json_shape_and_unknown_code() {
    let result = dispatch(&argv(&["explain", "--format=json", "E1001"]));
    assert_eq!(result.code, exit::OK);
    for field in [
        "\"code\":\"E1001\"",
        "\"title\":",
        "\"severity\":\"error\"",
        "\"explanation\":",
        "\"example_valid\":",
        "\"example_invalid\":",
    ] {
        assert!(result.stdout.contains(field), "missing {field}");
    }
    let result = dispatch(&argv(&["explain", "e7004"]));
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.contains("E7004"));

    let result = dispatch(&argv(&["explain"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"));

    let result = dispatch(&argv(&["explain", "E9999"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7003"));
    assert!(result.stderr.contains("E9999"));
    // Lists known codes so the user can pick one.
    assert!(result.stderr.contains("E1001"));
    assert!(result.stderr.contains("E7004"));

    // E7005 was a retired slice-2a formatter stub; B5/J1 reclaims it as
    // the internal-error code (see `can explain E7005`).
    let result = dispatch(&argv(&["explain", "E7005"]));
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.contains("internal-error"));
}

#[test]
fn cli_fmt_check_clean_and_drift() {
    let clean = TempFile::new("fmt-clean.can", "app F\nGiven\nWhen\nThen\n");
    let result = dispatch(&argv(&["fmt", "--check", &clean.arg()]));
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());

    let drifted = "app F   \nGiven\nWhen\nThen";
    let drift = TempFile::new("fmt-drift.can", drifted);
    let result = dispatch(&argv(&["fmt", "--check", &drift.arg()]));
    assert_eq!(result.code, exit::DIAGNOSTICS);
    assert_eq!(result.stdout.trim(), drift.arg());
    assert!(result.stderr.is_empty());
    // --check writes nothing.
    assert_eq!(std::fs::read_to_string(&drift.path).unwrap(), drifted);
}

#[test]
fn cli_fmt_rewrites_files_in_place() {
    let file = TempFile::new("fmt-write.can", "app F   \nGiven\nWhen\nThen");
    let result = dispatch(&argv(&["fmt", &file.arg()]));
    assert_eq!(result.code, exit::OK, "{}", result.stderr);
    assert_eq!(
        std::fs::read_to_string(&file.path).unwrap(),
        "app F\nGiven\nWhen\nThen\n"
    );
    // Second run is a no-op success.
    let result = dispatch(&argv(&["fmt", "--check", &file.arg()]));
    assert_eq!(result.code, exit::OK);
    assert!(result.stdout.is_empty());
}

#[test]
fn cli_fmt_parse_failure_reports_envelope_and_writes_nothing() {
    let before = "app F\nGiven\n\tTodo {x:int}\nWhen\nThen\n";
    let file = TempFile::new("fmt-bad.can", before);
    for args in [
        argv(&["fmt", "--check", &file.arg()]),
        argv(&["fmt", &file.arg()]),
    ] {
        let result = dispatch(&args);
        assert_eq!(result.code, exit::DIAGNOSTICS, "{args:?}");
        assert!(result.stdout.contains("\"E1003\""), "{}", result.stdout);
        assert!(
            result.stdout.contains("\"diagnostics\""),
            "{}",
            result.stdout
        );
        assert!(result.stderr.is_empty());
    }
    assert_eq!(std::fs::read_to_string(&file.path).unwrap(), before);
}

#[test]
fn cli_fmt_missing_file_is_tool_failure() {
    let file = TempFile::new("fmt-gone.can", "app F\nGiven\nWhen\nThen\n");
    std::fs::remove_file(&file.path).unwrap();
    let result = dispatch(&argv(&["fmt", &file.arg()]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stdout.is_empty());
    assert!(result.stderr.contains("E7002"), "{}", result.stderr);
}

/// Minimal hermetic catalog: the lint fixtures use no builtins, so an
/// empty entry list still loads clean and silences E6002.
const LINT_CATALOG_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "lint-cli-test-0",
  "entries": []
}"#;

const LINT_SCENARIO: &str = "app T\nGiven\n Todo { title:text }\nWhen\n scenario s(task:Todo) by=members\n  do\n   require false\n   set task {title=\"z\"}\nThen\n";

#[test]
fn cli_lint_reports_findings_and_exits_zero() {
    let catalog = TempFile::new("lint-catalog.json", LINT_CATALOG_JSON);
    let file = TempFile::new("lint-find.can", LINT_SCENARIO);
    // Warnings never block: findings print, exit stays 0.
    let result = dispatch(&argv(&["lint", &file.arg(), "--catalog", &catalog.arg()]));
    assert_eq!(result.code, exit::OK, "{}", result.stderr);
    assert!(result.stderr.is_empty());
    assert!(result.stdout.contains("W1001"), "{}", result.stdout);
    let result = dispatch(&argv(&[
        "lint",
        "--format=json",
        &file.arg(),
        "--catalog",
        &catalog.arg(),
    ]));
    assert_eq!(result.code, exit::OK, "{}", result.stderr);
    assert!(result.stdout.contains("\"W1001\""), "{}", result.stdout);
    assert!(
        result.stdout.contains("\"diagnostics\""),
        "{}",
        result.stdout
    );
}

#[test]
fn cli_lint_clean_file_reports_empty_envelope() {
    let catalog = TempFile::new("lint-catalog.json", LINT_CATALOG_JSON);
    let clean = TempFile::new("lint-clean.can", "app F\nGiven\nWhen\nThen\n");
    let result = dispatch(&argv(&[
        "lint",
        "--format=json",
        &clean.arg(),
        "--catalog",
        &catalog.arg(),
    ]));
    assert_eq!(result.code, exit::OK, "{}", result.stderr);
    assert!(
        result.stdout.contains("\"diagnostics\":[]"),
        "{}",
        result.stdout
    );
}

#[test]
fn cli_lint_analysis_errors_exit_10_without_findings() {
    let catalog = TempFile::new("lint-catalog.json", LINT_CATALOG_JSON);
    let bad = TempFile::new(
        "lint-bad.can",
        "app T\nGiven\n Todo { title:nosuchtype }\nWhen\nThen\n",
    );
    let result = dispatch(&argv(&["lint", &bad.arg(), "--catalog", &catalog.arg()]));
    assert_eq!(result.code, exit::DIAGNOSTICS, "{}", result.stdout);
    assert!(!result.stdout.contains("W1001"), "{}", result.stdout);
}

#[test]
fn cli_lint_operand_errors_are_tool_failures() {
    let result = dispatch(&argv(&["lint"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7001"), "{}", result.stderr);
    let missing = std::env::temp_dir().join(format!(
        "can-authoring-{}-lint-missing.can",
        std::process::id()
    ));
    let result = dispatch(&argv(&["lint", &missing.to_string_lossy()]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7002"), "{}", result.stderr);
}

#[test]
fn cli_lsp_returns_stdio_flag() {
    let result = dispatch(&argv(&["lsp"]));
    assert_eq!(result.code, exit::OK);
    assert!(result.run_lsp);
    let result = dispatch(&argv(&["lsp", "extra.can"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(!result.run_lsp);
    assert!(result.stderr.contains("E7001"), "{}", result.stderr);
}

#[test]
fn cli_unknown_command_with_help_is_still_a_tool_failure() {
    // Nit 2: `can <unknown> --help` matches the non-help path (E7001 on
    // stderr, exit 2) instead of printing "unknown command" as help text.
    for args in [
        argv(&["frobnicate", "--help"]),
        argv(&["--help", "frobnicate"]),
    ] {
        let result = dispatch(&args);
        assert_eq!(result.code, exit::TOOL_FAILURE, "{args:?}");
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7001"), "{}", result.stderr);
        assert!(result.stderr.contains("frobnicate"), "{}", result.stderr);
    }
}

#[test]
fn cli_format_flag_rejected_where_it_does_nothing() {
    // Nit 3: --format is silently meaningless for fmt/lsp and for the
    // can-side parsing of thin entries, so it is rejected (E7001 naming
    // the subcommand) rather than accepted-and-ignored.
    for args in [
        argv(&["fmt", "--format=json", "x.can"]),
        argv(&["lsp", "--format=json"]),
        argv(&["--format=json", "run", "prog"]),
    ] {
        let result = dispatch(&args);
        assert_eq!(result.code, exit::TOOL_FAILURE, "{args:?}");
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7001"), "{}", result.stderr);
    }
    let result = dispatch(&argv(&["fmt", "--format=json", "x.can"]));
    assert!(result.stderr.contains("can fmt"), "{}", result.stderr);
    let result = dispatch(&argv(&["lsp", "--format", "json"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("can lsp"), "{}", result.stderr);
    let result = dispatch(&argv(&["--format=json", "test", "suite"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("can test"), "{}", result.stderr);
    // --format AFTER a thin subcommand is child args, not ours; covered
    // by the fixture-platform passthrough test below.
}

#[test]
fn cli_thin_entries_report_missing_producer() {
    for cmd in ["run", "test", "build", "deploy"] {
        let result = cli::run_thin_entry(
            cmd,
            &[],
            Some("/nonexistent-dir-xyz/can-platform".to_string()),
        );
        assert_eq!(result.code, exit::TOOL_FAILURE, "{cmd}");
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7004"), "{cmd}: {}", result.stderr);
        assert!(result.stderr.contains("can-platform"));
        assert!(result.stderr.contains(cmd));
    }
}

/// Serializes the tests that mutate process-global env (`CAN_PLATFORM_*`).
#[cfg(unix)]
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// RAII env guard: sets vars, restores (or removes) them on drop.
#[cfg(unix)]
struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
}

#[cfg(unix)]
impl EnvGuard {
    fn set(pairs: &[(&str, &str)]) -> Self {
        let mut saved = Vec::with_capacity(pairs.len());
        for (key, value) in pairs {
            saved.push((key.to_string(), std::env::var(key).ok()));
            // SAFETY: held under ENV_LOCK, and only tests holding that
            // lock touch process env, so no other thread observes this.
            unsafe { std::env::set_var(key, value) };
        }
        Self { saved }
    }

    fn set_one(&mut self, key: &str, value: &str) {
        if !self.saved.iter().any(|(k, _)| k == key) {
            self.saved.push((key.to_string(), std::env::var(key).ok()));
        }
        // SAFETY: same lock discipline as `set`.
        unsafe { std::env::set_var(key, value) };
    }
}

#[cfg(unix)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, old) in self.saved.drain(..) {
            // SAFETY: same lock discipline as `set`.
            unsafe {
                match old {
                    Some(value) => std::env::set_var(&key, value),
                    None => std::env::remove_var(&key),
                }
            }
        }
    }
}

/// M1+M8: thin entries exec `can-platform {cmd} {args...}` with verbatim
/// passthrough (flags included) through the real `dispatch` + env path,
/// and the child exit code passes through.
#[test]
#[cfg(unix)]
fn cli_thin_entries_passthrough_args_and_exit_codes() {
    use std::os::unix::fs::PermissionsExt;

    let _locked = ENV_LOCK.lock().unwrap();
    let script = TempFile::new(
        "can-platform",
        "#!/bin/sh\necho \"$@\" > \"$CAN_PLATFORM_ARGS_FILE\"\nexit \"${CAN_PLATFORM_EXIT_CODE:-0}\"\n",
    );
    std::fs::set_permissions(&script.path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let capture = TempFile::new("args.txt", "");
    let mut env = EnvGuard::set(&[
        ("CAN_PLATFORM_BIN", &script.arg()),
        ("CAN_PLATFORM_ARGS_FILE", &capture.arg()),
        ("CAN_PLATFORM_EXIT_CODE", "0"),
    ]);

    // Every thin entry forwards `cmd` + verbatim args, flags included.
    for cmd in ["run", "test", "build", "deploy"] {
        let result = dispatch(&argv(&[
            cmd,
            "--bogus",
            "--format=json",
            "prog",
            "--",
            "dash",
        ]));
        assert_eq!(result.code, 0, "{cmd}");
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
        let seen = std::fs::read_to_string(&capture.path).unwrap();
        assert_eq!(
            seen.trim_end(),
            format!("{cmd} --bogus --format=json prog -- dash"),
            "{cmd} argv"
        );
    }
    // `can run --help` asks the platform tool, never `can` itself.
    let result = dispatch(&argv(&["run", "--help"]));
    assert_eq!(result.code, 0);
    let seen = std::fs::read_to_string(&capture.path).unwrap();
    assert_eq!(seen.trim_end(), "run --help");

    // Exit codes pass through, including nonzero.
    env.set_one("CAN_PLATFORM_EXIT_CODE", "42");
    let result = dispatch(&argv(&["test", "suite"]));
    assert_eq!(result.code, 42);
    env.set_one("CAN_PLATFORM_EXIT_CODE", "0");

    // A CAN_PLATFORM_BIN that is not a file is E7004 through dispatch too.
    env.set_one("CAN_PLATFORM_BIN", "/nonexistent-dir-xyz/can-platform");
    let result = dispatch(&argv(&["build", "x"]));
    assert_eq!(result.code, exit::TOOL_FAILURE);
    assert!(result.stderr.contains("E7004"), "{}", result.stderr);
}

/// M8: analyzer returning one error diagnostic, exercising the exit-10
/// path through the `dispatch_with` seam. [`StubAnalyzer`] behavior is
/// unchanged (the envelope-mechanics test above pins it explicitly).
struct ErrorAnalyzer;

impl cli::Analyzer for ErrorAnalyzer {
    fn analyze(
        &self,
        db: &canlang_compiler::source::SourceDb,
        tool_version: &str,
    ) -> canlang_compiler::diagnostic::DiagnosticResult {
        use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
        use canlang_compiler::source::Span;
        let mut result = DiagnosticResult::new(
            tool_version,
            canlang_compiler::LANGUAGE_VERSION,
            canlang_compiler::SCHEMA_VERSION,
        );
        result.add_sources(db);
        let file = db.iter().next().map(|(id, _)| id).expect("one source");
        result.push(Diagnostic::error(
            "E1001",
            "test error".to_string(),
            Span::new(file, 0, 4),
        ));
        result.finish();
        result
    }
}

#[test]
fn cli_check_like_commands_exit_10_on_errors() {
    let file = TempFile::new("bad.can", "app Bad\nGiven\nWhen\nThen\n");
    for cmd in ["check", "lint", "compile"] {
        let result =
            cli::dispatch_with(&argv(&[cmd, "--format=json", &file.arg()]), &ErrorAnalyzer);
        assert_eq!(result.code, exit::DIAGNOSTICS, "{cmd}");
        assert_eq!(result.code, 10, "{cmd}");
        assert!(result.stderr.is_empty());
        assert!(
            result.stdout.contains("\"code\":\"E1001\""),
            "{cmd}: {}",
            result.stdout
        );
        assert!(
            result.stdout.contains("\"severity\":\"error\""),
            "{cmd}: {}",
            result.stdout
        );
    }
    let result = cli::dispatch_with(&argv(&["check", &file.arg()]), &ErrorAnalyzer);
    assert_eq!(result.code, exit::DIAGNOSTICS);
    assert!(result.stdout.contains("bad.can:1:1:"), "{}", result.stdout);
    assert!(
        result.stdout.contains("error E1001 test error"),
        "{}",
        result.stdout
    );
}

/// Reader that yields at most `chunk` bytes per `read` call.
struct Drip<'a> {
    data: &'a [u8],
    pos: usize,
    chunk: usize,
}

impl Read for Drip<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.data.len() {
            return Ok(0);
        }
        let end = (self.pos + self.chunk).min(self.data.len());
        let count = (end - self.pos).min(buf.len());
        buf[..count].copy_from_slice(&self.data[self.pos..self.pos + count]);
        self.pos += count;
        Ok(count)
    }
}

#[test]
fn transport_framing_round_trip_with_split_reads() {
    use lsp::transport as t;
    let bodies: [&[u8]; 3] = [
        br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#,
        "😀 multibyte ✓".as_bytes(),
        br#"[1,{"a":[true,null,"x"]}]"#,
    ];
    let mut wire = Vec::new();
    for body in bodies {
        t::write_message(&mut wire, body).unwrap();
    }
    for chunk in [1, 2, 7] {
        let mut reader = BufReader::new(Drip {
            data: &wire,
            pos: 0,
            chunk,
        });
        for body in bodies {
            let got = t::read_message(&mut reader).unwrap();
            assert_eq!(got.as_deref(), Some(body), "chunk={chunk}");
        }
        assert_eq!(t::read_message(&mut reader).unwrap(), None);
    }
}

#[test]
fn transport_json_values_round_trip() {
    use lsp::transport as t;
    let text = r#"{"id":42,"method":"m","params":{"list":[1,"a",null],"flag":false}}"#;
    let value = t::parse(text).unwrap();
    assert_eq!(value.get("id").and_then(t::Json::as_i64), Some(42));
    assert_eq!(t::parse(&t::render(&value)).unwrap(), value);
    assert!(t::parse("{bad").is_err());
}

#[test]
fn server_publishes_only_current_versions() {
    use lsp::server::{Server, StubAnalysis};
    use lsp::transport as t;

    let mut server = Server::new(StubAnalysis);
    let init = t::parse(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#).unwrap();
    server.handle_json(&init);
    let open = t::parse(
        r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///a.can","languageId":"can","version":1,"text":"app A\n"}}}"#,
    )
    .unwrap();
    server.handle_json(&open);
    for (version, text) in [(2, "app A\nGiven\n"), (3, "app A\nGiven\nWhen\n")] {
        let change = t::parse(&format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/didChange\",\"params\":{{\"textDocument\":{{\"uri\":\"file:///a.can\",\"version\":{version}}},\"contentChanges\":[{{\"text\":{text:?}}}]}}}}"
        ))
        .unwrap();
        server.handle_json(&change);
    }
    // Source-owner replacement prunes stale jobs before numeric IDs remap.
    assert_eq!(server.pending_count(), 1);
    let notes = server.pump();
    // Three versions received; only the current one remains queued/published.
    assert_eq!(notes.len(), 1, "expected one publish: {notes:?}");
    assert!(notes[0].contains("textDocument/publishDiagnostics"));
    assert!(notes[0].contains("\"version\":3"));
    assert!(!notes[0].contains("\"version\":1"));
    assert!(!notes[0].contains("\"version\":2"));
    assert_eq!(server.pending_count(), 0);
}

#[test]
fn server_publishes_nothing_after_close() {
    use lsp::server::{Server, StubAnalysis};
    use lsp::transport as t;

    let mut server = Server::new(StubAnalysis);
    let init = t::parse(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#).unwrap();
    server.handle_json(&init);
    let open = t::parse(
        r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///b.can","languageId":"can","version":1,"text":"app B\n"}}}"#,
    )
    .unwrap();
    server.handle_json(&open);
    let close = t::parse(
        r#"{"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":"file:///b.can"}}}"#,
    )
    .unwrap();
    server.handle_json(&close);
    assert!(server.pump().is_empty());
}

#[test]
fn server_ignores_incremental_only_changes() {
    use lsp::server::{Server, StubAnalysis};
    use lsp::transport as t;

    // Full-text sync only: a change whose every edit carries a `range` is
    // ignored (documented limitation), so no new version is enqueued and
    // the tracked text stays at version 1.
    let mut server = Server::new(StubAnalysis);
    let init = t::parse(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#).unwrap();
    server.handle_json(&init);
    let open = t::parse(
        r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///c.can","languageId":"can","version":1,"text":"app C\n"}}}"#,
    )
    .unwrap();
    server.handle_json(&open);
    assert_eq!(server.pending_count(), 1);
    let incremental = t::parse(
        r#"{"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":"file:///c.can","version":2},"contentChanges":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"text":"X"}]}}"#,
    )
    .unwrap();
    server.handle_json(&incremental);
    assert_eq!(server.pending_count(), 1);
    let notes = server.pump();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("\"version\":1"), "{}", notes[0]);
}

fn collect_can_files(dir: &str, out: &mut Vec<std::path::PathBuf>) {
    let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read corpus dir {dir}: {e}"))
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_can_files(path.to_str().unwrap(), out);
        } else if path.extension().is_some_and(|e| e == "can") {
            out.push(path);
        }
    }
}

/// T5: `can explain` round-trips every code the syntax stage can emit.
///
/// Each E1xxx catalog `example_invalid` is parsed for real (E1002 goes
/// through the bytes entry point, the only site that emits it); every code
/// observed anywhere must resolve via `explain::lookup` and render as JSON
/// and text; and the observed set must equal the catalog E1xxx set, so a new
/// emission site without catalog coverage fails here.
#[test]
fn explain_round_trips_every_emitted_code() {
    use canlang_compiler::explain;
    use canlang_compiler::source::SourceId;
    use canlang_compiler::syntax::{lex_bytes, parse_source};
    use std::collections::BTreeSet;

    let mut seen: BTreeSet<String> = BTreeSet::new();
    for info in explain::all().iter().filter(|i| i.code.starts_with("E1")) {
        if info.code == "E1002" {
            continue;
        }
        let diags = if info.code == "E1008" {
            // The catalog describes API arguments; authored source cannot set base.
            assert_eq!(
                info.example_invalid,
                "syntax::lex_fragment(file, \"a\", u32::MAX, &mut diagnostics)",
            );
            let mut diagnostics = Vec::new();
            let tokens = canlang_compiler::syntax::lex_fragment(
                SourceId(37),
                "a",
                u32::MAX,
                &mut diagnostics,
            );
            assert!(tokens.is_empty());
            assert_eq!(diagnostics.len(), 1);
            diagnostics
        } else {
            parse_source(SourceId(0), info.example_invalid).1
        };
        let codes: Vec<&str> = diags.iter().map(|d| d.code).collect();
        assert!(
            codes.contains(&info.code),
            "example_invalid for {} emitted {codes:?}",
            info.code
        );
        seen.extend(codes.into_iter().map(str::to_string));
    }
    // E1002 (bad UTF-8) is only reachable through the bytes entry point.
    let err = lex_bytes(SourceId(0), b"app \xff\n").unwrap_err();
    assert_eq!(err.code, "E1002");
    seen.insert("E1002".to_string());

    // The shipped corpus parses with zero diagnostics, except the
    // KNOWN_CORPUS_DEFECTS pinned by tests/syntax.rs (mirrored here so
    // the round-trip stays honest while drafts are fixed).
    let mut files = Vec::new();
    collect_can_files("../examples", &mut files);
    collect_can_files("../draft", &mut files);
    assert!(
        files.iter().any(|p| p.ends_with("TeamTasks.can")),
        "examples/TeamTasks.can missing from {files:?}"
    );
    assert!(
        files.iter().any(|p| p.ends_with("ExpenseFlow.can")),
        "examples/ExpenseFlow.can missing from {files:?}"
    );
    assert!(
        files.len() >= 44,
        "expected at least the 44-file corpus, found {}",
        files.len()
    );
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let (_tree, diags) = parse_source(SourceId(0), &text);
        let rel = path.to_string_lossy().replace('\\', "/");
        let known = rel.ends_with("draft/CanShift.can") || rel.ends_with("draft/CanVolunteer.can");
        if known {
            let codes: Vec<_> = diags.iter().map(|d| d.code).collect();
            assert_eq!(
                codes,
                vec!["E1203", "E1203"],
                "{rel} defect shape changed: update the known-defects mirror",
            );
            seen.insert("E1203".to_string());
            continue;
        }
        assert!(
            diags.is_empty(),
            "{} emitted {diags:?}",
            path.to_string_lossy()
        );
    }

    // Every observed code resolves and renders as JSON and text.
    for code in &seen {
        let info =
            explain::lookup(code).unwrap_or_else(|| panic!("emitted {code} has no catalog entry"));
        let json = explain::entry_to_json(info);
        assert!(!json.contains('\n'), "JSON must be single-line: {json}");
        assert!(
            json.contains(&format!("\"code\":\"{code}\"")),
            "JSON missing code: {json}"
        );
        let text = explain::entry_to_text(info);
        assert!(text.contains(code), "text missing code: {text}");
        assert!(text.contains(info.title), "text missing title: {text}");
    }

    // The observed set equals the catalog E1xxx set: no catalog entry is
    // untriggerable and no emitted code is undocumented.
    let catalog: BTreeSet<String> = explain::all()
        .iter()
        .filter(|i| i.code.starts_with("E1"))
        .map(|i| i.code.to_string())
        .collect();
    assert_eq!(seen, catalog, "emitted set must equal catalog E1xxx set");
}

/// Every E1xxx catalog `example_valid` parses with zero diagnostics,
/// including E1002's (valid UTF-8 through the text entry point).
#[test]
fn explain_e1xxx_valid_examples_parse_clean() {
    use canlang_compiler::explain;
    use canlang_compiler::source::SourceId;
    use canlang_compiler::syntax::parse_source;

    for info in explain::all().iter().filter(|i| i.code.starts_with("E1")) {
        let diags = if info.code == "E1008" {
            assert_eq!(
                info.example_valid,
                "syntax::lex_fragment(file, \"a\", u32::MAX - 1, &mut diagnostics)",
            );
            let mut diagnostics = Vec::new();
            let tokens = canlang_compiler::syntax::lex_fragment(
                SourceId(37),
                "a",
                u32::MAX - 1,
                &mut diagnostics,
            );
            assert_eq!(tokens.len(), 1);
            assert_eq!(
                tokens[0].span,
                canlang_compiler::source::Span::new(SourceId(37), u32::MAX - 1, u32::MAX),
            );
            diagnostics
        } else {
            parse_source(SourceId(0), info.example_valid).1
        };
        assert!(
            diags.is_empty(),
            "example_valid for {} emitted {diags:?}",
            info.code
        );
    }
}

#[test]
fn server_reports_method_not_found() {
    use lsp::server::{Server, StubAnalysis};
    use lsp::transport as t;

    let mut server = Server::new(StubAnalysis);
    let init = t::parse(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#).unwrap();
    let responses = server.handle_json(&init);
    assert!(responses[0].contains("semanticTokensProvider"));
    let bad = t::parse(r#"{"jsonrpc":"2.0","id":2,"method":"nope","params":{}}"#).unwrap();
    let responses = server.handle_json(&bad);
    assert_eq!(responses.len(), 1);
    assert!(responses[0].contains("-32601"));
}
