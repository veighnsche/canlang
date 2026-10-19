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
/// Host-read stage (one NeedHost round-trip): staged module buffers.
const ST_LOAD_MODULES: &str = "LOAD_MODULES";
const ST_PUBLISH_NATIVE_MODULES: &str = "PUBLISH_NATIVE_MODULES";
/// Host-read stage (one NeedHost round-trip): plan options. Built
/// before any previous-plan demand: competing binding failures refuse
/// here without previous-plan IO.
const ST_PLAN: &str = "PLAN";
/// Host-read stage (one NeedHost round-trip): the previous sidecar
/// the host read for the derived sidecar path (absent file rides
/// null). Requested only after the plan builds.
const ST_LOAD_PREVIOUS_PLAN: &str = "LOAD_PREVIOUS_PLAN";

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

/// One held module buffer: keyed JS source as admitted UTF-16 units,
/// plus the host frontend's syntax facts when served (deploy).
/// Buffers stay borrowed slices through the import/graph gates below:
/// the refusal lands before any owned module map or bundle assembly
/// materializes (the resume transport itself is the only allocation).
struct ModuleBuffer {
    key: Vec<u16>,
    js: Vec<u16>,
    facts: Option<crate::modules::ModuleFacts>,
}

/// Typed LOAD_MODULES resume: `{modules: [{key: Text, js: Text,
/// facts?: Facts}]}`. Shape failures speak the tree voice (BAD_NODE):
/// the resume is a malformed tagged tree, never an invented module code.
fn module_buffers(tree: &Node, command: &str) -> Result<Vec<ModuleBuffer>, Failure> {
    module_entries(tree, command, ST_LOAD_MODULES, "modules")
}

/// Shared `{key: Text, js: Text, facts?: Facts}` entry parser for the
/// finished `modules` map and each native `layers.*` array. `field`
/// names the resume member so refusals point at the exact array; the
/// `modules` field keeps its historical detail strings byte-identical.
fn module_entries(
    tree: &Node,
    command: &str,
    stage: &str,
    field: &str,
) -> Result<Vec<ModuleBuffer>, Failure> {
    let bad = |detail: String| {
        Failure::for_stage(command, stage, crate::failures::transport::BAD_NODE, detail)
    };
    let Node::Arr(items) = tree else {
        return Err(bad(format!(
            "LOAD_MODULES resume: {field} must be an array"
        )));
    };
    let mut buffers = Vec::with_capacity(items.len());
    for item in items {
        let key = crate::input::obj_get(item, "key")
            .and_then(crate::input::as_text)
            .ok_or_else(|| bad(format!("LOAD_MODULES resume: {field}[*].key must be text")))?;
        let js = crate::input::obj_get(item, "js")
            .and_then(crate::input::as_text)
            .ok_or_else(|| bad(format!("LOAD_MODULES resume: {field}[*].js must be text")))?;
        let facts = match crate::input::obj_get(item, "facts") {
            None => None,
            Some(node) => Some(crate::modules::decode_module_facts(node).map_err(|detail| {
                // The `modules` field keeps the shared decoder's
                // historical detail byte-identical (pinned by
                // vectors); layer fields name their own array.
                if field == "modules" {
                    bad(detail)
                } else {
                    bad(format!("LOAD_MODULES resume: {field}[*].facts {detail}"))
                }
            })?),
        };
        buffers.push(ModuleBuffer {
            key: key.clone(),
            js: js.clone(),
            facts,
        });
    }
    Ok(buffers)
}

/// Raw native layers from a LOAD_MODULES resume: `{layers: {pre,
/// post, trailing}}`, each an array of `{key, js, facts?}` entries in
/// bundle-composition order. Present means the native route: the job
/// assembles the final map itself instead of consuming a finished TS
/// bundle. Layers ride deploy only; mixing `layers` with a finished
/// `modules` map refuses (fail-closed on ambiguous input).
struct NativeLayers {
    pre: Vec<ModuleBuffer>,
    post: Vec<ModuleBuffer>,
    trailing: Vec<ModuleBuffer>,
}

fn native_layers(
    payload: &serde_json::Value,
    command: &str,
) -> Result<Option<NativeLayers>, Failure> {
    let raw = match payload.get("layers") {
        None | Some(serde_json::Value::Null) => return Ok(None),
        Some(tree) => tree,
    };
    if command != "deploy" {
        return Err(Failure::for_stage(
            command,
            ST_LOAD_MODULES,
            crate::failures::transport::BAD_NODE,
            "LOAD_MODULES resume: layers ride the deploy native route".to_string(),
        ));
    }
    if payload.get("modules").is_some_and(|v| !v.is_null()) {
        return Err(Failure::for_stage(
            command,
            ST_LOAD_MODULES,
            crate::failures::transport::BAD_NODE,
            "LOAD_MODULES resume: mixed map+layers".to_string(),
        ));
    }
    let bytes = serde_json::to_vec(raw).unwrap_or_default();
    let node = decode_tree(&bytes)
        .map_err(|e| Failure::for_stage(command, ST_LOAD_MODULES, e.code, e.detail))?;
    let layer = |name: &str| -> Result<Vec<ModuleBuffer>, Failure> {
        let field = format!("layers.{name}");
        match crate::input::obj_get(&node, name) {
            None => Err(Failure::for_stage(
                command,
                ST_LOAD_MODULES,
                crate::failures::transport::BAD_NODE,
                format!("LOAD_MODULES resume: {field} is required"),
            )),
            Some(member) => module_entries(member, command, ST_LOAD_MODULES, &field),
        }
    };
    Ok(Some(NativeLayers {
        pre: layer("pre")?,
        post: layer("post")?,
        trailing: layer("trailing")?,
    }))
}

