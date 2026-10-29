//! CAN18-v1 filter remainder pins (Lane B-filter-rest).
//!
//! Finite remainder batch from the canonical 288 capture
//! (`/tmp/can18-main-agap-capture.json`, same tuple as the promoted
//! read-only reference
//! `historical diagnostic snapshot (removed)`):
//! table filters 9 outer + 9 inner, list filters 4 + 4, board filters
//! 2 + 2, calendar filters 2 inner, preferences 4 (plus 1 adjacent
//! board `pagination` child, now served by the shared finite page profile).
//!
//! Shape determination (actual `.can` bytes at the remaining spans,
//! classified against the accepted E5 checked-conjunction + C1
//! reference rules; `C2` = text follower, `C3` = date/datetime
//! follower, both stay refused per the C1 batch):
//!
//! | recorded occurrence | filter list | failing selector (type) | disposition |
//! | CanAffiliate table x2 | reversed,qualified_at,amount.currency | qualified_at (datetime, C3) + amount.currency (dotted money leaf) | already pinned (`datetime_selector_refuses`, `dotted_path_selector_refuses`) |
//! | CanInvoice list | location,currency | currency (`currency` scalar) | NEW pin below |
//! | CanInvoice table | location,state,currency,due | currency (new) + due (date, C3 admitted); currency still blocks the recorded shape | NEW pin + `date_selector_lowers` |
//! | CanExpense list | status,location,category,business_date | category (text, C2 admitted) + business_date (date, C3 admitted); status enum + location ref are admitted leftovers | ADMITTED by C2+C3; component pins (`text_selector_lowers`, `date_selector_lowers`) |
//! | CanExpense board | status,location,category,business_date | same as list | ADMITTED by C2+C3; component pins (`board_text_selector_lowers`, `date_selector_lowers`) |
//! | CanExpense table (approved) | parent,location,category,business_date | parent (containing-parent linkage) | NEW pin below (category/business_date admitted by C2+C3) |
//! | CanExpense table (Reimbursement) | paid | paid (date, C3) | ADMITTED by the C3 civil-date rule; pin moved to `date_selector_lowers` |
//! | CanDesk list (Ticket, 8 selectors) | location,state,priority,assignee,unassigned,overdue,category,queue | assignee (`user?` nullable, ADMITTED by Lane E) + unassigned/overdue (derived bools, still refused) + category/queue (text, C2); location ref + state/priority enums are admitted leftovers | nullable-user pin below now asserts lowering; derived-bool pin stays refused; text already pinned |
//! | CanLeave table (row.Request) | bucket,state | bucket (text, C2); state enum is an admitted leftover | already pinned (`text_selector_refuses`) |
//! | CanLeave table (Allowance, mine) | year,bucket | year (int) + bucket (text, C2) | already pinned (`int_selector_refuses`, `text_selector_refuses`) |
//! | CanLeave table (Request, review) | bucket,state | bucket (text, C2) | already pinned |
//! | CanLeave table (Allowance, config) | year,bucket | year (int) + bucket (text, C2) | already pinned |
//! | CanLeave calendar | location,from,until | from/until (date, C3 admitted); location ref is an admitted leftover | ADMITTED by the C3 civil-date rule; pin moved to `calendar_date_selector_lowers` |
//! | CanMaintain list (Asset) | location,category,retired | category (text, C2); location ref + retired bool are admitted leftovers | already pinned (`text_selector_refuses`) |
//! | CanField board (Job) | location,state,skill | skill (text, C2) | already pinned (`board_text_selector_refuses`) |
//! | CanField calendar (Job) | location,state,skill | skill (text, C2) | ADMITTED by the C2 text-equality rule (DESIGN 975 scalar + operator table); pin below now asserts lowering |
//! | CanMember preferences x2 | toggle current_only | inline owning-bool toggle presentation has no source-to-factory profile | NEW pin below |
//! | CanRent preferences | toggle arrival_open | same family as above | covered by the same NEW pin |
//! | CanLeave preferences | input year + input bucket | inline scalar input presentation has no source-to-factory profile | NEW pin below |
//! | CanRent board | pagination child | shared finite page query and continuation | ADMITTED; owning pin below |
//!
//! C2 text-equality admission (CAN18-v1, DESIGN 975 scalar + operator
//! table): the CanField calendar `skill:text` selector lowers as an
//! exact equality control beside its admitted location/enum siblings,
//! so its pin below asserts lowering.
//!
//! C3 civil-date equality admission (CAN18-v1, DESIGN 1015-1025
//! operator table — CORRECTION per 2321: dates are civil, so the
//! missing generated controls are local implementation work): every
//! plain `date` selector (`business_date`, `paid`, `due`,
//! `from`/`until`) lowers as an exact equality control beside its
//! admitted siblings, so the component pins in `enum_filter_group.rs`
//! (`date_selector_lowers`, `calendar_date_selector_lowers`) assert
//! lowering. Every other remainder shape bottoms out on a
//! datetime/dotted/int follower (already pinned) or on a
//! genuinely-new selector (currency scalar, derived bool, containing
//! parent, inline preferences presentation) for which this batch makes
//! exactly one named choice each — stay loudly refused with the exact
//! E6008 below. Lane E admits exactly one more shape beyond the
//! civil-date rule: the nullable stored `user?` selector (opaque
//! identity, no inventory; runtime-backed in `desk_filter_profiles.rs`).
//! No further symmetry generalization (nullable `member`/enum/bool and
//! derived bool are not admitted from their admitted siblings;
//! validated string-likes, nullable text model fields and computed text
//! defaults are not admitted from admitted plain text;
//! datetime/nullable-date/computed-date are not admitted from admitted
//! plain date), no weakened permissions or refusals, no original
//! rewrites. The recorded `where` clauses
//! accompanying refused filters (parent/actor restrictions) are
//! outside this filter batch.
//!
//! Like the CLI, every stage runs and contributes diagnostics; each
//! pin below asserts the exact E6008 refusal the frozen capture
//! records for its family.
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

