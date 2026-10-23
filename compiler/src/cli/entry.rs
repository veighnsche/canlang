//! Private entry command implementation.
use super::*;

/// Source commands own their usage; the platform owns generation/validation.
/// Spawn directly with fixed argument boundaries and the current compiler.
pub(super) fn run_source_entry(
    operation: &str,
    operands: &[String],
    format: OutputFormat,
    retry: bool,
    dry_run: bool,
    settings: Option<&str>,
    platform_bin: Option<String>,
) -> DispatchResult {
    let command_name = if operation == "generate" {
        "gen"
    } else {
        "validate"
    };
    let [source] = operands else {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {command_name} expects exactly one FILE.can"),
        );
    };
    if Path::new(source).extension().is_none_or(|ext| ext != "can") {
        return DispatchResult::tool_error(
            "E7001",
            format!("can {command_name} expects a .can source file"),
        );
    }
    let source = match std::fs::canonicalize(source) {
        Ok(path) if path.is_file() => path,
        Ok(_) => {
            return DispatchResult::tool_error("E7001", format!("source '{source}' is not a file"));
        }
        Err(error) => {
            return DispatchResult::tool_error(
                "E7001",
                format!("cannot read source '{source}': {error}"),
            );
        }
    };
    let selected = platform_bin
        .or_else(|| find_on_path("can-platform"))
        .or_else(|| checkout_platform(Some(&source)));
    let bin = match locate_platform_bin(selected, command_name) {
        Ok(bin) => bin,
        Err(error) => return error,
    };
    let mut command = std::process::Command::new(&bin);
    command.arg(operation).arg(source);
    if retry {
        command.arg("--retry");
    }
    if dry_run {
        command.arg("--dry-run");
    }
    if let Some(settings) = settings {
        // The platform resolves this public path against the unchanged caller cwd.
        command.arg(format!("--settings={settings}"));
    }
    command.arg(match format {
        OutputFormat::Json => "--format=json",
        OutputFormat::Text => "--format=text",
    });
    match std::env::current_exe() {
        Ok(executable) => {
            command.env("CAN_COMPILER_BIN", executable);
        }
        Err(error) => {
            return DispatchResult::tool_error(
                "E7004",
                format!("cannot locate current compiler: {error}"),
            );
        }
    }
    match command.status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(error) => {
            DispatchResult::tool_error("E7004", format!("failed to exec platform '{bin}': {error}"))
        }
    }
}

/// Thin lane-7 entry: exec the platform producer with argument passthrough.
///
/// `platform_bin` overrides PATH search (used by `CAN_PLATFORM_BIN` and by
/// tests). Returns the child's exit code on success (a signal-killed child
/// has no exit code and maps to [`exit::TOOL_FAILURE`]), or an `E7004`
/// missing-producer tool error when the producer is absent/unlaunchable.
/// Never a second engine: unknown subcommands or analysis never happen here.
pub fn run_thin_entry(
    subcommand: &str,
    args: &[String],
    platform_bin: Option<String>,
) -> DispatchResult {
    let bin = match locate_platform_bin(platform_bin, subcommand) {
        Ok(bin) => bin,
        Err(result) => return result,
    };
    let mut child_args = Vec::with_capacity(args.len() + 1);
    child_args.push(subcommand.to_string());
    child_args.extend(args.iter().cloned());
    let mut command = std::process::Command::new(&bin);
    command.args(&child_args);
    if subcommand == "test"
        && std::env::var_os("CAN_COMPILER_BIN").is_none()
        && let Ok(executable) = std::env::current_exe()
    {
        command.env("CAN_COMPILER_BIN", executable);
    }
    match command.status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(err) => DispatchResult::tool_error(
            "E7004",
            format!("failed to exec lane-7 producer '{bin}': {err}"),
        ),
    }
}

/// Pass the native `can dev` command to the single Node session client.
/// The child owns its one-line JSON response and exit status.
pub fn run_dev_entry(args: &[String], dev_bin: Option<String>) -> DispatchResult {
    let bin = match dev_bin {
        Some(path) => path,
        None => match find_on_path("can-dev") {
            Some(path) => path,
            None => {
                return DispatchResult::tool_error(
                    "E7004",
                    "development control 'can-dev' not found on PATH; install it or set CAN_DEV_BIN (see can explain E7004)".to_string(),
                );
            }
        },
    };
    if !Path::new(&bin).is_file() {
        return DispatchResult::tool_error(
            "E7004",
            format!(
                "development control '{bin}' is not a file; install it or fix CAN_DEV_BIN (see can explain E7004)"
            ),
        );
    }
    match std::process::Command::new(&bin).args(args).status() {
        Ok(status) => DispatchResult {
            code: status.code().unwrap_or(exit::TOOL_FAILURE),
            stdout: String::new(),
            stderr: String::new(),
            run_lsp: false,
        },
        Err(err) => DispatchResult::tool_error(
            "E7004",
            format!("failed to exec development control '{bin}': {err}"),
        ),
    }
}
