//! Outcome 6 (Lane B): recorded bool toggle filters lower end to end.
//!
//! The original24 composition filters on owned bool fields (`active`,
//! `done`) with matching bool preferences alongside the admitted enum
//! correspondence. The checker admits distinct owned plain-bool selectors
//! with matching defaults, the lowering validator accepts `bool` columns
//! with `true`/`false` captions, and data-only/absent `where` keeps
//! working. Non-bool kinds (int/text/date/model reference/nullable bool),
//! duplicate/undeclared selectors, dotted paths and lambda-where filter
//! composition keep the exact E6008 refusals below.
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

const HEAD: &str = "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company), active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, active:bool? }\n page /customers title=\"Customers\"\n";

/// Recorded CanCustomer shape: enum + bool filters with matching owned
/// preference defaults and no `where`.
#[test]
fn list_bool_filter_with_enum_and_matching_defaults_lowers() {
    assert_lowers(&format!(
        "{HEAD}  list Customer columns=name,kind,active filter=kind,active defaults={{kind=preferences.kind,active=preferences.active}}\n"
    ));
}

/// Recorded CanMember shape: bool-only filter with a renamed bool
/// preference default and no `where`.
#[test]
fn list_bool_only_filter_with_renamed_preference_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Plan { name:text, active:bool=true }\n policy Plan read=public\nWhen\nThen\n preferences { active_filter:bool? }\n page /plans title=\"Plans\"\n  list Plan columns=name,active filter=active defaults={active=preferences.active_filter}\n",
    );
}

/// Recorded nested `done` shape: bool-only table filter with no defaults
/// and no `where`.
#[test]
fn table_bool_only_filter_without_defaults_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Account { title:text }\n Milestone in Account { title:text, done:bool=false }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title\n   table row.Milestone columns=title,done order=title filter=done\n",
    );
}

/// Generalization: the shared collection pipeline admits bool filters on
/// board too.
#[test]
fn board_bool_filter_lowers() {
    assert_lowers(&format!(
        "{HEAD}  board Customer by=kind columns=name,active filter=active\n"
    ));
}

/// Bool filters compose with the admitted data-only table time predicate.
#[test]
fn bool_filter_with_time_where_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, active:bool=true, seen:datetime }\n policy Customer read=public\nWhen\nThen\n preferences { active:bool? }\n page /customers title=\"Customers\"\n  table Customer as c where c.seen>=now columns=name,active filter=active defaults={active=preferences.active}\n",
    );
}

/// A bool literal default initializes the toggle control.
#[test]
fn bool_literal_default_lowers() {
    assert_lowers(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=true}}\n"
    ));
}

/// The committed int refusal stays: rank is not a finite-choice field.
#[test]
fn int_filter_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, rank:int=0 }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,rank filter=rank\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Text fields are not finite-choice selectors.
#[test]
fn text_filter_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, category:text }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,category filter=category\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Date fields are not finite-choice selectors.
#[test]
fn date_filter_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, due:date }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,due filter=due\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded `location` shape stays refused: a model reference is not a
/// finite-choice field even with a matching model-typed preference.
#[test]
fn model_reference_filter_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, location:Location }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { location:Location? }\n page /customers title=\"Customers\"\n  list Customer columns=name,location filter=location defaults={location=preferences.location}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Nullable bool fields stay refused: only plain bool toggles lower.
#[test]
fn nullable_bool_filter_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, active:bool? }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Duplicate bool selectors stay refused.
#[test]
fn duplicate_bool_filter_refuses() {
    assert_refuses(
        &format!("{HEAD}  list Customer columns=name,active filter=active,active\n"),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A default for an undeclared control stays refused (recorded
/// CanAffiliate/CanStock mismatch shape).
#[test]
fn undeclared_bool_default_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,active filter=active defaults={{kind=preferences.kind}}\n"
        ),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded nesting (CanSuccess/CanContract): a refused outer list keeps
/// its checker refusal while an admitted nested bool table lowers quietly
/// alongside it. (The harness returns after checker diagnostics, so the
/// lowering-stage outer refusal surfaces only in the full CLI pipeline;
/// the nested table must stay quiet in both.)
#[test]
fn refused_outer_list_keeps_admitted_nested_bool_table_quiet() {
    let diags = emit_all(
        "app Probe\nGiven\n Location { name:text }\n Account { title:text, location:Location }\n Milestone in Account { title:text, done:bool=false }\n policy Location read=public\n policy Account read=public\nWhen\nThen\n preferences { location:Location? }\n page /a title=\"A\"\n  list Account columns=title,location filter=location defaults={location=preferences.location}\n   table row.Milestone columns=title,done order=title filter=done\n",
    );
    assert!(
        diags
            .iter()
            .any(|d| d.contains("list filters need distinct")),
        "expected the outer list field refusal, got: {diags:?}"
    );
    assert!(
        diags.iter().all(|d| !d.contains("table filters")),
        "nested bool table must lower quietly, got: {diags:?}"
    );
}

/// Lambda-where plus filter composition stays refused at lowering even
/// when the selectors themselves are admitted (recorded Repair shape).
#[test]
fn bool_filter_with_lambda_where_refuses_at_lowering() {
    assert_refuses(
        &format!("{HEAD}  list Customer as c where c.active columns=name,active filter=active\n"),
        "E6008",
        "need matching owned declarations and data-only where",
    );
}
