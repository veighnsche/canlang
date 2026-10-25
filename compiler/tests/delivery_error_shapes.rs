//! Delivery errors retain their closed nullable schema and authorized receipt leaf.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = "app DeliveryErrors\nuse std {EmailV1 as Mail} from=deployment.mail\nuse producer {Documents} from=deployment.documents\nGiven\n Entry {local:delivery(Documents.invoice)?,standard:delivery(Mail.send)?}\n policy Entry read=members fields=local.error,standard.error\n derive local(entry:Entry):text? = entry.local?.error?.code\n derive standard(entry:Entry):text? = entry.standard?.error?.message\nWhen\n scenario completed on=Documents.invoice.completed\n  do\n   let message=event.error?.message\n   let code=event.error?.code\n   let status=event.status\nThen\npackage producer\n Given\n  export contract Ack {ok:bool}\n  export capability Documents version=1\n   invoice() -> Ack\n When\n Then\n";

const STANDARD_EVENT_SOURCE: &str = r#"app StandardEvents
use std {PaymentsV1 as Cash} from=deployment.cash
use std {MailboxV1 as Post} from=deployment.post
Given
 derive text_value(value:text):text = value
When
 scenario payment_changed on=Cash.changed
  do
   let payload=event
   let status=event.status
   let waiting=event.status==pending
   let caller=actor
   if event.provider_reference!=null
    let provider=text_value(event.provider_reference)
  examples event={reference="payment",revision=1,provider_reference=null,amount=money("1.00","EUR"),status=pending,checkout_url=null,failure=null}
   event.status -> event.status
   pending -> pending
   succeeded -> succeeded
 scenario mail_received on=Post.received
  do
   let email=event.value
   let source=event.value.source
   let files=event.value.attachments
  examples event={value={mailbox="box",source="source",thread="thread",sender="sender",reply_to=null,subject="subject",body="body",body_complete=true,attachments=[],attachment_count=0,attachments_complete=true,received=datetime("2026-10-01T00:00:00Z")}}
   event.value.source -> event.value.subject
   "source" -> "subject"
Then
"#;

fn catalog() -> Catalog {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn check(source: &str, catalog: &Catalog) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("delivery-errors.can".into(), source.into());
    check_program(&db, &[id], Some(catalog))
}

fn type_at<'a>(checked: &'a CheckedProgram, source: &str, expression: &str) -> &'a ResolvedType {
    checked
        .types
        .node_types
        .iter()
        .filter(|(key, _)| source[key.start as usize..key.end as usize].trim() == expression)
        .min_by_key(|(key, _)| key.start)
        .map(|(_, ty)| ty)
        .unwrap_or_else(|| panic!("missing checked expression: {expression}"))
}

fn standard_completion_source(capability: &str, op: &str) -> String {
    let result = if capability == "EmailV1" {
        r#"{reference="accepted"}"#
    } else {
        r#"{reference="accepted",revision=1,provider_reference=null,amount=money("1.00","EUR"),status=pending,checkout_url=null,failure=null}"#
    };
    format!(
        r#"app StandardCompletion
use std {{{capability} as Wire}} from=deployment.wire
Given
When
 scenario observe on=Wire.{op}.completed
  do
   let id=event.delivery_id
   let terminal=event.status==succeeded
   let status=event.status
   let result=event.result
   let reference=event.result?.reference
   let message=event.error?.message
   let error=event.error
   if event.result!=null
    let present=event.result.reference
   if event.error!=null
    let code=event.error.code
  examples event={{delivery_id="delivery",status=succeeded,result={result},error=null}}
   event.result.reference -> event.status
   "accepted" -> succeeded
Then
"#
    )
}

