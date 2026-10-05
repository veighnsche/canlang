//! Single dispatch for the `can` binary.
//!
//! `can compile|check|lint|fmt|explain|lsp|policy|run|test|build|deploy|activate|completions|help`,
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
//! Analysis status (PR7): `check` loads sources and runs the
//! [`Analyzer`] hook, whose default implementation is [`CatalogAnalyzer`]
//! (full pipeline over the producer catalog, `complete=true` via the
//! [`check::readiness`] gate). `lint` runs the same analysis, then the
//! [`lint`](crate::lint) driver over the checked program (warnings only,
//! never blocking). `compile` additionally runs the `codegen` emitter
//! over the checked program and prints the artifact. `fmt` formats via
//! the lossless CST ([`format`](crate::format)). [`StubAnalyzer`]
//! remains as the deterministic empty backend behind the
//! [`dispatch_with`] test seam (diagnostics only: it keeps no checked
//! program, so `compile` and `lint` under it report `E7001`); this
//! module never fabricates diagnostics to look busy.

use crate::analysis::catalog::{CATALOG_ENV_VAR, CatalogRequest, load_catalog};
use crate::diagnostic::DiagnosticResult;
use crate::exit;
use crate::source::{SourceDb, SourceId, Span};
use std::path::{Path, PathBuf};

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

    /// Analyze and keep the program and catalog for `can compile`. The
    /// default impl degrades to [`Analyzer::analyze`] with no program:
    /// backends without a pipeline ([`StubAnalyzer`]) cannot compile.
    fn analyze_owned(&self, db: &SourceDb, tool_version: &str) -> OwnedAnalysis {
        OwnedAnalysis {
            program: None,
            catalog: None,
            result: self.analyze(db, tool_version),
        }
    }
}

/// Full compile inputs for `can compile`: the checked program and the
/// loaded catalog alongside the analysis diagnostics.
pub struct OwnedAnalysis {
    /// Checked program (`None` when the backend has no pipeline).
    pub program: Option<crate::analysis::CheckedProgram>,
    /// Loaded producer catalog (`None` when the load failed or the
    /// backend has no pipeline).
    pub catalog: Option<crate::analysis::catalog::Catalog>,
    /// Analysis diagnostics (completeness gate included).
    pub result: DiagnosticResult,
}

/// Deterministic empty backend: empty *complete* result, never fake
/// diagnostics.
///
/// Kept behind the [`dispatch_with`] seam for CLI-mechanics tests; it is
/// not a clean bill of health for any particular source (no pass runs).
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

/// Production analyzer: resolves the producer catalog, then runs parse +
/// resolve + types over every source in `db`.
///
/// Catalog resolution order: the `--catalog` flag value, the
/// `CAN_CATALOG` environment value, `./can-catalog.json`, then
/// `./packages/values/dist/catalog.json` (emitted by `npm run catalog`
/// in `packages/values`). A missing catalog is one precise `E6002`
/// naming every location tried; without a catalog, builtin names do not
/// resolve (each use is `E2001`). The result is `complete=true`: the full
/// pipeline ran (see [`check::readiness`]); emission is PR6+.
#[derive(Debug, Clone, Default)]
pub struct CatalogAnalyzer {
    /// `--catalog PATH` flag value.
    flag: Option<PathBuf>,
    /// `CAN_CATALOG` value, when set (empty values are ignored downstream).
    env: Option<String>,
    /// Working directory anchoring the `./` candidates.
    cwd: PathBuf,
}

impl CatalogAnalyzer {
    /// Analyzer with fully explicit catalog inputs (tests stay hermetic:
    /// no process environment or working directory is consulted).
    pub fn new(flag: Option<PathBuf>, env: Option<String>, cwd: PathBuf) -> Self {
        Self { flag, env, cwd }
    }

