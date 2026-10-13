//! Single dispatch for the `can` binary.
//!
//! `can compile|check|lint|fmt|explain|lsp|policy|docs|run|test|build|deploy|activate|dev|gen|completions|help`,
//! plus `--help`/`--version` and a global `--format=json|text`. Exit codes
//! come from [`crate::exit`]: 0 clean, 10 errors reported, 2 tool failure
//! (warnings alone exit 0; they never block). JSON goes to stdout,
//! progress and tool errors to stderr.
//!
//! [`run`] is the one entry point (argv includes the program name at
//! index 0, mirroring `std::env::args`). [`dispatch`] is the same logic
//! returning captured output so tests never touch real stdio, except that
//! `lsp` returns [`DispatchResult::run_lsp`] for [`run`] to serve,
//! `run|test|build|deploy|activate` spawn the lane-7 producer as a side
//! effect, and `docs` pipes the reference model through the
//! `can-platform docs` renderer (plus an `--out` file write when asked).
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
use crate::source::{SourceDb, SourceId, Span, admit_source_len};
use std::io::Read;
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
    // binary with this set): this qualifies the E7005/exit-2 mapping for
    // ordinary unwinds, not aborts. Production `main` catches this into
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
        "compile" => run_compile(
            &parsed.operands,
            parsed.format,
            analyzer,
            parsed.native_scenario_receipts,
        ),
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
        "docs" => run_docs(
            &parsed.operands,
            parsed.format,
            parsed.locale,
            parsed.out,
            analyzer,
        ),
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
        "dev" => {
            if parsed.format_set || parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can dev takes no can-side flags; arguments pass through to can-dev"
                        .to_string(),
                );
            }
            run_dev_entry(&parsed.operands, std::env::var("CAN_DEV_BIN").ok())
        }
        "gen" => {
            if parsed.catalog_set {
                return DispatchResult::tool_error(
                    "E7001",
                    "can gen takes no --catalog flag".to_string(),
                );
            }
            run_gen(
                &parsed.operands,
                parsed.format,
                parsed.format_set,
                parsed.request.as_deref(),
            )
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
            | "docs"
            | "run"
            | "test"
            | "build"
            | "deploy"
            | "activate"
            | "dev"
            | "gen"
            | "completions"
            | "help"
    )
}

/// Thin lane-7 entries: flag parsing stops at these; everything after is
/// child args passed verbatim to `can-platform`.
fn is_thin_entry(cmd: &str) -> bool {
    matches!(
        cmd,
        "run" | "test" | "build" | "deploy" | "activate" | "dev"
    )
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
    native_scenario_receipts: bool,
    /// `can docs --locale=TAG`: requested reference locale (selected by
    /// the TS renderer; absent means the app default plus source fallback).
    locale: Option<String>,
    /// Whether `--locale` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    locale_set: bool,
    /// `can docs --out=PATH`: reference output file (absent means stdout).
    out: Option<String>,
    /// Whether `--out` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    out_set: bool,
    /// `can gen --request=FILE`: versioned JSON request file (absent
    /// with no operands means stdin carries the request).
    request: Option<String>,
    /// Whether `--request` was passed explicitly (rejected for
    /// commands that take none, rather than silently ignored).
    request_set: bool,
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
        native_scenario_receipts: false,
        locale: None,
        locale_set: false,
        out: None,
        out_set: false,
        request: None,
        request_set: false,
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
            } else if arg == "--native-scenario-receipts" {
                parsed.native_scenario_receipts = true;
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
            } else if let Some(value) = arg.strip_prefix("--locale=") {
                parsed.locale = Some(value.to_string());
                parsed.locale_set = true;
            } else if arg == "--locale" {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --locale; want a BCP 47 tag".to_string())?;
                parsed.locale = Some(value.clone());
                parsed.locale_set = true;
            } else if let Some(value) = arg.strip_prefix("--out=") {
                parsed.out = Some(value.to_string());
                parsed.out_set = true;
            } else if arg == "--out" {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --out; want a PATH".to_string())?;
                parsed.out = Some(value.clone());
                parsed.out_set = true;
            } else if let Some(value) = arg.strip_prefix("--request=") {
                parsed.request = Some(value.to_string());
                parsed.request_set = true;
            } else if arg == "--request" {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "missing value for --request; want a PATH".to_string())?;
                parsed.request = Some(value.clone());
                parsed.request_set = true;
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
    if parsed.native_scenario_receipts && parsed.subcommand.as_deref() != Some("compile") {
        return Err("--native-scenario-receipts only applies to can compile".to_string());
    }
    if parsed.locale_set && parsed.subcommand.as_deref() != Some("docs") {
        return Err("--locale only applies to can docs".to_string());
    }
    if parsed.out_set && parsed.subcommand.as_deref() != Some("docs") {
        return Err("--out only applies to can docs".to_string());
    }
    if parsed.request_set && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--request only applies to can gen".to_string());
    }
    if parsed.locale.as_deref().is_some_and(str::is_empty) {
        return Err("can docs --locale needs a non-empty BCP 47 tag".to_string());
    }
    if parsed.out.as_deref().is_some_and(str::is_empty) {
        return Err("can docs --out needs a non-empty PATH".to_string());
    }
    if parsed.request.as_deref().is_some_and(str::is_empty) {
        return Err("can gen --request needs a non-empty PATH".to_string());
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
  docs      Generate the localized internal declaration reference (Markdown)
  run       Thin lane-7 entry: exec can-platform run (passthrough)
  test      Thin lane-7 entry: exec can-platform test (passthrough)
  build     Thin lane-7 entry: exec can-platform build (passthrough)
  deploy    Thin lane-7 entry: exec can-platform deploy (passthrough)
  activate  Thin lane-7 entry: exec can-platform activate (passthrough)
  dev       JSON control for the local development session (can-dev)
  gen       Versioned generation JSON dispatcher (plus bind/status sugar)
  completions  Print a shell completion script: can completions bash|zsh|fish
  help      Show help (global or `can help <COMMAND>`)

Options:
  --format=json|text   Machine or human output (check, compile, lint, explain, policy; docs diagnostics only)
  --catalog=PATH       Producer catalog (check, compile, lint, policy, docs; else CAN_CATALOG,
                       ./can-catalog.json, ./packages/values/dist/catalog.json)
  --native-scenario-receipts  Emit retained-result capture for the native State runtime (compile only)
  --locale=TAG         Reference locale (docs only; default is the app default + source fallback)
  --out=PATH           Write the reference to PATH instead of stdout (docs only; never a .can source)
  -h, --help           Show help (global or `can <COMMAND> --help`)
  -V, --version        Show version

Environment:
  CAN_CATALOG       Producer catalog path (below --catalog, above ./can-catalog.json)
  CAN_PLATFORM_BIN  Override path to the can-platform binary (run|test|build|deploy|activate|docs)
  CAN_DEV_BIN       Override path to the can-dev JSON control binary

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
        "compile" => "can compile — analyze sources and emit the compile artifact\n\nUsage: can compile [--format=json|text] [--catalog=PATH] [--native-scenario-receipts] FILE.can...\n\nText lists one emitted module path per line; json prints the artifact envelope. --native-scenario-receipts emits complete supported retained-result capture for the native State runtime; use its Cloudflare runtime stdlib facade. Analysis or emission errors (E6006/E6007/E6008) report diagnostics instead of an artifact.\n\nExit codes: 0 emitted, 10 errors reported, 2 tool failure.\n".to_string(),
        "explain" => "can explain — print a diagnostic catalog entry\n\nUsage: can explain [--format=json|text] CODE\n\nExit codes: 0 printed, 2 unknown code (E7003) or bad usage.\n".to_string(),
        "fmt" => "can fmt — format sources canonically\n\nUsage: can fmt [--check] [FILE.can...|-]\n\nFormats each file in place, writing only files that change. With no operands, or `-`, reads stdin and writes the formatted text to stdout. `--check` writes nothing and lists the files that differ instead. Parse failures print the machine-JSON diagnostic envelope on stdout and write nothing. Exit codes: 0 clean, 10 errors or differences reported, 2 tool failure.\n".to_string(),
        "lsp" => "can lsp — run the language server over stdio\n\nUsage: can lsp\n\nSpeaks Content-Length JSON-RPC; see the transport module docs.\nStdin EOF shuts the server down with the lifecycle exit code; a\nshutdown request followed by the exit notification exits 0, exit\nwithout shutdown exits 1.\n\nExit codes: 0 clean shutdown (shutdown+exit, or stdin EOF), 1 exit without shutdown, 2 tool failure.\n".to_string(),
        "completions" => "can completions — print a shell completion script\n\nUsage: can completions bash|zsh|fish\n\nPrints the completion script for every `can` command, flag and\noperand to stdout; eval it or install it (see docs/install.md).\n\nExit codes: 0 printed, 2 unknown shell or bad usage.\n".to_string(),
        "help" => "can help — show help\n\nUsage: can help [COMMAND]\n\nWith no command, prints the global help (`can --help`). With a\ncommand, prints that command's help (same as `can <COMMAND> --help`,\nexcept run|test|build|deploy|activate pass a trailing `--help`\nthrough to can-platform, so `can help <COMMAND>` — like\n`can --help <COMMAND>` — is the way to see their `can`-side help).\n\nExit codes: 0 printed, 2 unknown command.\n".to_string(),
        "policy" => format!(
            "can {cmd} — dump the declared policy surface (roles, model policies/invariants, operation gates)\n\nUsage: can {cmd} [--format=json|text] [--catalog=PATH] FILE.can...\n\nReads the checked program and prints the policy surface in source order.\nExit codes: 0 clean, 10 errors reported, 2 tool failure.\n"
        ),
        "docs" => "can docs — generate the localized internal declaration reference\n\nUsage: can docs [--locale=TAG] [--out=PATH] [--format=json|text] [--catalog=PATH] FILE.can...\n\nAnalyzes sources, extracts the frozen reference model v1 and pipes it as JSON through stdin to the `can-platform docs` renderer (fixed args, no shell), which selects description variants through the shared TS locale resolver and writes Markdown. Without --out the Markdown goes to stdout; without --locale the renderer uses the app default locale plus source fallback. --format shapes diagnostics only, never the Markdown. Analysis errors report diagnostics (exit 10) with no reference output and no file write; a missing runtime/renderer or a failed render is tool error E7004. --out refuses `.can` paths and input files: authored sources are never overwritten. The reference never runs business handlers or examples.\n\nExit codes: 0 rendered, 10 errors reported, 2 tool failure.\n".to_string(),
        "run" | "test" | "build" | "deploy" | "activate" => format!(
            "can {cmd} — thin lane-7 entry (passthrough to can-platform)\n\nUsage: can {cmd} [ARGS...]\n\nExecs `can-platform {cmd}` with argument passthrough when the lane-7\nproducer is installed, else reports missing-producer error E7004.\nEverything after the subcommand passes through verbatim, flags\nincluded (`can {cmd} --help` asks the platform tool; use\n`can help {cmd}` or `can --help {cmd}` to see this text). `can` never embeds a second\nplatform engine. Override search with CAN_PLATFORM_BIN. The child\nprocess exit code passes through; a signal-killed child maps to\nexit 2.\n"
        ),
        "dev" => "can dev — JSON control for the local development session\n\nUsage: can dev [COMMAND] [ARGS...]\n\nExecs the installed `can-dev` control adapter and passes every argument through. `can dev help` lists its machine-readable commands and flags. A missing adapter reports E7004. Override search with CAN_DEV_BIN. The adapter's JSON stdout and exit code pass through unchanged.\n".to_string(),
        "gen" => "can gen — versioned generation JSON dispatcher (BGI-03)\n\nUsage: can gen --request FILE\n       can gen < request.json\n       can gen status [--format=json|text] ROOT FILE.can...\n       can gen bind ROOT FILE.can START END REVISION UNIT|new\n\nThe dispatcher reads one v1 JSON request (FILE, or stdin when bare)\nand prints exactly one final JSON envelope on stdout: version,\nrequest_id, operation, ok, state, the operation payload (units,\npaths, effective recipe, phases, validation summaries), structured\nerrors, and bounded next actions. Optional JSONL progress goes to\nstderr, ending in that envelope. Typed operations: doctor, status,\ninspect, bind, generate, refine, retry, resume, diff, preview,\nvalidate, adopt, accept, cancel, reset, rollback, edit.begin,\nedit.end, lease.recover. refine carries exactly one instruction\ncarrier: inline `instruction`, an `instruction_file` path, or\n`instruction_stdin` (with --request FILE only). Settings come from\nROOT/can.gen.toml or an explicit `settings` file (no ambient\nsearch); explicit run values override the selected complete\nrunner/model recipe, and a runner override requires an explicit\nmodel. status/bind keep their positional sugar above; status\nconsults no settings, recipe, or MCP server.\n\nExit codes: 0 requested outcome succeeded, 2 invalid\nrequest/config/selection, 3 conflict/held lease, 4 validation\nfailure, 5 runner failure, 6 unknown completion.\n".to_string(),
        unknown => format!("unknown command '{unknown}'; use can --help\n"),
    }
}

