//! B4/F6 `set x.parent` regression tests: set-target resolution parity
//! with expression resolution (GRAMMAR:358 `mutation_target=path`).
//!
//! Failing-first: `set_parent_resolves_like_expression`,
//! `set_parent_enum_value_elides`, and `set_parent_bad_value_still_errors`
//! fail before the types-pass fix (`E2013` on the set target, plus an
//! `E2001` cascade on the bare enum case) and pass after.
//! `set_parent_phantom_member_still_e2013` is a guard that passes before
//! and after: phantom members must keep erroring in both positions.

use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

/// Check one source, returning sorted diagnostics.
fn check(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], None);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
}

/// Byte span of the 1-based `occurrence`-th appearance of `needle`.
fn span_of(src: &str, needle: &str, occurrence: usize) -> (u32, u32) {
    assert!(occurrence >= 1, "occurrences are 1-based");
    let mut idx = 0;
    let mut found = 0;
    while found < occurrence {
        match src[idx..].find(needle) {
            Some(at) => {
                idx += at;
                found += 1;
                if found < occurrence {
                    idx += needle.len();
                }
            }
            None => panic!("needle {needle:?} has fewer than {occurrence} occurrences"),
        }
    }
    (idx as u32, (idx + needle.len()) as u32)
}

/// Assert exact `(code, start, end)` findings; `expected` entries are
/// `(code, span needle, needle occurrence)`.
#[track_caller]
fn assert_findings(src: &str, diags: &[Diagnostic], expected: &[(&str, &str, usize)]) {
    let mut want: Vec<(String, u32, u32)> = expected
        .iter()
        .map(|(code, needle, occ)| {
            let (start, end) = span_of(src, needle, *occ);
            ((*code).to_string(), start, end)
        })
        .collect();
    want.sort();
    let mut got: Vec<(String, u32, u32)> = diags
        .iter()
        .map(|d| (d.code.to_string(), d.primary.start, d.primary.end))
        .collect();
    got.sort();
    assert_eq!(got, want, "source:\n{src}\nall diagnostics: {diags:?}");
}

/// The identical path resolves in expression position and as a `set`
/// target (CanBook:174 vs :175, CanDecide:102 vs :106). Flips the
/// `set_parent_target_current_behavior` characterization in
/// `b4_resolve.rs`: this source must check clean.
#[test]
fn set_parent_resolves_like_expression() {
    let src = r#"app T
Given
 Cafe {location:text}
 Table in Cafe {seats:int}
 policy Cafe read=members
 policy Table read=members
When
 scenario s(t:Table) by=members
  require t.parent.location!="x"
  do
   set t.parent {location="y"}
Then
"#;
    let diags = check(src);
    assert!(
        diags.is_empty(),
        "source:\n{src}\nall diagnostics: {diags:?}"
    );
}

/// Set-value checking applies through the resolved parent: the bare
/// `unavailable` case elides against the parent's enum state (the
/// CanBook ×8 shape: `E2013` + `E2001` cascade before the fix).
#[test]
fn set_parent_enum_value_elides() {
    let src = r#"app T
Given
 Slot {state:enum(pending,unavailable)=pending}
 Attempt in Slot {tries:int}
 policy Slot read=members
 policy Attempt read=members
When
 scenario s(a:Attempt) by=members
  require a.parent.state==pending
  do
   set a.parent {state=unavailable}
Then
"#;
    let diags = check(src);
    assert!(
        diags.is_empty(),
        "source:\n{src}\nall diagnostics: {diags:?}"
    );
}

/// GUARD (passes before and after): phantom members still `E2013` in
/// both positions — expression `t.parent.typo_here` and set-target
/// `t.bogus_field_xyz`. A resolve-only fix that synthesizes `parent`
/// degrades these to silence; the types-pass fix must not.
#[test]
fn set_parent_phantom_member_still_e2013() {
    let src = r#"app T
Given
 Cafe {location:text}
 Table in Cafe {seats:int}
 policy Cafe read=members
 policy Table read=members
When
 scenario s(t:Table) by=members
  require t.parent.typo_here!="x"
  do
   set t.bogus_field_xyz {location="y"}
Then
"#;
    let diags = check(src);
    assert_findings(
        src,
        &diags,
        &[("E2013", "typo_here", 1), ("E2013", "bogus_field_xyz", 1)],
    );
}

/// A resolved parent still checks the set value: the bogus key errors
/// against model `Cafe` (proving the target navigated to the parent
/// record), instead of checking clean as it does under the unsound
/// resolve-only patch (b4-f2.md §3). Before the fix this source
/// reports `E2013` on the `parent` segment instead.
#[test]
fn set_parent_bad_value_still_errors() {
    let src = r#"app T
Given
 Cafe {location:text}
 Table in Cafe {seats:int}
 policy Cafe read=members
 policy Table read=members
When
 scenario s(t:Table) by=members
  require t.parent.location!="x"
  do
   set t.parent {bogus_field_xyz=1}
Then
"#;
    let diags = check(src);
    assert_findings(src, &diags, &[("E2013", "bogus_field_xyz", 1)]);
}
