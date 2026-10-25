//! Outcome 6 (Lane B): recorded bool toggle filters lower end to end.
//!
//! The original24 composition filters on owned bool fields (`active`,
//! `done`) with matching bool preferences alongside the admitted enum
//! correspondence. The checker admits distinct owned plain-bool selectors
//! with matching defaults, the lowering validator accepts `bool` columns
//! with `true`/`false` captions, and data-only/absent `where` keeps
//! working. Duplicate/undeclared selectors and dotted paths retain their
//! exact refusals; nullable bools and checked lambda composition are supported. Plain `text` selectors lower
//! through the CAN18-v1 C2 text-equality rule (DESIGN 975 scalar +
//! operator table); see `enum_filter_group.rs` for the text pins.
//! Plain `date` selectors lower through the CAN18-v1 C3 civil-date
//! equality rule (DESIGN 1015-1025 operator table); see
//! `enum_filter_group.rs` for the date pins.
//! Model references lower through the
//! CAN18-v1 reference-equality rule (typed opaque identity, never an enum
//! spelling): see `enum_filter_group.rs` for the board/calendar pins.
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

/// Lowered page-render JS for one source (panics on any diagnostic, so
/// the returned text is the admitted emission).
fn emit_js(source: &str) -> String {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.into());
    let (checked, check_diags) = check_program(&db, &[file], None);
    assert!(
        check_diags.is_empty(),
        "unexpected check diagnostics: {:?}",
        codes(&check_diags)
    );
    let (program, build_diags) = ir::build(&checked, &db, None);
    assert!(
        build_diags.is_empty(),
        "unexpected IR diagnostics: {:?}",
        codes(&build_diags)
    );
    let mut out = String::new();
    for module in &program.modules {
        for page in &module.pages {
            for node in &page.render {
                let mut emitter = js::Emitter::new(&program);
                out.push_str(&emitter.lower_ui(node));
                let (diags, _, _, _) = emitter.finish();
                assert!(
                    diags.is_empty(),
                    "unexpected lowering diagnostics: {:?}",
                    codes(&diags)
                );
            }
        }
    }
    out
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

/// B11: a saved bool preference read decodes its store spelling at the
/// checked typed reader, before any bool expression consumes it. The
/// store is string-typed, so `preferences.active` arrives as
/// `"true"`/`"false"` while bool consumers require real booleans. The
/// nullable bool read is wrapped in the strict spelling decoding (null
/// stays null, real booleans pass through, strict spellings map, and
/// anything else throws a validation refusal, never truthy); the enum
/// read lowers verbatim, and no collection sink wrapper applies.
#[test]
fn saved_bool_preference_read_decodes_strict_spellings() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,kind,active filter=kind,active defaults={{kind=preferences.kind,active=preferences.active}}\n"
    ));
    assert!(
        js.contains("kind:(preferences.kind ?? null)"),
        "enum default stays verbatim, got: {js}"
    );
    assert!(
        js.contains("active:((value=>{if(value==null)return null;"),
        "nullable bool read carries the spelling decoding, got: {js}"
    );
    assert!(
        js.contains(
            "if(value===\"true\")return true;if(value===\"false\")return false;throw{code:\"validation\",message:\"Invalid bool preference.\"}"
        ),
        "only strict spellings map and anything else refuses before any query, got: {js}"
    );
    assert!(
        !js.contains("return value;}"),
        "no sink passthrough survives: malformed spellings refuse, got: {js}"
    );
}

/// B11: a bool literal default lowers verbatim with no coercion of any
/// kind (it is already a real boolean; decoding applies to reads only).
#[test]
fn bool_literal_default_lowers_verbatim() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=true}}\n"
    ));
    assert!(
        js.contains("active:true"),
        "bool literal default stays a real boolean, got: {js}"
    );
    assert!(
        !js.contains("value=>{if(value==null)"),
        "no decoding wrapper on literals, got: {js}"
    );
}

/// B11: the shared collection pipeline decodes saved bool spellings at
/// the read on board too, not just list.
#[test]
fn board_saved_bool_preference_read_decodes() {
    let js = emit_js(&format!(
        "{HEAD}  board Customer by=kind columns=name,active filter=active defaults={{active=preferences.active}}\n"
    ));
    assert!(
        js.contains("active:((value=>{if(value==null)return null;"),
        "board bool read carries the spelling decoding, got: {js}"
    );
}

