//! Connect the terminal adapter to the actual owner/control authority.
use crate::{
    claim::{self, ControlError, Identity},
    control::{Client, Command},
    input::{Action, HELP},
    model::{Lifecycle, Snapshot, SourceResult},
    owner::Owner,
    presentation,
    ui::{self, ExitReason, UiConfig, UiUpdate},
};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone)]
enum Endpoint {
    Owned(Arc<Owner>),
    Attached(Client),
}
impl Endpoint {
    fn identity(&self) -> &Identity {
        match self {
            Self::Owned(owner) => &owner.identity,
            Self::Attached(client) => &client.identity,
        }
    }
    fn request(&self, name: &str, payload: Value, cancel: &AtomicBool) -> claim::Result<Value> {
        let command = Command {
            command: name.into(),
            payload,
        };
        match self {
            Self::Owned(owner) => owner.request(command),
            Self::Attached(client) => client.request(command, cancel),
        }
    }
    fn snapshot(&self, cancel: &AtomicBool) -> claim::Result<Snapshot> {
        let state = match self {
            Self::Owned(owner) => owner.snapshot(),
            Self::Attached(_) => {
                serde_json::from_value(self.request("observe", json!({}), cancel)?).map_err(
                    |_| ControlError::new("INVALID_OBSERVATION", "owner snapshot is unavailable"),
                )?
            }
        };
        if state.schema != "can.dev.observation.v1" || state.session != self.identity().session_id {
            return Err(ControlError::new(
                "INVALID_OBSERVATION",
                "snapshot does not match the verified owner",
            ));
        }
        Ok(state)
    }
}

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn recovery(identity: &Identity) -> String {
    format!(
        "can dev stop --root {} --session {}",
        quoted(&identity.root),
        quoted(&identity.session_id)
    )
}
fn message(updates: &Sender<UiUpdate>, lines: Vec<String>) {
    let _ = updates.send(UiUpdate::Message(lines));
}
fn command_error(error: ControlError) -> Vec<String> {
    vec![
        format!("{}: {}", error.code, error.message),
        "Enter status for the current owner state; retry only after its blocker is resolved."
            .into(),
    ]
}

fn format_access(value: Value) -> Vec<String> {
    let mut lines = match value.get("url").and_then(Value::as_str) {
        Some(url) => vec![format!("Preview access (private): {url}")],
        None => vec!["Preview access URL unavailable.".into()],
    };
    match &value["actors"] {
        Value::Array(actors) => {
            for actor in actors.iter().take(20) {
                if let (Some(email), Some(password)) =
                    (actor["email"].as_str(), actor["password"].as_str())
                {
                    lines.push(format!(
                        "Actor {} (private): {email} / {password}",
                        actor["label"].as_str().unwrap_or("local")
                    ));
                }
            }
        }
        Value::Object(actors) => {
            for (label, actor) in actors.iter().take(20) {
                if let Some(url) = actor.as_str().or_else(|| actor["url"].as_str()) {
                    lines.push(format!("Actor {label} (private): {url}"));
                }
            }
        }
        _ => {}
    }
    lines
}

