//! Standard terminal handlers beyond trivial lets (CAN18-v1 outcome 9,
//! family D).
//!
//! `std.EmailV1.send` and the four `std.PaymentsV1` terminal operations
//! (`collect`/`refund`/`cancel`/`reconcile` → `PaymentState`) lower through
//! the native terminal carrier when the body stays inside the bounded
//! public profile: `for` delivery-correlation queries (`limit=1`, checked
//! event-correlated predicate), `if`/`else`, `require`, `let`, writes to
//! `for`-bound stored rows, and `emit ProviderReceipt`/`InvoiceSettlement`
//! feeds. Anything else (uncorrelated scans, other limits, unlisted
//! emissions, calls such as `any()`, context reads, parent chains) keeps
//! the fail-closed carrier refusal.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrEventSource, IrItemKind};
use canlang_compiler::codegen::js;
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

const EMAIL_SOURCE: &str = "app Terminal\nuse std {EmailV1 as Mail} from=deployment.mail\nGiven\n Notice { delivery:text, state:text }\n policy Notice read=members\nWhen\n scenario observed on=Mail.send.completed\n  do\n   for notice in Notice as row where row.delivery==event.delivery_id limit=1\n    if event.status==succeeded\n     set notice {state=\"sent\"}\n    else\n     set notice {state=\"failed\"}\nThen\n";

const PAYMENTS_SOURCE: &str = "app Terminal\nuse std {PaymentsV1 as Pay} from=deployment.pay\nuse std {PaymentState} from=deployment.pay\nGiven\n Attempt { delivery:text, reference:text, status:enum(pending,unknown,succeeded,failed) }\n policy Attempt read=members\n event ProviderReceipt { value:PaymentState }\nWhen\n scenario observed on=Pay.collect.completed\n  do\n   for attempt in Attempt as row where row.delivery==event.delivery_id and row.status in [pending,unknown] limit=1\n    if event.status==succeeded and event.result!=null\n     require event.result.reference==attempt.reference\n     emit ProviderReceipt {value=event.result}\n    else\n     set attempt {status=unknown}\nThen\n";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn catalog() -> Catalog {
    let path = root().join("packages/values/dist/catalog.json");
    let mut db = SourceDb::new();
    let id = db.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn checked(source: &str, catalog: &Catalog) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let id = db.add("payment-completion-handlers.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[id], Some(catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program)
}

fn handler_source(ir: &ir::IrProgram, canonical: &str) -> Option<IrEventSource> {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .and_then(|item| match &item.kind {
            IrItemKind::Scenario { event_source, .. } => event_source.clone(),
            _ => None,
        })
}

fn assert_carrier_refusal(source: &str, catalog: &Catalog, case: &str) {
    let mut db = SourceDb::new();
    let id = db.add("payment-completion-refused.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[id], Some(catalog));
    assert!(diagnostics.is_empty(), "{case}: {diagnostics:?}");
    let (_ir, diagnostics) = ir::build(&program, &db, Some(catalog));
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic
                    .message
                    .contains("standard handler triggers await the native terminal carrier")),
        "{case}: {diagnostics:?}"
    );
}

#[test]
fn email_correlation_query_with_branch_and_row_write_lowers() {
    let catalog = catalog();
    let (db, program) = checked(EMAIL_SOURCE, &catalog);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        matches!(
            handler_source(&ir, "Terminal.observed"),
            Some(IrEventSource::StandardCompleted { source, .. })
            if source == "Terminal.Mail.send.completed"
        ),
        "email terminal route"
    );
    let out = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    assert!(
        out.entry.js.contains("Terminal.Mail.send.completed"),
        "email terminal route publishes"
    );
}

#[test]
fn payments_collect_bounded_profile_lowers_with_typed_invocation() {
    let catalog = catalog();
    let (db, program) = checked(PAYMENTS_SOURCE, &catalog);
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(
        handler_source(&ir, "Terminal.observed"),
        Some(IrEventSource::StandardCompleted {
            source: "Terminal.Pay.collect.completed".into(),
            canonical_operation: "std.PaymentsV1.collect".into(),
            result_type: "PaymentState".into(),
            binding: "Terminal.Pay".into(),
            from: "deployment.pay".into(),
        })
    );
    let out = js::emit_program_with_native_source_receipts(&ir, false, &db);
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    for fragment in [
        "Terminal.Pay.collect.completed",
        "PaymentState",
        "ProviderReceipt",
        "invocation:",
    ] {
        assert!(
            out.entry.js.contains(fragment),
            "payments terminal publication {fragment}"
        );
    }
}

#[test]
fn unbounded_and_unlisted_terminal_bodies_still_refuse() {
    let catalog = catalog();
    // The original Invoice Attempt stores an optional delivery ID; widening
    // the admitted row comparison needs its own checked correlation proof.
    assert_carrier_refusal(
        &PAYMENTS_SOURCE.replace("delivery:text,", "delivery:text?,"),
        &catalog,
        "nullable delivery correlation",
    );
    // Other `limit` values are not the bounded delivery correlation.
    assert_carrier_refusal(
        &PAYMENTS_SOURCE.replace("limit=1", "limit=2"),
        &catalog,
        "limit 2",
    );
    // An uncorrelated scan stays out of the bounded profile.
    assert_carrier_refusal(
        "app Terminal\nuse std {PaymentsV1 as Pay} from=deployment.pay\nGiven\n Attempt { delivery:text }\n policy Attempt read=members\nWhen\n scenario observed on=Pay.collect.completed\n  do\n   for attempt in Attempt limit=1\n    set attempt {delivery=\"held\"}\nThen\n",
        &catalog,
        "uncorrelated scan",
    );
    // Only the two completion-feed events are admittable emissions.
    assert_carrier_refusal(
        "app Terminal\nuse std {PaymentsV1 as Pay} from=deployment.pay\nGiven\n event Stray { value:text }\nWhen\n scenario observed on=Pay.collect.completed\n  do emit Stray {value=\"x\"}\nThen\n",
        &catalog,
        "unlisted emission",
    );
    // `ErrorsV1.report` is outside the released terminal carriers.
    assert_carrier_refusal(
        "app Terminal\nuse std {ErrorsV1 as Problems} from=deployment.problems\nGiven\nWhen\n scenario observed on=Problems.report.completed\n  do let result=event.result\nThen\n",
        &catalog,
        "unreleased capability",
    );
    // Query calls (`any`, and likewise `max`/`count`/helper calls),
    // context reads and parent chains exceed the bounded profile: the
    // original invoice bodies need that follow-up surface.
    assert_carrier_refusal(
        "app Terminal\nuse std {PaymentsV1 as Pay} from=deployment.pay\nGiven\n Attempt { delivery:text, status:enum(pending,unknown,succeeded,failed) }\n policy Attempt read=members\nWhen\n scenario observed on=Pay.collect.completed\n  do\n   for attempt in Attempt as row where row.delivery==event.delivery_id limit=1\n    if any(Attempt as other, other.delivery==event.delivery_id)\n     set attempt {status=unknown}\nThen\n",
        &catalog,
        "query-call predicate",
    );
}
