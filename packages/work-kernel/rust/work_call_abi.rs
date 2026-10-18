//! Synchronous selected-call ABI for every registered Work-kernel family.
//!
//! This extends the existing Wasm producer (same crate, same binary) with
//! the full selected dispatch in `decisions::call`: one dispatch, two
//! transports (native differential observer and this ABI). Transport
//! discipline mirrors `recovery_scan_abi.rs`: one non-reused call handle,
//! host-supplied UTF-16 text frames, demand/resume phases, and numeric
//! error codes for protocol/allocation failures only.
//!
//! Decision faults (owning name/message/code/scope) travel as DATA in the
//! response frame, never as ABI error codes: a decision refusal is not a
//! transport failure. `ERROR` phase means the host misused the ABI
//! (wrong phase, bad handle, allocation refusal, unparsable request, or an
//! unregistered leaf/fn): those fail visibly per call and never substitute
//! a decision.
//!
//! Panic-freedom: this ABI never catches a panic (traps cannot unwind on
//! the selected target and would poison the instance). Host callbacks
//! therefore arrive as supplied values across resumed phases, never as
//! invoked host code and never as intra-call suspension:
//! - `retry.computeBackoff` dry-runs with a recording RNG. No demand means
//!   the decision is final (exhausted and throw paths consume zero samples,
//!   exactly like the donor); a demand stores the parsed fields and waits
//!   for the one `random.nextUnit()` sample via NEED_SAMPLE.
//! - `every.admitEveryTick` records the full ordered mint sequence with
//!   placeholder ids first. Every demanded id is then minted by the host
//!   through the donor `deriveId` at its original demand position, and one
//!   final run slots them in. Mint order and count match the donor exactly,
//!   including throw paths (mints before the throw are still demanded).
//! - `recovery.planRecoveryScan` stays on its accepted dedicated ABI and is
//!   rejected here (use `can_recovery_*`).
//!
//! Request frame (UTF-16 JSON, ASCII-only by construction):
//! `{"leaf":"rows","fn":"readDispatchRow","args":[...]}` where `args` uses
//! the registered `$bits`/`$u16`/`$entries`/array/null/boolean channels.
//! Response frame: `{"outcome":{"ok":...}|{"throw":...},"randomCalls":n,
//! "deriveCalls":[...]}`.
//!
//! Closed-data profile: scalar params must be channel-correct (strings as
//! text, numbers as bits). Channel violations are host-contract bugs and
//! trap visibly; they never silently decide. This matches the accepted
//! recovery planner profile, which likewise requires string IDs and number
//! facts rather than coercing exotic inputs.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::decisions::{call, every, retry};

const DONE: u32 = 0;
const NEED_REQUEST: u32 = 1;
const NEED_SAMPLE: u32 = 10;
const NEED_ID: u32 = 11;
const ERROR: u32 = 254;
const PROTOCOL: u32 = 100;
const BAD_REQUEST: u32 = 102;

struct BackoffResume {
    attempt: f64,
    first_attempt_at_ms: f64,
    now_ms: f64,
    policy: Option<retry::RetryPolicy>,
}

/// One pending recurrence-id demand, in donor mint order.
type PendingId = (every::U16, every::U16, every::U16, every::U16, f64);

struct EveryResume {
    input: every::EveryTickInput,
    /// Full ordered mint sequence from the recording run.
    triples: Vec<PendingId>,
    supplied: Vec<every::U16>,
    /// Recording-run throw, resolved after its mints are demanded.
    failed: Option<every::EveryError>,
}

struct Call {
    phase: u32,
    error: u32,
    req: Vec<u16>,
    req_ready: bool,
    id: Vec<u16>,
    id_ready: bool,
    result: Vec<u16>,
    backoff: Option<BackoffResume>,
    every: Option<EveryResume>,
}

impl Call {
    fn new() -> Self {
        Self {
            phase: NEED_REQUEST,
            error: 0,
            req: Vec::new(),
            req_ready: false,
            id: Vec::new(),
            id_ready: false,
            result: Vec::new(),
            backoff: None,
            every: None,
        }
    }

