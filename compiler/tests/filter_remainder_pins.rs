//! CAN18-v1 filter remainder pins (Lane B-filter-rest).
//!
//! Finite remainder batch from the canonical 288 capture
//! (`/tmp/can18-main-agap-capture.json`, same tuple as the promoted
//! read-only reference
//! `/Users/vince/Projects/canlang/evidence/original24-main-20261016.json`):
//! table filters 9 outer + 9 inner, list filters 4 + 4, board filters
//! 2 + 2, calendar filters 2 inner, preferences 4 (plus 1 adjacent
//! board `page` option refusal on a board `pagination` child).
//!
//! Shape determination (actual `.can` bytes at the remaining spans,
//! classified against the accepted E5 checked-conjunction + C1
//! reference rules; `C2` = text follower, `C3` = date/datetime
//! follower, both stay refused per the C1 batch):
//!
//! | recorded occurrence | filter list | failing selector (type) | disposition |
//! | CanAffiliate table x2 | reversed,qualified_at,amount.currency | qualified_at (datetime, C3) + amount.currency (dotted money leaf) | already pinned (`datetime_selector_refuses`, `dotted_path_selector_refuses`) |
//! | CanInvoice list | location,currency | currency (`currency` scalar) | NEW pin below |
//! | CanInvoice table | location,state,currency,due | currency (new) + due (date, C3) | NEW pin + `date_selector_refuses` |
//! | CanExpense list | status,location,category,business_date | category (text, C2) + business_date (date, C3); status enum + location ref are admitted leftovers | already pinned (`text_selector_refuses`, `date_selector_refuses`) |
//! | CanExpense board | status,location,category,business_date | same as list | already pinned (`board_text_selector_refuses` for the text half, `date_selector_refuses` for the date half) |
//! | CanExpense table (approved) | parent,location,category,business_date | parent (containing-parent linkage) | NEW pin below (category/business_date already pinned) |
//! | CanExpense table (Reimbursement) | paid | paid (date, C3) | already pinned (`date_selector_refuses`) |
//! | CanDesk list (Ticket, 8 selectors) | location,state,priority,assignee,unassigned,overdue,category,queue | assignee (`user?` nullable, first failure) + unassigned/overdue (derived bools) + category/queue (text, C2); location ref + state/priority enums are admitted leftovers | NEW pins below (nullable user, derived bool); text already pinned |
//! | CanLeave table (row.Request) | bucket,state | bucket (text, C2); state enum is an admitted leftover | already pinned (`text_selector_refuses`) |
//! | CanLeave table (Allowance, mine) | year,bucket | year (int) + bucket (text, C2) | already pinned (`int_selector_refuses`, `text_selector_refuses`) |
//! | CanLeave table (Request, review) | bucket,state | bucket (text, C2) | already pinned |
//! | CanLeave table (Allowance, config) | year,bucket | year (int) + bucket (text, C2) | already pinned |
//! | CanLeave calendar | location,from,until | from/until (date, C3); location ref is an admitted leftover | already pinned (`calendar_date_selector_refuses`) |
//! | CanMaintain list (Asset) | location,category,retired | category (text, C2); location ref + retired bool are admitted leftovers | already pinned (`text_selector_refuses`) |
//! | CanField board (Job) | location,state,skill | skill (text, C2) | already pinned (`board_text_selector_refuses`) |
//! | CanField calendar (Job) | location,state,skill | skill (text, C2) | NEW pin below (calendar+text was never pinned; only calendar+date was) |
//! | CanMember preferences x2 | toggle current_only | inline owning-bool toggle presentation has no source-to-factory profile | NEW pin below |
//! | CanRent preferences | toggle arrival_open | same family as above | covered by the same NEW pin |
//! | CanLeave preferences | input year + input bucket | inline scalar input presentation has no source-to-factory profile | NEW pin below |
//! | CanRent board | pagination child | board factory does not consume the `page` property | NEW pin below |
//!
//! No new rule is admitted here: every remainder shape bottoms out on
//! a C2/C3/dotted/int follower (already pinned) or on a genuinely-new
//! selector (currency scalar, nullable user, derived bool, containing
//! parent, inline preferences presentation, board pagination) for
//! which this batch makes exactly one named choice each — stay loudly
//! refused with the exact E6008 below. No new primitive, no symmetry
//! generalization (nullable user is not admitted from admitted user;
//! derived bool is not admitted from admitted stored bool; board
//! `page` is not admitted from list/table `page`), no weakened
//! permissions or refusals, no original rewrites. The recorded `where`
//! clauses accompanying refused filters (parent/actor restrictions)
//! are outside this filter batch.
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

