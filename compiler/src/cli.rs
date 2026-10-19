//! Single dispatch for the `can` binary.
//!
//! `can compile|check|lint|fmt|explain|lsp|policy|docs|run|test|build|deploy|activate|dev|gen|validate|completions|help`,
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
    let args = if argv.is_empty() { &[][..] } else { &argv[1..] };
    let flag = parse_args(args)
        .ok()
        .and_then(|parsed| parsed.catalog)
        .map(PathBuf::from);
    let analyzer = CatalogAnalyzer::from_process(flag);
    let public_generation = std::env::var("CAN_GENERATION_COMPILER_ONLY").as_deref() != Ok("1");
    let result = dispatch_with_route(argv, &analyzer, public_generation);
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
    dispatch_with_route(argv, analyzer, false)
}

fn dispatch_help_command(parsed: &ParsedArgs) -> Option<DispatchResult> {
    if !parsed.help {
        return None;
    }
    Some(match &parsed.subcommand {
        None => DispatchResult::ok_stdout(global_help()),
        Some(cmd) if is_known_command(cmd) => DispatchResult::ok_stdout(command_help(cmd)),
        // Unknown commands stay E7001/exit 2 even with --help, matching
        // the non-help path (there is no help text to show for them).
        Some(unknown) => DispatchResult::tool_error(
            "E7001",
            format!("unknown command '{unknown}'; use can --help"),
        ),
    })
}

fn dispatch_core_command(
    cmd: &str,
    parsed: &ParsedArgs,
    analyzer: &dyn Analyzer,
) -> Option<DispatchResult> {
    Some(match cmd {
        "check" => run_check_like(
            cmd,
            &parsed.operands,
            parsed.format,
            analyzer,
            parsed.generation_root.as_deref(),
        ),
        "lint" => run_lint(&parsed.operands, parsed.format, parsed.fix, analyzer),
        "compile" => run_compile(
            &parsed.operands,
            parsed.format,
            analyzer,
            parsed.native_scenario_receipts,
            parsed.generation_root.as_deref(),
        ),
        "fmt" => {
            if parsed.format_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can fmt takes no --format flag".to_string(),
                ));
            }
            if parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can fmt takes no --catalog flag".to_string(),
                ));
            }
            run_fmt(&parsed.operands, parsed.fmt_check)
        }
        "explain" => {
            if parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can explain takes no --catalog flag".to_string(),
                ));
            }
            run_explain(&parsed.operands, parsed.format)
        }
        "policy" => run_policy(&parsed.operands, parsed.format, analyzer),
        "docs" => run_docs(
            &parsed.operands,
            parsed.format,
            parsed.locale.clone(),
            parsed.out.clone(),
            analyzer,
        ),
        _ => return None,
    })
}

fn dispatch_lsp_command(parsed: &ParsedArgs) -> Option<DispatchResult> {
    if parsed.format_set {
        return Some(DispatchResult::tool_error(
            "E7001",
            "can lsp takes no --format flag".to_string(),
        ));
    }
    if parsed.catalog_set {
        return Some(DispatchResult::tool_error(
            "E7001",
            "can lsp takes no --catalog flag".to_string(),
        ));
    }
    if !parsed.operands.is_empty() {
        return Some(DispatchResult::tool_error(
            "E7001",
            "can lsp takes no file arguments; it serves stdio".to_string(),
        ));
    }
    Some(DispatchResult {
        code: exit::OK,
        stdout: String::new(),
        stderr: String::new(),
        run_lsp: true,
    })
}

fn dispatch_gen_command(
    parsed: &ParsedArgs,
    public_generation: bool,
) -> DispatchResult {
    if parsed.catalog_set {
        return DispatchResult::tool_error(
            "E7001",
            "can gen takes no --catalog flag".to_string(),
        );
    }
    let source_mode = parsed
        .operands
        .first()
        .is_some_and(|file| Path::new(file).extension().is_some_and(|ext| ext == "can"));
    if source_mode && !parsed.request_set {
        return run_source_entry(
            "generate",
            &parsed.operands,
            parsed.format,
            parsed.retry,
            parsed.dry_run,
            parsed.settings.as_deref(),
            std::env::var("CAN_PLATFORM_BIN").ok(),
        );
    }
    if parsed.retry || parsed.dry_run || parsed.settings.is_some() {
        return DispatchResult::tool_error(
            "E7001",
            "--retry, --dry-run and --settings require can gen FILE.can".to_string(),
        );
    }
    run_gen(
        &parsed.operands,
        parsed.format,
        parsed.format_set,
        parsed.request.as_deref(),
        public_generation,
    )
}

fn dispatch_entry_command(
    cmd: &str,
    parsed: &ParsedArgs,
    public_generation: bool,
) -> Option<DispatchResult> {
    Some(match cmd {
        "completions" => {
            if parsed.format_set || parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can completions takes no --format or --catalog flag".to_string(),
                ));
            }
            run_completions(&parsed.operands)
        }
        "help" => {
            if parsed.format_set || parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can help takes no --format or --catalog flag".to_string(),
                ));
            }
            run_help(&parsed.operands)
        }
        "lsp" => return dispatch_lsp_command(parsed),
        "run" | "test" | "build" | "deploy" | "activate" => {
            if parsed.format_set || parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    format!(
                        "can {cmd} takes no can-side flags; everything after the subcommand passes through to can-platform"
                    ),
                ));
            }
            let platform_bin = std::env::var("CAN_PLATFORM_BIN").ok();
            run_thin_entry(cmd, &parsed.operands, platform_bin)
        }
        "dev" => {
            if parsed.format_set || parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can dev takes no can-side flags; arguments pass through to can-dev"
                        .to_string(),
                ));
            }
            run_dev_entry(&parsed.operands, std::env::var("CAN_DEV_BIN").ok())
        }
        "validate" => {
            if parsed.catalog_set {
                return Some(DispatchResult::tool_error(
                    "E7001",
                    "can validate takes no --catalog flag".to_string(),
                ));
            }
            run_source_entry(
                "validate",
                &parsed.operands,
                parsed.format,
                false,
                false,
                None,
                std::env::var("CAN_PLATFORM_BIN").ok(),
            )
        }
        "gen" => dispatch_gen_command(parsed, public_generation),
        _ => return None,
    })
}

fn dispatch_with_route(
    argv: &[String],
    analyzer: &dyn Analyzer,
    public_generation: bool,
) -> DispatchResult {
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
    if let Some(help) = dispatch_help_command(&parsed) {
        return help;
    }
    if parsed.version {
        return DispatchResult::ok_stdout(version_text());
    }
    let Some(cmd) = &parsed.subcommand else {
        return DispatchResult::ok_stdout(global_help());
    };
    if let Some(out) = dispatch_core_command(cmd, &parsed, analyzer) {
        return out;
    }
    if let Some(out) = dispatch_entry_command(cmd, &parsed, public_generation) {
        return out;
    }
    DispatchResult::tool_error(
        "E7001",
        format!("unknown command '{cmd}'; use can --help"),
    )
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
            | "validate"
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
    generation_root: Option<String>,
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
    retry: bool,
    dry_run: bool,
    settings: Option<String>,
    help: bool,
    version: bool,
}

fn parse_simple_flag(parsed: &mut ParsedArgs, arg: &str) -> bool {
    match arg {
        "--help" | "-h" => parsed.help = true,
        "--version" | "-V" => parsed.version = true,
        "--retry" => parsed.retry = true,
        "--dry-run" => parsed.dry_run = true,
        "--check" => parsed.fmt_check = true,
        "--fix" => parsed.fix = true,
        "--native-scenario-receipts" => parsed.native_scenario_receipts = true,
        _ => return false,
    }
    true
}

fn parse_root_settings_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if arg == "--generation-root" {
        *i += 1;
        parsed.generation_root =
            Some(args.get(*i).ok_or("--generation-root needs a path")?.clone());
    } else if let Some(value) = arg.strip_prefix("--generation-root=") {
        if value.is_empty() {
            return Err("--generation-root needs a path".into());
        }
        parsed.generation_root = Some(value.to_string());
    } else if arg == "--settings" || arg.starts_with("--settings=") {
        if parsed.settings.is_some() {
            return Err("--settings may only be supplied once".to_string());
        }
        let value = if let Some(value) = arg.strip_prefix("--settings=") {
            value
        } else {
            *i += 1;
            args.get(*i)
                .ok_or_else(|| "missing value for --settings; want a PATH".to_string())?
        };
        if value.is_empty() || value.starts_with("--") {
            return Err("--settings requires a non-empty PATH".to_string());
        }
        parsed.settings = Some(value.to_string());
    } else {
        return Ok(false);
    }
    Ok(true)
}

fn parse_path_valued_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if parse_root_settings_flag(args, i, parsed, arg)? {
        return Ok(true);
    }
    if let Some(value) = arg.strip_prefix("--catalog=") {
        parsed.catalog = Some(value.to_string());
        parsed.catalog_set = true;
    } else if arg == "--catalog" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --catalog; want a PATH".to_string())?;
        parsed.catalog = Some(value.clone());
        parsed.catalog_set = true;
    } else if let Some(value) = arg.strip_prefix("--locale=") {
        parsed.locale = Some(value.to_string());
        parsed.locale_set = true;
    } else if arg == "--locale" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --locale; want a BCP 47 tag".to_string())?;
        parsed.locale = Some(value.clone());
        parsed.locale_set = true;
    } else if let Some(value) = arg.strip_prefix("--out=") {
        parsed.out = Some(value.to_string());
        parsed.out_set = true;
    } else if arg == "--out" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --out; want a PATH".to_string())?;
        parsed.out = Some(value.clone());
        parsed.out_set = true;
    } else if let Some(value) = arg.strip_prefix("--request=") {
        parsed.request = Some(value.to_string());
        parsed.request_set = true;
    } else if arg == "--request" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --request; want a PATH".to_string())?;
        parsed.request = Some(value.clone());
        parsed.request_set = true;
    } else {
        return Ok(false);
    }
    Ok(true)
}

fn parse_valued_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if let Some(value) = arg.strip_prefix("--format=") {
        parsed.format = parse_format(value)?;
        parsed.format_set = true;
    } else if arg == "--format" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --format; want json|text".to_string())?;
        parsed.format = parse_format(value)?;
        parsed.format_set = true;
    } else if !parse_path_valued_flag(args, i, parsed, arg)? {
        return Ok(false);
    }
    Ok(true)
}

fn check_flag_scope(parsed: &ParsedArgs) -> Result<(), String> {
    if (parsed.retry || parsed.dry_run) && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--retry and --dry-run only apply to can gen FILE.can".to_string());
    }
    if parsed.settings.is_some() && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--settings only applies to can gen FILE.can".to_string());
    }
    if parsed.fmt_check && parsed.subcommand.as_deref() != Some("fmt") {
        return Err("--check only applies to can fmt".to_string());
    }
    if parsed.fix && parsed.subcommand.as_deref() != Some("lint") {
        return Err("--fix only applies to can lint".to_string());
    }
    if parsed.generation_root.is_some()
        && !matches!(parsed.subcommand.as_deref(), Some("check" | "compile"))
    {
        return Err("--generation-root is available for check and compile".into());
    }
    if parsed.native_scenario_receipts && parsed.subcommand.as_deref() != Some("compile") {
        return Err("--native-scenario-receipts only applies to can compile".to_string());
    }
    check_docs_flag_scope(parsed)
}

