//! The single writer of session lifecycle, operation and publication facts.
//! Effects execute outside this value and return identified facts. A stale
//! result can retain an allocation, but cannot publish a generation.
use crate::model::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inputs {
    pub source_revision: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckTicket {
    pub operation: String,
    pub revision: String,
    pub inputs: Inputs,
    pub hint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NotRunning,
    Busy,
    CleanupRequired,
    RestartRequired,
    StaleOperation,
    RevisionConflict,
    CaptureUnconfirmed,
    UnknownGeneration,
    NotReady,
}

#[derive(Debug, Clone)]
struct Generation {
    operation: String,
    revision: String,
    origin: String,
    ready: bool,
    available: bool,
    cleanup: bool,
    error: Option<String>,
}

pub struct SessionState {
    observation: Snapshot,
    inputs: Option<Inputs>,
    epoch: u64,
    hint: u64,
    operation_serial: u64,
    generations: BTreeMap<String, Generation>,
    serving: Option<String>,
    restart_reason: Option<String>,
    owner_jobs: usize,
    host_released: bool,
    host_cleanup_required: bool,
    access_closed: bool,
}

impl SessionState {
    pub fn new(session: String, app: String, source_path: String, mode: CheckMode) -> Self {
        Self {
            observation: Snapshot {
                schema: "can.dev.observation.v1".into(),
                session,
                sequence: 0,
                app,
                source_path,
                mode,
                lifecycle: Lifecycle::Starting,
                revision: None,
                source_revision: None,
                capture: CaptureState::Unconfirmed,
                operation: None,
                last_outcome: None,
                preview: PreviewObservation {
                    availability: Availability::Unavailable,
                    revision: None,
                    build: None,
                    origin: None,
                    freshness: Freshness::NotApplicable,
                },
                admission: Admission {
                    check: false,
                    open: false,
                    retry_cleanup: false,
                    reasons: vec![],
                },
                shutdown_error: None,
            },
            inputs: None,
            epoch: 0,
            hint: 0,
            operation_serial: 0,
            generations: BTreeMap::new(),
            serving: None,
            restart_reason: None,
            owner_jobs: 0,
            host_released: true,
            host_cleanup_required: false,
            access_closed: true,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.observation.clone()
    }
    pub fn hint(&self) -> u64 {
        self.hint
    }

    fn changed(&mut self) {
        self.observation.sequence += 1;
        self.project_preview();
        self.project_admission();
    }

    pub fn control_ready(&mut self) -> Result<(), Refusal> {
        if self.observation.lifecycle != Lifecycle::Starting {
            return Err(Refusal::NotRunning);
        }
        self.observation.lifecycle = Lifecycle::Running;
        self.changed();
        Ok(())
    }

    fn require_running(&self) -> Result<(), Refusal> {
        if self.observation.lifecycle != Lifecycle::Running {
            return Err(Refusal::NotRunning);
        }
        Ok(())
    }

    fn require_check(&self) -> Result<(), Refusal> {
        self.require_running()?;
        if self.cleanup_required() {
            return Err(Refusal::CleanupRequired);
        }
        if self.restart_reason.is_some() {
            return Err(Refusal::RestartRequired);
        }
        if self.observation.operation.is_some() {
            return Err(Refusal::Busy);
        }
        if self.owner_jobs > 0 {
            return Err(Refusal::Busy);
        }
        Ok(())
    }

    /// File events express uncertainty. Only captured identities advance epoch.
    pub fn dirty(&mut self) {
        if self.require_running().is_err() {
            return;
        }
        self.hint += 1;
        self.observation.capture = CaptureState::Unconfirmed;
        self.changed();
    }

    pub fn observe_inputs(&mut self, inputs: Inputs, hint: u64) -> Result<String, Refusal> {
        self.require_running()?;
        if self.inputs.as_ref() != Some(&inputs) {
            self.epoch += 1;
            self.observation.revision = Some(format!("r{}", self.epoch));
            self.observation.source_revision = Some(inputs.source_revision.clone());
            self.inputs = Some(inputs);
        }
        self.observation.capture = if hint == self.hint {
            CaptureState::Confirmed
        } else {
            CaptureState::Unconfirmed
        };
        self.changed();
        Ok(self
            .observation
            .revision
            .clone()
            .expect("observed inputs have revision"))
    }

    pub fn capture_incomplete(&mut self) {
        if self.require_running().is_err() {
            return;
        }
        self.observation.capture = CaptureState::Incomplete;
        self.changed();
    }

    pub fn begin_check(&mut self, now: u64) -> Result<String, Refusal> {
        self.require_check()?;
        self.operation_serial += 1;
        let id = format!("check-{}", self.operation_serial);
        self.observation.operation = Some(Operation {
            id: id.clone(),
            revision: None,
            phase: CheckPhase::Capturing,
            subphase: None,
            started_at: now,
            phase_started_at: now,
        });
        self.changed();
        Ok(id)
    }

    fn active(&self, operation: &str) -> bool {
        self.observation
            .operation
            .as_ref()
            .is_some_and(|o| o.id == operation)
    }

    /// Expected revision is tested after recapture, without erasing prior outcome.
    pub fn bind_capture(
        &mut self,
        operation: &str,
        expected: Option<&str>,
    ) -> Result<CheckTicket, Refusal> {
        self.require_running()?;
        if !self.active(operation) {
            return Err(Refusal::StaleOperation);
        }
        if self.observation.capture != CaptureState::Confirmed {
            return Err(Refusal::CaptureUnconfirmed);
        }
        let revision = self
            .observation
            .revision
            .clone()
            .ok_or(Refusal::CaptureUnconfirmed)?;
        if expected.is_some_and(|value| value != revision) {
            return Err(Refusal::RevisionConflict);
        }
        self.observation.operation.as_mut().unwrap().revision = Some(revision.clone());
        self.changed();
        Ok(CheckTicket {
            operation: operation.into(),
            revision,
            inputs: self.inputs.clone().unwrap(),
            hint: self.hint,
        })
    }

    pub fn phase(
        &mut self,
        operation: &str,
        phase: CheckPhase,
        subphase: Option<String>,
        now: u64,
    ) {
        if self.require_running().is_err() || !self.active(operation) {
            return;
        }
        let op = self.observation.operation.as_mut().unwrap();
        op.phase = phase;
        op.subphase = subphase;
        op.phase_started_at = now;
        self.changed();
    }

    pub fn abandon(&mut self, operation: &str) {
        if !self.active(operation) {
            return;
        }
        self.observation.operation = None;
        self.changed();
    }

    /// Register before asking the host to allocate. Failed/uncertain prepare
    /// retains this handle and blocks growth until confirmed release.
    pub fn allocate(
        &mut self,
        ticket: &CheckTicket,
        id: String,
        origin: String,
    ) -> Result<(), Refusal> {
        self.current_ticket(ticket)?;
        if self.cleanup_required() {
            return Err(Refusal::CleanupRequired);
        }
        if self.generations.contains_key(&id) {
            return Err(Refusal::Busy);
        }
        if self
            .generations
            .keys()
            .any(|id| self.serving.as_ref() != Some(id))
        {
            return Err(Refusal::Busy);
        }
        self.generations.insert(
            id,
            Generation {
                operation: ticket.operation.clone(),
                revision: ticket.revision.clone(),
                origin,
                ready: false,
                available: false,
                cleanup: false,
                error: None,
            },
        );
        self.access_closed = false;
        self.changed();
        Ok(())
    }

    fn current_ticket(&self, ticket: &CheckTicket) -> Result<(), Refusal> {
        self.require_running()?;
        if !self.active(&ticket.operation) {
            return Err(Refusal::StaleOperation);
        }
        if self.observation.capture != CaptureState::Confirmed {
            return Err(Refusal::CaptureUnconfirmed);
        }
        if self.inputs.as_ref() != Some(&ticket.inputs)
            || self.observation.revision.as_ref() != Some(&ticket.revision)
        {
            return Err(Refusal::RevisionConflict);
        }
        Ok(())
    }

    /// A fresh capture can finish against its existing live generation. This
    /// never selects, reallocates or revives a generation from an earlier epoch.
    pub fn reuse_serving(&mut self, ticket: &CheckTicket, cancelled: bool, now: u64) -> bool {
        if cancelled
            || self.current_ticket(ticket).is_err()
            || ticket.hint != self.hint
            || self.cleanup_required()
            || self.restart_reason.is_some()
            || self.generations.len() != 1
        {
            return false;
        }
        let Some(generation) = self
            .serving
            .as_ref()
            .and_then(|id| self.generations.get(id))
        else {
            return false;
        };
        if generation.revision != ticket.revision
            || !generation.ready
            || !generation.available
            || generation.cleanup
        {
            return false;
        }
        self.finish(
            &ticket.operation,
            SourceResult::Valid,
            PreviewResult::Ready,
            None,
            now,
        );
        true
    }

    /// Correlation is mandatory; late readiness still leaves ownership retained.
    pub fn runtime_ready(&mut self, id: &str, operation: &str) -> Result<(), Refusal> {
        let g = self
            .generations
            .get_mut(id)
            .ok_or(Refusal::UnknownGeneration)?;
        if g.operation != operation {
            return Err(Refusal::StaleOperation);
        }
        if self.serving.as_deref() == Some(id) || g.cleanup {
            return Ok(());
        }
        g.ready = true;
        g.available = true;
        if self.observation.lifecycle != Lifecycle::Running || !self.active(operation) {
            self.generations.get_mut(id).unwrap().cleanup = true;
        }
        self.changed();
        Ok(())
    }

    /// Call at the synchronous gateway selection fence, after final recapture.
    /// The returned old generation is retired only after selection succeeds.
    pub fn publish(
        &mut self,
        ticket: &CheckTicket,
        id: &str,
        now: u64,
    ) -> Result<Option<String>, Refusal> {
        self.current_ticket(ticket)?;
        if self.cleanup_required() {
            return Err(Refusal::CleanupRequired);
        }
        if self.restart_reason.is_some() {
            return Err(Refusal::RestartRequired);
        }
        let g = self.generations.get(id).ok_or(Refusal::UnknownGeneration)?;
        if g.operation != ticket.operation || g.revision != ticket.revision {
            return Err(Refusal::StaleOperation);
        }
        if !g.ready || !g.available || g.cleanup {
            return Err(Refusal::NotReady);
        }
        let retired = self.serving.replace(id.into());
        if let Some(old) = &retired {
            self.generations.get_mut(old).unwrap().cleanup = true;
        }
        self.finish(
            &ticket.operation,
            SourceResult::Valid,
            PreviewResult::Ready,
            None,
            now,
        );
        Ok(retired)
    }

    pub fn finish(
        &mut self,
        operation: &str,
        source: SourceResult,
        preview: PreviewResult,
        reason: Option<String>,
        now: u64,
    ) {
        if !self.active(operation) {
            return;
        }
        let op = self.observation.operation.take().unwrap();
        for (id, g) in &mut self.generations {
            if g.operation == operation && self.serving.as_ref() != Some(id) {
                g.cleanup = true;
            }
        }
        self.observation.last_outcome = Some(Outcome {
            id: op.id,
            revision: op.revision,
            source,
            preview,
            reason,
            started_at: op.started_at,
            finished_at: now,
        });
        self.changed();
    }

    pub fn retire(&mut self, id: &str, error: Option<String>) -> Result<(), Refusal> {
        let g = self
            .generations
            .get_mut(id)
            .ok_or(Refusal::UnknownGeneration)?;
        g.cleanup = true;
        g.error = error;
        self.changed();
        Ok(())
    }

    /// Endpoint loss changes availability, never resource ownership/lifecycle.
    pub fn runtime_lost(&mut self, id: &str, error: String) -> Result<(), Refusal> {
        let g = self
            .generations
            .get_mut(id)
            .ok_or(Refusal::UnknownGeneration)?;
        g.available = false;
        g.cleanup = true;
        g.error = Some(error);
        self.changed();
        Ok(())
    }

    pub fn released(&mut self, id: &str) -> Result<(), Refusal> {
        if self.generations.remove(id).is_none() {
            return Err(Refusal::UnknownGeneration);
        }
        if self.serving.as_deref() == Some(id) {
            self.serving = None;
        }
        self.changed();
        Ok(())
    }

    pub fn cleanup_ids(&self) -> Vec<String> {
        self.generations
            .iter()
            .filter(|(_, g)| g.cleanup)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn cleanup_required(&self) -> bool {
        self.host_cleanup_required || self.generations.values().any(|g| g.cleanup)
    }

    pub fn host_lost(&mut self, reason: String) {
        self.host_cleanup_required = true;
        for g in self.generations.values_mut() {
            g.available = false;
            g.cleanup = true;
            g.error = Some(reason.clone());
        }
        self.changed();
    }
    pub fn host_cleanup_required(&self) -> bool {
        self.host_cleanup_required
    }

    pub fn restart_required(&mut self, reason: String) {
        self.restart_reason = Some(reason);
        self.changed();
    }

    pub fn host_started(&mut self) {
        self.host_released = false;
        self.changed();
    }
    pub fn host_released(&mut self) {
        self.host_released = true;
        self.host_cleanup_required = false;
        self.changed();
    }
    pub fn job_started(&mut self) {
        self.owner_jobs += 1;
        self.changed();
    }
    pub fn job_joined(&mut self) {
        self.owner_jobs = self
            .owner_jobs
            .checked_sub(1)
            .expect("joined job was owned");
        self.changed();
    }

    /// This transition must precede acknowledging stop or awaiting any effect.
    pub fn stop(&mut self, now: u64) {
        if self.observation.lifecycle == Lifecycle::Stopped {
            return;
        }
        self.observation.lifecycle = Lifecycle::Stopping;
        self.access_closed = false;
        for g in self.generations.values_mut() {
            g.cleanup = true;
        }
        if let Some(op) = self.observation.operation.clone() {
            self.finish(
                &op.id,
                SourceResult::Cancelled,
                PreviewResult::Unavailable,
                Some("session stopping".into()),
                now,
            );
        }
        self.changed();
    }

    pub fn access_closed(&mut self) {
        self.access_closed = true;
        self.changed();
    }

    /// No acknowledgement or missing endpoint can substitute for joined jobs,
    /// closed access, released generations and verified host/tree retirement.
    pub fn finish_stop(&mut self, failure: Option<String>) -> bool {
        if !matches!(
            self.observation.lifecycle,
            Lifecycle::Stopping | Lifecycle::ShutdownIncomplete
        ) {
            return false;
        }
        let released = self.resources_released();
        self.observation.lifecycle = if released && failure.is_none() {
            Lifecycle::Stopped
        } else {
            Lifecycle::ShutdownIncomplete
        };
        self.observation.shutdown_error =
            (self.observation.lifecycle != Lifecycle::Stopped).then(|| "CLEANUP_FAILED".into());
        self.changed();
        self.observation.lifecycle == Lifecycle::Stopped
    }
    pub fn resources_released(&self) -> bool {
        self.generations.is_empty()
            && self.host_released
            && self.owner_jobs == 0
            && self.access_closed
    }

    fn project_preview(&mut self) {
        let live = self
            .serving
            .as_ref()
            .and_then(|id| self.generations.get(id).map(|g| (id, g)))
            .filter(|(_, g)| g.available && !self.access_closed);
        self.observation.preview = match live {
            Some((id, g)) => PreviewObservation {
                availability: Availability::Serving,
                revision: Some(g.revision.clone()),
                build: Some(id.clone()),
                origin: Some(g.origin.clone()),
                freshness: self.freshness(&g.revision),
            },
            None => PreviewObservation {
                availability: Availability::Unavailable,
                revision: None,
                build: None,
                origin: None,
                freshness: Freshness::NotApplicable,
            },
        };
    }

    fn freshness(&self, revision: &str) -> Freshness {
        if self.observation.capture != CaptureState::Confirmed {
            return Freshness::Unconfirmed;
        }
        if self.observation.revision.as_deref() == Some(revision) {
            Freshness::Current
        } else {
            Freshness::Older
        }
    }

    fn project_admission(&mut self) {
        let running = self.observation.lifecycle == Lifecycle::Running;
        let cleanup = self.cleanup_required();
        let mut reasons = vec![];
        if !running {
            reasons.push("stopping".into());
        }
        if cleanup {
            reasons.push("cleanup_required".into());
        }
        if self.restart_reason.is_some() {
            reasons.push("restart_required".into());
        }
        self.observation.admission = Admission {
            check: running
                && !cleanup
                && self.restart_reason.is_none()
                && self.observation.operation.is_none()
                && self.owner_jobs == 0,
            open: running && self.observation.preview.availability == Availability::Serving,
            retry_cleanup: cleanup || self.observation.lifecycle == Lifecycle::ShutdownIncomplete,
            reasons,
        };
    }
}
