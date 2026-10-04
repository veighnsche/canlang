//! The `can` binary: thin entry point over [`canlang_compiler::cli`].
//!
//! All dispatch, output formatting and exit codes live in the library so
//! integration tests exercise the same code as the shipped binary.

use std::{env, process::ExitCode};

fn main() -> ExitCode {
    // Non-UTF-8 arguments degrade to U+FFFD rather than panicking; file
    // operands that fail to open still report a precise E7002.
    let argv: Vec<String> = env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    ExitCode::from(canlang_compiler::cli::run(&argv) as u8)
}
