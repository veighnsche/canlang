//! IDE queries and real LSP backend tests (lane-01, PR7 part 3).
//!
//! Every span below traces to CST/analysis output observed through the
//! probes during development; nothing here is invented.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::ide::fixes::{self, FixEdit};
use canlang_compiler::ide::queries::{Snapshot, offset_at_position};
use canlang_compiler::ide::tokens;
use canlang_compiler::lsp::server::{RealAnalysis, Server};
use canlang_compiler::lsp::transport as t;
use canlang_compiler::source::{SourceDb, SourceId, Span};

/// Main fixture: model, scenario, let binding, member access, set target.
///
/// Observed layout (byte offsets):
/// - module `Tasks` name: 4..9
/// - `Todo` decl: 17..21, field `title`: 24..29, `text`: 30..34
/// - `complete` decl: 52..60, param `task`: 61..65, type use `Todo`: 66..70
/// - `members`: 75..82, `let` stmt: 87..111, `label` decl: 95..100
/// - `task` use: 101..105, member `title`: 106..111 (unresolved)
/// - set target `task`: 119..123 (resolved), entry key `title`: 125..130
/// - `label` use: 131..136
const FIXTURE: &str = "app Tasks\nGiven\n Todo { title:text }\nWhen\n scenario complete(task:Todo) by=members\n  do\n   let label=task.title\n   set task {title=label}\nThen\n";

fn load(text: &str) -> (SourceDb, SourceId) {
    let mut db = SourceDb::new();
    let id = db.add("t.can".to_string(), text.to_string());
    (db, id)
}

fn spans_of(spans: &[Span]) -> Vec<(u32, u32)> {
    spans.iter().map(|s| (s.start, s.end)).collect()
}

fn test_catalog(tag: &str) -> Catalog {
    // One file per test: parallel tests must not share a path while
    // writing (truncate-then-write races a concurrent read).
    let dir = std::env::temp_dir();
    let path = dir.join(format!("canlang-ide-test-catalog-{tag}.json"));
    let doc = r#"{"language_version":"1.0","catalog_version":"probe-1","entries":[{"id":"count","js":"count","owner":"lane-02","kind":"builtin","signature":"count(values:C<T>)->int","effects":"pure","availability":"implemented"}]}"#;
    std::fs::write(&path, doc).unwrap();
    let (catalog, diags) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &dir,
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diags.is_empty(), "{diags:?}");
    catalog.expect("catalog loads")
}

// --- hover ---

#[test]
fn hover_symbol_decl_and_use() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let decl = snapshot.hover_at(18).expect("hover on Todo decl");
    assert_eq!(decl.markdown, "**Tasks.Todo** — model");
    assert_eq!((decl.span.start, decl.span.end), (17, 21));
    let use_site = snapshot.hover_at(67).expect("hover on Todo type use");
    assert_eq!(use_site.markdown, "**Tasks.Todo** — model");
    assert_eq!((use_site.span.start, use_site.span.end), (66, 70));
    let param = snapshot.hover_at(102).expect("hover on task use");
    assert_eq!(
        param.markdown,
        "**Tasks.complete.task** — parameter\n\ndeclared: `Todo`"
    );
    assert_eq!((param.span.start, param.span.end), (101, 105));
}

#[test]
fn hover_local_binding_shows_type() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let hover = snapshot.hover_at(133).expect("hover on label use");
    assert_eq!(hover.markdown, "**label** — let binding\n\ntype: `text`");
    assert_eq!((hover.span.start, hover.span.end), (131, 136));
}

#[test]
fn hover_predicate_and_unresolved_are_empty() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let predicate = snapshot.hover_at(76).expect("hover on members");
    assert!(
        predicate.markdown.contains("actor predicate"),
        "{}",
        predicate.markdown
    );
    assert_eq!((predicate.span.start, predicate.span.end), (75, 82));
    // Member-navigation names have no resolution entry: empty, never a guess.
    assert!(snapshot.hover_at(108).is_none());
    // Mutation targets resolve their head, without guessing field selectors.
    assert!(
        snapshot
            .hover_at(120)
            .unwrap()
            .markdown
            .contains("Tasks.complete.task")
    );
    // Keywords and trivia: empty.
    assert!(snapshot.hover_at(1).is_none());
    // Past the end: empty.
    assert!(snapshot.hover_at(5000).is_none());
}

#[test]
fn hover_shows_descriptions() {
    let text = "# Track work.\napp Tasks\nGiven\n # The title.\n Todo { title:text }\nWhen\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    let model = snapshot.hover_at(46).expect("hover on Todo");
    assert_eq!(model.markdown, "**Tasks.Todo** — model\n\nThe title.");
    let app = snapshot.hover_at(19).expect("hover on Tasks");
    assert_eq!(app.markdown, "**Tasks** — app\n\nTrack work.");
}

#[test]
fn hover_builtin_with_catalog() {
    let catalog = test_catalog("hover");
    let text = "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=count(M)\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, Some(&catalog));
    let offset = text.find("count(M)").unwrap() as u32 + 1;
    let hover = snapshot.hover_at(offset).expect("hover on count");
    assert_eq!(
        hover.markdown,
        "**count** — builtin\n\ncatalog `probe-1`\n\neffects: pure\navailability: implemented"
    );
    // Without a catalog the same use is unresolved: empty.
    let bare = Snapshot::analyze(&db, id, None);
    assert!(bare.hover_at(offset).is_none());
}

