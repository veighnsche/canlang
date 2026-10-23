use super::*;

pub(super) struct CheckWorker {
    pub(super) resources: Arc<sdk::Resources>,
    pub(super) config: Config,
    pub(super) bridge: Option<Arc<Bridge>>,
    pub(super) tx: Sender<Event>,
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) operation: String,
    pub(super) hint: u64,
}
impl CheckWorker {
    pub(super) fn run(mut self, expected: Option<String>) {
        let result = self.perform(expected);
        if let Err(reason) = result {
            let _ = self.tx.send(Event::Failed(self.operation.clone(), reason));
        }
    }
    fn perform(&mut self, expected: Option<String>) -> std::result::Result<(), String> {
        let bridge = self.host()?;
        let inventory = || self.inventory(&bridge, CheckPhase::Capturing);
        let mut request = self.config.capture.clone();
        if request.input_inventory.as_deref() == Some("installed-local-preview") {
            let inputs = inventory()?;
            request.package_input_paths = inputs.package_input_paths;
            request.extra_input_paths = inputs.extra_input_paths;
        }
        let capture = capture::capture_with_phases(&request, &inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::Capturing, phase)
        })?;
        let ticket = self.bind_current(capture.clone(), expected, &inventory)?;
        let (reuse_reply, reuse_result) = mpsc::channel();
        self.tx
            .send(Event::ReuseServing {
                ticket: ticket.clone(),
                reply: reuse_reply,
            })
            .map_err(|e| e.to_string())?;
        if reuse_result
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
        let compiler_inventory = || self.inventory(&bridge, CheckPhase::CheckingSource);
        self.phase(CheckPhase::CheckingSource, "compiler");
        let result = if !source_app_matches(&capture.source_text, &self.config.selection.app) {
            CompileResult::ProfileUnsupported {
                reason: "selected app does not match source app declaration".into(),
            }
        } else {
            compiler::compile(&capture, &compiler_inventory, &self.cancel, &|phase| {
                self.phase(CheckPhase::CheckingSource, phase)
            })
        };
        let result = service::normalize(&capture, result);
        if let Ok(index) = load_construct_index(&bridge, &capture, &self.cancel, &self.tx) {
            let _ = self.tx.send(Event::ConstructIndex(
                ticket.revision.clone(),
                Arc::new(index),
            ));
        }
        match result {
            CompileResult::Artifact {
                artifact,
                artifact_bytes,
            } => self.prepare(&bridge, ticket, capture, artifact, artifact_bytes, &|| {
                self.inventory(&bridge, CheckPhase::PreparingPreview)
            }),
            result => {
                self.tx
                    .send(Event::Completed {
                        operation: self.operation.clone(),
                        result,
                        capture: Some(capture),
                    })
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }
    fn host(&mut self) -> std::result::Result<Arc<Bridge>, String> {
        if let Some(host) = &self.bridge {
            return Ok(host.clone());
        }
        self.phase(CheckPhase::Capturing, "starting_runtime_host");
        self.tx
            .send(Event::HostStarting)
            .map_err(|e| e.to_string())?;
        let result = Bridge::spawn(self.config.bridge.clone());
        let host = match result {
            Ok(host) => Arc::new(host),
            Err(mut error) => {
                if let Some(host) = error.retained.take() {
                    let _ = self.tx.send(Event::Host(Arc::new(*host)));
                } else {
                    let _ = self.tx.send(Event::HostReleased);
                }
                return Err(error.to_string());
            }
        };
        self.tx
            .send(Event::Host(host.clone()))
            .map_err(|e| e.to_string())?;
        self.bridge = Some(host.clone());
        Ok(host)
    }
    fn inventory(
        &self,
        bridge: &Bridge,
        phase: CheckPhase,
    ) -> std::result::Result<Inventory, String> {
        self.phase(phase, "enumerating_input_membership");
        let call = |command: &str, parent: Option<&str>, payload: Value, signal: &AtomicBool| {
            sdk::call(bridge, &self.resources, command, parent, payload, signal)
        };
        let inventory = inventory::collect(
            std::path::Path::new(&self.config.capture.checkout_root),
            std::path::Path::new(&self.config.capture.compiler_path),
            std::path::Path::new(
                self.config
                    .capture
                    .catalog_path
                    .as_deref()
                    .ok_or("catalog unavailable")?,
            ),
            &call,
            &self.cancel,
        )?;
        self.phase(phase, "verifying_captured_bytes");
        Ok(inventory)
    }
    fn bind(
        &self,
        capture: Capture,
        expected: Option<String>,
        hint: u64,
    ) -> std::result::Result<std::result::Result<CheckTicket, Refusal>, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Event::Captured {
                operation: self.operation.clone(),
                capture,
                hint,
                expected,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    fn current_hint(&self) -> std::result::Result<u64, String> {
        let (tx, rx) = mpsc::channel();
        self.tx.send(Event::Hint(tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())
    }
    pub(super) fn bind_current(
        &self,
        captured: Capture,
        expected: Option<String>,
        inventory: &capture::InventoryProvider<'_>,
    ) -> std::result::Result<CheckTicket, String> {
        self.bind_current_at(captured, expected, inventory, self.hint)
    }
    fn bind_current_at(
        &self,
        captured: Capture,
        expected: Option<String>,
        inventory: &capture::InventoryProvider<'_>,
        hint: u64,
    ) -> std::result::Result<CheckTicket, String> {
        let first = self.bind(captured.clone(), expected.clone(), hint)?;
        if first != Err(Refusal::CaptureUnconfirmed) {
            return first.map_err(|e| format!("{e:?}"));
        }
        // A watch hint can arrive after its bytes were already read. Confirm
        // against a fresh hint serial instead of treating that hint as failure.
        let hint = self.current_hint()?;
        if !capture::is_current_with_phases(&captured, inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::Capturing, phase)
        }) {
            return Err("captured inputs changed while confirming a watch hint".into());
        }
        self.bind(captured, expected, hint)?
            .map_err(|e| format!("{e:?}"))
    }
    fn phase(&self, phase: CheckPhase, subphase: &str) {
        let _ = self
            .tx
            .send(Event::Phase(self.operation.clone(), phase, subphase.into()));
    }
    fn prepare(
        &self,
        bridge: &Bridge,
        ticket: CheckTicket,
        captured: Capture,
        artifact: Value,
        bytes: Vec<u8>,
        inventory: &capture::InventoryProvider<'_>,
    ) -> std::result::Result<(), String> {
        self.tx
            .send(Event::Retain(
                captured.clone(),
                CompileResult::Artifact {
                    artifact: artifact.clone(),
                    artifact_bytes: bytes.clone(),
                },
            ))
            .map_err(|e| e.to_string())?;
        self.phase(CheckPhase::PreparingPreview, "confirming_candidate_inputs");
        // Source checks and help loading can outlive a notification hint. Bind
        // the same verified bytes again before the authoritative allocation gate.
        let ticket = self.bind_current_at(
            captured.clone(),
            Some(ticket.revision.clone()),
            inventory,
            ticket.hint,
        )?;
        self.phase(CheckPhase::PreparingPreview, "preparing_runtime");
        let gateway = Gateway::bind().map_err(|e| e.to_string())?;
        let origin = gateway.origin().to_owned();
        let id = request_id("generation");
        let mut payloads = Payloads::new()?;
        let artifact_ref = payloads.write(&bytes)?;
        let capture_ref = payloads.json(&captured)?;
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Event::Candidate {
                ticket: ticket.clone(),
                id: id.clone(),
                gateway,
                payloads,
                reply: tx,
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())??;
        let _ = (artifact_ref, capture_ref);
        let call = |command: &str, parent: Option<&str>, payload: Value, signal: &AtomicBool| {
            sdk::call(bridge, &self.resources, command, parent, payload, signal)
        };
        let persistence = preview::default_state_root()?;
        let prepared = preview::prepare(
            &captured,
            &artifact,
            &bytes,
            &id,
            &origin,
            Some(&persistence),
            self.config.preview_roles.as_ref().unwrap_or(&json!({})),
            &call,
            &self.cancel,
        )?;
        let backend = prepared.backend.clone();
        let recipe = retain_runtime_recipe(&prepared, &captured, &ticket.revision, &id, &bytes)?;
        self.phase(CheckPhase::PreparingPreview, "verifying_publication_inputs");
        let hint = self.current_hint()?;
        if !capture::is_current_with_phases(&captured, inventory, &self.cancel, &|phase| {
            self.phase(CheckPhase::PreparingPreview, phase)
        }) {
            self.tx
                .send(Event::Superseded(self.operation.clone()))
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.tx
            .send(Event::Prepared {
                ticket,
                id,
                backend,
                capture: captured,
                hint,
                recipe,
            })
            .map_err(|e| e.to_string())
    }
}