/// Refuse files outside the byte-offset range before allocating their contents.
fn read_source_file(path: impl AsRef<Path>) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    admit_source_len(file.metadata()?.len())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    read_source_text(file)
}

/// A growing file or stream may reveal one byte beyond the representable range.
fn read_source_text(reader: impl Read) -> std::io::Result<String> {
    let mut text = String::new();
    reader
        .take(u64::from(u32::MAX) + 1)
        .read_to_string(&mut text)?;
    admit_source_len(text.len() as u64)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(text)
}

fn add_source(db: &mut SourceDb, path: String, text: String) -> Result<SourceId, DispatchResult> {
    let display = path.clone();
    db.try_add(path, text).map_err(|error| {
        DispatchResult::tool_error("E7002", format!("cannot admit '{display}': {error}"))
    })
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
        let text = match read_source_file(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        if let Err(error) = add_source(&mut db, path.clone(), text) {
            return error;
        }
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
    native_scenario_receipts: bool,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can compile expects at least one FILE.can operand".to_string(),
        );
    }
    let mut db = SourceDb::new();
    for path in operands {
        let text = match read_source_file(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        if let Err(error) = add_source(&mut db, path.clone(), text) {
            return error;
        }
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
        options: crate::codegen::EmitOptions {
            native_scenario_receipts,
            ..crate::codegen::EmitOptions::new()
        },
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
        let text = match read_source_file(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        match add_source(&mut db, path.clone(), text) {
            Ok(id) => files.push(id),
            Err(error) => return error,
        }
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

/// `can docs`: full analysis, then the frozen reference model v1 piped as
/// JSON through stdin to the `can-platform docs` renderer (fixed argv, never
/// a shell), which writes localized Markdown. Operand and input failures
/// follow [`run_check_like`] (`E7001`/`E7002`, exit 2). `--out` pointing
/// at a `.can` source or an input file is refused (`E7001`) before any
/// analysis runs: authored sources are never overwritten. Analysis errors
/// exit 10 with diagnostics (shaped by `--format`, which never affects the
/// Markdown) and no reference output: no spawn, no file write. A missing
/// runtime/renderer or a failed render is `E7004`/exit 2 carrying the
/// producer's own detail; an unwritable `--out` is `E7007`. The reference
/// never runs business handlers or examples.
fn run_docs(
    operands: &[String],
    format: OutputFormat,
    locale: Option<String>,
    out: Option<String>,
    analyzer: &dyn Analyzer,
) -> DispatchResult {
    let platform_bin = std::env::var("CAN_PLATFORM_BIN").ok();
    run_docs_with_platform(operands, format, locale, out, analyzer, platform_bin)
}

/// [`run_docs`] with an explicit platform binary: the test seam for the
/// renderer boundary (`None` searches `PATH`, mirroring `CAN_PLATFORM_BIN`
/// unset). Unit tests point this at stub scripts; production [`dispatch`]
/// always passes the environment value.
fn run_docs_with_platform(
    operands: &[String],
    format: OutputFormat,
    locale: Option<String>,
    out: Option<String>,
    analyzer: &dyn Analyzer,
    platform_bin: Option<String>,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can docs expects at least one FILE.can operand".to_string(),
        );
    }
    if let Some(path) = &out
        && let Some(reason) = docs_out_refusal(path, operands)
    {
        return DispatchResult::tool_error("E7001", reason);
    }
    let mut db = SourceDb::new();
    let mut files = Vec::new();
    // Portable registration: absolute operands under the project root (the
    // process working directory, same root as the catalog `./` candidates)
    // are stored project-relative; absolute operands outside stay truthful
    // `external:...` identities. Relative operands pass through verbatim,
    // so relative runs are byte-identical before/after. Reads still use the
    // original spelling (refusal above already compared both spellings).
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for path in operands {
        let text = match read_source_file(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        match add_source(&mut db, crate::docs::portable_source_id(path, &root), text) {
            Ok(id) => files.push(id),
            Err(error) => return error,
        }
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
            "can docs needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    let model = crate::docs::extract_reference(&db, &files, &program);
    let payload = model.to_json_string();
    let bin = match locate_platform_bin(platform_bin, "docs") {
        Ok(bin) => bin,
        Err(result) => return result,
    };
    let markdown = match render_via_platform(&bin, locale.as_deref(), &payload) {
        Ok(markdown) => markdown,
        Err(result) => return result,
    };
    if let Some(path) = &out {
        if let Err(err) = write_file_atomic(Path::new(path), &markdown, None) {
            return DispatchResult::tool_error("E7007", format!("cannot write '{path}': {err}"));
        }
        return DispatchResult::ok_stdout(String::new());
    }
    DispatchResult::ok_stdout(markdown)
}

/// Refusal reason when a `can docs --out` path would overwrite authored
/// sources: `.can` paths (case-insensitive) and the analyzed input files
/// themselves (by literal or canonical path). `None` means writable.
fn docs_out_refusal(out: &str, operands: &[String]) -> Option<String> {
    if Path::new(out)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("can"))
    {
        return Some(format!(
            "can docs --out refuses '.can' paths (authored sources are never overwritten): '{out}'"
        ));
    }
    if operands.iter().any(|input| input == out) {
        return Some(format!(
            "can docs --out refuses to overwrite an input file: '{out}'"
        ));
    }
    // Same file through different spellings (`./a.md` vs `a.md`): compare
    // canonical paths when both resolve; unresolvable paths (the `--out`
    // target usually does not exist yet) keep the literal check above.
    if let Ok(canonical_out) = std::fs::canonicalize(out) {
        for input in operands {
            if let Ok(canonical_in) = std::fs::canonicalize(input)
                && canonical_in == canonical_out
            {
                return Some(format!(
                    "can docs --out refuses to overwrite an input file: '{out}'"
                ));
            }
        }
    }
    None
}

/// Pipe the reference-model JSON through stdin to `can-platform docs`
/// (fixed argv, never a shell) and capture the rendered Markdown. The
/// child writes Markdown to stdout on success; any spawn failure,
/// nonzero exit, signal kill, non-UTF8 output or empty output is a
/// truthful `E7004` carrying the producer's own detail — never partial
/// Markdown presented as success.
fn render_via_platform(
    bin: &str,
    locale: Option<&str>,
    payload: &str,
) -> Result<String, DispatchResult> {
    let mut child_args = vec!["docs".to_string()];
    if let Some(tag) = locale {
        child_args.push(format!("--locale={tag}"));
    }
    let mut child = match std::process::Command::new(bin)
        .args(&child_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return Err(DispatchResult::tool_error(
                "E7004",
                format!("failed to exec lane-7 producer '{bin}': {err}"),
            ));
        }
    };
    // Drain both output pipes while writing input: a finite startup message
    // must not fill an output pipe and prevent the renderer reading its model.
    let stdout = child.stdout.take().expect("piped renderer stdout");
    let stderr = child.stderr.take().expect("piped renderer stderr");
    let output = std::thread::scope(|scope| {
        let stdout = scope.spawn(move || read_renderer_pipe(stdout));
        let stderr = scope.spawn(move || read_renderer_pipe(stderr));
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            if let Err(err) = stdin.write_all(payload.as_bytes()) {
                // Child::drop does not terminate or reap a failed renderer.
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                return Err(DispatchResult::tool_error(
                    "E7004",
                    format!("failed to pipe the reference model to '{bin} docs': {err}"),
                ));
            }
            // Drop stdin before waiting so the renderer sees EOF.
        }
        let waited = (|| {
            let status = match child.wait() {
                Ok(status) => status,
                Err(err) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(err);
                }
            };
            Ok(std::process::Output {
                status,
                stdout: stdout.join().expect("renderer stdout reader")?,
                stderr: stderr.join().expect("renderer stderr reader")?,
            })
        })();
        waited.map_err(|err| {
            DispatchResult::tool_error("E7004", format!("failed waiting for '{bin} docs': {err}"))
        })
    })?;
    if !output.status.success() {
        let detail = stderr_tail(&output.stderr);
        let status = match output.status.code() {
            Some(code) => format!("exit {code}"),
            None => "killed by signal".to_string(),
        };
        return Err(DispatchResult::tool_error(
            "E7004",
            format!("reference renderer '{bin} docs' failed ({status}): {detail}"),
        ));
    }
    let markdown = match String::from_utf8(output.stdout) {
        Ok(markdown) => markdown,
        Err(_) => {
            return Err(DispatchResult::tool_error(
                "E7004",
                format!("reference renderer '{bin} docs' wrote non-UTF8 output"),
            ));
        }
    };
    if markdown.is_empty() {
        return Err(DispatchResult::tool_error(
            "E7004",
            format!("reference renderer '{bin} docs' produced no output"),
        ));
    }
    Ok(markdown)
}

