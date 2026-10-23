//! Private args command implementation.
use super::*;

pub(super) struct ParsedArgs {
    pub(super) subcommand: Option<String>,
    pub(super) operands: Vec<String>,
    pub(super) format: OutputFormat,
    /// Whether `--format` was passed explicitly (rejected for commands
    /// that take no format, rather than silently ignored).
    pub(super) format_set: bool,
    /// `--catalog PATH` flag value (`check`/`lint`/`compile` only).
    pub(super) catalog: Option<String>,
    /// Whether `--catalog` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    pub(super) catalog_set: bool,
    pub(super) fmt_check: bool,
    /// `can lint --fix`: compute machine fixes and report them (JSON
    /// gains a sorted `fixes` array; text gains one `fix` line each).
    pub(super) fix: bool,
    pub(super) native_scenario_receipts: bool,
    pub(super) generation_root: Option<String>,
    /// `can docs --locale=TAG`: requested reference locale (selected by
    /// the TS renderer; absent means the app default plus source fallback).
    pub(super) locale: Option<String>,
    /// Whether `--locale` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    pub(super) locale_set: bool,
    /// `can docs --out=PATH`: reference output file (absent means stdout).
    pub(super) out: Option<String>,
    /// Whether `--out` was passed explicitly (rejected for commands
    /// that take none, rather than silently ignored).
    pub(super) out_set: bool,
    /// `can gen --request=FILE`: versioned JSON request file (absent
    /// with no operands means stdin carries the request).
    pub(super) request: Option<String>,
    /// Whether `--request` was passed explicitly (rejected for
    /// commands that take none, rather than silently ignored).
    pub(super) request_set: bool,
    pub(super) retry: bool,
    pub(super) dry_run: bool,
    pub(super) settings: Option<String>,
    pub(super) help: bool,
    pub(super) version: bool,
}

fn parse_simple_flag(parsed: &mut ParsedArgs, arg: &str) -> bool {
    match arg {
        "--help" | "-h" => parsed.help = true,
        "--version" | "-V" => parsed.version = true,
        "--retry" => parsed.retry = true,
        "--dry-run" => parsed.dry_run = true,
        "--check" => parsed.fmt_check = true,
        "--fix" => parsed.fix = true,
        "--native-scenario-receipts" => parsed.native_scenario_receipts = true,
        _ => return false,
    }
    true
}

fn parse_root_settings_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if arg == "--generation-root" {
        *i += 1;
        parsed.generation_root = Some(
            args.get(*i)
                .ok_or("--generation-root needs a path")?
                .clone(),
        );
    } else if let Some(value) = arg.strip_prefix("--generation-root=") {
        if value.is_empty() {
            return Err("--generation-root needs a path".into());
        }
        parsed.generation_root = Some(value.to_string());
    } else if arg == "--settings" || arg.starts_with("--settings=") {
        if parsed.settings.is_some() {
            return Err("--settings may only be supplied once".to_string());
        }
        let value = if let Some(value) = arg.strip_prefix("--settings=") {
            value
        } else {
            *i += 1;
            args.get(*i)
                .ok_or_else(|| "missing value for --settings; want a PATH".to_string())?
        };
        if value.is_empty() || value.starts_with("--") {
            return Err("--settings requires a non-empty PATH".to_string());
        }
        parsed.settings = Some(value.to_string());
    } else {
        return Ok(false);
    }
    Ok(true)
}

fn parse_path_valued_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if parse_root_settings_flag(args, i, parsed, arg)? {
        return Ok(true);
    }
    if let Some(value) = arg.strip_prefix("--catalog=") {
        parsed.catalog = Some(value.to_string());
        parsed.catalog_set = true;
    } else if arg == "--catalog" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --catalog; want a PATH".to_string())?;
        parsed.catalog = Some(value.clone());
        parsed.catalog_set = true;
    } else if let Some(value) = arg.strip_prefix("--locale=") {
        parsed.locale = Some(value.to_string());
        parsed.locale_set = true;
    } else if arg == "--locale" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --locale; want a BCP 47 tag".to_string())?;
        parsed.locale = Some(value.clone());
        parsed.locale_set = true;
    } else if let Some(value) = arg.strip_prefix("--out=") {
        parsed.out = Some(value.to_string());
        parsed.out_set = true;
    } else if arg == "--out" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --out; want a PATH".to_string())?;
        parsed.out = Some(value.clone());
        parsed.out_set = true;
    } else if let Some(value) = arg.strip_prefix("--request=") {
        parsed.request = Some(value.to_string());
        parsed.request_set = true;
    } else if arg == "--request" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --request; want a PATH".to_string())?;
        parsed.request = Some(value.clone());
        parsed.request_set = true;
    } else {
        return Ok(false);
    }
    Ok(true)
}

