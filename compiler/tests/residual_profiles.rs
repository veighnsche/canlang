//! Lane D residual profiles: app-source shapes that clear the
//! formatted/filter/stat/collapse/history sites through their owning
//! factory profiles. Each test drives check -> IR build -> full JS
//! emission (including scenario bodies), so factory-table and
//! presentation-sink gaps fail here too.
//!
//! Locked refusals (the seal): raw money stat headers keep refusing
//! (the stat factory renders TextValue only); bare `history` outside an
//! owning collection row keeps refusing; derived-bool and nullable-user
//! filter selectors keep refusing; bare `skeleton` keeps refusing.
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| {
            format!(
                "{}:{} @{}-{}",
                d.code, d.message, d.primary.start, d.primary.end
            )
        })
        .collect()
}

fn emit_all(source: &str) -> Vec<String> {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.into());
    let (checked, check_diags) = check_program(&db, &[file], None);
    let mut out: Vec<String> = codes(&check_diags);
    if !check_diags.is_empty() {
        return out;
    }
    let (program, build_diags) = ir::build(&checked, &db, None);
    out.extend(codes(&build_diags));
    if !build_diags.is_empty() {
        return out;
    }
    for module in &program.modules {
        for page in &module.pages {
            for node in &page.render {
                let mut emitter = js::Emitter::new(&program);
                let _ = emitter.lower_ui(node);
                let (diags, _, _, _) = emitter.finish();
                out.extend(codes(&diags));
            }
        }
    }
    let js_out = js::emit_program(&program);
    out.extend(codes(&js_out.diagnostics));
    out
}

fn assert_lowers(source: &str) {
    let diags = emit_all(source);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
}

fn assert_refuses(source: &str, code: &str, fragment: &str) {
    let diags = emit_all(source);
    assert!(
        diags.iter().any(|d| d.starts_with(&format!("{code}:")))
            && diags.iter().any(|d| d.contains(fragment)),
        "expected {code} containing {fragment:?}, got: {diags:?}"
    );
}

/// CanDesk triage filters (assignee/unassigned/overdue) intentionally have
/// no test here: clearing them by deleting UI controls is rejected by
/// review gate 20261022_04. They need an exact checked filter profile with
/// positive runtime-backed coverage; the two Desk diagnostics stay refused
/// until that profile lands.

/// Recorded CanField shape: the pending-confirmation collapse carries a
/// `loading` placeholder (the renderState loading visual) instead of the
/// profile-less bare `skeleton`.
#[test]
fn collapse_with_loading_placeholder_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Job { state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}} }\n policy Job read=public\nWhen\nThen\n page /j title=\"J\"\n  list Job columns=state\n   collapse \"Confirm\"\n    require row.state==open\n    loading\n",
    );
}

/// Bare `skeleton` keeps refusing alongside its empty collapse.
#[test]
fn bare_skeleton_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Job { state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}} }\n policy Job read=public\nWhen\nThen\n page /j title=\"J\"\n  list Job columns=state\n   collapse \"Confirm\"\n    require row.state==open\n    skeleton\n",
        "E6008",
        "no supported source-to-factory profile",
    );
}

/// Recorded CanRefer/CanPurchase shape: money balances render through a
/// money-param message (the checked-message sink formats money with the
/// page currency scales), one stat per value header.
#[test]
fn money_stats_through_message_calls_lower() {
    assert_lowers(
        "app Probe\nGiven\n message money_amount(amount:money) = \"{amount}\"@{nl=\"{amount}\"}\n Advocate { earned:money, paid:money, available:money, owed:money }\n policy Advocate read=public\nWhen\nThen\n page /r title=\"R\"\n  list Advocate columns=earned,paid\n   stat money_amount(row.earned),money_amount(row.paid),money_amount(row.available),money_amount(row.owed)\n",
    );
}

/// A url-param message call lowers through the same message sink.
#[test]
fn url_message_param_call_lowers() {
    assert_lowers(
        "app Probe\nGiven\n message link_line(label:text,target:url) = \"{label}: {target}\"@{nl=\"{label}: {target}\"}\n Registration { name:text, site:url }\n policy Registration read=public\nWhen\nThen\n page /r title=\"R\"\n  list Registration columns=name,site\n   stat link_line(row.name,row.site)\n",
    );
}

/// Recorded CanInvoice shape: the record-page audit trail wraps in a
/// single-row owning list with a data-only identity where.
#[test]
fn record_page_history_through_owning_list_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Invoice { number:text }\n policy Invoice read=public\nWhen\nThen\n page /finance/invoice/{Invoice.id} title=\"I\"\n  list Invoice as invoice where invoice.id==row.id\n   history\n",
    );
}

/// Bare page-level `history` keeps refusing without an owning row.
#[test]
fn page_level_history_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Invoice { number:text }\n policy Invoice read=public\nWhen\nThen\n page /finance/invoice/{Invoice.id} title=\"I\"\n  card \"C\"\n   text row.number\n  history\n",
        "E6008",
        "bare history needs an owning collection row",
    );
}