// --- D06: hover reads the one checked description slot ---

#[test]
fn hover_field_description_spellings() {
    let text = "app Shop\nGiven\n Gadget {\n  # Attached wording.\n  attached:text,\n  inline:text desc=\"Inline wording.\",\n  legacy:text @{desc=\"Legacy wording.\"},\n  empty:text desc=\"\",\n  bare:int\n }\n policy Gadget read=members\nWhen\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    for (needle, wording) in [
        ("attached:text", "Attached wording."),
        ("inline:text", "Inline wording."),
        ("legacy:text", "Legacy wording."),
    ] {
        let offset = text.find(needle).unwrap() as u32 + 1;
        let hover = snapshot.hover_at(offset).expect("hover on described field");
        let name = needle.split(':').next().unwrap();
        assert_eq!(
            hover.markdown,
            format!("**Shop.Gadget.{name}** — field\n\ndeclared: `text`\n\n{wording}")
        );
    }
    // Authored-empty and undescribed fields show no description section.
    for (needle, ty) in [("empty:text", "text"), ("bare:int", "int")] {
        let offset = text.find(needle).unwrap() as u32 + 1;
        let hover = snapshot.hover_at(offset).expect("hover on field");
        let name = needle.split(':').next().unwrap();
        assert_eq!(
            hover.markdown,
            format!("**Shop.Gadget.{name}** — field\n\ndeclared: `{ty}`")
        );
    }
}

#[test]
fn hover_description_static_reference_resolves_wording() {
    let text = "app Shop\nGiven\n message shared_msg = \"Shared wording.\"@{nl=\"Gedeelde tekst.\"}\n Gadget {\n  #= shared_msg\n  attached:text,\n  inline:text desc=shared_msg\n }\n policy Gadget read=members\nWhen\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    for needle in ["attached:text", "inline:text"] {
        let offset = text.find(needle).unwrap() as u32 + 1;
        let hover = snapshot.hover_at(offset).expect("hover on described field");
        let name = needle.split(':').next().unwrap();
        assert_eq!(
            hover.markdown,
            format!("**Shop.Gadget.{name}** — field\n\ndeclared: `text`\n\nShared wording.")
        );
        assert!(
            !hover.markdown.contains("see "),
            "resolved wording, never a pointer: {}",
            hover.markdown
        );
    }
}

#[test]
fn hover_description_shows_source_language_only() {
    let text = "app Shop\nGiven\n Gadget { name:text desc=\"Source wording.\"@{nl=\"Brontekst.\"} }\n policy Gadget read=members\nWhen\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let offset = text.find("name:text").unwrap() as u32 + 1;
    let hover = snapshot.hover_at(offset).expect("hover on described field");
    assert_eq!(
        hover.markdown,
        "**Shop.Gadget.name** — field\n\ndeclared: `text`\n\nSource wording."
    );
    assert!(
        !hover.markdown.contains("Brontekst"),
        "no locale selection in hover: {}",
        hover.markdown
    );
}

#[test]
fn hover_param_description_from_slot() {
    let text = "app Shop\nGiven\n Gadget { title:text }\n policy Gadget read=members\nWhen\n scenario approve(note:text desc=\"Param wording.\") by=members\n  do\n   let x = 1\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let offset = text.find("note:text").unwrap() as u32 + 1;
    let hover = snapshot.hover_at(offset).expect("hover on described param");
    assert_eq!(
        hover.markdown,
        "**Shop.approve.note** — parameter\n\ndeclared: `text`\n\nParam wording."
    );
}

// --- definition ---

#[test]
fn definition_spans() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert_eq!(spans_of(&snapshot.definition_at(102)), [(61, 65)]);
    assert_eq!(spans_of(&snapshot.definition_at(67)), [(17, 21)]);
    assert_eq!(spans_of(&snapshot.definition_at(18)), [(17, 21)]);
    assert_eq!(spans_of(&snapshot.definition_at(133)), [(95, 100)]);
    assert_eq!(spans_of(&snapshot.definition_at(97)), [(95, 100)]);
    // Builtin scalars, member names and keywords have no definition.
    assert!(snapshot.definition_at(31).is_empty());
    assert!(snapshot.definition_at(108).is_empty());
    assert!(snapshot.definition_at(1).is_empty());
    assert!(snapshot.definition_at(5000).is_empty());
}

// --- references ---

#[test]
fn references_spans() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    // Todo: declaration plus the parameter type use.
    assert_eq!(spans_of(&snapshot.references_at(18)), [(17, 21), (66, 70)]);
    assert_eq!(spans_of(&snapshot.references_at(67)), [(17, 21), (66, 70)]);
    // task: declaration, member-receiver use and mutation-target head.
    assert_eq!(
        spans_of(&snapshot.references_at(63)),
        [(61, 65), (101, 105), (119, 123)]
    );
    // label: declaration plus the object-entry use.
    assert_eq!(
        spans_of(&snapshot.references_at(97)),
        [(95, 100), (131, 136)]
    );
    // title field: declaration only (member and key positions unresolved).
    assert_eq!(spans_of(&snapshot.references_at(26)), [(24, 29)]);
    // Unresolved positions: empty.
    assert!(snapshot.references_at(108).is_empty());
    assert!(snapshot.references_at(76).is_empty());
}

