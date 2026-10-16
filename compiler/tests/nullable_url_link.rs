//! Outcome 2 (C10): a `link` destination accepts `text`, `url`, `url?`,
//! `file` and `file?`. Library-level checker coverage; emission and
//! rendering closure is covered by the catalog-backed `ui_adapter`
//! integration test and the `link` factory tests in
//! `packages/ui/test/leaves.test.ts`.
use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

/// Check one source through the full pipeline.
fn check(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, diags) = check_program(&db, &[id], None);
    diags
}

fn messages(diags: &[Diagnostic], code: &str) -> Vec<String> {
    diags
        .iter()
        .filter(|d| d.code == code)
        .map(|d| d.message.clone())
        .collect()
}

const HEADER: &str =
    "app LinkProbe\nGiven\n Item { title:text, href:url? }\n policy Item read=public\n";

#[test]
fn nullable_url_link_targets_check_clean_direct_and_helper() {
    let src = format!(
        "{HEADER} derive pick(href:url?):url? = href\nWhen\nThen\n page / title=\"Links\"\n  list Item\n   link target=row.href caption=\"Direct\"\n   link target=pick(row.href) caption=\"Helped\"\n"
    );
    let diags = check(&src);
    let link_errors = messages(&diags, "E3001");
    assert!(
        link_errors.is_empty(),
        "nullable url link targets refused: {link_errors:?} (all: {diags:?})"
    );
}

#[test]
fn button_nullable_url_target_still_refuses() {
    let src = format!(
        "{HEADER}When\nThen\n page / title=\"Page\"\n  list Item\n   button caption=\"Open\" target=row.href\n"
    );
    let diags = check(&src);
    let errors = messages(&diags, "E3001");
    let error = errors
        .iter()
        .find(|message| message.contains("button target needs"))
        .unwrap_or_else(|| panic!("button url? target not refused: {diags:?}"));
    assert!(
        error.contains("text, url, file or nullable file"),
        "button message changed: {error}"
    );
    assert!(
        !error.contains("nullable url"),
        "button must not admit nullable url: {error}"
    );
}

#[test]
fn link_non_url_nullable_targets_still_refuse() {
    let src = "app LinkProbe\nGiven\n Item { title:text, note:text?, tags:text[] }\n policy Item read=public\nWhen\nThen\n page / title=\"Page\"\n  list Item\n   link target=row.note caption=\"Note\"\n   link target=row.tags caption=\"Tags\"\n";
    let diags = check(src);
    let link_errors: Vec<_> = messages(&diags, "E3001")
        .into_iter()
        .filter(|message| message.contains("link target needs"))
        .collect();
    assert_eq!(
        link_errors.len(),
        2,
        "nullable text/array link targets must both refuse: {diags:?}"
    );
    for message in &link_errors {
        assert!(
            message.contains("nullable url"),
            "link refusal must name the nullable-url profile: {message}"
        );
    }
}