#[test]
fn standard_completions_keep_declared_nullable_results_and_checked_source_identity() {
    use canlang_compiler::analysis::effects::HandlerSource;
    use canlang_compiler::analysis::types::Scalar;
    let catalog = catalog();
    for (capability, op) in [
        ("EmailV1", "send"),
        ("PaymentsV1", "collect"),
        ("PaymentsV1", "refund"),
        ("PaymentsV1", "cancel"),
        ("PaymentsV1", "reconcile"),
    ] {
        let source = standard_completion_source(capability, op);
        let (checked, diagnostics) = check(&source, &catalog);
        assert!(diagnostics.is_empty(), "{capability}.{op}: {diagnostics:?}");
        assert_eq!(
            type_at(&checked, &source, "event.delivery_id"),
            &ResolvedType::Scalar(Scalar::Text)
        );
        assert!(
            matches!(type_at(&checked, &source, "event.status"), ResolvedType::Enum {cases,owner:None}
            if cases == &["succeeded","failed","unknown","skipped"])
        );
        let ResolvedType::Nullable(result) = type_at(&checked, &source, "event.result") else {
            panic!("completion result must stay nullable: {capability}.{op}");
        };
        let fields = match result.as_ref() {
            ResolvedType::Object(fields) if capability == "EmailV1" => fields,
            ResolvedType::StdNominal {
                name: "PaymentState",
                fields,
            } if capability == "PaymentsV1" => fields,
            _ => panic!("completion result must retain its declared schema: {result:?}"),
        };
        let names: Vec<_> = fields.iter().map(|(name, _)| name.as_str()).collect();
        if capability == "EmailV1" {
            assert_eq!(names, ["reference"]);
        } else {
            assert_eq!(
                names,
                [
                    "reference",
                    "revision",
                    "provider_reference",
                    "amount",
                    "status",
                    "checkout_url",
                    "failure"
                ]
            );
            assert!(matches!(&fields[4].1, ResolvedType::Enum {cases,owner:None}
                if cases == &["pending","unknown","succeeded","failed"]));
            let start = source.find("status=pending").unwrap() + "status=".len();
            assert!(
                checked
                    .types
                    .resolved_cases
                    .iter()
                    .any(|key| key.start <= start as u32 && (start as u32) < key.end)
            );
        }
        assert!(
            matches!(type_at(&checked, &source, "event.error"), ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Object(fields)
                if fields == &vec![("code".into(),ResolvedType::Scalar(Scalar::Text)),("message".into(),ResolvedType::Scalar(Scalar::Text))]))
        );
        assert!(
            matches!(type_at(&checked, &source, "event.result?.reference"), ResolvedType::Nullable(inner)
            if inner.as_ref() == &ResolvedType::Scalar(Scalar::Text))
        );
        let start =
            source.find("let present=event.result.reference").unwrap() + "let present=".len();
        assert!(
            checked
                .types
                .node_types
                .iter()
                .any(|(key, ty)| key.start <= start as u32
                    && (start as u32) < key.end
                    && source[key.start as usize..key.end as usize].trim()
                        == "event.result.reference"
                    && ty == &ResolvedType::Scalar(Scalar::Text)),
            "explicit nullable-result guard must narrow the body reference"
        );
        let scenario = checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "StandardCompletion.observe")
            .unwrap();
        assert_eq!(checked.types.std_delivery_completion_handlers.len(), 1);
        let completion = checked
            .types
            .std_delivery_completion_handlers
            .values()
            .next()
            .unwrap();
        let module = &checked.modules[scenario.module.0 as usize];
        let import = &module.imports[0];
        assert_eq!(
            completion.canonical_operation,
            format!("std.{capability}.{op}")
        );
        assert_eq!(
            completion.result_type,
            if capability == "EmailV1" {
                "EmailAccepted"
            } else {
                "PaymentState"
            }
        );
        assert_eq!(completion.module, module.id);
        assert_eq!(completion.alias, "Wire");
        assert_eq!(completion.import_span, import.span);
        assert_eq!(
            completion.binding.as_deref(),
            Some("StandardCompletion.Wire")
        );
        assert_eq!(completion.from.as_deref(), Some("deployment.wire"));
        assert!(matches!(&checked.effects.scenarios[&scenario.id].on,
            Some(HandlerSource::StdDeliveryCompleted {capability:canonical,op:operation,source:identity})
                if canonical == &format!("std.{capability}") && operation == op
                    && identity == &format!("StandardCompletion.Wire.{op}.completed")));
    }
}

