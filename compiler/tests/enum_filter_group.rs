//! Outcome 6 (Lane B14): computed enum filter defaults admitted at the
//! defining owner (compiler); the executable consumer lives in Lane B15
//! (the interfaces enum-page-source test), not here.
//!
//! What this batch fixes (exactly two shapes, never a general
//! expression language): a `??` fallback across two saved enum reads,
//! and a checked derive-helper call (local or imported) returning the
//! owned enum or its nullable form — both over owned enum preference
//! reads with the same leaf-registration contract as direct reads. The
//! repair reuses the B-team owned-declaration/defaults machinery
//! (matching owned enum declarations, saved-read leaves, typed
//! predicates) and extends it to enum spellings rather than forking it.
//! Saved enum values are already case spellings, so reads lower verbatim
//! and the host preparer refuses unknown spellings against the column
//! inventory (no decoding wrapper, no truthiness, no cross-kind
//! coercion).
//!
//! What stays refused with exact codes: the frozen original24 capture's
//! remaining filter occurrences stay refused — every table/list/board/
//! calendar filter refusal bottoms out on a genuinely unsupported selector
//! (int `year`, datetime `qualified_at`, dotted paths; nullable `date?`
//! model fields, computed date defaults and datetime selectors are
//! likewise not admitted from the civil-date rule below; nullable
//! `text?` model fields, validated string-likes, and computed text
//! defaults are likewise not admitted from the text rule),
//! `archived=include` with no consumed factory profile, or an expression
//! `order=` with no §13 lowering. Each keeps its exact named
//! E6008 refusal below (base control: B6 Lambda-where/defaults-key/
//! co-fields/dotted-path disposition; outcome-5/12 for archived/order);
//! `not` over an enum keeps E3007 (no implicit truthiness); cross-kind
//! reads, unknown case literals, reference literal/computed defaults, and
//! foreign-model reference defaults keep E6008. None of those is absorbed
//! here.
//!
//! C1 reference rule (CAN18-v1 board/calendar batch, DESIGN 434/975/977):
//! a stored-model reference (`location`), a `user` reference (`owner`),
//! or a `member` reference lowers beside enum/bool siblings through typed
//! opaque identity — reference equality is not an enum spelling, so no
//! case inventory applies.
//!
//! C2 text-equality rule (CAN18-v1, DESIGN 975 scalar + operator table):
//! a plain owned `text` field (`bucket`/`category`/`skill`) lowers as an
//! exact equality control beside enum/bool/reference siblings: the saved
//! `text?` read (or a text literal, or null) lowers verbatim with no
//! case inventory, and the host preparer compares the ordinary string
//! equality.
//!
//! C3 civil-date equality rule (CAN18-v1, DESIGN 1015-1025 operator
//! table — CORRECTION per 2321: date/datetime already accept
//! eq/ne/lt/lte/gt/gte/between; dates are civil, datetimes canonical
//! instants under existing zone rules, so the missing generated
//! controls are local implementation work, not language exclusion):
//! a plain owned `date` field (`business_date`, `paid`, `due`,
//! `from`/`until`) lowers as an exact equality control beside
//! enum/bool/reference/text siblings: the saved `date?` read (or a
//! date literal, or null) lowers verbatim with no case inventory, and
//! the host preparer admits only real civil dates while the state
//! string equality evaluates them. Only `eq` is offered (one rule:
//! ranges need no generalization here). The datetime follower
//! (`qualified_at`) stays refused below with its exact code. The C4
//! agenda bindings lower:
//! a parent-bound (nested) agenda threads the enclosing row through the
//! shared collection pipeline like a bound timeline, and agenda
//! `columns=` names owned row fields the calendarAgenda factory renders
//! beside each endpoint line.
//!
//! Catalog-free: every test drives check -> IR build -> per-page JS UI
//! lowering in process (string inspection only; execution is B15).
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
/// node (catches factory-table and prop-admission gaps too). Like the CLI,
/// every stage runs and contributes diagnostics: a refused table/list/board
/// filter keeps both its checker refusal (distinct owned fields) and its
/// lowering refusal (matching declarations), while a refused calendar
/// filter keeps the checker refusal alone.
fn emit_all(source: &str) -> Vec<String> {
    let mut db = SourceDb::new();
    let file = db.add("probe.can".into(), source.into());
    let (checked, check_diags) = check_program(&db, &[file], None);
    let mut out: Vec<String> = codes(&check_diags);
    let (program, build_diags) = ir::build(&checked, &db, None);
    out.extend(codes(&build_diags));
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

const HEAD: &str = "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, active:bool? }\n page /customers title=\"Customers\"\n";

/// Recorded shape: a table enum filter with a matching owned enum
/// declaration and saved default lowers end to end.
#[test]
fn table_enum_filter_with_matching_defaults_lowers() {
    assert_lowers(&format!(
        "{HEAD}  table Customer columns=name,kind filter=kind defaults={{kind=preferences.kind}}\n"
    ));
}

/// Recorded shape: a list enum filter with a matching owned enum
/// declaration and saved default lowers end to end.
#[test]
fn list_enum_filter_with_matching_defaults_lowers() {
    assert_lowers(&format!(
        "{HEAD}  list Customer columns=name,kind filter=kind defaults={{kind=preferences.kind}}\n"
    ));
}

/// Recorded CanCRM shape minus the unsupported model references: a board
/// enum+bool filter with matching owned declarations and saved defaults
/// lowers end to end.
#[test]
fn board_enum_bool_filter_with_matching_defaults_lowers() {
    assert_lowers(&format!(
        "{HEAD}  board Customer by=kind columns=name,active filter=kind,active defaults={{kind=preferences.kind,active=preferences.active}}\n"
    ));
}

/// Board row/card binding: authored row children thread row_scope exactly
/// like the accepted table/list row-child path, so the page-render JS
/// carries a bound `renderRow` closure instead of an eager `c is not
/// defined` crash. A childless board on the same shape emits no `renderRow`.
#[test]
fn board_row_children_lower_to_bound_render_row() {
    let js = emit_js(&format!(
        "{HEAD}  board Customer as c by=kind columns=name filter=kind defaults={{kind=preferences.kind}}\n   text row.name\n"
    ));
    assert!(
        js.contains("renderRow:"),
        "board row children bind a row closure, got: {js}"
    );
    let plain = emit_js(&format!(
        "{HEAD}  board Customer as c by=kind columns=name filter=kind defaults={{kind=preferences.kind}}\n"
    ));
    assert!(
        !plain.contains("renderRow:"),
        "childless board keeps column-only emission, got: {plain}"
    );
}

/// Recorded agenda shape: a top-level calendar enum filter with a
/// matching owned declaration and saved default lowers end to end.
#[test]
fn calendar_enum_filter_with_matching_defaults_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Job { title:text, from:datetime, until:datetime, state:enum(open,closed)=open }\n policy Job read=public\nWhen\nThen\n preferences { state:Job.state? }\n page /agenda title=\"Agenda\"\n  calendar Job start=from end=until filter=state defaults={state=preferences.state}\n",
    );
}

