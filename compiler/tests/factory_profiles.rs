//! Outcome 6 (Lane B factory profiles): recorded original24 shapes lower
//! through their owning factory profiles.
//!
//! The original24 composition refuses 29 factory-profile occurrences at the
//! UI lowering stage. Each recorded shape below is admitted through its
//! owning profile, reusing the UI catalog contracts and the shared
//! collection pipeline: multi-value `stat` lowers through the single-value
//! stat profile (metrics-style visual join), `copy` takes string-carried
//! text/URL values, `radial_progress` takes body-free int/decimal values
//! with an int max, `steps` item slots take one text stage or one owning
//! status stage, `indicator` takes its content/indicator slots, and agenda
//! `calendar` without `columns=` keeps lowering. `timeline` bound
//! sequences and agenda `calendar columns=` have NO supported
//! source-to-factory profile: the owning TimelineProps takes prebuilt
//! items only (a bound emission throws reading items.length in the real
//! factory, REVIEW-21), and calendarAgenda never reads columns
//! (byte-identical output either way). Both stay loud E6008. A
//! standalone `filter preferences.field` retains its owned finite-choice
//! declaration and versioned page-save binding.
//! `collapse` and headed `hero` with nonempty suites already lower (locked
//! here); their composition occurrences are cascades of other lanes'
//! inner refusals. Anything outside the recorded set keeps the exact E6008
//! refusals below, including inline `preferences` panels, which need the
//! settings save production no owned contract provides.
//! Catalog-free: every test drives check -> IR build -> per-page JS UI
//! lowering in process.
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::{ir, js};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

fn codes(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| format!("{}:{}", d.code, d.message))
        .collect()
}

/// Full UI pipeline: check, IR build, then JS lowering of every page render
/// node (catches factory-table and prop-admission gaps too).
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

/// Recorded CanMember/CanRefer/CanSuccess shape: one stat per value header
/// through the single-value stat profile.
#[test]
fn multi_value_stat_lowers_as_single_value_stats() {
    assert_lowers(
        "app Probe\nGiven\n Allowance { granted:int, available:int }\n policy Allowance read=public\nWhen\nThen\n page /a title=\"A\"\n  list Allowance columns=granted,available\n   stat row.granted,row.available\n",
    );
}

/// Recorded CanMember shape: decimal values lower header by header.
#[test]
fn multi_value_decimal_stat_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Allowance { granted:decimal, available:decimal }\n policy Allowance read=public\nWhen\nThen\n page /a title=\"A\"\n  list Allowance columns=granted,available\n   stat row.granted,row.available\n",
    );
}

/// Recorded CanRefer/CanPurchase shape: money values have no stat value
/// profile (the owning stat factory renders TextValue only; raw money
/// row values throw), so multi-value money stats keep their refusal.
#[test]
fn multi_value_money_stat_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Budget { total:money, spent:money }\n policy Budget read=public\nWhen\nThen\n page /b title=\"B\"\n  list Budget columns=total,spent\n   stat row.total,row.spent\n",
        "E6008",
        "only one value header",
    );
}

/// Recorded CanPropose/CanAffiliate/CanRefer shape: a URL value copies as
/// its string (an owned URL field; the `app_url(format(...))` spelling is
/// covered by the binary probe since builtins need the installed catalog).
#[test]
fn url_copy_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, site:url }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  list Customer columns=name\n   copy row.site\n",
    );
}

/// Recorded CanSuccess shape: a decimal completion fraction with an int
/// max.
#[test]
fn decimal_radial_progress_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Account { title:text }\n derive Account.progress:decimal = 50/100 label=\"P\"\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   radial_progress row.progress max=100\n",
    );
}

/// Plain int radial progress keeps lowering.
#[test]
fn int_radial_progress_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Account { done:int }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=done\n   radial_progress row.done max=10\n",
    );
}

/// Recorded CanContract shape: each lifecycle stage shows its live status
/// flag beside the frozen record.
#[test]
fn steps_with_status_stages_lower() {
    assert_lowers(
        "app Probe\nGiven\n Term { executed:bool=false, expired:bool=false }\n policy Term read=public\nWhen\nThen\n page /t title=\"T\"\n  list Term columns=executed\n   steps\n    slot item\n     status row.executed\n    slot item\n     status row.expired\n",
    );
}