#[test]
fn standard_completion_provenance_selects_the_authored_alias_and_preserves_unbound_imports() {
    let catalog = catalog();
    let source = r#"app CompletionRoutes
use std {EmailV1 as Secondary} from=deployment.secondary
use std {EmailV1 as Primary} from=deployment.primary
Given
When
 scenario observe_primary on=Primary.send.completed
  do
   let id=event.delivery_id
 scenario observe_secondary on=Secondary.send.completed
  do
   let id=event.delivery_id
Then
"#;
    let (checked, diagnostics) = check(source, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.std_delivery_completion_handlers.len(), 2);
    let module = checked
        .modules
        .iter()
        .find(|module| module.name == "CompletionRoutes")
        .unwrap();
    for (alias, route) in [
        ("Primary", "deployment.primary"),
        ("Secondary", "deployment.secondary"),
    ] {
        let identity = format!("CompletionRoutes.{alias}.send.completed");
        let completion = checked
            .types
            .std_delivery_completion_handlers
            .values()
            .find(|completion| completion.source == identity)
            .unwrap();
        let import = module
            .imports
            .iter()
            .find(|import| import.members.iter().any(|member| member.alias == alias))
            .unwrap();
        assert_eq!(completion.canonical_operation, "std.EmailV1.send");
        assert_eq!(completion.result_type, "EmailAccepted");
        assert_eq!(completion.module, module.id);
        assert_eq!(completion.alias, alias);
        assert_eq!(completion.import_span, import.span);
        assert_eq!(
            completion.binding,
            Some(format!("CompletionRoutes.{alias}"))
        );
        assert_eq!(completion.from.as_deref(), Some(route));
    }

    let unbound =
        standard_completion_source("EmailV1", "send").replace(" from=deployment.wire", "");
    let (checked, diagnostics) = check(&unbound, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.std_delivery_completion_handlers.len(), 1);
    let completion = checked
        .types
        .std_delivery_completion_handlers
        .values()
        .next()
        .unwrap();
    assert_eq!(completion.canonical_operation, "std.EmailV1.send");
    assert_eq!(completion.result_type, "EmailAccepted");
    assert_eq!(completion.source, "StandardCompletion.Wire.send.completed");
    assert_eq!(completion.alias, "Wire");
    let module = &checked.modules[completion.module.0 as usize];
    assert_eq!(module.name, "StandardCompletion");
    assert_eq!(completion.import_span, module.imports[0].span);
    assert_eq!(completion.binding, None);
    assert_eq!(completion.from, None);
}

#[test]
fn ambiguous_standard_completion_imports_do_not_acquire_checked_provenance() {
    let catalog = catalog();
    let original = standard_completion_source("EmailV1", "send");
    for duplicate in [
        "use std {EmailV1 as Wire} from=deployment.second",
        "use std {PaymentsV1 as Wire} from=deployment.second",
    ] {
        let source = original.replace(
            "use std {EmailV1 as Wire} from=deployment.wire",
            &format!("use std {{EmailV1 as Wire}} from=deployment.first\n{duplicate}"),
        );
        assert_ne!(source, original, "control must change source");
        let (checked, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E2002"),
            "{duplicate}: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("E1")),
            "{diagnostics:?}"
        );
        assert!(
            checked.types.std_delivery_completion_handlers.is_empty(),
            "ambiguous import acquired provenance: {duplicate}"
        );
    }
}

