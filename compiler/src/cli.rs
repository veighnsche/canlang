//! Single dispatch for the `can` binary.
//!
//! `can compile|check|lint|fmt|explain|lsp|run|test|build|deploy`,
//! plus `--help`/`--version` and a global `--format=json|text`. Exit codes
//! come from [`crate::exit`]: 0 clean, 10 errors reported, 2 tool failure
//! (warnings alone exit 0; they never block). JSON goes to stdout,
//! progress and tool errors to stderr.
//!
//! [`run`] is the one entry point (argv includes the program name at
//! index 0, mirroring `std::env::args`). [`dispatch`] is the same logic
//! returning captured output so tests never touch real stdio, except that
//! `lsp` returns [`DispatchResult::run_lsp`] for [`run`] to serve and
//! `run|test|build|deploy` spawn the lane-7 producer as a side effect.
//!
//! Analysis status (slice 2a): `check`/`lint`/`compile` load sources and run
//! the [`Analyzer`] hook, whose only implementation is [`StubAnalyzer`]
//! returning empty *complete* results. Real analysis lands in later slices;
//! this module never fabricates diagnostics to look busy.

use crate::diagnostic::DiagnosticResult;
use crate::exit;
use crate::source::SourceDb;
use std::path::Path;

/// Output format for machine/human surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    /// Human text (`path:line:col: severity code message` per diagnostic).
    Text,
    /// Parseable single-binary JSON surfaces.
    Json,
}

/// Captured result of [`dispatch`].
#[derive(Debug, Clone)]
pub struct DispatchResult {
    /// Process exit code from [`crate::exit`] (or a passthrough child code).
    pub code: i32,
    /// Bytes for stdout (empty for tool failures and passthrough children).
    pub stdout: String,
    /// Bytes for stderr (tool errors, never JSON payloads).
    pub stderr: String,
    /// True only for `can lsp`: [`run`] must serve stdio instead of exiting.
    pub run_lsp: bool,
}

impl DispatchResult {
    fn ok_stdout(stdout: String) -> Self {
        Self {
            code: exit::OK,
            stdout,
            stderr: String::new(),
            run_lsp: false,
        }
    }

    fn tool_error(code: &'static str, message: String) -> Self {
        Self {
            code: exit::TOOL_FAILURE,
            stdout: String::new(),
            stderr: format!("error[{code}]: {message}\n"),
            run_lsp: false,
        }
    }
}

/// Analysis hook for `check`/`lint`/`compile`.
///
/// Later slices implement real passes (syntax sibling owns the CST; analysis
/// owns resolve/types/effects). The trait keeps `cli` decoupled from those
/// concrete types: it only sees the shared [`SourceDb`] and returns the
/// shared [`DiagnosticResult`].
pub trait Analyzer {
    /// Analyze every source in `db`, recording all consulted sources.
    fn analyze(&self, db: &SourceDb, tool_version: &str) -> DiagnosticResult;
}

/// Slice-2a analyzer: empty *complete* result, never fake diagnostics.
///
/// Documented as unimplemented analysis, not as a clean bill of health for
/// any particular source: it reports no findings because no pass runs yet.
#[derive(Debug, Default)]
pub struct StubAnalyzer;

impl Analyzer for StubAnalyzer {
    fn analyze(&self, db: &SourceDb, tool_version: &str) -> DiagnosticResult {
        let mut result =
            DiagnosticResult::new(tool_version, crate::LANGUAGE_VERSION, crate::SCHEMA_VERSION);
        result.add_sources(db);
        result.finish();
        result
    }
}

/// Run the CLI against real stdio. `argv[0]` is the program name.
///
/// A closed stdout/stderr pipe (`EPIPE`, e.g. `can check f.can | head`)
/// is ignored rather than panicking; any other I/O error still panics.
pub fn run(argv: &[String]) -> i32 {
    let result = dispatch(argv);
    write_ignoring_broken_pipe(std::io::stdout().lock(), result.stdout.as_bytes(), "stdout");
    write_ignoring_broken_pipe(std::io::stderr().lock(), result.stderr.as_bytes(), "stderr");
    if result.run_lsp {
        return crate::lsp::server::run_stdio();
    }
    result.code
}

