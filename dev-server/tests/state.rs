use can_dev_server::{model::*, state::*};

fn state() -> SessionState {
    let mut s = SessionState::new(
        "session".into(),
        "App".into(),
        "/project/App.can".into(),
        CheckMode::Manual,
    );
    s.control_ready().unwrap();
    s
}
fn inputs(n: u32) -> Inputs {
    Inputs {
        source_revision: format!("source{n}"),
        digest: format!("all{n}"),
    }
}
fn begin(s: &mut SessionState, n: u32) -> CheckTicket {
    let id = s.begin_check(10).unwrap();
    s.observe_inputs(inputs(n), s.hint()).unwrap();
    s.bind_capture(&id, None).unwrap()
}
fn ready(s: &mut SessionState, t: &CheckTicket, id: &str) {
    s.allocate(t, id.into(), "http://127.0.0.1:1234".into())
        .unwrap();
    s.runtime_ready(id, &t.operation).unwrap();
}
fn serving(s: &mut SessionState) {
    let t = begin(s, 1);
    ready(s, &t, "generation1");
    s.publish(&t, "generation1", 30).unwrap();
}

#[test]
fn owner_control_is_not_application_readiness() {
    let s = state().snapshot();
    assert_eq!(s.lifecycle, Lifecycle::Running);
    assert_eq!(s.preview.availability, Availability::Unavailable);
    assert!(s.admission.check);
    assert!(!s.admission.open);
}

#[test]
fn terminal_result_does_not_release_a_still_running_job() {
    let mut s = state();
    let t = begin(&mut s, 1);
    s.job_started();
    s.finish(
        &t.operation,
        SourceResult::Errors,
        PreviewResult::Unavailable,
        None,
        40,
    );
    assert!(!s.snapshot().admission.check);
    assert_eq!(s.begin_check(50), Err(Refusal::Busy));
    s.job_joined();
    assert!(s.snapshot().admission.check);
}

#[test]
fn identical_dirty_capture_confirms_without_new_revision() {
    let mut s = state();
    serving(&mut s);
    s.dirty();
    assert_eq!(s.snapshot().preview.freshness, Freshness::Unconfirmed);
    assert_eq!(s.observe_inputs(inputs(1), s.hint()).unwrap(), "r1");
    assert_eq!(s.snapshot().preview.freshness, Freshness::Current);
    let mut producer_changed = inputs(1);
    producer_changed.digest = "new compiler".into();
    assert_eq!(s.observe_inputs(producer_changed, s.hint()).unwrap(), "r2");
    assert_eq!(s.snapshot().source_revision.as_deref(), Some("source1"));
    assert_eq!(s.snapshot().preview.freshness, Freshness::Older);
}

#[test]
fn capture_after_new_hint_cannot_confirm_currency() {
    let mut s = state();
    serving(&mut s);
    let hint = s.hint();
    s.dirty();
    s.observe_inputs(inputs(1), hint).unwrap();
    assert_eq!(s.snapshot().capture, CaptureState::Unconfirmed);
}

#[test]
fn errors_keep_old_preview_and_immutable_operation_revision() {
    let mut s = state();
    serving(&mut s);
    let t = begin(&mut s, 2);
    s.observe_inputs(inputs(3), s.hint()).unwrap();
    s.finish(
        &t.operation,
        SourceResult::Errors,
        PreviewResult::Unavailable,
        Some("expected expression".into()),
        40,
    );
    let o = s.snapshot();
    assert_eq!(o.revision.as_deref(), Some("r3"));
    assert_eq!(o.last_outcome.unwrap().revision.as_deref(), Some("r2"));
    assert_eq!(o.preview.revision.as_deref(), Some("r1"));
    assert_eq!(o.preview.freshness, Freshness::Older);
    assert_eq!(o.preview.availability, Availability::Serving);
}

#[test]
fn failed_prepare_retains_handle_and_blocks_growth_until_release() {
    let mut s = state();
    serving(&mut s);
    let t = begin(&mut s, 2);
    s.allocate(&t, "candidate".into(), "http://127.0.0.1:2345".into())
        .unwrap();
    s.retire("candidate", Some("partial prepare; release failed".into()))
        .unwrap();
    s.finish(
        &t.operation,
        SourceResult::Valid,
        PreviewResult::Failed,
        Some("prepare failed".into()),
        40,
    );
    assert_eq!(s.begin_check(50), Err(Refusal::CleanupRequired));
    assert!(s.snapshot().admission.open);
    assert!(s.snapshot().admission.retry_cleanup);
    s.released("candidate").unwrap();
    assert!(s.snapshot().admission.check);
    assert_eq!(s.snapshot().preview.build.as_deref(), Some("generation1"));
}

