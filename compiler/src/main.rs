//! The `can` binary: thin entry point over [`canlang_compiler::cli`].
//!
//! All dispatch, output formatting and exit codes live in the library so
//! integration tests exercise the same code as the shipped binary.

use std::{env, process::ExitCode};

fn main() -> ExitCode {
    // Installed FIRST, before any other work: a panic anywhere below
    // (unreachable invariant, failed output write, backend bug) prints one
    // `error[E7005]` line on stderr and exits 2 — never a Rust trace and
    // never exit 101 on user input. `catch_unwind` below converts the
    // unwind into the exit code; this hook replaces the default trace.
    std::panic::set_hook(Box::new(|info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|message| message.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_string());
        // Panic messages may span lines; the tool error stays one line.
        let first_line = payload.lines().next().unwrap_or("").trim();
        let at = info
            .location()
            .map(|at| format!(" at {}:{}", at.file(), at.line()))
            .unwrap_or_default();
        eprintln!("error[E7005]: internal error{at}: {first_line} (see `can explain E7005`)");
    }));
    let code = match std::panic::catch_unwind(run) {
        Ok(code) => code,
        Err(_) => canlang_compiler::exit::TOOL_FAILURE,
    };
    ExitCode::from(code as u8)
}

fn run() -> i32 {
    // Non-UTF-8 arguments degrade to U+FFFD rather than panicking; file
    // operands that fail to open still report a precise E7002.
    let argv: Vec<String> = env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    canlang_compiler::cli::run(&argv)
}