/// One served composed map for an authored module: the host-executed
/// remapping merge output (`map_json`, canonical JSON text, or null
/// when the module carries no usable original) plus the observed
/// import-edit stage count. Raw JS, pages and callables ride the
/// artifact payload the job already holds; only the host-composed
/// bytes need serving here.
struct AuthoredMap {
    path: Vec<u16>,
    map_json: Option<String>,
    stages: usize,
    facts: Option<crate::modules::ModuleFacts>,
}

/// Typed `authoredMaps` LOAD_MODULES resume field. Absent (or null)
/// means the host serves a finished final map with no
/// natively-constructed layer: legacy and canned payloads keep the
/// pre-construction gates, and the Prepared outputs record no digest.
/// Present (even empty) switches deploy to native construction with a
/// host-skew veto. Shape failures speak the tree voice (BAD_NODE);
/// content mismatches refuse as bundle failures at the call site.
fn authored_maps(
    payload: &serde_json::Value,
    command: &str,
) -> Result<Option<Vec<AuthoredMap>>, Failure> {
    let bad = |detail: String| {
        Failure::for_stage(
            command,
            ST_LOAD_MODULES,
            crate::failures::transport::BAD_NODE,
            detail,
        )
    };
    let raw = match payload.get("authoredMaps") {
        None | Some(serde_json::Value::Null) => return Ok(None),
        Some(tree) => tree,
    };
    let bytes = serde_json::to_vec(raw).unwrap_or_default();
    let node = decode_tree(&bytes)
        .map_err(|error| Failure::for_stage(command, ST_LOAD_MODULES, error.code, error.detail))?;
    let Node::Arr(items) = node else {
        return Err(bad(
            "LOAD_MODULES resume: authoredMaps must be an array".to_string()
        ));
    };
    let mut out = Vec::with_capacity(items.len());
    for item in &items {
        let field = |name: &str| {
            obj_get(item, name).ok_or_else(|| {
                bad(format!(
                    "LOAD_MODULES resume: authoredMaps[*].{name} is required"
                ))
            })
        };
        let path = field("path")
            .and_then(|node| {
                as_text(node).ok_or_else(|| {
                    bad("LOAD_MODULES resume: authoredMaps[*].path must be text".to_string())
                })
            })
            .map(|units| units.clone())?;
        let map_json = match field("mapJson")? {
            Node::Null => None,
            node => Some(
                as_text(node)
                    .ok_or_else(|| {
                        bad(
                            "LOAD_MODULES resume: authoredMaps[*].mapJson must be text or null"
                                .to_string(),
                        )
                    })
                    // WHATWG parity with the host `Buffer.from(json,
                    // "utf8")`: lone surrogates ride as U+FFFD on both
                    // sides, never as corrupt bytes.
                    .map(|units| String::from_utf16_lossy(units))?,
            ),
        };
        let (bits, _) = field("stages").and_then(|node| {
            as_num(node).ok_or_else(|| {
                bad("LOAD_MODULES resume: authoredMaps[*].stages must be a number".to_string())
            })
        })?;
        let stages = f64::from_bits(bits);
        if !(stages >= 0.0 && stages.fract() == 0.0) {
            return Err(bad(
                "LOAD_MODULES resume: authoredMaps[*].stages must be a non-negative integer"
                    .to_string(),
            ));
        }
        // Host frontend facts over the staged bytes for this module
        // (the layer route validates Rust-produced bytes against
        // these; absent rides None and refuses at validation like a
        // facts-less served buffer).
        let facts = match obj_get(item, "facts") {
            None | Some(Node::Null) => None,
            Some(node) => Some(crate::modules::decode_module_facts(node).map_err(|detail| {
                bad(format!(
                    "LOAD_MODULES resume: authoredMaps[*].facts {detail}"
                ))
            })?),
        };
        out.push(AuthoredMap {
            path,
            map_json,
            stages: stages as usize,
            facts,
        });
    }
    Ok(Some(out))
}