/// B14 repair: a `??` fallback across two saved enum reads is admitted.
/// Both leaves register with the enum-case options; the checked type
/// (the owned enum or its nullable form) does the work.
#[test]
fn enum_coalesced_saved_reads_lower() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, backup:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=preferences.kind ?? preferences.backup}\n",
    );
}

/// B14 repair: a checked derive-helper call returning the owned enum
/// over an admitted saved read is admitted, agreeing with the direct
/// read at runtime.
#[test]
fn enum_derive_helper_default_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual }\n derive pick(k:Customer.kind?):Customer.kind? = k\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=pick(preferences.kind)}\n",
    );
}

/// B14 emission: the coalesced default lowers with both saved reads
/// verbatim (cases are already spellings) and the `??` fallback
/// surviving; no bool spelling-decoding wrapper applies to enum reads.
#[test]
fn enum_coalesced_default_lowers_verbatim_reads() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, backup:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=preferences.kind ?? preferences.backup}\n",
    );
    assert!(
        js.contains("(preferences.kind ?? null) ?? (preferences.backup ?? null)"),
        "both saved reads stay verbatim under the surviving fallback, got: {js}"
    );
    assert!(
        !js.contains("value=>{if(value==null)"),
        "no bool spelling-decoding wrapper on enum reads, got: {js}"
    );
}