#[test]
fn standard_completion_checks_reject_unknown_targets_unsafe_reads_and_wrong_examples() {
    let catalog = catalog();
    let original = standard_completion_source("EmailV1", "send");
    for (before, after, code) in [
        ("Wire.send.completed", "Wire.missing.completed", "E3010"),
        ("Wire.send.completed", "Wire.send.finished", "E3010"),
        ("Wire.send.completed", "Wire.send.progressed", "E3010"),
        ("use std", "use vendor", "E3010"),
        ("EmailV1 as Wire", "MissingV1 as Wire", "E3010"),
        ("EmailV1 as Wire", "PaymentState as Wire", "E3010"),
        ("event.status==succeeded", "event.status==pending", "E2001"),
        ("event.result?.reference", "event.result.reference", "E3003"),
        ("event.error?.message", "event.error.message", "E3003"),
        ("event.result?.reference", "event.result?.unknown", "E2013"),
        ("event.error?.message", "event.error?.details", "E2013"),
        (
            "if event.result!=null",
            "if event.status==succeeded",
            "E3003",
        ),
        ("if event.error!=null", "if event.status==failed", "E3003"),
        (
            "let terminal=event.status==succeeded",
            "let succeeded=\"shadow\"\n   let terminal=event.status==succeeded",
            "E3002",
        ),
        (
            "status=succeeded,result=",
            "status=pending,result=",
            "E2001",
        ),
        (
            "event.result.reference ->",
            "event.result.unknown ->",
            "E5002",
        ),
    ] {
        let source = original.replace(before, after);
        assert_ne!(source, original, "control must change the source: {before}");
        let (checked, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{after}: expected {code}, got {diagnostics:?}"
        );
        if code == "E3010" {
            assert!(
                checked.types.std_delivery_completion_handlers.is_empty(),
                "rejected source acquired provenance: {after}"
            );
        }
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("E1")),
            "semantic negative must parse: {after}: {diagnostics:?}"
        );
    }

    // Released standard terminal transport retains its original checked completion inventory.
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("standard-completion.can");
    std::fs::write(&path, original).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let js = value["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        js.contains("standardCompletions:"),
        "missing checked terminal source: {js}"
    );
    assert!(
        js.contains("StandardCompletion.Wire.send.completed"),
        "{js}"
    );
}

#[test]
fn standard_declared_events_share_their_own_fields_with_body_examples_and_effects() {
    use canlang_compiler::analysis::effects::HandlerSource;
    use canlang_compiler::analysis::types::Scalar;
    let catalog = catalog();
    let (checked, diagnostics) = check(STANDARD_EVENT_SOURCE, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let start = STANDARD_EVENT_SOURCE.find("let payload=event").unwrap() + "let payload=".len();
    let payload = checked
        .types
        .node_types
        .iter()
        .find_map(|(key, ty)| {
            (key.start <= start as u32
                && (start as u32) < key.end
                && STANDARD_EVENT_SOURCE[key.start as usize..key.end as usize].trim() == "event")
                .then_some(ty)
        })
        .unwrap();
    let ResolvedType::StdNominal {
        name: "PaymentState",
        fields,
    } = payload
    else {
        panic!("changed event must retain its declared nominal schema: {payload:?}");
    };
    assert!(fields.iter().map(|(name, _)| name.as_str()).eq([
        "reference",
        "revision",
        "provider_reference",
        "amount",
        "status",
        "checkout_url",
        "failure"
    ]));
    assert!(
        matches!(type_at(&checked, STANDARD_EVENT_SOURCE, "event.status"), ResolvedType::Enum {cases,owner:None}
        if cases == &["pending","unknown","succeeded","failed"])
    );
    assert_eq!(
        type_at(&checked, STANDARD_EVENT_SOURCE, "actor"),
        &ResolvedType::Null
    );
    assert!(
        matches!(type_at(&checked, STANDARD_EVENT_SOURCE, "event.value"), ResolvedType::StdNominal {name: "IncomingEmail", fields}
        if fields.iter().map(|(name,_)| name.as_str()).eq(["mailbox","source","thread","sender","reply_to","subject","body","body_complete","attachments","attachment_count","attachments_complete","received"]))
    );
    assert_eq!(
        type_at(&checked, STANDARD_EVENT_SOURCE, "event.value.source"),
        &ResolvedType::Scalar(Scalar::Text)
    );
    assert!(
        matches!(type_at(&checked, STANDARD_EVENT_SOURCE, "event.value.attachments"), ResolvedType::Array {element,..}
        if element.as_ref() == &ResolvedType::Scalar(Scalar::File))
    );
    for (scenario, capability, event, source) in [
        (
            "payment_changed",
            "std.PaymentsV1",
            "changed",
            "StandardEvents.Cash.changed",
        ),
        (
            "mail_received",
            "std.MailboxV1",
            "received",
            "StandardEvents.Post.received",
        ),
    ] {
        let symbol = checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == format!("StandardEvents.{scenario}"))
            .unwrap();
        assert!(
            matches!(&checked.effects.scenarios[&symbol.id].on, Some(HandlerSource::StdCapabilityEvent {capability:c,event:e,source:s})
            if c==capability && e==event && s==source)
        );
    }
}