/// Native authored construction for deploy (RUST-PREPARATION-010):
/// match every validated artifact module to its served composed map,
/// stage the authored layer in Rust, and substitute the Rust-produced
/// texts over the served final map (host-skew veto inside
/// `assemble_native_texts`). Artifact validation mandates
/// `modules[*].map`, so `has_original` is always true here; a served
/// map entry for an unknown module (or a module missing its entry)
/// refuses as host skew.
/// Native authored staging without served-map substitution: match
/// every validated artifact module to its served composed map (host
/// skew veto) and stage the authored layer in Rust. Both the legacy
/// substitution route and the native layer route build on this.
fn stage_authored(
    artifact: &crate::artifact::ValidatedArtifact,
    maps: &[AuthoredMap],
    command: &str,
) -> Result<crate::modules::StagedBundle, Failure> {
    let refused = |message: String| {
        Failure::for_stage(
            command,
            ST_LOAD_MODULES,
            crate::failures::semantic::BUNDLE_FAILED,
            message,
        )
    };
    for entry in maps {
        if !artifact
            .modules
            .iter()
            .any(|module| module.path == entry.path.as_slice())
        {
            return Err(refused(format!(
                "LOAD_MODULES resume: authoredMaps carries unknown module {} (host skew)",
                crate::input::json_quote(&entry.path)
            )));
        }
    }
    let mut authored = Vec::with_capacity(artifact.modules.len());
    for module in &artifact.modules {
        let entry = maps
            .iter()
            .find(|entry| entry.path.as_slice() == module.path)
            .ok_or_else(|| {
                refused(format!(
                    "LOAD_MODULES resume: authoredMaps drops module {} (host skew)",
                    crate::input::json_quote(module.path)
                ))
            })?;
        authored.push(crate::modules::AuthoredModule {
            path: module.path,
            js: module.js,
            map_json: entry.map_json.as_deref(),
            has_original: true,
            stage_count: entry.stages,
        });
    }
    let pages: Vec<crate::modules::PageRef> = artifact
        .pages
        .iter()
        .map(|page| crate::modules::PageRef {
            path: page.path,
            module: page.module,
        })
        .collect();
    let callables: Vec<crate::modules::CallableRef> = artifact
        .callables
        .iter()
        .map(|callable| crate::modules::CallableRef {
            id: callable.id,
            module: callable.module,
        })
        .collect();
    crate::modules::construct_staged_bundle(&authored, &pages, &callables)
        .map_err(|error| refused(error.message))
}

fn native_authored_texts(
    artifact: &crate::artifact::ValidatedArtifact,
    maps: &[AuthoredMap],
    served: &[(Vec<u16>, Vec<u16>)],
    command: &str,
) -> Result<Vec<(Vec<u16>, Vec<u16>)>, Failure> {
    let staged = stage_authored(artifact, maps, command)?;
    crate::modules::assemble_native_texts(served, &staged).map_err(|error| {
        Failure::for_stage(
            command,
            ST_LOAD_MODULES,
            crate::failures::semantic::BUNDLE_FAILED,
            error.message,
        )
    })
}

/// `<dir>/<stem>.deploy-plan.json` where stem strips one trailing
/// `.artifact.json` (mirrors the host planPath derivation).
fn plan_sidecar_path(artifact_path: &str) -> String {
    let dir_end = artifact_path.rfind('/').map(|index| index + 1).unwrap_or(0);
    let base = &artifact_path[dir_end..];
    let stem = base.strip_suffix(".artifact.json").unwrap_or(base);
    format!("{}{stem}.deploy-plan.json", &artifact_path[..dir_end])
}

/// Deterministic plan outputs for the Prepared envelope.
struct PlanReview {
    changed: bool,
    lines: Vec<String>,
    plan_json: String,
    toml: String,
    preview: String,
}

/// PLAN exchange plus the deploy-plan build. Mirrors the host
/// order (buildDeployPlan first): binding failures refuse as
/// unresolved-binding before any previous-plan demand.
fn build_plan(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    descriptor: &Node,
    environment: &Node,
) -> Result<Node, i32> {
    const COMMAND: &str = "deploy";
    let payload = match exchange(reader, writer, token, ST_PLAN, serde_json::json!({})) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    let options = match resume_tree(&payload, "options", COMMAND, ST_PLAN) {
        Ok(tree) => tree,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    match crate::plan::build_deploy_plan(descriptor, environment, &options) {
        Ok(plan) => Ok(plan),
        Err(error) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_PLAN,
                    semantic::UNRESOLVED_BINDING,
                    error.message,
                ),
            );
            Err(1)
        }
    }
}

