//! Reserved foundation binding entries (A07.1 smoke).
//!
//! `abi_version` pins the transport ABI the generated glue was built
//! against; `exact_call` runs one versioned operation request and
//! returns one response. Both are synchronous and infallible at the
//! binding layer: every Can failure is data inside the response JSON,
//! never a trap or a thrown JS exception.

use wasm_bindgen::prelude::*;

use values_semantics::transport::exact::{handle_line, ABI_VERSION};

/// Transport ABI version this glue was built against.
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// Runs one `{"v":1,"op":...,"args":[...]}` request, returning the
/// response JSON (`{"ok":true,"value":...}` or a failure object).
#[wasm_bindgen]
pub fn exact_call(request_json: &str) -> String {
    handle_line(request_json).to_string()
}
