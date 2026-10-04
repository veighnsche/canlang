use std::{env, process::ExitCode};

const HELP: &str = "CanLang compiler scaffold

Usage: can <COMMAND>
       can --help
       can --version

Reserved commands (not implemented):
  compile
  lint
  fmt

Options:
  -h, --help     Show this help
  -V, --version  Show the scaffold version";

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let command = args.first().and_then(|arg| arg.to_str());

    match (command, args.len()) {
        (None, 0) | (Some("--help" | "-h"), 1) => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        (Some("--version" | "-V"), 1) => {
            println!("can {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        (Some(command @ ("compile" | "lint" | "fmt")), _) => {
            eprintln!("error: can {command} is reserved but not implemented");
            ExitCode::FAILURE
        }
        _ => {
            eprintln!("error: unknown command or unsupported arguments; use can --help");
            ExitCode::FAILURE
        }
    }
}