/// LOAD_PREVIOUS_PLAN exchange plus the prior-plan check. The native
/// side derives the sidecar path and asks; the host file read rides
/// back as a tree (absent file rides null for first deploy; an
/// unparsable sidecar rides its raw text so the shape check refuses
/// it, like loadPreviousPlan).
fn load_previous_plan(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    artifact_path: &str,
) -> Result<Option<Node>, i32> {
    const COMMAND: &str = "deploy";
    let plan_path = plan_sidecar_path(artifact_path);
    let payload = match exchange(
        reader,
        writer,
        token,
        ST_LOAD_PREVIOUS_PLAN,
        serde_json::json!({"plan_path": plan_path}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    match payload.get("previous") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(_) => {
            let tree = match resume_tree(&payload, "previous", COMMAND, ST_LOAD_PREVIOUS_PLAN) {
                Ok(tree) => tree,
                Err(failure) => {
                    let _ = refuse(writer, failure);
                    return Err(1);
                }
            };
            if let Err(error) = crate::review::check_previous_plan(&tree, &plan_path) {
                let _ = refuse(
                    writer,
                    Failure::for_stage(
                        COMMAND,
                        ST_LOAD_PREVIOUS_PLAN,
                        semantic::INVALID_DEPLOY_BUNDLE,
                        error.message,
                    ),
                );
                return Err(1);
            }
            Ok(Some(tree))
        }
    }
}

/// Pure diff/render assembly over a built plan. Every failure refuses
/// as invalid-deploy-bundle at the call site stage.
fn assemble_review(plan: &Node, previous: Option<&Node>) -> Result<PlanReview, Failure> {
    const COMMAND: &str = "deploy";
    const STAGE: &str = ST_LOAD_PREVIOUS_PLAN;
    let invalid = |message: String| {
        Failure::for_stage(COMMAND, STAGE, semantic::INVALID_DEPLOY_BUNDLE, message)
    };
    let diff = crate::review::diff_plans(previous, plan).map_err(|error| invalid(error.message))?;
    let plan_json = crate::render::render_plan_json(plan);
    let toml = crate::render::render_wrangler_toml(plan).map_err(|error| invalid(error.message))?;
    let preview =
        crate::review::format_preview(plan, &diff).map_err(|error| invalid(error.message))?;
    // No duplicate plan object: `plan_json` already carries the
    // canonical lossless rendering (exactly the sidecar bytes,
    // including lone-surrogate escapes no `serde_json::Value` can
    // hold); the TS host `JSON.parse`s it to get the real plan.
    Ok(PlanReview {
        changed: diff.changed,
        lines: diff.lines,
        plan_json,
        toml,
        preview,
    })
}

/// PLAN + LOAD_PREVIOUS_PLAN + review join (P06.3/013 order), grouped
/// out of `run_deploy_tail`: plan first (its binding failures refuse
/// without previous-plan IO), then the previous sidecar demand, then
/// diff/render. The compiler gate below keeps its original observable
/// position.
fn plan_and_review(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: u64,
    descriptor: &Node,
    environment: &Node,
    artifact_path: &str,
) -> Result<PlanReview, i32> {
    let token = token + 1;
    let plan = match build_plan(reader, writer, token, descriptor, environment) {
        Ok(plan) => plan,
        Err(code) => return Err(code),
    };
    let token = token + 1;
    let previous = match load_previous_plan(reader, writer, token, artifact_path) {
        Ok(previous) => previous,
        Err(code) => return Err(code),
    };
    match assemble_review(&plan, previous.as_ref()) {
        Ok(review) => Ok(review),
        Err(failure) => {
            let _ = refuse(writer, failure);
            Err(1)
        }
    }
}

/// Attach host facts to one layer's buffers, refusing facts-less
/// entries in the served-buffer voice. Runs before content
/// validation so presence precedes shape per buffer, like the
/// legacy gate.
fn factored_layer(
    buffers: &[ModuleBuffer],
    writer: &mut impl Write,
) -> Result<Vec<(Vec<u16>, Vec<u16>, crate::modules::ModuleFacts)>, i32> {
    const COMMAND: &str = "deploy";
    let mut out = Vec::with_capacity(buffers.len());
    for buffer in buffers {
        let facts = match &buffer.facts {
            None => {
                let _ = refuse(
                    writer,
                    Failure::for_stage(
                        COMMAND,
                        ST_LOAD_MODULES,
                        crate::failures::transport::BAD_NODE,
                        format!(
                            "LOAD_MODULES resume: module {} serves no host syntax facts",
                            crate::input::json_quote(&buffer.key)
                        ),
                    ),
                );
                return Err(1);
            }
            Some(facts) => facts.clone(),
        };
        out.push((buffer.key.clone(), buffer.js.clone(), facts));
    }
    Ok(out)
}

/// PUBLISH_NATIVE_MODULES exchange: send the natively-assembled
/// modules for host publication, then verify the returned digest
/// against the native one. Consumes one token.
fn publish_native_modules(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &mut u64,
    merged: &[(Vec<u16>, Vec<u16>, crate::modules::ModuleFacts)],
    digest: &str,
) -> Result<(), i32> {
    const COMMAND: &str = "deploy";
    *token += 1;
    let items: Vec<serde_json::Value> = merged
        .iter()
        .map(|(key, js, _)| {
            encode_tree(&Node::Obj(vec![
                ("key".encode_utf16().collect(), Node::Text(key.clone())),
                ("js".encode_utf16().collect(), Node::Text(js.clone())),
            ]))
        })
        .collect();
    let payload = match exchange(
        reader,
        writer,
        *token,
        ST_PUBLISH_NATIVE_MODULES,
        serde_json::json!({"modules": items}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    let sha = match payload.get("sha256").and_then(|value| value.as_str()) {
        Some(sha) => sha,
        None => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_PUBLISH_NATIVE_MODULES,
                    transport::PROTOCOL_VIOLATION,
                    "PUBLISH_NATIVE_MODULES resume: sha256 must be a string".to_string(),
                ),
            );
            return Err(1);
        }
    };
    if sha != digest {
        let _ = refuse(
            writer,
            Failure::for_stage(
                COMMAND,
                ST_PUBLISH_NATIVE_MODULES,
                semantic::BUNDLE_FAILED,
                "PUBLISH_NATIVE_MODULES publication digest mismatch (host skew)".to_string(),
            ),
        );
        return Err(1);
    }
    Ok(())
}