/// Text stages keep lowering.
#[test]
fn steps_with_text_stages_lower() {
    assert_lowers(
        "app Probe\nGiven\n Term { name:text }\n policy Term read=public\nWhen\nThen\n page /t title=\"T\"\n  list Term columns=name\n   steps\n    slot item\n     text \"First\"\n    slot item\n     text row.name\n",
    );
}

/// Recorded CanField shape: explicit content plus indicator slots.
#[test]
fn indicator_slots_lower() {
    assert_lowers(
        "app Probe\nGiven\n Job { address:text, state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}} }\n policy Job read=public\nWhen\nThen\n page /j title=\"J\"\n  list Job columns=address\n   indicator\n    slot content\n     text row.address
    slot indicator
     badge row.state
",
    );
}

/// A headed hero with a nonempty suite already lowers (locked here).
#[test]
fn headed_hero_with_suite_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  hero \"Welcome\"\n   text \"Body\"\n",
    );
}

/// A collapse with a nonempty suite already lowers (locked here).
#[test]
fn collapse_with_suite_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  collapse \"Details\"\n   text \"Body\"\n",
    );
}

/// Recorded CanStock timeline: a bound child sequence has no items-based
/// factory profile. The owning TimelineProps takes prebuilt items only,
/// so the bound shape stays refused (its former emission threw reading
/// items.length in the real factory, REVIEW-21).
#[test]
fn timeline_bound_sequence_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Account { title:text }\n Movement in Account { reason:text, quantity:int }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   timeline row.Movement order=-quantity\n    slot item\n     badge row.quantity\n     text row.reason\n",
        "E6008",
        "no supported source-to-factory profile",
    );
}

/// Recorded CanLeave agenda: option columns on the date-grouped calendar
/// has no consumed factory profile (calendarAgenda never reads columns).
#[test]
fn agenda_calendar_with_columns_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Request { state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}}, from:date, until:date, location:text }\n policy Request read=public\nWhen\nThen\n page /l title=\"L\"\n  calendar Request as request where request.state==open start=from end=until columns=location,state empty=\"None\"\n   badge row.state\n",
        "E6008",
        "option columns has no consumed factory profile",
    );
}

/// The same agenda without columns= keeps lowering.
#[test]
fn agenda_calendar_without_columns_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Request { state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}}, from:date, until:date, location:text }\n policy Request read=public\nWhen\nThen\n page /l title=\"L\"\n  calendar Request as request where request.state==open start=from end=until empty=\"None\"\n   badge row.state\n",
    );
}

/// A multi-value stat with a content suite keeps its owning refusal.
#[test]
fn multi_value_stat_with_suite_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Allowance { granted:int, available:int }\n policy Allowance read=public\nWhen\nThen\n page /a title=\"A\"\n  list Allowance columns=granted,available\n   stat row.granted,row.available\n    text \"Note\"\n",
        "E6008",
        "only one value header",
    );
}

/// An int value is not a string-carried copy value.
#[test]
fn copy_int_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, rank:int }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  list Customer columns=name\n   copy row.rank\n",
        "E6008",
        "copy takes text values",
    );
}

/// A text radial value is not a compatible integer value.
#[test]
fn radial_text_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Account { name:text }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=name\n   radial_progress row.name max=100\n",
        "E6008",
        "body-free compatible integer values",
    );
}

/// A radial with a content suite keeps its refusal.
#[test]
fn radial_with_suite_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Account { done:int }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=done\n   radial_progress row.done max=10\n    text \"Note\"\n",
        "E6008",
        "body-free compatible integer values",
    );
}

/// Two stages in one item slot keep the refusal.
#[test]
fn steps_two_stages_per_slot_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Term { executed:bool=false, expired:bool=false }\n policy Term read=public\nWhen\nThen\n page /t title=\"T\"\n  list Term columns=executed\n   steps\n    slot item\n     text \"First\"\n     status row.executed\n",
        "E6008",
        "one text stage",
    );
}

/// A badge is not a text-bearing stage.
#[test]
fn steps_badge_stage_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Term { executed:bool=false }\n policy Term read=public\nWhen\nThen\n page /t title=\"T\"\n  list Term columns=executed\n   steps\n    slot item\n     badge row.executed\n",
        "E6008",
        "one text stage",
    );
}