fn parse_valued_flag(
    args: &[String],
    i: &mut usize,
    parsed: &mut ParsedArgs,
    arg: &str,
) -> Result<bool, String> {
    if let Some(value) = arg.strip_prefix("--format=") {
        parsed.format = parse_format(value)?;
        parsed.format_set = true;
    } else if arg == "--format" {
        *i += 1;
        let value = args
            .get(*i)
            .ok_or_else(|| "missing value for --format; want json|text".to_string())?;
        parsed.format = parse_format(value)?;
        parsed.format_set = true;
    } else if !parse_path_valued_flag(args, i, parsed, arg)? {
        return Ok(false);
    }
    Ok(true)
}

fn check_flag_scope(parsed: &ParsedArgs) -> Result<(), String> {
    if (parsed.retry || parsed.dry_run) && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--retry and --dry-run only apply to can gen FILE.can".to_string());
    }
    if parsed.settings.is_some() && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--settings only applies to can gen FILE.can".to_string());
    }
    if parsed.fmt_check && parsed.subcommand.as_deref() != Some("fmt") {
        return Err("--check only applies to can fmt".to_string());
    }
    if parsed.fix && parsed.subcommand.as_deref() != Some("lint") {
        return Err("--fix only applies to can lint".to_string());
    }
    if parsed.generation_root.is_some()
        && !matches!(parsed.subcommand.as_deref(), Some("check" | "compile"))
    {
        return Err("--generation-root is available for check and compile".into());
    }
    if parsed.native_scenario_receipts && parsed.subcommand.as_deref() != Some("compile") {
        return Err("--native-scenario-receipts only applies to can compile".to_string());
    }
    check_docs_flag_scope(parsed)
}

fn check_docs_flag_scope(parsed: &ParsedArgs) -> Result<(), String> {
    if parsed.locale_set && parsed.subcommand.as_deref() != Some("docs") {
        return Err("--locale only applies to can docs".to_string());
    }
    if parsed.out_set && parsed.subcommand.as_deref() != Some("docs") {
        return Err("--out only applies to can docs".to_string());
    }
    if parsed.request_set && parsed.subcommand.as_deref() != Some("gen") {
        return Err("--request only applies to can gen".to_string());
    }
    if parsed.locale.as_deref().is_some_and(str::is_empty) {
        return Err("can docs --locale needs a non-empty BCP 47 tag".to_string());
    }
    Ok(())
}

pub(super) fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs {
        subcommand: None,
        operands: Vec::new(),
        format: OutputFormat::Text,
        format_set: false,
        catalog: None,
        catalog_set: false,
        fmt_check: false,
        fix: false,
        native_scenario_receipts: false,
        generation_root: None,
        locale: None,
        locale_set: false,
        out: None,
        out_set: false,
        request: None,
        request_set: false,
        retry: false,
        dry_run: false,
        settings: None,
        help: false,
        version: false,
    };
    let mut i = 0;
    let mut flags_done = false;
    while i < args.len() {
        let arg = &args[i];
        if !flags_done && arg == "--" {
            flags_done = true;
            i += 1;
            continue;
        }
        if !flags_done && arg.starts_with('-') && arg.len() > 1 {
            if !parse_simple_flag(&mut parsed, arg)
                && !parse_valued_flag(args, &mut i, &mut parsed, arg)?
            {
                return Err(format!("unknown flag '{arg}'; use can --help"));
            }
            i += 1;
            continue;
        }
        if parsed.subcommand.is_none() {
            parsed.subcommand = Some(arg.clone());
            if is_thin_entry(arg) {
                // Thin lane-7 entry: stop flag parsing at the subcommand.
                // Everything after passes through verbatim to can-platform
                // (flags, `--`, and all), so `can` never swallows or
                // reinterprets child arguments.
                parsed.operands.extend(args[i + 1..].iter().cloned());
                break;
            }
        } else {
            parsed.operands.push(arg.clone());
        }
        i += 1;
    }
    check_flag_scope(&parsed)?;
    if parsed.out.as_deref().is_some_and(str::is_empty) {
        return Err("can docs --out needs a non-empty PATH".to_string());
    }
    if parsed.request.as_deref().is_some_and(str::is_empty) {
        return Err("can gen --request needs a non-empty PATH".to_string());
    }
    Ok(parsed)
}

fn parse_format(value: &str) -> Result<OutputFormat, String> {
    match value {
        "json" => Ok(OutputFormat::Json),
        "text" => Ok(OutputFormat::Text),
        other => Err(format!("invalid --format '{other}'; want json|text")),
    }
}