#[test]
fn superseded_ready_candidate_cannot_publish_or_erase_outcome() {
    let mut s = state();
    serving(&mut s);
    let t = begin(&mut s, 2);
    ready(&mut s, &t, "candidate");
    s.observe_inputs(inputs(3), s.hint()).unwrap();
    assert_eq!(
        s.publish(&t, "candidate", 40),
        Err(Refusal::RevisionConflict)
    );
    s.retire("candidate", None).unwrap();
    s.finish(
        &t.operation,
        SourceResult::Superseded,
        PreviewResult::Superseded,
        None,
        40,
    );
    let outcome = s.snapshot().last_outcome;
    s.phase(&t.operation, CheckPhase::Publishing, None, 50);
    s.runtime_ready("candidate", &t.operation).unwrap();
    assert_eq!(s.snapshot().last_outcome, outcome);
    assert_eq!(s.cleanup_ids(), ["candidate"]);
}

#[test]
fn changed_then_restored_inputs_still_supersede_earlier_epoch() {
    let mut s = state();
    let t = begin(&mut s, 1);
    ready(&mut s, &t, "candidate");
    s.observe_inputs(inputs(2), s.hint()).unwrap();
    s.observe_inputs(inputs(1), s.hint()).unwrap();
    assert_eq!(
        s.publish(&t, "candidate", 40),
        Err(Refusal::RevisionConflict)
    );
}

#[test]
fn stop_admission_precedes_late_ready_and_requires_actual_release() {
    let mut s = state();
    let t = begin(&mut s, 1);
    s.host_started();
    s.job_started();
    s.allocate(&t, "candidate".into(), "http://127.0.0.1:2345".into())
        .unwrap();
    s.stop(20);
    assert!(!s.snapshot().admission.check);
    assert!(!s.snapshot().admission.open);
    s.runtime_ready("candidate", &t.operation).unwrap();
    assert_eq!(s.publish(&t, "candidate", 30), Err(Refusal::NotRunning));
    assert!(!s.finish_stop(None));
    assert_eq!(s.snapshot().lifecycle, Lifecycle::ShutdownIncomplete);
    s.released("candidate").unwrap();
    s.host_released();
    s.job_joined();
    assert!(!s.finish_stop(None)); // The gateway has not closed yet.
    s.access_closed();
    assert!(s.finish_stop(None));
    assert_eq!(s.snapshot().lifecycle, Lifecycle::Stopped);
    assert_eq!(
        s.snapshot().last_outcome.unwrap().source,
        SourceResult::Cancelled
    );
}

#[test]
fn runtime_crash_is_unavailable_with_retained_cleanup_and_live_control() {
    let mut s = state();
    serving(&mut s);
    s.runtime_lost("generation1", "host connection closed".into())
        .unwrap();
    let o = s.snapshot();
    assert_eq!(o.lifecycle, Lifecycle::Running);
    assert_eq!(o.preview.availability, Availability::Unavailable);
    assert_eq!(s.cleanup_ids(), ["generation1"]);
    assert_eq!(s.begin_check(40), Err(Refusal::CleanupRequired));
}

#[test]
fn promotion_retains_old_generation_and_failure_does_not_undo_selection() {
    let mut s = state();
    serving(&mut s);
    let t = begin(&mut s, 2);
    ready(&mut s, &t, "generation2");
    assert_eq!(
        s.publish(&t, "generation2", 90).unwrap().as_deref(),
        Some("generation1")
    );
    assert_eq!(s.snapshot().last_outcome.unwrap().finished_at, 90);
    s.retire("generation1", Some("retry required".into()))
        .unwrap();
    assert_eq!(s.snapshot().preview.build.as_deref(), Some("generation2"));
    assert!(!s.snapshot().admission.check);
    s.released("generation1").unwrap();
    assert!(s.snapshot().admission.check);
}

#[test]
fn expected_revision_refusal_preserves_previous_terminal_outcome() {
    let mut s = state();
    serving(&mut s);
    let previous = s.snapshot().last_outcome;
    let op = s.begin_check(40).unwrap();
    s.observe_inputs(inputs(2), s.hint()).unwrap();
    assert_eq!(
        s.bind_capture(&op, Some("r1")),
        Err(Refusal::RevisionConflict)
    );
    s.abandon(&op);
    assert_eq!(s.snapshot().last_outcome, previous);
}

#[test]
fn duplicate_checks_and_candidates_cannot_allocate_more_resources() {
    let mut s = state();
    let t = begin(&mut s, 1);
    assert_eq!(s.begin_check(20), Err(Refusal::Busy));
    ready(&mut s, &t, "candidate");
    assert_eq!(
        s.allocate(&t, "second".into(), "http://127.0.0.1:3".into()),
        Err(Refusal::Busy)
    );
    assert_eq!(
        s.runtime_ready("candidate", "other-op"),
        Err(Refusal::StaleOperation)
    );
    s.dirty();
    assert_eq!(
        s.publish(&t, "candidate", 30),
        Err(Refusal::CaptureUnconfirmed)
    );
}