fn read_renderer_pipe(mut pipe: impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Last 2000 chars of child stderr (lossy, char-boundary safe) for
/// renderer-failure detail; names the absence when there is nothing.
fn stderr_tail(bytes: &[u8]) -> String {
    const MAX: usize = 2000;
    let text = String::from_utf8_lossy(bytes);
    if text.is_empty() {
        return "no detail on stderr".to_string();
    }
    if text.len() <= MAX {
        return text.into_owned();
    }
    // Char-boundary floor: walk forward from the cut to a boundary.
    let mut cut = text.len() - MAX;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("...{}", &text[cut..])
}

/// Locate the lane-7 `can-platform` producer: the explicit override
/// (`CAN_PLATFORM_BIN` / tests) or a `PATH` search. Shared by the thin
/// entries and the `can docs` renderer boundary; a missing producer is
/// the same truthful `E7004` everywhere.
fn locate_platform_bin(
    platform_bin: Option<String>,
    subcommand: &str,
) -> Result<String, DispatchResult> {
    let bin = match platform_bin {
        Some(path) => path,
        None => match find_on_path("can-platform") {
            Some(path) => path,
            None => {
                return Err(DispatchResult::tool_error(
                    "E7004",
                    format!(
                        "lane-7 producer 'can-platform' not found on PATH for `can {subcommand}`; install it or set CAN_PLATFORM_BIN (see can explain E7004)"
                    ),
                ));
            }
        },
    };
    if !Path::new(&bin).is_file() {
        return Err(DispatchResult::tool_error(
            "E7004",
            format!(
                "lane-7 producer '{bin}' is not a file for `can {subcommand}`; install it or fix CAN_PLATFORM_BIN (see can explain E7004)"
            ),
        ));
    }
    Ok(bin)
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
            match read_source_text(std::io::stdin()) {
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
        match read_source_file(operand) {
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
        let id = match add_source(&mut db, input.name.clone(), input.text.clone()) {
            Ok(id) => id,
            Err(error) => return error,
        };
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
                // Repeated operands or an earlier rewritten target can
                // already have this output. Keep equal bytes a no-op;
                // otherwise the original input remains the stale check.
                if *output != input.text
                    && std::fs::read(path).is_ok_and(|current| current == output.as_bytes())
                {
                    continue;
                }
                if *output != input.text
                    && let Err(err) = write_file_atomic(path, output, Some(&input.text))
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

/// Replace the requested directory entry with complete staged bytes.
/// Existing regular-file permissions (including a symlink target's mode)
/// are restored on the open staging handle. Symlinks/hardlinks retain the
/// existing entry-replacement policy; their other names are not rewritten.
/// Missing outputs use ordinary creation permissions filtered by umask.
/// Detected concurrent changes fail, but the final check is not a CAS.
/// Parent directories must be trusted; no owner/ACL or durability promise.
fn write_file_atomic(path: &Path, bytes: &str, expected: Option<&str>) -> std::io::Result<()> {
    use std::io::Write;
    replace_file_with(path, expected, |file| file.write_all(bytes.as_bytes()))
}

// One owned staging path, shared by both callers and controlled IO-failure
// tests. The callback writes through the open handle, never a temp pathname.
fn replace_file_with(
    path: &Path,
    expected: Option<&str>,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let before = replacement_destination(path)?;
    check_replacement_input(path, expected)?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut builder = tempfile::Builder::new();
    builder.prefix(".can-");
    #[cfg(unix)]
    if before.regular.is_none() {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut staged = builder.tempfile_in(parent)?;
    write(staged.as_file_mut())?;
    if let Some(original) = &before.regular {
        // Apply after writing: creation umask and writes must not narrow
        // the captured mode or clear its special bits before replacement.
        staged.as_file().set_permissions(original.permissions())?;
    }
    let after = replacement_destination(path)?;
    if !same_replacement_metadata(before.entry.as_ref(), after.entry.as_ref())
        || !same_replacement_metadata(before.regular.as_ref(), after.regular.as_ref())
    {
        return Err(std::io::Error::other(
            "destination changed during replacement",
        ));
    }
    check_replacement_input(path, expected)?;
    if before.entry.is_some() {
        staged.persist(path).map_err(|failure| failure.error)?;
    } else {
        staged
            .persist_noclobber(path)
            .map_err(|failure| failure.error)?;
    }
    Ok(())
}

struct ReplacementDestination {
    entry: Option<std::fs::Metadata>,
    regular: Option<std::fs::Metadata>,
}

fn replacement_destination(path: &Path) -> std::io::Result<ReplacementDestination> {
    let entry = match std::fs::symlink_metadata(path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let regular = match &entry {
        Some(metadata) if metadata.is_file() => Some(metadata.clone()),
        Some(metadata) if metadata.is_symlink() => match std::fs::metadata(path) {
            Ok(target) if target.is_file() => Some(target),
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        },
        _ => None,
    };
    Ok(ReplacementDestination { entry, regular })
}

fn same_replacement_metadata(
    before: Option<&std::fs::Metadata>,
    after: Option<&std::fs::Metadata>,
) -> bool {
    let (Some(before), Some(after)) = (before, after) else {
        return before.is_none() && after.is_none();
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.mode() != after.mode()
        {
            return false;
        }
    }
    before.file_type() == after.file_type()
        && before.len() == after.len()
        && before.permissions().readonly() == after.permissions().readonly()
        && before.modified().ok() == after.modified().ok()
}

fn check_replacement_input(path: &Path, expected: Option<&str>) -> std::io::Result<()> {
    if let Some(expected) = expected
        && std::fs::read(path)? != expected.as_bytes()
    {
        return Err(std::io::Error::other("source changed since formatting"));
    }
    Ok(())
}

#[cfg(test)]
mod replacement_tests {
    use super::*;
    use std::io::Write;

    fn entries(parent: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn partial_staging_write_failure_keeps_destination_and_cleans_up() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("source.can");
        std::fs::write(&path, "original").unwrap();
        let before = entries(parent.path());
        let error = replace_file_with(&path, Some("original"), |file| {
            file.write_all(b"partial new data")?;
            Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "injected IO failure",
            ))
        })
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WriteZero);
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(entries(parent.path()), before);
    }

    #[test]
    fn persist_failure_keeps_directory_and_cleans_up() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("destination");
        std::fs::create_dir(&path).unwrap();
        let before = entries(parent.path());
        assert!(write_file_atomic(&path, "new data", None).is_err());
        assert!(path.is_dir());
        assert_eq!(entries(parent.path()), before);
    }

    #[test]
    fn concurrent_creation_is_not_overwritten_and_staging_is_removed() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("reference.md");
        assert!(
            replace_file_with(&path, None, |file| {
                file.write_all(b"new reference")?;
                std::fs::write(&path, "concurrent writer")
            })
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"concurrent writer");
        assert_eq!(entries(parent.path()), vec![path]);
    }

    #[test]
    fn concurrent_content_change_is_not_overwritten() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("source.can");
        std::fs::write(&path, "original").unwrap();
        assert!(
            replace_file_with(&path, Some("original"), |file| {
                file.write_all(b"formatted")?;
                std::fs::write(&path, "concurrent edit")
            })
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"concurrent edit");
        assert_eq!(entries(parent.path()), vec![path]);
    }

    #[test]
    fn stale_format_input_is_rejected_before_staging() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("source.can");
        std::fs::write(&path, "edited").unwrap();
        let before = entries(parent.path());
        assert!(write_file_atomic(&path, "formatted", Some("old snapshot")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited");
        assert_eq!(entries(parent.path()), before);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_permission_change_is_not_reverted() {
        use std::os::unix::fs::PermissionsExt;
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("source.can");
        std::fs::write(&path, "original").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(
            replace_file_with(&path, Some("original"), |file| {
                file.write_all(b"formatted")?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            })
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        assert_eq!(entries(parent.path()), vec![path]);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_inode_is_detected_with_equal_bytes_mode_and_mtime() {
        use std::os::unix::fs::MetadataExt;
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("source.can");
        let replacement = parent.path().join("concurrent");
        std::fs::write(&path, "original").unwrap();
        let original = std::fs::metadata(&path).unwrap();
        assert!(
            replace_file_with(&path, None, |file| {
                file.write_all(b"formatted")?;
                std::fs::write(&replacement, "original")?;
                std::fs::set_permissions(&replacement, original.permissions())?;
                std::fs::File::open(&replacement)?
                    .set_times(std::fs::FileTimes::new().set_modified(original.modified()?))?;
                std::fs::rename(&replacement, &path)
            })
            .is_err()
        );
        let after = std::fs::metadata(&path).unwrap();
        assert_ne!(after.ino(), original.ino());
        assert_eq!(after.modified().unwrap(), original.modified().unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        assert_eq!(entries(parent.path()), vec![path]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_permission_change_is_not_reverted() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("target");
        let path = parent.path().join("link");
        std::fs::write(&target, "original").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink("target", &path).unwrap();
        assert!(
            replace_file_with(&path, None, |file| {
                file.write_all(b"formatted")?;
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))
            })
            .is_err()
        );
        assert!(std::fs::symlink_metadata(&path).unwrap().is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        assert_eq!(entries(parent.path()).len(), 2);
    }
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
        let text = match read_source_file(path) {
            Ok(text) => text,
            Err(err) => {
                return DispatchResult::tool_error("E7002", format!("cannot read '{path}': {err}"));
            }
        };
        if let Err(error) = add_source(&mut db, path.clone(), text) {
            return error;
        }
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
            if !fix {
                format!("{}\n", result.to_json())
            } else {
                #[derive(serde::Serialize)]
                struct LintOutput<'a> {
                    #[serde(flatten)]
                    diagnostics: &'a DiagnosticResult,
                    fixes: &'a [crate::lint::LintFix],
                }
                let output = crate::json::to_compact_string(&LintOutput {
                    diagnostics: &result,
                    fixes: &fixes,
                })
                .expect("closed lint output DTO must serialize");
                format!("{output}\n")
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
    let bin = match locate_platform_bin(platform_bin, subcommand) {
        Ok(bin) => bin,
        Err(result) => return result,
    };
    let mut child_args = Vec::with_capacity(args.len() + 1);
    child_args.push(subcommand.to_string());
    child_args.extend(args.iter().cloned());
    let mut command = std::process::Command::new(&bin);
    command.args(&child_args);
    if subcommand == "test"
        && std::env::var_os("CAN_COMPILER_BIN").is_none()
        && let Ok(executable) = std::env::current_exe()
    {
        command.env("CAN_COMPILER_BIN", executable);
    }
    match command.status() {
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

/// Pass the native `can dev` command to the single Node session client.
/// The child owns its one-line JSON response and exit status.
pub fn run_dev_entry(args: &[String], dev_bin: Option<String>) -> DispatchResult {
    let bin = match dev_bin {
        Some(path) => path,
        None => match find_on_path("can-dev") {
            Some(path) => path,
            None => {
                return DispatchResult::tool_error(
                    "E7004",
                    "development control 'can-dev' not found on PATH; install it or set CAN_DEV_BIN (see can explain E7004)".to_string(),
                );
            }
        },
    };
    if !Path::new(&bin).is_file() {
        return DispatchResult::tool_error(
            "E7004",
            format!(
                "development control '{bin}' is not a file; install it or fix CAN_DEV_BIN (see can explain E7004)"
            ),
        );
    }
    match std::process::Command::new(&bin).args(args).status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(err) => DispatchResult::tool_error(
            "E7004",
            format!("failed to exec development control '{bin}': {err}"),
        ),
    }
}

/// `can gen`: thin routing between the BGI-02 positional selectors
/// and the BGI-03 versioned JSON dispatcher.
///
/// `can gen --request FILE` reads one v1 JSON request from FILE;
/// bare `can gen` (no operands, no `--request`) reads it from
/// stdin. Both print exactly one final JSON envelope on stdout and
/// exit 0/2/3/4/5/6. `can gen bind|status ...` keep their BGI-02
/// positional sugar byte for byte; any other positional operation
/// diagnoses (retry and friends arrive as JSON requests, not
/// positionals).
fn run_gen(
    operands: &[String],
    format: OutputFormat,
    format_set: bool,
    request: Option<&str>,
) -> DispatchResult {
    if request.is_some() || operands.is_empty() {
        return run_gen_request(operands, format_set, request);
    }
    let [operation, rest @ ..] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can gen expects an operation: bind|status (see can help gen)".to_string(),
        );
    };
    match operation.as_str() {
        "bind" => run_gen_bind(rest),
        "status" => run_gen_status(rest, format),
        unknown => DispatchResult::tool_error(
            "E7001",
            format!(
                "unknown gen operation '{unknown}'; positional `can gen` supports bind|status only — '{unknown}' arrives as a JSON request via `can gen --request FILE` or stdin (BGI-03 dispatcher; see can help gen)"
            ),
        ),
    }
}

/// BGI-03 versioned JSON dispatcher: one v1 request via
/// `--request FILE` or stdin, one final JSON envelope on stdout,
/// exit 0/2/3/4/5/6. Optional JSONL progress would go to stderr so
/// stdout always parses as the single envelope; synchronous BGI-03
/// admission emits no progress itself. Unreadable or invalid
/// requests still answer with the error envelope (never a bare
/// tool error), echoing the request id/operation when they parsed.
fn run_gen_request(operands: &[String], format_set: bool, request: Option<&str>) -> DispatchResult {
    use crate::analysis::generation_protocol as proto;
    if format_set {
        return DispatchResult::tool_error(
            "E7001",
            "can gen --request/stdin always returns the versioned JSON envelope; --format does not apply (see can help gen)".to_string(),
        );
    }
    if request.is_some() && !operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can gen --request FILE takes no operands; the file carries the request (see can help gen)".to_string(),
        );
    }
    let from_stdin = request.is_none();
    let text = match request {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) => {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        "",
                        "unknown",
                        "request-unreadable",
                        &format!("cannot read request '{path}': {err}"),
                        vec![
                            "pass a readable --request FILE or pipe the request on stdin"
                                .to_string(),
                        ],
                    ),
                );
            }
        },
        None => match read_source_text(std::io::stdin()) {
            Ok(text) => text,
            Err(err) => {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        "",
                        "unknown",
                        "request-unreadable",
                        &format!("cannot read the stdin request: {err}"),
                        vec!["pipe one v1 JSON request on stdin or use --request FILE".to_string()],
                    ),
                );
            }
        },
    };
    let validated = match proto::parse_request(&text) {
        Ok(validated) => validated,
        Err(err) => {
            let (request_id, operation) = echo_header(&text);
            return gen_envelope_result(
                err.exit,
                proto::error_envelope(
                    &request_id,
                    &operation,
                    err.code,
                    &err.message,
                    vec!["fix the request and resend (see can help gen)".to_string()],
                ),
            );
        }
    };
    dispatch_gen_operation(&validated, from_stdin)
}

/// Wrap a final JSON envelope as the dispatcher result: envelope on
/// stdout, silent stderr, contract exit code.
fn gen_envelope_result(code: i32, envelope: String) -> DispatchResult {
    DispatchResult {
        code,
        stdout: envelope,
        stderr: String::new(),
        run_lsp: false,
    }
}

/// Best-effort request id/operation echo for failed parses: parsed
/// strings pass through, anything else becomes empty/`unknown`
/// markers. Never invents ids.
fn echo_header(text: &str) -> (String, String) {
    let (mut request_id, mut operation) = (String::new(), "unknown".to_string());
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(serde_json::Value::String(id)) = map.get("request_id") {
            request_id = id.clone();
        }
        if let Some(serde_json::Value::String(op)) = map.get("operation") {
            operation = op.clone();
        }
    }
    (request_id, operation)
}