fn write_ignoring_broken_pipe(mut sink: impl std::io::Write, bytes: &[u8], name: &'static str) {
    match sink.write_all(bytes).and_then(|()| sink.flush()) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(err) => panic!("failed printing to {name}: {err}"),
    }
}

/// Dispatch without touching real stdio (see module docs for the two
/// documented side effects: none here for `lsp`, child spawn for thin
/// lane-7 entries).
pub fn dispatch(argv: &[String]) -> DispatchResult {
    dispatch_with(argv, &StubAnalyzer)
}

/// [`dispatch`] with an injectable [`Analyzer`]: the test seam for the
/// exit-10 path, unreachable through [`dispatch`] while [`StubAnalyzer`]
/// (empty results) is the only production backend.
pub fn dispatch_with(argv: &[String], analyzer: &dyn Analyzer) -> DispatchResult {
    let args: &[String] = if argv.is_empty() { &[] } else { &argv[1..] };
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(message) => return DispatchResult::tool_error("E7001", message),
    };
    if parsed.help {
        match &parsed.subcommand {
            None => return DispatchResult::ok_stdout(global_help()),
            Some(cmd) if is_known_command(cmd) => {
                return DispatchResult::ok_stdout(command_help(cmd));
            }
            // Unknown commands stay E7001/exit 2 even with --help, matching
            // the non-help path (there is no help text to show for them).
            Some(unknown) => {
                return DispatchResult::tool_error(
                    "E7001",
                    format!("unknown command '{unknown}'; use can --help"),
                );
            }
        }
    }
    if parsed.version {
        return DispatchResult::ok_stdout(format!("can {}\n", tool_version()));
    }
    let Some(cmd) = &parsed.subcommand else {
        return DispatchResult::ok_stdout(global_help());
    };
    match cmd.as_str() {
        "check" | "lint" | "compile" => {
            run_check_like(cmd, &parsed.operands, parsed.format, analyzer)
        }
        "explain" => run_explain(&parsed.operands, parsed.format),
        "fmt" => {
            if parsed.format_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can fmt takes no --format flag".to_string(),
                );
            }
            run_fmt(&parsed.operands, parsed.fmt_check)
        }
        "lsp" => {
            if parsed.format_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can lsp takes no --format flag".to_string(),
                );
            }
            if !parsed.operands.is_empty() {
                return DispatchResult::tool_error(
                    "E7001",
                    "can lsp takes no file arguments; it serves stdio".to_string(),
                );
            }
            DispatchResult {
                code: exit::OK,
                stdout: String::new(),
                stderr: String::new(),
                run_lsp: true,
            }
        }
        "run" | "test" | "build" | "deploy" => {
            if parsed.format_set {
                return DispatchResult::tool_error(
                    "E7001",
                    format!(
                        "can {cmd} takes no can-side flags; everything after the subcommand passes through to can-platform"
                    ),
                );
            }
            let platform_bin = std::env::var("CAN_PLATFORM_BIN").ok();
            run_thin_entry(cmd, &parsed.operands, platform_bin)
        }
        unknown => DispatchResult::tool_error(
            "E7001",
            format!("unknown command '{unknown}'; use can --help"),
        ),
    }
}

/// All subcommands `can` accepts.
fn is_known_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "compile"
            | "check"
            | "lint"
            | "fmt"
            | "explain"
            | "lsp"
            | "run"
            | "test"
            | "build"
            | "deploy"
    )
}

/// Thin lane-7 entries: flag parsing stops at these; everything after is
/// child args passed verbatim to `can-platform`.
fn is_thin_entry(cmd: &str) -> bool {
    matches!(cmd, "run" | "test" | "build" | "deploy")
}

