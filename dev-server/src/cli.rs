//! Bounded, non-starting command parsing and retained JSON control envelopes.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const COMMANDS: &[&str] = &[
    "start",
    "discover",
    "status",
    "check",
    "diagnostics",
    "diagnostic.detail",
    "construct.help",
    "construct.rank",
    "rank.lookup",
    "failure.lookup",
    "failure.detail",
    "failures",
    "preview.status",
    "preview.open",
    "example.run",
    "example.rerun",
    "stop",
];
const COMMON: &[&str] = &["--root", "--session", "--app", "--profile"];
const START: &[&str] = &[
    "--source",
    "--root",
    "--app",
    "--compiler",
    "--catalog",
    "--help-index",
    "--capture",
    "--preview-roles",
    "--check-mode",
];
const USAGE_CODES: &[&str] = &[
    "UNKNOWN_COMMAND",
    "INVALID_ARGUMENTS",
    "INVALID_CAPTURE",
    "REVISION_REQUIRED",
    "INVALID_REVISION",
    "FAILURE_REF_REQUIRED",
    "CONSTRUCT_ID_REQUIRED",
    "RANK_REF_REQUIRED",
];
#[derive(Clone, Debug)]
pub struct Args {
    pub command: String,
    pub values: BTreeMap<String, String>,
}
impl Args {
    pub fn value(&self, flag: &str) -> Option<&str> {
        self.values.get(flag).map(String::as_str)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Envelope {
    Success {
        ok: bool,
        command: String,
        session: Option<String>,
        result: Value,
    },
    Failure {
        ok: bool,
        command: String,
        code: String,
        detail: String,
    },
}
impl Envelope {
    pub fn success(command: impl Into<String>, session: Option<String>, result: Value) -> Self {
        Self::Success {
            ok: true,
            command: command.into(),
            session,
            result,
        }
    }
    pub fn failure(
        command: impl Into<String>,
        code: impl Into<String>,
        detail: impl AsRef<str>,
    ) -> Self {
        Self::Failure {
            ok: false,
            command: command.into(),
            code: code.into(),
            detail: detail
                .as_ref()
                .chars()
                .map(|c| {
                    if c <= '\u{1f}' || c == '\u{7f}' {
                        ' '
                    } else {
                        c
                    }
                })
                .take(300)
                .collect(),
        }
    }
    pub fn command(&self) -> &str {
        match self {
            Self::Success { command, .. } | Self::Failure { command, .. } => command,
        }
    }
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Success { .. })
    }
}
pub struct CliOutput {
    pub line: String,
    pub exit_code: u8,
}
pub fn format(envelope: &Envelope) -> CliOutput {
    let mut selected = envelope.clone();
    let mut encoded = serde_json::to_string(&selected).unwrap_or_default();
    if encoded.is_empty() {
        selected = Envelope::failure(
            safe_command(envelope.command()),
            "CONTROL_INTERNAL",
            "control response cannot be encoded as JSON",
        );
        encoded = serde_json::to_string(&selected).unwrap();
    }
    if encoded.len() + 1 > 128 * 1024 {
        selected = Envelope::failure(
            safe_command(envelope.command()),
            "OUTPUT_LIMIT",
            "control response exceeds the JSON output limit",
        );
        encoded = serde_json::to_string(&selected).unwrap();
    }
    let exit_code = match &selected {
        Envelope::Success { .. } => 0,
        Envelope::Failure { code, .. } if USAGE_CODES.contains(&code.as_str()) => 2,
        _ => 1,
    };
    CliOutput {
        line: format!("{encoded}\n"),
        exit_code,
    }
}
fn safe_command(command: &str) -> String {
    let value: String = command
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if value.is_empty() {
        "help".into()
    } else {
        value
    }
}
fn failure(args: &Args, code: &str, detail: &str) -> Envelope {
    Envelope::failure(&args.command, code, detail)
}
fn required_revision(command: &str) -> bool {
    matches!(
        command,
        "diagnostics"
            | "diagnostic.detail"
            | "construct.help"
            | "construct.rank"
            | "rank.lookup"
            | "failures"
    )
}
fn allowed(command: &str) -> BTreeSet<&'static str> {
    let mut flags: BTreeSet<_> = if command == "start" { START } else { COMMON }
        .iter()
        .copied()
        .collect();
    if matches!(command, "check" | "example.run") {
        flags.insert("--expected-revision");
    }
    if command == "example.run" {
        flags.extend(["--operation", "--row"]);
    }
    if required_revision(command) {
        flags.insert("--revision");
    }
    if matches!(command, "diagnostics" | "failures") {
        flags.extend(["--after", "--limit"]);
    }
    if matches!(command, "diagnostic.detail" | "construct.rank") {
        flags.insert("--index");
    }
    match command {
        "construct.rank" => {
            flags.insert("--author-intent");
        }
        "construct.help" => {
            flags.insert("--id");
        }
        "rank.lookup" | "failure.lookup" | "failure.detail" | "example.rerun" => {
            flags.insert("--ref");
        }
        _ => {}
    }
    flags
}
pub fn parse(argv: &[String]) -> Result<Args, Envelope> {
    let command = argv.first().map(String::as_str).unwrap_or("help");
    if matches!(command, "help" | "--help" | "-h" | "--version") {
        if argv.len() > 1 {
            return Err(Envelope::failure(
                command,
                "INVALID_ARGUMENTS",
                "help/version takes no arguments",
            ));
        }
        return Ok(Args {
            command: if command == "--version" {
                "version"
            } else {
                "help"
            }
            .into(),
            values: BTreeMap::new(),
        });
    }
    let ui = matches!(command, "ui" | "terminal");
    if !ui && !COMMANDS.contains(&command) {
        return Err(Envelope::failure(
            command,
            "UNKNOWN_COMMAND",
            "development control command is unavailable",
        ));
    }
    let mut args = Args {
        command: command.into(),
        values: BTreeMap::new(),
    };
    let tokens = parse_tokens(&mut args, &argv[1..], ui)?;
    if ui && tokens.len() == 1 && matches!(tokens[0].as_str(), "help" | "--help" | "-h") {
        args.command = "ui".into();
        args.values.insert("--help".into(), "true".into());
        return Ok(args);
    }
    let selected = if ui {
        if tokens
            .iter()
            .any(|v| matches!(v.as_str(), "--source" | "--capture"))
        {
            "start"
        } else {
            "discover"
        }
    } else {
        command
    };
    parse_pairs(&mut args, &tokens, selected)?;
    validate(&args, selected)?;
    if ui {
        args.command = "ui".into();
    }
    Ok(args)
}
fn parse_tokens(args: &mut Args, argv: &[String], ui: bool) -> Result<Vec<String>, Envelope> {
    if argv.iter().map(String::len).sum::<usize>() > 1024 * 1024 {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "control arguments exceed the input limit",
        ));
    }
    let mut tokens = Vec::new();
    for token in argv {
        if ui && token == "--plain" {
            // Existing terminal mode treats --plain as a presentation toggle.
            args.values.insert("--plain".into(), "true".into());
        } else {
            tokens.push(token.clone());
        }
    }
    Ok(tokens)
}
fn parse_pairs(args: &mut Args, tokens: &[String], selected: &str) -> Result<(), Envelope> {
    let allowed = allowed(selected);
    for pair in tokens.chunks(2) {
        if pair.len() != 2
            || !pair[0].starts_with("--")
            || pair[1].starts_with("--")
            || args.values.contains_key(&pair[0])
        {
            return Err(failure(
                args,
                "INVALID_ARGUMENTS",
                "control flags need one value and may appear once",
            ));
        }
        if !allowed.contains(pair[0].as_str()) {
            return Err(failure(
                args,
                "INVALID_ARGUMENTS",
                "flag does not apply to this command",
            ));
        }
        args.values.insert(pair[0].clone(), pair[1].clone());
    }
    Ok(())
}
fn revision(value: &str) -> bool {
    value.strip_prefix('r').is_some_and(|v| positive_digits(v))
}
fn positive_digits(value: &str) -> bool {
    !value.starts_with('0') && !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}
