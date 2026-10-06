//! Retained-session job loop (P03.3 states).
//!
//! One process serves one job: handshake, then exactly one `Begin`,
//! then the stage sequence with at most one open `NeedHost` (token
//! resumes exactly once, in issue order), then one terminal
//! (`Prepared` or `Failed`). P03.3 runs a fixed two-probe scaffold
//! sequence; P04+ replaces `run_stages` with real stage execution
//! while this state machine (tokens, abort, EOF, failure mapping)
//! stays frozen.

use crate::artifact::validate_artifact;
use crate::compatibility::{
    check_compatibility, check_compiler_version_match, installed_from_tree,
};
use crate::failures::semantic;
use crate::failures::transport;
use crate::input::{as_num, as_text, decode_tree, encode_tree, obj_get, render_text, Node};
use crate::protocol::{
    parse_host_message, read_frame, write_json, BeginBody, Failure, FailureBody, FrameError,
    Handshake, HandshakeAccept, HostMessage, NeedBody, NeedHost, Prepared, PreparedBody,
    PROTOCOL_NAME, PROTOCOL_VERSION, TAG_JSON,
};
use crate::release::{assert_lockstep, LockstepInputs, RELEASE_VERSION};
use std::io::{Read, Write};

/// Scaffold stage script (P03.3): fixed probe sequence proving the
/// request/resume machinery. P04+ replaces it with real stages.
const SCAFFOLD_STAGES: [&str; 2] = ["mcp_bun_probe", "catalog_probe"];

/// Serve one job. Returns the process exit code (0 clean EOF,
/// terminal `Prepared`, or acknowledged `Abort`; 1 framing or
/// protocol violation at any point).
pub fn run_job(reader: &mut impl Read, writer: &mut impl Write) -> i32 {
    match serve(reader, writer) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

/// Read the next host message frame. Maps transport failures to the
/// abort path; `Ok(None)` is clean EOF between messages.
fn next_message(reader: &mut impl Read, what: &str) -> Result<Option<(u8, Vec<u8>)>, Failure> {
    match read_frame(reader) {
        Ok(frame) => Ok(frame),
        Err(FrameError::Eof) => Err(Failure::new(
            transport::TRUNCATED,
            format!("{what}: truncated frame"),
        )),
        Err(FrameError::TooLarge(n)) => Err(Failure::new(
            transport::FRAME_TOO_LARGE,
            format!("{what}: declared length {n} exceeds cap"),
        )),
        Err(FrameError::BadTag(t)) => Err(Failure::new(
            transport::FRAME_CORRUPT,
            format!("{what}: unknown frame tag {t}"),
        )),
        Err(e) => Err(Failure::new(
            transport::FRAME_CORRUPT,
            format!("{what}: invalid frame ({e})"),
        )),
    }
}

/// Emit a terminal `Failed` frame. Best effort: a dead peer fails the
/// job, never hangs it.
fn fail(writer: &mut impl Write, failure: &Failure) {
    let _ = write_json(writer, failure);
}

fn serve(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), i32> {
    let (tag, payload) = match read_frame(reader) {
        Ok(Some(frame)) => frame,
        Ok(None) => {
            eprintln!("can-preparation: empty session (EOF before handshake)");
            return Ok(());
        }
        Err(e) => {
            eprintln!("can-preparation: handshake frame invalid: {e}");
            return Err(1);
        }
    };
    if tag != TAG_JSON {
        eprintln!("can-preparation: handshake must be a JSON frame");
        return Err(1);
    }
    let hello: Handshake = match serde_json::from_slice(&payload) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("can-preparation: handshake is not a Handshake: {e}");
            return Err(1);
        }
    };
    if hello.protocol != PROTOCOL_NAME || hello.version != PROTOCOL_VERSION {
        let failure = Failure::new(
            transport::VERSION_MISMATCH,
            format!(
                "want {} v{}, got {} v{}",
                PROTOCOL_NAME, PROTOCOL_VERSION, hello.protocol, hello.version
            ),
        );
        let _ = write_json(writer, &failure);
        return Err(1);
    }
    if write_json(
        writer,
        &HandshakeAccept {
            ready: true,
            protocol: PROTOCOL_NAME.to_string(),
            version: PROTOCOL_VERSION,
            job: "scaffold-probes".to_string(),
        },
    )
    .is_err()
    {
        return Err(1);
    }
    // Exactly one Begin opens the job. EOF here is a clean no-job
    // session; anything else is a violation.
    let begin = match next_message(reader, "begin") {
        Err(failure) => {
            eprintln!("can-preparation: {}", failure.error.detail);
            fail(writer, &failure);
            return Err(1);
        }
        Ok(None) => return Ok(()),
        Ok(Some((tag, payload))) => {
            if tag != TAG_JSON {
                let failure = Failure::new(
                    transport::FRAME_CORRUPT,
                    "begin: expected a JSON frame".to_string(),
                );
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            match parse_host_message(&payload) {
                Some(HostMessage::Begin(begin)) => begin,
                Some(HostMessage::Abort(abort)) => {
                    eprintln!(
                        "can-preparation: aborted before begin{}",
                        abort.reason.map(|r| format!(": {r}")).unwrap_or_default()
                    );
                    fail(
                        writer,
                        &Failure::new(semantic::ABORTED, "aborted before begin".to_string()),
                    );
                    return Ok(());
                }
                _ => {
                    let failure = Failure::new(
                        transport::PROTOCOL_VIOLATION,
                        "begin: expected {begin:{mode}}".to_string(),
                    );
                    eprintln!("can-preparation: {}", failure.error.detail);
                    fail(writer, &failure);
                    return Err(1);
                }
            }
        }
    };
    // A Begin WITHOUT artifact_path runs the frozen scaffold script;
    // WITH it, build/deploy run real P04.4 execution.
    match begin.artifact_path.clone() {
        None => run_stages(reader, writer, &begin.mode),
        Some(artifact_path) => run_real_stages(reader, writer, &begin, &artifact_path),
    }
}

