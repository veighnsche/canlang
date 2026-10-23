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

mod args;
use args::*;
mod compile;
use compile::*;
mod reference;
use reference::*;
mod entry;
use entry::*;
mod generation;
use generation::*;

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

