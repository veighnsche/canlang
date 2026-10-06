//! Native conformance runner: NDJSON operation requests on stdin, one
//! NDJSON response per line on stdout.
//!
//! Usage: printf '%s\n' "$REQ" | cargo run --locked --manifest-path \
//!   packages/values/semantics/Cargo.toml --example conformance
//!
//! This is a test/differential harness, not a shipped entry point.

use std::io::{self, BufRead, Write};

use values_semantics::transport::exact::handle_line;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let _ = writeln!(
                    out,
                    "{{\"ok\":false,\"transport\":\"stdin read failed: {error}\"}}"
                );
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_line(&line);
        let _ = writeln!(out, "{}", response);
        // The driver is request/response sequential: flush every line or
        // both sides block forever on a buffered reply.
        let _ = out.flush();
    }
}