/// Walk the stage script: one open NeedHost at a time, each token
/// resuming exactly once, then terminal Prepared.
fn run_stages(reader: &mut impl Read, writer: &mut impl Write, mode: &str) -> Result<(), i32> {
    let mut resumes: Vec<serde_json::Value> = Vec::new();
    for (index, stage) in SCAFFOLD_STAGES.iter().enumerate() {
        let token = index as u64 + 1;
        let need = NeedHost {
            need: NeedBody {
                token,
                stage: stage.to_string(),
                request: serde_json::json!({"probe": stage}),
            },
        };
        if write_json(writer, &need).is_err() {
            return Err(1);
        }
        match next_message(reader, &format!("resume token {token}")) {
            Err(failure) => {
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            Ok(None) => {
                let failure = Failure::new(
                    transport::TRUNCATED,
                    format!("resume token {token}: EOF with NeedHost open"),
                );
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Err(1);
            }
            Ok(Some((tag, payload))) => {
                if tag != TAG_JSON {
                    let failure = Failure::new(
                        transport::FRAME_CORRUPT,
                        format!("resume token {token}: expected a JSON frame"),
                    );
                    eprintln!("can-preparation: {}", failure.error.detail);
                    fail(writer, &failure);
                    return Err(1);
                }
                match parse_host_message(&payload) {
                    Some(HostMessage::Resume(resume)) if resume.token == token => {
                        resumes.push(resume.payload);
                    }
                    Some(HostMessage::Abort(abort)) => {
                        eprintln!(
                            "can-preparation: aborted with token {token} open{}",
                            abort.reason.map(|r| format!(": {r}")).unwrap_or_default()
                        );
                        fail(
                            writer,
                            &Failure::new(
                                semantic::ABORTED,
                                format!("aborted with token {token} open"),
                            ),
                        );
                        return Ok(());
                    }
                    _ => {
                        let failure = Failure::new(
                            transport::PROTOCOL_VIOLATION,
                            format!("resume token {token}: expected {{resume:{{token:{token}}}}}"),
                        );
                        eprintln!("can-preparation: {}", failure.error.detail);
                        fail(writer, &failure);
                        return Err(1);
                    }
                }
            }
        }
    }
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: true,
            mode: mode.to_string(),
            stages: SCAFFOLD_STAGES.iter().map(|s| s.to_string()).collect(),
            resumes,
            outputs: serde_json::Value::Null,
        },
    };
    if write_json(writer, &prepared).is_err() {
        return Err(1);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Real execution (P04.4): ordered artifact acceptance before
// companions/environment, build lockstep results, deploy compatibility,
// and the confirmation/activation gates. Refusal order and CLI
// classifications mirror `host.ts runPreparedBuild/runPreparedDeploy`
// exactly; the host stays the filesystem/reader authority (reads,
// parses, loader validation) while the core owns ordering, algorithm
// verdicts, and the confirm/compiler gates.
//
// P05.4/P06.3 append module/plan stages to this script; the compiler
// gate moves after diff/render then (its TS line-421 position), while
// computation stays early. Until then it enforces at the prefix end:
// after ACTIVATION_REQUEST (TS order: activation runs before the
// gate), before any publication.
// ---------------------------------------------------------------------------

/// Host-read stages (one NeedHost round-trip each).
const ST_LOAD_ARTIFACT: &str = "LOAD_ARTIFACT";
const ST_LOAD_COMPANIONS: &str = "LOAD_COMPANIONS";
const ST_LOCKSTEP_INPUTS: &str = "LOCKSTEP_INPUTS";
const ST_ACTIVATION_REQUEST: &str = "ACTIVATION_REQUEST";
/// Native gates (no round-trip; pure over held facts).
const GATE_BEGIN: &str = "BEGIN";
const GATE_COMPAT: &str = "COMPAT_GATE";
const GATE_CONFIRM: &str = "CONFIRM_GATE";
const GATE_COMPILER: &str = "COMPILER_GATE";

/// Outcome of one NeedHost exchange: the resume payload, or a
/// terminal already emitted (exit with the code).
enum Exchange {
    Payload(serde_json::Value),
    Done(i32),
}

/// Issue one NeedHost and await its single resume. Token/abort/EOF
/// semantics mirror the frozen scaffold exchange exactly.
fn exchange(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    stage: &str,
    request: serde_json::Value,
) -> Exchange {
    let need = NeedHost {
        need: NeedBody {
            token,
            stage: stage.to_string(),
            request,
        },
    };
    if write_json(writer, &need).is_err() {
        return Exchange::Done(1);
    }
    let what = format!("resume token {token}");
    match next_message(reader, &what) {
        Err(failure) => {
            eprintln!("can-preparation: {}", failure.error.detail);
            fail(writer, &failure);
            Exchange::Done(1)
        }
        Ok(None) => {
            let failure = Failure::new(
                transport::TRUNCATED,
                format!("resume token {token}: EOF with NeedHost open"),
            );
            eprintln!("can-preparation: {}", failure.error.detail);
            fail(writer, &failure);
            Exchange::Done(1)
        }
        Ok(Some((tag, payload))) => {
            if tag != TAG_JSON {
                let failure = Failure::new(
                    transport::FRAME_CORRUPT,
                    format!("resume token {token}: expected a JSON frame"),
                );
                eprintln!("can-preparation: {}", failure.error.detail);
                fail(writer, &failure);
                return Exchange::Done(1);
            }
            match parse_host_message(&payload) {
                Some(HostMessage::Resume(resume)) if resume.token == token => {
                    Exchange::Payload(resume.payload)
                }
                Some(HostMessage::Abort(abort)) => {
                    eprintln!(
                        "can-preparation: aborted with token {token} open{}",
                        abort.reason.map(|r| format!(": {r}")).unwrap_or_default()
                    );
                    fail(
                        writer,
                        &Failure::new(
                            semantic::ABORTED,
                            format!("aborted with token {token} open"),
                        ),
                    );
                    Exchange::Done(0)
                }
                _ => {
                    let failure = Failure::new(
                        transport::PROTOCOL_VIOLATION,
                        format!("resume token {token}: expected {{resume:{{token:{token}}}}}"),
                    );
                    eprintln!("can-preparation: {}", failure.error.detail);
                    fail(writer, &failure);
                    Exchange::Done(1)
                }
            }
        }
    }
}

/// Refuse the job with a classified CLI failure. Semantic refusals
/// exit 1 (the Failed frame carries the classification); aborts
/// exit 0 via the exchange path, never here.
fn refuse(writer: &mut impl Write, failure: Failure) -> Result<(), i32> {
    eprintln!("can-preparation: {}", failure.error.detail);
    fail(writer, &failure);
    Err(1)
}

/// `usage` refusals mirror `fail(null, "usage", …)`: no command, but
/// the refusing gate is still attributed.
fn usage_refusal(stage: &str, detail: String) -> Failure {
    Failure {
        error: FailureBody {
            code: semantic::USAGE.to_string(),
            detail,
            command: None,
            stage: Some(stage.to_string()),
        },
    }
}

/// Extract the host's `{load_error}` detail, if this resume reports a
/// reader failure instead of facts.
fn load_error(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("load_error")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Decode one tagged tree out of a resume payload field. Decode
/// failures are transport-class (host sent an unadmittable tree).
fn resume_tree(
    payload: &serde_json::Value,
    field: &str,
    command: &str,
    stage: &str,
) -> Result<Node, Failure> {
    let bytes = payload
        .get(field)
        .map(|tree| serde_json::to_vec(tree).unwrap_or_default())
        .unwrap_or_default();
    decode_tree(&bytes).map_err(|e| Failure::for_stage(command, stage, e.code, e.detail))
}

/// Fixed `missingEmission` detail per command (TS discards the loader
/// error; the classification is the signal).
fn missing_emission_detail(command: &str) -> String {
    let verb = if command == "build" {
        "package"
    } else {
        "deploy"
    };
    format!("no L1 CompileArtifact emission to {verb} yet")
}

fn run_real_stages(
    reader: &mut impl Read,
    writer: &mut impl Write,
    begin: &BeginBody,
    artifact_path: &str,
) -> Result<(), i32> {
    let command = begin.mode.as_str();
    if command != "build" && command != "deploy" {
        return refuse(
            writer,
            usage_refusal(
                GATE_BEGIN,
                format!("unknown preparation mode {command:?}: want build|deploy"),
            ),
        );
    }
    let mut token: u64 = 0;
    // Artifact acceptance comes before companions/environment in
    // every mode (TS loads the artifact first).
    token += 1;
    let payload = match exchange(
        reader,
        writer,
        token,
        ST_LOAD_ARTIFACT,
        serde_json::json!({"artifact_path": artifact_path}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    if load_error(&payload).is_some() {
        return refuse(
            writer,
            Failure::for_stage(
                command,
                ST_LOAD_ARTIFACT,
                semantic::MISSING_PRODUCER,
                missing_emission_detail(command),
            ),
        );
    }
    let artifact_tree = match resume_tree(&payload, "tree", command, ST_LOAD_ARTIFACT) {
        Ok(tree) => tree,
        Err(failure) => return refuse(writer, failure),
    };
    let validated = match validate_artifact(&artifact_tree, artifact_path) {
        Ok(validated) => validated,
        Err(error) => {
            return refuse(
                writer,
                Failure::for_stage(
                    command,
                    ST_LOAD_ARTIFACT,
                    semantic::MISSING_PRODUCER,
                    error.message,
                ),
            );
        }
    };
    if command == "build" {
        return run_build_tail(reader, writer, token, &validated);
    }
    run_deploy_tail(reader, writer, token, begin, artifact_path, &validated)
}

/// Build tail: lockstep over host-read tree facts, then the build
/// outputs. Consumes `validated` only for counts/lists.
fn run_build_tail(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    validated: &crate::artifact::ValidatedArtifact,
) -> Result<(), i32> {
    let token = token + 1;
    let payload = match exchange(
        reader,
        writer,
        token,
        ST_LOCKSTEP_INPUTS,
        serde_json::json!({}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    // TS classifies `readLockstepInputs` throws as release-drift with
    // the reader message; malformed resume facts use the same code in
    // the "release stamp" voice (the resume shape is P04.4-defined).
    if let Some(detail) = load_error(&payload) {
        return refuse(
            writer,
            Failure::for_stage("build", ST_LOCKSTEP_INPUTS, semantic::RELEASE_DRIFT, detail),
        );
    }
    let inputs_tree = match resume_tree(&payload, "inputs", "build", ST_LOCKSTEP_INPUTS) {
        Ok(tree) => tree,
        Err(failure) => return refuse(writer, failure),
    };
    let lockstep = match lockstep_inputs(&inputs_tree) {
        Ok(inputs) => inputs,
        Err(detail) => {
            return refuse(
                writer,
                Failure::for_stage("build", ST_LOCKSTEP_INPUTS, semantic::RELEASE_DRIFT, detail),
            );
        }
    };
    if let Err(message) = assert_lockstep(&lockstep) {
        return refuse(
            writer,
            Failure::for_stage(
                "build",
                ST_LOCKSTEP_INPUTS,
                semantic::RELEASE_DRIFT,
                message,
            ),
        );
    }
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: false,
            mode: "build".to_string(),
            stages: vec![ST_LOAD_ARTIFACT.to_string(), ST_LOCKSTEP_INPUTS.to_string()],
            resumes: Vec::new(),
            outputs: serde_json::json!({
                "release": RELEASE_VERSION,
                "modules": validated.modules.len(),
                "callables": validated.callables.iter().map(|c| render_text(c.id)).collect::<Vec<_>>(),
                "pages": validated.pages.iter().map(|p| render_text(p.path)).collect::<Vec<_>>(),
            }),
        },
    };
    if write_json(writer, &prepared).is_err() {
        return Err(1);
    }
    Ok(())
}

/// Read the lockstep facts out of the host-supplied inputs tree.
/// Shape failures speak in the "release stamp" voice; drift itself
/// is reported by `assert_lockstep`.
fn lockstep_inputs(tree: &Node) -> Result<LockstepInputs<'_>, String> {
    let text_field = |field: &str| {
        obj_get(tree, field)
            .and_then(as_text)
            .map(|units| units.as_slice())
            .ok_or_else(|| format!("release stamp: lockstep {field} carries no string version"))
    };
    let root_version = text_field("rootVersion")?;
    let platform_version = text_field("platformVersion")?;
    let compiler_version = text_field("compilerVersion")?;
    let (contracts_bits, contracts_spelling) = obj_get(tree, "contractsVersion")
        .and_then(as_num)
        .ok_or_else(|| {
        "release stamp: lockstep contractsVersion carries no number".to_string()
    })?;
    let packages_node = obj_get(tree, "packageVersions")
        .ok_or_else(|| "release stamp: lockstep packageVersions carries no record".to_string())?;
    let entries = match packages_node {
        Node::Obj(entries) => entries,
        _ => {
            return Err("release stamp: lockstep packageVersions carries no record".to_string());
        }
    };
    let mut package_versions: Vec<(&[u16], &[u16])> = Vec::with_capacity(entries.len());
    for (name, version) in entries {
        let version = as_text(version)
            .map(|units| units.as_slice())
            .ok_or_else(|| {
                format!(
                    "release stamp: lockstep packageVersions[{}] carries no string version",
                    render_text(name)
                )
            })?;
        package_versions.push((name.as_slice(), version));
    }
    Ok(LockstepInputs {
        root_version,
        platform_version,
        compiler_version,
        contracts_version: f64::from_bits(contracts_bits),
        contracts_spelling,
        package_versions,
    })
}

/// Deploy tail: companions, installed probe, compatibility, the
/// confirm gate (native: `requireYes` is pure flag logic, so no host
/// round-trip — the refusal order is what the trace must retain),
/// the recorded compiler check, then ACTIVATION_REQUEST and the
/// compiler gate (preview warns via outputs and proceeds; confirmed
/// refuses before publication).
fn run_deploy_tail(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    begin: &BeginBody,
    artifact_path: &str,
    _validated: &crate::artifact::ValidatedArtifact,
) -> Result<(), i32> {
    let env = match begin.env.as_deref() {
        Some(env) => env,
        // TS checks `--env` after the artifact load, before the
        // companion reads: the same position as here.
        None => {
            return refuse(
                writer,
                usage_refusal(GATE_BEGIN, "deploy requires --env <name>".to_string()),
            );
        }
    };
    let token = token + 1;
    let payload = match exchange(
        reader,
        writer,
        token,
        ST_LOAD_COMPANIONS,
        serde_json::json!({"artifact_path": artifact_path, "env": env}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    if let Some(detail) = load_error(&payload) {
        return refuse(
            writer,
            Failure::for_stage(
                "deploy",
                ST_LOAD_COMPANIONS,
                semantic::INVALID_DEPLOY_BUNDLE,
                detail,
            ),
        );
    }
    let descriptor = match resume_tree(&payload, "descriptor", "deploy", ST_LOAD_COMPANIONS) {
        Ok(tree) => tree,
        Err(failure) => return refuse(writer, failure),
    };
    let environment = match resume_tree(&payload, "environment", "deploy", ST_LOAD_COMPANIONS) {
        Ok(tree) => tree,
        Err(failure) => return refuse(writer, failure),
    };
    let target = match resume_tree(&payload, "target", "deploy", ST_LOAD_COMPANIONS) {
        Ok(tree) => tree,
        Err(failure) => return refuse(writer, failure),
    };
    // TS calls `installedFromTree({}, target)`: the env is the empty
    // record literal, mirrored here.
    let empty_env = Node::Obj(Vec::new());
    let installed = match installed_from_tree(&empty_env, &target) {
        Ok(installed) => installed,
        Err(error) => {
            return refuse(
                writer,
                Failure::for_stage(
                    "deploy",
                    ST_LOAD_COMPANIONS,
                    semantic::INVALID_DEPLOY_BUNDLE,
                    error.message,
                ),
            );
        }
    };
    let verdict = match check_compatibility(&descriptor, &environment, &installed) {
        Ok(verdict) => verdict,
        Err(error) => {
            return refuse(
                writer,
                Failure::for_stage(
                    "deploy",
                    ST_LOAD_COMPANIONS,
                    semantic::INVALID_DEPLOY_BUNDLE,
                    error.message,
                ),
            );
        }
    };
    if !verdict.compatible {
        let detail = verdict
            .reasons
            .iter()
            .map(|reason| format!("{}: {}", reason.code, reason.detail))
            .collect::<Vec<_>>()
            .join("; ");
        return refuse(
            writer,
            Failure::for_stage("deploy", GATE_COMPAT, semantic::INCOMPATIBLE, detail),
        );
    }
    // Confirm gate: preview skips `requireYes` entirely; bare refuses
    // before any further work (TS order: after incompatible).
    if !begin.preview && !begin.yes {
        return refuse(
            writer,
            Failure::for_stage(
                "deploy",
                GATE_CONFIRM,
                semantic::CONFIRM_REQUIRED,
                "refusing to deploy without --yes: pass --preview to review, --yes to confirm (nothing was written)".to_string(),
            ),
        );
    }
    // Computed early (TS position), enforced after activation.
    let compiler_detail = match check_compiler_version_match(&descriptor, &installed) {
        Ok(detail) => detail,
        Err(error) => {
            return refuse(
                writer,
                Failure::for_stage(
                    "deploy",
                    ST_LOAD_COMPANIONS,
                    semantic::INVALID_DEPLOY_BUNDLE,
                    error.message,
                ),
            );
        }
    };
    let token = token + 1;
    let payload = match exchange(
        reader,
        writer,
        token,
        ST_ACTIVATION_REQUEST,
        serde_json::json!({"installed": installed_tree(&installed)}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    let activation = match activation_verdict(&payload) {
        Ok(verdict) => verdict,
        Err(detail) => {
            return refuse(
                writer,
                Failure::for_stage(
                    "deploy",
                    ST_ACTIVATION_REQUEST,
                    transport::PROTOCOL_VIOLATION,
                    detail,
                ),
            );
        }
    };
    // Compiler gate: preview records the warning in outputs and
    // proceeds; confirmed refuses before publication.
    if !begin.preview {
        if let Some(detail) = compiler_detail.as_deref() {
            return refuse(
                writer,
                Failure::for_stage(
                    "deploy",
                    GATE_COMPILER,
                    semantic::COMPILER_MISMATCH,
                    format!("{detail} (release lockstep: rebuild with the pinned toolchain)"),
                ),
            );
        }
    }
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: false,
            mode: "deploy".to_string(),
            stages: vec![
                ST_LOAD_ARTIFACT.to_string(),
                ST_LOAD_COMPANIONS.to_string(),
                ST_ACTIVATION_REQUEST.to_string(),
            ],
            resumes: Vec::new(),
            outputs: serde_json::json!({
                "preview": begin.preview,
                "compilerMatch": compiler_detail.is_none(),
                "compilerDetail": compiler_detail,
                "verdict": activation,
            }),
        },
    };
    if write_json(writer, &prepared).is_err() {
        return Err(1);
    }
    Ok(())
}

/// The core-computed installed facts as a tagged tree for the
/// ACTIVATION_REQUEST. Entry order mirrors the TS probe return
/// (`contractsVersion`, `runtimeVersion`, `capabilities`,
/// `knownLanguageVersions`, `supportsSchedules`).
fn installed_tree(installed: &crate::compatibility::InstalledRuntime) -> serde_json::Value {
    let text = |units: &[u16]| Node::Text(units.to_vec());
    let texts = |items: &[&[u16]]| Node::Arr(items.iter().map(|u| text(u)).collect());
    encode_tree(&Node::Obj(vec![
        (
            "contractsVersion".encode_utf16().collect(),
            Node::Num {
                bits: installed.contracts_version.to_bits(),
                spelling: installed.contracts_spelling.to_string(),
            },
        ),
        (
            "runtimeVersion".encode_utf16().collect(),
            text(installed.runtime_version),
        ),
        (
            "capabilities".encode_utf16().collect(),
            texts(&installed.capabilities),
        ),
        (
            "knownLanguageVersions".encode_utf16().collect(),
            texts(&installed.known_language_versions),
        ),
        (
            "supportsSchedules".encode_utf16().collect(),
            Node::Bool(installed.supports_schedules),
        ),
    ]))
}

/// Validate the host's activation verdict resume. The core never
/// invents a verdict; a misshapen one breaks the stage contract.
fn activation_verdict(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let verdict = payload
        .get("verdict")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "ACTIVATION_REQUEST resume: verdict must be an object".to_string())?;
    if verdict.get("active").and_then(|v| v.as_bool()).is_none() {
        return Err("ACTIVATION_REQUEST resume: verdict.active must be a boolean".to_string());
    }
    match verdict.get("reasons").and_then(|v| v.as_array()) {
        Some(reasons) => {
            for reason in reasons {
                let shape_ok = reason
                    .as_object()
                    .map(|r| {
                        r.get("code").and_then(|c| c.as_str()).is_some()
                            && r.get("detail").and_then(|d| d.as_str()).is_some()
                    })
                    .unwrap_or(false);
                if !shape_ok {
                    return Err(
                        "ACTIVATION_REQUEST resume: verdict reasons must be {code, detail} strings"
                            .to_string(),
                    );
                }
            }
        }
        None => {
            return Err("ACTIVATION_REQUEST resume: verdict.reasons must be an array".to_string());
        }
    }
    Ok(serde_json::Value::Object(verdict.clone()))
}
