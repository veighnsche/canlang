//! Private reference command implementation.
use super::*;

/// Render diagnostics with exit 10: shared by the analysis-error and
/// emission-error paths of [`run_compile`].
/// Success prints the policy surface: the JSON dump as json, one
/// declaration per line as text (source order).
pub(super) fn run_policy(
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
pub(super) fn run_docs(
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