    fn fail(&mut self, code: u32) -> u32 {
        self.error = code;
        self.phase = ERROR;
        self.req_ready = false;
        self.id_ready = false;
        ERROR
    }

    fn set_result(&mut self, text: &str) {
        self.result = text.encode_utf16().collect();
    }
}

struct Calls {
    next: Option<u32>,
    calls: HashMap<u32, Call>,
}

thread_local! {
    static CALLS: RefCell<Calls> = RefCell::new(Calls { next: Some(1), calls: HashMap::new() });
}

fn with_call(handle: u32, f: impl FnOnce(&mut Call) -> u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        match calls.calls.get_mut(&handle) {
            Some(call) => f(call),
            None => ERROR,
        }
    })
}

fn decode_request(units: &[u16]) -> Result<serde_json::Value, u32> {
    let text = String::from_utf16(units).map_err(|_| BAD_REQUEST)?;
    if !text.is_ascii() {
        return Err(BAD_REQUEST);
    }
    serde_json::from_str(&text).map_err(|_| BAD_REQUEST)
}

fn leaf_fn(request: &serde_json::Value) -> Result<(&str, &str), u32> {
    let leaf = request
        .get("leaf")
        .and_then(|v| v.as_str())
        .ok_or(BAD_REQUEST)?;
    let fun = request
        .get("fn")
        .and_then(|v| v.as_str())
        .ok_or(BAD_REQUEST)?;
    Ok((leaf, fun))
}

fn outcome_response(
    outcome: serde_json::Value,
    random_calls: u64,
    derive_calls: serde_json::Value,
) -> String {
    serde_json::json!({
        "outcome": outcome,
        "randomCalls": random_calls,
        "deriveCalls": derive_calls,
    })
    .to_string()
}

fn retry_policy(v: &serde_json::Value) -> Option<retry::RetryPolicy> {
    if call::is_absent(v) {
        return None;
    }
    Some(retry::RetryPolicy {
        max_attempts: call::number(call::field(v, "maxAttempts")),
        horizon_ms: call::number(call::field(v, "horizonMs")),
    })
}

/// Recording RNG: notes the demand and answers a dummy so the dry run
/// completes without host input. Pure decisions run deterministically, so
/// the resumption with the real sample decides identically.
struct RecordingRng {
    demanded: std::cell::Cell<bool>,
}

impl retry::RandomPort for RecordingRng {
    fn next_unit(&self) -> f64 {
        self.demanded.set(true);
        0.0
    }
}

struct FixedSample {
    sample: f64,
}

impl retry::RandomPort for FixedSample {
    fn next_unit(&self) -> f64 {
        self.sample
    }
}

fn backoff_ok(decision: &retry::BackoffDecision) -> serde_json::Value {
    serde_json::json!({"ok": call::object(vec![
        ("exhausted", serde_json::json!(decision.exhausted)),
        ("delayMs", call::n(decision.delay_ms)),
        ("notBeforeMs", call::n(decision.not_before_ms)),
    ])})
}

fn backoff_fault(e: &retry::PolicyError) -> serde_json::Value {
    let throw = call::fault(&e.name, &e.message, None, None);
    serde_json::json!({"throw": throw["throw"].clone()})
}

/// Parse one `retry.computeBackoff` request into resumable fields.
fn parse_backoff(args: &serde_json::Value) -> Result<BackoffResume, u32> {
    let v = args
        .as_array()
        .ok_or(BAD_REQUEST)?
        .first()
        .ok_or(BAD_REQUEST)?;
    let policy = call::field(v, "policy");
    Ok(BackoffResume {
        attempt: call::number(call::field(v, "attempt")),
        first_attempt_at_ms: call::number(call::field(v, "firstAttemptAtMs")),
        now_ms: call::number(call::field(v, "nowMs")),
        policy: retry_policy(policy),
    })
}