/// Native layer route: stage the authored layer, merge
/// pre/authored/post/rendered-artifact/trailing in bundle order with
/// duplicate-last-wins (the host `Object.assign` composition), run
/// the facts and deploy gates over the merged buffers, then publish
/// the natively-assembled modules and verify the publication
/// digest. No finished TS bundle is consumed anywhere on this path.
fn load_native_layers(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &mut u64,
    artifact: &crate::artifact::ValidatedArtifact,
    artifact_tree: Option<&Node>,
    activation: Option<&serde_json::Value>,
    payload: &serde_json::Value,
    layers: NativeLayers,
) -> Result<LoadModulesOutcome, i32> {
    const COMMAND: &str = "deploy";
    let mut binary_keys: Vec<Vec<u16>> = Vec::new();
    if payload.get("binaries").is_some() {
        let tree = match resume_tree(payload, "binaries", COMMAND, ST_LOAD_MODULES) {
            Ok(tree) => tree,
            Err(failure) => {
                let _ = refuse(writer, failure);
                return Err(1);
            }
        };
        let Node::Arr(items) = tree else {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    "LOAD_MODULES resume: binaries must be an array".to_string(),
                ),
            );
            return Err(1);
        };
        for item in items {
            match item {
                Node::Text(units) => binary_keys.push(units),
                _ => {
                    let _ = refuse(
                        writer,
                        Failure::for_stage(
                            COMMAND,
                            ST_LOAD_MODULES,
                            crate::failures::transport::BAD_NODE,
                            "LOAD_MODULES resume: binaries[*] must be text".to_string(),
                        ),
                    );
                    return Err(1);
                }
            }
        }
    }
    let maps = match authored_maps(payload, COMMAND) {
        Ok(Some(maps)) => maps,
        Ok(None) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    "LOAD_MODULES resume: layers require authoredMaps".to_string(),
                ),
            );
            return Err(1);
        }
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    let staged = match stage_authored(artifact, &maps, COMMAND) {
        Ok(staged) => staged,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    // Presence gates run in bundle order (pre, authored, post,
    // artifact, trailing) so multi-failure precedence matches the
    // composed-map gate order.
    let pre = factored_layer(&layers.pre, writer)?;
    let mut staged_layer = Vec::with_capacity(staged.staged.len());
    for (key, js) in &staged.staged {
        let facts = match maps
            .iter()
            .find(|entry| entry.path.as_slice() == key.as_slice())
            .and_then(|entry| entry.facts.as_ref())
        {
            None => {
                let _ = refuse(
                    writer,
                    Failure::for_stage(
                        COMMAND,
                        ST_LOAD_MODULES,
                        crate::failures::transport::BAD_NODE,
                        format!(
                            "LOAD_MODULES resume: module {} serves no host syntax facts",
                            crate::input::json_quote(key)
                        ),
                    ),
                );
                return Err(1);
            }
            Some(facts) => facts.clone(),
        };
        staged_layer.push((key.clone(), js.clone(), facts));
    }
    let post = factored_layer(&layers.post, writer)?;
    // The artifact module renders natively from the validated
    // artifact tree, the staged source maps and the activation
    // verdict (all already gated inputs); its syntax facts ride the
    // `artifactFacts` attestation the host scans over byte-identical
    // output, and any span-affecting divergence refuses below.
    let tree = match artifact_tree {
        Some(tree) => tree,
        None => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    transport::PROTOCOL_VIOLATION,
                    "native route needs the artifact tree".to_string(),
                ),
            );
            return Err(1);
        }
    };
    let activation = match activation {
        Some(activation) => activation,
        None => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    transport::PROTOCOL_VIOLATION,
                    "native route needs the activation verdict".to_string(),
                ),
            );
            return Err(1);
        }
    };
    // The resume already crossed `serde_json` (object keys sorted),
    // which is exact here because `activate()` builds verdicts with
    // alphabetical keys (`active` before `reasons`, `code` before
    // `detail`); the d21 vector pins a reasons-carrying render.
    let verdict_json = serde_json::to_string(activation).unwrap_or_default();
    let verdict_units: Vec<u16> = verdict_json.encode_utf16().collect();
    let verdict = match crate::input::parse_json_text(&verdict_units) {
        Ok(verdict) => verdict,
        Err(detail) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    transport::PROTOCOL_VIOLATION,
                    format!("LOAD_MODULES resume: verdict is not a JSON value ({detail})"),
                ),
            );
            return Err(1);
        }
    };
    let source_maps = match crate::modules::staged_source_maps_node(&staged) {
        Ok(node) => node,
        Err(error) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    semantic::BUNDLE_FAILED,
                    error.message,
                ),
            );
            return Err(1);
        }
    };
    let staged_paths: Vec<Vec<u16>> = staged.staged.iter().map(|(path, _)| path.clone()).collect();
    let path_refs: Vec<&[u16]> = staged_paths.iter().map(|path| path.as_slice()).collect();
    let assembly = match crate::modules::portable_assembled_modules(&path_refs, &source_maps) {
        Ok(assembly) => assembly,
        Err(error) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    semantic::BUNDLE_FAILED,
                    error.message,
                ),
            );
            return Err(1);
        }
    };
    let rendered =
        match crate::modules::render_staged_deployment(tree, &assembly, &staged_paths, &verdict) {
            Ok(rendered) => rendered,
            Err(error) => {
                let _ = refuse(
                    writer,
                    Failure::for_stage(
                        COMMAND,
                        ST_LOAD_MODULES,
                        semantic::BUNDLE_FAILED,
                        error.message,
                    ),
                );
                return Err(1);
            }
        };
    let artifact_key: Vec<u16> = crate::modules::ARTIFACT_MODULE.encode_utf16().collect();
    let artifact_facts = match payload.get("artifactFacts") {
        None | Some(serde_json::Value::Null) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    "LOAD_MODULES resume: artifactFacts is required".to_string(),
                ),
            );
            return Err(1);
        }
        Some(raw) => {
            let bytes = serde_json::to_vec(raw).unwrap_or_default();
            let node = match decode_tree(&bytes) {
                Ok(node) => node,
                Err(error) => {
                    let _ = refuse(
                        writer,
                        Failure::for_stage(COMMAND, ST_LOAD_MODULES, error.code, error.detail),
                    );
                    return Err(1);
                }
            };
            match crate::modules::decode_module_facts(&node) {
                Ok(facts) => facts,
                Err(detail) => {
                    let _ = refuse(
                        writer,
                        Failure::for_stage(
                            COMMAND,
                            ST_LOAD_MODULES,
                            crate::failures::transport::BAD_NODE,
                            format!("LOAD_MODULES resume: artifactFacts {detail}"),
                        ),
                    );
                    return Err(1);
                }
            }
        }
    };
    let artifact_layer = vec![(
        artifact_key,
        rendered.encode_utf16().collect::<Vec<u16>>(),
        artifact_facts,
    )];
    let trailing = factored_layer(&layers.trailing, writer)?;
    let merged =
        crate::modules::merge_factored_layers(&[pre, staged_layer, post, artifact_layer, trailing]);
    for binary in &binary_keys {
        if merged.iter().any(|(key, _, _)| key == binary) {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    format!(
                        "LOAD_MODULES resume: binary key {} shadows a text module",
                        crate::input::json_quote(binary)
                    ),
                ),
            );
            return Err(1);
        }
    }
    for (key, js, facts) in &merged {
        if let Err(detail) = crate::modules::validate_module_facts(key, js, facts) {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    detail,
                ),
            );
            return Err(1);
        }
    }
    let count = match crate::modules::check_deploy_modules(&merged, &binary_keys) {
        Ok(count) => count,
        Err(error) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    COMMAND,
                    ST_LOAD_MODULES,
                    semantic::BUNDLE_FAILED,
                    error.message,
                ),
            );
            return Err(1);
        }
    };
    let refs: Vec<(&[u16], &[u16])> = merged
        .iter()
        .map(|(key, js, _)| (key.as_slice(), js.as_slice()))
        .collect();
    let main: Vec<u16> = crate::modules::DEPLOY_MAIN_MODULE.encode_utf16().collect();
    let digest = crate::modules::bundle_sha256(&main, &refs);
    publish_native_modules(reader, writer, token, &merged, &digest)?;
    Ok(LoadModulesOutcome {
        checked: count,
        sha256: Some(digest),
        published: true,
    })
}