// --- rename ---

#[test]
fn rename_spans_and_hash() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let rename = snapshot.rename_at(102).expect("rename task");
    assert_eq!(spans_of(&rename.spans), [(61, 65), (101, 105), (119, 123)]);
    assert_eq!(rename.sha256, snapshot.sha256());
    assert_eq!(rename.sha256.len(), 64);
    let label = snapshot.rename_at(133).expect("rename label");
    assert_eq!(spans_of(&label.spans), [(95, 100), (131, 136)]);
    // Predicates, member names and keywords are refused, never guessed.
    assert!(snapshot.rename_at(76).is_none());
    assert!(snapshot.rename_at(108).is_none());
    assert!(snapshot.rename_at(1).is_none());
}

#[test]
fn mutation_target_references_capture_statement_time_identity() {
    let text = "app T\nGiven\n Todo { title:text }\nWhen\n scenario complete(task:Todo,other:Todo) by=members\n  do\n   let label=task.title\n   set task {title=label}\n   delete task\n   let task=other\n   set task {title=label}\n   delete task\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let occurrences: Vec<_> = text
        .match_indices("task")
        .map(|(i, _)| (i as u32, i as u32 + 4))
        .collect();
    assert_eq!(occurrences.len(), 7);
    let parameter = &occurrences[..4];
    let local = &occurrences[4..];
    for &(start, _) in parameter {
        assert_eq!(spans_of(&snapshot.references_at(start)), parameter);
        assert_eq!(
            spans_of(&snapshot.rename_at(start).unwrap().spans),
            parameter
        );
        assert_eq!(spans_of(&snapshot.definition_at(start)), [parameter[0]]);
    }
    for &(start, _) in local {
        assert_eq!(spans_of(&snapshot.references_at(start)), local);
        assert_eq!(spans_of(&snapshot.rename_at(start).unwrap().spans), local);
        assert_eq!(spans_of(&snapshot.definition_at(start)), [local[0]]);
    }
}

#[test]
fn mutation_target_head_excludes_field_selectors_and_unresolved_names() {
    let text = "app T\nGiven\n Todo { title:text }\n Box { child:Todo }\nWhen\n scenario complete(task:Box) by=members\n  do\n   set task.child {title=\"done\"}\n   delete task.child\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let expected: Vec<_> = text
        .match_indices("task")
        .map(|(i, _)| (i as u32, i as u32 + 4))
        .collect();
    assert_eq!(expected.len(), 3);
    for &(start, _) in &expected {
        assert_eq!(
            spans_of(&snapshot.rename_at(start).unwrap().spans),
            expected
        );
    }
    for (i, _) in text.match_indices("task.child") {
        assert!(snapshot.rename_at(i as u32 + 5).is_none());
        assert!(snapshot.references_at(i as u32 + 5).is_empty());
    }
    let bad = text.replace("task.child", "missing.child");
    let (db, id) = load(&bad);
    let snapshot = Snapshot::analyze(&db, id, None);
    for (i, _) in bad.match_indices("missing.child") {
        assert!(snapshot.rename_at(i as u32).is_none());
    }
}