#[test]
fn standard_declared_events_refuse_unknown_fields_targets_and_transport() {
    let catalog = catalog();
    for (before, after, code) in [
        ("Cash.changed", "Cash.missing", "E3010"),
        ("Cash.changed", "Cash.collect", "E3010"),
        ("Post.received", "Post.reply", "E3010"),
        ("use std", "use vendor", "E3010"),
        ("PaymentsV1 as Cash", "MissingV1 as Cash", "E3010"),
        ("PaymentsV1 as Cash", "PaymentState as Cash", "E3010"),
        ("event.status==pending", "event.status==skipped", "E2001"),
        ("let status=event.status", "let error=event.error", "E2013"),
        ("event.value.source", "event.value.unknown", "E2013"),
        (
            "if event.provider_reference!=null",
            "if event.status==succeeded",
            "E3001",
        ),
        (
            "let waiting=event.status==pending",
            "let pending=\"shadow\"\n   let waiting=event.status==pending",
            "E3002",
        ),
        (
            "status=pending,checkout_url",
            "status=skipped,checkout_url",
            "E2001",
        ),
        ("event.status ->", "event.unknown ->", "E5002"),
    ] {
        let source = STANDARD_EVENT_SOURCE.replace(before, after);
        assert_ne!(source, STANDARD_EVENT_SOURCE, "{before}");
        let (_, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{after}: expected{code}, {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("E1")),
            "semantic negative must parse: {after}: {diagnostics:?}"
        );
    }
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("standard-events.can");
    std::fs::write(&path, STANDARD_EVENT_SOURCE).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        value["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"
                && diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("checked selected-call binding is not published")),
        "{value}"
    );
}

#[test]
fn delivery_errors_are_closed_nullable_values_and_completions_exclude_pending() {
    let catalog = catalog();
    let (checked, diagnostics) = check(SOURCE, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for expression in ["event.error", "entry.local?.error", "entry.standard?.error"] {
        assert!(
            matches!(type_at(&checked, SOURCE, expression), ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Object(fields)
                if fields == &vec![("code".into(), ResolvedType::Scalar(canlang_compiler::analysis::types::Scalar::Text)),("message".into(), ResolvedType::Scalar(canlang_compiler::analysis::types::Scalar::Text))])),
            "{expression}"
        );
    }
    for expression in [
        "event.error?.message",
        "event.error?.code",
        "entry.local?.error?.code",
        "entry.standard?.error?.message",
    ] {
        assert!(
            matches!(type_at(&checked, SOURCE, expression), ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Scalar(canlang_compiler::analysis::types::Scalar::Text))),
            "{expression}"
        );
    }
    assert!(
        matches!(type_at(&checked, SOURCE, "event.status"), ResolvedType::Enum {cases, owner:None}
        if cases == &["succeeded","failed","unknown","skipped"])
    );

    for (before, after, code) in [
        ("event.error?.message", "event.error.message", "E3003"),
        ("event.error?.message", "event.error?.details", "E2013"),
        (
            "entry.local?.error?.code",
            "entry.local?.error.code",
            "E3003",
        ),
        (
            "entry.standard?.error?.message",
            "entry.standard?.error?.retryable",
            "E2013",
        ),
        (
            "let status=event.status",
            "let status=event.status==pending",
            "E2001",
        ),
        (
            "let message=event.error?.message",
            "if event.status==failed\n    let message=event.error.message",
            "E3003",
        ),
    ] {
        let source = SOURCE.replace(before, after);
        let (_, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{after}: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("E1")),
            "semantic negative must parse: {after}: {diagnostics:?}"
        );
    }
    for result in [" -> Ack", " -> Ack?"] {
        let source = SOURCE
            .replace("invoice() -> Ack", &format!("invoice(){result}"))
            .replace(
                "let status=event.status",
                "let status=event.status\n   let got=event.result",
            );
        let (checked, diagnostics) = check(&source, &catalog);
        assert!(diagnostics.is_empty(), "{result}: {diagnostics:?}");
        let ty = type_at(&checked, &source, "event.result");
        let ack = checked
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == "producer.Ack")
            .unwrap();
        assert!(
            matches!(ty, ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Record {symbol,..} if *symbol==ack.id)),
            "local result must retain its owning declaration with one nullable wrapper: {ty:?}"
        );
        for op in ["reply", "reconcile"] {
            let source = format!(
                r#"app MailboxCompletion
use std {{MailboxV1 as Box}} from=deployment.box
Given
When
 scenario observe on=Box.{op}.completed
  do
   let result=event.result
   if event.result!=null
    let accepted=event.result.state==accepted
    let reference=event.result.reference
Then
"#
            );
            let (checked, diagnostics) = check(&source, &catalog);
            assert!(diagnostics.is_empty(), "MailboxV1.{op}: {diagnostics:?}");
            assert!(
                matches!(type_at(&checked, &source, "event.result"), ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Object(fields)
                if fields.iter().map(|(name,_)| name.as_str()).eq(["source","state","reference","detail"])))
            );
            assert!(
                matches!(type_at(&checked, &source, "event.result.state"), ResolvedType::Enum {cases,owner:None}
            if cases == &["accepted","not_sent","unknown"])
            );
            let (_, diagnostics) = check(
                &source.replace("event.result.reference", "event.result.unknown"),
                &catalog,
            );
            assert!(
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "E2013"),
                "{diagnostics:?}"
            );
        }
    }
    // Receipt status remains the published five-case vocabulary.
    let source = SOURCE
        .replace("entry.local?.error?.code", "entry.local?.status")
        .replace(
            "derive local(entry:Entry):text?",
            "derive local(entry:Entry):DeliveryResult.status?",
        )
        .replace(
            "use std {EmailV1",
            "use std {DeliveryResult}\nuse std {EmailV1",
        );
    let (checked, diagnostics) = check(&source, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        matches!(type_at(&checked, &source, "entry.local?.status"), ResolvedType::Nullable(inner)
        if matches!(inner.as_ref(), ResolvedType::Enum {cases,..} if cases.iter().any(|case| case == "pending") && cases.len()==5))
    );
}