/// Route one validated request to its operation handler. Handlers
/// for execution and lifecycle operations join through BGI-04,
/// BGI-05, and BGI-12; this dispatcher owns their common admission
/// (selectors, settings, recipes, pre-launch gates) once, so every
/// admitted-but-unhandled request fails closed with a typed
/// `not-implemented` envelope instead of launching partial work.
fn dispatch_gen_operation(
    validated: &crate::analysis::generation_protocol::ValidatedRequest,
    from_stdin: bool,
) -> DispatchResult {
    use crate::analysis::generation_protocol::GenParams;
    match &validated.params {
        GenParams::Doctor(params) => run_gen_doctor(&validated.header, params),
        GenParams::Status(params) => run_gen_status_json(&validated.header, params),
        GenParams::Inspect(params) => run_gen_inspect(&validated.header, params),
        GenParams::Bind(params) => run_gen_bind_json(&validated.header, params),
        GenParams::Generate(params) => run_gen_generate(&validated.header, params),
        GenParams::Refine(params) => run_gen_refine(&validated.header, params, from_stdin),
        GenParams::Retry(params) => run_gen_retry(&validated.header, params),
        GenParams::Resume(params) => run_gen_not_implemented(
            &validated.header,
            params.root.clone(),
            "BGI-05 (recorded-session store, capture checks, and resume preflight)",
        ),
        GenParams::Diff(params) => {
            admit_saved_unit(&validated.header, &params.root, &params.unit_id).map_or_else(
                |error| error,
                |_| {
                    run_gen_not_implemented(
                        &validated.header,
                        params.root.clone(),
                        "BGI-05 (candidate inventory and machine diffs)",
                    )
                },
            )
        }
        GenParams::Preview(params) => {
            admit_saved_unit(&validated.header, &params.root, &params.unit_id).map_or_else(
                |error| error,
                |_| {
                    run_gen_not_implemented(
                        &validated.header,
                        params.root.clone(),
                        "BGI-05 (candidate inventory and rendered previews)",
                    )
                },
            )
        }
        GenParams::Validate(params) => admit_validate(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-11 (interface/contract/target validators)",
                )
            },
        ),
        GenParams::Adopt(params) => admit_adopt(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-12 (validation-to-promotion joins)",
                )
            },
        ),
        GenParams::Accept(params) => admit_accept(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-12 (conditional promotion) with BGI-04 (run journals)",
                )
            },
        ),
        GenParams::Cancel(params) => admit_cancel(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-05 (execution fencing) with BGI-12 (controls)",
                )
            },
        ),
        GenParams::Reset(params) => admit_reset(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-05 (execution fencing) with BGI-12 (controls)",
                )
            },
        ),
        GenParams::Rollback(params) => {
            admit_saved_unit(&validated.header, &params.root, &params.unit_id).map_or_else(
                |error| error,
                |_| {
                    run_gen_not_implemented(
                        &validated.header,
                        params.root.clone(),
                        "BGI-12 (rollback) with BGI-04 (run journals)",
                    )
                },
            )
        }
        GenParams::EditBegin(params) => admit_edit_begin(&validated.header, params).map_or_else(
            |error| error,
            |_| {
                run_gen_not_implemented(
                    &validated.header,
                    params.root.clone(),
                    "BGI-04 (write leases)",
                )
            },
        ),
        GenParams::EditEnd(params) => run_gen_not_implemented(
            &validated.header,
            params.root.clone(),
            "BGI-04 (write leases)",
        ),
        GenParams::LeaseRecover(params) => run_gen_not_implemented(
            &validated.header,
            params.root.clone(),
            "BGI-04 (write leases and journal recovery)",
        ),
    }
}

/// `not-implemented`: the request passed full admission, but its
/// handler joins through a later task. Exit 2 with a typed error
/// naming the join; nothing launches, nothing changes.
fn run_gen_not_implemented(
    header: &crate::analysis::generation_protocol::RequestHeader,
    _root: String,
    join: &str,
) -> DispatchResult {
    use crate::analysis::generation_protocol as proto;
    gen_envelope_result(
        exit::TOOL_FAILURE,
        proto::error_envelope(
            &header.request_id,
            header.operation.as_str(),
            "not-implemented",
            &format!(
                "operation '{}' passed admission, but its handler joins through {}; nothing launched and nothing changed",
                header.operation.as_str(),
                join,
            ),
            vec![format!("resend after {join} lands")],
        ),
    )
}

/// Load one source file for generation discovery, with CLI error mapping.
fn read_gen_source(path: &str) -> Result<(SourceDb, SourceId, String), DispatchResult> {
    let text = match read_source_file(path) {
        Ok(text) => text,
        Err(err) => {
            return Err(DispatchResult::tool_error(
                "E7002",
                format!("cannot read '{path}': {err}"),
            ));
        }
    };
    let mut db = SourceDb::new();
    let id = add_source(&mut db, path.to_string(), text.clone())?;
    Ok((db, id, text))
}

/// Load the saved records under `<root>/can.generated/`, collecting
/// incompatible groups as issues instead of aborting the report.
fn load_gen_saved(
    root: &Path,
) -> (
    Vec<crate::analysis::generation_intake::UnitRecord>,
    Vec<crate::analysis::generation_intake::IntakeIssue>,
) {
    use crate::analysis::generation_intake as intake;
    let mut saved = Vec::new();
    let mut issues = Vec::new();
    for name in intake::scan_unit_ids(root) {
        let id = match intake::GenerationUnitId::parse(&name) {
            Ok(id) => id,
            Err(_) => continue, // scan_unit_ids already validated; stay total.
        };
        let path = root
            .join(intake::GENERATED_DIR)
            .join(id.as_str())
            .join(intake::UNIT_FILE);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => {
                issues.push(intake::IntakeIssue {
                    unit: id.as_str().to_string(),
                    action: intake::IntakeAction::Generate,
                    detail: format!(
                        "no saved group at {}; prepare generation for the unit",
                        path.display()
                    ),
                });
                continue;
            }
        };
        match intake::UnitRecord::parse(&text, &id) {
            Ok(record) => saved.push(record),
            Err(reason) => issues.push(intake::IntakeIssue {
                unit: id.as_str().to_string(),
                action: intake::IntakeAction::Bind,
                detail: format!(
                    "saved group is incompatible: {reason}; reconcile with an explicit bind"
                ),
            }),
        }
    }
    (saved, issues)
}

/// `can gen bind ROOT FILE.can START END REVISION UNIT|new`: reconcile one
/// inspected source span with a saved unit, or allocate a fresh ID.
///
/// The span selects the discovered generation unit containing it;
/// applications and named uses reuse their definition and cannot bind.
/// The bind refuses when REVISION no longer matches the file (stale
/// selector), when UNIT names no saved group or a different-kind group,
/// and always leaves saved groups intact on failure. Persistence is one
/// atomic `unit.json` write; lease coordination arrives with BGI-04.
fn run_gen_bind(operands: &[String]) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    let [root, file, start_text, end_text, revision, unit] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can gen bind expects ROOT FILE.can START END REVISION UNIT|new (see can help gen)"
                .to_string(),
        );
    };
    let (start, end) = match (start_text.parse::<u32>(), end_text.parse::<u32>()) {
        (Ok(start), Ok(end)) if start <= end => (start, end),
        _ => {
            return DispatchResult::tool_error(
                "E7001",
                format!("can gen bind needs byte offsets START<=END, got {start_text}..{end_text}"),
            );
        }
    };
    let target = if unit == "new" {
        intake::BindTarget::New
    } else {
        match intake::GenerationUnitId::parse(unit) {
            Ok(id) => intake::BindTarget::Existing(id),
            Err(reason) => {
                return DispatchResult::tool_error("E7001", format!("can gen bind: {reason}"));
            }
        }
    };
    let (_db, _id, text) = match read_gen_source(file) {
        Ok(loaded) => loaded,
        Err(error) => return error,
    };
    let current_revision = crate::source::sha256_hex(text.as_bytes());
    let (tree, _) = crate::syntax::parse_source(SourceId(0), &text);
    let found = crate::analysis::generation::discover_generation(&tree, &text);
    let selected = found.descriptors.iter().find(|d| {
        intake::UnitKind::of_descriptor(d.kind).is_some()
            && d.span.start <= start
            && end <= d.span.end
    });
    let Some(descriptor) = selected else {
        return DispatchResult::tool_error(
            "E7001",
            format!(
                "can gen bind: no generation unit at {file}:{start}..{end}; applications and named uses reuse their definition and cannot bind"
            ),
        );
    };
    let root_path = Path::new(root);
    let (saved, _) = load_gen_saved(root_path);
    let request = intake::BindRequest {
        path: file.clone(),
        revision: revision.clone(),
        start,
        end,
        source: match intake::association_for(descriptor, file, revision) {
            Some(source) => source,
            None => {
                return DispatchResult::tool_error(
                    "E7001",
                    "can gen bind: selected descriptor carries no generation identity".to_string(),
                );
            }
        },
        contract: match intake::contract_for(descriptor) {
            Some(contract) => contract,
            None => {
                return DispatchResult::tool_error(
                    "E7001",
                    "can gen bind: selected descriptor carries no generation identity".to_string(),
                );
            }
        },
        target,
    };
    let record = match intake::apply_bind(&saved, &request, &current_revision) {
        Ok(record) => record,
        Err(err) => return DispatchResult::tool_error("E7001", format!("can gen bind: {err}")),
    };
    let dir = root_path
        .join(intake::GENERATED_DIR)
        .join(record.id.as_str());
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return DispatchResult::tool_error(
            "E7007",
            format!("cannot write '{}': {err}", dir.display()),
        );
    }
    let unit_path = dir.join(intake::UNIT_FILE);
    if let Err(err) = write_file_atomic(&unit_path, &record.to_json(), None) {
        return DispatchResult::tool_error(
            "E7007",
            format!("cannot write '{}': {err}", unit_path.display()),
        );
    }
    DispatchResult::ok_stdout(format!(
        "bound {} {file}:{start}..{end} -> {}\n",
        record.id,
        unit_path.display()
    ))
}

/// Collected association report shared by the BGI-02 positional
/// `status` sugar and the BGI-03 JSON `status` operation. Both
/// surfaces report the same units/issues; only the envelope differs.
struct GenStatusReport {
    /// Human text lines (positional sugar only).
    lines: Vec<String>,
    /// Machine unit entries (both JSON surfaces).
    units: Vec<serde_json::Value>,
    /// Missing/incompatible groups with their exact unit and action.
    issues: Vec<crate::analysis::generation_intake::IntakeIssue>,
}

/// Collect one association report over explicit sources: saved
/// intake only, no settings, recipe, or MCP server consulted.
fn collect_gen_status(root: &str, files: &[String]) -> Result<GenStatusReport, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    let root_path = Path::new(root);
    let (saved, mut issues) = load_gen_saved(root_path);
    let mut lines: Vec<String> = Vec::new();
    let mut units_json: Vec<serde_json::Value> = Vec::new();
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();
    for file in files {
        let (_db, _id, text) = read_gen_source(file)?;
        let (tree, _) = crate::syntax::parse_source(SourceId(0), &text);
        let found = crate::analysis::generation::discover_generation(&tree, &text);
        // Current captured file/revision evidence: explicit binds are
        // honored for their exact location, while changed/stale input
        // still refuses conservatively (BGI02-repair join).
        let evidence = intake::AssociationSource {
            path: file.clone(),
            revision: crate::source::sha256_hex(text.as_bytes()),
        };
        for (index, association) in
            intake::associate_with_source(&found.descriptors, &saved, &evidence)
        {
            let descriptor = &found.descriptors[index];
            let kind = intake::UnitKind::of_descriptor(descriptor.kind)
                .map(|k| k.as_str())
                .unwrap_or("?");
            let label = descriptor.label.as_deref().unwrap_or("-");
            match &association {
                intake::UnitAssociation::Retained { id, prompt_changed } => {
                    matched.insert(id.as_str().to_string());
                    let group = intake::read_saved_group(root_path, id);
                    let stale = if *prompt_changed {
                        " prompt-changed"
                    } else {
                        ""
                    };
                    match group {
                        Ok(_) => {
                            lines.push(format!(
                                "unit {} {}/{}/{label} {file}{stale}",
                                id, descriptor.owner, kind
                            ));
                            units_json.push(serde_json::json!({
                                "id": id.as_str(),
                                "owner": descriptor.owner,
                                "kind": kind,
                                "label": descriptor.label,
                                "path": file,
                                "association": "retained",
                                "prompt_changed": prompt_changed,
                                "current": format!(
                                    "{}/{}/{id}",
                                    root, intake::GENERATED_DIR
                                ),
                                // BGI-04 owns leases/journals under this dir;
                                // BGI-02 only names the concrete location.
                                "candidates": format!(
                                    "{}/.can/gen/attempts/{id}",
                                    root
                                ),
                            }));
                        }
                        Err(issue) => {
                            // Reported once with every other issue below.
                            issues.push(issue);
                        }
                    }
                }
                intake::UnitAssociation::New => {
                    lines.push(format!(
                        "new {}/{}/{label} {file} (action: generate)",
                        descriptor.owner, kind
                    ));
                    units_json.push(serde_json::json!({
                        "id": null,
                        "owner": descriptor.owner,
                        "kind": kind,
                        "label": descriptor.label,
                        "path": file,
                        "association": "new",
                        "action": "generate",
                    }));
                }
                intake::UnitAssociation::Ambiguous { candidates } => {
                    let names = candidates
                        .iter()
                        .map(intake::GenerationUnitId::as_str)
                        .collect::<Vec<_>>()
                        .join(",");
                    lines.push(format!(
                        "ambiguous {}/{}/{label} {file} candidates=[{names}] (action: bind)",
                        descriptor.owner, kind
                    ));
                    units_json.push(serde_json::json!({
                        "id": null,
                        "owner": descriptor.owner,
                        "kind": kind,
                        "label": descriptor.label,
                        "path": file,
                        "association": "ambiguous",
                        "candidates": candidates.iter().map(intake::GenerationUnitId::as_str).collect::<Vec<_>>(),
                        "action": "bind",
                    }));
                }
            }
        }
    }
    for record in &saved {
        if matched.contains(record.id.as_str()) {
            continue;
        }
        lines.push(format!(
            "saved {} has no current source unit (action: bind)",
            record.id
        ));
        units_json.push(serde_json::json!({
            "id": record.id.as_str(),
            "association": "orphaned",
            "action": "bind",
        }));
    }
    for issue in &issues {
        lines.push(format!("{issue}"));
    }
    Ok(GenStatusReport {
        lines,
        units: units_json,
        issues,
    })
}