struct ParsedArgs {
    subcommand: Option<String>,
    operands: Vec<String>,
    format: OutputFormat,
    /// Whether `--format` was passed explicitly (rejected for commands
    /// that take no format, rather than silently ignored).
    format_set: bool,
    fmt_check: bool,
    help: bool,
    version: bool,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs {
        subcommand: None,
        operands: Vec::new(),
        format: OutputFormat::Text,
        format_set: false,
        fmt_check: false,
        help: false,
        version: false,
    };
    let mut i = 0;
    let mut flags_done = false;
    while i < args.len() {
        let arg = &args[i];
        if !flags_done && arg == "--" {
            flags_done = true;
            i += 1;
            continue;
        }
        if !flags_done && arg.starts_with('-') && arg.len() > 1 {
            if arg == "--help" || arg == "-h" {
                parsed.help = true;
            } else if arg == "--version" || arg == "-V" {
                parsed.version = true;
            } else if arg == "--check" {
                parsed.fmt_check = true;
            } else if let Some(value) = arg.strip_prefix("--format=") {
                parsed.format = parse_format(value)?;
                parsed.format_set = true;
            } else if arg == "--format" {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --format; want json|text".to_string())?;
                parsed.format = parse_format(value)?;
                parsed.format_set = true;
            } else {
                return Err(format!("unknown flag '{arg}'; use can --help"));
            }
            i += 1;
            continue;
        }
        if parsed.subcommand.is_none() {
            parsed.subcommand = Some(arg.clone());
            if is_thin_entry(arg) {
                // Thin lane-7 entry: stop flag parsing at the subcommand.
                // Everything after passes through verbatim to can-platform
                // (flags, `--`, and all), so `can` never swallows or
                // reinterprets child arguments.
                parsed.operands.extend(args[i + 1..].iter().cloned());
                break;
            }
        } else {
            parsed.operands.push(arg.clone());
        }
        i += 1;
    }
    if parsed.fmt_check && parsed.subcommand.as_deref() != Some("fmt") {
        return Err("--check only applies to can fmt".to_string());
    }
    Ok(parsed)
}

fn parse_format(value: &str) -> Result<OutputFormat, String> {
    match value {
        "json" => Ok(OutputFormat::Json),
        "text" => Ok(OutputFormat::Text),
        other => Err(format!("invalid --format '{other}'; want json|text")),
    }
}

fn tool_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn global_help() -> String {
    format!(
        "can {} — CanLang compiler and authoring tools

Usage: can <COMMAND> [OPTIONS] [ARGS...]
       can --help
       can --version

Commands:
  compile   Check sources (artifact emission lands in slice 4)
  check     Analyze sources and report diagnostics
  lint      Run lint rules over sources (rules land in slice 2b)
  fmt       Check formatting (unimplemented: reports E7005, never false clean)
  explain   Print a diagnostic catalog entry: can explain E1001
  lsp       Run the language server over stdio (Content-Length JSON-RPC)
  run       Thin lane-7 entry: exec can-platform run (passthrough)
  test      Thin lane-7 entry: exec can-platform test (passthrough)
  build     Thin lane-7 entry: exec can-platform build (passthrough)
  deploy    Thin lane-7 entry: exec can-platform deploy (passthrough)

Options:
  --format=json|text   Machine or human output (check, compile, lint, explain)
  -h, --help           Show help (global or `can <COMMAND> --help`)
  -V, --version        Show version

Exit codes: 0 clean, 10 errors reported, 2 tool failure.
",
        tool_version()
    )
}

fn command_help(cmd: &str) -> String {
    match cmd {
        "check" | "lint" | "compile" => format!(
            "can {cmd} — analyze sources and report diagnostics (slice 2a: loads sources, runs the Analyzer hook, emits the DiagnosticResult envelope)\n\nUsage: can {cmd} [--format=json|text] FILE.can...\n\nExit codes: 0 clean, 10 errors reported, 2 tool failure.\n"
        ),
        "explain" => "can explain — print a diagnostic catalog entry\n\nUsage: can explain [--format=json|text] CODE\n\nExit codes: 0 printed, 2 unknown code (E7003) or bad usage.\n".to_string(),
        "fmt" => "can fmt — check formatting (slice 2a: unimplemented)\n\nUsage: can fmt [--check] FILE.can...\n\nAlways reports E7005 until the slice-2b formatter lands; never a false clean.\n".to_string(),
        "lsp" => "can lsp — run the language server over stdio\n\nUsage: can lsp\n\nSpeaks Content-Length JSON-RPC; see the transport module docs.\n".to_string(),
        "run" | "test" | "build" | "deploy" => format!(
            "can {cmd} — thin lane-7 entry (passthrough to can-platform)\n\nUsage: can {cmd} [ARGS...]\n\nExecs `can-platform {cmd}` with argument passthrough when the lane-7\nproducer is installed, else reports missing-producer error E7004.\nEverything after the subcommand passes through verbatim, flags\nincluded (`can {cmd} --help` asks the platform tool; use\n`can --help {cmd}` to see this text). `can` never embeds a second\nplatform engine. Override search with CAN_PLATFORM_BIN. The child\nprocess exit code passes through; a signal-killed child maps to\nexit 2.\n"
        ),
        unknown => format!("unknown command '{unknown}'; use can --help\n"),
    }
}

