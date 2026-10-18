//! Synchronous recovery-planner demand/resume ABI. The host supplies only
//! demanded reads; this module never invokes a callback or stages an effect.
//! Text is lossless UTF-16 and all storage belongs to one non-reused handle.

use std::cell::RefCell;
use std::collections::HashMap;

const DONE: u32 = 0;
const ERROR: u32 = 254;
const PROTOCOL: u32 = 100;

struct Call {
    phase: u32,
    error: u32,
    text: Vec<u16>,
    text_ready: bool,
    claims: HashMap<Vec<u16>, u32>,
    next_claim: u32,
    selected_claim: u32,
    output: usize,
    lists: [Vec<Vec<u16>>; 7],
    now: f64,
    age: f64,
    attempts: f64,
    failure_now: f64,
    anchor: f64,
}

impl Call {
    fn new() -> Self {
        Self {
            phase: 1, error: 0, text: Vec::new(), text_ready: false,
            claims: HashMap::new(), next_claim: 0, selected_claim: u32::MAX,
            output: 0, lists: std::array::from_fn(|_| Vec::new()),
            now: 0.0, age: 0.0, attempts: 0.0, failure_now: 0.0, anchor: 0.0,
        }
    }

    fn fail(&mut self, code: u32) -> u32 {
        self.error = code;
        self.phase = ERROR;
        self.text_ready = false;
        ERROR
    }

    fn output(&mut self, list: usize) -> u32 {
        self.output = list;
        self.phase = 30;
        self.phase
    }

    fn prepare_text(&mut self, len: u32) -> bool {
        let Ok(len) = usize::try_from(len) else { self.fail(PROTOCOL); return false; };
        if len > (isize::MAX as usize) / std::mem::size_of::<u16>() {
            self.fail(PROTOCOL); return false;
        }
        // Clear first so each exposed pointer describes this exact frame.
        self.text.clear();
        self.text_ready = false;
        if self.text.try_reserve(len).is_err() { self.fail(PROTOCOL); return false; }
        self.text.resize(len, 0);
        self.text_ready = true;
        true
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

#[no_mangle]
pub extern "C" fn can_recovery_abi_version() -> u32 { 1 }

#[no_mangle]
pub extern "C" fn can_recovery_create() -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(handle) = calls.next else { return 0; };
        if calls.calls.try_reserve(1).is_err() { return 0; }
        calls.next = handle.checked_add(1);
        calls.calls.insert(handle, Call::new());
        handle
    })
}

#[no_mangle]
pub extern "C" fn can_recovery_free(handle: u32) -> u32 {
    CALLS.with(|calls| u32::from(calls.borrow_mut().calls.remove(&handle).is_some()))
}

#[no_mangle]
pub extern "C" fn can_recovery_demand(handle: u32) -> u32 {
    with_call(handle, |call| call.phase)
}

#[no_mangle]
pub extern "C" fn can_recovery_error_code(handle: u32) -> u32 {
    CALLS.with(|calls| calls.borrow().calls.get(&handle).map_or(PROTOCOL, |call| call.error))
}

#[no_mangle]
pub extern "C" fn can_recovery_claim_index(handle: u32) -> u32 {
    let value = with_call(handle, |call| {
        if !matches!(call.phase, 15..=17) { call.fail(PROTOCOL); return u32::MAX; }
        call.selected_claim
    });
    // Unknown handles cannot resolve a claim index.
    if value == ERROR && can_recovery_error_code(handle) == PROTOCOL { u32::MAX } else { value }
}

#[no_mangle]
pub extern "C" fn can_recovery_text_prepare(handle: u32, len: u32) -> u32 {
    let result = with_call(handle, |call| {
        if !matches!(call.phase, 10 | 14 | 30) { call.fail(PROTOCOL); return 0; }
        u32::from(call.prepare_text(len))
    });
    u32::from(result == 1)
}