/// B11 discriminator (inline): a negated `??`-defaulted bool preference
/// read is admitted and lowers with the decoded read inside, so a saved
/// `"false"` spelling selects `true` rows at runtime. No sink wrapper.
#[test]
fn negated_bool_default_with_fallback_lowers() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=not(preferences.active ?? false)}}\n"
    ));
    assert!(
        js.contains("!(("),
        "negation lowers over the defaulted read, got: {js}"
    );
    assert!(
        js.contains("(value=>{if(value==null)return null;"),
        "the inner read still decodes at the reader, got: {js}"
    );
    assert!(
        js.contains("??false)") || js.contains("?? false)"),
        "the null fallback survives lowering, got: {js}"
    );
}

/// B11 discriminator (helper): an equivalent derive-helper call over the
/// saved preference is admitted and lowers with the decoded read as its
/// argument, agreeing with the inline negation at runtime.
#[test]
fn derive_helper_bool_default_lowers() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, active:bool=true }\n derive inverted(x:bool?):bool = not(x ?? false)\n policy Customer read=public\nWhen\nThen\n preferences { active:bool? }\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active defaults={active=inverted(preferences.active)} display=split\n",
    );
    assert!(
        js.contains("(value=>{if(value==null)return null;"),
        "the helper argument read decodes at the reader, got: {js}"
    );
    assert!(
        js.contains("await "),
        "the checked derive helper runs at render, got: {js}"
    );
}

/// B11: a bare `??`-defaulted bool preference read is admitted without
/// the negation (null/default handling pins the fallback shape alone).
#[test]
fn coalesced_bool_default_lowers() {
    assert_lowers(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=preferences.active ?? false}}\n"
    ));
}

/// B13: `not` over a non-nullable bool preference read is admitted: the
/// checked typed reader decodes the saved spelling before the negation,
/// so a saved `"false"` selects `true` rows. The strict decoding maps
/// real booleans and strict spellings only: no nullable passthrough and
/// no `?? null` wrapper on the non-nullable read, so a missing value
/// never becomes a nullable success.
#[test]
fn not_over_nonnullable_bool_read_decodes() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { show:bool=true }\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active defaults={active=not(preferences.show)}\n",
    );
    assert!(
        js.contains("active:!(value=>{if(value===true)return true;"),
        "negation lowers over the strict non-nullable decoding, got: {js}"
    );
    assert!(
        js.contains(
            "if(value===\"true\")return true;if(value===\"false\")return false;throw{code:\"validation\",message:\"Invalid bool preference.\"}"
        ),
        "only strict spellings map and anything else refuses before any query, got: {js}"
    );
    assert!(
        !js.contains("if(value==null)return null"),
        "no nullable passthrough on a non-nullable read, got: {js}"
    );
    assert!(
        !js.contains("?? null"),
        "no nullable wrapper on a non-nullable read, got: {js}"
    );
}

/// B13: a direct non-nullable bool preference default decodes at the
/// checked typed reader, exactly as nullable reads do. The emission
/// carries the strict decoding with no nullable wrapper, so a saved
/// `"false"` reaches the host preparer as a real boolean.
#[test]
fn direct_nonnullable_bool_read_decodes() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { show:bool=true }\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active defaults={active=preferences.show}\n",
    );
    assert!(
        js.contains("active:(value=>{if(value===true)return true;"),
        "direct non-nullable read carries the strict decoding, got: {js}"
    );
    assert!(
        !js.contains("if(value==null)return null"),
        "no nullable passthrough on a non-nullable read, got: {js}"
    );
    assert!(
        !js.contains("?? null"),
        "no nullable wrapper on a non-nullable read, got: {js}"
    );
}

/// B13: a derive-helper call over a non-nullable bool preference read is
/// admitted with the strict decoding at its argument, agreeing with the
/// inline negation at runtime.
#[test]
fn derive_helper_over_nonnullable_bool_read_decodes() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, active:bool=true }\n derive flip(x:bool):bool = not(x)\n policy Customer read=public\nWhen\nThen\n preferences { show:bool=true }\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active defaults={active=flip(preferences.show)}\n",
    );
    assert!(
        js.contains("(value=>{if(value===true)return true;"),
        "the helper argument read decodes strictly at the reader, got: {js}"
    );
    assert!(
        js.contains("await "),
        "the checked derive helper runs at render, got: {js}"
    );
}