fn run_check_like(
    cmd: &str,
    operands: &[String],
    format: OutputFormat,
    analyzer: &dyn Analyzer,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {cmd} expects at least one FILE.can operand"),
        );
    }
    let mut db = SourceDb::new();
    for path in operands {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        db.add(path.clone(), text);
    }
    let mut result = analyzer.analyze(&db, tool_version());
    result.finish();
    let code = if result.has_errors() {
        exit::DIAGNOSTICS
    } else {
        exit::OK
    };
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", result.to_json()),
        OutputFormat::Text => result.to_text(&db),
    };
    DispatchResult {
        code,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

fn run_explain(operands: &[String], format: OutputFormat) -> DispatchResult {
    let [code] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can explain expects exactly one CODE operand".to_string(),
        );
    };
    match crate::explain::lookup(code) {
        Some(info) => {
            let stdout = match format {
                OutputFormat::Json => format!("{}\n", crate::explain::entry_to_json(info)),
                OutputFormat::Text => crate::explain::entry_to_text(info),
            };
            DispatchResult::ok_stdout(stdout)
        }
        None => DispatchResult::tool_error(
            "E7003",
            format!(
                "unknown diagnostic code '{}'; known codes: {}",
                code.trim(),
                crate::explain::known_codes().join(", ")
            ),
        ),
    }
}

fn run_fmt(operands: &[String], _check: bool) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can fmt expects at least one FILE.can operand".to_string(),
        );
    }
    // Stub reports unimplemented (E7005), never a false clean.
    DispatchResult::tool_error(
        "E7005",
        "formatter not implemented in slice 2a (needs the lossless CST); refusing to claim clean"
            .to_string(),
    )
}

/// Thin lane-7 entry: exec the platform producer with argument passthrough.
///
/// `platform_bin` overrides PATH search (used by `CAN_PLATFORM_BIN` and by
/// tests). Returns the child's exit code on success (a signal-killed child
/// has no exit code and maps to [`exit::TOOL_FAILURE`]), or an `E7004`
/// missing-producer tool error when the producer is absent/unlaunchable.
/// Never a second engine: unknown subcommands or analysis never happen here.
pub fn run_thin_entry(
    subcommand: &str,
    args: &[String],
    platform_bin: Option<String>,
) -> DispatchResult {
    let bin = match platform_bin {
        Some(path) => path,
        None => match find_on_path("can-platform") {
            Some(path) => path,
            None => {
                return DispatchResult::tool_error(
                    "E7004",
                    format!(
                        "lane-7 producer 'can-platform' not found on PATH for `can {subcommand}`; install it or set CAN_PLATFORM_BIN (see can explain E7004)"
                    ),
                );
            }
        },
    };
    if !Path::new(&bin).is_file() {
        return DispatchResult::tool_error(
            "E7004",
            format!(
                "lane-7 producer '{bin}' is not a file for `can {subcommand}`; install it or fix CAN_PLATFORM_BIN (see can explain E7004)"
            ),
        );
    }
    let mut child_args = Vec::with_capacity(args.len() + 1);
    child_args.push(subcommand.to_string());
    child_args.extend(args.iter().cloned());
    match std::process::Command::new(&bin).args(&child_args).status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(err) => DispatchResult::tool_error(
            "E7004",
            format!("failed to exec lane-7 producer '{bin}': {err}"),
        ),
    }
}

/// Unix-only PATH search: no Windows `PATHEXT` handling, and non-UTF8
/// `PATH` entries convert lossily. Sufficient for lane scope (CI is unix).
fn find_on_path(name: &str) -> Option<String> {
    if name.contains('/') {
        return Path::new(name).is_file().then(|| name.to_string());
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}
