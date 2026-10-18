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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        claim::tests::{lookup, selection},
        control::Server,
        state::SessionState,
    };

    #[test]
    fn action_adapter_uses_real_client_and_revision_bound_captured_diagnostics() {
        let (_root, _runtime, selection) = selection();
        let calls = Arc::new(Mutex::new(Vec::<Command>::new()));
        let seen = calls.clone();
        let observation_started = Arc::new(AtomicBool::new(false));
        let release_observation = Arc::new(AtomicBool::new(false));
        let observed = observation_started.clone();
        let release = release_observation.clone();
        let mut server = Server::start(selection.clone(), Arc::new(move |command| {
            seen.lock().unwrap().push(command.clone());
            Ok(match command.command.as_str() {
                "observe" => {
                    observed.store(true, Ordering::Release);
                    while !release.load(Ordering::Acquire) { thread::sleep(Duration::from_millis(5)); }
                    json!({})
                }
                "diagnostics" => json!({"revision":"captured-r1","current":false,"diagnostics":[{"code":"E123","message":"Unknown field","at":{"file":0,"start":7,"end":9}}],"next_after":null}),
                "diagnostic.detail" => json!({"revision":"captured-r1","captured_excerpt":{"text":"captured original source"}}),
                "check.request" => json!({"accepted":true}),
                "preview.open" => json!({"url":"http://localhost/access?private=credential"}),
                "logs" => json!({"text":"runtime line\n","dropped_bytes":12}),
                "failure.detail" => json!({"ref":"session/r1/d0","message":"safe retained message"}),
                "help" => json!({"commands":[{"name":"example.run","required":[{"name":"expectedRevision"}],"availability":"current_verified_artifact"}]}),
                _ => return Err(ControlError::new("UNEXPECTED_COMMAND", "unexpected test command")),
            })
        })).unwrap();
        let client = Client::discover(&lookup(&selection)).unwrap();
        let endpoint = Endpoint::Attached(client);
        let mut snapshot = SessionState::new(
            server.identity.session_id.clone(),
            "Tasks".into(),
            "Tasks.can".into(),
            crate::model::CheckMode::Manual,
        )
        .snapshot();
        snapshot.last_outcome = Some(crate::model::Outcome {
            id: "check".into(),
            revision: Some("captured-r1".into()),
            source: SourceResult::Errors,
            preview: crate::model::PreviewResult::Unavailable,
            reason: None,
            started_at: 1,
            finished_at: 2,
        });
        let cancel = AtomicBool::new(false);
        let lines = perform(&endpoint, Action::Details, &snapshot, &cancel)
            .unwrap()
            .join("\n");
        assert!(lines.contains("captured-r1 (older source)"));
        assert!(lines.contains("captured original source"));
        assert!(lines.contains("Tasks.can bytes 7..9"));
        assert!(
            perform(&endpoint, Action::Check, &snapshot, &cancel).unwrap()[0].contains("requested")
        );
        let access = perform(&endpoint, Action::Open, &snapshot, &cancel).unwrap();
        assert_eq!(
            access,
            ["Preview access (private): http://localhost/access?private=credential"]
        );
        assert!(
            perform(&endpoint, Action::Logs, &snapshot, &cancel)
                .unwrap()
                .iter()
                .any(|line| line.contains("dropped 12 bytes"))
        );
        let routed = perform(
            &endpoint,
            Action::Control {
                command: "failure.detail".into(),
                payload: json!({"ref":"session/r1/d0"}),
            },
            &snapshot,
            &cancel,
        )
        .unwrap()
        .join("\n");
        assert!(routed.contains("safe retained message"));
        assert!(
            perform(&endpoint, Action::Help, &snapshot, &cancel)
                .unwrap()
                .join("\n")
                .contains("--expected-revision")
        );
        let before = calls.lock().unwrap().len();
        assert!(
            perform(&endpoint, Action::Stop, &snapshot, &cancel).unwrap()[0]
                .contains("cannot stop")
        );
        let recorded = calls.lock().unwrap();
        assert_eq!(recorded.len(), before);
        assert_eq!(recorded[0].command, "diagnostics");
        assert_eq!(
            recorded[0].payload,
            json!({"revision":"captured-r1","after":-1,"limit":3})
        );
        assert_eq!(
            recorded[1].payload,
            json!({"revision":"captured-r1","index":0,"presentationOnly":true})
        );
        drop(recorded);
        let Endpoint::Attached(client) = endpoint else {
            unreachable!()
        };
        let interrupted = Arc::new(AtomicBool::new(false));
        let signal = interrupted.clone();
        let (finished, completion) = mpsc::channel();
        let startup = thread::spawn(move || {
            let result = initial_observation(&client, move || signal.load(Ordering::Acquire));
            let _ = finished.send(result);
        });
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while !observation_started.load(Ordering::Acquire) && std::time::Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(observation_started.load(Ordering::Acquire));
        interrupted.store(true, Ordering::Release);
        let cancelled = completion.recv_timeout(Duration::from_secs(2));
        release_observation.store(true, Ordering::Release);
        startup.join().unwrap();
        assert!(cancelled.unwrap().unwrap().is_none());
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.command == "stop" || call.command == "stop.confirm")
        );
        loop {
            if server.retire_when_drained().unwrap() {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "cancelled observer connection was not released"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn explicit_access_projects_real_actor_credentials_and_results_are_bounded() {
        assert_eq!(
            format_access(
                json!({"url":"http://localhost/access", "actors":[{"label":"Ava","email":"ava@local","password":"private","teams":["team"]}]})
            ),
            [
                "Preview access (private): http://localhost/access",
                "Actor Ava (private): ava@local / private"
            ]
        );
        let lines = format_control(
            "failures",
            json!({"failures": (0..100).collect::<Vec<_>>()}),
        );
        assert!(lines.len() <= 38);
        assert!(lines.last().unwrap().contains("truncated"));
        assert_eq!(
            format_control("example.run", json!({"status":"passed"})).len(),
            4
        );
    }

    #[test]
    fn details_and_logs_report_unavailable_truncation_and_explicit_access_only() {
        assert_eq!(
            format_access(json!({})),
            ["Preview access URL unavailable."]
        );
        assert_eq!(
            format_logs(json!({"unavailable":true})),
            ["Runtime logs unavailable in this session."]
        );
        let logs = format_logs(json!({"text":"line\n".repeat(40),"dropped_bytes":5}));
        assert!(logs.iter().any(|line| line.contains("truncated")));
        assert!(logs.iter().any(|line| line.contains("dropped 5 bytes")));
        let snapshot = SessionState::new(
            "s".into(),
            "Tasks".into(),
            "Tasks.can".into(),
            crate::model::CheckMode::Manual,
        )
        .snapshot();
        let page = json!({"current":false,"diagnostics":[{"code":"E","message":"captured","at":{"file":3,"start":1,"end":2}}],"next_after":2});
        let details = format_diagnostics(&snapshot, "r1", &page).join("\n");
        assert!(details.contains("captured file 3 (path unavailable)"));
        assert!(details.contains("More diagnostics retained"));
        assert!(!details.contains("Tasks.can"));
    }
}