/// B14 emission: the helper default lowers with the checked helper
/// running at render over the verbatim saved read, so an unknown saved
/// spelling reaches the host preparer (which refuses it against the
/// column inventory) rather than coercing into a case.
#[test]
fn enum_helper_default_runs_helper_over_verbatim_read() {
    let js = emit_js(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual }\n derive pick(k:Customer.kind?):Customer.kind? = k\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=pick(preferences.kind)}\n",
    );
    assert!(
        js.contains("await "),
        "the checked derive helper runs at render, got: {js}"
    );
    assert!(
        js.contains("(preferences.kind ?? null)"),
        "the helper argument read stays verbatim, got: {js}"
    );
}

/// A direct saved enum read lowers verbatim with the null fallback and
/// no bool decoding: the strict spelling contract lives in the column
/// inventory the host preparer checks.
#[test]
fn saved_enum_read_lowers_verbatim_without_bool_decoding() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,kind,active filter=kind,active defaults={{kind=preferences.kind,active=preferences.active}}\n"
    ));
    assert!(
        js.contains("kind:(preferences.kind ?? null)"),
        "enum default stays verbatim, got: {js}"
    );
    assert!(
        js.contains("active:((value=>{if(value==null)return null;"),
        "the bool sibling still carries its spelling decoding, got: {js}"
    );
}

/// An enum case-text literal default lowers verbatim.
#[test]
fn enum_literal_default_lowers_verbatim() {
    let js = emit_js(&format!(
        "{HEAD}  list Customer columns=name,kind filter=kind defaults={{kind=\"individual\"}}\n"
    ));
    assert!(
        js.contains("kind:\"individual\""),
        "enum literal default stays a case spelling, got: {js}"
    );
}

/// C1 reference rule (CAN18-v1 board/calendar batch): a stored-model
/// reference lowers beside a bool toggle through typed opaque identity
/// (DESIGN 977) with a matching model-typed preference default (DESIGN
/// 975 subset). The retired CanBook/CanRent dominance refusal is recorded
/// here as the admission it became; text/date followers lower below on
/// their own selectors under the C2/C3 rules.
#[test]
fn model_reference_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Calendar { location:Location, active:bool=true }\n policy Location read=public\n policy Calendar read=public\nWhen\nThen\n preferences { location:Location?, active:bool? }\n page /calendars title=\"Calendars\"\n  list Calendar columns=location,active filter=location,active defaults={location=preferences.location,active=preferences.active} display=split\n",
    );
}

/// C2 text-equality rule (CAN18-v1, DESIGN 975 scalar + operator
/// table): the recorded CanLeave shape lowers. A plain owned `text`
/// field is an exact equality control with a matching `text?`
/// preference default: the saved read lowers verbatim with no case
/// inventory, and null stays no initial restriction (DESIGN 975).
#[test]
fn text_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Request { bucket:text }\n policy Request read=public\nWhen\nThen\n preferences { bucket:text? }\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket defaults={bucket=preferences.bucket}\n",
    );
}

/// C2 text-equality rule: a text literal default matches the text
/// control exactly (DESIGN 975 scalar), lowering verbatim.
#[test]
fn text_literal_default_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Request { bucket:text }\n policy Request read=public\nWhen\nThen\n preferences { bucket:text? }\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket defaults={bucket=\"review\"}\n",
    );
}

/// C2 text-equality rule: no default is no initial restriction
/// (DESIGN 975: null means no initial restriction), so the bare text
/// control lowers.
#[test]
fn text_selector_without_default_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Request { bucket:text }\n policy Request read=public\nWhen\nThen\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket\n",
    );
}

/// C2 text-equality rule on tables: the same shared gate covers the
/// recorded CanMaintain shape (list) and its table sibling alike.
#[test]
fn table_text_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Asset { name:text, category:text }\n policy Asset read=public\nWhen\nThen\n preferences { category:text? }\n page /assets title=\"Assets\"\n  table Asset columns=name,category order=name filter=category defaults={category=preferences.category}\n",
    );
}