/// B13: comparisons over a decoded bool preference read are admitted by
/// the shared pure-expression rule, not refused as unlisted spellings.
/// A nullable read compared against a bool literal lowers with the
/// reader decoding inside and a strict comparison outside.
#[test]
fn comparison_over_bool_read_lowers() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=preferences.active == true}}\n"
    ));
    assert!(
        js.contains("(value=>{if(value==null)return null;"),
        "the compared read still decodes at the reader, got: {js}"
    );
    assert!(
        js.contains("equalValue(\"bool?\""),
        "the nullable comparison lowers through the null-safe equality helper, got: {js}"
    );
}

/// B13 discriminator (comparison): `((preferences.active ?? false) ==
/// false)` is admitted and lowers with the decoded read inside, agreeing
/// with the inline negation and the equivalent helper call at runtime.
#[test]
fn discriminator_comparison_default_lowers() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,active filter=active defaults={{active=(preferences.active ?? false) == false}}\n"
    ));
    assert!(
        js.contains("(value=>{if(value==null)return null;"),
        "the compared read still decodes at the reader, got: {js}"
    );
    assert!(
        js.contains("??false)") || js.contains("?? false)"),
        "the null fallback survives lowering, got: {js}"
    );
    assert!(
        js.contains("?? false) === false"),
        "the defaulted read stays parenthesized under the strict comparison, got: {js}"
    );
}

/// B11: a derive-helper call returning non-bool stays refused even over
/// an admitted read: defaults entries type exactly `bool`.
#[test]
fn non_bool_helper_call_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, active:bool=true }\n derive label(x:bool?):text = \"a\"\n policy Customer read=public\nWhen\nThen\n preferences { active:bool? }\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active defaults={active=label(preferences.active)}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// An owned int field is an exact typed equality control without case options.
#[test]
fn int_filter_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, rank:int=0 }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,rank filter=rank\n",
    );
}

/// C2 text-equality rule (DESIGN 975 scalar + operator table): a bare
/// plain-text control with no default is no initial restriction, so it
/// lowers; text is an exact equality control, not a finite-choice
/// selector, and carries no case inventory.
#[test]
fn text_filter_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, category:text }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,category filter=category\n",
    );
}

/// C3 civil-date equality rule (DESIGN 1015-1025 operator table): a
/// bare plain-date control with no default is no initial restriction,
/// so it lowers; dates are exact civil equality controls, not
/// finite-choice selectors, and carry no case inventory.
#[test]
fn date_filter_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, due:date }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,due filter=due\n",
    );
}

/// Recorded `location` shape (C1 reference rule, CAN18-v1 board/calendar
/// batch): a stored-model reference lowers beside a bool toggle through
/// typed opaque identity (DESIGN 977), never an enum spelling, with a
/// matching model-typed preference default (DESIGN 975 subset).
#[test]
fn model_reference_filter_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, location:Location, active:bool=true }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { location:Location?, active:bool? }\n page /customers title=\"Customers\"\n  list Customer columns=name,location,active filter=location,active defaults={location=preferences.location,active=preferences.active}\n",
    );
}

/// Nullable bool selectors retain the owned bool filter codec.
#[test]
fn nullable_bool_filter_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, active:bool? }\n policy Customer read=public\nWhen\nThen\n page /customers title=\"Customers\"\n  list Customer columns=name,active filter=active\n",
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

/// An unsupported validated email selector on an outer list must not
/// introduce a refusal in its independently supported nested bool table.
#[test]
fn refused_outer_list_keeps_admitted_nested_bool_table_quiet() {
    let diags = emit_all(
        "app Probe\nGiven\n Account { title:text, category:text, contact:email? }\n Milestone in Account { title:text, done:bool=false }\n policy Account read=public\nWhen\nThen\n page /a title=\"A\"\n  list Account columns=title,category filter=contact\n   table row.Milestone columns=title,done order=title filter=done\n",
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

/// E5 (CAN18-v1, DESIGN 434/440/975/977): a Lambda where conjoins with
/// admitted bool selectors (`{op:and,[where,...filters]}` at the query
/// adapter) instead of refusing (recorded Repair shape now admitted).
#[test]
fn bool_filter_with_lambda_where_conjoins_at_lowering() {
    assert_lowers(&format!(
        "{HEAD}  list Customer as c where c.active columns=name,active filter=active\n"
    ));
}