#[test]
fn completion_status_assignment_bridge_is_exact_and_one_way() {
    let catalog = catalog();
    let source = SOURCE
        .replace("use std {EmailV1", "use std {DeliveryResult,OperationOutcome}\nuse std {EmailV1")
        .replace("Entry {local:", "Entry {receipt_status:DeliveryResult.status?,foreign:enum(succeeded,failed,unknown,skipped),outcome:OperationOutcome,local:")
        .replace("let status=event.status", "let status=event.status\n   for entry in Entry as row limit=1\n    set entry {receipt_status=event.status}");
    let (_, diagnostics) = check(&source, &catalog);
    assert!(
        diagnostics.is_empty(),
        "completion updates its owning receipt field: {diagnostics:?}"
    );
    for actual in ["entry.foreign", "entry.outcome.state"] {
        let refused = source.replace(
            "receipt_status=event.status",
            &format!("receipt_status={actual}"),
        );
        let (checked, diagnostics) = check(&refused, &catalog);
        assert!(
            matches!(type_at(&checked, &refused, actual), ResolvedType::Enum {owner,..}
            if owner.is_some() == (actual == "entry.foreign")),
            "negative retains its actual enum identity: {actual}"
        );
        let start =
            refused.find(&format!("receipt_status={actual}")).unwrap() + "receipt_status=".len();
        assert!(
            diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "E3001"
                    && diagnostic.primary.start <= start as u32
                    && (start as u32) < diagnostic.primary.end
            }),
            "foreign named or unrelated std enum must fail at its assignment: {actual}: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.code.starts_with("E1")),
            "{diagnostics:?}"
        );
    }

    // An ownerless terminal result refuses a nonnullable receipt enum,
    // without relying on a nullable-to-nonnullable mismatch for the refusal.
    let reverse = source.replacen("Given\n", "Given\n derive reverse(value:DeliveryResult.status):enum(succeeded,failed,unknown,skipped) = value\n", 1);
    let (checked, diagnostics) = check(&reverse, &catalog);
    assert!(
        matches!(type_at(&checked, &reverse, "value"), ResolvedType::Enum {cases,owner:None} if cases.len()==5 && cases.iter().any(|case| case=="pending"))
    );
    let result = checked
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "DeliveryErrors.reverse")
        .unwrap();
    assert!(
        matches!(&checked.types.symbol_results[&result.id], Some(ResolvedType::Enum {cases,owner:None}) if cases == &["succeeded","failed","unknown","skipped"])
    );
    let start = reverse.find(" = value").unwrap() + " = ".len();
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E3001"
                && diagnostic.primary.start <= start as u32
                && (start as u32) < diagnostic.primary.end
        }),
        "receipt enum must not flow into completion status: {diagnostics:?}"
    );
    assert!(
        diagnostics
            .iter()
            .all(|diagnostic| !diagnostic.code.starts_with("E1")),
        "{diagnostics:?}"
    );
}