/// A nullable owned `text?` model field is not admitted from the
/// admitted plain `text` selector: the selector gate takes the exact
/// non-nullable text type, mirroring the enum precedent.
#[test]
fn nullable_text_model_field_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Request { bucket:text? }\n policy Request read=public\nWhen\nThen\n preferences { bucket:text? }\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket defaults={bucket=preferences.bucket}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A validated string-like is not admitted from the admitted plain
/// `text` selector: `email` keeps its exact E6008 refusal. No
/// symmetry generalization.
#[test]
fn email_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Contact { address:email }\n policy Contact read=public\nWhen\nThen\n preferences { address:email? }\n page /contacts title=\"Contacts\"\n  list Contact columns=address filter=address defaults={address=preferences.address}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// No computed text default is admitted (no B14 analog): a `??`
/// fallback across two saved text reads keeps its exact E6008
/// refusal. Only a text literal, a direct saved text read, or null
/// lower.
#[test]
fn computed_text_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Request { bucket:text }\n policy Request read=public\nWhen\nThen\n preferences { bucket:text?, backup:text? }\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket defaults={bucket=preferences.bucket ?? preferences.backup}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanLeave year equality preserves its exact matching int preference.
#[test]
fn int_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Allowance { year:int }\n policy Allowance read=public\nWhen\nThen\n preferences { year:int? }\n page /allowances title=\"Allowances\"\n  list Allowance columns=year filter=year defaults={year=preferences.year}\n",
    );
}

/// C3 civil-date equality rule (CAN18-v1, DESIGN 1015-1025 operator
/// table): the recorded CanExpense shape lowers. A plain owned `date`
/// field is an exact equality control with a matching `date?`
/// preference default: the saved read lowers verbatim with no case
/// inventory, and null stays no initial restriction (DESIGN 1023).
#[test]
fn date_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Reimbursement { paid:date }\n policy Reimbursement read=public\nWhen\nThen\n preferences { paid:date? }\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid defaults={paid=preferences.paid}\n",
    );
}

/// A bare string is not a date literal default: the date control takes
/// only the `date("...")` constructor (real catalog) or a direct saved
/// date read — never an untyped string. The constructor spelling is
/// covered end to end through the real binary + catalog consumer
/// (`packages/interfaces/test/date-page-source.test.ts`); the
/// catalog-free harness pins the refusal here.
#[test]
fn bare_string_date_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Reimbursement { paid:date }\n policy Reimbursement read=public\nWhen\nThen\n preferences { paid:date? }\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid defaults={paid=\"2026-10-01\"}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// C3 civil-date equality rule: no default is no initial restriction
/// (DESIGN 1023: null means no initial restriction), so the bare date
/// control lowers.
#[test]
fn date_selector_without_default_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Reimbursement { paid:date }\n policy Reimbursement read=public\nWhen\nThen\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid\n",
    );
}

/// C3 civil-date equality rule on tables: the same shared gate covers
/// the recorded CanInvoice `due` shape and its table sibling alike.
#[test]
fn table_date_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Invoice { number:text, due:date }\n policy Invoice read=public\nWhen\nThen\n preferences { due:date? }\n page /invoices title=\"Invoices\"\n  table Invoice columns=number,due order=number filter=due defaults={due=preferences.due}\n",
    );
}

/// A nullable owned `date?` model field is not admitted from the
/// admitted plain `date` selector: the selector gate takes the exact
/// non-nullable date type, mirroring the text/enum precedent.
#[test]
fn nullable_date_model_field_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Reimbursement { paid:date? }\n policy Reimbursement read=public\nWhen\nThen\n preferences { paid:date? }\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid defaults={paid=preferences.paid}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// No computed date default is admitted: a `??` fallback across two
/// saved date reads keeps its exact E6008 refusal. Only a date
/// literal, a direct saved date read, or null lower.
#[test]
fn computed_date_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Reimbursement { paid:date }\n policy Reimbursement read=public\nWhen\nThen\n preferences { paid:date?, backup:date? }\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid defaults={paid=preferences.paid ?? preferences.backup}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanAffiliate instant equality uses the checked datetime codec,
/// alongside the original bool toggle and its owned default.
#[test]
fn datetime_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Sale { reversed:bool=false, qualified_at:datetime }\n policy Sale read=public\nWhen\nThen\n preferences { reversed:bool? }\n page /sales title=\"Sales\"\n  list Sale columns=reversed,qualified_at filter=reversed,qualified_at defaults={reversed=preferences.reversed}\n",
    );
}