#[no_mangle]
pub extern "C" fn can_recovery_text_ptr(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else { return 0; };
        if !call.text_ready { call.fail(PROTOCOL); return 0; }
        match u32::try_from(call.text.as_mut_ptr() as usize) {
            Ok(pointer) => pointer,
            Err(_) => { call.fail(PROTOCOL); 0 }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_recovery_text_len(handle: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else { return 0; };
        if !call.text_ready { call.fail(PROTOCOL); return 0; }
        match u32::try_from(call.text.len()) {
            Ok(len) => len,
            Err(_) => { call.fail(PROTOCOL); 0 }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_recovery_text_reply(handle: u32) -> u32 {
    with_call(handle, |call| {
        if !call.text_ready { return call.fail(PROTOCOL); }
        call.text_ready = false;
        match call.phase {
            10 => {
                let Some(next) = call.next_claim.checked_add(1) else { return call.fail(PROTOCOL); };
                if call.claims.try_reserve(1).is_err() { return call.fail(PROTOCOL); }
                call.claims.insert(std::mem::take(&mut call.text), call.next_claim);
                call.next_claim = next;
                call.phase = 9;
            }
            14 => {
                if let Some(index) = call.claims.get(&call.text) {
                    call.selected_claim = *index;
                    call.phase = 15;
                } else {
                    call.selected_claim = u32::MAX;
                    call.phase = 11;
                }
            }
            30 => {
                let list = &mut call.lists[call.output];
                if list.len() >= u32::MAX as usize || list.try_reserve(1).is_err() { return call.fail(PROTOCOL); }
                list.push(std::mem::take(&mut call.text));
                call.phase = 11;
            }
            _ => return call.fail(PROTOCOL),
        }
        call.phase
    })
}

/// Tag-reply select phases 9/11: branch selection, then equal-id
/// sorting into DONE. Unstable sorting avoids an extra infallible
/// scratch allocation without changing output (equal UTF-16 ids are
/// indistinguishable).
fn tag_reply_select(call: &mut Call, value: u32) -> Option<u32> {
    match call.phase {
        9 => match value { 0 => call.phase = 11, 1 => call.phase = 10, _ => return Some(call.fail(PROTOCOL)) },
        11 => match value {
            0 => { for list in &mut call.lists { list.sort_unstable(); } call.phase = DONE; }
            1 => call.phase = 12,
            _ => return Some(call.fail(PROTOCOL)),
        },
        _ => return None,
    }
    Some(call.phase)
}

/// Tag-reply route phases 12-27: fan out to the output/branch phases.
fn tag_reply_route(call: &mut Call, value: u32) -> Option<u32> {
    match call.phase {
        12 => match value {
            0 => call.phase = 13, 1 => call.phase = 14, 2 => call.phase = 20,
            3 => call.phase = 27, 4 => call.phase = 11, _ => return Some(call.fail(PROTOCOL)),
        },
        13 => match value { 0 => { call.output(4); }, 1 => call.phase = 11, _ => return Some(call.fail(PROTOCOL)) },
        20 => match value { 1 => call.phase = 21, 0 => { call.output(5); }, _ => return Some(call.fail(PROTOCOL)) },
        23 => match value { 0 => { call.output(1); }, 1 => call.phase = 24, _ => return Some(call.fail(PROTOCOL)) },
        27 => match value {
            0 => { call.output(3); }, 1 => { call.output(1); }, 2 => { call.output(2); },
            _ => return Some(call.fail(PROTOCOL)),
        },
        _ => return None,
    }
    Some(call.phase)
}

#[no_mangle]
pub extern "C" fn can_recovery_tag_reply(handle: u32, value: u32) -> u32 {
    with_call(handle, |call| {
        if let Some(outcome) = tag_reply_select(call, value) {
            return outcome;
        }
        if let Some(outcome) = tag_reply_route(call, value) {
            return outcome;
        }
        call.fail(PROTOCOL)
    })
}

/// Number-reply gate phases 1-8: finite, non-negative, integer, and
/// positive gates. Returns the reply when the phase was handled.
fn number_reply_gate(call: &mut Call, value: f64) -> Option<u32> {
    match call.phase {
        1 => { if !value.is_finite() { return Some(call.fail(1)); } call.phase = 2; }
        2 => { if value < 0.0 { return Some(call.fail(1)); } call.phase = 3; }
        3 => { if !value.is_finite() { return Some(call.fail(2)); } call.phase = 4; }
        4 => { if value < 0.0 { return Some(call.fail(2)); } call.phase = 5; }
        5 => { if !value.is_finite() || value.trunc() != value { return Some(call.fail(3)); } call.phase = 6; }
        6 => { if value < 1.0 { return Some(call.fail(3)); } call.phase = 7; }
        7 => { if !value.is_finite() { return Some(call.fail(4)); } call.phase = 8; }
        8 => { if value <= 0.0 { return Some(call.fail(4)); } call.phase = 9; }
        _ => return None,
    }
    Some(call.phase)
}

/// Number-reply staleness window phases 15-17: captures now/age,
/// gates both, then compares the value against the window.
fn number_reply_window(call: &mut Call, value: f64) -> Option<u32> {
    match call.phase {
        15 => { call.now = value; call.phase = 16; }
        16 => {
            call.age = value;
            if !call.now.is_finite() || call.now < 0.0 { return Some(call.fail(5)); }
            if !call.age.is_finite() || call.age < 0.0 { return Some(call.fail(6)); }
            call.phase = 17;
        }
        17 => { if value + call.age <= call.now { call.output(0); } else { call.phase = 11; } }
        _ => return None,
    }
    Some(call.phase)
}

/// Number-reply attempt phases 21-26: captures attempts/anchor and
/// compares against the horizon value.
fn number_reply_attempt(call: &mut Call, value: f64) -> Option<u32> {
    match call.phase {
        21 => { call.attempts = value; call.phase = 22; }
        22 => { if call.attempts >= value { call.output(6); } else { call.phase = 23; } }
        24 => { call.failure_now = value; call.phase = 25; }
        25 => { call.anchor = value; call.phase = 26; }
        26 => { if call.failure_now - call.anchor >= value { call.output(6); } else { call.output(1); } }
        _ => return None,
    }
    Some(call.phase)
}

#[no_mangle]
pub extern "C" fn can_recovery_number_reply(handle: u32, value: f64) -> u32 {
    with_call(handle, |call| {
        if let Some(outcome) = number_reply_gate(call, value) {
            return outcome;
        }
        if let Some(outcome) = number_reply_window(call, value) {
            return outcome;
        }
        if let Some(outcome) = number_reply_attempt(call, value) {
            return outcome;
        }
        call.fail(PROTOCOL)
    })
}

#[no_mangle]
pub extern "C" fn can_recovery_result_len(handle: u32, list: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else { return 0; };
        if call.phase != DONE || list >= 7 { call.fail(PROTOCOL); return 0; }
        match u32::try_from(call.lists[list as usize].len()) {
            Ok(len) => len,
            Err(_) => { call.fail(PROTOCOL); 0 }
        }
    })
}

#[no_mangle]
pub extern "C" fn can_recovery_result_select(handle: u32, list: u32, index: u32) -> u32 {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let Some(call) = calls.calls.get_mut(&handle) else { return 0; };
        if call.phase != DONE || list >= 7 { call.fail(PROTOCOL); return 0; }
        let Some(value) = call.lists[list as usize].get(index as usize) else { call.fail(PROTOCOL); return 0; };
        let Ok(len) = u32::try_from(value.len()) else { call.fail(PROTOCOL); return 0; };
        // Reserve without an infallible Vec clone; allocation errors stay explicit.
        call.text.clear();
        call.text_ready = false;
        if call.text.try_reserve(len as usize).is_err() { call.fail(PROTOCOL); return 0; }
        call.text.extend_from_slice(value);
        call.text_ready = true;
        1
    })
}