#[test]
fn clean_rename_applies_to_reads_and_mutations_then_rechecks() {
    let text = FIXTURE
        .replace("   let", "   ## é😀\n   let")
        .replace(
            "   set task {title=label}",
            "   set task {title=label}\n   delete task",
        )
        .replace('\n', "\r\n");
    let (db, id) = load(&text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let rename = snapshot
        .rename_at(text.find("set task").unwrap() as u32 + 4)
        .unwrap();
    let expected: Vec<_> = text
        .match_indices("task")
        .map(|(i, _)| (i as u32, i as u32 + 4))
        .collect();
    assert_eq!(expected.len(), 4);
    assert_eq!(spans_of(&rename.spans), expected);
    let mut applied = text.clone();
    for span in rename.spans.iter().rev() {
        applied.replace_range(span.start as usize..span.end as usize, "job");
    }
    assert_eq!(applied, text.replace("task", "job"));
    assert!(applied.contains("job.title"));
    assert!(applied.contains("set job {title=label}"));
    assert!(applied.contains("delete job"));
    let (db, id) = load(&applied);
    let renamed = Snapshot::analyze(&db, id, None);
    assert!(
        renamed.diagnostics().is_empty(),
        "{:?}",
        renamed.diagnostics()
    );
}

// --- completion ---

#[test]
fn enum_match_completion_and_tokens_follow_the_subject_and_arm_scope() {
    let text = "app EnumTools\nGiven\n Choice {state:enum(a,b)=a}\n Other {state:enum(b,c)=b}\nWhen\n scenario caption(record:Choice,b:Other.state) read=true -> text by=members\n  do\n   match record.state\n    case a\n     let onlyA=\"A\"\n     return onlyA\n    case b\n     let onlyB=\"B\"\n     return onlyB\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    let label = text.find("case b").unwrap() as u32 + 5;
    let completion = snapshot.completions_at(label);
    assert_eq!(labels(&completion), ["b"]);
    assert_eq!(completion[0].kind, "EnumMember");
    assert!(
        snapshot.hover_at(label).is_none(),
        "case label must not capture the b parameter"
    );
    let body = snapshot.completions_at(text.find("return onlyB").unwrap() as u32 + 8);
    assert!(labels(&body).contains(&"onlyB"));
    assert!(!labels(&body).contains(&"onlyA"));
    let statement = snapshot.completions_at(text.find("match record").unwrap() as u32 + 1);
    assert!(labels(&statement).contains(&"match"));
    assert!(!labels(&statement).contains(&"case"));
    let decoded = decode_tokens(&tokens::semantic_tokens(&snapshot));
    assert!(decoded.contains(&(7, 3, 5, token_index("keyword"), 0)));
    assert!(decoded.contains(&(11, 4, 4, token_index("keyword"), 0)));
    assert!(decoded.contains(&(11, 9, 1, token_index("enumMember"), 0)));
    let partial = text.replacen("case b", "case pending", 1);
    let (db, id) = load(&partial);
    let editing = Snapshot::analyze(&db, id, None);
    let completion = editing.completions_at(partial.find("case pending").unwrap() as u32 + 6);
    assert_eq!(labels(&completion), ["b"]);
    assert_eq!(completion[0].kind, "EnumMember");
}

fn labels(items: &[canlang_compiler::ide::queries::Completion]) -> Vec<&str> {
    items.iter().map(|c| c.label.as_str()).collect()
}

#[test]
fn completion_expression_scope() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let items = snapshot.completions_at(103);
    let labels = labels(&items);
    // Visible scope bindings and module symbols.
    for expected in ["task", "label", "Todo", "complete", "actor", "now"] {
        assert!(labels.contains(&expected), "missing {expected}: {labels:?}");
    }
    // Expression keywords.
    for expected in ["and", "or", "not", "true", "false", "null", "where"] {
        assert!(labels.contains(&expected), "missing {expected}: {labels:?}");
    }
    // Sorted and deduplicated.
    let mut sorted = labels.clone();
    sorted.sort();
    assert_eq!(labels, sorted);
    // Precise kinds.
    let kind_of = |label: &str| {
        items
            .iter()
            .find(|c| c.label == label)
            .map(|c| c.kind)
            .unwrap()
    };
    assert_eq!(kind_of("Todo"), "Class");
    assert_eq!(kind_of("complete"), "Function");
    assert_eq!(kind_of("task"), "Variable");
    assert_eq!(kind_of("and"), "Keyword");
}

#[test]
fn completion_type_position() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let items = snapshot.completions_at(68);
    let labels = labels(&items);
    for expected in ["int", "text", "bool", "enum", "action", "delivery", "Todo"] {
        assert!(labels.contains(&expected), "missing {expected}: {labels:?}");
    }
}

#[test]
fn completion_section_keywords() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    // Trivia inside the Given section (offset 15: newline before Todo).
    let items = snapshot.completions_at(15);
    let labels = labels(&items);
    for expected in ["capability", "policy", "message", "export"] {
        assert!(labels.contains(&expected), "missing {expected}: {labels:?}");
    }
}

#[test]
fn completion_builtin_with_catalog() {
    let catalog = test_catalog("completion");
    let text = "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   let x=1\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, Some(&catalog));
    let offset = text.find("let x=1").unwrap() as u32 + 6;
    let items = snapshot.completions_at(offset);
    let entry = items
        .iter()
        .find(|c| c.label == "count")
        .expect("count offered");
    assert_eq!(entry.kind, "Function");
    assert_eq!(entry.detail.as_deref(), Some("builtin"));
}

// --- document symbols ---

#[test]
fn document_symbols_outline() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let roots = snapshot.document_symbols();
    assert_eq!(roots.len(), 1);
    let app = &roots[0];
    assert_eq!(app.name, "Tasks");
    assert_eq!(app.kind, "app");
    assert_eq!((app.span.start, app.span.end), (4, 9));
    assert_eq!((app.range.start, app.range.end), (0, 142));
    assert_eq!(app.children.len(), 2);
    let model = &app.children[0];
    assert_eq!(model.name, "Todo");
    assert_eq!(model.kind, "model");
    assert_eq!((model.span.start, model.span.end), (17, 21));
    assert_eq!((model.range.start, model.range.end), (15, 36));
    assert_eq!(model.children.len(), 1);
    assert_eq!(model.children[0].name, "title");
    assert_eq!(model.children[0].kind, "field");
    assert_eq!(
        (model.children[0].span.start, model.children[0].span.end),
        (24, 29)
    );
    let scenario = &app.children[1];
    assert_eq!(scenario.name, "complete");
    assert_eq!(scenario.kind, "scenario");
    assert_eq!((scenario.span.start, scenario.span.end), (52, 60));
    assert_eq!((scenario.range.start, scenario.range.end), (41, 137));
    assert_eq!(scenario.children.len(), 1);
    assert_eq!(scenario.children[0].name, "task");
    assert_eq!(scenario.children[0].kind, "parameter");
    assert_eq!(
        (
            scenario.children[0].span.start,
            scenario.children[0].span.end
        ),
        (61, 65)
    );
}