/// Duplicate selectors stay refused.
#[test]
fn duplicate_enum_selector_refuses() {
    assert_refuses(
        &format!("{HEAD}  list Customer columns=name,kind filter=kind,kind\n"),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A default for an undeclared control stays refused.
#[test]
fn undeclared_enum_default_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,kind filter=kind defaults={{active=preferences.active}}\n"
        ),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanAffiliate Money.currency is the exact checked Money component;
/// arbitrary dotted navigation remains outside this filter grammar.
#[test]
fn dotted_path_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Sale { amount:money, reversed:bool=false }\n policy Sale read=public\nWhen\nThen\n preferences { reversed:bool? }\n page /sales title=\"Sales\"\n  list Sale columns=amount,reversed filter=reversed,amount.currency defaults={reversed=preferences.reversed}\n",
    );
}

/// E5 (CAN18-v1, DESIGN 434/440/975/977): a field-to-field predicate
/// lowers to a Lambda where, which conjoins with the admitted enum
/// selectors (`{op:and,[where,...filters]}` at the query adapter) instead
/// of refusing. Column/defaults validation is unchanged.
#[test]
fn enum_filter_with_lambda_where_conjoins_at_lowering() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, nick:text, kind:enum(individual,company)=individual }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer as c where c.name==c.nick columns=name,kind filter=kind defaults={kind=preferences.kind}\n",
    );
}

/// E5 reuse on boards (CAN18-v1 board/calendar filter batch): the same
/// field-to-field Lambda `where` conjoins with admitted board enum+bool
/// selectors. No board-specific veto, no mechanism change; column and
/// grouping validation is unchanged. The pin is childless (cards render
/// from columns): authored row children on boards are a separate
/// card-content gap outside this batch. Recorded CanCRM/CanExpense/
/// CanField boards stay refused below on their model-reference/text/date
/// selectors, which are outside the enum-selector batch.
#[test]
fn board_enum_filter_with_lambda_where_conjoins_at_lowering() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, nick:text, kind:enum(individual,company)=individual, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, active:bool? }\n page /customers title=\"Customers\"\n  board Customer as c where c.name==c.nick by=kind columns=name,active filter=kind,active defaults={kind=preferences.kind,active=preferences.active}\n",
    );
}

/// C1 reference rule on boards (CAN18-v1 board/calendar batch): the
/// recorded CanCRM/CanExpense/CanField board shape lowers once the
/// stored-model reference compares by typed opaque identity (DESIGN 977)
/// beside the admitted enum selector, with matching owned declarations
/// and a 975 default subset. The E5 conjunction covers the board exactly
/// like the enum/bool pin above. The pin is childless (cards render from
/// columns): authored row children on boards are the separate card-content
/// gap named in the batch commit, outside this rule.
#[test]
fn board_model_reference_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, kind:enum(individual,company)=individual, site:Location }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { site:Location?, kind:Customer.kind? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,site filter=site,kind defaults={site=preferences.site,kind=preferences.kind}\n",
    );
}

/// C1 reference rule for the CanCRM `owner:user` selector: a user
/// reference lowers beside the model reference and the enum through the
/// same opaque identity, with no default required for the owner control
/// (DESIGN 975: null means no initial restriction).
#[test]
fn board_user_reference_selector_lowers_without_default() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Deal { title:text, location:Location, owner:user, stage:enum(lead,won)=lead }\n policy Location read=public\n policy Deal read=public\nWhen\nThen\n preferences { location:Location?, stage:Deal.stage? }\n page /sales title=\"Sales\"\n  board Deal by=stage columns=title,location,owner filter=location,owner,stage defaults={location=preferences.location,stage=preferences.stage}\n",
    );
}

/// C1 reference rule for `member` selectors: a member reference lowers
/// through the same opaque identity beside the enum, descriptor kind
/// `member` with empty value labels.
#[test]
fn table_member_reference_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Assignment { title:text, owner:member, state:enum(open,closed)=open }\n policy Assignment read=public\nWhen\nThen\n preferences { state:Assignment.state? }\n page /assignments title=\"Assignments\"\n  table Assignment columns=title,owner,state order=title filter=owner,state defaults={state=preferences.state}\n",
    );
}