    /// Analyzer reading process state: `CAN_CATALOG` and the current
    /// working directory (an unreadable directory falls back to `.`, so
    /// the `./` candidates simply miss and the `E6002` names them).
    pub fn from_process(flag: Option<PathBuf>) -> Self {
        Self {
            flag,
            env: std::env::var(CATALOG_ENV_VAR).ok(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

impl Analyzer for CatalogAnalyzer {
    fn analyze(&self, db: &SourceDb, tool_version: &str) -> DiagnosticResult {
        self.analyze_owned(db, tool_version).result
    }

    fn analyze_owned(&self, db: &SourceDb, tool_version: &str) -> OwnedAnalysis {
        let mut result =
            DiagnosticResult::new(tool_version, crate::LANGUAGE_VERSION, crate::SCHEMA_VERSION);
        result.add_sources(db);
        let files: Vec<SourceId> = db.iter().map(|(id, _)| id).collect();
        // Catalog faults name a file outside the analyzed sources, so
        // they anchor on an empty span at the start of the first source.
        let first = files.first().copied().unwrap_or(SourceId(0));
        let request = CatalogRequest {
            flag: self.flag.as_deref(),
            env: self.env.clone(),
            cwd: &self.cwd,
            primary: Span::new(first, 0, 0),
        };
        let (catalog, load_diags) = load_catalog(&request);
        for diagnostic in load_diags {
            result.push(diagnostic);
        }
        let (program, diags) = crate::analysis::check_program(db, &files, catalog.as_ref());
        for diagnostic in diags {
            result.push(diagnostic);
        }
        let gate = crate::analysis::check::readiness(crate::analysis::check::CompleteInputs::all(
            Span::new(first, 0, 0),
        ));
        result.complete = gate.is_empty();
        for diagnostic in gate {
            result.push(diagnostic);
        }
        result.finish();
        OwnedAnalysis {
            program: Some(program),
            catalog,
            result,
        }
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

/// Dispatch without touching real stdout/stderr (file reads happen
/// here, as do the `fmt` stdin read and in-place writes when operands
/// request them; the module docs cover the remaining side effects:
/// none here for `lsp`, child spawn for thin lane-7 entries).
/// Analysis runs the production [`CatalogAnalyzer`].
pub fn dispatch(argv: &[String]) -> DispatchResult {
    // Pre-parse for the `--catalog` flag only (`parse_args` is pure, and
    // `dispatch_with` parses again authoritatively; on a parse error the
    // flag is `None` and the analyzer goes unused).
    let args: &[String] = if argv.is_empty() { &[] } else { &argv[1..] };
    let flag = parse_args(args)
        .ok()
        .and_then(|parsed| parsed.catalog)
        .map(PathBuf::from);
    let analyzer = CatalogAnalyzer::from_process(flag);
    dispatch_with(argv, &analyzer)
}

/// [`dispatch`] with an injectable [`Analyzer`]: the test seam for CLI
/// mechanics (exit-10 path, envelope shape) with deterministic backends.
/// The injected analyzer fully determines analysis; an argv `--catalog`
/// flag is inert here (production [`dispatch`] threads it into its own
/// [`CatalogAnalyzer`]).
pub fn dispatch_with(argv: &[String], analyzer: &dyn Analyzer) -> DispatchResult {
    // Test-only hook for the panic path (`tests/exe.rs` drives the real
    // binary with this set): no user input panics, so the E7005/exit-2
    // mapping needs a forced fault. Production `main` catches this into
    // `error[E7005]`; in-process callers see the panic itself.
    if std::env::var("CAN_INTERNAL_TEST_PANIC").as_deref() == Ok("1") {
        panic!("forced internal error (CAN_INTERNAL_TEST_PANIC=1)");
    }
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
        return DispatchResult::ok_stdout(version_text());
    }
    let Some(cmd) = &parsed.subcommand else {
        return DispatchResult::ok_stdout(global_help());
    };
    match cmd.as_str() {
        "check" => run_check_like(cmd, &parsed.operands, parsed.format, analyzer),
        "lint" => run_lint(&parsed.operands, parsed.format, parsed.fix, analyzer),
        "compile" => run_compile(&parsed.operands, parsed.format, analyzer),
        "fmt" => {
            if parsed.format_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can fmt takes no --format flag".to_string(),
                );
            }
            if parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can fmt takes no --catalog flag".to_string(),
                );
            }
            run_fmt(&parsed.operands, parsed.fmt_check)
        }
        "explain" => {
            if parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can explain takes no --catalog flag".to_string(),
                );
            }
            run_explain(&parsed.operands, parsed.format)
        }
        "policy" => run_policy(&parsed.operands, parsed.format, analyzer),
        "completions" => {
            if parsed.format_set || parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can completions takes no --format or --catalog flag".to_string(),
                );
            }
            run_completions(&parsed.operands)
        }
        "help" => {
            if parsed.format_set || parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can help takes no --format or --catalog flag".to_string(),
                );
            }
            run_help(&parsed.operands)
        }
        "lsp" => {
            if parsed.format_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can lsp takes no --format flag".to_string(),
                );
            }
            if parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can lsp takes no --catalog flag".to_string(),
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
        "run" | "test" | "build" | "deploy" | "activate" => {
            if parsed.format_set || parsed.catalog_set {
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
            | "policy"
            | "run"
            | "test"
            | "build"
            | "deploy"
            | "activate"
            | "completions"
            | "help"
    )
}