/// Machine rendering of one intake issue, shared by both JSON
/// status surfaces.
fn gen_issue_json(issue: &crate::analysis::generation_intake::IntakeIssue) -> serde_json::Value {
    serde_json::json!({
        "unit": issue.unit,
        "action": issue.action.as_str(),
        "detail": issue.detail,
    })
}

/// `can gen status ROOT FILE.can...`: report association per discovered
/// unit plus every missing/incompatible group with its exact unit and
/// generation/reconciliation action. Always exits 0 when the report is
/// complete; unreadable inputs are tool failures.
fn run_gen_status(operands: &[String], format: OutputFormat) -> DispatchResult {
    let [root, files @ ..] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can gen status expects ROOT FILE.can... (see can help gen)".to_string(),
        );
    };
    if files.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can gen status expects ROOT FILE.can... (see can help gen)".to_string(),
        );
    }
    let report = match collect_gen_status(root, files) {
        Ok(report) => report,
        Err(error) => return error,
    };
    let GenStatusReport {
        lines,
        units: units_json,
        issues,
    } = report;
    let stdout = match format {
        OutputFormat::Json => {
            let issues_json: Vec<serde_json::Value> = issues.iter().map(gen_issue_json).collect();
            format!(
                "{}\n",
                serde_json::json!({ "units": units_json, "issues": issues_json })
            )
        }
        OutputFormat::Text => {
            let mut out = String::new();
            for line in lines {
                out.push_str(&line);
                out.push('\n');
            }
            out
        }
    };
    DispatchResult::ok_stdout(stdout)
}

/// JSON `status`: the shared association report inside the result
/// envelope. Saved intake only: no settings, recipe, or MCP server
/// is consulted, so ordinary saved builds stay independent of
/// generation configuration.
fn run_gen_status_json(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::StatusParams,
) -> DispatchResult {
    use crate::analysis::generation_protocol as proto;
    let report = match collect_gen_status(&params.root, &params.files) {
        Ok(report) => report,
        Err(error) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "unreadable-input",
                    tool_message(&error.stderr),
                    vec!["pass readable source files and resend".to_string()],
                ),
            );
        }
    };
    let issues_json: Vec<serde_json::Value> = report.issues.iter().map(gen_issue_json).collect();
    let mut payload = serde_json::Map::new();
    payload.insert("units".to_string(), serde_json::Value::Array(report.units));
    payload.insert("issues".to_string(), serde_json::Value::Array(issues_json));
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(
            header,
            "reported",
            payload,
            status_next_actions(&report.issues),
        ),
    )
}

/// Strip the `error[CODE]: ` prefix plus trailing newline from a
/// tool error rendered for envelope embedding.
fn tool_message(stderr: &str) -> &str {
    let message = stderr.strip_prefix("error[").map(|rest| {
        rest.find("]: ")
            .map(|index| &rest[index + 3..])
            .unwrap_or(rest)
    });
    message.unwrap_or(stderr).trim()
}

/// Bounded next actions for a status report: generate for
/// unassociated units, bind for ambiguous/orphaned ones.
fn status_next_actions(issues: &[crate::analysis::generation_intake::IntakeIssue]) -> Vec<String> {
    use crate::analysis::generation_intake::IntakeAction;
    let mut next = Vec::new();
    if issues
        .iter()
        .any(|issue| issue.action == IntakeAction::Generate)
    {
        next.push("send a generate request for units with no saved group".to_string());
    }
    if issues
        .iter()
        .any(|issue| issue.action == IntakeAction::Bind)
    {
        next.push("send a bind request to reconcile ambiguous or orphaned units".to_string());
    }
    if next.is_empty() {
        next.push("no action needed; every unit is associated".to_string());
    }
    next
}

/// JSON `doctor`: provider check without coding generation. Reports
/// every adapter's advertised capabilities plus its PATH
/// availability probe, the effective shared recipe with origins
/// when one resolves, the pre-launch preflight for that recipe, and
/// an overall launch verdict. A negative verdict is a successful
/// check (exit 0): the report carries the blockers, and callers map
/// `verdict: blocked` to their own handling.
fn run_gen_doctor(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::DoctorParams,
) -> DispatchResult {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    let root = params.root.clone().unwrap_or_else(|| ".".to_string());
    let loaded = match config::load_settings(Path::new(&root), params.settings.as_deref()) {
        Ok(loaded) => loaded,
        Err(err) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    err.code(),
                    &err.to_string(),
                    vec!["fix the settings selection and resend doctor".to_string()],
                ),
            );
        }
    };
    let overrides = params.overrides();
    let recipe = config::resolve_recipe(
        loaded.as_ref(),
        config::RecipeCategory::Given,
        None,
        &overrides,
    );
    let mut adapters_json = Vec::new();
    for adapter in config::ADAPTERS {
        let mut found: Option<(&str, String)> = None;
        for binary in adapter.probe_binaries {
            if let Some(path) = find_on_path(binary) {
                found = Some((binary, path));
                break;
            }
        }
        let availability = match found {
            Some((binary, path)) => serde_json::json!({
                "found": true,
                "binary": binary,
                "path": path,
                "tried": adapter.probe_binaries,
            }),
            None => serde_json::json!({
                "found": false,
                "binary": null,
                "path": null,
                "tried": adapter.probe_binaries,
            }),
        };
        adapters_json.push(serde_json::json!({
            "id": adapter.id,
            "label": adapter.label,
            "capabilities": adapter.to_json(),
            "availability": availability,
        }));
    }
    let mut blockers: Vec<String> = Vec::new();
    let (recipe_json, recipe_error_json, preflight_json) = match &recipe {
        Ok(resolved) => {
            let failures = match config::preflight_recipe(resolved) {
                Ok(()) => Vec::new(),
                Err(err) => vec![err.to_string()],
            };
            if failures.is_empty() {
                let adapter = config::adapter_capabilities(&resolved.runner)
                    .expect("resolved runner is known");
                let binary_found = adapter
                    .probe_binaries
                    .iter()
                    .any(|binary| find_on_path(binary).is_some());
                if !binary_found {
                    blockers.push(format!(
                        "runner `{}` has no executable on PATH (tried: {})",
                        resolved.runner,
                        adapter.probe_binaries.join(", "),
                    ));
                }
            } else {
                blockers.extend(failures.clone());
            }
            (
                resolved.to_json(),
                serde_json::Value::Null,
                serde_json::json!({"ok": failures.is_empty(), "failures": failures}),
            )
        }
        Err(err) => {
            blockers.push(err.to_string());
            (
                serde_json::Value::Null,
                serde_json::json!({"code": err.code(), "message": err.to_string()}),
                serde_json::Value::Null,
            )
        }
    };
    // Without any recipe selectors the check covers availability and
    // gates only: the verdict stays blocked with an explicit
    // no-recipe blocker, never a misleading ready.
    let recipe_selected = params.settings.is_some()
        || overrides.profile.is_some()
        || overrides.runner.is_some()
        || overrides.model.is_some()
        || loaded.as_ref().is_some_and(|found| {
            found.settings.shared.runner.is_some() || !found.settings.profiles.is_empty()
        });
    if !recipe_selected {
        blockers.clear();
        blockers.push(
            "no recipe selected: pass settings, a profile, or runner/model overrides to check one recipe"
                .to_string(),
        );
    }
    let verdict = if blockers.is_empty() {
        "ready"
    } else {
        "blocked"
    };
    let mut next = Vec::new();
    if verdict == "blocked" {
        next.push("resolve the reported blockers, then resend doctor".to_string());
    } else {
        next.push("the selected recipe can launch; send an execution request".to_string());
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "adapters".to_string(),
        serde_json::Value::Array(adapters_json),
    );
    payload.insert("recipe".to_string(), recipe_json);
    payload.insert("recipe_error".to_string(), recipe_error_json);
    payload.insert("preflight".to_string(), preflight_json);
    payload.insert(
        "verdict".to_string(),
        serde_json::Value::String(verdict.to_string()),
    );
    payload.insert(
        "blockers".to_string(),
        serde_json::Value::Array(
            blockers
                .into_iter()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    payload.insert(
        "auth".to_string(),
        serde_json::Value::String(
            "native CLI login is not probed by BGI-03; BGI-05 qualifies per-adapter authentication"
                .to_string(),
        ),
    );
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(header, "reported", payload, next),
    )
}

/// JSON `inspect`: one unit's association, contracts, concrete
/// paths, and effective recipe with origins. The selector names a
/// saved unit id or one source span; applications and named uses
/// reuse their definition and cannot inspect.
fn run_gen_inspect(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::InspectParams,
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let root_path = Path::new(&params.root);
    let (saved, _) = load_gen_saved(root_path);
    // Resolve the selector to a descriptor plus its association.
    let selected = if let Some(unit_id) = &params.unit_id {
        let id = match intake::GenerationUnitId::parse(unit_id) {
            Ok(id) => id,
            Err(reason) => {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        &header.request_id,
                        header.operation.as_str(),
                        "invalid-param",
                        &format!("inspect `unit_id`: {reason}"),
                        vec!["pass a saved unit id (see a status report)".to_string()],
                    ),
                );
            }
        };
        let record = saved.iter().find(|record| record.id == id);
        let Some(record) = record else {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "unknown-unit",
                    &format!("no saved unit `{unit_id}` under {}", root_path.display()),
                    vec!["send a status request to list saved units".to_string()],
                ),
            );
        };
        InspectedUnit::saved(record)
    } else {
        let (Some(file), Some(start), Some(end)) = (params.file.clone(), params.start, params.end)
        else {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    "inspect needs `unit_id`, or `file` with `start`/`end`",
                    vec!["select one unit and resend".to_string()],
                ),
            );
        };
        let (_db, _id, text) = match read_gen_source(&file) {
            Ok(loaded) => loaded,
            Err(error) => {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        &header.request_id,
                        header.operation.as_str(),
                        "unreadable-input",
                        tool_message(&error.stderr),
                        vec!["pass a readable source file and resend".to_string()],
                    ),
                );
            }
        };
        let (tree, _) = crate::syntax::parse_source(SourceId(0), &text);
        let found = crate::analysis::generation::discover_generation(&tree, &text);
        // Current captured file/revision evidence, as in status.
        let evidence = intake::AssociationSource {
            path: file.clone(),
            revision: crate::source::sha256_hex(text.as_bytes()),
        };
        let associations = intake::associate_with_source(&found.descriptors, &saved, &evidence);
        let located = associations.iter().find(|(index, _)| {
            let descriptor = &found.descriptors[*index];
            intake::UnitKind::of_descriptor(descriptor.kind).is_some()
                && descriptor.span.start <= start
                && end <= descriptor.span.end
        });
        let Some((index, association)) = located else {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "no-unit-at-span",
                    &format!(
                        "no generation unit at {file}:{start}..{end}; applications and named uses reuse their definition and cannot inspect"
                    ),
                    vec!["send a status request to list inspectable units".to_string()],
                ),
            );
        };
        InspectedUnit::spanned(&found.descriptors[*index], association, &saved)
    };
    // Effective recipe for the unit's category, when one resolves.
    let (recipe_json, recipe_error_json) = inspect_recipe(params, &selected);
    let mut payload = serde_json::Map::new();
    payload.insert("unit".to_string(), selected.to_json(&params.root));
    payload.insert("recipe".to_string(), recipe_json);
    payload.insert("recipe_error".to_string(), recipe_error_json);
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(header, "reported", payload, vec![]),
    )
}

/// One inspected unit: either a saved record selected by id, or a
/// spanned descriptor with its live association.
struct InspectedUnit {
    /// Saved id when the unit is associated.
    id: Option<String>,
    /// Descriptor owner.
    owner: String,
    /// Unit kind wire string.
    kind: String,
    /// Descriptor label, if any.
    label: Option<String>,
    /// Association state: retained, new, ambiguous, or orphaned.
    association: String,
    /// Ambiguous candidates, if any.
    candidates: Vec<String>,
    /// Prompt changed since association, if retained.
    prompt_changed: Option<bool>,
    /// Contract refs, when the unit carries them.
    contract: Option<serde_json::Value>,
    /// Owning declaration's optional generation profile.
    agent: Option<String>,
    /// Recipe category for the unit kind.
    category: crate::analysis::generation_config::RecipeCategory,
}

impl InspectedUnit {
    /// A saved record selected by id (retained by construction).
    fn saved(record: &crate::analysis::generation_intake::UnitRecord) -> Self {
        Self {
            id: Some(record.id.as_str().to_string()),
            owner: record.source.owner.clone(),
            kind: record.source.kind.as_str().to_string(),
            label: record.source.label.clone(),
            association: "retained".to_string(),
            candidates: Vec::new(),
            prompt_changed: Some(false),
            contract: Some(contract_json(&record.contract)),
            agent: record.contract.profile.clone(),
            category: category_for_kind(record.source.kind),
        }
    }