/// C1 reference rule on agendas (CAN18-v1 board/calendar batch): the
/// recorded CanShift/CanLeave/CanField calendar shape lowers once the
/// stored-model reference compares by typed opaque identity beside the
/// admitted enum selector. The E5 conjunction covers the agenda exactly
/// like the enum pin above.
#[test]
fn calendar_model_reference_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Job { title:text, from:datetime, until:datetime, site:Location, state:enum(open,closed)=open }\n policy Location read=public\n policy Job read=public\nWhen\nThen\n preferences { site:Location?, state:Job.state? }\n page /agenda title=\"Agenda\"\n  calendar Job start=from end=until filter=site,state defaults={site=preferences.site,state=preferences.state}\n   badge row.state\n",
    );
}

/// C1 emission: the reference descriptor carries no enum spelling. The
/// model reference lowers as `ref:<target>` and the user reference as
/// `user`, both with empty value labels; the saved reads stay verbatim
/// and the host preparer resolves the opaque identity (no decoding
/// wrapper, no truthiness, no cross-kind coercion).
#[test]
fn reference_filter_descriptor_carries_no_enum_spelling() {
    let js = emit_js(
        "app Probe\nGiven\n Location { name:text }\n Deal { title:text, location:Location, owner:user, stage:enum(lead,won)=lead }\n policy Location read=public\n policy Deal read=public\nWhen\nThen\n preferences { location:Location?, stage:Deal.stage? }\n page /sales title=\"Sales\"\n  board Deal by=stage columns=title,location,owner filter=location,owner,stage defaults={location=preferences.location,stage=preferences.stage}\n",
    );
    assert!(
        js.contains("type:\"ref:Probe.Location\""),
        "model reference descriptor names its target, got: {js}"
    );
    assert!(
        js.contains("type:\"user\""),
        "user reference descriptor names its kind, got: {js}"
    );
    assert!(
        js.contains("valueLabels:{}"),
        "reference descriptors carry no spellings, got: {js}"
    );
    assert!(
        js.contains("location:(preferences.location ?? null)"),
        "the saved reference read stays verbatim, got: {js}"
    );
    assert!(
        !js.contains("value=>{if(value==null)"),
        "no bool spelling-decoding wrapper on reference reads, got: {js}"
    );
}

/// C2 text-equality rule on boards (CAN18-v1, DESIGN 975 scalar +
/// operator table): the recorded CanField `skill` shape lowers. The
/// plain owned `text` selector conjoins beside the admitted enum
/// through the same E5 conjunction, with the saved text read lowering
/// verbatim and no case inventory.
#[test]
fn board_text_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Job { title:text, skill:text, state:enum(open,closed)=open }\n policy Job read=public\nWhen\nThen\n preferences { skill:text?, state:Job.state? }\n page /dispatch title=\"Dispatch\"\n  board Job by=state columns=title,skill filter=skill,state defaults={skill=preferences.skill,state=preferences.state}\n",
    );
}

/// C2 text-equality emission: the text descriptor carries the `text`
/// type with no value labels, and the saved read stays verbatim with
/// no bool spelling-decoding wrapper.
#[test]
fn text_filter_descriptor_carries_no_spellings() {
    let js = emit_js(
        "app Probe\nGiven\n Request { bucket:text }\n policy Request read=public\nWhen\nThen\n preferences { bucket:text? }\n page /requests title=\"Requests\"\n  list Request columns=bucket filter=bucket defaults={bucket=preferences.bucket}\n",
    );
    assert!(
        js.contains("type:\"text\""),
        "text descriptor names its kind, got: {js}"
    );
    assert!(
        js.contains("valueLabels:{}"),
        "text descriptors carry no spellings, got: {js}"
    );
    assert!(
        js.contains("bucket:(preferences.bucket ?? null)"),
        "the saved text read stays verbatim, got: {js}"
    );
    assert!(
        !js.contains("value=>{if(value==null)"),
        "no bool spelling-decoding wrapper on text reads, got: {js}"
    );
}

