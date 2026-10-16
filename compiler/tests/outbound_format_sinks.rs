//! Outcome 7: original human/outbound formatting sinks.
//!
//! Localized `format(descriptor,locale=...)` results lower at the recorded
//! human/outbound send positions — std mail subject/body and the pinned
//! `catch.AlertsV1.notify(value:Alert)` message path (DESIGN §9.1) — through
//! the shared formatter, frozen inline in the send args in authored order.
//! Guards, stored writes and every other formatted position keep refusing,
//! and the private-mail recipient path is untouched.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrItem, IrItemKind, IrProgram, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const MAIL_BOTH: &str = "app OutboundMail
use std {EmailV1 as Mail} from=deployment.mail
Given
 Entry {count:int=0,attempt:delivery(Mail.send)?}
 policy Entry read=members fields=count,attempt.status,attempt.result
When
 crud Entry by=owner fields=count
 scenario deliver(entry:Entry,enabled:bool) -> int by=owner
  do
   send Mail.send {to=\"recipient@example.test\",subject=format(\"Visit completed\"@{nl=\"Bezoek afgerond\"},locale=null),body=format(\"Review your current shifts.\"@{nl=\"Bekijk je huidige diensten.\"},locale=null)} when=enabled as attempt
   set entry {count=entry.count+1,attempt=attempt}
   return entry.count
Then
";

const MAIL_USER: &str = "app OutboundMailUser
use std {EmailV1 as Mail} from=deployment.mail
Given
 Entry {count:int=0,user_attempt:delivery(Mail.send_user)?}
 policy Entry read=members fields=count,user_attempt.status,user_attempt.result
When
 crud Entry by=owner fields=count
 scenario invite(entry:Entry,person:user,enabled:bool) -> int by=owner
  do
   send Mail.send_user {to=person,subject=format(\"Workspace confirmed\"@{nl=\"Werkplek bevestigd\"},locale=null),body=\"Frozen body\"} when=enabled as user_attempt
   set entry {count=entry.count+1,user_attempt=user_attempt}
   return entry.count
Then
";

const NOTIFY_MESSAGE: &str = "app catch
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   send AlertsV1.notify {value={source=\"probe\",destination=target,message=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)}} when=enabled as attempt
   return 1
Then
";

const NOTIFY_HELPER: &str = "app catch
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   let held=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)
   send AlertsV1.notify {value={source=\"probe\",destination=target,message=held}} when=enabled as attempt
   return 1
Then
";

const NOTIFY_ALIAS: &str = "app CatchAlias uses=[catch,probe]
package catch
 Given
  export contract Alert { source:text, destination:url, message:text }
  export contract AlertAccepted { reference:text }
  export capability AlertsV1 version=1
   notify(value:Alert) -> AlertAccepted
 When
 Then
package probe
 use catch {AlertsV1 as Alerts}
 Given
 When
  scenario ping(target:url,enabled:bool) -> int by=members
   do
    send Alerts.notify {value={source=\"probe\",destination=target,message=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)}} when=enabled as attempt
    return 1
 Then
";

const NOTIFY_SOURCE: &str = "app catch
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   send AlertsV1.notify {value={source=format(\"probe\"@{nl=\"sonde\"},locale=null),destination=target,message=\"Missed\"}} when=enabled as attempt
   return 1
Then
";

const NOTIFY_FOREIGN: &str = "app probe
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   send AlertsV1.notify {value={source=\"probe\",destination=target,message=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)}} when=enabled as attempt
   return 1
Then
";

const NOTIFY_VERSION: &str = "app catch
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=2
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   send AlertsV1.notify {value={source=\"probe\",destination=target,message=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)}} when=enabled as attempt
   return 1
Then
";

const NOTIFY_SCHEMA: &str = "app catch
Given
 contract Alert { source:text, destination:url?, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   send AlertsV1.notify {value={source=\"probe\",message=format(\"Job heartbeat missed\"@{nl=\"Heartbeat van taak gemist\"},locale=null)}} when=enabled as attempt
   return 1
Then
";

const SEND_GUARD: &str = "app GuardedFormat
use std {EmailV1 as Mail} from=deployment.mail
Given
 Entry {count:int=0,attempt:delivery(Mail.send)?}
 policy Entry read=members fields=count,attempt.status,attempt.result
When
 crud Entry by=owner fields=count
 scenario deliver(entry:Entry,enabled:bool,note:text) -> int by=owner
  do
   send Mail.send {to=\"recipient@example.test\",subject=\"Visit\",body=\"Shifts\"} when=enabled and note==format(\"Confirm\"@{nl=\"Bevestigen\"},locale=null) as attempt
   set entry {count=entry.count+1,attempt=attempt}
   return entry.count
Then
";

const STORED_CREATE: &str = "app StoredFormat
Given
 Note {title:text}
 policy Note read=members fields=title
When
 scenario file(note:text) by=members
  do
   create Note {title=format(\"Filed\"@{nl=\"Gearchiveerd\"},locale=null)} as created
Then
";

const STORED_SET: &str = "app StoredSetFormat
Given
 Note {title:text}
 policy Note read=members fields=title
When
 scenario annotate(target:Note) by=members
  do
   set target {title=format(\"Refiled\"@{nl=\"Opnieuw gearchiveerd\"},locale=null)}
Then
";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner_root() -> PathBuf {
    let public = Path::new("/Users/vince/Projects/canlang");
    if public
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        public.into()
    } else {
        root()
    }
}

fn native_catalog() -> PathBuf {
    native_owner_root().join("packages/cloudflare/dist/native-catalog.json")
}

fn fixture(name: &str, source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(format!("{name}.can"), source.into());
    let path = native_catalog();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    (db, program, ir, catalog)
}

fn item<'a>(ir: &'a IrProgram, name: &str) -> &'a IrItem {
    ir.items.iter().find(|item| item.canonical == name).unwrap()
}

fn lower_sends(ir: &IrProgram, scenario: &str) -> (Vec<String>, Vec<String>) {
    let owner = item(ir, scenario);
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        panic!("{scenario} must be a scenario");
    };
    let mut emitter = js::Emitter::new(ir);
    let mut lines = Vec::new();
    for stmt in effects {
        if matches!(stmt, IrStmt::Send { .. }) {
            lines.extend(
                emitter
                    .lower_stmt(stmt, 1)
                    .into_iter()
                    .map(|(line, _)| line),
            );
        }
    }
    let (diags, _, _, _) = emitter.finish();
    let codes: Vec<String> = diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect();
    (lines, codes)
}

fn send_line(lines: &[String]) -> &str {
    lines
        .iter()
        .find(|line| line.contains("await send("))
        .expect("lowered send call")
}

#[test]
fn mail_send_subject_and_body_format_lower_frozen_in_order() {
    let (_db, _program, ir, _catalog) = fixture("outbound-mail", MAIL_BOTH);
    let (lines, diags) = lower_sends(&ir, "OutboundMail.deliver");
    assert!(diags.is_empty(), "{diags:?}");
    let send = send_line(&lines);
    assert!(send.contains("await send(c,\"std.EmailV1.send\""), "{send}");
    // Private recipient path stays a plain value, never formatted.
    assert!(send.contains("to:\"recipient@example.test\""), "{send}");
    let subject = send.find("subject:").expect("subject position");
    let body = send.find("body:").expect("body position");
    assert!(subject < body, "authored order preserved: {send}");
    // One frozen formatter evaluation per human-text field.
    assert_eq!(
        send.matches("6c6f63616c697a65645f666f726d6174").count(),
        2,
        "one frozen format call per field: {send}"
    );
}

#[test]
fn mail_send_user_subject_format_lowers_with_recipient_path_intact() {
    let (_db, _program, ir, _catalog) = fixture("outbound-mail-user", MAIL_USER);
    let (lines, diags) = lower_sends(&ir, "OutboundMailUser.invite");
    assert!(diags.is_empty(), "{diags:?}");
    let send = send_line(&lines);
    assert!(
        send.contains("await send(c,\"std.EmailV1.send_user\""),
        "{send}"
    );
    let subject = send.find("subject:").expect("subject position");
    let body = send.find("body:").expect("body position");
    assert!(subject < body, "authored order preserved: {send}");
    assert!(send.contains("subject:(("), "{send}");
}

#[test]
fn notify_value_message_format_lowers() {
    let (_db, _program, ir, _catalog) = fixture("notify-message", NOTIFY_MESSAGE);
    let (lines, diags) = lower_sends(&ir, "catch.ping");
    assert!(diags.is_empty(), "{diags:?}");
    let send = send_line(&lines);
    assert!(send.contains("catch.AlertsV1.notify"), "{send}");
    assert!(send.contains("message:(("), "{send}");
}

#[test]
fn notify_helper_bound_message_format_lowers() {
    let (_db, _program, ir, _catalog) = fixture("notify-helper", NOTIFY_HELPER);
    // Lower every effect in authored order like real emission, so the
    // immutable let alias is classified before the send consumes it.
    let owner = item(&ir, "catch.ping");
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        panic!("catch.ping must be a scenario");
    };
    let mut emitter = js::Emitter::new(&ir);
    let mut lines = Vec::new();
    for stmt in effects {
        lines.extend(
            emitter
                .lower_stmt(stmt, 1)
                .into_iter()
                .map(|(line, _)| line),
        );
    }
    let (diags, _, _, _) = emitter.finish();
    assert!(diags.is_empty(), "{diags:?}");
    let send = send_line(&lines);
    assert!(send.contains("catch.AlertsV1.notify"), "{send}");
    // The immutable alias evaluates the shared formatter exactly once at
    // the let and the sink references the frozen value: same meaning as
    // the inline shape, no duplicate evaluation.
    let all = lines.join("\n");
    assert_eq!(
        all.matches("6c6f63616c697a65645f666f726d6174").count(),
        1,
        "one frozen format evaluation total: {all}"
    );
    assert!(
        send.contains("message:$can$l$"),
        "sink references the frozen alias: {send}"
    );
}

const NOTIFY_HELPER_SOURCE: &str = "app catch
Given
 contract Alert { source:text, destination:url, message:text }
 contract AlertAccepted { reference:text }
 capability AlertsV1 version=1
  notify(value:Alert) -> AlertAccepted
When
 scenario ping(target:url,enabled:bool) -> int by=members
  do
   let held=format(\"probe\"@{nl=\"sonde\"},locale=null)
   send AlertsV1.notify {value={source=held,destination=target,message=\"Missed\"}} when=enabled as attempt
   return 1
Then
";

#[test]
fn notify_helper_bound_non_message_path_refuses() {
    let (_db, _program, ir, _catalog) = fixture("notify-helper-source", NOTIFY_HELPER_SOURCE);
    let owner = item(&ir, "catch.ping");
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        panic!("catch.ping must be a scenario");
    };
    let mut emitter = js::Emitter::new(&ir);
    let mut lines = Vec::new();
    for stmt in effects {
        lines.extend(
            emitter
                .lower_stmt(stmt, 1)
                .into_iter()
                .map(|(line, _)| line),
        );
    }
    let (diags, _, _, _) = emitter.finish();
    let codes: Vec<String> = diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect();
    // The alias is really classified (not vacuously admitted): a let-bound
    // format at a non-human-text path still refuses.
    assert!(
        codes
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "aliased value.source must refuse: {codes:?}"
    );
    let _ = lines;
}

#[test]
fn notify_imported_alias_format_lowers() {
    let (_db, _program, ir, _catalog) = fixture("notify-alias", NOTIFY_ALIAS);
    let (lines, diags) = lower_sends(&ir, "probe.ping");
    assert!(diags.is_empty(), "{diags:?}");
    let send = send_line(&lines);
    assert!(send.contains("catch.AlertsV1.notify"), "{send}");
    assert!(send.contains("message:(("), "{send}");
}

#[test]
fn notify_non_message_path_format_refuses() {
    let (_db, _program, ir, _catalog) = fixture("notify-source", NOTIFY_SOURCE);
    let (_lines, diags) = lower_sends(&ir, "catch.ping");
    assert!(
        diags
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "value.source must refuse: {diags:?}"
    );
}

#[test]
fn notify_unrelated_owner_format_refuses() {
    let (_db, _program, ir, _catalog) = fixture("notify-foreign", NOTIFY_FOREIGN);
    let (_lines, diags) = lower_sends(&ir, "probe.ping");
    assert!(
        diags
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "unrelated AlertsV1 owner must refuse: {diags:?}"
    );
}

#[test]
fn notify_altered_version_format_refuses() {
    let (_db, _program, ir, _catalog) = fixture("notify-version", NOTIFY_VERSION);
    let (_lines, diags) = lower_sends(&ir, "catch.ping");
    assert!(
        diags
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "altered capability version must refuse: {diags:?}"
    );
}

#[test]
fn notify_altered_schema_format_refuses() {
    let (_db, _program, ir, _catalog) = fixture("notify-schema", NOTIFY_SCHEMA);
    let (_lines, diags) = lower_sends(&ir, "catch.ping");
    assert!(
        diags
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "altered Alert schema must refuse: {diags:?}"
    );
}

#[test]
fn send_guard_format_refuses() {
    let (_db, _program, ir, _catalog) = fixture("send-guard", SEND_GUARD);
    let (_lines, diags) = lower_sends(&ir, "GuardedFormat.deliver");
    assert!(
        diags
            .iter()
            .any(|d| d.starts_with("E6008:") && d.contains("formatted")),
        "formatted guard must refuse: {diags:?}"
    );
}

#[test]
fn stored_create_with_format_refuses() {
    let mut db = SourceDb::new();
    let file = db.add("stored-create.can".into(), STORED_CREATE.into());
    let path = native_catalog();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    let mut codes: Vec<String> = diagnostics
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect();
    if diagnostics.is_empty() {
        let (ir, build_diags) = ir::build(&program, &db, Some(&catalog));
        codes.extend(
            build_diags
                .iter()
                .map(|d| format!("{}:{}", d.code, d.message)),
        );
        if build_diags.is_empty() {
            let mut emitter = js::Emitter::new(&ir);
            for item in &ir.items {
                if let IrItemKind::Scenario { effects, .. } = &item.kind {
                    for stmt in effects {
                        let _ = emitter.lower_stmt(stmt, 1);
                    }
                }
            }
            let (diags, _, _, _) = emitter.finish();
            codes.extend(diags.iter().map(|d| format!("{}:{}", d.code, d.message)));
        }
    }
    assert!(
        codes.iter().any(|d| d.contains("formatted")),
        "stored create with formatted title must refuse: {codes:?}"
    );
}

#[test]
fn stored_set_with_format_refuses() {
    let mut db = SourceDb::new();
    let file = db.add("stored-set.can".into(), STORED_SET.into());
    let path = native_catalog();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    let mut codes: Vec<String> = diagnostics
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect();
    if diagnostics.is_empty() {
        let (ir, build_diags) = ir::build(&program, &db, Some(&catalog));
        codes.extend(
            build_diags
                .iter()
                .map(|d| format!("{}:{}", d.code, d.message)),
        );
        if build_diags.is_empty() {
            let mut emitter = js::Emitter::new(&ir);
            for item in &ir.items {
                if let IrItemKind::Scenario { effects, .. } = &item.kind {
                    for stmt in effects {
                        let _ = emitter.lower_stmt(stmt, 1);
                    }
                }
            }
            let (diags, _, _, _) = emitter.finish();
            codes.extend(diags.iter().map(|d| format!("{}:{}", d.code, d.message)));
        }
    }
    assert!(
        codes.iter().any(|d| d.contains("formatted")),
        "stored set with formatted title must refuse: {codes:?}"
    );
}
