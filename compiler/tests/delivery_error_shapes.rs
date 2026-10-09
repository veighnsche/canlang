//! Delivery errors retain their closed nullable schema and authorized receipt leaf.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::ResolvedType;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

const SOURCE: &str = "app DeliveryErrors\nuse std {EmailV1 as Mail} from=deployment.mail\nuse producer {Documents} from=deployment.documents\nGiven\n Entry {local:delivery(Documents.invoice)?,standard:delivery(Mail.send)?}\n policy Entry read=members fields=local.error,standard.error\n derive local(entry:Entry):text? = entry.local?.error?.code\n derive standard(entry:Entry):text? = entry.standard?.error?.message\nWhen\n scenario completed on=Documents.invoice.completed\n  do\n   let message=event.error?.message\n   let code=event.error?.code\n   let status=event.status\nThen\npackage producer\n Given\n  export contract Ack {ok:bool}\n  export capability Documents version=1\n   invoice() -> Ack\n When\n Then\n";

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
        .find_map(|(key, ty)| {
            (source[key.start as usize..key.end as usize].trim() == expression).then_some(ty)
        })
        .unwrap_or_else(|| panic!("missing checked expression: {expression}"))
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