fn assert_refuses(source: &str, code: &str, fragment: &str) {
    let diags = emit_all(source);
    assert!(
        diags.iter().any(|d| d.starts_with(&format!("{code}:")))
            && diags.iter().any(|d| d.contains(fragment)),
        "expected {code} containing {fragment:?}, got: {diags:?}"
    );
}

fn assert_lowers(source: &str) {
    let diags = emit_all(source);
    assert!(diags.is_empty(), "unexpected diagnostics: {diags:?}");
}

/// Recorded CanInvoice currency equality preserves the exact validated
/// currency codec and its owned nullable saved preference.
#[test]
fn currency_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text, currency:currency }\n policy Customer read=public\nWhen\nThen\n preferences { currency:currency? }\n page /customers title=\"Customers\"\n  list Customer columns=name,currency filter=currency defaults={currency=preferences.currency}\n",
    );
}

/// Recorded CanDesk shape (`assignee:user?` beside admitted location,
/// state and priority siblings): a nullable stored `user?` selector is
/// admitted (Lane E exact checked Desk filter profile). It compares by
/// the same typed opaque identity as a non-nullable `user` (DESIGN 977)
/// with no case inventory; clearing the control means no restriction,
/// and a null stored value never matches a selected identity. Runtime
/// behavior is pinned end to end by `desk_filter_chain_runtime` in
/// `desk_filter_profiles.rs`.
#[test]
fn nullable_user_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Ticket { title:text, location:Location, assignee:user? }\n policy Location read=public\n policy Ticket read=public\nWhen\nThen\n page /tickets title=\"Tickets\"\n  list Ticket columns=title,location,assignee filter=location,assignee\n",
    );
}

/// Recorded CanDesk shape (`derive Ticket.overdue:bool` /
/// `Ticket.unassigned:bool` beside admitted siblings): a derived bool
/// is not a stored finite-choice toggle, so the list keeps its exact
/// E6008 refusal. The stored-bool rule does not generalize to derives.
#[test]
fn derived_bool_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Ticket { title:text, state:enum(open,resolved)=open }\n derive Ticket.overdue:bool = row.state!=resolved\n policy Ticket read=public\nWhen\nThen\n page /tickets title=\"Tickets\"\n  list Ticket columns=title,overdue filter=overdue\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanExpense parent equality consumes only its declared containing
/// model identity, using the existing typed-reference filter contract.
#[test]
fn parent_linkage_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Employee { name:text }\n Expense in Employee { purpose:text }\n policy Employee read=public\n policy Expense read=public\nWhen\nThen\n page /expenses title=\"Expenses\"\n  table Expense columns=purpose filter=parent\n",
    );
}

/// Recorded CanMember shape (x2) and CanRent `arrival_open` shape: an
/// inline owning-bool toggle presentation (`preferences` block with a
/// `toggle` child) binds the checked local bool field to its saved editor.
#[test]
fn inline_bool_toggle_presentation_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n preferences { current_only:bool=false }\n page /mine title=\"Mine\"\n  preferences\n   toggle current_only\n  list Customer columns=name\n",
    );
}

/// Recorded CanLeave shape (`input year` + `input bucket`): an inline
/// scalar inputs retain their owning type and nullable clear behavior.
#[test]
fn inline_scalar_input_presentation_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n preferences { year:int?, bucket:text? }\n page /mine title=\"Mine\"\n  preferences\n   input year\n   input bucket\n  list Customer columns=name\n",
    );
}

#[test]
fn inline_preference_controls_require_matching_local_fields() {
    let source = "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n preferences { enabled:bool=false, year:int? }\n page /mine title=\"Mine\"\n  preferences\n   toggle enabled\n";
    for control in ["toggle missing", "input enabled", "toggle year"] {
        assert_refuses(&source.replace("toggle enabled", control), "E3001",
            "preferences controls require one local bool toggle or text/int input field");
    }
}

/// A board's bare pagination marker uses the same finite query/continuation
/// contract as other collections; headers, nested content and duplicate markers
/// still refuse at the owning source checker.
#[test]
fn board_pagination_option_lowers() {
    let source = "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, active:bool? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,active filter=kind,active defaults={kind=preferences.kind,active=preferences.active}\n   pagination\n";
    assert_lowers(source);
    for marker in [
        "pagination limit=10",
        "pagination\n    text \"nested\"",
        "pagination\n   pagination",
    ] {
        assert_refuses(&source.replace("pagination", marker), "E6008", "pagination:");
    }
}

/// C2 text-equality rule on agendas (CAN18-v1, DESIGN 975 scalar +
/// operator table): the recorded CanField calendar shape lowers. The
/// plain owned `skill:text` selector conjoins beside the admitted
/// location reference and enum through the same E5 conjunction; the
/// agenda keeps no second lowering refusal for the admitted filter,
/// exactly like the admitted calendar shapes.
#[test]
fn calendar_text_selector_lowers() {
    assert_lowers(
        "app Probe\nGiven\n Location { name:text }\n Job { title:text, from:datetime, until:datetime, location:Location, skill:text, state:enum(pending,done)=pending }\n policy Location read=public\n policy Job read=public\nWhen\nThen\n preferences { location:Location?, state:Job.state?, skill:text? }\n page /dispatch title=\"Dispatch\"\n  calendar Job start=from end=until filter=location,state,skill defaults={location=preferences.location,state=preferences.state,skill=preferences.skill}\n   badge row.state\n",
    );
}
