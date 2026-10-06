//! Versioned structural scaffold binding (V03.5).
//!
//! `validation_call` runs one `{"v":1,"op":...,"args":{...}}` scaffold
//! request against a process-lifetime [`ProfileHost`]: owner handles
//! stay server-side across calls, exactly as in production. The
//! binding adds no logic of its own: every gate lives in
//! `profiles.rs`, and every failure is data in the response envelope,
//! never a trap.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

use values_semantics::profiles::{ProfileHost, STRUCTURAL_ABI};

thread_local! {
    static HOST: RefCell<ProfileHost> = RefCell::new(ProfileHost::default());
}

/// Structural scaffold ABI version this glue was built against.
#[wasm_bindgen]
pub fn structural_abi_version() -> u32 {
    STRUCTURAL_ABI
}

/// Runs one scaffold request, returning the response JSON.
#[wasm_bindgen]
pub fn validation_call(request_json: &str) -> String {
    HOST.with(|host| host.borrow_mut().handle_line(request_json).to_string())
}