// --- semantic tokens ---

/// Undelta LSP token data into `(line, col, len, type, mods)` tuples.
fn decode_tokens(data: &[u32]) -> Vec<(u32, u32, u32, u32, u32)> {
    assert_eq!(data.len() % 5, 0, "token data is quintuples");
    let mut out = Vec::new();
    let (mut line, mut col) = (0u32, 0u32);
    for quint in data.as_chunks::<5>().0 {
        line += quint[0];
        if quint[0] == 0 {
            col += quint[1];
        } else {
            col = quint[1];
        }
        out.push((line, col, quint[2], quint[3], quint[4]));
    }
    out
}

fn token_index(name: &str) -> u32 {
    tokens::TOKEN_TYPES
        .iter()
        .position(|t| *t == name)
        .expect("legend type") as u32
}

#[test]
fn semantic_tokens_tiny_exact() {
    // Derived by hand from the CST: `app` and the section markers are
    // keywords; the module name has no token.
    let (db, id) = load("app T\nGiven\nWhen\nThen\n");
    let snapshot = Snapshot::analyze(&db, id, None);
    let decoded = decode_tokens(&tokens::semantic_tokens(&snapshot));
    let keyword = token_index("keyword");
    assert_eq!(
        decoded,
        vec![
            (0, 0, 3, keyword, 0),
            (1, 0, 5, keyword, 0),
            (2, 0, 4, keyword, 0),
            (3, 0, 4, keyword, 0),
        ]
    );
}

#[test]
fn semantic_tokens_classify_fixture() {
    let (db, id) = load(FIXTURE);
    let snapshot = Snapshot::analyze(&db, id, None);
    let decoded = decode_tokens(&tokens::semantic_tokens(&snapshot));
    // Sorted by (line, col).
    let mut sorted = decoded.clone();
    sorted.sort_by_key(|(line, col, _, _, _)| (*line, *col));
    assert_eq!(decoded, sorted);
    // Every type index names a legend entry.
    for (_, _, _, ty, mods) in &decoded {
        assert!((*ty as usize) < tokens::TOKEN_TYPES.len());
        assert!(*mods < 16, "only four modifier bits exist");
    }
    let has = |line, col, len, ty: u32, mods: u32| decoded.contains(&(line, col, len, ty, mods));
    let class = token_index("class");
    let property = token_index("property");
    let parameter = token_index("parameter");
    let variable = token_index("variable");
    let keyword = token_index("keyword");
    let ty = token_index("type");
    let operator = token_index("operator");
    const DECL: u32 = 1;
    const DEFAULT_LIB: u32 = 4;
    // `Todo` declaration (line 2, col 1) and its type use (line 4).
    assert!(has(2, 1, 4, class, DECL), "{decoded:?}");
    assert!(has(4, 24, 4, ty, 0), "{decoded:?}");
    // Field declaration `title` (line 2, col 8).
    assert!(has(2, 8, 5, property, DECL), "{decoded:?}");
    // Builtin scalar `text` (line 2, col 14).
    assert!(has(2, 14, 4, ty, DEFAULT_LIB), "{decoded:?}");
    // Parameter declaration and use.
    assert!(has(4, 19, 4, parameter, DECL), "{decoded:?}");
    assert!(has(6, 13, 4, parameter, 0), "{decoded:?}");
    // Let binding declaration and use.
    assert!(has(6, 7, 5, variable, DECL), "{decoded:?}");
    assert!(has(7, 19, 5, variable, 0), "{decoded:?}");
    // Member-navigation name: syntactic `property` fallback.
    assert!(has(6, 18, 5, property, 0), "{decoded:?}");
    // Predicate and operator leaves.
    assert!(has(4, 33, 7, keyword, 0), "{decoded:?}");
    assert!(has(6, 17, 1, operator, 0), "{decoded:?}");
}

// --- fixes ---

#[test]
fn fixes_for_analysis_diagnostics_are_deliberately_empty() {
    use canlang_compiler::diagnostic::Diagnostic;
    let (db, id) = load(
        "app T\nGiven\nWhen\n scenario s(m:Nope) by=members\n  do\n   let x=m.n+\"s\"\nThen\n",
    );
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(!snapshot.diagnostics().is_empty());
    for diagnostic in snapshot.diagnostics() {
        assert!(
            fixes::fixes_for(diagnostic, snapshot.sha256()).is_empty(),
            "no safe fix ships for {}",
            diagnostic.code
        );
    }
    // Unknown codes are empty too, never errors.
    let unknown = Diagnostic::error(
        Box::leak("E9999".to_string().into_boxed_str()),
        "bogus".to_string(),
        Span::new(id, 0, 1),
    );
    assert!(fixes::fixes_for(&unknown, snapshot.sha256()).is_empty());
}