/// Outcome of the module gate: the verified buffer count plus, on
/// native-constructed deploy paths, the Rust-computed final digest.
/// `published` is true only when the host published the
/// natively-assembled modules through `PUBLISH_NATIVE_MODULES` (the
/// PLAN stage records it in the stage list).
struct LoadModulesOutcome {
    checked: usize,
    sha256: Option<String>,
    published: bool,
}

/// LOAD_MODULES exchange plus the native import/graph gates. Consumes
/// one token for the resume, plus one more on the native layer route
/// for the publication exchange (`token` advances past both so PLAN
/// resumes numbering). Deploy applies the facts policy over the host
/// frontend's syntax observations; build admits its domain with no
/// module gate (021: the TS build accepts artifacts the deploy
/// loadability gate refuses).
fn load_modules(
    reader: &mut impl Read,
    writer: &mut impl Write,
    token: &mut u64,
    command: &str,
    artifact: &crate::artifact::ValidatedArtifact,
    artifact_tree: Option<&Node>,
    activation: Option<&serde_json::Value>,
) -> Result<LoadModulesOutcome, i32> {
    *token += 1;
    let payload = match exchange(
        reader,
        writer,
        *token,
        ST_LOAD_MODULES,
        serde_json::json!({}),
    ) {
        Exchange::Payload(payload) => payload,
        Exchange::Done(code) => return Err(code),
    };
    // Native layer route: raw layers assemble fully in Rust with no
    // finished TS bundle underneath. Legacy payloads (finished
    // `modules` map, with or without 010 `authoredMaps`) keep their
    // gates below.
    let layers = match native_layers(&payload, command) {
        Ok(layers) => layers,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    if let Some(layers) = layers {
        return load_native_layers(
            reader,
            writer,
            token,
            artifact,
            artifact_tree,
            activation,
            &payload,
            layers,
        );
    }
    let tree = match resume_tree(&payload, "modules", command, ST_LOAD_MODULES) {
        Ok(tree) => tree,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    let mut buffers = match module_buffers(&tree, command) {
        Ok(buffers) => buffers,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    if command != "deploy" {
        return Ok(LoadModulesOutcome {
            checked: buffers.len(),
            sha256: None,
            published: false,
        });
    }
    // Staged binary asset keys join the link closure (028: mixed
    // Wasm links resolve in this same stage scope; absent when the
    // bundle stages no binaries). Overlap with a text key is a host
    // bundle defect (the owner forbids shadowing either way).
    let mut binary_keys: Vec<Vec<u16>> = Vec::new();
    if payload.get("binaries").is_some() {
        let tree = match resume_tree(&payload, "binaries", command, ST_LOAD_MODULES) {
            Ok(tree) => tree,
            Err(failure) => {
                let _ = refuse(writer, failure);
                return Err(1);
            }
        };
        let Node::Arr(items) = tree else {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    command,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    "LOAD_MODULES resume: binaries must be an array".to_string(),
                ),
            );
            return Err(1);
        };
        for item in items {
            match item {
                Node::Text(units) => binary_keys.push(units),
                _ => {
                    let _ = refuse(
                        writer,
                        Failure::for_stage(
                            command,
                            ST_LOAD_MODULES,
                            crate::failures::transport::BAD_NODE,
                            "LOAD_MODULES resume: binaries[*] must be text".to_string(),
                        ),
                    );
                    return Err(1);
                }
            }
        }
    }
    for binary in &binary_keys {
        if buffers.iter().any(|buffer| buffer.key == *binary) {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    command,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    format!(
                        "LOAD_MODULES resume: binary key {} shadows a text module",
                        crate::input::json_quote(binary)
                    ),
                ),
            );
            return Err(1);
        }
    }
    // Native construction (010), after the transport-shape checks and
    // before facts validation so the facts policy applies to the
    // Rust-produced bytes: when the host serves composed maps, the
    // authored layer is staged natively and substituted over the
    // served map (skew veto inside). Absent authoredMaps keeps the
    // legacy finished-map gates with no digest.
    let native_maps = match authored_maps(&payload, command) {
        Ok(maps) => maps,
        Err(failure) => {
            let _ = refuse(writer, failure);
            return Err(1);
        }
    };
    let native_present = native_maps.is_some();
    if let Some(maps) = native_maps {
        let served: Vec<(Vec<u16>, Vec<u16>)> = buffers
            .iter()
            .map(|buffer| (buffer.key.clone(), buffer.js.clone()))
            .collect();
        match native_authored_texts(artifact, &maps, &served, command) {
            Ok(texts) => {
                for (buffer, (_, js)) in buffers.iter_mut().zip(texts) {
                    buffer.js = js;
                }
            }
            Err(failure) => {
                let _ = refuse(writer, failure);
                return Err(1);
            }
        }
    }
    let mut validated: Vec<(Vec<u16>, Vec<u16>, crate::modules::ModuleFacts)> =
        Vec::with_capacity(buffers.len());
    for buffer in &buffers {
        let facts = match &buffer.facts {
            None => {
                let _ = refuse(
                    writer,
                    Failure::for_stage(
                        command,
                        ST_LOAD_MODULES,
                        crate::failures::transport::BAD_NODE,
                        format!(
                            "LOAD_MODULES resume: module {} serves no host syntax facts",
                            crate::input::json_quote(&buffer.key)
                        ),
                    ),
                );
                return Err(1);
            }
            Some(facts) => facts,
        };
        if let Err(detail) = crate::modules::validate_module_facts(&buffer.key, &buffer.js, facts) {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    command,
                    ST_LOAD_MODULES,
                    crate::failures::transport::BAD_NODE,
                    detail,
                ),
            );
            return Err(1);
        }
        validated.push((buffer.key.clone(), buffer.js.clone(), facts.clone()));
    }
    match crate::modules::check_deploy_modules(&validated, &binary_keys) {
        Ok(count) => {
            // The native digest covers the Rust-produced final buffers
            // (identical to the served map by the skew veto above, and
            // `bundle_sha256` sorts defensively like the TS helper, so
            // any served order yields the publication digest). The host
            // checks it against its bundle at publication; legacy
            // payloads record no digest.
            let sha256 = if native_present {
                let refs: Vec<(&[u16], &[u16])> = validated
                    .iter()
                    .map(|(key, js, _)| (key.as_slice(), js.as_slice()))
                    .collect();
                let main = crate::modules::DEPLOY_MAIN_MODULE
                    .encode_utf16()
                    .collect::<Vec<u16>>();
                Some(crate::modules::bundle_sha256(&main, &refs))
            } else {
                None
            };
            Ok(LoadModulesOutcome {
                checked: count,
                sha256,
                published: false,
            })
        }
        Err(error) => {
            let _ = refuse(
                writer,
                Failure::for_stage(
                    command,
                    ST_LOAD_MODULES,
                    crate::failures::semantic::BUNDLE_FAILED,
                    error.message,
                ),
            );
            Err(1)
        }
    }
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
    run_deploy_tail(
        reader,
        writer,
        token,
        begin,
        artifact_path,
        &validated,
        &artifact_tree,
    )
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
    // load_modules consumes the next token itself.
    let mut token = token;
    let outcome = match load_modules(reader, writer, &mut token, "build", validated, None, None) {
        Ok(outcome) => outcome,
        Err(code) => return Err(code),
    };
    let modules_checked = outcome.checked;
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: false,
            mode: "build".to_string(),
            stages: vec![
                ST_LOAD_ARTIFACT.to_string(),
                ST_LOCKSTEP_INPUTS.to_string(),
                ST_LOAD_MODULES.to_string(),
            ],
            resumes: Vec::new(),
            outputs: serde_json::json!({
                "release": RELEASE_VERSION,
                "modules": validated.modules.len(),
                "callables": validated.callables.iter().map(|c| render_text(c.id)).collect::<Vec<_>>(),
                "pages": validated.pages.iter().map(|p| render_text(p.path)).collect::<Vec<_>>(),
                "modulesChecked": modules_checked,
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
    validated: &crate::artifact::ValidatedArtifact,
    artifact_tree: &Node,
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
    // Module buffers gate the bundle before the compiler gate:
    // import/graph failures refuse here, never at publication.
    // load_modules consumes the next token itself.
    let mut token = token;
    let outcome = match load_modules(
        reader,
        writer,
        &mut token,
        "deploy",
        validated,
        Some(&artifact_tree),
        Some(&activation),
    ) {
        Ok(outcome) => outcome,
        Err(code) => return Err(code),
    };
    let modules_checked = outcome.checked;
    let modules_sha256 = outcome.sha256;
    // Plan/review join (P06.3) sits after module staging and before
    // the compiler gate; see `plan_and_review` for the order.
    let review = match plan_and_review(
        reader,
        writer,
        token,
        &descriptor,
        &environment,
        artifact_path,
    ) {
        Ok(review) => review,
        Err(code) => return Err(code),
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
                    format!("{detail} (release mismatch: rebuild the preparation binary)"),
                ),
            );
        }
    }
    let prepared = Prepared {
        prepared: PreparedBody {
            scaffold: false,
            mode: "deploy".to_string(),
            stages: {
                let mut stages = vec![
                    ST_LOAD_ARTIFACT.to_string(),
                    ST_LOAD_COMPANIONS.to_string(),
                    ST_ACTIVATION_REQUEST.to_string(),
                    ST_LOAD_MODULES.to_string(),
                ];
                // The native layer route publishes the Rust-assembled
                // modules through PUBLISH_NATIVE_MODULES; legacy
                // payloads record no publication stage.
                if outcome.published {
                    stages.push(ST_PUBLISH_NATIVE_MODULES.to_string());
                }
                stages.push(ST_PLAN.to_string());
                stages.push(ST_LOAD_PREVIOUS_PLAN.to_string());
                stages
            },
            resumes: Vec::new(),
            outputs: serde_json::json!({
                "preview": begin.preview,
                "compilerMatch": compiler_detail.is_none(),
                "compilerDetail": compiler_detail,
                "verdict": activation,
                "modulesChecked": modules_checked,
                "modulesSha256": modules_sha256,
                "planChanged": review.changed,
                "planDiff": review.lines,
                "planJson": review.plan_json,
                "wranglerToml": review.toml,
                "previewText": review.preview,
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

