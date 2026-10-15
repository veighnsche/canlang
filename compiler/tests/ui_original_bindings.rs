//! Outcome 6: required original UI syntax/bindings.
//!
//! Original filters/defaults/forms/calendars and the recorded component
//! payloads lower through the shared UI contract: derived schemas,
//! permissions and interaction are preserved, and unsupported shapes refuse
//! loudly. Catalog-free: every test drives check -> IR build -> per-page JS
//! UI lowering in process.
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

const ITEM: &str = "app Probe\nGiven\n Item { title:text, href:url?, doc:file?, state:enum(open,closed)=open, urgent:bool=false, stamp:date?, note:text? }\n policy Item read=public\nWhen\nThen\n";

// -- Links (nullable/file destinations narrowed by guards) -------------------

#[test]
fn link_nullable_url_target_with_guard() {
    assert_lowers(&format!(
        "{ITEM} page /info/{{Item.id}} title=\"Info\"\n  card \"Doc\"\n   require row.href!=null\n   text row.href\n   link target=row.href caption=\"Direct\"\n"
    ));
}

// -- Lists: filters and defaults --------------------------------------------

#[test]
fn list_enum_filter_with_preference_default() {
    assert_lowers(&format!(
        "{ITEM} preferences {{ item_state:Item.state? }}\n page / title=\"Page\"\n  list Item filter=state defaults={{state=preferences.item_state}}\n   text row.title\n"
    ));
}

// -- Boards: enum grouping ---------------------------------------------------

#[test]
fn board_enum_grouping_with_filter() {
    assert_lowers(&format!(
        "{ITEM} preferences {{ item_state:Item.state? }}\n page / title=\"Page\"\n  board Item as item by=state columns=title filter=state defaults={{state=preferences.item_state}}\n   text row.title\n"
    ));
}

// -- Payload leaves: copy, metrics, stat -------------------------------------

#[test]
fn copy_single_text_value() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   copy row.title\n"
    ));
}

#[test]
fn copy_nullable_text_value() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   copy row.note\n"
    ));
}

#[test]
fn metrics_single_value() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   metrics row.title\n"
    ));
}

#[test]
fn metrics_money_values_share_stat_contract() {
    assert_lowers(
        "app Money\nGiven\n Item { title:text, total:money, balance:money }\n policy Item read=public\nWhen\nThen\n page / title=\"Page\"\n  list Item\n   metrics row.total,row.balance\n",
    );
}

#[test]
fn stat_single_header() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   stat row.title\n"
    ));
}

#[test]
fn stat_slotted_value_and_title() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   stat\n    slot value\n     text row.title\n    slot title\n     text \"Title\"\n"
    ));
}

// -- Content ------------------------------------------------------------------

#[test]
fn content_nullable_text_renders_empty() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   content row.note\n"
    ));
}

// -- Form controls: toggle, file input, range, date calendar ------------------

#[test]
fn toggle_bool_input_in_create_form() {
    assert_lowers(
        "app Toggle\nGiven\n Item { title:text, urgent:bool=false }\n policy Item read=public\nWhen\n crud Item by=public fields=title,urgent\nThen\n page / title=\"Page\"\n  form Item.create\n   input title\n   toggle urgent\n",
    );
}

#[test]
fn file_input_nullable_file_in_create_form() {
    assert_lowers(
        "app Upload\nGiven\n Item { title:text, doc:file? }\n policy Item read=public\nWhen\n crud Item by=public fields=title,doc\nThen\n page / title=\"Page\"\n  form Item.create\n   input title\n   file_input doc\n",
    );
}

#[test]
fn file_input_bound_scenario_param() {
    assert_lowers(
        "app Handoff\nGiven\n Item { title:text, photo:file? }\n policy Item read=public\nWhen\n crud Item by=public fields=title,photo\n scenario handoff(ticket:Item,photo:file?) -> Item by=public\n  do return ticket\nThen\n page / title=\"Page\"\n  list Item\n   form handoff arguments={ticket=row} display=inline\n    file_input photo\n",
    );
}

#[test]
fn range_int_and_decimal_inputs() {
    assert_lowers(
        "app Rank\nGiven\n Item { title:text, rank:int=0, rate:decimal=0 }\n policy Item read=public\nWhen\n crud Item by=public fields=title,rank,rate\nThen\n page / title=\"Page\"\n  primary \"Create\" action=Item.create\n   input title\n   range rank\n   range rate\n",
    );
}

#[test]
fn date_calendar_in_create_and_primary_forms() {
    assert_lowers(
        "app Dates\nGiven\n Item { title:text, stamp:date, renewal:date? }\n policy Item read=public\nWhen\n crud Item by=public fields=title,stamp,renewal\nThen\n page / title=\"Page\"\n  form Item.create\n   input title\n   calendar stamp\n   calendar renewal\n",
    );
}

#[test]
fn date_calendar_bound_scenario_params() {
    assert_lowers(
        "app Move\nGiven\n Item { title:text, start:date, stamp:date }\n policy Item read=public\nWhen\n scenario move_days(booking:Item,start:date,stamp:date) -> Item by=public\n  do return booking\nThen\n page /info/{Item.id} title=\"Info\"\n  form move_days arguments={booking=row} display=inline\n   calendar start\n   calendar stamp\n",
    );
}

// -- Grouping components: dropdown, accordion, steps, swap, diff --------------

#[test]
fn dropdown_trigger_and_content_slots() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  dropdown\n   slot trigger\n    text \"More\"\n   slot content\n    text \"Body\"\n"
    ));
}

#[test]
fn accordion_collapse_suite() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  accordion\n   collapse \"First\"\n    text \"Body\"\n   collapse \"Second\"\n    text \"More\"\n"
    ));
}

#[test]
fn steps_item_slots_become_labels() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  steps\n   slot item\n    text \"One\"\n   slot item\n    text \"Two\"\n"
    ));
}

#[test]
fn swap_bool_header_with_off_on_slots() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  list Item\n   swap row.urgent\n    slot off\n     text \"Off\"\n    slot on\n     text \"On\"\n"
    ));
}

#[test]
fn swap_with_countdown_in_on_slot() {
    assert_lowers(
        "app Countdown\nGiven\n Item { title:text, open:bool=false, until:datetime }\n policy Item read=public\nWhen\nThen\n page / title=\"Page\"\n  list Item\n   swap row.open\n    slot off\n     text \"Off\"\n    slot on\n     countdown row.until-now\n",
    );
}

#[test]
fn diff_before_and_after_slots() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  diff\n   slot before\n    text \"Before\"\n   slot after\n    text \"After\"\n"
    ));
}

#[test]
fn radial_progress_value_with_max() {
    assert_lowers(
        "app Radial\nGiven\n Item { title:text, remaining:int=0, days:int=0 }\n policy Item read=public\nWhen\nThen\n page / title=\"Page\"\n  list Item\n   radial_progress row.remaining max=row.days\n",
    );
}

// -- Containers ---------------------------------------------------------------

#[test]
fn collapse_with_table_child() {
    assert_lowers(&format!(
        "{ITEM} page / title=\"Page\"\n  collapse \"Details\"\n   table Item columns=title\n    text row.title\n"
    ));
}

#[test]
fn bare_fieldset_groups_inputs() {
    assert_lowers(
        "app Group\nGiven\n Item { title:text }\n policy Item read=public\nWhen\n crud Item by=public fields=title\nThen\n page / title=\"Page\"\n  form Item.create\n   fieldset\n    input title\n",
    );
}