/// Parse one `every.admitEveryTick` request into an owned input.
fn parse_every(args: &serde_json::Value) -> Result<every::EveryTickInput, u32> {
    let v = args
        .as_array()
        .ok_or(BAD_REQUEST)?
        .first()
        .ok_or(BAD_REQUEST)?;
    let scopes = call::field(v, "scopes")
        .as_array()
        .ok_or(BAD_REQUEST)?
        .iter()
        .map(|s| {
            Ok(every::EveryScopeInput {
                scope: every::U16(call::text(call::field(s, "scope"))),
                owner: every::U16(call::text(call::field(s, "owner"))),
            })
        })
        .collect::<Result<Vec<_>, u32>>()?;
    let mut previous_slots = Vec::new();
    for entry in call::field(v, "previousSlots")["$entries"]
        .as_array()
        .ok_or(BAD_REQUEST)?
    {
        let key = every::U16(call::text(&entry[0]));
        let slot = if entry[1].get("$bits").is_some() {
            every::PrevSlot::Num(call::number(&entry[1]))
        } else {
            every::PrevSlot::Other
        };
        previous_slots.push((key, slot));
    }
    Ok(every::EveryTickInput {
        now_ms: call::number(call::field(v, "nowMs")),
        period_ms: call::number(call::field(v, "periodMs")),
        app: every::U16(call::text(call::field(v, "app"))),
        handler: every::U16(call::text(call::field(v, "handler"))),
        scopes,
        previous_slots,
    })
}

fn every_fault(e: &every::EveryError) -> serde_json::Value {
    let throw = call::fault(
        &e.name,
        &e.message,
        e.code.as_deref(),
        e.scope.as_ref().map(|s| s.0.as_slice()),
    );
    serde_json::json!({"throw": throw["throw"].clone()})
}

fn derive_calls_json(calls: &[PendingId]) -> serde_json::Value {
    calls
        .iter()
        .map(|(app, handler, scope, owner, slot)| {
            call::object(vec![
                ("app", call::string(&app.0)),
                ("handler", call::string(&handler.0)),
                ("scope", call::string(&scope.0)),
                ("owner", call::string(&owner.0)),
                ("slot", call::n(*slot)),
            ])
        })
        .collect::<Vec<_>>()
        .into()
}

fn every_ok(result: &every::EveryTickResult) -> serde_json::Value {
    serde_json::json!({"ok": call::object(vec![
        ("slot", call::n(result.slot)),
        ("slotStartMs", call::n(result.slot_start_ms)),
        ("admitted", result.admitted.iter().map(|o| call::object(vec![
            ("occurrenceId", call::string(&o.occurrence_id.0)),
            ("app", call::string(&o.app.0)),
            ("handler", call::string(&o.handler.0)),
            ("scope", call::string(&o.scope.0)),
            ("owner", call::string(&o.owner.0)),
            ("slot", call::n(o.slot)),
        ])).collect::<Vec<_>>().into()),
    ])})
}

fn need_sample_json() -> String {
    serde_json::json!({"need": "sample"}).to_string()
}

fn need_id_json(triple: &PendingId) -> String {
    call::object(vec![
        (
            "need",
            call::string(&"id".encode_utf16().collect::<Vec<_>>()),
        ),
        ("app", call::string(&triple.0 .0)),
        ("handler", call::string(&triple.1 .0)),
        ("scope", call::string(&triple.2 .0)),
        ("owner", call::string(&triple.3 .0)),
        ("slot", call::n(triple.4)),
    ])
    .to_string()
}

/// Recording derive: notes every mint in donor order and answers a
/// placeholder. Admission never branches on the id bytes, so the recording
/// run follows the exact donor path; placeholders never reach a response.
fn record_admission(
    input: &every::EveryTickInput,
) -> (
    Result<every::EveryTickResult, every::EveryError>,
    Vec<PendingId>,
) {
    let triples = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let owned = std::rc::Rc::clone(&triples);
    // `DeriveId` is `dyn Fn` with a `'static` bound, so the log is owned.
    let derive = move |app: &every::U16,
                       handler: &every::U16,
                       scope: &every::U16,
                       owner: &every::U16,
                       slot: f64|
          -> every::U16 {
        owned.borrow_mut().push((
            app.clone(),
            handler.clone(),
            scope.clone(),
            owner.clone(),
            slot,
        ));
        every::U16(vec![])
    };
    let outcome = every::admit_every_tick(input, &derive);
    drop(derive);
    let triples = std::rc::Rc::try_unwrap(triples)
        .map(|cell| cell.into_inner())
        .unwrap_or_default();
    (outcome, triples)
}