#[test]
fn lint_fix_wrap_apply_and_stale() {
    use canlang_compiler::lint::{LintConfig, collect_fixes};
    let text = "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=m?.n\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    let config = LintConfig {
        fix: true,
        ..LintConfig::default()
    };
    let lint_fixes = collect_fixes(snapshot.program(), &db, &config);
    let lint_fix = lint_fixes
        .iter()
        .find(|f| f.rule == "redundant-null-marker")
        .expect("I1002 fix observed");
    assert_eq!((lint_fix.span.start, lint_fix.span.end), (73, 75));
    let fix = fixes::from_lint_fix(lint_fix);
    assert_eq!(fix.edits.len(), 1);
    assert_eq!(fix.expected_sha256, snapshot.sha256());
    // Applying rewrites `?.` to `.`.
    let applied = fixes::apply_fix(text, &fix).expect("applies");
    assert_eq!(
        applied,
        "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=m.n\nThen\n"
    );
    // Stale content is refused, never forced.
    assert_eq!(
        fixes::apply_fix("app T\nGiven\nWhen\nThen\n", &fix),
        Err(fixes::FixError::StaleContent)
    );
    // Overlapping edits are refused.
    let sha = snapshot.sha256().to_string();
    let overlapping = fixes::DiagnosticFix {
        id: "test",
        title: "test".to_string(),
        kind: "quickfix",
        safe: true,
        expected_sha256: sha.clone(),
        edits: vec![
            FixEdit {
                start: 0,
                end: 5,
                new_text: String::new(),
            },
            FixEdit {
                start: 4,
                end: 8,
                new_text: String::new(),
            },
        ],
    };
    assert_eq!(
        fixes::apply_fix(text, &overlapping),
        Err(fixes::FixError::Overlap)
    );
    // Out-of-bounds ranges are refused.
    let bad = fixes::DiagnosticFix {
        id: "test",
        title: "test".to_string(),
        kind: "quickfix",
        safe: true,
        expected_sha256: sha,
        edits: vec![FixEdit {
            start: 0,
            end: 5000,
            new_text: String::new(),
        }],
    };
    assert_eq!(fixes::apply_fix(text, &bad), Err(fixes::FixError::BadRange));
}

#[test]
fn lint_fix_preserves_analysis() {
    use canlang_compiler::lint::{LintConfig, collect_fixes, lint_program};
    let text = "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=m?.n\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    let config = LintConfig {
        fix: true,
        ..LintConfig::default()
    };
    let lint_fix = collect_fixes(snapshot.program(), &db, &config)
        .into_iter()
        .find(|f| f.rule == "redundant-null-marker")
        .expect("I1002 fix observed");
    let fix = fixes::from_lint_fix(&lint_fix);
    let applied = fixes::apply_fix(text, &fix).expect("applies");
    // The repaired text analyzes with the finding gone and nothing new:
    // the redundant marker was provably meaningless.
    let (db2, id2) = load(&applied);
    let after = Snapshot::analyze(&db2, id2, None);
    assert!(after.diagnostics().is_empty(), "{:?}", after.diagnostics());
    let lints = lint_program(after.program(), &db2, &LintConfig::default());
    let codes: Vec<&str> = lints.iter().map(|d| d.code).collect();
    assert_eq!(codes, ["I1001"], "only the unread `let` remains: {codes:?}");
}

// --- positions ---

#[test]
fn offset_at_position_cases() {
    let text = "ab\r\ncde\nf";
    assert_eq!(offset_at_position(text, 0, 0), Some(0));
    assert_eq!(offset_at_position(text, 0, 2), Some(2));
    // The CRLF `\r` is not an addressable column: character 2 (past the
    // two columns) still lands on the break.
    assert_eq!(offset_at_position(text, 0, 9), Some(2));
    assert_eq!(offset_at_position(text, 1, 0), Some(4));
    assert_eq!(offset_at_position(text, 2, 1), Some(9));
    assert_eq!(offset_at_position(text, 9, 0), None);
    // UTF-16 units: the emoji counts 2, and a mid-scalar character
    // clamps back to the scalar start.
    let wide = "a\u{1F600}b";
    assert_eq!(offset_at_position(wide, 0, 1), Some(1));
    assert_eq!(offset_at_position(wide, 0, 2), Some(1));
    assert_eq!(offset_at_position(wide, 0, 3), Some(5));
    assert_eq!(offset_at_position(wide, 0, 99), Some(6));
    // A bare CR, including at EOF, counts as an ordinary scalar.
    for character in [2, 99] {
        assert_eq!(offset_at_position("a\r", 0, character), Some(2));
        assert_eq!(offset_at_position("a\r\n", 0, character), Some(1));
    }
    assert_eq!(offset_at_position("a\rb", 0, 2), Some(2));
    assert_eq!(offset_at_position("a\rb", 0, 99), Some(3));
    assert_eq!(offset_at_position("a\n", 1, 0), Some(2));
    assert_eq!(offset_at_position("a\n", 1, 99), Some(2));
    assert_eq!(offset_at_position("a\n", 2, 0), None);
    assert_eq!(offset_at_position("", 0, 99), Some(0));
    assert_eq!(offset_at_position("", 1, 0), None);
}

#[test]
fn offset_at_position_roundtrips_addressable_scalar_boundaries() {
    for text in [
        "", "é😀x", "ab\r\nc", "a\rb", "a\r", "a\n", "a\r\n", "\r\r\n",
    ] {
        let index = canlang_compiler::source::LineIndex::new(text);
        for offset in 0..=text.len() {
            if !text.is_char_boundary(offset) {
                continue;
            }
            // The LF of CRLF shares the preceding CR's position.
            if offset > 0
                && text.as_bytes().get(offset - 1) == Some(&b'\r')
                && text.as_bytes().get(offset) == Some(&b'\n')
            {
                continue;
            }
            let (line, character) = index.to_lsp(text, offset as u32, true);
            assert_eq!(
                offset_at_position(text, line, character),
                Some(offset as u32),
                "{text:?} at byte {offset}"
            );
        }
    }
}