/// Thin lane-7 entries: flag parsing stops at these; everything after is
/// child args passed verbatim to `can-platform`.
fn is_thin_entry(cmd: &str) -> bool {
    matches!(cmd, "run" | "test" | "build" | "deploy" | "activate")
}

struct ParsedArgs {
    subcommand: Option<String>,
    operands: Vec<String>,
    format: OutputFormat,
    /// Whether `--format` was passed explicitly (rejected for commands
    /// that take no format, rather than silently ignored).
    format_set: bool,
    /// `--catalog PATH` flag value (`check`/`lint`/`compile` only).
    catalog: Option<String>,
    /// Whether `--catalog` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    catalog_set: bool,
    fmt_check: bool,
    /// `can lint --fix`: compute machine fixes and report them (JSON
    /// gains a sorted `fixes` array; text gains one `fix` line each).
    fix: bool,
    help: bool,
    version: bool,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs {
        subcommand: None,
        operands: Vec::new(),
        format: OutputFormat::Text,
        format_set: false,
        catalog: None,
        catalog_set: false,
        fmt_check: false,
        fix: false,
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
            } else if arg == "--fix" {
                parsed.fix = true;
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
            } else if let Some(value) = arg.strip_prefix("--catalog=") {
                parsed.catalog = Some(value.to_string());
                parsed.catalog_set = true;
            } else if arg == "--catalog" {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --catalog; want a PATH".to_string())?;
                parsed.catalog = Some(value.clone());
                parsed.catalog_set = true;
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
    if parsed.fix && parsed.subcommand.as_deref() != Some("lint") {
        return Err("--fix only applies to can lint".to_string());
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

/// Short git HEAD captured by `build.rs`, or `"unknown"` for tarball
/// builds without git metadata.
fn build_commit() -> &'static str {
    option_env!("CAN_BUILD_COMMIT").unwrap_or("unknown")
}

/// `can --version`: tool version plus the commit it was built from and
/// the language/diagnostic-schema versions it implements.
fn version_text() -> String {
    format!(
        "can {} (commit {}; language {}; schema {})\n",
        tool_version(),
        build_commit(),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION
    )
}

fn global_help() -> String {
    format!(
        "can {} — CanLang compiler and authoring tools

Usage: can <COMMAND> [OPTIONS] [ARGS...]
       can --help
       can --version

Commands:
  compile   Analyze sources and emit the compile artifact
  check     Analyze sources and report diagnostics
  lint      Run lint rules over sources (warnings only, never blocks)
  fmt       Format sources in place (or check with --check)
  explain   Print a diagnostic catalog entry: can explain E1001
  lsp       Run the language server over stdio (Content-Length JSON-RPC)
  policy    Dump the declared policy surface (roles, policies, operation gates)
  run       Thin lane-7 entry: exec can-platform run (passthrough)
  test      Thin lane-7 entry: exec can-platform test (passthrough)
  build     Thin lane-7 entry: exec can-platform build (passthrough)
  deploy    Thin lane-7 entry: exec can-platform deploy (passthrough)
  activate  Thin lane-7 entry: exec can-platform activate (passthrough)
  completions  Print a shell completion script: can completions bash|zsh|fish
  help      Show help (global or `can help <COMMAND>`)

Options:
  --format=json|text   Machine or human output (check, compile, lint, explain, policy)
  --catalog=PATH       Producer catalog (check, compile, lint, policy; else CAN_CATALOG,
                       ./can-catalog.json, ./packages/values/dist/catalog.json)
  -h, --help           Show help (global or `can <COMMAND> --help`)
  -V, --version        Show version

Environment:
  CAN_CATALOG       Producer catalog path (below --catalog, above ./can-catalog.json)
  CAN_PLATFORM_BIN  Override path to the can-platform binary (run|test|build|deploy|activate)

Exit codes: 0 clean, 10 errors reported, 2 tool failure.
",
        tool_version()
    )
}

fn command_help(cmd: &str) -> String {
    match cmd {
        "check" => format!(
            "can {cmd} — analyze sources and report diagnostics (full pipeline over the producer catalog; result is complete=true)\n\nUsage: can {cmd} [--format=json|text] [--catalog=PATH] FILE.can...\n\nCatalog order: --catalog PATH, CAN_CATALOG, ./can-catalog.json, ./packages/values/dist/catalog.json (emit it with `npm run catalog` in packages/values). Without a catalog, builtin names do not resolve.\n\nExit codes: 0 clean, 10 errors reported, 2 tool failure.\n"
        ),
        "lint" => format!(
            "can {cmd} — analyze sources, then run lint rules over the checked program (recommended rules; warnings/informational only, never blocking)\n\nUsage: can {cmd} [--fix] [--format=json|text] [--catalog=PATH] FILE.can...\n\nAnalysis errors report diagnostics with exit 10 and no lint findings. On a clean analysis the lint findings print as the diagnostic envelope (exit 0: warnings never block). With --fix, machine fixes are computed and reported (JSON gains a sorted `fixes` array; text gains one `fix` line per fix); nothing is written.\n\nExit codes: 0 findings-or-clean, 10 analysis errors reported, 2 tool failure.\n"
        ),
        "compile" => "can compile — analyze sources and emit the compile artifact\n\nUsage: can compile [--format=json|text] [--catalog=PATH] FILE.can...\n\nText lists one emitted module path per line; json prints the artifact envelope. Analysis or emission errors (E6006/E6007/E6008) report diagnostics instead of an artifact.\n\nExit codes: 0 emitted, 10 errors reported, 2 tool failure.\n".to_string(),
        "explain" => "can explain — print a diagnostic catalog entry\n\nUsage: can explain [--format=json|text] CODE\n\nExit codes: 0 printed, 2 unknown code (E7003) or bad usage.\n".to_string(),
        "fmt" => "can fmt — format sources canonically\n\nUsage: can fmt [--check] [FILE.can...|-]\n\nFormats each file in place, writing only files that change. With no operands, or `-`, reads stdin and writes the formatted text to stdout. `--check` writes nothing and lists the files that differ instead. Parse failures print the machine-JSON diagnostic envelope on stdout and write nothing. Exit codes: 0 clean, 10 errors or differences reported, 2 tool failure.\n".to_string(),
        "lsp" => "can lsp — run the language server over stdio\n\nUsage: can lsp\n\nSpeaks Content-Length JSON-RPC; see the transport module docs.\nStdin EOF shuts the server down with the lifecycle exit code; a\nshutdown request followed by the exit notification exits 0, exit\nwithout shutdown exits 1.\n\nExit codes: 0 clean shutdown (shutdown+exit, or stdin EOF), 1 exit without shutdown, 2 tool failure.\n".to_string(),
        "completions" => "can completions — print a shell completion script\n\nUsage: can completions bash|zsh|fish\n\nPrints the completion script for every `can` command, flag and\noperand to stdout; eval it or install it (see docs/install.md).\n\nExit codes: 0 printed, 2 unknown shell or bad usage.\n".to_string(),
        "help" => "can help — show help\n\nUsage: can help [COMMAND]\n\nWith no command, prints the global help (`can --help`). With a\ncommand, prints that command's help (same as `can <COMMAND> --help`,\nexcept run|test|build|deploy|activate pass a trailing `--help`\nthrough to can-platform, so `can help <COMMAND>` — like\n`can --help <COMMAND>` — is the way to see their `can`-side help).\n\nExit codes: 0 printed, 2 unknown command.\n".to_string(),
        "policy" => format!(
            "can {cmd} — dump the declared policy surface (roles, model policies/invariants, operation gates)\n\nUsage: can {cmd} [--format=json|text] [--catalog=PATH] FILE.can...\n\nReads the checked program and prints the policy surface in source order.\nExit codes: 0 clean, 10 errors reported, 2 tool failure.\n"
        ),
        "run" | "test" | "build" | "deploy" | "activate" => format!(
            "can {cmd} — thin lane-7 entry (passthrough to can-platform)\n\nUsage: can {cmd} [ARGS...]\n\nExecs `can-platform {cmd}` with argument passthrough when the lane-7\nproducer is installed, else reports missing-producer error E7004.\nEverything after the subcommand passes through verbatim, flags\nincluded (`can {cmd} --help` asks the platform tool; use\n`can help {cmd}` or `can --help {cmd}` to see this text). `can` never embeds a second\nplatform engine. Override search with CAN_PLATFORM_BIN. The child\nprocess exit code passes through; a signal-killed child maps to\nexit 2.\n"
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

/// `can compile`: full analysis, then codegen emission over the checked
/// program. Operand and input failures follow [`run_check_like`]
/// (`E7001`/`E7002`, exit 2). Analysis errors exit 10 with diagnostics
/// and no emission; emission diagnostics (`E6006`/`E6007`/`E6008`, all
/// error severity) also exit 10 with diagnostics and no artifact.
/// Success prints the artifact: one emitted module path per line as
/// text, the artifact envelope as json.
fn run_compile(
    operands: &[String],
    format: OutputFormat,
    analyzer: &dyn Analyzer,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can compile expects at least one FILE.can operand".to_string(),
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
    let owned = analyzer.analyze_owned(&db, tool_version());
    let mut result = owned.result;
    // First sort covers the early analysis-error return below
    // (`emit_diagnostics` does not sort); the second covers the merged
    // analysis+emission diagnostics. `finish` is an idempotent sort.
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let Some(program) = owned.program else {
        return DispatchResult::tool_error(
            "E7001",
            "can compile needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    let sources = crate::codegen::EmitSources {
        db: &db,
        result: &result,
        catalog: owned.catalog.as_ref(),
        options: crate::codegen::EmitOptions::new(),
    };
    let (artifact, emit_diags) = crate::codegen::emit(&program, &sources);
    for diagnostic in emit_diags {
        result.push(diagnostic);
    }
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", crate::codegen::to_json_string(&artifact)),
        OutputFormat::Text => {
            let mut out = String::new();
            for module in &artifact.modules {
                out.push_str(&module.path);
                out.push('\n');
            }
            for test in &artifact.tests {
                out.push_str(&test.module.path);
                out.push('\n');
            }
            out
        }
    };
    DispatchResult {
        code: exit::OK,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

/// Render diagnostics with exit 10: shared by the analysis-error and
/// emission-error paths of [`run_compile`].
/// Success prints the policy surface: the JSON dump as json, one
/// declaration per line as text (source order).
fn run_policy(
    operands: &[String],
    format: OutputFormat,
    analyzer: &dyn Analyzer,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can policy expects at least one FILE.can operand".to_string(),
        );
    }
    let mut db = SourceDb::new();
    let mut files = Vec::new();
    for path in operands {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        files.push(db.add(path.clone(), text));
    }
    let owned = analyzer.analyze_owned(&db, tool_version());
    let mut result = owned.result;
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let Some(program) = owned.program else {
        return DispatchResult::tool_error(
            "E7001",
            "can policy needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    let dump = crate::policy::policy_dump(&db, &program, &files);
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", crate::policy::policy_dump_json(&dump)),
        OutputFormat::Text => {
            let mut out = String::new();
            for role in &dump.roles {
                out.push_str(&format!("role {}\n", role.canonical));
            }
            for model in &dump.models {
                out.push_str(&format!("model {}\n", model.canonical));
                for policy in &model.policies {
                    out.push_str(&format!("  policy {}={}\n", policy.kind, policy.grantee));
                    if let Some(pred) = &policy.where_predicate {
                        out.push_str(&format!("    where {pred}\n"));
                    }
                }
                for invariant in &model.invariants {
                    out.push_str(&format!("  invariant {}\n", invariant.predicate));
                }
            }
            for op in &dump.operations {
                out.push_str(&format!("operation {} {}\n", op.kind, op.canonical));
                if let Some(by) = &op.by {
                    out.push_str(&format!("  by {by}\n"));
                }
                if let Some(when) = &op.when {
                    out.push_str(&format!("  when {when}\n"));
                }
                for require in &op.requires {
                    out.push_str(&format!("  require {require}\n"));
                }
            }
            out
        }
    };
    DispatchResult {
        code: exit::OK,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

fn emit_diagnostics(
    result: &DiagnosticResult,
    db: &SourceDb,
    format: OutputFormat,
) -> DispatchResult {
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", result.to_json()),
        OutputFormat::Text => result.to_text(db),
    };
    DispatchResult {
        code: exit::DIAGNOSTICS,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
}

/// `can completions bash|zsh|fish`: print the completion script.
/// The scripts ship as `compiler/can-completions.<shell>` and are
/// embedded here so the binary never depends on its install layout;
/// `tests/exe.rs` snapshots the output against the shipped files.
fn run_completions(operands: &[String]) -> DispatchResult {
    let [shell] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can completions expects exactly one SHELL operand (bash|zsh|fish)".to_string(),
        );
    };
    let script = match shell.as_str() {
        "bash" => include_str!("../can-completions.bash"),
        "zsh" => include_str!("../can-completions.zsh"),
        "fish" => include_str!("../can-completions.fish"),
        unknown => {
            return DispatchResult::tool_error(
                "E7001",
                format!("unknown shell '{unknown}'; want bash|zsh|fish"),
            );
        }
    };
    DispatchResult::ok_stdout(script.to_string())
}

/// `can help [COMMAND]`: the alias form of `--help`. With no operand it
/// prints the global help; unknown commands stay E7001/exit 2, matching
/// the `--help` flag path.
fn run_help(operands: &[String]) -> DispatchResult {
    match operands {
        [] => DispatchResult::ok_stdout(global_help()),
        [cmd] if is_known_command(cmd) => DispatchResult::ok_stdout(command_help(cmd)),
        [unknown] => DispatchResult::tool_error(
            "E7001",
            format!("unknown command '{unknown}'; use can --help"),
        ),
        _ => DispatchResult::tool_error(
            "E7001",
            "can help expects at most one COMMAND operand".to_string(),
        ),
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

/// One formatter input: a file (written back in place) or stdin (`dest`
/// is `None`, rendered to stdout).
struct FmtInput {
    /// Display name: the operand path, or `<stdin>`.
    name: String,
    /// Input text as read.
    text: String,
    /// Where formatted output goes in write mode (`None` means stdout).
    dest: Option<PathBuf>,
}

fn run_fmt(operands: &[String], check: bool) -> DispatchResult {
    let mut inputs = Vec::new();
    // No operands formats the stdin filter, mirroring rustfmt/gofmt.
    let resolved: Vec<&str> = if operands.is_empty() {
        vec!["-"]
    } else {
        operands.iter().map(String::as_str).collect()
    };
    let mut stdin_used = false;
    for operand in resolved {
        if operand == "-" {
            if stdin_used {
                return DispatchResult::tool_error(
                    "E7001",
                    "duplicate `-` (stdin) operand".to_string(),
                );
            }
            stdin_used = true;
            match std::io::read_to_string(std::io::stdin()) {
                Ok(text) => inputs.push(FmtInput {
                    name: "<stdin>".to_string(),
                    text,
                    dest: None,
                }),
                Err(err) => {
                    return DispatchResult::tool_error(
                        "E7002",
                        format!("cannot read '<stdin>': {err}"),
                    );
                }
            }
            continue;
        }
        match std::fs::read_to_string(operand) {
            Ok(text) => inputs.push(FmtInput {
                name: operand.to_string(),
                text,
                dest: Some(PathBuf::from(operand)),
            }),
            Err(err) => {
                return DispatchResult::tool_error(
                    "E7002",
                    format!("cannot read '{operand}': {err}"),
                );
            }
        }
    }
    // Format everything before writing anything: a parse failure anywhere
    // reports the aggregated envelope and leaves every file untouched.
    let mut db = SourceDb::new();
    let mut outputs: Vec<String> = Vec::with_capacity(inputs.len());
    let mut result = DiagnosticResult::new(
        tool_version(),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION,
    );
    for input in &inputs {
        let id = db.add(input.name.clone(), input.text.clone());
        match crate::format::format_source(id, &input.text) {
            Ok(formatted) => outputs.push(formatted.text),
            Err(error) => {
                outputs.push(String::new());
                for diagnostic in error.diagnostics {
                    result.push(diagnostic);
                }
            }
        }
    }
    if result.has_errors() {
        result.add_sources(&db);
        result.finish();
        return DispatchResult {
            code: exit::DIAGNOSTICS,
            stdout: format!("{}\n", result.to_json()),
            stderr: String::new(),
            run_lsp: false,
        };
    }
    if check {
        let mut differing = Vec::new();
        for (input, output) in inputs.iter().zip(outputs.iter()) {
            if *output != input.text {
                differing.push(input.name.clone());
            }
        }
        if differing.is_empty() {
            return DispatchResult::ok_stdout(String::new());
        }
        return DispatchResult {
            code: exit::DIAGNOSTICS,
            stdout: format!("{}\n", differing.join("\n")),
            stderr: String::new(),
            run_lsp: false,
        };
    }
    // Each file writes atomically (temp file in the same directory,
    // then rename): a failure aborts with E7007 and the failed file keeps
    // its old bytes. Earlier files in the same invocation may already be
    // rewritten; operands are still processed in order.
    let mut stdout = String::new();
    for (input, output) in inputs.iter().zip(outputs.iter()) {
        match &input.dest {
            None => stdout.push_str(output),
            Some(path) => {
                if *output != input.text
                    && let Err(err) = write_file_atomic(path, output)
                {
                    return DispatchResult::tool_error(
                        "E7007",
                        format!("cannot write '{}': {err}", path.display()),
                    );
                }
            }
        }
    }
    DispatchResult::ok_stdout(stdout)
}

/// Write `bytes` to `path` atomically: a same-directory temp file holds
/// the new bytes until `rename` swaps them in, so a crash or full disk
/// leaves the old file (or nothing new) rather than a torn write.
fn write_file_atomic(path: &Path, bytes: &str) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fmt".to_string());
    let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
    let tmp_name = format!(".{file_name}.tmp-{}-{seq}", std::process::id());
    let tmp = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(&tmp_name));
    if let Err(err) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// `can lint`: full analysis, then the lint driver over the checked
/// program. Operand and input failures follow [`run_check_like`]
/// (`E7001`/`E7002`, exit 2). Analysis errors exit 10 with diagnostics
/// and no lint findings (one signal per run; the LSP server merges
/// both instead, since editor buffers are always mid-edit). On a
/// clean analysis the lint findings (recommended rules;
/// warnings/informational only) print as the diagnostic envelope
/// with exit 0 — warnings never block.
///
/// With `fix` (`--fix`), machine fixes are computed and reported:
/// JSON gains a sorted `fixes` array (see [`crate::lint::driver`]
/// fix-JSON shape), text gains one `fix` line per fix. Without `fix`
/// the output path is untouched and byte-identical to before. Nothing
/// is ever written: `--fix` reports, the agent applies.
fn run_lint(
    operands: &[String],
    format: OutputFormat,
    fix: bool,
    analyzer: &dyn Analyzer,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can lint expects at least one FILE.can operand".to_string(),
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
    let owned = analyzer.analyze_owned(&db, tool_version());
    let mut result = owned.result;
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
    let Some(program) = owned.program else {
        return DispatchResult::tool_error(
            "E7001",
            "can lint needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    let config = crate::lint::LintConfig {
        enabled: crate::lint::RuleSet::recommended(),
        fix,
        deprecated: owned
            .catalog
            .as_ref()
            .map(crate::lint::DeprecatedSet::from_catalog),
    };
    for finding in crate::lint::lint_program(&program, &db, &config) {
        result.push(finding);
    }
    result.finish();
    let fixes = crate::lint::collect_fixes(&program, &db, &config);
    let stdout = match format {
        OutputFormat::Json => {
            let envelope = result.to_json();
            if !fix {
                format!("{envelope}\n")
            } else {
                // The envelope always ends with `}`; splice the sorted
                // fixes array in as the final key.
                let mut with_fixes = envelope;
                with_fixes.pop();
                with_fixes.push_str(",\"fixes\":");
                with_fixes.push_str(&crate::lint::driver::fixes_to_json(&fixes));
                with_fixes.push_str("}\n");
                with_fixes
            }
        }
        OutputFormat::Text => {
            let mut text = result.to_text(&db);
            if fix {
                use crate::source::LineIndex;
                for lint_fix in &fixes {
                    let (path, line, col) = match db.get(lint_fix.file) {
                        Some(source) => {
                            let index = LineIndex::new(&source.text);
                            let (line, col) = index.line_col(&source.text, lint_fix.span.start);
                            (source.path.as_str(), line, col)
                        }
                        None => ("<unknown>", 1, 1),
                    };
                    text.push_str(&format!(
                        "{path}:{line}:{col}: fix {} {}\n",
                        lint_fix.rule, lint_fix.title
                    ));
                }
            }
            text
        }
    };
    DispatchResult {
        code: exit::OK,
        stdout,
        stderr: String::new(),
        run_lsp: false,
    }
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