/// Final admission with host-minted ids slotted in donor order.
fn finish_admission(
    input: &every::EveryTickInput,
    supplied: &[every::U16],
) -> (
    Result<every::EveryTickResult, every::EveryError>,
    Vec<PendingId>,
) {
    let triples = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let supplied = supplied.to_vec();
    let owned = std::rc::Rc::clone(&triples);
    let replay = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let replay_in = std::rc::Rc::clone(&replay);
    let derive = move |app: &every::U16,
                       handler: &every::U16,
                       scope: &every::U16,
                       owner: &every::U16,
                       slot: f64|
          -> every::U16 {
        owned.borrow_mut().push((
            app.clone(),
            handler.clone(),
            scope.clone(),
            owner.clone(),
            slot,
        ));
        let at = replay_in.get();
        replay_in.set(at + 1);
        supplied[at].clone()
    };
    let outcome = every::admit_every_tick(input, &derive);
    drop(derive);
    let triples = std::rc::Rc::try_unwrap(triples)
        .map(|cell| cell.into_inner())
        .unwrap_or_default();
    (outcome, triples)
}

#[no_mangle]
pub extern "C" fn can_work_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn can_work_create() -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(handle) = calls.next else {
            return 0;
        };
        if calls.calls.try_reserve(1).is_err() {
            return 0;
        }
        calls.next = handle.checked_add(1);
        calls.calls.insert(handle, Call::new());
        handle
    })
}

#[no_mangle]
pub extern "C" fn can_work_free(handle: u32) -> u32 {
    CALLS.with(|calls| u32::from(calls.borrow_mut().calls.remove(&handle).is_some()))
}

#[no_mangle]
pub extern "C" fn can_work_demand(handle: u32) -> u32 {
    with_call(handle, |call| call.phase)
}

#[no_mangle]
pub extern "C" fn can_work_error_code(handle: u32) -> u32 {
    CALLS.with(|calls| {
        calls
            .borrow()
            .calls
            .get(&handle)
            .map_or(PROTOCOL, |call| call.error)
    })
}

#[no_mangle]
pub extern "C" fn can_work_request_prepare(handle: u32, len: u32) -> u32 {
    let result = with_call(handle, |call| {
        if call.phase != NEED_REQUEST {
            call.fail(PROTOCOL);
            return 0;
        }
        let Ok(len) = usize::try_from(len) else {
            call.fail(PROTOCOL);
            return 0;
        };
        if len > (isize::MAX as usize) / std::mem::size_of::<u16>() {
            call.fail(PROTOCOL);
            return 0;
        }
        call.req.clear();
        call.req_ready = false;
        if call.req.try_reserve(len).is_err() {
            call.fail(PROTOCOL);
            return 0;
        }
        call.req.resize(len, 0);
        call.req_ready = true;
        1
    });
    u32::from(result == 1)
}