// --- server integration (real backend) ---

fn request(id: &str, method: &str, params: &str) -> t::Json {
    t::parse(&format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"{method}\",\"params\":{params}}}"
    ))
    .unwrap()
}

fn notify(method: &str, params: &str) -> t::Json {
    t::parse(&format!(
        "{{\"jsonrpc\":\"2.0\",\"method\":\"{method}\",\"params\":{params}}}"
    ))
    .unwrap()
}

fn real_server() -> Server<RealAnalysis> {
    let mut server = Server::new(RealAnalysis::new(None));
    let responses = server.handle_json(&request(
        "1",
        "initialize",
        r#"{"processId":null,"rootUri":null,"capabilities":{"workspace":{"workspaceEdit":{"documentChanges":true}}}}"#,
    ));
    assert_eq!(responses.len(), 1);
    assert!(responses[0].contains("capabilities"));
    server.handle_json(&notify("initialized", "{}"));
    server
}

fn open_doc(server: &mut Server<RealAnalysis>, uri: &str, version: i32, text: &str) {
    // JSON-escape the document text for the notification body.
    let mut escaped = String::from("{\"textDocument\":{\"uri\":\"");
    escaped.push_str(uri);
    escaped.push_str("\",\"languageId\":\"can\",\"version\":");
    escaped.push_str(&version.to_string());
    escaped.push_str(",\"text\":");
    canlang_compiler::diagnostic::push_json_str(&mut escaped, text);
    escaped.push_str("}}");
    server.handle_json(&notify("textDocument/didOpen", &escaped));
}

#[test]
fn server_publishes_analysis_and_lint() {
    let mut server = real_server();
    let text = "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=m.n+\"s\"\nThen\n";
    open_doc(&mut server, "file:///a.can", 1, text);
    let notes = server.pump();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(
        notes[0].contains("textDocument/publishDiagnostics"),
        "{}",
        notes[0]
    );
    assert!(notes[0].contains("\"version\":1"), "{}", notes[0]);
    // Analysis error observed in the probe (E3002 at 72..79).
    assert!(notes[0].contains("E3002"), "{}", notes[0]);
    assert!(
        notes[0].contains("cannot compute int + text"),
        "{}",
        notes[0]
    );
}

#[test]
fn server_stale_version_suppressed_with_real_backend() {
    let mut server = real_server();
    open_doc(&mut server, "file:///a.can", 1, "app A\n");
    let change = format!(
        "{{\"textDocument\":{{\"uri\":\"file:///a.can\",\"version\":2}},\"contentChanges\":[{{\"text\":{FIXTURE:?}}}]}}"
    );
    server.handle_json(&notify("textDocument/didChange", &change));
    // Replacing distinct source text prunes the obsolete version before remap.
    assert_eq!(server.pending_count(), 1);
    let notes = server.pump();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("\"version\":2"), "{}", notes[0]);
    assert!(!notes[0].contains("\"version\":1"), "{}", notes[0]);
}

#[test]
fn server_capability_negotiation() {
    // Every advertised provider below has a passing test proving it
    // works (one per provider in this file).
    let mut server = Server::new(RealAnalysis::new(None));
    let responses = server.handle_json(&request(
        "1",
        "initialize",
        r#"{"processId":null,"rootUri":null,"capabilities":{}}"#,
    ));
    assert_eq!(responses.len(), 1);
    let capabilities = &responses[0];
    for provider in [
        "\"hoverProvider\":true",
        "\"completionProvider\":{}",
        "\"definitionProvider\":true",
        "\"referencesProvider\":true",
        "\"renameProvider\":true",
        "\"codeActionProvider\":true",
        "\"semanticTokensProvider\"",
    ] {
        assert!(
            capabilities.contains(provider),
            "missing {provider}: {capabilities}"
        );
    }
    // The legend is the tokens module's single source of truth.
    for token in ["\"keyword\"", "\"comment\"", "\"string\"", "\"number\""] {
        assert!(
            capabilities.contains(token),
            "missing {token}: {capabilities}"
        );
    }
    for modifier in ["\"declaration\"", "\"defaultLibrary\""] {
        assert!(
            capabilities.contains(modifier),
            "missing {modifier}: {capabilities}"
        );
    }
}