/// An indicator without its indicator slot keeps its refusal.
#[test]
fn indicator_missing_slot_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Job { address:text }\n policy Job read=public\nWhen\nThen\n page /j title=\"J\"\n  list Job columns=address\n   indicator\n    slot content\n     text row.address\n",
        "E6008",
        "needs its indicator slot",
    );
}

/// An unadmitted agenda option keeps its exact refusal.
#[test]
fn agenda_calendar_unknown_option_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Request { state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}}, from:date, until:date, location:text }\n policy Request read=public\nWhen\nThen\n page /l title=\"L\"\n  calendar Request as request where request.state==open start=from end=until columns=location,state search=location empty=\"None\"\n   badge row.state\n",
        "E6008",
        "option search has no consumed factory profile",
    );
}

/// A timeline with extra suites keeps its refusal.
#[test]
fn timeline_with_two_slots_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Account { title:text }\n Movement in Account { reason:text, quantity:int }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   timeline row.Movement\n    slot item\n     text row.reason\n    slot note\n     text row.quantity\n",
        "E6008",
        "no supported source-to-factory profile",
    );
}

/// Recorded CanExpense cascade: a collapse whose only content is a bound
/// timeline keeps both refusals, each at its owning node.
#[test]
fn collapse_over_bound_timeline_cascades() {
    let diags = emit_all(
        "app Probe\nGiven\n Account { title:text }\n Decision in Account { reason:text }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   collapse \"Decisions\"\n    timeline row.Decision\n     slot item\n      text row.reason\n",
    );
    assert!(
        diags.iter().any(|d| d.contains("cannot lower timeline")
            && d.contains("no supported source-to-factory profile")),
        "timeline keeps its refusal, got: {diags:?}"
    );
    assert!(
        diags.iter().any(|d| d.contains("cannot lower collapse")
            && d.contains("nonempty content suite")),
        "collapse keeps its cascade refusal, got: {diags:?}"
    );
}

/// A second sequence header keeps its refusal.
#[test]
fn timeline_with_two_headers_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Account { title:text }\n Movement in Account { reason:text, quantity:int }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   timeline row.Movement,row.title\n    slot item\n     text row.reason\n",
        "E6008",
        "no supported source-to-factory profile",
    );
}

/// A literal is not a saved preference: it stays refused.
#[test]
fn filter_with_literal_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Job { location:text, state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}} }\n policy Job read=public\nWhen\nThen\n preferences { state:Job.state? }\n page /d title=\"D\"\n  filter \"open\"\n  list Job columns=location filter=state defaults={state=preferences.state}\n",
        "E6008",
        "saved finite-choice preference",
    );
}

/// A plain int preference reuses no owned model field: it stays refused.
#[test]
fn standalone_filter_with_int_preference_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Job { location:text }\n policy Job read=public\nWhen\nThen\n preferences { rank:int? }\n page /d title=\"D\"\n  filter preferences.rank\n  list Job columns=location\n",
        "E6008",
        "saved finite-choice preference",
    );
}

/// An empty collapse keeps its exact refusal.
#[test]
fn empty_collapse_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  collapse \"Details\"\n",
        "E6008",
        "collapse needs a nonempty content suite",
    );
}

/// An empty hero keeps its exact refusal.
#[test]
fn empty_hero_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n page /c title=\"C\"\n  hero \"Welcome\"\n",
        "E6008",
        "needs a nonempty content suite",
    );
}

/// Inline preference panels need the settings save production no owned
/// contract provides: the exact refusal is preserved.
#[test]
fn inline_preferences_panel_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n policy Location read=public\nWhen\nThen\n preferences { arrival_open:bool=false label=\"Show\" }\n page /w title=\"W\"\n  preferences\n   toggle arrival_open\n  list Location columns=name\n",
        "E6008",
        "no supported source-to-factory profile",
    );
}

/// Recorded CanExpense/CanField shape: an in-context saved default for a
/// sibling collection filter, carrying the same filter/default descriptor.
#[test]
fn standalone_filter_with_saved_preference_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Job { location:text, state:enum(open,closed) label={text=\"S\",values={open=\"Open\",closed=\"Closed\"}} }\n policy Job read=public\nWhen\nThen\n preferences { state:Job.state? }\n page /d title=\"D\"\n  filter preferences.state\n  list Job columns=location filter=state defaults={state=preferences.state}\n",
    );
}