#[cfg(unix)]
#[test]
fn delivery_error_reads_join_native_observer_and_nullable_set_clears_old_value() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("delivery-error-shapes.can");
    std::fs::write(&source, include_str!("fixtures/delivery-error-shapes.can")).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let output = std::process::Command::new("node")
        .arg(root.join("compiler/tests/fixtures/delivery-error-shapes-consumer.mjs"))
        .arg(root)
        .arg(artifact)
        .arg(scratch.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stdout));
}

const CALLBACK_DIAGNOSTIC_SOURCE: &str = r#"app CallbackDiagnostics
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Entry {request:delivery(LLM.generate)?}
 policy Entry read=members fields=request.error,request.callback_diagnostics
When
 scenario inspect(entry:Entry) by=members
  do
   let diagnostics=entry.request?.callback_diagnostics
   if diagnostics!=null
    let outcome=diagnostics.outcome
    if diagnostics.outcome=="complete"
     let failures=diagnostics.failures
     let snapshot=diagnostics.snapshotAttribution
     for failure in diagnostics.failures limit=10
      let delivery= failure.deliveryId
      let source= failure.sourceOccurrence
      let occurrence= failure.occurrenceId
      let handler= failure.handler
      let eventName= failure.event
      let recorded= failure.recordedAtMs
      let code= failure.code
      let message= failure.message
    else
     let reason=diagnostics.reason
 scenario receive on=LLM.generate.progressed
  do
   let id=event.delivery_id
Then
"#;