    /// A spanned descriptor with its live association outcome.
    fn spanned(
        descriptor: &crate::analysis::generation::GenerationDescriptor,
        association: &crate::analysis::generation_intake::UnitAssociation,
        saved: &[crate::analysis::generation_intake::UnitRecord],
    ) -> Self {
        use crate::analysis::generation_intake as intake;
        let kind = intake::UnitKind::of_descriptor(descriptor.kind).expect("selected identity");
        let mut unit = Self {
            id: None,
            owner: descriptor.owner.clone(),
            kind: kind.as_str().to_string(),
            label: descriptor.label.clone(),
            association: "new".to_string(),
            candidates: Vec::new(),
            prompt_changed: None,
            contract: intake::contract_for(descriptor).map(|contract| contract_json(&contract)),
            agent: descriptor.profile.clone(),
            category: category_for_kind(kind),
        };
        match association {
            intake::UnitAssociation::Retained { id, prompt_changed } => {
                unit.id = Some(id.as_str().to_string());
                unit.association = "retained".to_string();
                unit.prompt_changed = Some(*prompt_changed);
                if let Some(record) = saved.iter().find(|record| record.id == *id) {
                    // The reported contract stays the saved original
                    // (historical provenance); the recipe agent stays
                    // the current descriptor's profile, so a live
                    // source profile edit resolves future attempts
                    // without rewriting historical receipts.
                    unit.contract = Some(contract_json(&record.contract));
                }
            }
            intake::UnitAssociation::New => {}
            intake::UnitAssociation::Ambiguous { candidates } => {
                unit.association = "ambiguous".to_string();
                unit.candidates = candidates
                    .iter()
                    .map(intake::GenerationUnitId::as_str)
                    .map(str::to_string)
                    .collect();
            }
        }
        unit
    }

    /// Machine rendering with concrete current/candidate paths.
    fn to_json(&self, root: &str) -> serde_json::Value {
        use crate::analysis::generation_intake as intake;
        let paths = match &self.id {
            Some(id) => serde_json::json!({
                "current": format!("{root}/{}/{id}", intake::GENERATED_DIR),
                "candidates": format!("{root}/.can/gen/attempts/{id}"),
            }),
            None => serde_json::json!({"current": null, "candidates": null}),
        };
        serde_json::json!({
            "id": self.id,
            "owner": self.owner,
            "kind": self.kind,
            "label": self.label,
            "association": self.association,
            "candidates": self.candidates,
            "prompt_changed": self.prompt_changed,
            "contract": self.contract,
            "paths": paths,
        })
    }
}

/// Minimal contract refs carried beside an inspected unit.
fn contract_json(contract: &crate::analysis::generation_intake::UnitContract) -> serde_json::Value {
    serde_json::json!({
        "target": contract.target,
        "profile": contract.profile,
        "prompt_sha256": contract.prompt_sha256,
        "signature": contract.signature,
    })
}

/// Recipe category for one unit kind: Then styles/views resolve the
/// frontend recipe, Given traits/keywords the shared recipe.
fn category_for_kind(
    kind: crate::analysis::generation_intake::UnitKind,
) -> crate::analysis::generation_config::RecipeCategory {
    use crate::analysis::generation_config::RecipeCategory;
    use crate::analysis::generation_intake::UnitKind;
    match kind {
        UnitKind::Style | UnitKind::StyleInline | UnitKind::View | UnitKind::ViewStyleInline => {
            RecipeCategory::Frontend
        }
        UnitKind::NamedTrait | UnitKind::InlineTrait | UnitKind::Keyword => RecipeCategory::Given,
    }
}

/// Effective recipe section for an inspected unit: resolve from the
/// request settings/overrides plus the owning declaration's agent.
/// Resolution failures report inside the envelope (inspect stays a
/// successful read); only unreadable settings fail the operation.
fn inspect_recipe(
    params: &crate::analysis::generation_protocol::InspectParams,
    selected: &InspectedUnit,
) -> (serde_json::Value, serde_json::Value) {
    use crate::analysis::generation_config as config;
    let loaded = match config::load_settings(Path::new(&params.root), params.settings.as_deref()) {
        Ok(loaded) => loaded,
        Err(err) => {
            return (
                serde_json::Value::Null,
                serde_json::json!({"code": err.code(), "message": err.to_string()}),
            );
        }
    };
    match config::resolve_recipe(
        loaded.as_ref(),
        selected.category,
        selected.agent.as_deref(),
        &params.overrides(),
    ) {
        Ok(resolved) => (resolved.to_json(), serde_json::Value::Null),
        Err(err) => (
            serde_json::Value::Null,
            serde_json::json!({"code": err.code(), "message": err.to_string()}),
        ),
    }
}

/// JSON `bind`: reconcile one inspected source span with an existing
/// saved unit id, or allocate a fresh id with `new`. Same intake
/// semantics as the positional sugar (stale revisions refuse, saved
/// groups stay intact on failure); only the envelope differs.
fn run_gen_bind_json(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::BindParams,
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let target = if params.unit == "new" {
        intake::BindTarget::New
    } else {
        match intake::GenerationUnitId::parse(&params.unit) {
            Ok(id) => intake::BindTarget::Existing(id),
            Err(reason) => {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        &header.request_id,
                        header.operation.as_str(),
                        "invalid-param",
                        &format!("bind `unit`: {reason}"),
                        vec!["pass a saved unit id or \"new\"".to_string()],
                    ),
                );
            }
        }
    };
    let (_db, _id, text) = match read_gen_source(&params.file) {
        Ok(loaded) => loaded,
        Err(error) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "unreadable-input",
                    tool_message(&error.stderr),
                    vec!["pass a readable source file and resend".to_string()],
                ),
            );
        }
    };
    let current_revision = crate::source::sha256_hex(text.as_bytes());
    let (tree, _) = crate::syntax::parse_source(SourceId(0), &text);
    let found = crate::analysis::generation::discover_generation(&tree, &text);
    let selected = found.descriptors.iter().find(|d| {
        intake::UnitKind::of_descriptor(d.kind).is_some()
            && d.span.start <= params.start
            && params.end <= d.span.end
    });
    let Some(descriptor) = selected else {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "no-unit-at-span",
                &format!(
                    "no generation unit at {}:{}..{}; applications and named uses reuse their definition and cannot bind",
                    params.file, params.start, params.end,
                ),
                vec!["send a status request to list bindable units".to_string()],
            ),
        );
    };
    let root_path = Path::new(&params.root);
    let (saved, _) = load_gen_saved(root_path);
    let source = match intake::association_for(descriptor, &params.file, &params.revision) {
        Some(source) => source,
        None => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    "the selected descriptor carries no generation identity",
                    vec!["select an identity-carrying unit span and resend".to_string()],
                ),
            );
        }
    };
    let contract = match intake::contract_for(descriptor) {
        Some(contract) => contract,
        None => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    "the selected descriptor carries no generation identity",
                    vec!["select an identity-carrying unit span and resend".to_string()],
                ),
            );
        }
    };
    let request = intake::BindRequest {
        path: params.file.clone(),
        revision: params.revision.clone(),
        start: params.start,
        end: params.end,
        source,
        contract,
        target,
    };
    let record = match intake::apply_bind(&saved, &request, &current_revision) {
        Ok(record) => record,
        Err(err) => {
            let code = match err {
                intake::BindError::StaleSelector { .. } => "stale-selector",
                intake::BindError::UnknownUnit { .. } => "unknown-unit",
                intake::BindError::KindMismatch { .. } => "kind-mismatch",
            };
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    code,
                    &err.to_string(),
                    vec!["re-inspect the source location and resend bind".to_string()],
                ),
            );
        }
    };
    let dir = root_path
        .join(intake::GENERATED_DIR)
        .join(record.id.as_str());
    if let Err(err) = std::fs::create_dir_all(&dir) {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "write-failed",
                &format!("cannot write '{}': {err}", dir.display()),
                vec!["check the project root is writable and resend".to_string()],
            ),
        );
    }
    let unit_path = dir.join(intake::UNIT_FILE);
    if let Err(err) = write_file_atomic(&unit_path, &record.to_json(), None) {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "write-failed",
                &format!("cannot write '{}': {err}", unit_path.display()),
                vec!["check the project root is writable and resend".to_string()],
            ),
        );
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "unit".to_string(),
        serde_json::json!({
            "id": record.id.as_str(),
            "path": unit_path.display().to_string(),
            "owner": record.source.owner,
            "kind": record.source.kind.as_str(),
            "label": record.source.label,
            "contract": contract_json(&record.contract),
        }),
    );
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(
            header,
            "bound",
            payload,
            vec!["send a generate request to produce the unit's outputs".to_string()],
        ),
    )
}

/// Shared admission for execution operations: load the selected
/// settings (explicit file or root file, never ambient search) and
/// surface configuration failures as error envelopes.
fn admit_execution_settings(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root: &str,
    settings: Option<&str>,
) -> Result<Option<crate::analysis::generation_config::LoadedSettings>, DispatchResult> {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    match config::load_settings(Path::new(root), settings) {
        Ok(loaded) => Ok(loaded),
        Err(err) => Err(gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                err.code(),
                &err.to_string(),
                vec!["fix the settings selection and resend".to_string()],
            ),
        )),
    }
}

/// Admit that every listed file opens for reading. Scope paths
/// resolve against the request root, never the process directory.
fn admit_readable_files(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root: &str,
    files: &[String],
) -> Result<(), DispatchResult> {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    for file in files {
        let path = config::resolve_against_root(Path::new(root), file);
        if std::fs::File::open(&path).is_err() {
            return Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "unreadable-input",
                    &format!("scope file '{}' does not open for reading", path.display()),
                    vec!["pass readable scope files and resend".to_string()],
                ),
            ));
        }
    }
    Ok(())
}

/// Admit that one unit id is well-formed and names a saved group.
/// Returns the saved record for category/agent resolution.
fn admit_saved_unit(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root: &str,
    unit_id: &str,
) -> Result<crate::analysis::generation_intake::UnitRecord, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let id = match intake::GenerationUnitId::parse(unit_id) {
        Ok(id) => id,
        Err(reason) => {
            return Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    &format!("`unit_id`: {reason}"),
                    vec!["pass a saved unit id (see a status report)".to_string()],
                ),
            ));
        }
    };
    let (saved, _) = load_gen_saved(Path::new(root));
    match saved.into_iter().find(|record| record.id == id) {
        Some(record) => Ok(record),
        None => Err(gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "unknown-unit",
                &format!("no saved unit `{unit_id}` under {root}"),
                vec!["send a status request to list saved units".to_string()],
            ),
        )),
    }
}

/// JSON `generate`: admit scope, settings, and the pinned recipe
/// (when the request pins one profile or runner), then run the
/// pre-launch preflight. Multi-recipe job grouping and capture join
/// through BGI-05, so unpinned requests stop at `not-implemented`
/// after full admission.
fn run_gen_generate(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::GenerateParams,
) -> DispatchResult {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    let loaded = match admit_execution_settings(header, &params.root, params.settings.as_deref()) {
        Ok(loaded) => loaded,
        Err(error) => return error,
    };
    if let Some(files) = &params.files
        && let Err(error) = admit_readable_files(header, &params.root, files)
    {
        return error;
    }
    if let Some(ids) = &params.unit_ids {
        for id in ids {
            if let Err(error) = admit_saved_unit(header, &params.root, id) {
                return error;
            }
        }
    }
    let overrides = params.overrides();
    let pinned = overrides.profile.is_some() || overrides.runner.is_some();
    if !pinned {
        return run_gen_not_implemented(
            header,
            params.root.clone(),
            "BGI-05 (capture, compatible-recipe job grouping, and execution)",
        );
    }
    // A pinned profile or runner determines the recipe alone; the
    // category default cannot change it, so Given is arbitrary here.
    let resolved = match config::resolve_recipe(
        loaded.as_ref(),
        config::RecipeCategory::Given,
        None,
        &overrides,
    ) {
        Ok(resolved) => resolved,
        Err(err) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    err.code(),
                    &err.to_string(),
                    vec!["fix the recipe selection and resend".to_string()],
                ),
            );
        }
    };
    if let Err(err) = config::preflight_recipe(&resolved) {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                err.code(),
                &err.to_string(),
                vec!["resolve the launch gate and resend".to_string()],
            ),
        );
    }
    run_gen_not_implemented(
        header,
        params.root.clone(),
        "BGI-05 (capture, compatible-recipe job grouping, and execution)",
    )
}