/// Recorded CanInvoice shape (`currency:currency` on Invoice in
/// Customer with a matching `currency?` preference default): a currency
/// scalar is not a finite-choice selector, so the list keeps its exact
/// E6008 refusal. No currency-equality primitive is admitted here.
#[test]
fn currency_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, currency:currency }\n policy Customer read=public\nWhen\nThen\n preferences { currency:currency? }\n page /customers title=\"Customers\"\n  list Customer columns=name,currency filter=currency defaults={currency=preferences.currency}\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanDesk shape (`assignee:user?` beside admitted location,
/// state and priority siblings): a nullable user reference is not an
/// admitted selector even with no default (null would mean no initial
/// restriction). The admitted-user rule does not generalize to the
/// nullable spelling, so the list keeps its exact E6008 refusal.
#[test]
fn nullable_user_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Ticket { title:text, location:Location, assignee:user? }\n policy Location read=public\n policy Ticket read=public\nWhen\nThen\n page /tickets title=\"Tickets\"\n  list Ticket columns=title,location,assignee filter=location,assignee\n",
        "E6008",
        "need distinct checked owned enum fields",
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

/// Recorded CanExpense shape (`filter=parent,...` on contained
/// Expense): containing-parent linkage is not an owned field selector,
/// so the table keeps its exact E6008 refusal. No parent-linkage
/// filter rule is admitted here.
#[test]
fn parent_linkage_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Employee { name:text }\n Expense in Employee { purpose:text }\n policy Employee read=public\n policy Expense read=public\nWhen\nThen\n page /expenses title=\"Expenses\"\n  table Expense columns=purpose filter=parent\n",
        "E6008",
        "need distinct checked owned enum fields",
    );
}

/// Recorded CanMember shape (x2) and CanRent `arrival_open` shape: an
/// inline owning-bool toggle presentation (`preferences` block with a
/// `toggle` child) has no source-to-factory profile even though the
/// owning `bool` preference is declared, so the page keeps its exact
/// E6008 refusal.
#[test]
fn inline_bool_toggle_presentation_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n preferences { current_only:bool=false }\n page /mine title=\"Mine\"\n  preferences\n   toggle current_only\n  list Customer columns=name\n",
        "E6008",
        "component has no supported source-to-factory profile",
    );
}

/// Recorded CanLeave shape (`input year` + `input bucket`): an inline
/// scalar input presentation has no source-to-factory profile even
/// though the owning preferences are declared, so the page keeps its
/// exact E6008 refusal.
#[test]
fn inline_scalar_input_presentation_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text }\n policy Customer read=public\nWhen\nThen\n preferences { year:int?, bucket:text? }\n page /mine title=\"Mine\"\n  preferences\n   input year\n   input bucket\n  list Customer columns=name\n",
        "E6008",
        "component has no supported source-to-factory profile",
    );
}

/// Recorded CanRent shape (board with a `pagination` child): the board
/// factory does not consume the `page` property that `pagination`
/// lowers to (list/table/calendar/gallery/timeline do), so the board
/// keeps its exact E6008 refusal. No symmetry generalization here.
#[test]
fn board_pagination_option_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Customer { name:text, kind:enum(individual,company)=individual, active:bool=true }\n policy Customer read=public\nWhen\nThen\n preferences { kind:Customer.kind?, active:bool? }\n page /customers title=\"Customers\"\n  board Customer by=kind columns=name,active filter=kind,active defaults={kind=preferences.kind,active=preferences.active}\n   pagination\n",
        "E6008",
        "the owning factory profile does not consume this property",
    );
}

/// Recorded CanField calendar shape (`skill:text` beside admitted
/// location and state siblings): a text field is not a finite-choice
/// selector on agendas either, so the calendar keeps its exact E6008
/// checker refusal (a refused calendar filter keeps the checker
/// refusal alone).
#[test]
fn calendar_text_selector_refuses() {
    assert_refuses(
        "app Probe\nGiven\n Location { name:text }\n Job { title:text, from:datetime, until:datetime, location:Location, skill:text, state:enum(pending,done)=pending }\n policy Location read=public\n policy Job read=public\nWhen\nThen\n preferences { location:Location?, state:Job.state? }\n page /dispatch title=\"Dispatch\"\n  calendar Job start=from end=until filter=location,state,skill defaults={location=preferences.location,state=preferences.state}\n   badge row.state\n",
        "E6008",
        "calendar filters need distinct checked owned enum fields",
    );
}