/// C3 civil-date equality rule on agendas (CAN18-v1, DESIGN 1015-1025
/// operator table): the recorded CanLeave `from`/`until` shape lowers.
/// Each plain owned `date` selector is an exact equality control
/// beside the admitted reference through the same E5 conjunction —
/// the same eq mechanism covers both endpoints with no range
/// generalization, and the location default stays a direct saved read.
#[test]
fn calendar_date_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Request { location:Location, from:date, until:date, state:enum(open,closed)=open }\n policy Location read=public\n policy Request read=public\nWhen\nThen\n preferences { location:Location?, state:Request.state? }\n page /leave title=\"Leave\"\n  calendar Request start=from end=until filter=location,from,until defaults={location=preferences.location}\n   badge row.state\n",
    );
}

/// C3 civil-date equality emission: the date descriptor carries the
/// `date` type with no value labels, and the saved read stays verbatim
/// with no bool spelling-decoding wrapper.
#[test]
fn date_filter_descriptor_carries_no_spellings() {
    let js = emit_js(
        "app Probe\nGiven\n Reimbursement { paid:date }\n policy Reimbursement read=public\nWhen\nThen\n preferences { paid:date? }\n page /reimbursements title=\"Reimbursements\"\n  list Reimbursement columns=paid filter=paid defaults={paid=preferences.paid}\n",
    );
    assert!(
        js.contains("type:\"date\""),
        "date descriptor names its kind, got: {js}"
    );
    assert!(
        js.contains("valueLabels:{}"),
        "date descriptors carry no spellings, got: {js}"
    );
    assert!(
        js.contains("paid:(preferences.paid ?? null)"),
        "the saved date read stays verbatim, got: {js}"
    );
    assert!(
        !js.contains("value=>{if(value==null)"),
        "no bool spelling-decoding wrapper on date reads, got: {js}"
    );
    // The `date:true` preference-leaf marker rides the page-level
    // `preferenceFields` descriptor (outside this per-node emission);
    // the installed consumer asserts it on the real artifact
    // (`packages/cloudflare/src/runtime/date-page-source-installed.test.ts`).
}

/// No literal spellings for references: an opaque identity is never an
/// authored case literal, so a text literal default keeps the exact
/// E6008 at the filter gate (the host preparer never sees it).
#[test]
fn reference_literal_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, kind:enum(individual,company)=individual, site:Location }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { site:Location?, kind:Customer.kind? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,site filter=site,kind defaults={site=\"headquarters\",kind=preferences.kind}\n",
        "E6008",
        "board filters need distinct checked owned enum fields",
    );
}

/// No computed reference defaults: a `??` fallback across two saved
/// reference reads stays refused (the enum B14 extension does not cross
/// to opaque identities). The exact E6008 stays at the filter gate.
#[test]
fn reference_coalesced_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, kind:enum(individual,company)=individual, site:Location }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { site:Location?, backup:Location? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,site filter=site,kind defaults={site=preferences.site ?? preferences.backup}\n",
        "E6008",
        "board filters need distinct checked owned enum fields",
    );
}

/// A default for an undeclared reference control stays refused (DESIGN
/// 975: defaults initialize only declared controls).
#[test]
fn undeclared_reference_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Customer { name:text, kind:enum(individual,company)=individual, site:Location }\n policy Location read=public\n policy Customer read=public\nWhen\nThen\n preferences { site:Location?, kind:Customer.kind? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,site filter=site,kind defaults={site=preferences.site,owner=preferences.site}\n",
        "E6008",
        "board filters need distinct checked owned enum fields",
    );
}

/// No cross-model coercion: a saved read of another model is not a
/// matching owned declaration for this reference filter.
#[test]
fn foreign_model_reference_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Depot { name:text }\n Customer { name:text, kind:enum(individual,company)=individual, site:Location }\n policy Location read=public\n policy Depot read=public\n policy Customer read=public\nWhen\nThen\n preferences { depot:Depot?, kind:Customer.kind? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,site filter=site,kind defaults={site=preferences.depot,kind=preferences.kind}\n",
        "E6008",
        "board filters need distinct checked owned enum fields",
    );
}

