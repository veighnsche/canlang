//! Exact captured compiler execution with bounded output and owned-child cleanup.
use crate::capture::{self, Capture, InventoryProvider, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompileResult {
    Artifact {
        artifact: Value,
        #[serde(rename = "artifactBytes")]
        artifact_bytes: Vec<u8>,
    },
    Diagnostics {
        envelope: Value,
    },
    ProfileUnsupported {
        reason: String,
    },
    CaptureIncomplete {
        reason: String,
    },
    ToolFailure {
        reason: String,
    },
    Cancelled {
        reason: String,
    },
}
pub fn admit_single_app_profile(source: &str) -> Result<()> {
    let (apps, _) = capture::profile_declarations(source);
    if apps == 1 {
        Ok(())
    } else {
        Err(format!(
            "first profile requires exactly one app declaration (found {apps})"
        ))
    }
}

/// Admit `use` imports only when every imported package resolves to a
/// captured closure provider. Discovery proposes; the compiler's own
/// verdict on the staged closure (plus `verify_compiler_sources`) is the
/// membership authority.
pub fn admit_use_closure(source: &str, providers: &[String]) -> Result<()> {
    let (_, uses) = capture::profile_declarations(source);
    for (line, name) in uses {
        if !providers.iter().any(|package| package == &name) {
            return Err(format!(
                "line {line}: imported package {name} is outside the captured closure"
            ));
        }
    }
    Ok(())
}

pub fn compile(
    captured: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    phase: &dyn Fn(&str),
) -> CompileResult {
    if let Err(reason) = capture::check_cancel(cancel) {
        return CompileResult::Cancelled { reason };
    }
    if let Err(reason) = admit_single_app_profile(&captured.source_text) {
        return CompileResult::ProfileUnsupported { reason };
    }
    let providers: Vec<String> = captured
        .provider_snapshot
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|provider| provider.package.clone())
        .collect();
    if let Err(reason) = admit_use_closure(&captured.source_text, &providers) {
        return CompileResult::ProfileUnsupported { reason };
    }
    if [captured.compiler_operand.clone()]
        .into_iter()
        .chain(
            captured
                .provider_snapshot
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|provider| provider.snapshot.path.clone()),
        )
        .any(|operand| {
            Path::new(&operand)
                .file_name()
                .is_some_and(|s| s.to_string_lossy().starts_with('-'))
        })
    {
        return CompileResult::CaptureIncomplete {
            reason: "source filename cannot be a compiler option".into(),
        };
    }
    match compile_inner(captured, inventory, cancel, phase) {
        Ok(result) => result,
        Err(reason) if cancel.load(Ordering::Acquire) => CompileResult::Cancelled { reason },
        Err(reason) => CompileResult::CaptureIncomplete { reason },
    }
}
fn compile_inner(
    captured: &Capture,
    inventory: &InventoryProvider<'_>,
    cancel: &AtomicBool,
    phase: &dyn Fn(&str),
) -> Result<CompileResult> {
    let compiler = capture::verified_bytes(captured, "compiler", cancel)?;
    let catalog_bytes = capture::verified_bytes(captured, "catalog", cancel)?;
    phase("staging_compiler");
    let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
    let executable = staging.path().join("can");
    let catalog = staging.path().join("catalog.json");
    write_executable(&executable, &compiler)?;
    write_private(&catalog, &catalog_bytes, 0o600)?;
    stage_sources(captured, staging.path(), cancel)?;
    capture::check_cancel(cancel)?;
    phase("compiler");
    let mut args = vec![
        "compile".into(),
        "--format=json".into(),
        "--native-scenario-receipts".into(),
        format!("--catalog={}", catalog.display()),
        captured.compiler_operand.clone(),
    ];
    if let Some(providers) = &captured.provider_snapshot {
        let mut operands: Vec<&str> = providers
            .iter()
            .map(|provider| provider.snapshot.path.as_str())
            .collect();
        operands.sort_unstable();
        args.extend(operands.into_iter().map(str::to_owned));
    }
    let run = match run_owned(
        &executable,
        &args,
        staging.path(),
        &[(
            "CAN_CATALOG",
            catalog.to_str().ok_or("catalog path is not UTF-8")?,
        )],
        None,
        cancel,
        30,
        16 * 1024 * 1024,
    ) {
        Ok(run) => run,
        Err(reason) if cancel.load(Ordering::Acquire) => return Err(reason),
        Err(reason) => return Ok(CompileResult::ToolFailure { reason }),
    };
    capture::check_cancel(cancel)?;
    phase("verifying_compiler_inputs");
    if !capture::is_current_with_phases(captured, inventory, cancel, phase) {
        return Err("inputs changed during compiler execution".into());
    }
    capture::check_cancel(cancel)?;
    Ok(interpret(captured, run))
}
fn stage_sources(captured: &Capture, staging: &Path, cancel: &AtomicBool) -> Result<()> {
    capture::validate_relative(&captured.compiler_operand)?;
    write_source(
        staging,
        &captured.compiler_operand,
        captured.source_text.as_bytes(),
    )?;
    if let Some(snapshot) = &captured.source_snapshot {
        for source in snapshot {
            capture::check_cancel(cancel)?;
            capture::validate_relative(&source.path)?;
            if source.bytes.kind != "Buffer" || capture::hash(&source.bytes.data) != source.sha256 {
                return Err("captured source snapshot hash mismatch".into());
            }
            if source.path == captured.compiler_operand && source.sha256 != captured.source_sha256 {
                return Err("captured source snapshot app mismatch".into());
            }
            write_source(staging, &source.path, &source.bytes.data)?;
        }
    }
    if let Some(providers) = &captured.provider_snapshot {
        for provider in providers {
            capture::check_cancel(cancel)?;
            capture::validate_relative(&provider.snapshot.path)?;
            if provider.snapshot.bytes.kind != "Buffer"
                || capture::hash(&provider.snapshot.bytes.data) != provider.snapshot.sha256
            {
                return Err("captured provider snapshot hash mismatch".into());
            }
            write_source(
                staging,
                &provider.snapshot.path,
                &provider.snapshot.bytes.data,
            )?;
        }
    }
    Ok(())
}
fn write_source(staging: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    if matches!(relative, "can" | "catalog.json") {
        return Err("source path collides with staged compiler inputs".into());
    }
    let path = staging.join(relative);
    fs::create_dir_all(path.parent().ok_or("source path has no parent")?)
        .map_err(|e| e.to_string())?;
    write_private(&path, bytes, 0o600)
}
pub(crate) fn write_executable(path: &Path, bytes: &[u8]) -> Result<()> {
    write_private(path, bytes, 0o700)
}
fn write_private(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|e| e.to_string())
}
fn interpret(captured: &Capture, run: ProcessOutput) -> CompileResult {
    if run.code != Some(0) && run.code != Some(10) {
        return CompileResult::ToolFailure {
            reason: format!(
                "compiler exited {:?}: {}",
                run.code,
                String::from_utf8_lossy(&run.stderr)
                    .chars()
                    .take(400)
                    .collect::<String>()
            ),
        };
    }
    let parsed: Value = match serde_json::from_slice(&run.stdout) {
        Ok(value) => value,
        Err(_) => {
            return CompileResult::ToolFailure {
                reason: "compiler returned invalid JSON".into(),
            };
        }
    };
    if run.code == Some(0) {
        if let Err(reason) = validate_artifact(&parsed) {
            return CompileResult::ToolFailure { reason };
        }
    } else if !parsed.is_object() || !parsed["diagnostics"].is_array() {
        return CompileResult::ToolFailure {
            reason: "compiler diagnostics envelope or diagnostics are missing".into(),
        };
    }
    let complete = run.code == Some(0) || parsed["complete"] == true;
    if let Err(reason) = capture::verify_compiler_sources(captured, &parsed, complete) {
        return CompileResult::CaptureIncomplete { reason };
    }
    if run.code == Some(0) {
        CompileResult::Artifact {
            artifact: parsed,
            artifact_bytes: run.stdout,
        }
    } else {
        CompileResult::Diagnostics { envelope: parsed }
    }
}
/// Runtime-specific optional sections are validated by the existing bridge
/// artifact loader. This boundary admits the compiler's executable envelope.
fn validate_artifact(value: &Value) -> Result<()> {
    if value["artifact_version"] != 1
        || !nonempty(&value["tool_version"])
        || !nonempty(&value["language_version"])
    {
        return Err("compiler returned an invalid artifact identity".into());
    }
    let modules = value["modules"]
        .as_array()
        .filter(|m| !m.is_empty())
        .ok_or("artifact modules must be a nonempty array")?;
    let mut paths = std::collections::BTreeSet::new();
    for module in modules {
        if !nonempty(&module["path"]) || !module["js"].is_string() || module["map"]["version"] != 3
        {
            return Err("artifact module is malformed".into());
        }
        paths.insert(module["path"].as_str().unwrap());
    }
    let callables = value["callables"]
        .as_array()
        .ok_or("artifact callables are missing")?;
    for callable in callables {
        validate_callable(callable, &paths)?;
    }
    let requires = value["requires"]
        .as_array()
        .ok_or("artifact requirements are missing")?;
    for requirement in requires {
        if !nonempty(&requirement["capability"]) || requirement["min_version"].as_u64().is_none() {
            return Err("artifact capability requirement is malformed".into());
        }
    }
    Ok(())
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn validate_callable(value: &Value, modules: &std::collections::BTreeSet<&str>) -> Result<()> {
    if !nonempty(&value["id"])
        || !nonempty(&value["export"])
        || !modules.contains(value["module"].as_str().unwrap_or(""))
    {
        return Err("artifact callable identity is malformed".into());
    }
    if !matches!(
        value["kind"].as_str(),
        Some("operation" | "pure" | "rule" | "handler" | "migration")
    ) {
        return Err("artifact callable kind is unsupported".into());
    }
    if !value["member"]
        .as_array()
        .is_some_and(|m| !m.is_empty() && m.iter().all(nonempty))
    {
        return Err("artifact callable member is malformed".into());
    }
    Ok(())
}

pub(crate) struct ProcessOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
struct PipeRead {
    bytes: Vec<u8>,
    error: Option<String>,
}
fn read_pipe(mut pipe: impl Read, limit: usize, overflow: Arc<AtomicBool>) -> PipeRead {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let len = match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                return PipeRead {
                    bytes,
                    error: Some(e.to_string()),
                };
            }
        };
        if bytes.len().saturating_add(len) > limit {
            overflow.store(true, Ordering::Release);
        } else {
            bytes.extend_from_slice(&buffer[..len]);
        }
    }
    PipeRead { bytes, error: None }
}
fn signal_group(child: &Child, signal: i32) {
    // process_group(0) below creates an exclusive group rooted in this exact
    // spawn. Never accept a PID from an external message or process scan.
    unsafe {
        libc::kill(-(child.id() as i32), signal);
    }
}
fn begin_termination(child: &Child, started: &mut Option<Instant>) {
    if started.is_none() {
        signal_group(child, libc::SIGTERM);
        *started = Some(Instant::now());
    }
}
fn await_owned(
    child: &mut Child,
    receiver: mpsc::Receiver<(bool, PipeRead)>,
    overflow: &AtomicBool,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<ProcessOutput> {
    let start = Instant::now();
    let mut terminated = None;
    let mut escalated = false;
    let mut reason = None;
    let mut code = None;
    let mut exited = false;
    let mut stdout = None;
    let mut stderr = None;
    loop {
        for (out, read) in receiver.try_iter() {
            if out {
                stdout = Some(read);
            } else {
                stderr = Some(read);
            }
        }
        if !exited {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exited = true;
                    code = status.code();
                }
                Ok(None) => {}
                Err(e) => {
                    reason.get_or_insert(e.to_string());
                    begin_termination(child, &mut terminated);
                }
            }
        }
        if cancel.load(Ordering::Acquire) {
            reason.get_or_insert_with(|| "cancelled".into());
        }
        if overflow.load(Ordering::Acquire) {
            reason.get_or_insert_with(|| "compiler output exceeded limit".into());
        }
        if start.elapsed() >= timeout {
            reason.get_or_insert_with(|| "compiler timed out".into());
        }
        if reason.is_some() {
            begin_termination(child, &mut terminated);
        }
        if !escalated && terminated.is_some_and(|time| time.elapsed() >= Duration::from_millis(250))
        {
            signal_group(child, libc::SIGKILL);
            escalated = true;
        }
        if exited && stdout.is_some() && stderr.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    // Child status and both pipe closures are observed before any caller can
    // release staging. Escalation also reaps inherited-pipe descendants.
    let _ = child.wait();
    let stdout = stdout.unwrap();
    let stderr = stderr.unwrap();
    if let Some(error) = reason.or(stdout.error).or(stderr.error) {
        return Err(error);
    }
    Ok(ProcessOutput {
        code,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_owned(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(&str, &str)],
    stdin: Option<Vec<u8>>,
    cancel: &AtomicBool,
    timeout_seconds: u64,
    stdout_limit: usize,
) -> Result<ProcessOutput> {
    capture::check_cancel(cancel)?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .envs(env.iter().copied())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let overflow = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::channel();
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let output_sender = sender.clone();
    let output_overflow = overflow.clone();
    let stdout_reader = thread::spawn(move || {
        let _ = output_sender.send((true, read_pipe(out, stdout_limit, output_overflow)));
    });
    let error_overflow = overflow.clone();
    let stderr_reader = thread::spawn(move || {
        let _ = sender.send((false, read_pipe(err, 8192, error_overflow)));
    });
    let writer = child.stdin.take().map(|mut pipe| {
        thread::spawn(move || {
            if let Some(bytes) = stdin {
                let _ = pipe.write_all(&bytes);
            }
        })
    });
    let result = await_owned(
        &mut child,
        receiver,
        &overflow,
        cancel,
        Duration::from_secs(timeout_seconds),
    );
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    result
}
