//! Private generation command implementation.
use super::*;

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
pub(super) fn run_gen(
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
    evidence:
        std::collections::HashMap<SourceId, crate::analysis::generation_intake::AssociationSource>,
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
            let inputs = match crate::source::ValidationInputs::bind(root_path, &paths) {
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
            current_files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
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
    _params: &crate::analysis::generation_protocol::BindParams,
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
    let current_bindings = intake::associate_with_sources(scope_descriptors, saved, scope_evidence);
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
    let (legacy_lease, legacy_files) =
        match bind_adopt_legacy(&header.request_id, root_path, &request, &mut saved, &fail) {
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
pub(super) struct ValidationFailure {
    pub(super) message: String,
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
    let report = match collect_gen_status(root, std::slice::from_ref(&record.source.path)) {
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
pub(super) fn read_saved_declaration(
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
pub(super) struct JsModuleScan {
    pub(super) exports: Vec<String>,
    imports: Vec<JsImportEdge>,
    has_require: bool,
    require_offset: usize,
}

/// Blank comments and string-literal contents with spaces, preserving
/// byte length and newlines so offsets still address the original.
/// Template `${...}` interpolations stay code; everywhere else inside
/// a literal is blanked.
fn blank_js_range(out: &mut [u8], from: usize, to: usize) {
    for b in &mut out[from..to] {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}

fn blank_js_line_comment(bytes: &[u8], out: &mut [u8], i: &mut usize) {
    let from = *i;
    while *i < bytes.len() && bytes[*i] != b'\n' {
        *i += 1;
    }
    blank_js_range(out, from, *i);
}

fn blank_js_block_comment(bytes: &[u8], out: &mut [u8], i: &mut usize) {
    let from = *i;
    *i += 2;
    while *i + 1 < bytes.len() && !(bytes[*i] == b'*' && bytes[*i + 1] == b'/') {
        *i += 1;
    }
    *i = (*i + 2).min(bytes.len());
    blank_js_range(out, from, *i);
}

fn blank_js_string(bytes: &[u8], out: &mut [u8], i: &mut usize, quote: u8) {
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

fn blank_js_template(bytes: &[u8], out: &mut [u8], i: &mut usize) {
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
        if j + 4 <= blanked.len() && blanked[j] == b'.' && js_keyword_at(blanked, j + 1, b"meta") {
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

    fn scan_from(&mut self, original: &[u8], _blanked: &[u8], i: usize) -> usize {
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

pub(super) fn scan_js_module(js: &str) -> JsModuleScan {
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
pub(super) fn resolve_saved_js_closure(
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
                "send an adopt request to reconcile the unit's declared interface (BGI-12)"
                    .to_string(),
            ],
        ));
    };
    let decl_text = String::from_utf8_lossy(&decl.bytes).into_owned();
    let parsed: SavedDeclarationFile = serde_json::from_str(&decl_text).map_err(|err| {
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
    let group =
        crate::analysis::generation_intake::read_saved_group(root_path, id).map_err(|issue| {
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