/// JSON `refine`: admit the exactly-one instruction carrier, scope,
/// settings, and the unit's effective recipe, then run the
/// pre-launch preflight. Candidate execution joins through BGI-05.
fn run_gen_refine(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::RefineParams,
    from_stdin: bool,
) -> DispatchResult {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    use crate::analysis::generation_protocol::InstructionCarrier;
    match params.carrier() {
        InstructionCarrier::Text(_) => {}
        InstructionCarrier::File(path) => {
            let resolved = config::resolve_against_root(Path::new(&params.root), &path);
            if std::fs::read_to_string(&resolved).is_err() {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        &header.request_id,
                        header.operation.as_str(),
                        "instruction-unreadable",
                        &format!("instruction file '{}' does not read", resolved.display()),
                        vec!["pass a readable instruction file and resend".to_string()],
                    ),
                );
            }
        }
        InstructionCarrier::Stdin => {
            if from_stdin {
                return gen_envelope_result(
                    exit::TOOL_FAILURE,
                    proto::error_envelope(
                        &header.request_id,
                        header.operation.as_str(),
                        "exclusive-carrier",
                        "instruction_stdin needs --request FILE; one stdin stream cannot carry both the request and the instruction",
                        vec!["send the request with --request FILE and pipe the instruction on stdin".to_string()],
                    ),
                );
            }
            match read_source_text(std::io::stdin()) {
                Ok(text) if text.is_empty() => {
                    return gen_envelope_result(
                        exit::TOOL_FAILURE,
                        proto::error_envelope(
                            &header.request_id,
                            header.operation.as_str(),
                            "invalid-param",
                            "the stdin instruction is empty",
                            vec!["pipe a non-empty instruction on stdin and resend".to_string()],
                        ),
                    );
                }
                Ok(_) => {}
                Err(err) => {
                    return gen_envelope_result(
                        exit::TOOL_FAILURE,
                        proto::error_envelope(
                            &header.request_id,
                            header.operation.as_str(),
                            "instruction-unreadable",
                            &format!("cannot read the stdin instruction: {err}"),
                            vec!["pipe a non-empty instruction on stdin and resend".to_string()],
                        ),
                    );
                }
            }
        }
    }
    let loaded = match admit_execution_settings(header, &params.root, params.settings.as_deref()) {
        Ok(loaded) => loaded,
        Err(error) => return error,
    };
    let record = match admit_saved_unit(header, &params.root, &params.unit_id) {
        Ok(record) => record,
        Err(error) => return error,
    };
    let resolved = match config::resolve_recipe(
        loaded.as_ref(),
        category_for_kind(record.source.kind),
        record.contract.profile.as_deref(),
        &params.overrides(),
    ) {
        Ok(resolved) => resolved,
        Err(err) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    err.code(),
                    &err.to_string(),
                    vec!["fix the recipe selection and resend".to_string()],
                ),
            );
        }
    };
    if let Err(err) = config::preflight_recipe(&resolved) {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                err.code(),
                &err.to_string(),
                vec!["resolve the launch gate and resend".to_string()],
            ),
        );
    }
    run_gen_not_implemented(
        header,
        params.root.clone(),
        "BGI-05 (capture and candidate execution)",
    )
}

/// JSON `retry`: admit the active-app source closure, settings, and
/// the pinned recipe (when the request pins one profile or runner),
/// then run the pre-launch preflight. Full fresh regrouped execution
/// joins through BGI-05, so unpinned requests stop at
/// `not-implemented` after full admission.
fn run_gen_retry(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::RetryParams,
) -> DispatchResult {
    use crate::analysis::generation_config as config;
    use crate::analysis::generation_protocol as proto;
    let loaded = match admit_execution_settings(header, &params.root, params.settings.as_deref()) {
        Ok(loaded) => loaded,
        Err(error) => return error,
    };
    if let Err(error) = admit_readable_files(header, &params.root, &params.files) {
        return error;
    }
    let overrides = params.overrides();
    let pinned = overrides.profile.is_some() || overrides.runner.is_some();
    if !pinned {
        return run_gen_not_implemented(
            header,
            params.root.clone(),
            "BGI-05 (capture, compatible-recipe job grouping, and execution)",
        );
    }
    // A pinned profile or runner determines the recipe alone; the
    // category default cannot change it, so Given is arbitrary here.
    let resolved = match config::resolve_recipe(
        loaded.as_ref(),
        config::RecipeCategory::Given,
        None,
        &overrides,
    ) {
        Ok(resolved) => resolved,
        Err(err) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    err.code(),
                    &err.to_string(),
                    vec!["fix the recipe selection and resend".to_string()],
                ),
            );
        }
    };
    if let Err(err) = config::preflight_recipe(&resolved) {
        return gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                err.code(),
                &err.to_string(),
                vec!["resolve the launch gate and resend".to_string()],
            ),
        );
    }
    run_gen_not_implemented(
        header,
        params.root.clone(),
        "BGI-05 (capture, compatible-recipe job grouping, and execution)",
    )
}

/// Admit `validate` selectors: one saved unit or readable files.
fn admit_validate(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::ValidateParams,
) -> Result<(), DispatchResult> {
    if let Some(unit_id) = &params.unit_id {
        admit_saved_unit(header, &params.root, unit_id)?;
    }
    if let Some(files) = &params.files {
        admit_readable_files(header, &params.root, files)?;
    }
    Ok(())
}

/// Admit `adopt` selectors: one saved unit plus readable files.
fn admit_adopt(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::AdoptParams,
) -> Result<(), DispatchResult> {
    admit_saved_unit(header, &params.root, &params.unit_id)?;
    admit_readable_files(header, &params.root, &params.files)?;
    Ok(())
}

/// Admit `accept` selectors: one saved unit or one attempt scope.
fn admit_accept(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::AcceptParams,
) -> Result<(), DispatchResult> {
    if let Some(unit_id) = &params.unit_id {
        admit_saved_unit(header, &params.root, unit_id)?;
    }
    Ok(())
}

/// Admit `cancel` selectors (non-empty session or request scope).
fn admit_cancel(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::CancelParams,
) -> Result<(), DispatchResult> {
    use crate::analysis::generation_protocol as proto;
    let empty = params
        .session_id
        .as_deref()
        .or(params.request.as_deref())
        .is_none_or(str::is_empty);
    if empty {
        return Err(gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "invalid-param",
                "cancel needs a non-empty `session_id` or `request`",
                vec!["select one pending scope and resend".to_string()],
            ),
        ));
    }
    Ok(())
}

/// Admit `reset` selectors (one non-empty unit, attempt, or session scope).
fn admit_reset(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::ResetParams,
) -> Result<(), DispatchResult> {
    use crate::analysis::generation_protocol as proto;
    if let Some(unit_id) = &params.unit_id {
        admit_saved_unit(header, &params.root, unit_id)?;
        return Ok(());
    }
    let scope = params.attempt.as_deref().or(params.session_id.as_deref());
    if scope.is_none_or(str::is_empty) {
        return Err(gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "invalid-param",
                "reset needs one non-empty `unit_id`, `attempt`, or `session_id`",
                vec!["select one pending scope and resend".to_string()],
            ),
        ));
    }
    Ok(())
}

/// Admit `edit.begin` selectors: one saved unit and/or openable paths.
fn admit_edit_begin(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::EditBeginParams,
) -> Result<(), DispatchResult> {
    if let Some(unit_id) = &params.unit_id {
        admit_saved_unit(header, &params.root, unit_id)?;
    }
    if let Some(paths) = &params.paths {
        admit_readable_files(header, &params.root, paths)?;
    }
    Ok(())
}