fn check_docs_flag_scope(parsed: &ParsedArgs) -> Result<(), String> {
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
    Ok(())
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
        generation_root: None,
        locale: None,
        locale_set: false,
        out: None,
        out_set: false,
        request: None,
        request_set: false,
        retry: false,
        dry_run: false,
        settings: None,
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
            if !parse_simple_flag(&mut parsed, arg)
                && !parse_valued_flag(args, &mut i, &mut parsed, arg)?
            {
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
    check_flag_scope(&parsed)?;
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
  gen       Generate and accept source-owned code (plus JSON and bind/status)
  validate  Compile, build and test saved output without AI
  completions  Print a shell completion script: can completions bash|zsh|fish
  help      Show help (global or `can help <COMMAND>`)

Options:
  --format=json|text   Machine or human output (check, compile, lint, explain, policy, gen, validate; docs diagnostics only)
  --catalog=PATH       Producer catalog (check, compile, lint, policy, docs; else CAN_CATALOG,
                       ./can-catalog.json, ./packages/values/dist/catalog.json)
  --native-scenario-receipts  Emit retained-result capture for the native State runtime (compile only)
  --retry              Regenerate all selected source units (gen FILE.can only)
  --dry-run            Report planned generation without changes (gen FILE.can only)
  --settings=PATH      Use an explicit generation settings file (gen FILE.can only)
  --locale=TAG         Reference locale (docs only; default is the app default + source fallback)
  --out=PATH           Write the reference to PATH instead of stdout (docs only; never a .can source)
  -h, --help           Show help (global or `can <COMMAND> --help`)
  -V, --version        Show version

Environment:
  CAN_CATALOG       Producer catalog path (below --catalog, above ./can-catalog.json)
  CAN_PLATFORM_BIN  Override path to the can-platform binary (run|test|build|deploy|activate|docs|gen|validate)
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
        "compile" => "can compile — analyze sources and emit the compile artifact\n\nUsage: can compile [--format=json|text] [--catalog=PATH] [--generation-root=PATH] [--native-scenario-receipts] FILE.can...\n\nText lists one emitted module path per line; json prints the artifact envelope. --generation-root selects the app output owner when sources move into subdirectories; saved locators stay relative to that root. --native-scenario-receipts emits complete supported retained-result capture for the native State runtime; use its Cloudflare runtime stdlib facade. Analysis or emission errors (E6006/E6007/E6008) report diagnostics instead of an artifact.\n\nExit codes: 0 emitted, 10 errors reported, 2 tool failure.\n".to_string(),
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
        "validate" => "can validate — validate saved output without AI\n\nUsage: can validate FILE.can [--format=json|text]\n\nCompiles the source and runs the platform build, examples and Playwright checks against saved output. Does not generate or repair output.\n\nExit codes: the platform validation exit code passes through; 2 for invalid usage or missing platform.\n".to_string(),
        "gen" => "can gen — generate source-owned code or dispatch a generation request\n\nUsage: can gen FILE.can [--retry] [--dry-run] [--settings=PATH] [--format=json|text]\n       can gen --request FILE\n       can gen < request.json\n       can gen status [--format=json|text] ROOT FILE.can...\n       can gen bind ROOT FILE.can START END REVISION UNIT|new\n\nFILE.can prepares and accepts missing generation outputs. --retry regenerates all selected units; --dry-run reports planned work without generation or acceptance. Source mode discovers the installed platform or a built checkout relative to the executable/source. --settings PATH (or --settings=PATH) selects an explicit file relative to the invoking working directory for preparation, retry and dry-run; no ancestor search runs.\n\nThe dispatcher reads one v1 JSON request (FILE, or stdin when bare)\nand prints exactly one final JSON envelope on stdout: version,\nrequest_id, operation, ok, state, the operation payload (units,\npaths, effective recipe, phases, validation summaries), structured\nerrors, and bounded next actions. Optional JSONL progress goes to\nstderr, ending in that envelope. Typed operations: doctor, status,\ninspect, bind, generate, refine, retry, resume, diff, preview,\nvalidate, adopt, accept, cancel, reset, rollback, edit.begin,\nedit.end, lease.recover. refine carries exactly one instruction\ncarrier: inline `instruction`, an `instruction_file` path, or\n`instruction_stdin` (with --request FILE only). Settings come from\nROOT/can.gen.toml or an explicit `settings` file (no ambient\nsearch); explicit run values override the selected complete\nrunner/model recipe, and a runner override requires an explicit\nmodel. JSON bind accepts copy_from with unit=new to fork current saved files without AI; binding an existing ID relocates its metadata and preserves code. status/bind keep their positional sugar above; status\nconsults no settings, recipe, or MCP server.\n\nExit codes: 0 requested outcome succeeded, 2 invalid\nrequest/config/selection, 3 conflict/held lease, 4 validation\nfailure, 5 runner failure, 6 unknown completion.\n".to_string(),
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
    generation_root: Option<&str>,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {cmd} expects at least one FILE.can operand"),
        );
    }
    let saved_roots = generation_root
        .map(|root| vec![PathBuf::from(root)])
        .unwrap_or_else(|| compile_saved_roots(operands));
    let mut db = match frozen_source_db(operands, &saved_roots) {
        Ok(db) => db,
        Err(error) => return error,
    };
    let mut owned = analyzer.analyze_owned(&db, tool_version());
    if let Some(program) = &mut owned.program {
        prepare_saved_given(
            &mut db,
            program,
            owned.catalog.as_ref(),
            &saved_roots,
            &mut owned.result,
        );
    }
    let mut result = owned.result;
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
    generation_root: Option<&str>,
) -> DispatchResult {
    if operands.is_empty() {
        return DispatchResult::tool_error(
            "E7001",
            "can compile expects at least one FILE.can operand".to_string(),
        );
    }
    let saved_roots = generation_root
        .map(|root| vec![PathBuf::from(root)])
        .unwrap_or_else(|| compile_saved_roots(operands));
    let mut db = match frozen_source_db(operands, &saved_roots) {
        Ok(db) => db,
        Err(error) => return error,
    };
    let owned = analyzer.analyze_owned(&db, tool_version());
    let mut result = owned.result;
    result.finish();
    let Some(mut program) = owned.program else {
        return DispatchResult::tool_error(
            "E7001",
            "can compile needs a pipeline analyzer; this backend keeps no checked program (production dispatch always passes one)".to_string(),
        );
    };
    // Saved production joins: consumed generation units resolve to
    // their current saved groups before emission, so missing or
    // incompatible inputs diagnose (exit 10, no artifact) instead of
    // compiling silently without them. Repeat saved builds stay
    // zero-AI: this path never invokes generation, it only reads
    // current saved bytes.
    let given_join = prepare_saved_given(
        &mut db,
        &mut program,
        owned.catalog.as_ref(),
        &saved_roots,
        &mut result,
    );
    // The Then join resolves here for coverage and packing; emission
    // re-resolves the same inputs deterministically for renderer
    // calls. Coverage failures block before emission.
    let then_join = crate::codegen::js::ThenBuildJoin::resolve(&db);
    for (span, detail) in then_join.missing() {
        result.push(crate::diagnostic::Diagnostic::error(
            "E6008",
            detail.clone(),
            *span,
        ));
    }
    result.finish();
    if result.has_errors() {
        return emit_diagnostics(&result, &db, format);
    }
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
    let mut artifact = artifact;
    // Saved modules stage once, in staged-path order, after both
    // joins contribute their packed units.
    let mut staged: Vec<crate::codegen::artifact::SavedUnitModule> = Vec::new();
    if let Some(join) = given_join
        && let Err(diagnostic) = attach_saved_given(&mut artifact, &join, &db, &mut staged)
    {
        result.push(diagnostic);
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    if let Err(diagnostic) = attach_saved_then(&mut artifact, &then_join, &db, &mut staged) {
        result.push(diagnostic);
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    if let Err(detail) = crate::codegen::artifact::stage_saved_unit_modules(&mut artifact, &staged)
    {
        let primary = db
            .iter()
            .next()
            .map(|(id, _)| Span::new(id, 0, 0))
            .unwrap_or(Span::new(SourceId(0), 0, 0));
        result.push(crate::diagnostic::Diagnostic::error(
            "E6008",
            format!("cannot lower saved implementations: {detail}"),
            primary,
        ));
        result.finish();
        return emit_diagnostics(&result, &db, format);
    }
    let stdout = match format {
        OutputFormat::Json => format!("{}\n", crate::codegen::artifact::to_json(&artifact)),
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

/// Load source and saved implementation from one lease-protected snapshot.
fn frozen_source_db(operands: &[String], roots: &[PathBuf]) -> Result<SourceDb, DispatchResult> {
    let frozen = std::sync::Arc::new(
        crate::analysis::generation_store::FrozenGeneration::capture(roots).map_err(|error| {
            DispatchResult::tool_error("E7002", format!("cannot capture generated inputs: {error}"))
        })?,
    );
    let mut db = SourceDb::new();
    for path in operands {
        let text = frozen.source(Path::new(path)).ok_or_else(|| {
            DispatchResult::tool_error(
                "E7002",
                format!(
                    "source '{path}' is outside the selected generation root or was not captured"
                ),
            )
        })?;
        add_source(&mut db, path.clone(), text.to_string())?;
    }
    db.generation = Some(frozen);
    Ok(db)
}

/// Saved-unit roots for one compilation: the distinct parent
/// directories of the operand files, each contributing its
/// `can.generated/` records. Operands without a parent directory
/// resolve against the current directory.
fn compile_saved_roots(operands: &[String]) -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for operand in operands {
        let root = Path::new(operand)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let root = if root.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            root
        };
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let canonical = roots
        .iter()
        .map(|root| root.canonicalize().unwrap_or_else(|_| root.clone()))
        .collect::<Vec<_>>();
    roots
        .into_iter()
        .enumerate()
        .filter(|(index, _)| {
            !canonical.iter().enumerate().any(|(other, parent)| {
                other != *index
                    && canonical[*index] != *parent
                    && canonical[*index].starts_with(parent)
            })
        })
        .map(|(_, root)| root)
        .collect()
}

/// Checked saved Given inputs for one compilation: the BGI-07
/// contract tables plus the consumed groups/units that feed artifact
/// packing. Built before emission; missing or incompatible inputs
/// diagnose instead of compiling silently without them.
struct GivenJoin {
    tables: crate::analysis::types::GivenContractTables,
    groups: std::collections::HashMap<String, crate::analysis::generation_intake::SavedGroup>,
    units: std::collections::HashMap<
        crate::analysis::generation_intake::AssociationKey,
        crate::analysis::types::GivenSavedUnit,
    >,
}

/// Reuse checked saved declarations for semantic checking and emission.
/// This reads owning saved inputs only; it neither generates nor emits JS.
fn prepare_saved_given(
    db: &mut SourceDb,
    program: &mut crate::analysis::CheckedProgram,
    catalog: Option<&crate::analysis::catalog::Catalog>,
    roots: &[PathBuf],
    result: &mut DiagnosticResult,
) -> Option<GivenJoin> {
    let mut given_result = DiagnosticResult::new(
        tool_version(),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION,
    );
    let join = join_saved_given(db, program, roots, &mut given_result);
    if let Some(join) = &join
        && catalog.is_some()
        && !given_result.has_errors()
    {
        let files = program.checked_files().to_vec();
        let (joined, diagnostics) =
            crate::analysis::check_program_with_given(db, &files, catalog, Some(&join.tables));
        *program = joined;
        result.diagnostics = diagnostics;
        result.sources.clear();
        result.add_sources(db);
    }
    result.diagnostics.extend(given_result.diagnostics);
    join
}

/// Join consumed Given definitions to their current saved groups and
/// check the BGI-07 contracts. Consumed means applied: a named trait
/// or keyword with no application, and any definition without a
/// matching saved record, stays pending generation — only applied
/// definitions without a bound unit diagnose. Diagnostics (missing
/// units, unreadable groups, contract failures) merge into `result`
/// as errors; the caller blocks emission on them. Carriers join the
/// database after the program check, exactly as validation does, so
/// checked-program ids stay stable.
fn join_saved_given(
    db: &mut SourceDb,
    program: &crate::analysis::CheckedProgram,
    _roots: &[std::path::PathBuf],
    result: &mut DiagnosticResult,
) -> Option<GivenJoin> {
    use crate::analysis::generation::{GenerationKind, discover_program};
    use crate::analysis::generation_intake as intake;
    let found = discover_program(db, program.checked_files());
    let mut defs: Vec<&crate::analysis::generation::GenerationDescriptor> = found
        .descriptors
        .iter()
        .filter(|d| {
            matches!(
                d.kind,
                GenerationKind::NamedTrait
                    | GenerationKind::InlineTrait
                    | GenerationKind::KeywordDefinition
            )
        })
        .collect();
    if defs.is_empty() {
        return None;
    }
    defs.sort_by_key(|d| (d.span.file.0, d.span.start));
    // Applied definitions consume their saved unit; unapplied ones are
    // pending generation and stay silent. Inline attachments apply at
    // their own target, always.
    let applied = |def: &crate::analysis::generation::GenerationDescriptor| -> bool {
        match def.kind {
            GenerationKind::InlineTrait => true,
            GenerationKind::NamedTrait => found.descriptors.iter().any(|d| {
                d.kind == GenerationKind::TraitApplication
                    && d.owner == def.owner
                    && d.label == def.label
            }),
            GenerationKind::KeywordDefinition => found.descriptors.iter().any(|d| {
                d.kind == GenerationKind::KeywordApplication
                    && d.owner == def.owner
                    && d.label == def.label
            }),
            _ => false,
        }
    };
    let mut saved: std::collections::HashMap<
        intake::AssociationKey,
        crate::analysis::types::GivenSavedUnit,
    > = std::collections::HashMap::new();
    let mut groups: std::collections::HashMap<String, intake::SavedGroup> =
        std::collections::HashMap::new();
    let mut failed = false;
    for def in defs {
        if !applied(def) {
            continue;
        }
        let Some(kind) = intake::UnitKind::of_descriptor(def.kind) else {
            continue;
        };
        let key = intake::AssociationKey {
            owner: def.owner.clone(),
            kind,
            label: def.label.clone(),
            anchor: def.anchor.clone(),
        };
        let what = match def.kind {
            GenerationKind::NamedTrait => {
                format!("trait `{}`", def.label.as_deref().unwrap_or_default())
            }
            GenerationKind::InlineTrait => "inline trait".to_string(),
            _ => format!("keyword `{}`", def.label.as_deref().unwrap_or_default()),
        };
        let resolved = db
            .generation
            .as_ref()
            .ok_or_else(|| "saved input snapshot unavailable".to_string())
            .and_then(|snapshot| snapshot.resolve(db, &key, def.span));
        let (staged_id, group) = match resolved {
            Ok(Some(group)) => group,
            Ok(None) => {
                result.push(crate::diagnostic::Diagnostic::error("E6008", format!("cannot lower {what}: no saved unit is bound to {}; prepare the unit (action: generate)", key.describe()), def.span));
                failed = true;
                continue;
            }
            Err(detail) => {
                result.push(crate::diagnostic::Diagnostic::error(
                    "E6008",
                    format!("cannot lower {what}: {detail} (action: bind)"),
                    def.span,
                ));
                failed = true;
                continue;
            }
        };
        let id = intake::GenerationUnitId::parse(&staged_id).expect("validated staged identity");
        match given_saved_unit(db, def, &id, &group) {
            Ok(unit) => {
                groups.insert(id.as_str().to_string(), group);
                saved.insert(key, unit);
            }
            Err(detail) => {
                result.push(crate::diagnostic::Diagnostic::error(
                    "E6008",
                    format!("cannot lower {what}: {detail}"),
                    def.span,
                ));
                failed = true;
            }
        }
    }
    if failed {
        return None;
    }
    if saved.is_empty() {
        return None;
    }
    let (tables, mut diags) = crate::analysis::check::check_given_contracts(
        &crate::analysis::check::GivenContractInputs {
            db,
            program,
            saved: &saved,
        },
    );
    for diagnostic in diags.drain(..) {
        result.push(diagnostic);
    }
    Some(GivenJoin {
        tables,
        groups,
        units: saved,
    })
}

/// Build one consumed unit's Given inputs from its saved group:
/// the contributions carrier (when present), the implementation
/// bytes plus their resolved import closure (keywords and field checks), and the
/// owner-visible declaration (keyword units).
fn given_saved_unit(
    db: &mut SourceDb,
    def: &crate::analysis::generation::GenerationDescriptor,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
) -> Result<crate::analysis::types::GivenSavedUnit, String> {
    use crate::analysis::generation::GenerationKind;
    let mut contributions = None;
    if let Some(carrier) = group
        .files
        .iter()
        .find(|f| f.rel_path == "contributions.can")
    {
        // A keyword carrier passes through so the Given check refuses
        // it as hidden authority instead of validating hidden bytes.
        let text = String::from_utf8_lossy(&carrier.bytes).into_owned();
        contributions = Some(db.add(
            format!(
                "{}/{}/contributions.can",
                crate::analysis::generation_intake::GENERATED_DIR,
                id.as_str()
            ),
            text,
        ));
    }
    let mut implementation_js = None;
    let mut implementation_imports = Vec::new();
    if let Some(file) = group
        .files
        .iter()
        .find(|f| f.rel_path == "implementation.js")
    {
        let js = String::from_utf8(file.bytes.clone()).map_err(|_| {
            format!(
                "unit `{}` `implementation.js` is not valid UTF-8; repair the file or reconcile with adopt",
                id.as_str(),
            )
        })?;
        if matches!(
            def.kind,
            GenerationKind::NamedTrait | GenerationKind::InlineTrait
        ) && !scan_js_module(&js)
            .exports
            .iter()
            .any(|export| export == crate::analysis::types::GIVEN_FIELD_VALIDATION_EXPORT)
        {
            return Err(format!(
                "unit `{id}` field validation implementation declares no `check` export in `implementation.js`"
            ));
        }
        implementation_imports =
            resolve_saved_js_closure(id, group, "implementation.js", &js, "workerd").map_err(
                |detail| format!("{detail}; fix the saved imports or reconcile with adopt"),
            )?;
        implementation_js = Some(js);
    }
    let mut declaration = None;
    if def.kind == GenerationKind::KeywordDefinition {
        declaration = Some(
            read_saved_declaration(id, group, def).map_err(|failure| failure.message.clone())?,
        );
    }
    Ok(crate::analysis::types::GivenSavedUnit {
        unit_id: id.as_str().to_string(),
        contributions,
        implementation_js,
        implementation_imports,
        declaration,
    })
}

/// Attach checked saved Given inputs to a freshly emitted artifact:
/// the `givenContracts` member, contributed trait fields merged into
/// the stored model descriptors, and packed keyword/field-check server modules
/// (with their import-closure siblings) appended to `staged`. Any
/// failure refuses the artifact with its diagnostic; the caller
/// reports it with exit 10 and no output.
fn attach_saved_given(
    artifact: &mut crate::codegen::artifact::CompileArtifact,
    join: &GivenJoin,
    db: &SourceDb,
    staged: &mut Vec<crate::codegen::artifact::SavedUnitModule>,
) -> Result<(), crate::diagnostic::Diagnostic> {
    use crate::codegen::artifact as art;
    let primary = db
        .iter()
        .next()
        .map(|(id, _)| Span::new(id, 0, 0))
        .unwrap_or(Span::new(SourceId(0), 0, 0));
    let fail = |detail: String| crate::diagnostic::Diagnostic::error("E6008", detail, primary);
    let given_ir = crate::codegen::ir::lower_given_contracts(&join.tables);
    if !given_ir.traits.is_empty() || !given_ir.keywords.is_empty() {
        artifact.given_contracts = Some(art::assemble_given_contracts(&given_ir, tool_version()));
    }
    if let Some(contracts) = artifact.given_contracts.as_ref() {
        if contracts
            .traits
            .iter()
            .any(|instance| instance.validation.is_some())
            && !artifact
                .requires
                .iter()
                .any(|requirement| requirement.capability == "state.field-validation")
        {
            artifact.requires.push(art::ArtifactRequirement {
                capability: "state.field-validation".into(),
                min_version: 1,
            });
        }
        for instance in &contracts.traits {
            if instance.target.split('.').count() == 2 {
                if let Some(model) = artifact
                    .models
                    .iter_mut()
                    .find(|model| model.name == instance.target)
                {
                    model.fields.retain(|field| {
                        !instance
                            .fields
                            .iter()
                            .any(|contributed| contributed.name == field.name)
                    });
                }
            }
        }
        art::merge_given_trait_fields(&mut artifact.models, &contracts.traits)
            .map_err(|detail| fail(format!("cannot lower saved trait contributions: {detail}")))?;
    }
    // Given server modules pack per checked contract: the expected
    // fingerprint is the contract's own closure hash, so pack refuses
    // any pairing skew between check and staging.
    if let Some(contracts) = artifact.given_contracts.as_ref() {
        let mut packed_units = std::collections::HashMap::<&str, &str>::new();
        let implementations = contracts
            .keywords
            .iter()
            .map(|rule| (rule.unit_id.as_str(), rule.fingerprint.as_str(), "keyword"))
            .chain(contracts.traits.iter().filter_map(|instance| {
                instance.validation.as_ref().map(|validation| {
                    (
                        instance.unit_id.as_str(),
                        validation.fingerprint.as_str(),
                        "trait",
                    )
                })
            }));
        for (unit_id, fingerprint, kind) in implementations {
            // Applications retain independent checked rules, while the
            // declaration owns one implementation and import closure.
            if let Some(previous) = packed_units.insert(unit_id, fingerprint) {
                if previous != fingerprint {
                    return Err(fail(format!(
                        "{kind} unit `{unit_id}` has inconsistent checked implementation fingerprints"
                    )));
                }
                continue;
            }
            let Some(group) = join.groups.get(unit_id) else {
                return Err(fail(format!(
                    "cannot lower {kind} unit `{unit_id}`: saved unit was not consumed by this build"
                )));
            };
            let owner = art::CanOwnerLink {
                unit_id: unit_id.to_string(),
                kind: group.record.source.kind.as_str().to_string(),
                can_path: group.record.source.path.clone(),
                can_revision: group.record.source.revision.clone(),
                start: group.record.source.start,
                end: group.record.source.end,
            };
            let root = group
                .files
                .iter()
                .find(|f| f.rel_path == "implementation.js")
                .map(|f| f.bytes.clone())
                .unwrap_or_default();
            let imports: Vec<crate::analysis::types::GivenSavedImport> = join
                .units
                .values()
                .find(|unit| unit.unit_id == unit_id)
                .map(|unit| unit.implementation_imports.clone())
                .unwrap_or_default();
            let mut packed = if imports.is_empty() {
                vec![
                    art::pack_saved_unit(group.record.source.kind, owner, &root, fingerprint)
                        .map_err(|detail| {
                            fail(format!(
                                "cannot lower saved {kind} implementation: {detail}"
                            ))
                        })?,
                ]
            } else {
                art::pack_saved_unit_closure(
                    group.record.source.kind,
                    owner,
                    &root,
                    &imports,
                    fingerprint,
                )
                .map_err(|detail| {
                    fail(format!(
                        "cannot lower saved {kind} implementation: {detail}"
                    ))
                })?
            };
            staged.append(&mut packed);
        }
    }
    Ok(())
}

/// Attach consumed Then inputs to a freshly emitted artifact: packed
/// stylesheets for consumed style units (plus view-colocated root
/// CSS), and staged view modules with their import-closure siblings
/// appended to `staged`. The view fingerprint is self-consistent by
/// construction (views carry no checked contract hash): pack still
/// enforces shape, UTF-8, and traversal rules, and refuses any
/// pairing skew it can see. Any failure refuses the artifact.
fn attach_saved_then(
    artifact: &mut crate::codegen::artifact::CompileArtifact,
    join: &crate::codegen::js::ThenBuildJoin,
    db: &SourceDb,
    staged: &mut Vec<crate::codegen::artifact::SavedUnitModule>,
) -> Result<(), crate::diagnostic::Diagnostic> {
    use crate::codegen::artifact as art;
    let primary = db
        .iter()
        .next()
        .map(|(id, _)| Span::new(id, 0, 0))
        .unwrap_or(Span::new(SourceId(0), 0, 0));
    let fail = |detail: String| crate::diagnostic::Diagnostic::error("E6008", detail, primary);
    let owner_of = |group: &crate::analysis::generation_intake::SavedGroup| art::CanOwnerLink {
        unit_id: group.record.id.as_str().to_string(),
        kind: group.record.source.kind.as_str().to_string(),
        can_path: group.record.source.path.clone(),
        can_revision: group.record.source.revision.clone(),
        start: group.record.source.start,
        end: group.record.source.end,
    };
    // Consumed style units pack their scoped CSS.
    let mut sheets: Vec<art::ArtifactStylesheet> = Vec::new();
    let mut style_ids: Vec<&String> = join.styles().keys().collect();
    style_ids.sort();
    for unit_id in style_ids {
        let group = &join.styles()[unit_id];
        let Some(css_file) = group.files.iter().find(|f| f.rel_path == "style.css") else {
            return Err(fail(format!(
                "unit `{unit_id}` has no saved `style.css`; repair the group or reconcile with adopt"
            )));
        };
        let css = String::from_utf8(css_file.bytes.clone()).map_err(|_| {
            fail(format!(
                "unit `{unit_id}` `style.css` is not valid UTF-8; repair the file or reconcile with adopt"
            ))
        })?;
        sheets.push(
            art::pack_saved_stylesheet_with_assets(
                group.record.source.kind,
                owner_of(group),
                &css,
                &group.files,
            )
            .map_err(|detail| fail(format!("cannot lower saved styles: {detail}")))?,
        );
    }
    // Consumed view units pack their renderer module (plus closure
    // siblings) and their colocated root CSS, when present.
    let mut view_ids: Vec<&String> = join.views().keys().collect();
    view_ids.sort();
    for unit_id in view_ids {
        let group = &join.views()[unit_id];
        let id = crate::analysis::generation_intake::GenerationUnitId::parse(unit_id)
            .map_err(|reason| fail(format!("saved unit id is malformed: {reason}")))?;
        // Adopted legacy views carry the handwritten renderer as
        // `server.js` instead of the v1 `implementation.js` module.
        let adopted = group.record.provenance.origin
            == crate::analysis::generation_intake::ProvenanceOrigin::Adopted;
        let module_rel = if group
            .files
            .iter()
            .any(|f| f.rel_path == "implementation.js")
        {
            "implementation.js"
        } else if adopted {
            "server.js"
        } else {
            "implementation.js"
        };
        let root = group
            .files
            .iter()
            .find(|f| f.rel_path == module_rel)
            .map(|f| f.bytes.clone())
            .unwrap_or_default();
        let root_text = String::from_utf8(root.clone()).map_err(|_| {
            fail(format!(
                "unit `{unit_id}` `{module_rel}` is not valid UTF-8; repair the file or reconcile with adopt"
            ))
        })?;
        let scan = scan_js_module(&root_text);
        if !scan.exports.iter().any(|name| name == "render") {
            return Err(fail(format!("view `{unit_id}` must export render")));
        }
        let module =
            art::saved_unit_module_path(group.record.source.kind, unit_id).map_err(&fail)?;
        let mut names: Vec<String> = join
            .resolved_shows()
            .filter(|show| show.unit_id == *unit_id)
            .map(|show| show.view_name.clone())
            .collect();
        names.sort();
        names.dedup();
        for view in names {
            artifact.generated_views.push(art::ArtifactGeneratedView {
                view,
                module: module.clone(),
                render_export: "render".to_string(),
                mount_export: scan
                    .exports
                    .iter()
                    .any(|name| name == "mount")
                    .then(|| "mount".to_string()),
            });
        }
        let closure =
            resolve_saved_js_closure(&id, group, module_rel, &root_text, "workerd/browser")
                .map_err(|detail| {
                    fail(format!(
                        "cannot lower view `{unit_id}`: {detail}; fix the saved imports or reconcile with adopt"
                    ))
                })?;
        let closure_refs: Vec<(&str, &[u8])> = closure
            .iter()
            .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
            .collect();
        let expected =
            crate::analysis::types::given_closure_fingerprint(root.as_slice(), &closure_refs);
        let mut packed = if closure.is_empty() {
            vec![
                art::pack_saved_unit(group.record.source.kind, owner_of(group), &root, &expected)
                    .map_err(|detail| {
                    fail(format!("cannot lower saved view implementation: {detail}"))
                })?,
            ]
        } else {
            art::pack_saved_unit_closure(
                group.record.source.kind,
                owner_of(group),
                &root,
                &closure,
                &expected,
            )
            .map_err(|detail| fail(format!("cannot lower saved view implementation: {detail}")))?
        };
        staged.append(&mut packed);
        if let Some(file) = group.files.iter().find(|f| f.rel_path == "style.css") {
            let css = String::from_utf8(file.bytes.clone()).map_err(|_| {
                fail(format!(
                    "unit `{unit_id}` `style.css` is not valid UTF-8; repair the file or reconcile with adopt"
                ))
            })?;
            sheets.push(
                art::pack_saved_stylesheet_with_assets(
                    group.record.source.kind,
                    owner_of(group),
                    &css,
                    &group.files,
                )
                .map_err(|detail| fail(format!("cannot lower saved styles: {detail}")))?,
            );
        }
    }
    sheets.sort_by(|a, b| a.path.cmp(&b.path));
    artifact.stylesheets.extend(sheets);
    Ok(())
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

/// [`run_docs`] with an explicit platform binary: the seam for the
/// renderer boundary (`None` searches `PATH`, mirroring `CAN_PLATFORM_BIN`
/// unset). Production [`dispatch`]
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
        None => match find_on_path("can-platform").or_else(|| checkout_platform(None)) {
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

/// Locate the built platform from an executable or source's checkout ancestors.
/// This uses only the package-owned entry point, never a fixture-specific script.
fn checkout_platform(source: Option<&Path>) -> Option<String> {
    // macOS may report the invoked symlink rather than its target. Discovery
    // follows the real executable's checkout, even from a user-local bin dir.
    let executable = std::env::current_exe()
        .ok()
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path));
    for anchor in source.into_iter().chain(executable.as_deref()) {
        for ancestor in anchor.ancestors().skip(1) {
            if !ancestor.join("packages/cloudflare/package.json").is_file() {
                continue;
            }
            let candidate = ancestor.join("packages/cloudflare/dist/cli/platform.js");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Source commands own their usage; the platform owns generation/validation.
/// Spawn directly with fixed argument boundaries and the current compiler.
fn run_source_entry(
    operation: &str,
    operands: &[String],
    format: OutputFormat,
    retry: bool,
    dry_run: bool,
    settings: Option<&str>,
    platform_bin: Option<String>,
) -> DispatchResult {
    let command_name = if operation == "generate" {
        "gen"
    } else {
        "validate"
    };
    let [source] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {command_name} expects exactly one FILE.can"),
        );
    };
    if Path::new(source).extension().is_none_or(|ext| ext != "can") {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {command_name} expects a .can source file"),
        );
    }
    let source = match std::fs::canonicalize(source) {
        Ok(path) if path.is_file() => path,
        Ok(_) => {
            return DispatchResult::tool_error("E7001", format!("source '{source}' is not a file"));
        }
        Err(error) => {
            return DispatchResult::tool_error(
                "E7001",
                format!("cannot read source '{source}': {error}"),
            );
        }
    };
    let selected = platform_bin
        .or_else(|| find_on_path("can-platform"))
        .or_else(|| checkout_platform(Some(&source)));
    let bin = match locate_platform_bin(selected, command_name) {
        Ok(bin) => bin,
        Err(error) => return error,
    };
    let mut command = std::process::Command::new(&bin);
    command.arg(operation).arg(source);
    if retry {
        command.arg("--retry");
    }
    if dry_run {
        command.arg("--dry-run");
    }
    if let Some(settings) = settings {
        // The platform resolves this public path against the unchanged caller cwd.
        command.arg(format!("--settings={settings}"));
    }
    command.arg(match format {
        OutputFormat::Json => "--format=json",
        OutputFormat::Text => "--format=text",
    });
    match std::env::current_exe() {
        Ok(executable) => {
            command.env("CAN_COMPILER_BIN", executable);
        }
        Err(error) => {
            return DispatchResult::tool_error(
                "E7004",
                format!("cannot locate current compiler: {error}"),
            );
        }
    }
    match command.status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(error) => {
            DispatchResult::tool_error("E7004", format!("failed to exec platform '{bin}': {error}"))
        }
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

fn read_fmt_inputs(operands: &[String]) -> Result<Vec<FmtInput>, DispatchResult> {
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
                return Err(DispatchResult::tool_error(
                    "E7001",
                    "duplicate `-` (stdin) operand".to_string(),
                ));
            }
            stdin_used = true;
            match read_source_text(std::io::stdin()) {
                Ok(text) => inputs.push(FmtInput {
                    name: "<stdin>".to_string(),
                    text,
                    dest: None,
                }),
                Err(err) => {
                    return Err(DispatchResult::tool_error(
                        "E7002",
                        format!("cannot read '<stdin>': {err}"),
                    ));
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
                return Err(DispatchResult::tool_error(
                    "E7002",
                    format!("cannot read '{operand}': {err}"),
                ));
            }
        }
    }
    Ok(inputs)
}

fn collect_fmt_outputs(
    inputs: &[FmtInput],
) -> Result<(SourceDb, Vec<String>, DiagnosticResult), DispatchResult> {
    // Format everything before writing anything: a parse failure anywhere
    // reports the aggregated envelope and leaves every file untouched.
    let mut db = SourceDb::new();
    let mut outputs: Vec<String> = Vec::with_capacity(inputs.len());
    let mut result = DiagnosticResult::new(
        tool_version(),
        crate::LANGUAGE_VERSION,
        crate::SCHEMA_VERSION,
    );
    for input in inputs {
        let id = match add_source(&mut db, input.name.clone(), input.text.clone()) {
            Ok(id) => id,
            Err(error) => return Err(error),
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
    Ok((db, outputs, result))
}

fn report_fmt_check(inputs: &[FmtInput], outputs: &[String]) -> Option<DispatchResult> {
    let mut differing = Vec::new();
    for (input, output) in inputs.iter().zip(outputs.iter()) {
        if *output != input.text {
            differing.push(input.name.clone());
        }
    }
    if differing.is_empty() {
        return Some(DispatchResult::ok_stdout(String::new()));
    }
    Some(DispatchResult {
        code: exit::DIAGNOSTICS,
        stdout: format!("{}\n", differing.join("\n")),
        stderr: String::new(),
        run_lsp: false,
    })
}

fn write_fmt_outputs(inputs: &[FmtInput], outputs: &[String]) -> DispatchResult {
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

fn run_fmt(operands: &[String], check: bool) -> DispatchResult {
    let inputs = match read_fmt_inputs(operands) {
        Ok(inputs) => inputs,
        Err(error) => return error,
    };
    let (db, outputs, mut result) = match collect_fmt_outputs(&inputs) {
        Ok(collected) => collected,
        Err(error) => return error,
    };
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
        if let Some(report) = report_fmt_check(&inputs, &outputs) {
            return report;
        }
    }
    write_fmt_outputs(&inputs, &outputs)
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
    public_generation: bool,
) -> DispatchResult {
    if request.is_some() || operands.is_empty() {
        return run_gen_request(operands, format_set, request, public_generation);
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
fn run_gen_request(
    operands: &[String],
    format_set: bool,
    request: Option<&str>,
    public_generation: bool,
) -> DispatchResult {
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
    if public_generation {
        return run_gen_platform(&text, request);
    }
    dispatch_gen_operation(&validated, from_stdin)
}

/// The executable's public generation requests use the existing Node host.
/// Compiler-owner child requests select the native handlers explicitly.
fn run_gen_platform(text: &str, request: Option<&str>) -> DispatchResult {
    let bin = match locate_platform_bin(std::env::var("CAN_PLATFORM_BIN").ok(), "gen") {
        Ok(bin) => bin,
        Err(error) => return error,
    };
    let mut command = std::process::Command::new(&bin);
    command.arg("gen");
    if std::env::var_os("CAN_COMPILER_BIN").is_none()
        && let Ok(executable) = std::env::current_exe()
    {
        command.env("CAN_COMPILER_BIN", executable);
    }
    if let Some(path) = request {
        // Refinement instructions may still arrive on the inherited stdin.
        command.args(["--request", path]);
        return match command.status() {
            Ok(status) => {
                gen_envelope_result(status.code().unwrap_or(exit::TOOL_FAILURE), String::new())
            }
            Err(error) => DispatchResult::tool_error(
                "E7004",
                format!("failed to exec generation host '{bin}': {error}"),
            ),
        };
    }
    command.stdin(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return DispatchResult::tool_error(
                "E7004",
                format!("failed to exec generation host '{bin}': {error}"),
            );
        }
    };
    if let Some(mut input) = child.stdin.take() {
        use std::io::Write;
        if let Err(error) = input.write_all(text.as_bytes()) {
            drop(input);
            let _ = child.kill();
            let _ = child.wait();
            return DispatchResult::tool_error(
                "E7004",
                format!("failed to pipe generation request to '{bin}': {error}"),
            );
        }
    }
    match child.wait() {
        Ok(status) => {
            gen_envelope_result(status.code().unwrap_or(exit::TOOL_FAILURE), String::new())
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            DispatchResult::tool_error(
                "E7004",
                format!("failed to wait for generation host '{bin}': {error}"),
            )
        }
    }
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
        GenParams::Validate(params) => run_gen_validate(&validated.header, params),
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
fn generation_source_path(root: &Path, file: &str) -> String {
    std::fs::canonicalize(root)
        .ok()
        .and_then(|root| {
            std::fs::canonicalize(file).ok().and_then(|source| {
                source
                    .strip_prefix(root)
                    .ok()
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
            })
        })
        .unwrap_or_else(|| file.to_string())
}

fn generation_source_file(root: &Path, file: &str) -> String {
    let path = Path::new(file);
    if path.is_absolute() {
        file.to_string()
    } else {
        let rooted = root.join(path);
        if rooted.is_file() {
            rooted.to_string_lossy().to_string()
        } else {
            file.to_string()
        }
    }
}

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
    allow_legacy_bind: bool,
) -> (
    Vec<crate::analysis::generation_intake::UnitRecord>,
    Vec<crate::analysis::generation_intake::IntakeIssue>,
) {
    use crate::analysis::generation_intake as intake;
    let mut saved = Vec::new();
    let mut issues = Vec::new();
    let names = match intake::scan_unit_ids(root) {
        Ok(names) => names,
        Err(detail) => {
            issues.push(intake::IntakeIssue {
                unit: intake::GENERATED_DIR.to_string(),
                action: intake::IntakeAction::Bind,
                detail,
            });
            return (saved, issues);
        }
    };
    for name in names {
        let id = match intake::GenerationUnitId::parse(&name) {
            Ok(id) => id,
            Err(_) => continue, // scan_unit_ids already validated; stay total.
        };
        let path = root
            .join(intake::GENERATED_DIR)
            .join(id.as_str())
            .join(intake::UNIT_FILE);
        if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            issues.push(intake::IntakeIssue {
                unit: id.as_str().to_string(),
                action: intake::IntakeAction::Bind,
                detail: format!(
                    "saved record {} must be a readable regular file",
                    path.display()
                ),
            });
            continue;
        }
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
            Err(_) if allow_legacy_bind && intake::is_legacy_bind_record(&text, &id) => {}
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
/// and always leaves saved groups intact on failure. Both entry points use
/// the same source/group leases and journaled metadata publication.
fn run_gen_bind(operands: &[String]) -> DispatchResult {
    use crate::analysis::generation_protocol as proto;
    let [root, file, start, end, revision, unit] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            "can gen bind expects ROOT FILE.can START END REVISION UNIT|new".into(),
        );
    };
    let (Ok(start), Ok(end)) = (start.parse::<u32>(), end.parse::<u32>()) else {
        return DispatchResult::tool_error(
            "E7001",
            "bind offsets must be unsigned integers".into(),
        );
    };
    if start > end {
        return DispatchResult::tool_error("E7001", "bind requires START<=END".into());
    }
    let result = run_gen_bind_json(
        &proto::RequestHeader {
            request_id: format!("bind-{}", std::process::id()),
            operation: proto::GenOperation::Bind,
        },
        &proto::BindParams {
            root: root.clone(),
            file: file.clone(),
            start,
            end,
            revision: revision.clone(),
            unit: unit.clone(),
            copy_from: None,
        },
    );
    if result.code != 0 {
        let error = serde_json::from_str::<serde_json::Value>(&result.stdout)
            .ok()
            .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| result.stderr.clone());
        return DispatchResult::tool_error("E7001", error);
    }
    let envelope: serde_json::Value = serde_json::from_str(&result.stdout).expect("bind envelope");
    DispatchResult::ok_stdout(format!(
        "bound {} {file}:{start}..{end} -> {}\n",
        envelope["unit"]["id"].as_str().unwrap(),
        envelope["unit"]["path"].as_str().unwrap()
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

struct GenScopeData {
    descriptors: Vec<crate::analysis::generation::GenerationDescriptor>,
    evidence: std::collections::HashMap<SourceId, crate::analysis::generation_intake::AssociationSource>,
    texts: std::collections::HashMap<String, String>,
}

fn collect_gen_scope_data(
    root_path: &Path,
    scope_files: &[String],
) -> Result<GenScopeData, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    let mut descriptors = Vec::new();
    let mut evidence = std::collections::HashMap::new();
    let mut texts = std::collections::HashMap::new();
    for (index, file) in scope_files.iter().enumerate() {
        let source_file = generation_source_file(root_path, file);
        let (_, _, text) = read_gen_source(&source_file)?;
        let id = SourceId(index as u32);
        let (tree, _) = crate::syntax::parse_source(id, &text);
        descriptors
            .extend(crate::analysis::generation::discover_generation(&tree, &text).descriptors);
        evidence.insert(
            id,
            intake::AssociationSource {
                path: file.clone(),
                revision: crate::source::sha256_hex(text.as_bytes()),
            },
        );
        texts.insert(file.clone(), text);
    }
    Ok(GenScopeData {
        descriptors,
        evidence,
        texts,
    })
}

#[allow(clippy::too_many_arguments)]
fn report_retained_group(
    root: &str,
    root_path: &Path,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    descriptor: &crate::analysis::generation::GenerationDescriptor,
    kind: &str,
    label: &str,
    file: &str,
    source_path: &str,
    text: &str,
    prompt_changed: bool,
    lines: &mut Vec<String>,
    units_json: &mut Vec<serde_json::Value>,
    issues: &mut Vec<crate::analysis::generation_intake::IntakeIssue>,
) {
    use crate::analysis::generation_intake as intake;
    let group = intake::read_saved_group(root_path, id);
    let stale = if prompt_changed {
        " prompt-changed"
    } else {
        ""
    };
    match group {
        Ok(group) => {
            let prefix = format!("{}/{id}/", intake::GENERATED_DIR);
            let mut paths = vec![format!("{prefix}{}", intake::UNIT_FILE)];
            paths.extend(
                group
                    .files
                    .iter()
                    .map(|f| format!("{prefix}{}", f.rel_path)),
            );
            let inputs =
                match crate::source::ValidationInputs::bind(root_path, &paths) {
                    Ok(inputs) => inputs,
                    Err(error) => {
                        issues.push(intake::IntakeIssue {
                            unit: id.as_str().to_string(),
                            action: intake::IntakeAction::Bind,
                            detail: error.to_string(),
                        });
                        return;
                    }
                };
            let mut current_files: Vec<serde_json::Value> = inputs
                .files
                .iter()
                .map(|f| serde_json::json!({"path": f.path, "sha256": f.sha256}))
                .collect();
            current_files.push(serde_json::json!({"path": source_path, "sha256": crate::source::sha256_hex(text.as_bytes())}));
            current_files
                .sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
            let mut compiler_sources = vec![source_path.to_string()];
            if matches!(
                group.record.source.kind,
                intake::UnitKind::NamedTrait | intake::UnitKind::InlineTrait
            ) && group
                .files
                .iter()
                .any(|f| f.rel_path == "contributions.can")
            {
                compiler_sources.push(format!("{prefix}contributions.can"));
            }
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
                "current_files": current_files,
                "compiler_sources": compiler_sources,
                // BGI-12 capture seam (additive): the live
                // prompt text, the fresh descriptor
                // contract, and the descriptor span for
                // bind-new selection. Saved history stays
                // in unit.json; prompt_changed flags drift.
                "prompt": descriptor.prompt,
                "selector": descriptor.selector,
                "region": descriptor.region,
                "contract": intake::contract_for(descriptor)
                    .map(|contract| contract_json(&contract))
                    .unwrap_or(serde_json::Value::Null),
                "span": serde_json::json!({"start": descriptor.span.start, "end": descriptor.span.end}),
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

/// Collect one association report over explicit sources: saved
/// intake only, no settings, recipe, or MCP server consulted.
fn collect_gen_status(root: &str, files: &[String]) -> Result<GenStatusReport, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    let root_path = Path::new(root);
    let (saved, mut issues) = load_gen_saved(root_path, false);
    let mut lines: Vec<String> = Vec::new();
    let mut units_json: Vec<serde_json::Value> = Vec::new();
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut scope_files = crate::analysis::generation_store::source_files(root_path)
        .map_err(|error| DispatchResult::tool_error("E7002", error))?;
    for file in files {
        let resolved = generation_source_file(root_path, file);
        let relative = generation_source_path(root_path, &resolved);
        if !scope_files.contains(&relative) {
            scope_files.push(relative);
        }
    }
    scope_files.sort();
    scope_files.dedup();
    let GenScopeData {
        descriptors,
        evidence,
        texts,
    } = collect_gen_scope_data(root_path, &scope_files)?;
    let associations = intake::associate_with_sources(&descriptors, &saved, &evidence);
    for (_, association) in &associations {
        if let intake::UnitAssociation::Retained { id, .. } = association {
            matched.insert(id.as_str().to_string());
        }
    }
    for file in files {
        let source_file = generation_source_file(root_path, file);
        let source_path = generation_source_path(root_path, &source_file);
        let text = &texts[&source_path];
        for (index, association) in &associations {
            let descriptor = &descriptors[*index];
            if evidence[&descriptor.span.file].path != source_path {
                continue;
            }
            let kind = intake::UnitKind::of_descriptor(descriptor.kind)
                .map(|k| k.as_str())
                .unwrap_or("?");
            let label = descriptor.label.as_deref().unwrap_or("-");
            match &association {
                intake::UnitAssociation::Retained { id, prompt_changed } => {
                    matched.insert(id.as_str().to_string());
                    report_retained_group(
                        root,
                        root_path,
                        id,
                        descriptor,
                        kind,
                        label,
                        file,
                        &source_path,
                        text,
                        *prompt_changed,
                        &mut lines,
                        &mut units_json,
                        &mut issues,
                    );
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
                        // BGI-12 capture seam (additive): see retained.
                        "prompt": descriptor.prompt,
                                "selector": descriptor.selector,
                                "region": descriptor.region,
                        "contract": intake::contract_for(descriptor)
                            .map(|contract| contract_json(&contract))
                            .unwrap_or(serde_json::Value::Null),
                        "span": serde_json::json!({"start": descriptor.span.start, "end": descriptor.span.end}),
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
                        // BGI-12 capture seam (additive): see retained.
                        "prompt": descriptor.prompt,
                                "selector": descriptor.selector,
                                "region": descriptor.region,
                        "contract": intake::contract_for(descriptor)
                            .map(|contract| contract_json(&contract))
                            .unwrap_or(serde_json::Value::Null),
                        "span": serde_json::json!({"start": descriptor.span.start, "end": descriptor.span.end}),
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
            // BGI-12 capture seam (additive): orphaned units have no
            // live descriptor, so the seam fields stay null.
            "prompt": serde_json::Value::Null,
            "contract": serde_json::Value::Null,
            "span": serde_json::Value::Null,
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
    let (saved, _) = load_gen_saved(root_path, false);
    let scope_files = match crate::analysis::generation_store::source_files(root_path) {
        Ok(files) => files,
        Err(error) => return DispatchResult::tool_error("E7002", error),
    };
    let mut descriptors = Vec::new();
    let mut evidence = std::collections::HashMap::new();
    for (index, path) in scope_files.iter().enumerate() {
        let source_file = generation_source_file(root_path, path);
        let (_, _, text) = match read_gen_source(&source_file) {
            Ok(value) => value,
            Err(error) => return error,
        };
        let source_id = SourceId(index as u32);
        let (tree, _) = crate::syntax::parse_source(source_id, &text);
        descriptors
            .extend(crate::analysis::generation::discover_generation(&tree, &text).descriptors);
        evidence.insert(
            source_id,
            intake::AssociationSource {
                path: path.clone(),
                revision: crate::source::sha256_hex(text.as_bytes()),
            },
        );
    }
    let associations = intake::associate_with_sources(&descriptors, &saved, &evidence);
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
        if let Some((index, association)) =
            associations
                .iter()
                .find(|(_, association)| match association {
                    intake::UnitAssociation::Retained { id: retained, .. } => *retained == id,
                    intake::UnitAssociation::Ambiguous { candidates } => candidates.contains(&id),
                    _ => false,
                })
        {
            InspectedUnit::spanned(&descriptors[*index], association, &saved)
        } else {
            let mut orphaned = InspectedUnit::saved(record);
            orphaned.association = "orphaned".into();
            orphaned
        }
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
        let source_file = generation_source_file(root_path, &file);
        let source_path = generation_source_path(root_path, &source_file);
        let located = associations
            .iter()
            .filter(|(index, _)| {
                let descriptor = &descriptors[*index];
                evidence[&descriptor.span.file].path == source_path
                    && intake::UnitKind::of_descriptor(descriptor.kind).is_some()
                    && descriptor.span.start <= start
                    && end <= descriptor.span.end
            })
            .min_by_key(|(index, _)| {
                let span = descriptors[*index].span;
                (
                    span.start != start || span.end != end,
                    span.end - span.start,
                )
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
        InspectedUnit::spanned(&descriptors[*index], association, &saved)
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
struct BindScope {
    scope: Vec<String>,
    _binding_lease: crate::analysis::generation_store::HeldLease,
    _source_lease: crate::analysis::generation_store::HeldLease,
}

fn bind_acquire_scope(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::BindParams,
    root_path: &Path,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<BindScope, DispatchResult> {
    let _binding_lease = match crate::analysis::generation_store::HeldLease::acquire(
        root_path,
        &["can.generated/bindings"],
        crate::leases::LeaseMode::Write,
        &header.request_id,
    ) {
        Ok(lease) => lease,
        Err(error) => return Err(fail("conflict", error)),
    };
    if !crate::leases::unresolved_journals(root_path).is_empty() {
        return Err(fail(
            "unresolved-journal",
            "recover pending publication before binding".into(),
        ));
    }
    let scope = match crate::analysis::generation_store::source_files(root_path) {
        Ok(scope) => scope,
        Err(error) => return Err(fail("unreadable-input", error)),
    };
    let _source_lease = match crate::analysis::generation_store::HeldLease::acquire(
        root_path,
        &scope.iter().map(String::as_str).collect::<Vec<_>>(),
        crate::leases::LeaseMode::Read,
        &header.request_id,
    ) {
        Ok(lease) => lease,
        Err(error) => return Err(fail("conflict", error)),
    };
    Ok(BindScope {
        scope,
        _binding_lease,
        _source_lease,
    })
}

fn bind_read_target(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::BindParams,
) -> Result<crate::analysis::generation_intake::BindTarget, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    if params.unit == "new" {
        return Ok(intake::BindTarget::New);
    }
    match intake::GenerationUnitId::parse(&params.unit) {
        Ok(id) => Ok(intake::BindTarget::Existing(id)),
        Err(reason) => Err(gen_envelope_result(
            exit::TOOL_FAILURE,
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                "invalid-param",
                &format!("bind `unit`: {reason}"),
                vec!["pass a saved unit id or \"new\"".to_string()],
            ),
        )),
    }
}

struct BindPrepared {
    current_revision: String,
    descriptor: crate::analysis::generation::GenerationDescriptor,
    source_file: String,
    saved: Vec<crate::analysis::generation_intake::UnitRecord>,
    request: crate::analysis::generation_intake::BindRequest,
}

fn bind_prepare_request(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::BindParams,
    root_path: &Path,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<BindPrepared, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let target = bind_read_target(header, params)?;
    let source_file = generation_source_file(Path::new(&params.root), &params.file);
    let (_db, _id, text) = match read_gen_source(&source_file) {
        Ok(loaded) => loaded,
        Err(error) => {
            return Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "unreadable-input",
                    tool_message(&error.stderr),
                    vec!["pass a readable source file and resend".to_string()],
                ),
            ));
        }
    };
    let current_revision = crate::source::sha256_hex(text.as_bytes());
    let (tree, _) = crate::syntax::parse_source(SourceId(0), &text);
    let found = crate::analysis::generation::discover_generation(&tree, &text);
    let selected = found
        .descriptors
        .iter()
        .filter(|d| {
            intake::UnitKind::of_descriptor(d.kind).is_some()
                && d.span.start <= params.start
                && params.end <= d.span.end
        })
        .min_by_key(|d| {
            (
                d.span.start != params.start || d.span.end != params.end,
                d.span.end - d.span.start,
            )
        });
    let Some(descriptor) = selected else {
        return Err(gen_envelope_result(
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
        ));
    };
    let descriptor = descriptor.clone();
    let (saved, saved_issues) = load_gen_saved(root_path, true);
    if !saved_issues.is_empty() {
        return Err(fail(
            "invalid-saved-record",
            saved_issues
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    let source_path = generation_source_path(root_path, &source_file);
    if Path::new(&source_path).is_absolute() || source_path.split('/').any(|part| part == "..") {
        return Err(fail(
            "invalid-path",
            "source must be inside its selected generation root".into(),
        ));
    }
    if params.copy_from.is_some() && params.unit != "new" {
        return Err(fail("invalid-param", "copy_from requires unit=new".into()));
    }
    let source = match intake::association_for(&descriptor, &source_path, &params.revision) {
        Some(source) => source,
        None => {
            return Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    "the selected descriptor carries no generation identity",
                    vec!["select an identity-carrying unit span and resend".to_string()],
                ),
            ));
        }
    };
    let contract = match intake::contract_for(&descriptor) {
        Some(contract) => contract,
        None => {
            return Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    "the selected descriptor carries no generation identity",
                    vec!["select an identity-carrying unit span and resend".to_string()],
                ),
            ));
        }
    };
    let request = intake::BindRequest {
        path: source_path.clone(),
        revision: params.revision.clone(),
        start: params.start,
        end: params.end,
        source,
        contract,
        target,
    };
    Ok(BindPrepared {
        current_revision,
        descriptor,
        source_file,
        saved,
        request,
    })
}

fn bind_adopt_legacy(
    request_id: &str,
    root_path: &Path,
    request: &crate::analysis::generation_intake::BindRequest,
    saved: &mut Vec<crate::analysis::generation_intake::UnitRecord>,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<
    (
        Option<crate::analysis::generation_store::HeldLease>,
        Vec<crate::analysis::generation_intake::SavedFile>,
    ),
    DispatchResult,
> {
    use crate::analysis::generation_intake as intake;
    let intake::BindTarget::Existing(id) = &request.target else {
        return Ok((None, Vec::new()));
    };
    if saved.iter().any(|record| record.id == *id)
        || !root_path
            .join(intake::GENERATED_DIR)
            .join(id.as_str())
            .join(intake::UNIT_FILE)
            .exists()
    {
        return Ok((None, Vec::new()));
    }
    let paths = [
        format!("{}/{}", intake::GENERATED_DIR, id.as_str()),
        format!(
            "{}/{}/{}",
            intake::GENERATED_DIR,
            id.as_str(),
            intake::UNIT_FILE
        ),
    ];
    let lease = match crate::analysis::generation_store::HeldLease::acquire(
        root_path,
        &paths.iter().map(String::as_str).collect::<Vec<_>>(),
        crate::leases::LeaseMode::Write,
        request_id,
    ) {
        Ok(lease) => lease,
        Err(error) => return Err(fail("conflict", error)),
    };
    let dir = root_path.join(intake::GENERATED_DIR).join(id.as_str());
    let (record, files) =
        match intake::bind_legacy_unit(&dir, id, &request.source, &request.contract) {
            Ok(adopted) => adopted,
            Err(error) => return Err(fail("legacy-binding-refused", error)),
        };
    saved.push(record);
    Ok((Some(lease), files))
}

fn bind_apply_request(
    header: &crate::analysis::generation_protocol::RequestHeader,
    request: &crate::analysis::generation_intake::BindRequest,
    saved: &[crate::analysis::generation_intake::UnitRecord],
    current_revision: &str,
) -> Result<crate::analysis::generation_intake::UnitRecord, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    match intake::apply_bind(saved, request, current_revision) {
        Ok(record) => Ok(record),
        Err(err) => {
            let code = match err {
                intake::BindError::StaleSelector { .. } => "stale-selector",
                intake::BindError::UnknownUnit { .. } => "unknown-unit",
                intake::BindError::KindMismatch { .. } => "kind-mismatch",
                intake::BindError::AllocationFailed { .. } => "allocation-failed",
            };
            Err(gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    code,
                    &err.to_string(),
                    vec!["re-inspect the source location and resend bind".to_string()],
                ),
            ))
        }
    }
}

fn bind_check_slot(
    params: &crate::analysis::generation_protocol::BindParams,
    record: &mut crate::analysis::generation_intake::UnitRecord,
    saved: &[crate::analysis::generation_intake::UnitRecord],
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<Option<usize>, DispatchResult> {
    let copied = params
        .copy_from
        .as_ref()
        .and_then(|id| saved.iter().position(|record| record.id.as_str() == id));
    if params.copy_from.is_some() && copied.is_none() {
        return Err(fail(
            "unknown-unit",
            "copy_from does not name a saved unit".into(),
        ));
    }
    let previous = copied
        .and_then(|index| saved.get(index))
        .or_else(|| saved.iter().find(|old| old.id == record.id));
    if let Some(old) = previous {
        if old.source.kind != record.source.kind
            || old.contract.target != record.contract.target
            || old.contract.signature != record.contract.signature
        {
            return Err(fail(
                "contract-mismatch",
                "destination changes the saved implementation contract; saved code was preserved"
                    .into(),
            ));
        }
        record.original = old.original.clone();
        record.provenance = old.provenance.clone();
    }
    // An explicit operation may resolve uncertain correspondence, but it may
    // not replace a different unit already bound to this exact current slot.
    if saved.iter().any(|old| {
        old.id != record.id
            && old.source.path == record.source.path
            && old.source.revision == record.source.revision
            && old.source.start == record.source.start
            && old.source.end == record.source.end
    }) {
        return Err(fail(
            "occupied-binding",
            "destination already has a saved binding; no files changed".into(),
        ));
    }
    Ok(copied)
}

fn bind_scope_evidence(
    root_path: &Path,
    scope_files: &[String],
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<
    (
        Vec<crate::analysis::generation::GenerationDescriptor>,
        std::collections::HashMap<SourceId, crate::analysis::generation_intake::AssociationSource>,
    ),
    DispatchResult,
> {
    use crate::analysis::generation_intake as intake;
    let mut scope_descriptors = Vec::new();
    let mut scope_evidence = std::collections::HashMap::new();
    for (index, path) in scope_files.iter().enumerate() {
        let text = match read_source_file(root_path.join(path)) {
            Ok(text) => text,
            Err(error) => return Err(fail("unreadable-input", error.to_string())),
        };
        let source_id = SourceId(index as u32);
        let (tree, _) = crate::syntax::parse_source(source_id, &text);
        scope_descriptors
            .extend(crate::analysis::generation::discover_generation(&tree, &text).descriptors);
        scope_evidence.insert(
            source_id,
            intake::AssociationSource {
                path: path.clone(),
                revision: crate::source::sha256_hex(text.as_bytes()),
            },
        );
    }
    Ok((scope_descriptors, scope_evidence))
}

fn bind_check_bindings(
    descriptor: &crate::analysis::generation::GenerationDescriptor,
    record: &crate::analysis::generation_intake::UnitRecord,
    scope_descriptors: &[crate::analysis::generation::GenerationDescriptor],
    scope_evidence: &std::collections::HashMap<
        SourceId,
        crate::analysis::generation_intake::AssociationSource,
    >,
    saved: &[crate::analysis::generation_intake::UnitRecord],
    legacy_present: bool,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<(), DispatchResult> {
    use crate::analysis::generation_intake as intake;
    let current_bindings =
        intake::associate_with_sources(scope_descriptors, saved, scope_evidence);
    for (index, binding) in current_bindings {
        let live = &scope_descriptors[index];
        let is_destination = scope_evidence[&live.span.file].path == record.source.path
            && live.span.start == descriptor.span.start
            && live.span.end == descriptor.span.end;
        if legacy_present
            && is_destination
            && !matches!(&binding, intake::UnitAssociation::Retained { id, .. } if *id == record.id)
        {
            return Err(fail(
                "ambiguous-binding",
                "selected source has duplicate or ambiguous saved claims; no files changed".into(),
            ));
        }
        if let intake::UnitAssociation::Retained { id, .. } = binding {
            if is_destination && id != record.id {
                return Err(fail(
                    "occupied-binding",
                    "destination already retains a different saved unit; no files changed".into(),
                ));
            }
            if !is_destination && id == record.id {
                return Err(fail(
                    "unit-in-use",
                    "unit still belongs to another live source slot; use copy_from to fork it"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_publish_replacements(
    root_path: &Path,
    record: &crate::analysis::generation_intake::UnitRecord,
    legacy_files: &[crate::analysis::generation_intake::SavedFile],
    copied: Option<&crate::analysis::generation_intake::UnitRecord>,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> Result<Vec<crate::leases::Replacement>, DispatchResult> {
    use crate::analysis::generation_intake as intake;
    let mut replacements = Vec::new();
    // Legacy server modules keep their historical path and bytes. Publish only
    // the missing canonical entrypoint copy beside the canonical unit record.
    for file in legacy_files {
        if !root_path
            .join(intake::GENERATED_DIR)
            .join(record.id.as_str())
            .join(&file.rel_path)
            .exists()
        {
            replacements.push(crate::leases::Replacement {
                unit: record.id.as_str().to_string(),
                path: file.rel_path.clone(),
                bytes: file.bytes.clone(),
            });
        }
    }
    if let Some(old) = copied {
        if let Err(error) = intake::read_saved_group(root_path, &old.id) {
            return Err(fail("invalid-saved-group", error.to_string()));
        }
        let paths = match crate::leases::group_files(root_path, old.id.as_str()) {
            Ok(paths) => paths,
            Err(error) => return Err(fail("unreadable-input", error.to_string())),
        };
        for path in paths {
            if path == intake::UNIT_FILE {
                continue;
            }
            let bytes = match std::fs::read(
                root_path
                    .join(intake::GENERATED_DIR)
                    .join(old.id.as_str())
                    .join(&path),
            ) {
                Ok(bytes) => bytes,
                Err(error) => return Err(fail("unreadable-input", error.to_string())),
            };
            replacements.push(crate::leases::Replacement {
                unit: record.id.as_str().to_string(),
                path,
                bytes,
            });
        }
    }
    replacements.push(crate::leases::Replacement {
        unit: record.id.as_str().to_string(),
        path: intake::UNIT_FILE.into(),
        bytes: record.to_json().into_bytes(),
    });
    Ok(replacements)
}

#[allow(clippy::too_many_arguments)]
fn bind_publish(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root_path: &Path,
    record: &crate::analysis::generation_intake::UnitRecord,
    legacy_files: &[crate::analysis::generation_intake::SavedFile],
    copied: Option<&crate::analysis::generation_intake::UnitRecord>,
    source_file: &str,
    current_revision: &str,
    fail: &dyn Fn(&str, String) -> DispatchResult,
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let replacements =
        match collect_publish_replacements(root_path, record, legacy_files, copied, fail) {
            Ok(replacements) => replacements,
            Err(error) => return error,
        };
    if read_source_file(source_file)
        .ok()
        .is_none_or(|text| crate::source::sha256_hex(text.as_bytes()) != current_revision)
    {
        return fail(
            "stale-selector",
            "source changed during bind; saved code was preserved".into(),
        );
    }
    let run_id = format!(
        "bind-{}",
        intake::next_unit_id(&std::collections::HashSet::new()).as_str()
    );
    if let Err(error) =
        crate::leases::stage_journal(root_path, &run_id, &[record.id.as_str()], &replacements)
    {
        return fail("write-failed", error.to_string());
    }
    match crate::leases::commit_journal(root_path, &run_id) {
        Ok(crate::leases::CommitOutcome::Committed { .. }) => {}
        Ok(_) => {
            return fail(
                "conflict",
                format!("binding publication conflicted; recover run {run_id}"),
            );
        }
        Err(error) => return fail("write-failed", error.to_string()),
    }
    let unit_path = root_path
        .join(intake::GENERATED_DIR)
        .join(record.id.as_str())
        .join(intake::UNIT_FILE);
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

fn run_gen_bind_json(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::BindParams,
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let fail = |code: &str, message: String| {
        gen_envelope_result(
            if code == "conflict" {
                exit::GEN_CONFLICT
            } else {
                exit::TOOL_FAILURE
            },
            proto::error_envelope(
                &header.request_id,
                header.operation.as_str(),
                code,
                &message,
                vec!["re-inspect the source and reconcile with bind".into()],
            ),
        )
    };
    let root_path = Path::new(&params.root);
    let scope = match bind_acquire_scope(header, params, root_path, &fail) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let prepared = match bind_prepare_request(header, params, root_path, &fail) {
        Ok(prepared) => prepared,
        Err(error) => return error,
    };
    let mut saved = prepared.saved;
    let current_revision = prepared.current_revision;
    let descriptor = prepared.descriptor;
    let source_file = prepared.source_file;
    let request = prepared.request;
    let scope_files = &scope.scope;
    let (legacy_lease, legacy_files) = match bind_adopt_legacy(
        &header.request_id,
        root_path,
        &request,
        &mut saved,
        &fail,
    ) {
        Ok(adopted) => adopted,
        Err(error) => return error,
    };
    let _legacy_lease = legacy_lease;
    let mut record = match bind_apply_request(header, &request, &saved, &current_revision) {
        Ok(record) => record,
        Err(error) => return error,
    };
    let copied_index = match bind_check_slot(params, &mut record, &saved, &fail) {
        Ok(index) => index,
        Err(error) => return error,
    };
    let copied = copied_index.and_then(|index| saved.get(index));
    let (scope_descriptors, scope_evidence) =
        match bind_scope_evidence(root_path, scope_files, &fail) {
            Ok(evidence) => evidence,
            Err(error) => return error,
        };
    match bind_check_bindings(
        &descriptor,
        &record,
        &scope_descriptors,
        &scope_evidence,
        &saved,
        _legacy_lease.is_some(),
        &fail,
    ) {
        Ok(()) => {}
        Err(error) => return error,
    }
    let mut guards = vec![
        format!("{}/{}", intake::GENERATED_DIR, record.id.as_str()),
        format!(
            "{}/{}/{}",
            intake::GENERATED_DIR,
            record.id.as_str(),
            intake::UNIT_FILE
        ),
    ];
    if let Some(old) = copied {
        guards.push(format!("{}/{}", intake::GENERATED_DIR, old.id.as_str()));
    }
    let _unit_lease = if _legacy_lease.is_some() {
        None
    } else {
        match crate::analysis::generation_store::HeldLease::acquire(
            root_path,
            &guards.iter().map(String::as_str).collect::<Vec<_>>(),
            crate::leases::LeaseMode::Write,
            &header.request_id,
        ) {
            Ok(lease) => Some(lease),
            Err(error) => return fail("conflict", error),
        }
    };
    bind_publish(
        header,
        root_path,
        &record,
        &legacy_files,
        copied,
        &source_file,
        &current_revision,
        &fail,
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
    let (saved, _) = load_gen_saved(Path::new(root), false);
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

/// JSON `validate` (BGI-11): one finite validator dispatch by kind/target.
///
/// Unit scope checks one saved unit's declared exports/imports/assets
/// against its captured inputs and current bytes, using only that unit
/// kind's producer outputs — BGI-07 contracts for Given kinds, BGI-09
/// lowering for views, BGI-10 scoping for styles — never every kind.
/// Files scope checks directly repaired saved files byte-for-byte
/// against their owning units. Both scopes read files only: no
/// settings, provider, login, model, or MCP server is consulted, so a
/// clean checkout validates with zero AI processes.
///
/// Success exits 0 with state `validated` and the exact consumed
/// closure (source revision plus file hashes) for BGI-12 promotion
/// comparison. Interface/contract failures exit 4 with the exact unit
/// and a bounded next action; source/interface drift routes to
/// deterministic manual `adopt` (BGI-12), never to silent regeneration.
fn run_gen_validate(
    header: &crate::analysis::generation_protocol::RequestHeader,
    params: &crate::analysis::generation_protocol::ValidateParams,
) -> DispatchResult {
    if let Err(error) = admit_validate(header, params) {
        return error;
    }
    if let Some(unit_id) = &params.unit_id {
        validate_saved_unit(header, &params.root, unit_id)
    } else {
        validate_saved_files(header, &params.root, params.files.as_deref().unwrap_or(&[]))
    }
}

/// One validation failure: the exact unit/input, why, and what to do.
struct ValidationFailure {
    message: String,
    next: Vec<String>,
}

impl ValidationFailure {
    fn new(message: String, next: Vec<String>) -> Self {
        Self { message, next }
    }

    /// A source/interface drift that deterministic manual `adopt`
    /// (BGI-12) reconciles; validation never regenerates or repairs.
    fn drift(message: String) -> Self {
        Self {
            message,
            next: vec![
                "send an adopt request to reconcile the drift deterministically (BGI-12)"
                    .to_string(),
            ],
        }
    }
}

/// Render a validation failure as the exit-4 `validation-failure`
/// envelope. Admission failures (unknown unit, unreadable input) keep
/// their exit-2 envelopes from the `admit_*` helpers.
fn validation_failure_envelope(
    header: &crate::analysis::generation_protocol::RequestHeader,
    failure: ValidationFailure,
) -> DispatchResult {
    use crate::analysis::generation_protocol as proto;
    gen_envelope_result(
        exit::GEN_VALIDATION,
        proto::error_envelope(
            &header.request_id,
            header.operation.as_str(),
            "validation-failure",
            &failure.message,
            failure.next,
        ),
    )
}

/// One passed check for a validation envelope: stable name, verdict,
/// and a one-line detail.
fn validation_check(name: &str, detail: String) -> serde_json::Value {
    serde_json::json!({"name": name, "ok": true, "detail": detail})
}

/// Bounded next action for a BGI-02 intake issue surfaced by validation.
fn intake_issue_next(issue: &crate::analysis::generation_intake::IntakeIssue) -> Vec<String> {
    use crate::analysis::generation_intake::IntakeAction;
    match issue.action {
        IntakeAction::Generate => {
            vec!["send a generate request to prepare the unit's saved group".to_string()]
        }
        IntakeAction::Bind => {
            vec!["send a bind request to reconcile the unit's association".to_string()]
        }
        IntakeAction::Adopt => vec![ValidationFailure::drift(String::new()).next.remove(0)],
    }
}

/// First-line rendering of compiler diagnostics for envelopes: the
/// first `code message`, plus a count when more follow.
fn diagnostic_summary(diags: &[crate::diagnostic::Diagnostic]) -> String {
    let Some(first) = diags.first() else {
        return "no diagnostics".to_string();
    };
    let mut summary = format!("{} {}", first.code, first.message);
    if diags.len() > 1 {
        summary.push_str(&format!(" (+{} more)", diags.len() - 1));
    }
    summary
}

/// Whether a diagnostic's primary span falls inside `start..end`.
/// Validation fails a unit only on diagnostics about that unit's own
/// descriptor span; unrelated source problems stay out of scope.
fn diagnostic_in_span(diag: &crate::diagnostic::Diagnostic, start: u32, end: u32) -> bool {
    diag.primary.start >= start && diag.primary.end <= end
}

/// Runtime targets a validated unit kind runs on. The kind selects the
/// validator and its targets; the recorded declaration target (row
/// model, style host) is a drift input, not a runtime selector.
fn runtime_targets_for(
    kind: crate::analysis::generation_intake::UnitKind,
    has_implementation: bool,
) -> &'static [&'static str] {
    use crate::analysis::generation_intake::UnitKind;
    match kind {
        UnitKind::Keyword => &["workerd"],
        UnitKind::View => &["workerd", "browser"],
        UnitKind::Style | UnitKind::StyleInline | UnitKind::ViewStyleInline => &["css"],
        UnitKind::NamedTrait | UnitKind::InlineTrait if has_implementation => &["check", "workerd"],
        UnitKind::NamedTrait | UnitKind::InlineTrait => &["check"],
    }
}

/// Validate one saved unit by kind/target against its captured inputs
/// and current bytes. Admission already established the record exists.
fn validate_saved_unit(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root: &str,
    unit_id: &str,
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let root_path = Path::new(root);
    // Admission parsed this id and found its record; re-parse stays total.
    let id = match intake::GenerationUnitId::parse(unit_id) {
        Ok(id) => id,
        Err(reason) => {
            return gen_envelope_result(
                exit::TOOL_FAILURE,
                proto::error_envelope(
                    &header.request_id,
                    header.operation.as_str(),
                    "invalid-param",
                    &format!("`unit_id`: {reason}"),
                    vec!["pass a saved unit id (see a status report)".to_string()],
                ),
            );
        }
    };
    let group = match intake::read_saved_group(root_path, &id) {
        Ok(group) => group,
        Err(issue) => {
            let next = intake_issue_next(&issue);
            return validation_failure_envelope(
                header,
                ValidationFailure::new(issue.to_string(), next),
            );
        }
    };
    let record = &group.record;
    // The owning source is a captured validation input: it must exist
    // and be readable. The recorded path is workspace-relative, but a
    // bind may have carried an absolute path; joining handles both.
    let source_text = match std::fs::read_to_string(root_path.join(&record.source.path)) {
        Ok(text) => text,
        Err(_) => {
            return validation_failure_envelope(
                header,
                ValidationFailure::new(
                    format!(
                        "unit `{}` owning source `{}` is missing; restore the source or send a bind request to reconcile the unit",
                        id.as_str(),
                        record.source.path
                    ),
                    vec![
                        "restore the owning source, or send a bind request to reconcile the unit"
                            .to_string(),
                    ],
                ),
            );
        }
    };
    let (tree, parse_diags) = crate::syntax::parse_source(SourceId(0), &source_text);
    if !parse_diags.is_empty() {
        return validation_failure_envelope(
            header,
            ValidationFailure::new(
                format!(
                    "unit `{}` owning source `{}` does not parse: {}",
                    id.as_str(),
                    record.source.path,
                    diagnostic_summary(&parse_diags)
                ),
                vec!["fix the source errors and resend validate".to_string()],
            ),
        );
    }
    // Bind the unit to its current descriptor: same owner/kind, label,
    // and non-prompt anchor. Anything else is source drift, which
    // deterministic manual adoption reconciles — never regeneration.
    let found = crate::analysis::generation::discover_generation(&tree, &source_text);
    let report = match collect_gen_status(root, &[record.source.path.clone()]) {
        Ok(report) => report,
        Err(error) => return error,
    };
    let current = report
        .units
        .iter()
        .find(|unit| unit["id"].as_str() == Some(id.as_str()) && unit["association"] == "retained");
    let descriptor = current.and_then(|unit| {
        found.descriptors.iter().find(|descriptor| {
            unit["span"]["start"].as_u64() == Some(descriptor.span.start as u64)
                && unit["span"]["end"].as_u64() == Some(descriptor.span.end as u64)
                && intake::UnitKind::of_descriptor(descriptor.kind) == Some(record.source.kind)
        })
    });
    let Some(descriptor) = descriptor else {
        return validation_failure_envelope(
            header,
            ValidationFailure::drift(format!(
                "unit `{}` source drifted or binding is ambiguous: no uniquely bound {} `{}` at anchor `{}` in current `{}`; the saved group is preserved",
                id.as_str(),
                record.source.kind.as_str(),
                record.source.label.as_deref().unwrap_or("-"),
                record.source.anchor,
                record.source.path
            )),
        );
    };
    let own_diags: Vec<_> = found
        .diagnostics
        .iter()
        .filter(|d| diagnostic_in_span(d, descriptor.span.start, descriptor.span.end))
        .collect();
    if !own_diags.is_empty() {
        let owned: Vec<crate::diagnostic::Diagnostic> = own_diags.into_iter().cloned().collect();
        return validation_failure_envelope(
            header,
            ValidationFailure::new(
                format!(
                    "unit `{}` source discovery failed: {}",
                    id.as_str(),
                    diagnostic_summary(&owned)
                ),
                vec!["fix the source errors and resend validate".to_string()],
            ),
        );
    }
    // Declaration-target and keyword-signature consistency: the current
    // descriptor must agree with the recorded contract, else the
    // interface drifted and manual adoption reconciles it.
    if descriptor.target != record.contract.target {
        return validation_failure_envelope(
            header,
            ValidationFailure::drift(format!(
                "unit `{}` interface drifted: declaration target is now {} but the saved group bound {}; the saved group is preserved",
                id.as_str(),
                descriptor
                    .target
                    .as_deref()
                    .map(|t| format!("`{t}`"))
                    .unwrap_or_else(|| "absent".to_string()),
                record
                    .contract
                    .target
                    .as_deref()
                    .map(|t| format!("`{t}`"))
                    .unwrap_or_else(|| "absent".to_string()),
            )),
        );
    }
    let current_signature = intake::contract_for(descriptor).and_then(|c| c.signature);
    if current_signature != record.contract.signature {
        return validation_failure_envelope(
            header,
            ValidationFailure::drift(format!(
                "unit `{}` interface drifted: keyword signature changed; the saved group is preserved",
                id.as_str()
            )),
        );
    }
    let prompt_changed = {
        let current_prompt = intake::contract_for(descriptor)
            .map(|c| c.prompt_sha256)
            .unwrap_or_default();
        current_prompt != record.contract.prompt_sha256
    };
    let mut checks = vec![validation_check(
        "source",
        format!(
            "bound {} `{}` at anchor `{}` (revision {})",
            record.source.kind.as_str(),
            record.source.label.as_deref().unwrap_or("-"),
            record.source.anchor,
            crate::source::sha256_hex(source_text.as_bytes()),
        ),
    )];
    // One finite dispatch by kind: only the selected unit kind's
    // producer outputs are consulted, not every kind.
    let outcome = match record.source.kind {
        intake::UnitKind::Keyword => {
            validate_keyword_unit(&id, &group, &source_text, descriptor, &mut checks)
        }
        intake::UnitKind::NamedTrait | intake::UnitKind::InlineTrait => {
            validate_trait_unit(&id, &group, &source_text, &mut checks)
        }
        intake::UnitKind::Style
        | intake::UnitKind::StyleInline
        | intake::UnitKind::ViewStyleInline => validate_style_unit(&id, &group, &mut checks),
        intake::UnitKind::View => {
            validate_view_unit(&id, &group, &source_text, descriptor, &mut checks)
        }
    };
    let fingerprint = match outcome {
        Ok(fingerprint) => fingerprint,
        Err(failure) => return validation_failure_envelope(header, failure),
    };
    // Bind the exact consumed closure: the owning source, the parsed
    // record, and every current group file. Promotion compares these
    // bytes; the validator consumed nothing else.
    let unit_prefix = format!("{}/{}/", intake::GENERATED_DIR, id.as_str());
    let mut bound_paths = vec![
        record.source.path.clone(),
        format!("{unit_prefix}{}", intake::UNIT_FILE),
    ];
    bound_paths.extend(
        group
            .files
            .iter()
            .map(|f| format!("{unit_prefix}{}", f.rel_path)),
    );
    let inputs = match crate::source::ValidationInputs::bind(root_path, &bound_paths) {
        Ok(inputs) => inputs,
        Err(err) => {
            return validation_failure_envelope(
                header,
                ValidationFailure::new(
                    err.to_string(),
                    vec!["restore the missing input and resend validate".to_string()],
                ),
            );
        }
    };
    let modified_since_generation = group
        .files
        .iter()
        .any(|f| modified_since_generation(&group.record, &f.rel_path, &f.sha256));
    let mut payload = serde_json::Map::new();
    payload.insert(
        "unit_id".to_string(),
        serde_json::Value::String(id.as_str().to_string()),
    );
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String(record.source.kind.as_str().to_string()),
    );
    payload.insert(
        "target".to_string(),
        record
            .contract
            .target
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    payload.insert(
        "runtime_targets".to_string(),
        serde_json::Value::Array(
            runtime_targets_for(
                record.source.kind,
                group
                    .files
                    .iter()
                    .any(|file| file.rel_path == "implementation.js"),
            )
            .iter()
            .map(|t| serde_json::Value::String(t.to_string()))
            .collect(),
        ),
    );
    payload.insert(
        "checks".to_string(),
        serde_json::Value::Array(checks.into_iter().collect()),
    );
    payload.insert(
        "inputs".to_string(),
        serde_json::json!({
            "source": {"path": record.source.path, "revision": crate::source::sha256_hex(source_text.as_bytes())},
            "files": inputs.files.iter().map(|f| serde_json::json!({"path": f.path, "sha256": f.sha256})).collect::<Vec<_>>(),
        }),
    );
    payload.insert(
        "fingerprint".to_string(),
        serde_json::Value::String(fingerprint),
    );
    payload.insert(
        "modified_since_generation".to_string(),
        serde_json::Value::Bool(modified_since_generation),
    );
    payload.insert(
        "prompt_changed".to_string(),
        serde_json::Value::Bool(prompt_changed),
    );
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(header, "validated", payload, vec![]),
    )
}

/// Whether current bytes differ from the recorded original output.
/// Unrecorded files (bound, never generated) are not modifications:
/// truthful provenance never invents generator credit.
fn modified_since_generation(
    record: &crate::analysis::generation_intake::UnitRecord,
    rel_path: &str,
    current_sha256: &str,
) -> bool {
    record
        .original
        .files
        .get(rel_path)
        .is_some_and(|original| original != current_sha256)
}

/// Saved interface declaration sidecar for keyword units
/// (`can.generated/<id>/declaration.json`): the owner-versioned
/// producer, the saved export implementing the behavior, and the
/// declared reads/effects/authority the BGI-07 check admits.
///
/// This legacy sidecar is optional: fresh v1 units derive their pure
/// producer/export binding from the owning checked source signature.
/// `unit.json` holds association and contract refs only; schema and
/// authority are never discovered by executing JavaScript.
/// Strict shape — unknown fields refuse — so a drifted declaration
/// diagnoses instead of validating against stale fields.
const DECLARATION_FILE: &str = "declaration.json";

/// Strict wire shape of [`DECLARATION_FILE`].
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedDeclarationFile {
    producer: String,
    export: String,
    #[serde(default)]
    reads: Vec<String>,
    #[serde(default)]
    effects: Vec<String>,
    #[serde(default)]
    authority: Vec<String>,
}

/// Parse a keyword unit's declaration sidecar into the saved
/// declaration the BGI-07 Given check consumes.
fn read_saved_declaration(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    descriptor: &crate::analysis::generation::GenerationDescriptor,
) -> Result<crate::analysis::types::GivenSavedDeclaration, ValidationFailure> {
    let Some(file) = group.files.iter().find(|f| f.rel_path == DECLARATION_FILE) else {
        return crate::analysis::types::given_declaration_for_source(descriptor).ok_or_else(|| ValidationFailure::new(
            format!("unit `{id}` has no admitted source-derived producer for its keyword signature; v1 admits exactly (target:model, field:field(target,text))"),
            vec!["use an admitted keyword signature; a new producer requires its defining compiler/owner integration".to_string()],
        ));
    };
    let text = String::from_utf8(file.bytes.clone()).map_err(|_| {
        ValidationFailure::new(
            format!(
                "unit `{}` `{DECLARATION_FILE}` is not valid UTF-8; repair the file or reconcile with adopt",
                id.as_str(),
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    let parsed: SavedDeclarationFile = serde_json::from_str(&text).map_err(|err| {
        ValidationFailure::new(
            format!(
                "unit `{}` `{DECLARATION_FILE}` is not a valid saved declaration: {err}",
                id.as_str(),
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    if parsed.producer.is_empty() || parsed.export.is_empty() {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` `{DECLARATION_FILE}` names no producer/export; reconcile the interface with adopt",
                id.as_str(),
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    Ok(crate::analysis::types::GivenSavedDeclaration {
        producer: parsed.producer,
        export: parsed.export,
        reads: parsed.reads,
        effects: parsed.effects,
        authority: parsed.authority,
    })
}

/// A group file that must exist and be UTF-8 before kind validation.
/// Fresh preparation groups (bound, no outputs yet) fail with the
/// generate action; anything else names the missing file.
fn require_group_text(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    rel_path: &str,
) -> Result<String, ValidationFailure> {
    let Some(file) = group.files.iter().find(|f| f.rel_path == rel_path) else {
        return Err(ValidationFailure::new(
            format!(
                "saved group `{}` ({}) is missing required primary output `{rel_path}`; prepare generation for the unit",
                id.as_str(),
                group.record.source.kind.as_str(),
            ),
            vec!["send a generate request to prepare the unit's saved group".to_string()],
        ));
    };
    String::from_utf8(file.bytes.clone()).map_err(|_| {
        ValidationFailure::new(
            format!(
                "unit `{}` `{rel_path}` is not valid UTF-8; repair the file or reconcile with adopt",
                id.as_str(),
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })
}

/// Check one owning source catalog-free (Given contracts never depend
/// on builtins) and return the database, program, and diagnostics.
/// Only Given-kind validation pays for the full check; style and view
/// units use only their own producer outputs.
fn check_validation_source(
    source_path: &str,
    source_text: &str,
) -> (
    crate::source::SourceDb,
    crate::analysis::CheckedProgram,
    Vec<crate::diagnostic::Diagnostic>,
) {
    let mut db = crate::source::SourceDb::new();
    let id = db.add(source_path.to_string(), source_text.to_string());
    let (program, diags) = crate::analysis::check_program(&db, &[id], None);
    (db, program, diags)
}

/// Run the BGI-07 Given check for exactly one saved unit and return
/// its contract tables. The saved map holds only the selected unit:
/// validation consumes that kind's producer outputs, not every kind.
fn check_one_given_unit(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    source_text: &str,
    saved_unit: crate::analysis::types::GivenSavedUnit,
    checks: &mut Vec<serde_json::Value>,
) -> Result<crate::analysis::types::GivenContractTables, ValidationFailure> {
    use crate::analysis::generation_intake::AssociationKey;
    let (mut db, program, base) = check_validation_source(&group.record.source.path, source_text);
    // Unit validation owns the generated Given interface. Ordinary bodies
    // may reference sibling contributions which are still pending; their
    // complete semantic check belongs to the saved compile join.
    let (source_tree, _) = crate::syntax::parse_source(SourceId(0), source_text);
    let given_sections: Vec<Span> = source_tree
        .descendants()
        .filter(|node| {
            node.kind == crate::syntax::SyntaxKind::Section
                && node.children.iter().any(|child| {
                    child
                        .token()
                        .is_some_and(|token| token.text(source_text) == "Given")
                })
        })
        .map(|node| node.span)
        .collect();
    let base: Vec<_> = base
        .into_iter()
        .filter(|diagnostic| {
            diagnostic.code.starts_with("E1")
                || given_sections.iter().any(|span| {
                    span.start <= diagnostic.primary.start && diagnostic.primary.end <= span.end
                })
        })
        .collect();
    if !base.is_empty() {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` owning source `{}` does not check: {}",
                id.as_str(),
                group.record.source.path,
                diagnostic_summary(&base)
            ),
            vec!["fix the source errors and resend validate".to_string()],
        ));
    }
    // Carriers join the database after the program check, exactly as
    // the BGI-07 harness does: checked-program ids stay stable.
    let mut saved_unit = saved_unit;
    if let Some(carrier) = group
        .files
        .iter()
        .find(|f| f.rel_path == "contributions.can")
        && saved_unit.contributions.is_none()
    {
        let text = String::from_utf8_lossy(&carrier.bytes).into_owned();
        let carrier_id = db.add(
            format!(
                "{}/{}/contributions.can",
                crate::analysis::generation_intake::GENERATED_DIR,
                id.as_str()
            ),
            text,
        );
        // Trait units carry their template here; a keyword carrier
        // passes through so the Given check refuses it as hidden
        // authority instead of validating against hidden bytes.
        saved_unit.contributions = Some(carrier_id);
    }
    let mut saved = std::collections::HashMap::new();
    saved.insert(
        AssociationKey {
            owner: group.record.source.owner.clone(),
            kind: group.record.source.kind,
            label: group.record.source.label.clone(),
            anchor: group.record.source.anchor.clone(),
        },
        saved_unit,
    );
    let (tables, diags) = crate::analysis::check::check_given_contracts(
        &crate::analysis::check::GivenContractInputs {
            db: &db,
            program: &program,
            saved: &saved,
        },
    );
    if !diags.is_empty() {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` given contract check failed: {}",
                id.as_str(),
                diagnostic_summary(&diags)
            ),
            vec![
                "fix the reported contract mismatch and resend validate".to_string(),
                "send an adopt request if the source intent changed (BGI-12)".to_string(),
            ],
        ));
    }
    checks.push(validation_check(
        "contract",
        "given contracts check with no diagnostics".to_string(),
    ));
    Ok(tables)
}

/// Validate a keyword unit for the workerd target: checked producer
/// contract, declared export present in the saved module, admitted
/// imports only, and a bound implementation fingerprint. Returns the
/// fingerprint downstream activation compares before running.
fn validate_keyword_unit(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    source_text: &str,
    descriptor: &crate::analysis::generation::GenerationDescriptor,
    checks: &mut Vec<serde_json::Value>,
) -> Result<String, ValidationFailure> {
    let declaration = read_saved_declaration(id, group, descriptor)?;
    checks.push(validation_check(
        "declaration",
        format!(
            "producer `{}` export `{}`",
            declaration.producer, declaration.export
        ),
    ));
    let js = require_group_text(id, group, "implementation.js")?;
    let scan = scan_js_module(&js);
    // The closure resolves (and admits every consumed file) before the
    // Given check, so the checked contract fingerprints the exact
    // consumed bytes; the `imports` check below re-admits the root for
    // its stable report line.
    let closure = resolve_saved_js_closure(id, group, "implementation.js", &js, "workerd")
        .map_err(|detail| {
            ValidationFailure::new(
                detail,
                vec!["fix the saved imports and resend validate".to_string()],
            )
        })?;
    let saved_unit = crate::analysis::types::GivenSavedUnit {
        unit_id: id.as_str().to_string(),
        contributions: None,
        implementation_js: Some(js.clone()),
        implementation_imports: closure.clone(),
        declaration: Some(declaration.clone()),
    };
    let tables = check_one_given_unit(id, group, source_text, saved_unit, checks)?;
    let contract = tables
        .keywords
        .iter()
        .find(|c| c.unit_id == id.as_str())
        .ok_or_else(|| {
            ValidationFailure::new(
                format!(
                    "unit `{}` produced no keyword contract; the definition has no checked application to validate against",
                    id.as_str(),
                ),
                vec![ValidationFailure::drift(String::new()).next.remove(0)],
            )
        })?;
    checks.push(validation_check(
        "contract-binding",
        format!(
            "producer `{}` semantics `{}` lifecycle `{}` ({} application{})",
            contract.producer,
            contract.semantics,
            contract.lifecycle,
            contract.applications.len(),
            if contract.applications.len() == 1 {
                ""
            } else {
                "s"
            },
        ),
    ));
    // The declared export must be textually declared by the saved
    // module. This is static admission, never execution: no module
    // runs to discover schema or authority.
    if !scan.exports.iter().any(|e| e == &contract.export) {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` declares export `{}` with no matching saved export in `implementation.js`; repair the export or reconcile with adopt",
                id.as_str(),
                contract.export
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    checks.push(validation_check(
        "exports",
        format!("saved module declares `{}`", contract.export),
    ));
    admit_js_imports(id, &scan, "workerd")?;
    checks.push(validation_check(
        "imports",
        if scan.imports.is_empty() {
            "no imports".to_string()
        } else {
            format!(
                "{} unit-local relative import{}",
                scan.imports.len(),
                if scan.imports.len() == 1 { "" } else { "s" }
            )
        },
    ));
    let closure_refs: Vec<(&str, &[u8])> = closure
        .iter()
        .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
        .collect();
    let fingerprint =
        crate::analysis::types::given_closure_fingerprint(js.as_bytes(), &closure_refs);
    checks.push(validation_check(
        "fingerprint",
        if closure.is_empty() {
            format!("implementation sha256 {fingerprint}")
        } else {
            format!(
                "implementation closure sha256 {fingerprint} ({} files)",
                closure.len() + 1
            )
        },
    ));
    Ok(fingerprint)
}

/// Validate a trait unit: its contributions carrier checks through
/// BGI-07 plus an optional source-derived pure text-field check. A check's
/// code/import closure and carrier jointly determine validation freshness.
fn validate_trait_unit(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    source_text: &str,
    checks: &mut Vec<serde_json::Value>,
) -> Result<String, ValidationFailure> {
    reject_unexpected_declaration(id, group)?;
    let carrier = require_group_text(id, group, "contributions.can")?;
    let implementation_js = group
        .files
        .iter()
        .any(|file| file.rel_path == "implementation.js")
        .then(|| require_group_text(id, group, "implementation.js"))
        .transpose()?;
    let implementation_imports = if let Some(js) = &implementation_js {
        resolve_saved_js_closure(id, group, "implementation.js", js, "workerd").map_err(
            |detail| {
                ValidationFailure::new(
                    detail,
                    vec!["fix the saved imports and resend validate".into()],
                )
            },
        )?
    } else {
        Vec::new()
    };
    let saved_unit = crate::analysis::types::GivenSavedUnit {
        unit_id: id.as_str().to_string(),
        contributions: None,
        implementation_js: implementation_js.clone(),
        implementation_imports: implementation_imports.clone(),
        declaration: None,
    };
    let tables = check_one_given_unit(id, group, source_text, saved_unit, checks)?;
    let contract = tables
        .traits
        .iter()
        .find(|c| c.unit_id == id.as_str())
        .ok_or_else(|| {
            ValidationFailure::new(
                format!(
                    "unit `{}` produced no trait contract; the definition has no checked application to validate against",
                    id.as_str(),
                ),
                vec![ValidationFailure::drift(String::new()).next.remove(0)],
            )
        })?;
    checks.push(validation_check(
        "contributions",
        format!(
            "{} contributed field{} ({} application{})",
            contract.contributed_fields.len(),
            if contract.contributed_fields.len() == 1 {
                ""
            } else {
                "s"
            },
            contract.applications.len(),
            if contract.applications.len() == 1 {
                ""
            } else {
                "s"
            },
        ),
    ));
    let fingerprint = if let Some(validation) = &contract.validation_fingerprint {
        let js = implementation_js
            .as_ref()
            .expect("checked validation implementation");
        let scan = scan_js_module(js);
        if !scan
            .exports
            .iter()
            .any(|export| export == crate::analysis::types::GIVEN_FIELD_VALIDATION_EXPORT)
        {
            return Err(ValidationFailure::new(
                format!(
                    "unit `{id}` field validation implementation declares no `check` export in `implementation.js`"
                ),
                vec!["export the source-derived check(value) function and resend validate".into()],
            ));
        }
        admit_js_imports(id, &scan, "workerd")?;
        checks.push(validation_check(
            "exports",
            "saved module declares `check`".into(),
        ));
        checks.push(validation_check(
            "imports",
            format!(
                "{} consumed unit-local imports",
                implementation_imports.len()
            ),
        ));
        checks.push(validation_check(
            "contract-binding",
            format!(
                "producer `{}` lifecycle `{}` (implementation closure {validation})",
                crate::analysis::types::GIVEN_PRODUCER_FIELD_VALIDATION,
                crate::analysis::types::GIVEN_FIELD_VALIDATION_LIFECYCLE,
            ),
        ));
        let mut closure = vec![("implementation.js", js.as_bytes())];
        closure.extend(
            implementation_imports
                .iter()
                .map(|import| (import.rel_path.as_str(), import.bytes.as_slice())),
        );
        crate::analysis::types::given_closure_fingerprint(carrier.as_bytes(), &closure)
    } else {
        crate::source::sha256_hex(carrier.as_bytes())
    };
    checks.push(validation_check(
        "fingerprint",
        if implementation_js.is_some() {
            format!("carrier and admitted implementation sha256 {fingerprint}")
        } else {
            format!("carrier sha256 {fingerprint}")
        },
    ));
    Ok(fingerprint)
}

/// Only keyword units declare a producer/export interface in v1; any
/// other kind carrying a declaration sidecar diagnoses instead of
/// validating against interface metadata it cannot own.
fn reject_unexpected_declaration(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
) -> Result<(), ValidationFailure> {
    if group.files.iter().any(|f| f.rel_path == DECLARATION_FILE) {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` ({}) carries unexpected `{DECLARATION_FILE}`: only keyword units declare a producer/export interface in v1; remove the file or reconcile with bind",
                id.as_str(),
                group.record.source.kind.as_str(),
            ),
            vec![
                "remove the unexpected declaration file, or send a bind request to reconcile the unit".to_string(),
            ],
        ));
    }
    Ok(())
}

/// Validate a style unit through the BGI-10 scoping path: the saved
/// CSS scopes with ownership guards, and every owned asset URL
/// resolves to a saved file in the unit. Returns the CSS fingerprint.
fn validate_style_unit(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    checks: &mut Vec<serde_json::Value>,
) -> Result<String, ValidationFailure> {
    reject_unexpected_declaration(id, group)?;
    let css = require_group_text(id, group, "style.css")?;
    let scoped = crate::css_scope::scope_stylesheet(id.as_str(), &css).map_err(|errors| {
        let first = &errors[0];
        let mut message = format!(
            "unit `{}` `style.css` failed scope checks: {} {} (line {}, column {})",
            id.as_str(),
            first.code,
            first.message,
            first.line,
            first.column,
        );
        if errors.len() > 1 {
            message.push_str(&format!(" (+{} more)", errors.len() - 1));
        }
        ValidationFailure::new(message, vec!["fix the CSS and resend validate".to_string()])
    })?;
    checks.push(validation_check(
        "scope",
        format!(
            "{} keyframe{}, {} propert{}, {} theme read{}, {} asset{}",
            scoped.keyframes.len(),
            if scoped.keyframes.len() == 1 { "" } else { "s" },
            scoped.properties.len(),
            if scoped.properties.len() == 1 {
                "y"
            } else {
                "ies"
            },
            scoped.theme_reads.len(),
            if scoped.theme_reads.len() == 1 {
                ""
            } else {
                "s"
            },
            scoped.assets.len(),
            if scoped.assets.len() == 1 { "" } else { "s" },
        ),
    ));
    for asset in &scoped.assets {
        if !group.files.iter().any(|f| f.rel_path == *asset) {
            return Err(ValidationFailure::new(
                format!(
                    "unit `{}` `style.css` references owned asset `{asset}` with no saved file; add the asset or reconcile with adopt",
                    id.as_str(),
                ),
                vec![ValidationFailure::drift(String::new()).next.remove(0)],
            ));
        }
    }
    for asset in &scoped.assets {
        let file = group
            .files
            .iter()
            .find(|file| &file.rel_path == asset)
            .expect("asset existence checked");
        crate::codegen::artifact::style_asset_content_type(asset, &file.bytes).map_err(|detail| ValidationFailure::new(detail, vec!["replace the asset with supported matching image/font bytes and resend validate".to_string()]))?;
    }
    if !scoped.assets.is_empty() {
        checks.push(validation_check(
            "assets",
            format!(
                "{} owned asset{} present",
                scoped.assets.len(),
                if scoped.assets.len() == 1 { "" } else { "s" },
            ),
        ));
    }
    let fingerprint = crate::source::sha256_hex(css.as_bytes());
    checks.push(validation_check(
        "fingerprint",
        format!("css sha256 {fingerprint}"),
    ));
    Ok(fingerprint)
}

/// Validate a view unit for the workerd/browser targets: the prompted
/// view lowers through BGI-09, the saved module declares `render`
/// (plus an optional browser `mount`), imports stay unit-local, and
/// any colocated CSS scopes. Returns the implementation fingerprint.
fn validate_view_unit(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    source_text: &str,
    descriptor: &crate::analysis::generation::GenerationDescriptor,
    checks: &mut Vec<serde_json::Value>,
) -> Result<String, ValidationFailure> {
    reject_unexpected_declaration(id, group)?;
    let (tree, _) = crate::syntax::parse_source(SourceId(0), source_text);
    let lowering = crate::codegen::then_views::lower_then_views(&tree, source_text);
    let Some(label) = group.record.source.label.clone() else {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` binds a view with no recorded name; send a bind request to reconcile the unit",
                id.as_str(),
            ),
            vec!["send a bind request to reconcile the unit's association".to_string()],
        ));
    };
    let own: Vec<_> = lowering
        .diagnostics
        .iter()
        .filter(|d| diagnostic_in_span(d, descriptor.span.start, descriptor.span.end))
        .cloned()
        .collect();
    if !own.is_empty() {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` view lowering failed: {}",
                id.as_str(),
                diagnostic_summary(&own)
            ),
            vec!["fix the source errors and resend validate".to_string()],
        ));
    }
    let Some(view) = lowering.views.iter().find(|v| v.name == label) else {
        return Err(ValidationFailure::drift(format!(
            "unit `{}` interface drifted: no prompted view `{label}` lowers from the current source; the saved group is preserved",
            id.as_str(),
        )));
    };
    checks.push(validation_check(
        "lowering",
        format!(
            "view `{}` over row model `{}` ({} control{})",
            view.name,
            view.row_model,
            view.controls.len(),
            if view.controls.len() == 1 { "" } else { "s" },
        ),
    ));
    let js = require_group_text(id, group, "implementation.js")?;
    let scan = scan_js_module(&js);
    // The closure resolves (and admits every consumed file) before the
    // export checks, so the validated fingerprint covers the exact
    // consumed bytes; the `imports` check below re-admits the root for
    // its stable report line.
    let closure = resolve_saved_js_closure(id, group, "implementation.js", &js, "workerd/browser")
        .map_err(|detail| {
            ValidationFailure::new(
                detail,
                vec!["fix the saved imports and resend validate".to_string()],
            )
        })?;
    if !scan.exports.iter().any(|e| e == "render") {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` view implementation declares no `render` export in `implementation.js`; repair the export or reconcile with adopt",
                id.as_str(),
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    checks.push(validation_check(
        "exports",
        if scan.exports.iter().any(|e| e == "mount") {
            "saved module declares `render` plus browser `mount`".to_string()
        } else {
            "saved module declares `render` (server render only)".to_string()
        },
    ));
    admit_js_imports(id, &scan, "workerd/browser")?;
    checks.push(validation_check(
        "imports",
        if scan.imports.is_empty() {
            "no imports".to_string()
        } else {
            format!(
                "{} unit-local relative import{}",
                scan.imports.len(),
                if scan.imports.len() == 1 { "" } else { "s" }
            )
        },
    ));
    if group.files.iter().any(|f| f.rel_path == "style.css") {
        validate_style_unit(id, group, checks)?;
    }
    let closure_refs: Vec<(&str, &[u8])> = closure
        .iter()
        .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
        .collect();
    let fingerprint =
        crate::analysis::types::given_closure_fingerprint(js.as_bytes(), &closure_refs);
    checks.push(validation_check(
        "fingerprint",
        if closure.is_empty() {
            format!("implementation sha256 {fingerprint}")
        } else {
            format!(
                "implementation closure sha256 {fingerprint} ({} files)",
                closure.len() + 1
            )
        },
    ));
    Ok(fingerprint)
}

/// One lexical import edge of a saved module: specifier, byte offset,
/// whether it came from a dynamic `import()`, and whether the
/// specifier could not be resolved lexically (fail-closed: an
/// unresolvable edge never validates).
struct JsImportEdge {
    specifier: String,
    offset: usize,
    dynamic: bool,
    unresolved: bool,
}

/// Lexical view of a saved module: declared export bindings, import
/// specifiers, and whether `require(` is called.
///
/// Finite static admission, never execution or a full parse: comments
/// and string-literal contents are blanked before keyword matching so
/// quoted `export`/`import` tokens cannot certify an interface. This
/// admits the shapes the v1 producers emit
/// (`export function/name`, `export const/let/var/class`, `export {a,
/// b as c}`, `export default`, static/dynamic `import`, re-export
/// `from`); anything subtler must use those explicit forms to
/// validate. Finite checking is not a proof of arbitrary JS behavior.
struct JsModuleScan {
    exports: Vec<String>,
    imports: Vec<JsImportEdge>,
    has_require: bool,
    require_offset: usize,
}

/// Blank comments and string-literal contents with spaces, preserving
/// byte length and newlines so offsets still address the original.
/// Template `${...}` interpolations stay code; everywhere else inside
/// a literal is blanked.
fn blank_js_range(out: &mut Vec<u8>, from: usize, to: usize) {
    for b in &mut out[from..to] {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}

fn blank_js_line_comment(bytes: &[u8], out: &mut Vec<u8>, i: &mut usize) {
    let from = *i;
    while *i < bytes.len() && bytes[*i] != b'\n' {
        *i += 1;
    }
    blank_js_range(out, from, *i);
}

fn blank_js_block_comment(bytes: &[u8], out: &mut Vec<u8>, i: &mut usize) {
    let from = *i;
    *i += 2;
    while *i + 1 < bytes.len() && !(bytes[*i] == b'*' && bytes[*i + 1] == b'/') {
        *i += 1;
    }
    *i = (*i + 2).min(bytes.len());
    blank_js_range(out, from, *i);
}

fn blank_js_string(bytes: &[u8], out: &mut Vec<u8>, i: &mut usize, quote: u8) {
    let from = *i;
    *i += 1;
    while *i < bytes.len() {
        if bytes[*i] == b'\\' {
            *i += 2;
        } else if bytes[*i] == b'\n' {
            break;
        } else if bytes[*i] == quote {
            *i += 1;
            break;
        } else {
            *i += 1;
        }
    }
    blank_js_range(out, from, *i);
}

fn blank_js_template(bytes: &[u8], out: &mut Vec<u8>, i: &mut usize) {
    // Blank literal runs byte by byte; `${...}`
    // interpolations stay code (balanced braces skipped
    // unblanked, including nested quotes — a conservative
    // over-approximation that can only add spurious keyword
    // matches inside exotic templates, never hide a real
    // export or import).
    out[*i] = b' ';
    *i += 1;
    while *i < bytes.len() {
        if bytes[*i] == b'\\' {
            out[*i] = b' ';
            if *i + 1 < bytes.len() && bytes[*i + 1] != b'\n' {
                out[*i + 1] = b' ';
            }
            *i += 2;
        } else if bytes[*i] == b'`' {
            out[*i] = b' ';
            *i += 1;
            break;
        } else if bytes[*i] == b'$' && *i + 1 < bytes.len() && bytes[*i + 1] == b'{' {
            *i += 2;
            let mut depth = 1usize;
            while *i < bytes.len() && depth > 0 {
                if bytes[*i] == b'{' {
                    depth += 1;
                } else if bytes[*i] == b'}' {
                    depth -= 1;
                }
                *i += 1;
            }
        } else {
            if bytes[*i] != b'\n' {
                out[*i] = b' ';
            }
            *i += 1;
        }
    }
}

fn blank_js_trivia(js: &str) -> Vec<u8> {
    let bytes = js.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            blank_js_line_comment(bytes, &mut out, &mut i);
        } else if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            blank_js_block_comment(bytes, &mut out, &mut i);
        } else if b == b'\'' || b == b'"' {
            blank_js_string(bytes, &mut out, &mut i, b);
        } else if b == b'`' {
            blank_js_template(bytes, &mut out, &mut i);
        } else {
            i += 1;
        }
    }
    out
}

/// ASCII identifier helpers over blanked bytes.
fn is_js_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_js_ident_part(b: u8) -> bool {
    is_js_ident_start(b) || b.is_ascii_digit()
}

/// Read one identifier at `*i`, advancing past it.
fn read_js_ident(blanked: &[u8], i: &mut usize) -> Option<String> {
    if *i < blanked.len() && is_js_ident_start(blanked[*i]) {
        let from = *i;
        while *i < blanked.len() && is_js_ident_part(blanked[*i]) {
            *i += 1;
        }
        return Some(String::from_utf8_lossy(&blanked[from..*i]).into_owned());
    }
    None
}

/// Skip ASCII whitespace in blanked bytes.
fn skip_js_ws(blanked: &[u8], i: &mut usize) {
    while *i < blanked.len() && matches!(blanked[*i], b' ' | b'\t' | b'\n' | b'\r' | 0x0C | 0x0B) {
        *i += 1;
    }
}

/// Skip whitespace and comments in ORIGINAL bytes, where quotes are
/// intact. Specifier lookup must use this: blanked string contents
/// are spaces, so a blanked skip would sail past the opening quote.
fn skip_js_trivia_original(js: &[u8], m: &mut usize) {
    loop {
        while *m < js.len() && matches!(js[*m], b' ' | b'\t' | b'\n' | b'\r' | 0x0C | 0x0B) {
            *m += 1;
        }
        if *m + 1 < js.len() && js[*m] == b'/' && js[*m + 1] == b'/' {
            while *m < js.len() && js[*m] != b'\n' {
                *m += 1;
            }
        } else if *m + 1 < js.len() && js[*m] == b'/' && js[*m + 1] == b'*' {
            *m += 2;
            while *m + 1 < js.len() && !(js[*m] == b'*' && js[*m + 1] == b'/') {
                *m += 1;
            }
            *m = (*m + 2).min(js.len());
        } else {
            break;
        }
    }
}

/// Whether `word` appears at `i` as a standalone keyword.
fn js_keyword_at(blanked: &[u8], i: usize, word: &[u8]) -> bool {
    blanked.len() >= i + word.len()
        && &blanked[i..i + word.len()] == word
        && (i == 0 || !is_js_ident_part(blanked[i - 1]))
        && (i + word.len() >= blanked.len() || !is_js_ident_part(blanked[i + word.len()]))
}

/// Read one single/double-quoted specifier from the ORIGINAL bytes at
/// a blanked quote position. Returns the decoded span text; escapes
/// stay raw (specifiers compare literally, never evaluated).
fn read_js_specifier(js: &[u8], quote_at: usize) -> Option<(String, usize)> {
    let quote = *js.get(quote_at)?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let mut i = quote_at + 1;
    while i < js.len() {
        if js[i] == b'\\' {
            i += 2;
        } else if js[i] == b'\n' {
            return None;
        } else if js[i] == quote {
            let text = String::from_utf8_lossy(&js[quote_at + 1..i]).into_owned();
            return Some((text, i + 1));
        } else {
            i += 1;
        }
    }
    None
}

/// Lexically scan one saved module for declared exports and import
/// specifiers. See [`JsModuleScan`] for the admitted shapes and the
/// finite-checking boundary.
struct JsScanState {
    exports: Vec<String>,
    imports: Vec<JsImportEdge>,
    has_require: bool,
    require_offset: usize,
    seen_exports: std::collections::HashSet<String>,
}

impl JsScanState {
    fn push_export(&mut self, name: String) {
        if self.seen_exports.insert(name.clone()) {
            self.exports.push(name);
        }
    }

    fn scan_export_list(&mut self, blanked: &[u8], j: &mut usize) {
        // `export {a, b as c}`: exported names are the `as`
        // targets (or the plain names).
        *j += 1;
        loop {
            skip_js_ws(blanked, j);
            if *j < blanked.len() && blanked[*j] == b'}' {
                *j += 1;
                break;
            }
            let Some(first) = read_js_ident(blanked, j) else {
                break;
            };
            skip_js_ws(blanked, j);
            let mut exported = first;
            if js_keyword_at(blanked, *j, b"as") {
                *j += 2;
                skip_js_ws(blanked, j);
                if let Some(target) = read_js_ident(blanked, j) {
                    exported = target;
                }
            }
            self.push_export(exported);
            skip_js_ws(blanked, j);
            if *j < blanked.len() && blanked[*j] == b',' {
                *j += 1;
            } else if *j < blanked.len() && blanked[*j] == b'}' {
                *j += 1;
                break;
            } else {
                break;
            }
        }
    }

    fn scan_export(&mut self, blanked: &[u8], i: usize) -> usize {
        let mut j = i + 6;
        skip_js_ws(blanked, &mut j);
        if js_keyword_at(blanked, j, b"default") {
            self.push_export("default".to_string());
            return j + 7;
        }
        if j < blanked.len() && blanked[j] == b'*' {
            // `export *` / `export * as ns from`: names come from
            // the target module, so only the re-export edge matters.
            return j + 1;
        }
        if j < blanked.len() && blanked[j] == b'{' {
            self.scan_export_list(blanked, &mut j);
            return j;
        }
        if js_keyword_at(blanked, j, b"async") {
            j += 5;
            skip_js_ws(blanked, &mut j);
        }
        if js_keyword_at(blanked, j, b"function") || js_keyword_at(blanked, j, b"class") {
            j += if blanked[j] == b'f' { 8 } else { 5 };
            skip_js_ws(blanked, &mut j);
            if blanked.get(j) == Some(&b'*') {
                j += 1;
                skip_js_ws(blanked, &mut j);
            }
            if let Some(name) = read_js_ident(blanked, &mut j) {
                self.push_export(name);
            }
            return j;
        }
        if js_keyword_at(blanked, j, b"const")
            || js_keyword_at(blanked, j, b"let")
            || js_keyword_at(blanked, j, b"var")
        {
            j += if blanked[j] == b'c' { 5 } else { 3 };
            skip_js_ws(blanked, &mut j);
            if let Some(name) = read_js_ident(blanked, &mut j) {
                self.push_export(name);
            }
            return j;
        }
        j
    }

    fn scan_import(&mut self, original: &[u8], blanked: &[u8], i: usize) -> usize {
        // Original trivia skip: a blanked skip would sail over a
        // blanked side-effect string to the statement end.
        let mut j = i + 6;
        skip_js_trivia_original(original, &mut j);
        if j < blanked.len() && original[j] == b'(' {
            // Dynamic `import(`: a quoted literal records an edge;
            // anything else is an unresolvable dynamic edge.
            j += 1;
            skip_js_trivia_original(original, &mut j);
            if let Some((spec, end)) = read_js_specifier(original, j) {
                self.imports.push(JsImportEdge {
                    specifier: spec,
                    offset: j,
                    dynamic: true,
                    unresolved: false,
                });
                return end;
            }
            self.imports.push(JsImportEdge {
                specifier: String::new(),
                offset: i,
                dynamic: true,
                unresolved: true,
            });
            return j;
        }
        // Static import: scan to `from "spec"` or a bare `"spec"`,
        // across newlines for multi-line imports, bounded so a
        // pathological statement cannot hang the scan.
        // `import.meta` records no edge. A statement end or window
        // exhaustion without a specifier records an unresolved edge
        // (fail-closed), and the scan consumes through the specifier
        // so the `from` arm below never records the same edge twice.
        if j + 4 <= blanked.len()
            && blanked[j] == b'.'
            && js_keyword_at(blanked, j + 1, b"meta")
        {
            return j + 5;
        }
        match find_from_specifier(original, blanked, j) {
            Some((spec, at, end)) => {
                self.imports.push(JsImportEdge {
                    specifier: spec,
                    offset: at,
                    dynamic: false,
                    unresolved: false,
                });
                end
            }
            None => {
                // No specifier before the statement end: `import`
                // with no edge (bare keyword, `import x` fragment).
                // A bare `import` is invalid syntax, so record it
                // unresolved rather than silently passing it.
                self.imports.push(JsImportEdge {
                    specifier: String::new(),
                    offset: i,
                    dynamic: false,
                    unresolved: true,
                });
                // Consume through the statement end or the window so the
                // `from` scan below never records the same edge twice.
                let window = (j + 4096).min(blanked.len());
                let mut k = j;
                while k < window && blanked[k] != b';' {
                    k += 1;
                }
                k.min(blanked.len())
            }
        }
    }

    fn scan_require(&mut self, original: &[u8], blanked: &[u8], i: usize) -> usize {
        let mut j = i + 7;
        skip_js_ws(blanked, &mut j);
        if j < blanked.len() && blanked[j] == b'(' {
            self.has_require = true;
            self.require_offset = i;
            let mut m = j + 1;
            skip_js_trivia_original(original, &mut m);
            if let Some((spec, _)) = read_js_specifier(original, m) {
                self.imports.push(JsImportEdge {
                    specifier: spec,
                    offset: m,
                    dynamic: true,
                    unresolved: false,
                });
            }
        }
        j
    }

    fn scan_from(&mut self, original: &[u8], blanked: &[u8], i: usize) -> usize {
        // Re-export edges: `export ... from "spec"` handled by the
        // `from` scan below at the `from` keyword itself.
        let mut j = i + 4;
        skip_js_trivia_original(original, &mut j);
        if let Some((spec, end)) = read_js_specifier(original, j) {
            self.imports.push(JsImportEdge {
                specifier: spec,
                offset: j,
                dynamic: false,
                unresolved: false,
            });
            return end;
        }
        i + 1
    }
}

fn find_from_specifier(
    original: &[u8],
    blanked: &[u8],
    j: usize,
) -> Option<(String, usize, usize)> {
    let mut k = j;
    let window = (j + 4096).min(blanked.len());
    while k < window && blanked[k] != b';' {
        if js_keyword_at(blanked, k, b"from") {
            let mut m = k + 4;
            skip_js_trivia_original(original, &mut m);
            if let Some((spec, end)) = read_js_specifier(original, m) {
                return Some((spec, m, end));
            }
            return None;
        }
        if original.get(k) == Some(&b'\'') || original.get(k) == Some(&b'"') {
            if let Some((spec, end)) = read_js_specifier(original, k) {
                return Some((spec, k, end));
            }
            return None;
        }
        k += 1;
    }
    None
}

fn scan_js_module(js: &str) -> JsModuleScan {
    let original = js.as_bytes();
    let blanked = blank_js_trivia(js);
    let mut state = JsScanState {
        exports: Vec::new(),
        imports: Vec::new(),
        has_require: false,
        require_offset: 0,
        seen_exports: std::collections::HashSet::new(),
    };
    let mut i = 0;
    while i < blanked.len() {
        if js_keyword_at(&blanked, i, b"export") {
            i = state.scan_export(&blanked, i);
            continue;
        }
        if js_keyword_at(&blanked, i, b"import") {
            i = state.scan_import(original, &blanked, i);
            continue;
        }
        if js_keyword_at(&blanked, i, b"require") {
            i = state.scan_require(original, &blanked, i);
            continue;
        }
        if js_keyword_at(&blanked, i, b"from") {
            i = state.scan_from(original, &blanked, i);
            continue;
        }
        i += 1;
    }
    JsModuleScan {
        exports: state.exports,
        imports: state.imports,
        has_require: state.has_require,
        require_offset: state.require_offset,
    }
}

/// Whether a specifier stays inside the unit's own directory.
fn is_unit_relative_specifier(specifier: &str) -> bool {
    specifier == "."
        || specifier == ".."
        || specifier.starts_with("./")
        || specifier.starts_with("../")
}

/// Refuse every import a workerd/browser bundle cannot take: bare
/// specifiers (no package resolution in the worker, and v1 admits no
/// producer imports for saved units), `node:`/Node builtins, `file:`
/// URLs, non-literal or unresolvable edges, and CommonJS `require`.
/// Source, process, and filesystem APIs never enter worker/browser
/// bundles.
///
/// Future owner-integrated producers extend the admitted relative set
/// explicitly; nothing is admitted by appearing in JS.
fn admit_js_imports(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    scan: &JsModuleScan,
    runtime: &str,
) -> Result<(), ValidationFailure> {
    admit_js_imports_inner(id, scan, runtime, "implementation")
}

/// Admit one saved file's import edges: `origin` names the file in
/// diagnostics (`implementation` for the root module, ``file `rel` ``
/// for closure members).
fn admit_js_imports_inner(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    scan: &JsModuleScan,
    runtime: &str,
    origin: &str,
) -> Result<(), ValidationFailure> {
    const NODE_BUILTINS: &[&str] = &[
        "assert",
        "buffer",
        "child_process",
        "cluster",
        "crypto",
        "dgram",
        "dns",
        "events",
        "fs",
        "http",
        "https",
        "module",
        "net",
        "os",
        "path",
        "process",
        "querystring",
        "readline",
        "stream",
        "string_decoder",
        "timers",
        "tls",
        "tty",
        "url",
        "util",
        "v8",
        "vm",
        "worker_threads",
        "zlib",
    ];
    if scan.has_require {
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` {runtime} {origin} calls `require(` at offset {}; CommonJS require never enters worker/browser bundles",
                id.as_str(),
                scan.require_offset
            ),
            vec!["remove the require call and resend validate".to_string()],
        ));
    }
    for edge in &scan.imports {
        if edge.unresolved || edge.specifier.is_empty() {
            let what = if edge.dynamic {
                "a non-literal dynamic import"
            } else {
                "an unresolvable import"
            };
            return Err(ValidationFailure::new(
                format!(
                    "unit `{}` {runtime} {origin} has {what} at offset {}; only literal specifiers validate",
                    id.as_str(),
                    edge.offset
                ),
                vec!["use a literal unit-local import and resend validate".to_string()],
            ));
        }
        if is_unit_relative_specifier(&edge.specifier) {
            continue;
        }
        let builtin = edge
            .specifier
            .strip_prefix("node:")
            .unwrap_or(&edge.specifier);
        let builtin = builtin.split('/').next().unwrap_or("");
        if edge.specifier.starts_with("node:")
            || edge.specifier.starts_with("file:")
            || NODE_BUILTINS.contains(&builtin)
        {
            return Err(ValidationFailure::new(
                format!(
                    "unit `{}` {runtime} {origin} imports `{}` at offset {}; source/process/filesystem APIs never enter worker/browser bundles",
                    id.as_str(),
                    edge.specifier,
                    edge.offset
                ),
                vec!["remove the privileged import and resend validate".to_string()],
            ));
        }
        return Err(ValidationFailure::new(
            format!(
                "unit `{}` {runtime} {origin} imports bare specifier `{}` at offset {}; v1 admits only unit-local relative imports",
                id.as_str(),
                edge.specifier,
                edge.offset
            ),
            vec!["use a unit-local relative import and resend validate".to_string()],
        ));
    }
    Ok(())
}

/// Resolve one unit-local import specifier against its importing file
/// to the consumed unit-relative path. Lexical POSIX normalization
/// (mirrors the Node `posix.normalize(posix.join(dirname, spec))`
/// resolution over staged modules): `.` segments collapse, `..`
/// pops, and anything escaping the unit directory or naming a
/// directory returns `None`.
fn normalize_unit_import(importer_rel: &str, specifier: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if let Some((dir, _)) = importer_rel.rsplit_once('/') {
        parts.extend(dir.split('/').filter(|part| !part.is_empty()));
    }
    for part in specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Resolve the transitive unit-local import closure of one saved root
/// module against its own saved group.
///
/// Every consumed file is admitted like the root (literal unit-local
/// specifiers only, no `require`, no builtins/bare/`file:` edges) and
/// must exist as UTF-8 inside the unit directory: `..` escapes and
/// missing targets refuse, because an unfingerprinted dependency must
/// never validate or pack silently. Returns each consumed file once
/// (the root excluded) in byte-ascending `rel_path` order, ready for
/// [`given_closure_fingerprint`](crate::analysis::types::given_closure_fingerprint).
/// Errors are plain details naming the unit and file; validation
/// wraps them in [`ValidationFailure`], ordinary compilation in an
/// `E6008` diagnostic.
fn resolve_saved_js_closure(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    group: &crate::analysis::generation_intake::SavedGroup,
    root_rel: &str,
    root_js: &str,
    runtime: &str,
) -> Result<Vec<crate::analysis::types::GivenSavedImport>, String> {
    use crate::analysis::types::GivenSavedImport;
    let mut ordered: Vec<GivenSavedImport> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(root_rel.to_string());
    let mut stack: Vec<(String, String)> = vec![(root_rel.to_string(), root_js.to_string())];
    while let Some((rel, js)) = stack.pop() {
        let scan = scan_js_module(&js);
        let origin = if rel == root_rel {
            "implementation".to_string()
        } else {
            format!("file `{rel}`")
        };
        admit_js_imports_inner(id, &scan, runtime, &origin).map_err(|failure| failure.message)?;
        for edge in &scan.imports {
            let Some(target) = normalize_unit_import(&rel, &edge.specifier) else {
                return Err(format!(
                    "unit `{}` {runtime} `{rel}` imports `{}` at offset {}: the specifier escapes the unit directory or names a directory; v1 consumes only unit-local files",
                    id.as_str(),
                    edge.specifier,
                    edge.offset
                ));
            };
            if !seen.insert(target.clone()) {
                continue;
            }
            let Some(file) = group.files.iter().find(|f| f.rel_path == target) else {
                return Err(format!(
                    "unit `{}` {runtime} `{rel}` imports `{}` at offset {}: no such saved file `{target}`; add the file or reconcile with adopt",
                    id.as_str(),
                    edge.specifier,
                    edge.offset
                ));
            };
            let text = String::from_utf8(file.bytes.clone()).map_err(|_| {
                format!(
                    "unit `{}` `{target}` is not valid UTF-8; repair the file or reconcile with adopt",
                    id.as_str(),
                )
            })?;
            ordered.push(GivenSavedImport {
                rel_path: target.clone(),
                bytes: file.bytes.clone(),
            });
            stack.push((target, text));
        }
    }
    ordered.sort_by(|a, b| a.rel_path.as_bytes().cmp(b.rel_path.as_bytes()));
    Ok(ordered)
}

/// Split a scope path into its owning unit id and unit-relative path.
/// Only `can.generated/<id>/<rel>` with a well-formed id and a
/// relative, traversal-free remainder qualifies; anything else is not
/// a saved output file.
fn split_saved_path(path: &str) -> Option<(String, String)> {
    use crate::analysis::generation_intake as intake;
    let rest = path.strip_prefix(&format!("{}/", intake::GENERATED_DIR))?;
    let (id, rel) = rest.split_once('/')?;
    if intake::GenerationUnitId::parse(id).is_err() || rel.is_empty() {
        return None;
    }
    let rel_path = std::path::Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some((id.to_string(), rel.to_string()))
}

/// Validate directly repaired saved files byte-for-byte against their
/// owning units. Each file must live under `can.generated/<id>/` with
/// a parseable record; anything else diagnoses (source reconciliation
/// is `adopt`, BGI-12). Byte-level checks mirror the unit scope — JS
/// admission, declared exports, CSS scope, asset presence — without
/// re-checking the owning source, except field-check modules also verify their
/// source-owned field attachment and carrier; drift against recorded originals is
/// reported per file, never regenerated.
fn validate_saved_files(
    header: &crate::analysis::generation_protocol::RequestHeader,
    root: &str,
    files: &[String],
) -> DispatchResult {
    use crate::analysis::generation_intake as intake;
    use crate::analysis::generation_protocol as proto;
    let root_path = Path::new(root);
    // Bind the scope plus the sibling inputs validation consumes
    // (unit records, keyword declarations), so the envelope reports
    // the exact consumed closure.
    let mut bound_paths: Vec<String> = files.to_vec();
    for file in files {
        if let Some((id, rel)) = split_saved_path(file) {
            for sibling in [intake::UNIT_FILE, DECLARATION_FILE] {
                let candidate = format!("{}/{id}/{sibling}", intake::GENERATED_DIR);
                if root_path.join(&candidate).is_file() {
                    bound_paths.push(candidate);
                }
            }
            if rel == "implementation.js" {
                let record_path = root_path
                    .join(intake::GENERATED_DIR)
                    .join(&id)
                    .join(intake::UNIT_FILE);
                let record = std::fs::read_to_string(record_path).ok().and_then(|text| {
                    intake::GenerationUnitId::parse(&id)
                        .ok()
                        .and_then(|id| intake::UnitRecord::parse(&text, &id).ok())
                });
                if let Some(record) = record
                    && matches!(
                        record.source.kind,
                        intake::UnitKind::NamedTrait | intake::UnitKind::InlineTrait
                    )
                {
                    let group = match intake::read_saved_group(root_path, &record.id) {
                        Ok(group) => group,
                        Err(issue) => {
                            return validation_failure_envelope(
                                header,
                                ValidationFailure::new(
                                    issue.to_string(),
                                    vec!["repair the saved group and resend validate".into()],
                                ),
                            );
                        }
                    };
                    bound_paths.push(record.source.path.clone());
                    bound_paths.extend(
                        group.files.iter().map(|file| {
                            format!("{}/{id}/{}", intake::GENERATED_DIR, file.rel_path)
                        }),
                    );
                }
            }
        }
    }
    let inputs = match crate::source::ValidationInputs::bind(root_path, &bound_paths) {
        Ok(inputs) => inputs,
        Err(err) => {
            return validation_failure_envelope(
                header,
                ValidationFailure::new(
                    err.to_string(),
                    vec!["pass readable saved files and resend".to_string()],
                ),
            );
        }
    };
    let scope: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut reports = Vec::new();
    for file in &inputs.files {
        if !scope.contains(file.path.as_str()) {
            continue;
        }
        match validate_one_saved_file(root_path, &inputs, &file.path, &file.bytes) {
            Ok(report) => reports.push(report),
            Err(failure) => return validation_failure_envelope(header, failure),
        }
    }
    let mut payload = serde_json::Map::new();
    payload.insert("files".to_string(), serde_json::Value::Array(reports));
    payload.insert(
        "inputs".to_string(),
        serde_json::json!({
            "files": inputs.files.iter().map(|f| serde_json::json!({
                "path": f.path,
                "sha256": f.sha256,
                "role": if scope.contains(f.path.as_str()) { "scope" } else { "sibling" },
            })).collect::<Vec<_>>(),
        }),
    );
    gen_envelope_result(
        exit::OK,
        proto::ok_envelope(header, "validated", payload, vec![]),
    )
}

/// Loaded owning unit for one saved file under validation.
struct SavedUnitRecord {
    id_text: String,
    id: crate::analysis::generation_intake::GenerationUnitId,
    record: crate::analysis::generation_intake::UnitRecord,
    rel: String,
}

/// Resolve one scope path to its owning unit id and parsed unit record.
fn load_saved_unit_record(
    inputs: &crate::source::ValidationInputs,
    path: &str,
) -> Result<SavedUnitRecord, ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    let Some((id_text, rel)) = split_saved_path(path) else {
        return Err(ValidationFailure::new(
            format!(
                "scope file `{path}` is not a saved output file; validate takes files under `can.generated/<id>/`"
            ),
            vec!["pass saved output files under can.generated/<id>/ and resend".to_string()],
        ));
    };
    // Admission parsed this id; re-parse stays total.
    let id = intake::GenerationUnitId::parse(&id_text).map_err(|reason| {
        ValidationFailure::new(
            format!("scope file `{path}` names no saved unit: {reason}"),
            vec!["pass saved output files under can.generated/<id>/ and resend".to_string()],
        )
    })?;
    let record_path = format!("{}/{id_text}/{}", intake::GENERATED_DIR, intake::UNIT_FILE);
    let record_text = inputs
        .files
        .iter()
        .find(|f| f.path == record_path)
        .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
        .unwrap_or_default();
    let record = intake::UnitRecord::parse(&record_text, &id).map_err(|reason| {
        ValidationFailure::new(
            format!("owning unit `{id_text}` record is incompatible: {reason}; reconcile with an explicit bind"),
            vec!["send a bind request to reconcile the unit's association".to_string()],
        )
    })?;
    Ok(SavedUnitRecord {
        id_text,
        id,
        record,
        rel,
    })
}

/// Validate a saved `declaration.json` against its keyword unit.
fn validate_saved_declaration(
    id_text: &str,
    kind: crate::analysis::generation_intake::UnitKind,
    bytes: &[u8],
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    if kind != intake::UnitKind::Keyword {
        return Err(ValidationFailure::new(
            format!(
                "unit `{id_text}` ({}) carries unexpected `{DECLARATION_FILE}`: only keyword units declare a producer/export interface in v1",
                kind.as_str(),
            ),
            vec![
                "remove the unexpected declaration file, or send a bind request to reconcile the unit".to_string(),
            ],
        ));
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        ValidationFailure::new(
            format!("unit `{id_text}` `{DECLARATION_FILE}` is not valid UTF-8"),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    let parsed: SavedDeclarationFile = serde_json::from_str(&text).map_err(|err| {
        ValidationFailure::new(
            format!(
                "unit `{id_text}` `{DECLARATION_FILE}` is not a valid saved declaration: {err}"
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    if parsed.producer.is_empty() || parsed.export.is_empty() {
        return Err(ValidationFailure::new(
            format!("unit `{id_text}` `{DECLARATION_FILE}` names no producer/export"),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    checks.push(validation_check(
        "declaration",
        format!("producer `{}` export `{}`", parsed.producer, parsed.export),
    ));
    Ok(())
}

/// Check a keyword unit's saved implementation against its declaration.
fn check_saved_keyword_implementation(
    inputs: &crate::source::ValidationInputs,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    id_text: &str,
    scan: &JsModuleScan,
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    let decl_path = format!("{}/{id_text}/{DECLARATION_FILE}", intake::GENERATED_DIR);
    let Some(decl) = inputs.files.iter().find(|f| f.path == decl_path) else {
        return Err(ValidationFailure::new(
            format!(
                "unit `{id_text}` declares no saved interface: `{DECLARATION_FILE}` is missing; reconcile the interface with adopt or regenerate the unit"
            ),
            vec![
                "send an adopt request to reconcile the unit's declared interface (BGI-12)".to_string(),
            ],
        ));
    };
    let decl_text = String::from_utf8_lossy(&decl.bytes).into_owned();
    let parsed: SavedDeclarationFile =
        serde_json::from_str(&decl_text).map_err(|err| {
            ValidationFailure::new(
                format!(
                    "unit `{id_text}` `{DECLARATION_FILE}` is not a valid saved declaration: {err}"
                ),
                vec![ValidationFailure::drift(String::new()).next.remove(0)],
            )
        })?;
    if !scan.exports.iter().any(|e| e == &parsed.export) {
        return Err(ValidationFailure::new(
            format!(
                "unit `{id_text}` declares export `{}` with no matching saved export in `implementation.js`; repair the export or reconcile with adopt",
                parsed.export
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    checks.push(validation_check(
        "exports",
        format!("saved module declares `{}`", parsed.export),
    ));
    admit_js_imports(id, scan, "workerd")?;
    Ok(())
}

/// Check a view unit's saved implementation for its `render` export.
fn check_saved_view_implementation(
    id: &crate::analysis::generation_intake::GenerationUnitId,
    id_text: &str,
    scan: &JsModuleScan,
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    if !scan.exports.iter().any(|e| e == "render") {
        return Err(ValidationFailure::new(
            format!(
                "unit `{id_text}` view implementation declares no `render` export in `implementation.js`; repair the export or reconcile with adopt"
            ),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        ));
    }
    checks.push(validation_check(
        "exports",
        "saved module declares `render`".to_string(),
    ));
    admit_js_imports(id, scan, "workerd/browser")?;
    Ok(())
}

/// Check a checked field-trait unit's saved implementation in source.
fn check_saved_trait_implementation(
    root_path: &Path,
    inputs: &crate::source::ValidationInputs,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    id_text: &str,
    record: &crate::analysis::generation_intake::UnitRecord,
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    let prefix = format!("{}/{id_text}/", intake::GENERATED_DIR);
    let files = inputs
        .files
        .iter()
        .filter_map(|file| {
            let rel = file.path.strip_prefix(&prefix)?;
            (rel != intake::UNIT_FILE).then(|| intake::SavedFile {
                rel_path: rel.to_string(),
                bytes: file.bytes.clone(),
                sha256: file.sha256.clone(),
            })
        })
        .collect();
    let group = intake::SavedGroup {
        record: record.clone(),
        files,
        dir: root_path.join(&prefix),
    };
    let source = inputs
        .files
        .iter()
        .find(|file| file.path == record.source.path)
        .and_then(|file| std::str::from_utf8(&file.bytes).ok())
        .ok_or_else(|| {
            ValidationFailure::new(
                format!("unit `{id_text}` field check has no captured owning source"),
                vec!["restore the owning source and resend validate".into()],
            )
        })?;
    validate_trait_unit(id, &group, source, checks)?;
    Ok(())
}

/// Validate a saved `implementation.js` against its owning unit's kind.
fn validate_saved_implementation(
    root_path: &Path,
    inputs: &crate::source::ValidationInputs,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    id_text: &str,
    kind: crate::analysis::generation_intake::UnitKind,
    bytes: &[u8],
    record: &crate::analysis::generation_intake::UnitRecord,
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        ValidationFailure::new(
            format!("unit `{id_text}` `implementation.js` is not valid UTF-8"),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    let scan = scan_js_module(&text);
    match kind {
        intake::UnitKind::Keyword => {
            check_saved_keyword_implementation(inputs, id, id_text, &scan, checks)?;
        }
        intake::UnitKind::View => {
            check_saved_view_implementation(id, id_text, &scan, checks)?;
        }
        intake::UnitKind::NamedTrait | intake::UnitKind::InlineTrait => {
            check_saved_trait_implementation(root_path, inputs, id, id_text, record, checks)?;
        }
        _ => {
            return Err(ValidationFailure::new(
                format!(
                    "unit `{id_text}` ({}) carries unexpected `implementation.js`: only keywords, checked field traits and views own saved JavaScript",
                    kind.as_str(),
                ),
                vec![
                    "remove the unexpected implementation file, or send a bind request to reconcile the unit".to_string(),
                ],
            ));
        }
    }
    checks.push(validation_check(
        "imports",
        if scan.imports.is_empty() {
            "no imports".to_string()
        } else {
            format!(
                "{} unit-local relative import{}",
                scan.imports.len(),
                if scan.imports.len() == 1 { "" } else { "s" }
            )
        },
    ));
    Ok(())
}

/// Validate a saved `contributions.can` carrier parses.
fn validate_saved_contributions(
    id_text: &str,
    bytes: &[u8],
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let (_, parse_diags) = crate::analysis::types::parse_given_carrier(SourceId(0), &text);
    if !parse_diags.is_empty() {
        return Err(ValidationFailure::new(
            format!(
                "unit `{id_text}` contributions carrier does not parse: {}",
                diagnostic_summary(&parse_diags)
            ),
            vec!["fix the carrier and resend validate".to_string()],
        ));
    }
    checks.push(validation_check(
        "carrier",
        "contributions carrier parses (unit scope checks its contracts)".to_string(),
    ));
    Ok(())
}

/// Check scoped stylesheet assets resolve to saved files of matching type.
fn check_saved_style_assets(
    id_text: &str,
    group: &crate::analysis::generation_intake::SavedGroup,
    assets: &[String],
) -> Result<(), ValidationFailure> {
    for asset in assets {
        if !group.files.iter().any(|f| f.rel_path == *asset) {
            return Err(ValidationFailure::new(
                format!(
                    "unit `{id_text}` `style.css` references owned asset `{asset}` with no saved file; add the asset or reconcile with adopt"
                ),
                vec![ValidationFailure::drift(String::new()).next.remove(0)],
            ));
        }
    }
    for asset in assets {
        let file = group
            .files
            .iter()
            .find(|file| &file.rel_path == asset)
            .expect("asset existence checked");
        crate::codegen::artifact::style_asset_content_type(asset, &file.bytes).map_err(
            |detail| {
                ValidationFailure::new(
                    detail,
                    vec!["replace the asset with matching supported bytes".to_string()],
                )
            },
        )?;
    }
    Ok(())
}

/// Validate a saved `style.css` scopes and owns its asset references.
fn validate_saved_style(
    root_path: &Path,
    id: &crate::analysis::generation_intake::GenerationUnitId,
    id_text: &str,
    bytes: &[u8],
    checks: &mut Vec<serde_json::Value>,
) -> Result<(), ValidationFailure> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        ValidationFailure::new(
            format!("unit `{id_text}` `style.css` is not valid UTF-8"),
            vec![ValidationFailure::drift(String::new()).next.remove(0)],
        )
    })?;
    let scoped = crate::css_scope::scope_stylesheet(id.as_str(), &text).map_err(|errors| {
        let first = &errors[0];
        ValidationFailure::new(
            format!(
                "unit `{id_text}` `style.css` failed scope checks: {} {} (line {}, column {})",
                first.code, first.message, first.line, first.column,
            ),
            vec!["fix the CSS and resend validate".to_string()],
        )
    })?;
    // Owned assets resolve against the owning unit's saved group.
    let group = crate::analysis::generation_intake::read_saved_group(root_path, id)
        .map_err(|issue| {
            let next = intake_issue_next(&issue);
            ValidationFailure::new(issue.to_string(), next)
        })?;
    check_saved_style_assets(id_text, &group, &scoped.assets)?;
    checks.push(validation_check(
        "scope",
        format!(
            "css scopes ({} asset{})",
            scoped.assets.len(),
            if scoped.assets.len() == 1 { "" } else { "s" },
        ),
    ));
    Ok(())
}

/// Validate one bound saved file against its owning unit's record and
/// siblings. Returns the file's envelope report.
fn validate_one_saved_file(
    root_path: &Path,
    inputs: &crate::source::ValidationInputs,
    path: &str,
    bytes: &[u8],
) -> Result<serde_json::Value, ValidationFailure> {
    use crate::analysis::generation_intake as intake;
    let loaded = load_saved_unit_record(inputs, path)?;
    let id_text = loaded.id_text.as_str();
    let rel = loaded.rel.as_str();
    let mut checks = Vec::new();
    let kind = loaded.record.source.kind;
    if rel == intake::UNIT_FILE {
        checks.push(validation_check("record", "unit record parses".to_string()));
    } else if rel == DECLARATION_FILE {
        validate_saved_declaration(id_text, kind, bytes, &mut checks)?;
    } else if rel == "implementation.js" {
        validate_saved_implementation(
            root_path,
            inputs,
            &loaded.id,
            id_text,
            kind,
            bytes,
            &loaded.record,
            &mut checks,
        )?;
    } else if rel == "contributions.can" {
        validate_saved_contributions(id_text, bytes, &mut checks)?;
    } else if rel == "style.css" {
        validate_saved_style(root_path, &loaded.id, id_text, bytes, &mut checks)?;
    } else {
        checks.push(validation_check(
            "asset",
            format!("{} bytes bound", bytes.len()),
        ));
    }
    let sha256 = crate::source::sha256_hex(bytes);
    Ok(serde_json::json!({
        "path": path,
        "unit": id_text,
        "kind": kind.as_str(),
        "sha256": sha256,
        "modified_since_generation": modified_since_generation(&loaded.record, rel, &sha256),
        "checks": checks,
    }))
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