#[no_mangle]
pub extern "C" fn can_work_request_ptr(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !call.req_ready {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.req.as_mut_ptr() as usize) {
            Ok(pointer) => pointer,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_work_request_len(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !call.req_ready {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.req.len()) {
            Ok(len) => len,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}

/// Parse the request frame and run it. Pure decisions complete here;
/// backoff waits for the RNG sample and admission waits per mint.
#[no_mangle]
pub extern "C" fn can_work_request_reply(handle: u32) -> u32 {
    with_call(handle, |call| {
        if call.phase != NEED_REQUEST || !call.req_ready {
            return call.fail(PROTOCOL);
        }
        call.req_ready = false;
        let units = std::mem::take(&mut call.req);
        let request = match decode_request(&units) {
            Ok(v) => v,
            Err(code) => return call.fail(code),
        };
        let (leaf, fun) = match leaf_fn(&request) {
            Ok(pair) => pair,
            Err(code) => return call.fail(code),
        };
        if (leaf, fun) == ("recovery", "planRecoveryScan") {
            // Accepted dedicated ABI owns this planner; no second route.
            return call.fail(BAD_REQUEST);
        }
        if !call::is_selected_call(leaf, fun) {
            return call.fail(BAD_REQUEST);
        }
        let args = request
            .get("args")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if (leaf, fun) == ("retry", "computeBackoff") {
            let resume = match parse_backoff(&args) {
                Ok(v) => v,
                Err(code) => return call.fail(code),
            };
            let probe = RecordingRng {
                demanded: std::cell::Cell::new(false),
            };
            let input = retry::BackoffInput {
                attempt: resume.attempt,
                first_attempt_at_ms: resume.first_attempt_at_ms,
                now_ms: resume.now_ms,
                policy: resume.policy.clone(),
                random: probe,
            };
            // The dry run completes without host input: validation faults
            // and exhausted paths demand nothing (zero samples, like the
            // donor); only a live schedule suspends for the sample.
            match retry::compute_backoff(&input) {
                Ok(decision) if !input.random.demanded.get() => {
                    let response =
                        outcome_response(backoff_ok(&decision), 0, serde_json::json!([]));
                    call.set_result(&response);
                    call.phase = DONE;
                }
                Ok(_) => {
                    call.backoff = Some(resume);
                    call.set_result(&need_sample_json());
                    call.phase = NEED_SAMPLE;
                }
                Err(e) => {
                    let response = outcome_response(backoff_fault(&e), 0, serde_json::json!([]));
                    call.set_result(&response);
                    call.phase = DONE;
                }
            }
            return call.phase;
        }
        if (leaf, fun) == ("every", "admitEveryTick") {
            let input = match parse_every(&args) {
                Ok(v) => v,
                Err(code) => return call.fail(code),
            };
            let (outcome, triples) = record_admission(&input);
            match outcome {
                Ok(result) if triples.is_empty() => {
                    let response =
                        outcome_response(every_ok(&result), 0, derive_calls_json(&triples));
                    call.set_result(&response);
                    call.phase = DONE;
                }
                Err(e) if triples.is_empty() => {
                    let response =
                        outcome_response(every_fault(&e), 0, derive_calls_json(&triples));
                    call.set_result(&response);
                    call.phase = DONE;
                }
                // Mints (before a throw included) are demanded in order.
                Ok(_) | Err(_) => {
                    let failed = outcome.err();
                    let first = triples[0].clone();
                    call.every = Some(EveryResume {
                        input,
                        triples,
                        supplied: Vec::new(),
                        failed,
                    });
                    call.set_result(&need_id_json(&first));
                    call.phase = NEED_ID;
                }
            }
            return call.phase;
        }
        // Registered shared dispatch for every other selected function.
        // `is_selected_call` admitted this pair, so `observe` cannot hit
        // its unregistered arm; remaining panics are host-contract bugs.
        let observation = call::observe(&serde_json::json!({
            "key": "work-call",
            "leaf": leaf,
            "fn": fun,
            "args": args,
        }));
        let outcome = observation
            .get("outcome")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let random_calls = observation
            .get("randomCalls")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let response = outcome_response(outcome, random_calls, serde_json::json!([]));
        call.set_result(&response);
        call.phase = DONE;
        call.phase
    })
}

/// Supply the demanded RNG sample and finish the backoff decision.
#[no_mangle]
pub extern "C" fn can_work_number_reply(handle: u32, value: f64) -> u32 {
    with_call(handle, |call| {
        if call.phase != NEED_SAMPLE {
            return call.fail(PROTOCOL);
        }
        let Some(resume) = call.backoff.take() else {
            return call.fail(PROTOCOL);
        };
        let input = retry::BackoffInput {
            attempt: resume.attempt,
            first_attempt_at_ms: resume.first_attempt_at_ms,
            now_ms: resume.now_ms,
            policy: resume.policy,
            random: FixedSample { sample: value },
        };
        match retry::compute_backoff(&input) {
            Ok(decision) => {
                let response = outcome_response(backoff_ok(&decision), 1, serde_json::json!([]));
                call.set_result(&response);
                call.phase = DONE;
            }
            Err(e) => {
                let response = outcome_response(backoff_fault(&e), 1, serde_json::json!([]));
                call.set_result(&response);
                call.phase = DONE;
            }
        }
        call.phase
    })
}

#[no_mangle]
pub extern "C" fn can_work_id_prepare(handle: u32, len: u32) -> u32 {
    let result = with_call(handle, |call| {
        if call.phase != NEED_ID {
            call.fail(PROTOCOL);
            return 0;
        }
        let Ok(len) = usize::try_from(len) else {
            call.fail(PROTOCOL);
            return 0;
        };
        if len > (isize::MAX as usize) / std::mem::size_of::<u16>() {
            call.fail(PROTOCOL);
            return 0;
        }
        call.id.clear();
        call.id_ready = false;
        if call.id.try_reserve(len).is_err() {
            call.fail(PROTOCOL);
            return 0;
        }
        call.id.resize(len, 0);
        call.id_ready = true;
        1
    });
    u32::from(result == 1)
}

#[no_mangle]
pub extern "C" fn can_work_id_ptr(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !call.id_ready {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.id.as_mut_ptr() as usize) {
            Ok(pointer) => pointer,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_work_id_len(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !call.id_ready {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.id.len()) {
            Ok(len) => len,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}

/// Supply one minted recurrence id and advance. When the sequence is
/// complete the final run slots every id in donor order; a recorded throw
/// resolves without re-running (its mints were still demanded).
#[no_mangle]
pub extern "C" fn can_work_id_reply(handle: u32) -> u32 {
    with_call(handle, |call| {
        if call.phase != NEED_ID || !call.id_ready {
            return call.fail(PROTOCOL);
        }
        call.id_ready = false;
        let minted = every::U16(std::mem::take(&mut call.id));
        let Some(resume) = call.every.as_mut() else {
            return call.fail(PROTOCOL);
        };
        resume.supplied.push(minted);
        if resume.supplied.len() < resume.triples.len() {
            let triple = resume.triples[resume.supplied.len()].clone();
            call.set_result(&need_id_json(&triple));
            call.phase = NEED_ID;
            return call.phase;
        }
        let Some(resume) = call.every.take() else {
            return call.fail(PROTOCOL);
        };
        if let Some(e) = resume.failed {
            // The recording run already threw after these mints: the host
            // minted the exact donor sequence; resolve the fault.
            let response = outcome_response(every_fault(&e), 0, derive_calls_json(&resume.triples));
            call.set_result(&response);
            call.phase = DONE;
            return call.phase;
        }
        let (outcome, calls) = finish_admission(&resume.input, &resume.supplied);
        match outcome {
            Ok(result) => {
                let response = outcome_response(every_ok(&result), 0, derive_calls_json(&calls));
                call.set_result(&response);
                call.phase = DONE;
            }
            Err(e) => {
                let response = outcome_response(every_fault(&e), 0, derive_calls_json(&calls));
                call.set_result(&response);
                call.phase = DONE;
            }
        }
        call.phase
    })
}

/// Read the response frame: the final outcome at DONE, or the pending
/// demand description (`{"need":"sample"}` / `{"need":"id",...}`) at
/// NEED_SAMPLE / NEED_ID.
#[no_mangle]
pub extern "C" fn can_work_result_ptr(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !matches!(call.phase, DONE | NEED_SAMPLE | NEED_ID) {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.result.as_mut_ptr() as usize) {
            Ok(pointer) => pointer,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_work_result_len(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else {
            return 0;
        };
        if !matches!(call.phase, DONE | NEED_SAMPLE | NEED_ID) {
            call.fail(PROTOCOL);
            return 0;
        }
        match u32::try_from(call.result.len()) {
            Ok(len) => len,
            Err(_) => {
                call.fail(PROTOCOL);
                0
            }
        }
    })
}