#[test]
fn generation_callback_diagnostics_have_closed_discriminated_source_types() {
    let catalog = catalog();
    let (checked, diagnostics) = check(CALLBACK_DIAGNOSTIC_SOURCE, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "entry.request?.callback_diagnostics"),
        ResolvedType::Nullable(inner) if matches!(inner.as_ref(), ResolvedType::StdNominal {name: "GenerationCallbackDiagnosticResult", fields}
            if fields.len() == 1 && fields[0].0 == "outcome"))
    );
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "diagnostics.failures"),
        ResolvedType::Array {element, ..} if matches!(element.as_ref(), ResolvedType::StdNominal {name: "GenerationCallbackFailure", fields} if fields.len() == 8))
    );
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "diagnostics.reason"),
        ResolvedType::Enum {cases, owner: None} if cases == &["store-profile", "bound-exceeded", "origin-correspondence", "occurrence-correspondence"])
    );
    assert!(matches!(
        type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "failure.recordedAtMs"),
        ResolvedType::Scalar(canlang_compiler::analysis::types::Scalar::Int)
    ));
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "failure.code"),
        ResolvedType::Enum {cases, owner: None} if cases == &["require-false"])
    );
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "failure.message"),
        ResolvedType::Enum {cases, owner: None} if cases == &["handler requirement rejected the occurrence"])
    );
    assert!(
        matches!(type_at(&checked, CALLBACK_DIAGNOSTIC_SOURCE, "diagnostics.snapshotAttribution"),
        ResolvedType::Enum {cases, owner: None} if cases == &["unsupported"])
    );
    assert_eq!(
        checked.types.delivery_selectors.len(),
        1,
        "protected observations must not enter ordinary receipt selectors"
    );

    let image = CALLBACK_DIAGNOSTIC_SOURCE
        .replace("TextGenerationV1 as LLM", "ImagesV1 as LLM")
        .replace("LLM.generate", "LLM.submit");
    let (_, diagnostics) = check(&image, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");

    let matched = r#"app CallbackMatch
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Entry {request:delivery(LLM.generate)?}
 policy Entry read=members fields=request.callback_diagnostics
When
 scenario inspect(entry:Entry) by=members
  do
   let diagnostics=entry.request?.callback_diagnostics
   if diagnostics!=null
    match diagnostics.outcome
     case complete
      let failures=diagnostics.failures
      let snapshot=diagnostics.snapshotAttribution
     case unsupported
      let reason=diagnostics.reason
Then
"#;
    let (_, diagnostics) = check(matched, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

#[test]
fn generation_callback_diagnostics_refuse_unknown_cross_arm_and_unchecked_origins() {
    let catalog = catalog();
    for source in [
        CALLBACK_DIAGNOSTIC_SOURCE.replace("diagnostics.failures", "diagnostics.reason"),
        CALLBACK_DIAGNOSTIC_SOURCE.replace("diagnostics.reason", "diagnostics.failures"),
        CALLBACK_DIAGNOSTIC_SOURCE.replace("failure.code", "failure.providerSnapshot"),
        CALLBACK_DIAGNOSTIC_SOURCE.replace(
            "    let outcome=diagnostics.outcome",
            "    let outcome=diagnostics.failures",
        ),
        CALLBACK_DIAGNOSTIC_SOURCE.replace(" from=deployment.llm", ""),
        CALLBACK_DIAGNOSTIC_SOURCE
            .replace(
                "scenario inspect(entry:Entry)",
                "scenario inspect(request:delivery(LLM.generate)?)",
            )
            .replace(
                "entry.request?.callback_diagnostics",
                "request?.callback_diagnostics",
            ),
    ] {
        let (_, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E2013"),
            "unchecked/unknown member should be refused: {diagnostics:?}"
        );
    }
    for source in [
        CALLBACK_DIAGNOSTIC_SOURCE
            .replace("TextGenerationV1 as LLM", "EmailV1 as LLM")
            .replace("LLM.generate", "LLM.send"),
        CALLBACK_DIAGNOSTIC_SOURCE.replace("TextGenerationV1 as LLM", "EmailV1 as LLM"),
    ] {
        let (_, diagnostics) = check(&source, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| matches!(diagnostic.code, "E3010" | "E2013")),
            "non-generation or forged original operation must be refused by its owning source/member check: {diagnostics:?}"
        );
    }
    let unknown = CALLBACK_DIAGNOSTIC_SOURCE.replace(
        "diagnostics.outcome==\"complete\"",
        "diagnostics.outcome==\"future\"",
    );
    let (_, diagnostics) = check(&unknown, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3002"),
        "unknown discriminant should be refused: {diagnostics:?}"
    );
}

#[test]
fn generation_callback_ui_value_lists_narrow_their_checked_aliases() {
    let catalog = catalog();
    let source = r#"app CallbackList
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Entry {request:delivery(LLM.generate)?}
 policy Entry read=members fields=request.callback_diagnostics
When
Then
 page / title="Callback history"
  list Entry
   list [row.request?.callback_diagnostics] as diagnostic
    card
     require diagnostic!=null
     card
      require diagnostic.outcome==unsupported
      alert tone=error
       text diagnostic.reason
     card
      require diagnostic.outcome==complete
      list diagnostic.failures as failure empty="No retained historical callback refusals."@{nl="Geen bewaarde historische callbackweigeringen."}
       alert tone=error
        text failure.code,failure.message
"#;
    let (checked, diagnostics) = check(source, &catalog);
    assert!(
        diagnostics.is_empty(),
        "source-only UI list/narrowing: {diagnostics:?}"
    );
    assert!(matches!(type_at(&checked, source, "diagnostic.failures"),
        ResolvedType::Array {element, ..} if matches!(element.as_ref(), ResolvedType::StdNominal {name: "GenerationCallbackFailure", ..})));
    assert!(matches!(type_at(&checked, source, "failure.message"),
        ResolvedType::Enum {cases, owner: None} if cases == &["handler requirement rejected the occurrence"]));
    assert!(matches!(type_at(&checked, source, "diagnostic.reason"),
        ResolvedType::Enum {cases, owner: None} if cases.len() == 4));
    let refused = source.replace(
        "text failure.code,failure.message",
        "text diagnostic.reason",
    );
    let (_, diagnostics) = check(&refused, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E2013"),
        "complete-arm UI cannot access unsupported fields: {diagnostics:?}"
    );
}
