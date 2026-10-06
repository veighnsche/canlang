//! `can-preparation`: native artifact-preparation job process.
//!
//! Launched by the host with an empty argument vector; speaks the
//! length-delimited frame protocol on stdin/stdout (see `protocol.rs`).
//! Stdout is protocol-only; diagnostics go to stderr.

mod failures;
mod input;
mod job;
mod protocol;

use std::io::{stdin, stdout};

fn main() {
    let mut args = std::env::args();
    let _program = args.next();
    if args.next().is_some() {
        eprintln!("usage: can-preparation (no arguments; protocol on stdio)");
        std::process::exit(2);
    }
    let code = job::run_job(&mut stdin().lock(), &mut stdout().lock());
    std::process::exit(code);
}
