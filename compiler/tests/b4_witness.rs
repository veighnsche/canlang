//! B4 design-witness dispositions: one consumer test per orphaned witness
//! construct that the checker touches (B4 closeout: all 8 orphaned, zero
//! consumers).
//!
//! Disposition (verified 2026-10-05 against `check_program`):
//!
//! | # | Witness | Construct | Status |
//! |---|---------|-----------|--------|
//! | 1 | CanInbox | Given `judgment` | TESTED elsewhere (`b4_resolve`, `analysis`, `format`, `syntax`) |
//! | 2 | CanChat/CanCreative | `delivery().progress`, `Target.progressed` | GAP: no checker support; pinned by `progress_*_gap` (flip when fixed). DESIGN L678-682 + `design/complex-apps/chat-media.md#associated-progress-contract` are unimplemented and producerless — archived, not normative-working. |
//! | 3 | CanWorkbench | `invocation(Op,...)` values | TESTED elsewhere (`b4_parse`, `format`, `@canlang/values`) |
//! | 4 | CanKnowledge | Given `corpus` | PARTIAL: declaration accepted (pinned); query members (`answer`/`cancel`/`reconcile`) unvalidated, pinned by `corpus_query_members_unvalidated_gap`. DESIGN §8.3 beyond declaration unimplemented — archived. |
//! | 5 | CanCreative/CanGallery | `gallery Query image=field` | PARTIAL: `image=` requiredness enforced (pinned); target unvalidated, pinned by `gallery_image_target_unvalidated_gap`. GRAMMAR:109 + DESIGN:1104 semantic checks unimplemented — archived. |
//! | 6 | CanCreative triplet | JSON finalized-file recipe sample | TESTED elsewhere (`@canlang/files` finalize suite); the sample itself is a doc mapping, present in the triplet. |
//! | 7 | CanSync | `choose(bool,T,T)` | TESTED elsewhere (`@canlang/values` stdlib-pure suite). |
//! | 8 | CanDecide | `options=runtime` | PARTIAL: map nonempty/unique enforced (pinned); 2–26 combined-count rule unvalidated, pinned by `runtime_choice_count_unenforced_gap`. GRAMMAR:293 + `design/complex-apps/decide.md#runtime-choice-contract` count rule unimplemented — archived. |
//!
//! Gap-pin rule: each `*_gap` test pins CURRENT behavior with equivalence
//! (witness construct ≡ nearby nonsense), so it fails exactly when real
//! support lands. Never delete a gap pin to implement the feature: flip
//! its assertions to the new behavior and drop the archived claim here.

use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

/// Check one source through the full pipeline, sorted by span+code.
fn check(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], None);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

// --- Supported: gallery ----------------------------------------------------

/// `gallery` without `image=` is E1204; with a file field it checks clean.
/// (CanCreative/CanGallery witness; GRAMMAR:109 requires `image=`.)
#[test]
fn gallery_image_required() {
    let missing = check(
        "app A\nGiven\n M { title:text, cover:file }\nWhen\nThen\n page /m title=\"M\"\n  gallery M\n",
    );
    assert_eq!(codes(&missing), vec!["E1204"], "{missing:?}");
    assert!(
        missing[0]
            .message
            .contains("missing required attribute `image`"),
        "unexpected E1204: {:?}",
        missing[0].message
    );
    let ok = check(
        "app A\nGiven\n M { title:text, cover:file }\nWhen\nThen\n page /m title=\"M\"\n  gallery M image=cover\n",
    );
    assert!(ok.is_empty(), "gallery with image=file: {ok:?}");
}

// --- Supported: runtime-choice map shape -----------------------------------

/// `options=runtime` maps must be nonempty with unique names (E1204/E1202).
/// (CanDecide witness; GRAMMAR:293.)
#[test]
fn runtime_choice_map_nonempty_and_unique() {
    let empty = check(
        "app T\nGiven\n judgment J version=1\n  p choice \"Q\" options=runtime {}\nWhen\nThen\n",
    );
    assert_eq!(codes(&empty), vec!["E1204"], "{empty:?}");
    assert!(
        empty[0]
            .message
            .contains("judgment options must contain at least one entry"),
        "unexpected E1204: {:?}",
        empty[0].message
    );
    let dupes = check(
        "app T\nGiven\n judgment J version=1\n  p choice \"Q\" options=runtime {a=\"A\",a=\"B\"}\nWhen\nThen\n",
    );
    assert_eq!(codes(&dupes), vec!["E1202"], "{dupes:?}");
    assert!(
        dupes[0].message.contains("duplicate judgment option `a`"),
        "unexpected E1202: {:?}",
        dupes[0].message
    );
    let ok = check(
        "app T\nGiven\n judgment J version=1\n  p choice \"Q\" options=runtime\nWhen\nThen\n",
    );
    assert!(ok.is_empty(), "bare options=runtime: {ok:?}");
}

// --- Supported: corpus declaration -----------------------------------------

/// A complete `corpus` declaration checks clean (CanKnowledge witness).
/// Query members are NOT validated (see gap below).
#[test]
fn corpus_declaration_checks_clean() {
    let diags = check(
        "app A\nGiven\n Revision { title:text, body:text }\n corpus Handbook model=Revision scope=site title=title content=body where=live(row) from=deployment.knowledge\nWhen\nThen\n page /handbook title=\"Handbook\"\n  list Revision columns=title\n",
    );
    assert!(diags.is_empty(), "corpus declaration: {diags:?}");
}