fn integer(value: &str, minimum: u64) -> Option<u64> {
    if value != "0" && !positive_digits(value) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n >= minimum && *n <= 9_007_199_254_740_991)
}
fn ascii_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn valid_operation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.".contains(&b))
}
fn retained_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn failure_ref(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() < 3 || !retained_id(parts[0]) || !revision(parts[1]) {
        return false;
    }
    if parts.len() == 3 {
        return parts[2]
            .strip_prefix('d')
            .is_some_and(|n| n == "0" || positive_digits(n));
    }
    if parts.len() != 4 || !retained_id(parts[2]) {
        return false;
    }
    let Some(index) = parts[3].strip_prefix('f') else {
        return false;
    };
    let entries: Vec<_> = index.split('_').collect();
    entries.len() <= 2
        && entries
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn validate(args: &Args, selected: &str) -> Result<(), Envelope> {
    validate_revision(args, selected)?;
    validate_lookup(args, selected)?;
    validate_paging(args, selected)?;
    if selected == "start" {
        validate_start(args)?;
    }
    if selected == "example.run" {
        validate_example(args)?;
    }
    if args.value("--author-intent").is_some_and(|s| {
        s.trim().is_empty()
            || s.encode_utf16().count() > 240
            || s.chars()
                .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
    }) {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "author intent needs one sentence of at most 240 characters",
        ));
    }
    Ok(())
}
fn validate_revision(args: &Args, selected: &str) -> Result<(), Envelope> {
    if required_revision(selected) && !args.value("--revision").is_some_and(revision) {
        return Err(failure(
            args,
            "REVISION_REQUIRED",
            "revisioned lookup needs --revision rN",
        ));
    }
    if args
        .value("--expected-revision")
        .is_some_and(|v| !revision(v))
    {
        return Err(failure(
            args,
            "INVALID_REVISION",
            "expected revision must be rN",
        ));
    }
    if selected == "example.run" && args.value("--expected-revision").is_none() {
        return Err(failure(
            args,
            "REVISION_REQUIRED",
            "example run needs --expected-revision rN",
        ));
    }
    Ok(())
}
fn validate_lookup(args: &Args, selected: &str) -> Result<(), Envelope> {
    if selected == "construct.help" {
        let valid = args
            .value("--id")
            .and_then(|id| id.strip_prefix("can.v1."))
            .is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 100
                    && s.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)
                    })
            });
        if !valid {
            return Err(failure(
                args,
                "CONSTRUCT_ID_REQUIRED",
                "construct help needs --id can.v1.CONSTRUCT",
            ));
        }
    }
    if matches!(
        selected,
        "failure.lookup" | "failure.detail" | "example.rerun"
    ) && !args.value("--ref").is_some_and(failure_ref)
    {
        return Err(failure(
            args,
            "FAILURE_REF_REQUIRED",
            "failure lookup needs a retained compiler or example ref",
        ));
    }
    if selected == "rank.lookup" && !args.value("--ref").is_some_and(crate::capture::valid_hash) {
        return Err(failure(
            args,
            "RANK_REF_REQUIRED",
            "rank lookup needs a pending SHA256 ref",
        ));
    }
    Ok(())
}
fn validate_paging(args: &Args, selected: &str) -> Result<(), Envelope> {
    let index_invalid = matches!(selected, "diagnostic.detail" | "construct.rank")
        && args.value("--index").and_then(|v| integer(v, 0)).is_none();
    let after_invalid = args
        .value("--after")
        .is_some_and(|v| v != "-1" && integer(v, 0).is_none());
    let limit_invalid = args
        .value("--limit")
        .is_some_and(|v| integer(v, 1).is_none_or(|n| n > 25));
    if index_invalid || after_invalid || limit_invalid {
        Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "diagnostic index/cursor/limit is invalid",
        ))
    } else {
        Ok(())
    }
}
fn validate_example(args: &Args) -> Result<(), Envelope> {
    let operation = args.value("--operation");
    let row = args.value("--row");
    if operation.is_some() != row.is_some()
        || operation.is_some_and(|v| !valid_operation(v))
        || row.is_some_and(|v| integer(v, 0).is_none())
    {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "selected example needs --operation NAME and --row N",
        ));
    }
    Ok(())
}
fn validate_start(args: &Args) -> Result<(), Envelope> {
    if args.value("--source").is_some() == args.value("--capture").is_some() {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "start needs exactly one of --source or --capture",
        ));
    }
    if args.value("--capture").is_some()
        && ["--root", "--compiler", "--catalog", "--help-index"]
            .iter()
            .any(|flag| args.value(flag).is_some())
    {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "a capture manifest already fixes root and tool inputs",
        ));
    }
    if args
        .value("--check-mode")
        .is_some_and(|v| !matches!(v, "manual" | "automatic"))
    {
        return Err(failure(
            args,
            "INVALID_ARGUMENTS",
            "check mode must be manual or automatic",
        ));
    }
    if let Some(roles) = args.value("--preview-roles") {
        if !valid_roles(roles) {
            return Err(failure(
                args,
                "INVALID_ARGUMENTS",
                "--preview-roles requires a JSON map of seeded actor labels to declared role names",
            ));
        }
    }
    Ok(())
}
fn valid_roles(raw: &str) -> bool {
    let Ok(Value::Object(actors)) = serde_json::from_str(raw) else {
        return false;
    };
    actors.iter().all(|(actor, roles)| {
        ["Ava", "Ben", "Cal", "Dee"].contains(&actor.as_str())
            && roles.as_array().is_some_and(|roles| valid_role_list(roles))
    })
}
fn valid_role_list(roles: &[Value]) -> bool {
    let mut seen = BTreeSet::new();
    roles.len() <= 32
        && roles.iter().all(|role| {
            role.as_str()
                .is_some_and(|name| name.split('.').all(ascii_identifier) && seen.insert(name))
        })
}
/// Construct only the request payload; lookup, defaults and process ownership
/// remain at the controller that dispatches the parsed command.
pub fn payload(args: &Args) -> Value {
    let mut payload = serde_json::Map::new();
    for (flag, key) in [
        ("--expected-revision", "expectedRevision"),
        ("--revision", "revision"),
        ("--operation", "operation"),
        ("--ref", "ref"),
        ("--id", "id"),
        ("--author-intent", "authorIntent"),
    ] {
        if let Some(value) = args.value(flag) {
            payload.insert(key.into(), value.into());
        }
    }
    for (flag, key) in [
        ("--index", "index"),
        ("--row", "rowIndex"),
        ("--after", "after"),
        ("--limit", "limit"),
    ] {
        if let Some(value) = args.value(flag).and_then(|s| s.parse::<i64>().ok()) {
            payload.insert(key.into(), value.into());
        }
    }
    if payload.is_empty() {
        Value::Null
    } else {
        Value::Object(payload)
    }
}
pub fn help() -> Envelope {
    let commands: Vec<_> = COMMANDS.iter().map(|command| json!({"command":command,"required":required(command),"session":if *command == "start" {"exclusive owner for the selected source"} else {"canonical checkout and verified owner-only socket"}})).collect();
    Envelope::success(
        "help",
        None,
        json!({"schema":"can.dev.control-help.v1","protocol":crate::claim::PROTOCOL,"commands":commands,"flags":{
        "start":START,"common":COMMON,"check":["--expected-revision"],"diagnostics":["--revision","--after","--limit"],"diagnostic.detail":["--revision","--index"],
        "construct.help":["--revision","--id"],"construct.rank":["--revision","--index","--author-intent"],"rank.lookup":["--revision","--ref"],"failure.lookup":["--ref"],"failure.detail":["--ref"],"failures":["--revision","--after","--limit"],"example.run":["--expected-revision","--operation","--row"],"example.rerun":["--ref"],"ui":["--source","--plain","--check-mode"]},
        "start_defaults":{"root":"current directory","compiler":"compiler/target/debug/can","catalog":"packages/values/dist/catalog.json","help_index":"docs/specification/CONSTRUCT-HELP.md"},"unavailable":[],
        "ui":{"command":"can dev ui --source PATH","alias":"terminal","description":"Without --source or --capture, attach to a verified owner."}}),
    )
}
fn required(command: &str) -> Vec<&'static str> {
    match command {
        "start" => vec!["--source PATH or --capture PATH"],
        "diagnostics" | "failures" => vec!["--revision rN"],
        "diagnostic.detail" | "construct.rank" => vec!["--revision rN", "--index N"],
        "construct.help" => vec!["--revision rN", "--id can.v1.CONSTRUCT"],
        "rank.lookup" => vec!["--revision rN", "--ref SHA256"],
        "failure.lookup" | "failure.detail" => vec!["--ref SESSION/rN/dN"],
        "example.run" => vec!["--expected-revision rN"],
        "example.rerun" => vec!["--ref SESSION/rN/RUN/fCASE_ENTRY"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }
    fn code(values: &[&str]) -> String {
        match parse(&argv(values)).unwrap_err() {
            Envelope::Failure { code, .. } => code,
            _ => panic!("expected failure"),
        }
    }
    #[test]
    fn no_argument_help_and_version_never_request_an_owner() {
        for values in [vec![], vec!["help"], vec!["--help"], vec!["-h"]] {
            let args = parse(&argv(&values)).unwrap();
            assert_eq!(args.command, "help");
            assert!(args.values.is_empty());
        }
        assert_eq!(parse(&argv(&["--version"])).unwrap().command, "version");
        assert_eq!(code(&["--version", "status"]), "INVALID_ARGUMENTS");
        assert_eq!(code(&["unknown"]), "UNKNOWN_COMMAND");
        assert_eq!(format(&help()).exit_code, 0);
    }
    #[test]
    fn ui_alias_plain_and_verified_attachment_selection_parse() {
        let args = parse(&argv(&[
            "terminal",
            "--plain",
            "--source",
            "App.can",
            "--check-mode",
            "manual",
        ]))
        .unwrap();
        assert_eq!(args.command, "ui");
        assert_eq!(args.value("--plain"), Some("true"));
        assert_eq!(args.value("--source"), Some("App.can"));
        assert!(parse(&argv(&["ui", "--root", "/work", "--session", "session"])).is_ok());
        assert_eq!(
            parse(&argv(&["ui", "--help"])).unwrap().value("--help"),
            Some("true")
        );
        assert_eq!(code(&["status", "--plain"]), "INVALID_ARGUMENTS");
    }
    #[test]
    fn scoped_flags_duplicates_and_missing_values_are_usage_errors() {
        for values in [
            vec!["status", "--revision", "r1"],
            vec!["status", "--root"],
            vec!["status", "--root", "--app"],
            vec!["check", "--root", "a", "--root", "b"],
            vec!["check", "extra"],
            vec!["check", "--unknown", "value"],
        ] {
            assert_eq!(code(&values), "INVALID_ARGUMENTS", "{values:?}");
        }
        assert!(parse(&argv(&["check", "--expected-revision", "r1"])).is_ok());
        assert_eq!(
            code(&["check", "--expected-revision", "r0"]),
            "INVALID_REVISION"
        );
    }
    #[test]
    fn revisioned_diagnostics_and_paging_preserve_payloads() {
        assert_eq!(code(&["diagnostics"]), "REVISION_REQUIRED");
        let args = parse(&argv(&[
            "diagnostics",
            "--revision",
            "r12",
            "--after",
            "-1",
            "--limit",
            "25",
        ]))
        .unwrap();
        assert_eq!(
            payload(&args),
            json!({"revision":"r12","after":-1,"limit":25})
        );
        for values in [
            vec!["diagnostic.detail", "--revision", "r1"],
            vec!["diagnostic.detail", "--revision", "r1", "--index", "01"],
            vec!["diagnostics", "--revision", "r1", "--limit", "26"],
            vec!["diagnostics", "--revision", "r1", "--after", "-2"],
        ] {
            assert_eq!(code(&values), "INVALID_ARGUMENTS");
        }
    }
    #[test]
    fn selected_examples_need_revision_operation_and_row_together() {
        assert_eq!(code(&["example.run"]), "REVISION_REQUIRED");
        assert_eq!(
            code(&[
                "example.run",
                "--expected-revision",
                "r1",
                "--operation",
                "App.save"
            ]),
            "INVALID_ARGUMENTS"
        );
        let args = parse(&argv(&[
            "example.run",
            "--expected-revision",
            "r2",
            "--operation",
            "App.save",
            "--row",
            "0",
        ]))
        .unwrap();
        assert_eq!(
            payload(&args),
            json!({"expectedRevision":"r2","operation":"App.save","rowIndex":0})
        );
        assert!(parse(&argv(&["example.rerun", "--ref", "session/r2/run/f0_1"])).is_ok());
        assert_eq!(
            code(&["example.rerun", "--ref", "session/r0/run/f0"]),
            "FAILURE_REF_REQUIRED"
        );
        assert!(parse(&argv(&["failure.detail", "--ref", "session/r2/d0"])).is_ok());
    }
    #[test]
    fn construct_and_rank_require_owned_identifiers_and_safe_intent() {
        assert_eq!(
            code(&["construct.help", "--revision", "r1"]),
            "CONSTRUCT_ID_REQUIRED"
        );
        assert!(
            parse(&argv(&[
                "construct.help",
                "--revision",
                "r1",
                "--id",
                "can.v1.ui.table"
            ]))
            .is_ok()
        );
        assert_eq!(
            code(&["rank.lookup", "--revision", "r1", "--ref", "bad"]),
            "RANK_REF_REQUIRED"
        );
        let hash = "a".repeat(64);
        assert!(parse(&argv(&["rank.lookup", "--revision", "r1", "--ref", &hash])).is_ok());
        assert_eq!(
            code(&[
                "construct.rank",
                "--revision",
                "r1",
                "--index",
                "0",
                "--author-intent",
                "bad\nintent"
            ]),
            "INVALID_ARGUMENTS"
        );
    }
    #[test]
    fn start_manifest_tool_overrides_and_preview_roles_match_baseline() {
        for values in [
            vec!["start"],
            vec!["start", "--source", "a", "--capture", "b"],
            vec!["start", "--capture", "b", "--root", "c"],
            vec!["start", "--source", "a", "--check-mode", "fast"],
            vec![
                "start",
                "--source",
                "a",
                "--preview-roles",
                r#"{"Unknown":["member"]}"#,
            ],
            vec![
                "start",
                "--source",
                "a",
                "--preview-roles",
                r#"{"Ava":["admin","admin"]}"#,
            ],
        ] {
            assert_eq!(code(&values), "INVALID_ARGUMENTS", "{values:?}");
        }
        assert!(
            parse(&argv(&[
                "start",
                "--source",
                "App.can",
                "--preview-roles",
                r#"{"Ava":["Office.admin"],"Ben":[]}"#
            ]))
            .is_ok()
        );
        assert!(
            parse(&argv(&[
                "start",
                "--capture",
                "inputs.json",
                "--app",
                "Office"
            ]))
            .is_ok()
        );
    }
    #[test]
    fn output_is_one_bounded_line_and_exit_tracks_control_outcome() {
        let checked = Envelope::success(
            "check",
            Some("session".into()),
            json!({"kind":"diagnostics"}),
        );
        let output = format(&checked);
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.line.lines().count(), 1);
        assert_eq!(
            format(&Envelope::failure(
                "check",
                "CONTROL_UNAVAILABLE",
                "offline"
            ))
            .exit_code,
            1
        );
        assert_eq!(
            format(&Envelope::failure(
                "check",
                "REVISION_REQUIRED",
                "needs revision"
            ))
            .exit_code,
            2
        );
        let output = format(&Envelope::success(
            "bad\ncommand",
            None,
            Value::String("x".repeat(128 * 1024)),
        ));
        assert_eq!(output.exit_code, 1);
        assert!(output.line.len() < 128 * 1024);
        let value: Value = serde_json::from_str(&output.line).unwrap();
        assert_eq!(value["code"], "OUTPUT_LIMIT");
        assert_eq!(value["command"], "bad_command");
        let value =
            serde_json::to_value(Envelope::failure("check", "NO", "bad\nvalue\u{0}")).unwrap();
        assert_eq!(value["detail"], "bad value ");
    }
}