/// A preference of a different enum is not a matching owned
/// declaration for this filter.
#[test]
fn foreign_enum_preference_default_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual }\n Other { state:enum(open,closed)=open }\n policy Customer read=public\n policy Other read=public\nWhen\nThen\n preferences { state:Other.state? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=preferences.state}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// No cross-kind coercion: a bool preference read is not an enum
/// default even when both are owned.
#[test]
fn bool_read_for_enum_filter_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,kind filter=kind defaults={{kind=preferences.active}}\n"
        ),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// No cross-kind coercion: an enum preference read is not a bool
/// default even when both are owned.
#[test]
fn enum_read_for_bool_filter_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,active filter=active defaults={{active=preferences.kind}}\n"
        ),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// No truthiness shortcuts: `not` over an enum read stays refused at
/// checking (`not` must be bool).
#[test]
fn negation_over_enum_read_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,kind filter=kind defaults={{kind=not(preferences.kind)}}\n"
        ),
        "E3007",
        "no implicit truthiness",
    );
}

/// An unknown case spelling is not a default: it keeps the exact E6008
/// at the filter gate (the host preparer never sees it).
#[test]
fn unknown_case_literal_refuses() {
    assert_refuses(
        &format!(
            "{HEAD}  list Customer columns=name,kind filter=kind defaults={{kind=\"foreign\"}}\n"
        ),
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// A non-derive call is not a pure enum value form even over an
/// admitted read.
#[test]
fn non_enum_helper_call_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual, active:bool=true }\n derive label(k:Customer.kind?):bool = true\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind? }\n page /customers title=\"Customers\"\n  list Customer columns=name,kind filter=kind defaults={kind=label(preferences.kind)}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanCRM/CanInvoice/CanRent shape (6 frozen occurrences):
/// `archived=include` has no consumed factory profile.
#[test]
fn archived_include_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, kind:enum(a,b)=a, active:bool=true }\n policy Customer read=public\nWhen\nThen\n page /p title=\"P\"\n  list Customer archived=include as customer where customer.active columns=name,kind\n",
        "E6008",
        "query clause archived has no consumed factory profile",
    );
}

/// Recorded CanInvoice/CanLeave shape: expression ordering in a stored
/// query retains its typed key and owning read. The
/// stored-query `first` builtin resolves through the real values
/// catalog, so this pin compiles through the CLI exactly like the
/// frozen capture (and like `query_order.rs`).
#[test]
fn expression_query_order_keeps_typed_key_and_owning_read() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("order.can");
    std::fs::write(
        &path,
        "app Probe\nGiven\n Invoice { total:int=0 }\n derive magnitude(inv:Invoice):int = inv.total + 1\n derive first_paid():Invoice? = first(Invoice as invoice where invoice.total>0 order=magnitude(invoice))\n policy Invoice read=public\nWhen\nThen\n page /p title=\"P\"\n  list Invoice columns=total\n",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&path)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let generated = response["modules"].as_array().unwrap().iter()
        .map(|module| module["js"].as_str().unwrap()).collect::<Vec<_>>().join("\n");
    assert!(generated.contains("order:{by:async("), "{generated}");
    assert!(generated.contains("compare:($a,$b)=>$a===$b?0:$a<$b?-1:1"), "{generated}");
    assert!(generated.contains("direction:\"asc\""), "{generated}");
}

/// Recorded CanShift shape: a nested (parent-bound) calendar agenda
/// lowers through the shared collection pipeline (CAN18-v1 agenda
/// binding batch, mirroring the accepted timeline bound-sequence
/// contract), with consumed `columns=` rendered beside each endpoint
/// line, admitted enum+bool selectors beside the C1 reference rule,
/// and a matching saved reference default.
#[test]
fn nested_calendar_agenda_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Site { name:text }\n Roster { title:text }\n Commitment in Roster { site:Site, kind:enum(duty,visit)=duty, conflict:bool=false, from:datetime, until:datetime }\n policy Site read=public\n policy Roster read=public\n policy Commitment read=public\nWhen\nThen\n preferences { site:Site? }\n page /p title=\"P\"\n  list Roster\n   card \"C\"\n    calendar row.Commitment start=from end=until columns=kind,conflict filter=site,kind,conflict defaults={site=preferences.site}\n     badge row.kind\n",
    );
}