#[test]
fn server_hover_definition_references_roundtrip() {
    let mut server = real_server();
    open_doc(&mut server, "file:///a.can", 1, FIXTURE);
    let _ = server.pump();
    // Hover on the `task` use (line 6, char 13).
    let hover = server.handle_json(&request(
        "2",
        "textDocument/hover",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":6,"character":13}}"#,
    ));
    assert!(hover[0].contains("Tasks.complete.task"), "{}", hover[0]);
    // Definition of the `Todo` type use (line 4, char 24) lands on the
    // declaration (line 2, chars 1..5).
    let definition = server.handle_json(&request(
        "3",
        "textDocument/definition",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":4,"character":24}}"#,
    ));
    assert!(definition[0].contains("file:///a.can"), "{}", definition[0]);
    assert!(definition[0].contains("\"line\":2"), "{}", definition[0]);
    assert!(
        definition[0].contains("\"character\":1"),
        "{}",
        definition[0]
    );
    assert!(
        definition[0].contains("\"character\":5"),
        "{}",
        definition[0]
    );
    // References of the `label` use (line 7, char 19): decl + use.
    let references = server.handle_json(&request(
        "4",
        "textDocument/references",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":7,"character":19},"context":{"includeDeclaration":true}}"#,
    ));
    assert_eq!(
        references[0].matches("file:///a.can").count(),
        2,
        "{}",
        references[0]
    );
}

#[test]
fn server_rename_and_invalid_name() {
    let mut server = real_server();
    open_doc(&mut server, "file:///a.can", 1, FIXTURE);
    let _ = server.pump();
    let rename = server.handle_json(&request(
        "2",
        "textDocument/rename",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":6,"character":13},"newName":"job"}"#,
    ));
    // Declaration, read and set-target edits are all retitled to `job`.
    assert_eq!(
        rename[0].matches("\"newText\":\"job\"").count(),
        3,
        "{}",
        rename[0]
    );
    // An invalid identifier is refused with empty edits, never an error.
    let refused = server.handle_json(&request(
        "3",
        "textDocument/rename",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":6,"character":13},"newName":"9bad"}"#,
    ));
    assert!(refused[0].contains("\"edits\":[]"), "{}", refused[0]);
}

#[test]
fn server_completion_and_semantic_tokens() {
    let mut server = real_server();
    open_doc(&mut server, "file:///a.can", 1, FIXTURE);
    let _ = server.pump();
    let completion = server.handle_json(&request(
        "2",
        "textDocument/completion",
        r#"{"textDocument":{"uri":"file:///a.can"},"position":{"line":6,"character":15}}"#,
    ));
    assert!(
        completion[0].contains("\"label\":\"task\""),
        "{}",
        completion[0]
    );
    assert!(
        completion[0].contains("\"label\":\"and\""),
        "{}",
        completion[0]
    );
    let tokens = server.handle_json(&request(
        "3",
        "textDocument/semanticTokens/full",
        r#"{"textDocument":{"uri":"file:///a.can"}}"#,
    ));
    assert!(tokens[0].contains("\"data\":["), "{}", tokens[0]);
    assert!(!tokens[0].contains("\"data\":[]"), "{}", tokens[0]);
}

#[test]
fn server_code_action_fix_application() {
    let mut server = real_server();
    let text = "app T\nGiven\n M { n:int }\nWhen\n scenario s(m:M) by=members\n  do\n   let x=m?.n\nThen\n";
    open_doc(&mut server, "file:///a.can", 7, text);
    let _ = server.pump();
    // The `?.` spans line 6, chars 11..13 (bytes 73..75).
    let actions = server.handle_json(&request(
        "2",
        "textDocument/codeAction",
        r#"{"textDocument":{"uri":"file:///a.can"},"range":{"start":{"line":6,"character":11},"end":{"line":6,"character":13}},"context":{"diagnostics":[]}}"#,
    ));
    assert!(actions[0].contains("redundant"), "{}", actions[0]);
    assert!(actions[0].contains("\"newText\":\".\""), "{}", actions[0]);
    assert!(actions[0].contains("documentChanges"), "{}", actions[0]);
    // A range with no fixable finding yields no actions, never an error.
    let none = server.handle_json(&request(
        "3",
        "textDocument/codeAction",
        r#"{"textDocument":{"uri":"file:///a.can"},"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":3}},"context":{"diagnostics":[]}}"#,
    ));
    assert!(none[0].contains("\"result\":[]"), "{}", none[0]);
    // The contract gate: the same fix refused against stale bytes.
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    let config = canlang_compiler::lint::LintConfig {
        fix: true,
        ..canlang_compiler::lint::LintConfig::default()
    };
    let lint_fix = canlang_compiler::lint::collect_fixes(snapshot.program(), &db, &config)
        .into_iter()
        .find(|f| f.rule == "redundant-null-marker")
        .expect("I1002 fix observed");
    let fix = fixes::from_lint_fix(&lint_fix);
    assert_eq!(
        fixes::apply_fix("app T\nGiven\nWhen\nThen\n", &fix),
        Err(fixes::FixError::StaleContent)
    );
}

#[test]
fn import_member_resolves_to_export() {
    let text = "package P\n Given\n  export Thing { n:int }\n When\n Then\napp A\nuse P {Thing}\nGiven\nWhen\nThen\n";
    let (db, id) = load(text);
    let snapshot = Snapshot::analyze(&db, id, None);
    assert!(
        snapshot.diagnostics().is_empty(),
        "{:?}",
        snapshot.diagnostics()
    );
    // `Thing` in the import member (67..72) resolves to the export (26..31).
    let hover = snapshot.hover_at(68).expect("hover on import member");
    assert_eq!(hover.markdown, "**P.Thing** — model");
    assert_eq!((hover.span.start, hover.span.end), (67, 72));
    assert_eq!(spans_of(&snapshot.definition_at(68)), [(26, 31)]);
}