// --- Gap: delivery progress ------------------------------------------------

/// `.progress` on a bound delivery behaves EXACTLY like `.status` and
/// `.bogus` (all opaque): the checker has no progress support. Flip when
/// DESIGN L678-682 lands (nullable typed `.progress` on observable
/// originals); until then the normative claim is archived.
#[test]
fn progress_member_unimplemented_gap() {
    fn derive(member: &str) -> Vec<Diagnostic> {
        check(&format!(
            "app T uses=[p]\npackage p\n use zzz {{Mail}} from=deployment.mail\n Given\n  M {{ t:text, request:delivery(Mail.send)? }}\n  policy M read=members\n  derive M.st:text? = row.request?.{member}\n When\n  scenario s(m:M) by=members\n   do\n    let x = 1\n Then\n"
        ))
    }
    let status = derive("status");
    let progress = derive("progress");
    let bogus = derive("bogus");
    assert_eq!(
        codes(&progress),
        codes(&status),
        "progress must behave like status while unimplemented: {progress:?} vs {status:?}"
    );
    assert_eq!(
        codes(&progress),
        codes(&bogus),
        "progress must behave like a bogus member while unimplemented: {progress:?} vs {bogus:?}"
    );
}

/// `on=` capability-event names are unvalidated: `completed`,
/// `progressed` and `bogus` all yield the identical shape diagnostic.
/// Flip when the finite event registry (GRAMMAR:365) validates names.
#[test]
fn progressed_event_unvalidated_gap() {
    fn trigger(event: &str) -> Vec<Diagnostic> {
        check(&format!(
            "app T\nGiven\n contract Ack {{ ok:bool }}\n capability Mail version=1\n  notify(to:text) -> Ack\nWhen\n scenario s() on=Mail.notify.{event}\n  do\n   let x = 1\nThen\n"
        ))
    }
    let completed = trigger("completed");
    let progressed = trigger("progressed");
    let bogus = trigger("bogus");
    assert_eq!(
        codes(&completed),
        codes(&progressed),
        "{completed:?} vs {progressed:?}"
    );
    assert_eq!(
        codes(&progressed),
        codes(&bogus),
        "{progressed:?} vs {bogus:?}"
    );
}

// --- Gap: corpus query members ----------------------------------------------

/// `send Handbook.answer` behaves exactly like `send Handbook.bogus`
/// (both E2001: the corpus name resolves nowhere in expression
/// position): corpus query members are unvalidated. Flip when
/// DESIGN §8.3 answer/cancel/reconcile members land.
#[test]
fn corpus_query_members_unvalidated_gap() {
    fn send(op: &str) -> Vec<Diagnostic> {
        check(&format!(
            "app A\nGiven\n Revision {{ title:text, body:text }}\n corpus Handbook model=Revision scope=site title=title content=body where=live(row) from=deployment.knowledge\nWhen\n scenario s() by=members\n  do\n   send Handbook.{op} {{scope=\"s\",value=\"q\"}} as attempt\nThen\n"
        ))
    }
    let answer = send("answer");
    let bogus = send("bogus");
    assert_eq!(codes(&answer), vec!["E2001"], "{answer:?}");
    assert_eq!(codes(&answer), codes(&bogus), "{answer:?} vs {bogus:?}");
}

// --- Gap: gallery image target -----------------------------------------------

/// `image=` pointing at a file field, a text field, or an unknown name
/// all check clean: the target is unvalidated. Flip when GRAMMAR:109 /
/// DESIGN:1104 land (exactly one readable image `file` field).
#[test]
fn gallery_image_target_unvalidated_gap() {
    fn gallery(image: &str) -> Vec<Diagnostic> {
        check(&format!(
            "app A\nGiven\n M {{ title:text, cover:file }}\nWhen\nThen\n page /m title=\"M\"\n  gallery M image={image}\n"
        ))
    }
    let file = gallery("cover");
    let text = gallery("title");
    let unknown = gallery("nope");
    assert!(file.is_empty(), "file target: {file:?}");
    assert_eq!(
        codes(&text),
        codes(&file),
        "text target must match file while unvalidated: {text:?}"
    );
    assert_eq!(
        codes(&unknown),
        codes(&file),
        "unknown target must match file while unvalidated: {unknown:?}"
    );
}

// --- Gap: runtime-choice combined count ---------------------------------------

/// One fixed choice with `options=runtime` checks clean: the GRAMMAR:293
/// combined 2–26 rule is unenforced (the runtime half is unknowable
/// statically, and the fixed floor is unchecked). Flip when the count
/// rule lands per `design/complex-apps/decide.md#runtime-choice-contract`.
#[test]
fn runtime_choice_count_unenforced_gap() {
    let diags = check(
        "app T\nGiven\n judgment J version=1\n  p choice \"Q\" options=runtime {only=\"O\"}\nWhen\nThen\n",
    );
    assert!(
        diags.is_empty(),
        "single fixed choice must stay silent while uncounted: {diags:?}"
    );
}