/// Unix-only PATH search: no Windows `PATHEXT` handling, and non-UTF8
/// `PATH` entries convert lossily. Sufficient for lane scope (CI is unix).
pub(crate) fn find_on_path(name: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    //! `can docs` CLI wiring tests (D05b): help, flag scoping, `--out`
    //! refusal, analysis-first failure (exit 10 with no spawn and no file
    //! write), the stdin/fixed-argv renderer boundary against stub
    //! platform binaries, and every failure mapping. Stub-spawn tests are
    //! unix-only (shebang scripts); all fixtures are hermetic temp files
    //! (no `PATH` or environment dependence).

    use super::{
        Analyzer, CatalogAnalyzer, OutputFormat, StubAnalyzer, dispatch_with, docs_out_refusal,
        run_docs_with_platform, stderr_tail,
    };
    use crate::diagnostic::{Diagnostic, DiagnosticResult};
    use crate::source::{SourceDb, SourceId, Span};
    use std::path::PathBuf;

    /// Clean shop source using no builtins (mirrors the `docs.rs`
    /// determinism fixture shape).
    const SHOP_SRC: &str =
        "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\nThen\n";

    /// Minimal catalog pinning the production analyzer (entries unused by
    /// the fixture; the version passes through to the reference model).
    const CATALOG_JSON: &str = r#"{
  "language_version": "1.0",
  "catalog_version": "2.5.0-test",
  "entries": [
    {"id": "count", "js": "count", "owner": "test", "kind": "builtin", "signature": "count(domain:C<T>)->int", "effects": "pure", "availability": "implemented"}
  ]
}"#;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    /// Unique scratch dir per test (pid + nanos + tag); removed on drop.
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("can-docs-cli-{}-{nanos}-{tag}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn write(&self, name: &str, text: &str) -> PathBuf {
            let path = self.dir.join(name);
            std::fs::write(&path, text).unwrap();
            path
        }

        /// Production analyzer over an explicit temp catalog (hermetic:
        /// no process environment or working directory is consulted).
        fn analyzer(&self) -> CatalogAnalyzer {
            let catalog = self.write("catalog.json", CATALOG_JSON);
            CatalogAnalyzer::new(Some(catalog), None, self.dir.clone())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Analyzer reporting one synthetic error (no program): the
    /// analysis-first failure path.
    struct ErrorAnalyzer {
        diagnostic: Diagnostic,
    }

    impl Analyzer for ErrorAnalyzer {
        fn analyze(&self, db: &SourceDb, tool_version: &str) -> DiagnosticResult {
            let mut result =
                DiagnosticResult::new(tool_version, crate::LANGUAGE_VERSION, crate::SCHEMA_VERSION);
            result.add_sources(db);
            result.push(self.diagnostic.clone());
            result.finish();
            result
        }
    }

    fn synthetic_error() -> ErrorAnalyzer {
        ErrorAnalyzer {
            diagnostic: Diagnostic::error(
                "E1001",
                "synthetic docs-test error".to_string(),
                Span::new(SourceId(0), 0, 1),
            ),
        }
    }

    #[test]
    fn docs_help_names_modes_and_refusal() {
        let analyzer = StubAnalyzer;
        let via_flag = dispatch_with(&argv(&["can", "docs", "--help"]), &analyzer);
        assert_eq!(via_flag.code, 0);
        assert!(via_flag.stderr.is_empty());
        for needle in [
            "can docs",
            "--locale=TAG",
            "--out=PATH",
            "FILE.can",
            "stdout",
            "app default",
            ".can",
            "never overwritten",
            "E7004",
            "Exit codes",
        ] {
            assert!(
                via_flag.stdout.contains(needle),
                "docs help misses {needle:?}:\n{}",
                via_flag.stdout
            );
        }
        let via_alias = dispatch_with(&argv(&["can", "help", "docs"]), &analyzer);
        assert_eq!(via_alias.code, 0);
        assert_eq!(via_alias.stdout, via_flag.stdout);
        let global = dispatch_with(&argv(&["can", "--help"]), &analyzer);
        assert_eq!(global.code, 0);
        assert!(global.stdout.contains("docs"), "global help misses docs");
        assert!(global.stdout.contains("--locale=TAG"));
        assert!(global.stdout.contains("--out=PATH"));
    }

    #[test]
    fn docs_requires_operands() {
        let result = dispatch_with(&argv(&["can", "docs"]), &StubAnalyzer);
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7001"), "{}", result.stderr);
        assert!(result.stderr.contains("FILE.can"), "{}", result.stderr);
    }

    #[test]
    fn locale_and_out_are_docs_only() {
        let analyzer = StubAnalyzer;
        // Rejected after another subcommand ...
        for args in [
            argv(&["can", "check", "--locale=nl", "f.can"]),
            argv(&["can", "check", "--out=x.md", "f.can"]),
            argv(&["can", "compile", "--locale", "nl", "f.can"]),
        ] {
            let result = dispatch_with(&args, &analyzer);
            assert_eq!(result.code, crate::exit::TOOL_FAILURE, "{args:?}");
            assert!(
                result.stderr.contains("E7001"),
                "{args:?}: {}",
                result.stderr
            );
            assert!(
                result.stderr.contains("only applies to can docs"),
                "{args:?}: {}",
                result.stderr
            );
        }
        // ... and before another subcommand ...
        let result = dispatch_with(&argv(&["can", "--locale=nl", "check", "f.can"]), &analyzer);
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stderr.contains("only applies to can docs"));
        // ... but accepted before `docs` (reaching the operands check).
        let result = dispatch_with(&argv(&["can", "--locale=nl", "docs"]), &analyzer);
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stderr.contains("expects at least one FILE.can"));
        // Empty values are usage errors, never silent defaults.
        for args in [
            argv(&["can", "docs", "--locale=", "f.can"]),
            argv(&["can", "docs", "--out=", "f.can"]),
        ] {
            let result = dispatch_with(&args, &analyzer);
            assert_eq!(result.code, crate::exit::TOOL_FAILURE, "{args:?}");
            assert!(result.stderr.contains("E7001"), "{}", result.stderr);
        }
    }

    #[test]
    fn out_refuses_can_sources_before_any_input_read() {
        // Nonexistent input + `.can` out: refusal (E7001) wins over the
        // unreadable-input error (E7002), proving the order.
        for out in ["ref.can", "REF.CAN", "generated/reference.can"] {
            let result = dispatch_with(
                &argv(&["can", "docs", "does-not-exist.can", &format!("--out={out}")]),
                &StubAnalyzer,
            );
            assert_eq!(result.code, crate::exit::TOOL_FAILURE, "out={out}");
            assert!(result.stdout.is_empty());
            assert!(result.stderr.contains("E7001"), "{}", result.stderr);
            assert!(
                result.stderr.contains("refuses '.can' paths"),
                "{}",
                result.stderr
            );
        }
        // `.can` detection is extension-based, not substring-based.
        assert!(docs_out_refusal("ref.md", &["a.can".to_string()]).is_none());
        assert!(docs_out_refusal("canary.md", &["a.can".to_string()]).is_none());
        assert!(docs_out_refusal("dir.can/ref.md", &["a.can".to_string()]).is_none());
        assert!(docs_out_refusal("ref.can", &["a.can".to_string()]).is_some());
    }

    #[test]
    fn out_refuses_to_overwrite_input_files() {
        // Non-`.can` input: the extension refusal would (correctly) fire
        // first on a `.can` path, hiding the self-overwrite branch.
        let scratch = Scratch::new("overwrite");
        let input = scratch.write("in.txt", SHOP_SRC);
        let input_str = input.to_string_lossy().into_owned();
        // Literal self-overwrite ...
        let result = run_docs_with_platform(
            std::slice::from_ref(&input_str),
            OutputFormat::Text,
            None,
            Some(input_str.clone()),
            &StubAnalyzer,
            None,
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(
            result.stderr.contains("overwrite an input"),
            "{}",
            result.stderr
        );
        // ... and the same file through a redundant-component spelling.
        let alias = format!("{}/./in.txt", scratch.dir.display());
        // Only meaningful when the input resolves (it does: we wrote it).
        let refusal = docs_out_refusal(&input_str, &[alias]);
        assert!(
            refusal.is_some_and(|reason| reason.contains("overwrite an input")),
            "canonical self-overwrite must refuse"
        );
    }

    #[test]
    fn diagnostics_fail_with_no_spawn_and_no_file_write() {
        let scratch = Scratch::new("diagnostics");
        let input = scratch.write("bad.can", SHOP_SRC);
        let out = scratch.dir.join("ref.md");
        let out_str = out.to_string_lossy().into_owned();
        // A garbage platform binary proves no spawn is attempted: the
        // diagnostics path returns before the renderer boundary.
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            Some("nl".to_string()),
            Some(out_str),
            &synthetic_error(),
            Some("/nonexistent/can-platform-docs-test".to_string()),
        );
        assert_eq!(result.code, crate::exit::DIAGNOSTICS);
        assert!(result.stderr.is_empty());
        assert!(result.stdout.contains("E1001"), "{}", result.stdout);
        assert!(
            !out.exists(),
            "failed analysis must not write the --out file"
        );
    }

    #[test]
    fn format_json_shapes_diagnostics_not_markdown() {
        let scratch = Scratch::new("format");
        let input = scratch.write("bad.can", SHOP_SRC);
        let operands = vec![input.to_string_lossy().into_owned()];
        let result = run_docs_with_platform(
            &operands,
            OutputFormat::Json,
            None,
            None,
            &synthetic_error(),
            None,
        );
        assert_eq!(result.code, crate::exit::DIAGNOSTICS);
        assert!(
            result.stdout.trim_start().starts_with('{'),
            "{}",
            result.stdout
        );
        assert!(result.stdout.contains("E1001"), "{}", result.stdout);
    }

    #[test]
    fn stub_backend_reports_needs_pipeline_before_spawn() {
        let scratch = Scratch::new("pipeline");
        let input = scratch.write("shop.can", SHOP_SRC);
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            None,
            None,
            &StubAnalyzer,
            Some("/nonexistent/can-platform-docs-test".to_string()),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stderr.contains("E7001"), "{}", result.stderr);
        assert!(
            result.stderr.contains("pipeline analyzer"),
            "{}",
            result.stderr
        );
    }

    #[test]
    fn missing_platform_binary_is_e7004() {
        let scratch = Scratch::new("missing");
        let input = scratch.write("shop.can", SHOP_SRC);
        let operands = vec![input.to_string_lossy().into_owned()];
        let analyzer = scratch.analyzer();
        // Absent path ...
        let result = run_docs_with_platform(
            &operands,
            OutputFormat::Text,
            None,
            None,
            &analyzer,
            Some(
                scratch
                    .dir
                    .join("no-such-binary")
                    .to_string_lossy()
                    .into_owned(),
            ),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7004"), "{}", result.stderr);
        assert!(result.stderr.contains("not a file"), "{}", result.stderr);
        // ... and a directory in place of the binary.
        let result = run_docs_with_platform(
            &operands,
            OutputFormat::Text,
            None,
            None,
            &analyzer,
            Some(scratch.dir.to_string_lossy().into_owned()),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stderr.contains("E7004"), "{}", result.stderr);
    }

    #[test]
    fn stderr_tail_caps_and_names_absence() {
        assert_eq!(stderr_tail(b""), "no detail on stderr");
        assert_eq!(stderr_tail(b"boom"), "boom");
        let long = "x".repeat(5000);
        let tail = stderr_tail(long.as_bytes());
        assert!(tail.starts_with("..."), "{tail:?}");
        assert_eq!(tail.len(), 2003);
        // Multibyte cut stays on a char boundary (never panics).
        let wide = "é".repeat(1500);
        let tail = stderr_tail(wide.as_bytes());
        assert!(tail.starts_with("..."));
        assert!(tail.contains("é"));
    }

    /// Write an executable stub platform binary (unix-only).
    #[cfg(unix)]
    fn stub_binary(scratch: &Scratch, name: &str, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch.write(name, &format!("#!/bin/sh\n{body}"));
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn renders_to_stdout_with_fixed_argv_and_stdin_payload() {
        let scratch = Scratch::new("stdout");
        let input = scratch.write("shop.can", SHOP_SRC);
        let args_marker = scratch.dir.join("args.txt");
        let stdin_marker = scratch.dir.join("stdin.json");
        // Baked marker paths (no shared env vars: tests run in parallel).
        let bin = stub_binary(
            &scratch,
            "platform-ok",
            &format!(
                "printf '%s' \"$*\" > '{}'\ncat > '{}'\nprintf '# Ref\\n'\n",
                args_marker.display(),
                stdin_marker.display()
            ),
        );
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            Some("nl".to_string()),
            None,
            &scratch.analyzer(),
            Some(bin),
        );
        assert_eq!(result.code, crate::exit::OK, "stderr: {}", result.stderr);
        assert_eq!(result.stdout, "# Ref\n");
        // Fixed argv: exactly `docs --locale=nl` (no shell, no extras).
        let args = std::fs::read_to_string(&args_marker).unwrap();
        assert_eq!(args, "docs --locale=nl");
        // Stdin carries the ReferenceModel v1 JSON payload.
        let payload = std::fs::read_to_string(&stdin_marker).unwrap();
        assert!(payload.starts_with(r#"{"version":1"#), "{payload:.120}");
        assert!(payload.contains(r#""appDefaultLocale""#), "{payload:.200}");
        assert!(payload.contains(r#""sourceRevision""#), "{payload:.200}");
    }

    #[cfg(unix)]
    #[test]
    fn renders_without_locale_omits_the_flag() {
        let scratch = Scratch::new("default-locale");
        let input = scratch.write("shop.can", SHOP_SRC);
        let args_marker = scratch.dir.join("args.txt");
        let bin = stub_binary(
            &scratch,
            "platform-default",
            &format!(
                "printf '%s' \"$*\" > '{}'\ncat > /dev/null\nprintf '# Ref\\n'\n",
                args_marker.display()
            ),
        );
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            // --format=json must not leak into the Markdown either.
            OutputFormat::Json,
            None,
            None,
            &scratch.analyzer(),
            Some(bin),
        );
        assert_eq!(result.code, crate::exit::OK, "stderr: {}", result.stderr);
        assert_eq!(result.stdout, "# Ref\n");
        let args = std::fs::read_to_string(&args_marker).unwrap();
        assert_eq!(args, "docs");
    }

    #[cfg(unix)]
    #[test]
    fn renderer_failure_reports_producer_detail_as_e7004() {
        let scratch = Scratch::new("render-fail");
        let input = scratch.write("shop.can", SHOP_SRC);
        let bin = stub_binary(
            &scratch,
            "platform-fail",
            "cat > /dev/null\nprintf 'renderer boom detail' >&2\nexit 2\n",
        );
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            None,
            None,
            &scratch.analyzer(),
            Some(bin),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stdout.is_empty(), "no partial Markdown on failure");
        assert!(result.stderr.contains("E7004"), "{}", result.stderr);
        assert!(result.stderr.contains("exit 2"), "{}", result.stderr);
        assert!(
            result.stderr.contains("renderer boom detail"),
            "{}",
            result.stderr
        );
    }

    #[cfg(unix)]
    #[test]
    fn renderer_output_is_drained_while_its_input_is_written() {
        let scratch = Scratch::new("renderer-duplex");
        let bin = stub_binary(
            &scratch,
            "platform-duplex",
            "head -c 262144 /dev/zero\nhead -c 262144 /dev/zero >&2\ncat > /dev/null\nprintf '# Ref\\n'\n",
        );
        let output = super::render_via_platform(&bin, None, &"x".repeat(262_144))
            .unwrap_or_else(|failure| panic!("{}", failure.stderr));
        assert_eq!(output.len(), 262_144 + "# Ref\n".len());
        assert!(output.as_bytes()[..262_144].iter().all(|byte| *byte == 0));
        assert!(output.ends_with("# Ref\n"));
    }

    #[cfg(unix)]
    #[test]
    fn failed_renderer_input_terminates_and_reaps_the_child() {
        let scratch = Scratch::new("closed-render-input");
        let pid_path = scratch.dir.join("renderer.pid");
        let bin = stub_binary(
            &scratch,
            "platform-closed-input",
            &format!(
                "printf '%s' $$ > '{}'\nexec 0<&-\nexec sleep 5\n",
                pid_path.display()
            ),
        );
        // More than a pipe buffer ensures closing stdin fails the write even
        // if the writer starts before the renderer closes its read endpoint.
        let result = super::render_via_platform(&bin, None, &"x".repeat(262_144));
        let failure = result.expect_err("closed input must fail the handoff");
        assert_eq!(failure.code, crate::exit::TOOL_FAILURE);
        assert!(failure.stdout.is_empty());
        assert!(failure.stderr.contains("E7004"));
        assert!(
            failure
                .stderr
                .contains("failed to pipe the reference model")
        );
        let pid = std::fs::read_to_string(pid_path).unwrap();
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .output()
            .unwrap()
            .status
            .success();
        if alive {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", pid.trim()])
                .output();
        }
        assert!(
            !alive,
            "renderer must be terminated and reaped before return"
        );
    }

    #[cfg(unix)]
    #[test]
    fn empty_and_non_utf8_output_are_e7004() {
        let scratch = Scratch::new("bad-output");
        let input = scratch.write("shop.can", SHOP_SRC);
        let operands = vec![input.to_string_lossy().into_owned()];
        let analyzer = scratch.analyzer();
        let empty = stub_binary(&scratch, "platform-empty", "cat > /dev/null\n");
        let result = run_docs_with_platform(
            &operands,
            OutputFormat::Text,
            None,
            None,
            &analyzer,
            Some(empty),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(
            result.stderr.contains("produced no output"),
            "{}",
            result.stderr
        );
        let binary = stub_binary(
            &scratch,
            "platform-binary",
            "cat > /dev/null\nprintf '\\377\\376'\n",
        );
        let result = run_docs_with_platform(
            &operands,
            OutputFormat::Text,
            None,
            None,
            &analyzer,
            Some(binary),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stderr.contains("non-UTF8"), "{}", result.stderr);
    }

    #[cfg(unix)]
    #[test]
    fn out_writes_the_file_and_stays_silent() {
        let scratch = Scratch::new("out-file");
        let input = scratch.write("shop.can", SHOP_SRC);
        let out = scratch.dir.join("ref.md");
        let bin = stub_binary(
            &scratch,
            "platform-out",
            "cat > /dev/null\nprintf '# Ref\\n'\n",
        );
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            None,
            Some(out.to_string_lossy().into_owned()),
            &scratch.analyzer(),
            Some(bin),
        );
        assert_eq!(result.code, crate::exit::OK, "stderr: {}", result.stderr);
        assert!(result.stdout.is_empty(), "file mode stays silent");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Ref\n");
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_out_is_e7007() {
        let scratch = Scratch::new("unwritable");
        let input = scratch.write("shop.can", SHOP_SRC);
        let missing_dir = scratch.dir.join("no-such-dir").join("ref.md");
        let bin = stub_binary(
            &scratch,
            "platform-e7007",
            "cat > /dev/null\nprintf '# Ref\\n'\n",
        );
        let result = run_docs_with_platform(
            &[input.to_string_lossy().into_owned()],
            OutputFormat::Text,
            None,
            Some(missing_dir.to_string_lossy().into_owned()),
            &scratch.analyzer(),
            Some(bin),
        );
        assert_eq!(result.code, crate::exit::TOOL_FAILURE);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.contains("E7007"), "{}", result.stderr);
    }
}
