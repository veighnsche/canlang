//! B5/J1 exe hardening: help/version goldens, exit codes, completions
//! snapshot, forced-internal-error behavior, and compile determinism.
//!
//! Every case shells out to the real `can` binary (`CARGO_BIN_EXE_can`),
//! so the panic hook, build-time commit hash, and stdio paths are the
//! shipped ones — not the in-process [`dispatch`] seam.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn can() -> Command {
    Command::new(env!("CARGO_BIN_EXE_can"))
}

fn run(args: &[&str]) -> Output {
    can()
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("spawn can")
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// All 15 subcommands the global help must document.
const ALL_COMMANDS: [&str; 15] = [
    "compile",
    "check",
    "lint",
    "fmt",
    "explain",
    "lsp",
    "policy",
    "docs",
    "run",
    "test",
    "build",
    "deploy",
    "activate",
    "completions",
    "help",
];

#[test]
fn help_golden_documents_everything() {
    for args in [&["--help"][..], &["-h"][..], &[][..]] {
        let output = run(args);
        assert_eq!(output.status.code(), Some(0), "help {args:?}");
        assert!(output.stderr.is_empty(), "help {args:?} wrote stderr");
        let help = stdout_text(&output);
        for cmd in ALL_COMMANDS {
            assert!(help.contains(cmd), "help {args:?} missing {cmd}");
        }
        for token in [
            "CAN_PLATFORM_BIN",
            "CAN_CATALOG",
            "--format=json|text",
            "Exit codes",
            "10 errors reported",
        ] {
            assert!(help.contains(token), "help {args:?} missing {token}");
        }
    }
}

#[test]
fn help_alias_matches_flag_form() {
    let bare = stdout_text(&run(&["--help"]));
    let alias = run(&["help"]);
    assert_eq!(alias.status.code(), Some(0));
    assert_eq!(stdout_text(&alias), bare, "`can help` == `can --help`");
    for cmd in ALL_COMMANDS {
        // Thin entries swallow `--help` into passthrough, so their flag
        // form is `can --help <cmd>`.
        let flag_form = if matches!(cmd, "run" | "test" | "build" | "deploy" | "activate") {
            stdout_text(&run(&["--help", cmd]))
        } else {
            stdout_text(&run(&[cmd, "--help"]))
        };
        let output = run(&["help", cmd]);
        assert_eq!(output.status.code(), Some(0), "can help {cmd}");
        assert_eq!(
            stdout_text(&output),
            flag_form,
            "`can help {cmd}` matches the flag form"
        );
        assert!(flag_form.contains(cmd), "help body for {cmd}");
    }
    let output = run(&["help", "frobnicate"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr_text(&output).contains("E7001"));
}

#[test]
fn version_golden_has_versions_and_commit() {
    for args in [&["--version"][..], &["-V"][..]] {
        let output = run(args);
        assert_eq!(output.status.code(), Some(0), "version {args:?}");
        assert!(output.stderr.is_empty());
        let version = stdout_text(&output);
        assert!(
            version.starts_with("can 0.1.0"),
            "version prefix: {version:?}"
        );
        for token in ["commit ", "language 1.0", "schema 1"] {
            assert!(version.contains(token), "version {args:?} missing {token}");
        }
    }
}

#[test]
fn exit_codes_are_stable() {
    // Unknown command: tool failure.
    let output = run(&["frobnicate"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr_text(&output).contains("E7001"));
    assert!(output.stdout.is_empty());
    // Missing input: unreadable input.
    let output = run(&["check", "does-not-exist.can"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr_text(&output).contains("E7002"));
    // E7005 is a real catalog entry now.
    let output = run(&["explain", "E7005"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert!(stdout_text(&output).contains("internal-error"));
    // Unknown code still E7003 and names the catalog gap filler.
    let output = run(&["explain", "E9999"]);
    assert_eq!(output.status.code(), Some(2));
    let stderr = stderr_text(&output);
    assert!(stderr.contains("E7003"));
    assert!(stderr.contains("E7005"));
    // `lsp` help states its exit codes.
    let output = run(&["lsp", "--help"]);
    assert_eq!(output.status.code(), Some(0));
    let help = stdout_text(&output);
    assert!(help.contains("Exit codes"), "{help}");
    assert!(help.contains('0'), "{help}");
}

#[test]
fn completions_snapshot_matches_shipped_scripts() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for shell in ["bash", "zsh", "fish"] {
        let output = run(&["completions", shell]);
        assert_eq!(output.status.code(), Some(0), "completions {shell}");
        assert!(output.stderr.is_empty());
        let script = stdout_text(&output);
        let shipped = std::fs::read_to_string(manifest.join(format!("can-completions.{shell}")))
            .unwrap_or_else(|_| panic!("compiler/can-completions.{shell} ships"));
        assert_eq!(script, shipped, "completions {shell} drifted from script");
        for cmd in ALL_COMMANDS {
            assert!(script.contains(cmd), "{shell} completions miss {cmd}");
        }
    }
    let output = run(&["completions", "powershell"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr_text(&output).contains("E7001"));
    let output = run(&["completions"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr_text(&output).contains("E7001"));
}

#[test]
fn forced_internal_error_is_e7005_exit_2_without_trace() {
    let output = can()
        .args(["check", "does-not-matter.can"])
        .env("CAN_INTERNAL_TEST_PANIC", "1")
        .stdin(Stdio::null())
        .output()
        .expect("spawn can");
    // Never 101, never a Rust trace: one E7005 tool error on stderr.
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = stderr_text(&output);
    assert!(stderr.contains("error[E7005]"), "{stderr:?}");
    for leak in ["panicked", "stack backtrace", "thread 'main'"] {
        assert!(!stderr.contains(leak), "trace leak {leak:?}: {stderr:?}");
    }
}

/// D05c `docs` goldens: help text, `--out` refusal, and the exit-10
/// no-write path. None of these spawn the platform renderer, so they
/// stay hermetic (no `CAN_PLATFORM_BIN`, no catalog, no network).
#[test]
fn docs_help_golden_names_flags_and_exits() {
    let output = run(&["docs", "--help"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert!(output.stderr.is_empty());
    let help = stdout_text(&output);
    for token in [
        "can docs",
        "--locale=TAG",
        "--out=PATH",
        "--format=json|text",
        "--catalog=PATH",
        "can-platform docs",
        "never overwritten",
        "Exit codes",
        "0 rendered",
        "10 errors reported",
    ] {
        assert!(help.contains(token), "docs help missing {token}: {help}");
    }
}

fn docs_tmpdir(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("can-docs-exe-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("tmpdir");
    dir
}

#[test]
fn docs_out_refuses_can_sources_before_any_work() {
    // Refusal precedes every read and the analysis itself: inputs need
    // not exist, and no file is created anywhere.
    let dir = docs_tmpdir("refuse");
    let out = dir.join("refused.can");
    let output = run(&[
        "docs",
        "--out",
        &out.to_string_lossy(),
        &dir.join("does-not-exist.can").to_string_lossy(),
    ]);
    assert_eq!(output.status.code(), Some(2), "{}", stderr_text(&output));
    assert!(output.stdout.is_empty());
    let stderr = stderr_text(&output);
    assert!(stderr.contains("E7001"), "{stderr}");
    assert!(stderr.contains("refuses"), "{stderr}");
    assert!(!out.exists(), "refused --out must not be created");
    // Same refusal through the input-overwrite path (literal match).
    let input = dir.join("input.can");
    std::fs::write(&input, "app T\nGiven\nWhen\nThen\n").expect("write input");
    let output = run(&[
        "docs",
        &format!("--out={}", input.to_string_lossy()),
        &input.to_string_lossy(),
    ]);
    assert_eq!(output.status.code(), Some(2), "{}", stderr_text(&output));
    let stderr = stderr_text(&output);
    assert!(stderr.contains("E7001"), "{stderr}");
    assert!(stderr.contains("refuses"), "{stderr}");
    assert_eq!(
        std::fs::read_to_string(&input).expect("reread input"),
        "app T\nGiven\nWhen\nThen\n",
        "refused --out must leave the input untouched"
    );
    std::fs::remove_dir_all(&dir).expect("tmpdir cleanup");
}

#[test]
fn docs_broken_source_exits_10_without_writing() {
    let dir = docs_tmpdir("exit10");
    let input = dir.join("broken.can");
    std::fs::write(&input, "this is not {.can syntax !!!\n").expect("write broken fixture");
    let out = dir.join("reference.md");
    let output = run(&[
        "docs",
        "--out",
        &out.to_string_lossy(),
        &input.to_string_lossy(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(10),
        "stdout: {}\nstderr: {}",
        stdout_text(&output),
        stderr_text(&output)
    );
    assert!(!out.exists(), "--out must not be written on analysis failure");
    assert!(
        !stdout_text(&output).is_empty(),
        "exit 10 still reports diagnostics on stdout"
    );
    std::fs::remove_dir_all(&dir).expect("tmpdir cleanup");
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../examples")
        .join(name)
}

fn catalog_arg() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/values/dist/catalog.json")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn compile_twice_is_byte_identical() {
    let input = fixture("ExpenseFlow.can");
    assert!(input.is_file(), "fixture missing: {}", input.display());
    let catalog = format!("--catalog={}", catalog_arg());
    for format in ["--format=json", "--format=text"] {
        let first = run(&["compile", format, &catalog, &input.to_string_lossy()]);
        let second = run(&["compile", format, &catalog, &input.to_string_lossy()]);
        assert_eq!(first.status.code(), second.status.code(), "{format}");
        assert_eq!(first.stdout, second.stdout, "{format} bytes differ");
        assert_eq!(first.stderr, second.stderr, "{format} stderr differs");
        assert!(
            !first.stdout.is_empty() || first.status.code() == Some(2),
            "{format} produced no output at all"
        );
    }
}

fn lsp_frame(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
}

#[test]
fn lsp_eof_and_shutdown_exit_cleanly() {
    use std::io::Write;
    // Immediate EOF: the server exits with the lifecycle code (0).
    let output = can()
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn can lsp")
        .wait_with_output()
        .expect("wait can lsp");
    assert_eq!(output.status.code(), Some(0));
    assert!(!stderr_text(&output).contains("panicked"));
    // initialize → shutdown → exit: graceful 0 with no trace.
    let mut child = can()
        .arg("lsp")
        .env("CAN_CATALOG", Path::new(&catalog_arg()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn can lsp");
    let mut input = child.stdin.take().expect("lsp stdin");
    for body in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}"#,
        r#"{"jsonrpc":"2.0","method":"exit","params":{}}"#,
    ] {
        input.write_all(&lsp_frame(body)).expect("write lsp frame");
    }
    drop(input);
    let output = child.wait_with_output().expect("wait can lsp");
    assert_eq!(output.status.code(), Some(0), "{}", stderr_text(&output));
    assert!(!stderr_text(&output).contains("panicked"));
}