/// Preserve owner result fields and refs without interpreting them as terminal instructions.
/// The UI applies its shared bounded-history projection before writing these lines.
fn help_fields(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|field| {
            let name = match field["name"].as_str()? {
                "expectedRevision" => "expected-revision",
                "authorIntent" => "author-intent",
                "rowIndex" => "row",
                name => name,
            };
            Some(format!(
                "--{name} {}",
                field["type"].as_str().unwrap_or("VALUE")
            ))
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn format_control(command: &str, value: Value) -> Vec<String> {
    let mut lines = vec![format!("{command} result:")];
    if command == "help" {
        for entry in value["commands"].as_array().into_iter().flatten().take(25) {
            let name = entry["name"].as_str().unwrap_or("unknown");
            let optional = help_fields(&entry["optional"]);
            lines.push(format!(
                "{name} {}{} | {}",
                help_fields(&entry["required"]),
                if optional.is_empty() {
                    String::new()
                } else {
                    format!(" [{optional}]")
                },
                entry["availability"]
                    .as_str()
                    .unwrap_or("owner decides availability")
            ));
        }
        return lines;
    }
    match serde_json::to_string_pretty(&value) {
        Ok(encoded) => {
            lines.extend(encoded.lines().take(36).map(str::to_owned));
            if encoded.lines().count() > 36 {
                lines.push("Result display truncated; use the JSON command for the complete bounded result.".into());
            }
        }
        Err(_) => lines.push("Owner result could not be displayed.".into()),
    }
    lines
}
fn format_logs(value: Value) -> Vec<String> {
    let Some(text) = value.get("text").and_then(Value::as_str) else {
        return vec!["Runtime logs unavailable in this session.".into()];
    };
    let mut lines = vec!["Retained runtime stderr:".into()];
    lines.extend(text.lines().take(30).map(str::to_string));
    if text.is_empty() {
        lines.push("No retained stderr; this is not evidence of runtime health.".into());
    }
    if text.lines().count() > 30 {
        lines.push(
            "Log display truncated to 30 lines; more retained bytes remain available.".into(),
        );
    }
    if let Some(dropped) = value
        .get("dropped_bytes")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
    {
        lines.push(format!("Runtime stderr retention dropped {dropped} bytes."));
    }
    lines
}
fn format_diagnostics(snapshot: &Snapshot, revision: &str, page: &Value) -> Vec<String> {
    let older = if page["current"] == false {
        " (older source)"
    } else {
        ""
    };
    let mut lines = vec![format!("Diagnostics captured at {revision}{older}:")];
    let items = page
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for diagnostic in items.iter().take(3) {
        let code = diagnostic["code"].as_str().unwrap_or("diagnostic");
        let text = diagnostic["message"]
            .as_str()
            .unwrap_or("message unavailable");
        let at = &diagnostic["at"];
        lines.push(format!("{code}: {text}"));
        let path = at["path"].as_str().map(str::to_string).unwrap_or_else(|| {
            if at["file"] == 0 {
                snapshot.source_path.clone()
            } else {
                format!("captured file {} (path unavailable)", at["file"])
            }
        });
        lines.push(format!("  {path} bytes {}..{}", at["start"], at["end"]));
    }
    if items.is_empty() {
        lines.push("No retained diagnostic entries for this result.".into());
    }
    if !page["next_after"].is_null() {
        lines.push("More diagnostics retained; this display contains the first three.".into());
    }
    lines
}
fn details(
    endpoint: &Endpoint,
    snapshot: &Snapshot,
    cancel: &AtomicBool,
) -> claim::Result<Vec<String>> {
    let Some(revision) = snapshot
        .last_outcome
        .as_ref()
        .and_then(|outcome| outcome.revision.as_deref())
    else {
        return Ok(vec!["No captured check details yet; enter check.".into()]);
    };
    let page = endpoint.request(
        "diagnostics",
        json!({"revision":revision,"after":-1,"limit":3}),
        cancel,
    )?;
    if page["revision"] != revision {
        return Err(ControlError::new(
            "INVALID_DIAGNOSTICS",
            "retained diagnostic revision did not match the requested check",
        ));
    }
    let mut lines = format_diagnostics(snapshot, revision, &page);
    match endpoint.request(
        "diagnostic.detail",
        json!({"revision":revision,"index":0,"presentationOnly":true}),
        cancel,
    ) {
        Ok(detail) => {
            if detail["revision"] != revision {
                lines.push("Captured detail unavailable: retained revision did not match the requested check.".into());
                return Ok(lines);
            }
            if let Some(text) = detail["captured_excerpt"]["text"].as_str() {
                lines.push(format!("Captured excerpt ({revision}):"));
                lines.extend(text.lines().take(12).map(|line| format!("  {line}")));
                if text.lines().count() > 12 {
                    lines.push("Captured excerpt display truncated to 12 lines.".into());
                }
            } else {
                lines.push(
                    "Captured source excerpt unavailable; source on disk may have changed.".into(),
                );
            }
        }
        Err(error) => lines.push(format!(
            "Captured detail unavailable ({}); source on disk was not substituted.",
            error.code
        )),
    }
    Ok(lines)
}
fn perform(
    endpoint: &Endpoint,
    action: Action,
    snapshot: &Snapshot,
    cancel: &AtomicBool,
) -> claim::Result<Vec<String>> {
    match action {
        Action::Check => {
            let result = endpoint.request("check.request", json!({}), cancel)?;
            let text = if result["accepted"] == true {
                "Check requested; waiting for owner progress."
            } else if result["alreadyChecking"] == true {
                "Already checking; the owner retained the active operation."
            } else {
                "Check refused by owner admission; enter status for the current blocker."
            };
            Ok(vec![text.into()])
        }
        Action::Open => endpoint
            .request("preview.open", json!({}), cancel)
            .map(format_access),
        Action::Details => details(endpoint, snapshot, cancel),
        Action::Logs => endpoint.request("logs", json!({}), cancel).map(format_logs),
        Action::Stop => {
            if !matches!(endpoint, Endpoint::Owned(_)) {
                return Ok(vec![
                    "Attached view cannot stop this owner. Enter detach to leave.".into(),
                ]);
            }
            let result = endpoint.request("stop.confirm", json!({}), cancel)?;
            Ok(vec![
                if result["resourcesReleased"] == true {
                    "Resources released; waiting for the owner to retire its control claim."
                } else {
                    "Shutdown release is unconfirmed; retain this owner and retry stop."
                }
                .into(),
            ])
        }
        Action::Status => Ok(presentation::status(
            &endpoint.snapshot(cancel)?,
            now(),
            true,
        )),
        Action::Help => {
            let help = endpoint.request("help", json!({}), cancel)?;
            let mut lines = vec![HELP.into(), "Use explicit --revision rN for retained results; example.run requires --expected-revision rN. Append --author-intent SENTENCE last. Selection is fixed to this verified owner.".into()];
            lines.extend(format_control("help", help));
            Ok(lines)
        }
        Action::Control { command, payload } => endpoint
            .request(&command, payload, cancel)
            .map(|value| format_control(&command, value)),
        Action::Detach => Ok(vec![
            "Detach is a presentation action; session lifetime remains with its owner.".into(),
        ]),
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct Work {
    action: Action,
    snapshot: Snapshot,
}
struct Session {
    endpoint: Endpoint,
    latest: Arc<Mutex<Snapshot>>,
    done: Arc<AtomicBool>,
    ui_live: Arc<AtomicBool>,
    updates: Sender<UiUpdate>,
    actions: Sender<Action>,
    threads: Vec<JoinHandle<()>>,
}
impl Session {
    fn start(endpoint: Endpoint, initial: Snapshot) -> (Self, Receiver<UiUpdate>) {
        let (updates, receiver) = mpsc::channel();
        let (actions, action_receiver) = mpsc::channel();
        let (work, work_receiver) = mpsc::sync_channel(4);
        let (stop, stop_receiver) = mpsc::sync_channel(1);
        let mut session = Self {
            endpoint,
            latest: Arc::new(Mutex::new(initial)),
            done: Arc::new(AtomicBool::new(false)),
            ui_live: Arc::new(AtomicBool::new(true)),
            updates,
            actions,
            threads: vec![],
        };
        session.spawn_worker(work_receiver);
        session.spawn_worker(stop_receiver);
        session.spawn_dispatcher(action_receiver, work.clone(), stop);
        session.spawn_monitor(work);
        session.spawn_signals();
        (session, receiver)
    }
    fn spawn_worker(&mut self, receiver: Receiver<Work>) {
        let endpoint = self.endpoint.clone();
        let done = self.done.clone();
        let updates = self.updates.clone();
        self.threads.push(thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let work = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(work) => work,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                let lines = perform(&endpoint, work.action, &work.snapshot, &done)
                    .unwrap_or_else(command_error);
                message(&updates, lines);
            }
        }));
    }
    fn spawn_dispatcher(
        &mut self,
        receiver: Receiver<Action>,
        work: SyncSender<Work>,
        stop: SyncSender<Work>,
    ) {
        let done = self.done.clone();
        let latest = self.latest.clone();
        let updates = self.updates.clone();
        self.threads.push(thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                let action = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(action) => action,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                let stopping = action == Action::Stop;
                let request = Work {
                    action,
                    snapshot: latest.lock().unwrap_or_else(|p| p.into_inner()).clone(),
                };
                let queue = if stopping { &stop } else { &work };
                if queue.try_send(request).is_err() {
                    message(
                        &updates,
                        vec![
                            "Control action already pending; stop remains available independently."
                                .into(),
                        ],
                    );
                }
            }
        }));
    }
    fn spawn_monitor(&mut self, work: SyncSender<Work>) {
        let endpoint = self.endpoint.clone();
        let done = self.done.clone();
        let latest = self.latest.clone();
        let updates = self.updates.clone();
        self.threads.push(thread::spawn(move || {
            monitor(endpoint, done, latest, updates, work)
        }));
    }
    fn spawn_signals(&mut self) {
        let done = self.done.clone();
        let live = self.ui_live.clone();
        let updates = self.updates.clone();
        self.threads.push(thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                if live.load(Ordering::Acquire) && crate::signals::take() {
                    let _ = updates.send(UiUpdate::Interrupt);
                }
                thread::sleep(Duration::from_millis(30));
            }
        }));
    }
    fn finish(mut self) -> Result<(), String> {
        self.ui_live.store(false, Ordering::Release);
        self.done.store(true, Ordering::Release);
        let failed = self
            .threads
            .drain(..)
            .map(|thread| thread.join().is_err())
            .fold(false, |failed, next| failed | next);
        if failed {
            Err("Foreground adapter worker failed".into())
        } else {
            Ok(())
        }
    }
}
fn monitor(
    endpoint: Endpoint,
    done: Arc<AtomicBool>,
    latest: Arc<Mutex<Snapshot>>,
    updates: Sender<UiUpdate>,
    work: SyncSender<Work>,
) {
    let mut connected = true;
    let mut previous = None;
    let mut outcome = None;
    while !done.load(Ordering::Acquire) {
        match endpoint.snapshot(&done) {
            Ok(snapshot) => {
                let changed = previous != Some(snapshot.sequence) || !connected;
                previous = Some(snapshot.sequence);
                connected = true;
                *latest.lock().unwrap_or_else(|p| p.into_inner()) = snapshot.clone();
                if changed {
                    let _ = updates.send(UiUpdate::Snapshot(snapshot.clone()));
                }
                auto_details(&snapshot, &mut outcome, &work, &updates);
            }
            Err(error) => {
                if connected {
                    let _ = updates.send(UiUpdate::Disconnected(format!(
                        "{}; verified recovery: {}",
                        error.code,
                        recovery(endpoint.identity())
                    )));
                }
                connected = false;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
}
fn auto_details(
    snapshot: &Snapshot,
    previous: &mut Option<String>,
    work: &SyncSender<Work>,
    updates: &Sender<UiUpdate>,
) {
    let Some(result) = &snapshot.last_outcome else {
        return;
    };
    if previous.as_deref() == Some(&result.id) {
        return;
    }
    *previous = Some(result.id.clone());
    if matches!(
        result.source,
        SourceResult::Errors | SourceResult::Incomplete
    ) && result.revision.is_some()
        && work
            .try_send(Work {
                action: Action::Details,
                snapshot: snapshot.clone(),
            })
            .is_err()
    {
        message(updates, vec!["Captured diagnostic details remain available; enter details after the pending action.".into()]);
    }
}

fn initial_observation(
    client: &Client,
    interrupted: impl Fn() -> bool + Send + 'static,
) -> Result<Option<Snapshot>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let signal_cancel = cancel.clone();
    let signal_finished = finished.clone();
    let watcher = thread::spawn(move || {
        while !signal_finished.load(Ordering::Acquire) {
            if interrupted() {
                signal_cancel.store(true, Ordering::Release);
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    });
    let result = Endpoint::Attached(client.clone()).snapshot(&cancel);
    finished.store(true, Ordering::Release);
    watcher
        .join()
        .map_err(|_| "Initial observation interrupt watcher failed".to_string())?;
    if cancel.load(Ordering::Acquire) {
        return Ok(None);
    }
    result.map(Some).map_err(|error| error.to_string())
}

pub fn run_attached(client: Client, plain: bool) -> Result<(), String> {
    let Some(initial) = initial_observation(&client, crate::signals::take)? else {
        return Ok(());
    };
    let endpoint = Endpoint::Attached(client);
    let config = UiConfig {
        plain,
        recovery_command: Some(recovery(endpoint.identity())),
        ..Default::default()
    };
    let (session, updates) = Session::start(endpoint, initial.clone());
    let result =
        ui::run(initial, updates, session.actions.clone(), config).map_err(|e| e.to_string());
    session.finish()?;
    result.map(|_| ())
}

pub fn run_owned(owner: Owner, plain: bool) -> Result<(), String> {
    let owner = Arc::new(owner);
    let endpoint = Endpoint::Owned(owner.clone());
    let initial = owner.snapshot();
    let recovery = recovery(&owner.identity);
    let config = UiConfig {
        owned: true,
        plain,
        recovery_command: Some(recovery.clone()),
        ..Default::default()
    };
    let (session, updates) = Session::start(endpoint, initial.clone());
    let result = ui::run(initial, updates, session.actions.clone(), config);
    session.ui_live.store(false, Ordering::Release);
    if !matches!(result, Ok(ExitReason::Stopped)) {
        retain_until_stopped(&owner, &session.actions, &recovery);
    }
    let workers = session.finish();
    let joined = Arc::try_unwrap(owner)
        .map_err(|_| "Foreground owner references were not released".to_string())?
        .join()
        .map_err(|e| e.to_string());
    workers?;
    joined?;
    result.map(|_| ()).map_err(|e| e.to_string())
}
fn retain_until_stopped(owner: &Owner, actions: &Sender<Action>, recovery: &str) {
    let mut output = io::stderr();
    let _ = writeln!(
        output,
        "Presentation closed; stopping the owned session and retaining cleanup authority."
    );
    let _ = actions.send(Action::Stop);
    let mut previous = None;
    while owner.snapshot().lifecycle != Lifecycle::Stopped {
        let lifecycle = owner.snapshot().lifecycle;
        if lifecycle == Lifecycle::ShutdownIncomplete && previous != Some(lifecycle) {
            let _ = writeln!(
                output,
                "Cleanup incomplete. Ctrl+C retries; the owner remains available. Recovery: {}",
                presentation::terminal_text(recovery, 2000)
            );
        }
        previous = Some(lifecycle);
        if crate::signals::take() {
            let _ = actions.send(Action::Stop);
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = writeln!(output, "Stopped; owner confirmed resource release.");
}
