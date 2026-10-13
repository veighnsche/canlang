//! BGI-09 row-bound renderers + BGI-10 scoped CSS and DOM hooks.
use canlang_compiler::analysis::generation::{GenerationKind, discover_generation};
use canlang_compiler::codegen::then_views::{
    MOUNT_SIGNATURE, RENDER_SIGNATURE, ROW_EVALUATED_ONCE, THEN_VIEW_CONTRACT_VERSION, ThenControl,
    collect_then_prompts, lower_then_views, style_use_contracts, view_instance_id,
    walk_generation_uses,
};
use canlang_compiler::css_scope::{
    CSS_SCOPE_VERSION, SHARED_THEME_VARS, compatible_style_host, scope_stylesheet,
    style_host_attributes, style_use_attributes,
};
use canlang_compiler::source::SourceId;
use canlang_compiler::syntax::parse_source;

const FIXTURE: &str = r#"app Tasks
Given
 trait completable $"Add done:bool=false."
 Todo {title:text trim min=1 max=200} completable
 keyword canonical_identity(target:model, field:field(target,text)) $"Use NFKC keys."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
When
 scenario complete(task:Todo) by=members
  do set task {title="Done"}
Then
 style TaskSurface $"Readable task surfaces."
 view TaskTile(row:Todo) $"Arrange admitted title/status and declared controls."
  edit fields=title
  delete
  style TaskSurface
 page / title="Todos" $"A calm workspace."
  card "Add a task" $"A compact entry area."
   form Todo.create fields=title
    input title $TaskSurface
  list Todo as task $TaskSurface
   show TaskTile {row=row} $TaskSurface
"#;

fn parse(text: &str) -> canlang_compiler::syntax::SyntaxNode {
    let (tree, diags) = parse_source(SourceId(0), text);
    assert!(diags.is_empty(), "{diags:?}");
    tree
}

fn wrap(then: &str) -> String {
    format!(
        "app Tasks\nGiven\n Todo {{title:text}}\nWhen\n scenario x(t:Todo) by=members\n  do set t {{title=\"a\"}}\nThen\n{then}"
    )
}

// ## BGI-09: prompted views lower to checked renderer contracts.

#[test]
fn prompted_view_lowers_row_controls_and_root_style() {
    let tree = parse(FIXTURE);
    let lowering = lower_then_views(&tree, FIXTURE);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    assert_eq!(lowering.views.len(), 1);
    let view = &lowering.views[0];
    assert_eq!(view.name, "TaskTile");
    assert_eq!(view.row_model, "Todo");
    assert_eq!(view.controls.len(), 2);
    assert_eq!(
        view.controls[0],
        ThenControl::Edit {
            fields: vec!["title".to_string()]
        }
    );
    assert_eq!(view.controls[1], ThenControl::Delete);
    let root = view.root_style.as_ref().expect("root style child");
    assert_eq!(root.named.as_deref(), Some("TaskSurface"));
    assert_eq!(THEN_VIEW_CONTRACT_VERSION, "canlang.then-view/1");
}

#[test]
fn form_and_action_controls_carry_operations() {
    let text = wrap(
        " view Tile(row:Todo) $\"Arrange.\"\n  form Todo.create fields=title\n  action Todo.create\n",
    );
    let tree = parse(&text);
    let lowering = lower_then_views(&tree, &text);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    assert_eq!(
        lowering.views[0].controls,
        vec![
            ThenControl::Form {
                operation: "Todo.create".to_string(),
                fields: vec!["title".to_string()]
            },
            ThenControl::Action {
                operation: "Todo.create".to_string()
            },
        ]
    );
}

#[test]
fn declared_fields_feed_admission_refusal() {
    // The descriptor exposes declared fields; Interfaces admission refuses
    // unpermitted ones and the renderer never sees them (TS-side cases).
    let tree = parse(FIXTURE);
    let lowering = lower_then_views(&tree, FIXTURE);
    let fields: Vec<String> = lowering.views[0]
        .controls
        .iter()
        .flat_map(|c| c.declared_fields())
        .collect();
    assert_eq!(fields, vec!["title".to_string()]);
}

#[test]
fn row_argument_contract_is_once_only_with_separate_instance_identity() {
    assert!(ROW_EVALUATED_ONCE);
    assert_eq!(RENDER_SIGNATURE, "render({row, bindings, ui})");
    assert_eq!(MOUNT_SIGNATURE, "mount(root, presentation) => cleanup");
    // Repeated instances share the renderer but never an identity.
    let tree = parse(FIXTURE);
    let (parsed, _) = parse_source(SourceId(0), FIXTURE);
    let _ = &tree;
    let found = discover_generation(&parsed, FIXTURE);
    let edges = walk_generation_uses(&parsed, FIXTURE, &found.descriptors);
    let view_uses: Vec<_> = edges
        .iter()
        .filter(|e| e.definition_kind == GenerationKind::ViewDefinition)
        .collect();
    assert_eq!(view_uses.len(), 1);
    let first = view_instance_id(0, view_uses[0].use_span);
    let second = view_instance_id(0, canlang_compiler::source::Span::new(SourceId(0), 1, 2));
    assert!(first.starts_with("can-view-m0-f0-s"));
    assert_ne!(first, second);
}

#[test]
fn unknown_row_model_diagnoses() {
    let text = wrap(" view Tile(row:Missing) $\"Arrange.\"\n  delete\n");
    let (tree, diags) = parse_source(SourceId(0), &text);
    assert!(diags.is_empty(), "{diags:?}");
    let lowering = lower_then_views(&tree, &text);
    assert!(lowering.views.is_empty());
    assert_eq!(lowering.diagnostics.len(), 1);
    assert!(lowering.diagnostics[0].message.contains("unknown model"));
}

#[test]
fn unprompted_views_are_not_renderer_units() {
    let text = wrap(" view Plain(row:Todo)\n  delete\n");
    let tree = parse(&text);
    let lowering = lower_then_views(&tree, &text);
    assert!(lowering.views.is_empty());
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
}

#[test]
fn use_walk_exposes_every_checked_use_without_an_index() {
    let tree = parse(FIXTURE);
    let found = discover_generation(&tree, FIXTURE);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let edges = walk_generation_uses(&tree, FIXTURE, &found.descriptors);
    // Trait app, keyword app, three named style uses (input, list, show),
    // the view root style use, and the show use of the prompted view.
    assert_eq!(edges.len(), 7);
    let style_uses: Vec<_> = edges
        .iter()
        .filter(|e| e.definition_kind == GenerationKind::StyleDefinition)
        .collect();
    assert_eq!(style_uses.len(), 4);
    assert!(
        style_uses
            .iter()
            .all(|e| e.definition_label == "TaskSurface")
    );
    let kinds: Vec<_> = edges.iter().map(|e| e.definition_kind).collect();
    assert!(kinds.contains(&GenerationKind::NamedTrait));
    assert!(kinds.contains(&GenerationKind::KeywordDefinition));
    assert!(kinds.contains(&GenerationKind::ViewDefinition));
}

// ## BGI-10: scoped CSS parsing and ownership.

#[test]
fn guards_cover_every_compound() {
    let scoped = scope_stylesheet("u7", ".a .b:hover, #x { margin: 0; }").expect("scope");
    assert_eq!(scoped.css.matches("data-can-style").count(), 6);
    assert!(scoped.css.contains(".a:where("));
    assert!(scoped.css.contains(".b:hover:where("));
    assert!(scoped.css.contains("#x:where("));
    assert_eq!(CSS_SCOPE_VERSION, "canlang.css-scope/1");
}

#[test]
fn nesting_conditions_and_host_rules_scope() {
    let css = "@media (min-width: 40rem) { .a { color: red; &:hover { color: blue; } .b { margin: 0; } } }";
    let scoped = scope_stylesheet("u7", css).expect("scope");
    assert!(scoped.css.contains("@media (min-width: 40rem)"));
    assert!(scoped.css.contains("&:hover:where("));
    assert!(scoped.css.contains(".b:where("));
    let host = scope_stylesheet(
        "u7",
        ":host { display: block; } :host(.wide) { width: 100%; }",
    )
    .expect("host");
    assert!(host.css.contains("[data-can-style-root^=\"u7:\"]"));
    assert!(!host.css.contains(":host"));
}

#[test]
fn functional_pseudo_selectors_scope_recursively() {
    let scoped = scope_stylesheet(
        "u7",
        ".a:not(.b, #c) { color: red; } li:nth-child(2n of .d) { color: red; }",
    )
    .expect("scope");
    assert!(scoped.css.contains(":not(.b:where("));
    assert!(scoped.css.contains("#c:where("));
    assert!(scoped.css.contains("of .d:where("));
    let supports =
        scope_stylesheet("u7", "@supports selector(.a) { .b { color: red; } }").expect("supports");
    assert!(supports.css.contains("selector(.a:where("));
}

#[test]
fn local_keyframes_and_properties_namespace() {
    let css = "@keyframes spin { from { transform: rotate(0); } to { transform: rotate(1turn); } } \
         .a { animation: spin 1s linear; --x: 1px; width: var(--x); }";
    let scoped = scope_stylesheet("u7", css).expect("scope");
    assert!(scoped.css.contains("@keyframes uu7-spin"));
    assert!(scoped.css.contains("animation: uu7-spin 1s linear"));
    assert!(scoped.css.contains("--uu7-x: 1px"));
    assert!(scoped.css.contains("var(--uu7-x)"));
    assert_eq!(scoped.keyframes, vec!["uu7-spin".to_string()]);
    assert_eq!(scoped.properties, vec!["--uu7-x".to_string()]);
}

#[test]
fn theme_reads_pass_but_redefinition_refuses() {
    let scoped = scope_stylesheet("u7", ".a { color: var(--color-base-100); }").expect("scope");
    assert!(scoped.css.contains("var(--color-base-100)"));
    assert_eq!(scoped.theme_reads, vec!["--color-base-100".to_string()]);
    let errors = scope_stylesheet("u7", ".a { --color-primary: red; }").expect_err("redefine");
    assert_eq!(errors[0].code, "E2105");
}

#[test]
fn global_relational_and_at_rule_escapes_refuse() {
    for (css, code) in [
        ("body { margin: 0; }", "E2103"),
        ("* { margin: 0; }", "E2103"),
        (":root { --x: 1; }", "E2103"),
        ("html body { margin: 0; }", "E2103"),
        (".a:has(.b) { color: red; }", "E2102"),
        ("svg|a { color: red; }", "E2102"),
        ("@import \"x.css\";", "E2106"),
        ("@font-face { font-family: x; }", "E2106"),
        ("@layer a { .b { color: red; } }", "E2106"),
        ("[data-can-style] { color: red; }", "E2104"),
    ] {
        let errors = scope_stylesheet("u7", css).expect_err(css);
        assert_eq!(errors[0].code, code, "{css}");
    }
}

#[test]
fn owned_urls_admit_remote_and_traversal_refuse() {
    let scoped = scope_stylesheet("u7", ".a { background: url(assets/bg.png); }").expect("scope");
    assert_eq!(scoped.assets, vec!["assets/bg.png".to_string()]);
    scope_stylesheet("u7", ".a { background: url(data:image/png;base64,AA==); }").expect("data");
    for css in [
        ".a { background: url(https://x/y.png); }",
        ".a { background: url(/abs/y.png); }",
        ".a { background: url(../x.png); }",
    ] {
        let errors = scope_stylesheet("u7", css).expect_err(css);
        assert_eq!(errors[0].code, "E2107", "{css}");
    }
}

#[test]
fn scoping_is_deterministic() {
    let css = "@media (min-width: 1px) { .a, .b .c { color: var(--x, red); } }";
    let first = scope_stylesheet("u7", css).expect("scope");
    let second = scope_stylesheet("u7", css).expect("scope");
    assert_eq!(first.css, second.css);
    assert_eq!(first, second);
}

#[test]
fn invalid_unit_ids_refuse() {
    for id in ["", "U7", "u 7", "../x", "u7;"] {
        let errors = scope_stylesheet(id, ".a { color: red; }").expect_err(id);
        assert_eq!(errors[0].code, "E2101", "{id}");
    }
}

#[test]
fn hook_attributes_carry_ownership_and_use_identity() {
    assert_eq!(
        style_use_attributes("u7", "s12"),
        "data-can-style=\"u7\" data-can-style-root=\"u7:s12\""
    );
    assert_eq!(
        style_host_attributes("u8", "u7"),
        "data-can-style=\"u8\" data-can-style-host=\"u7\""
    );
    for host in [
        "Page",
        "Card",
        "Show",
        "Form:Todo.create",
        "CatalogItem",
        "UiLeaf",
    ] {
        assert!(compatible_style_host(host), "{host}");
    }
    assert!(!compatible_style_host("Given"));
    assert!(!compatible_style_host(""));
}

// ## Shared Then closure: named-twice fixture, retry, pipeline feed.

#[test]
fn named_twice_plus_inline_sibling_contracts() {
    let text = wrap(
        " style CardSurface $\"Readable cards.\"\n page / title=\"T\"\n  text \"A\" $CardSurface\n  text \"B\" $CardSurface\n  text \"C\" $\"One-off entry.\"\n",
    );
    let tree = parse(&text);
    let found = discover_generation(&tree, &text);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let (contracts, diagnostics) = style_use_contracts(&found.descriptors);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    // The two `$CardSurface` attachments share the one definition unit;
    // the inline sibling owns its own unit.
    let named: Vec<_> = contracts
        .iter()
        .filter(|c| !c.style_name.is_empty())
        .collect();
    let inline: Vec<_> = contracts
        .iter()
        .filter(|c| c.style_name.is_empty())
        .collect();
    assert_eq!(named.len(), 2);
    assert_eq!(inline.len(), 1);
    assert!(named.iter().all(|c| c.compatible));
    assert_eq!(named[0].unit_anchor, named[1].unit_anchor);
    assert_ne!(named[0].use_span, named[1].use_span);
    // Full-app retry regenerates both prompts: the named definition once
    // plus the inline sibling.
    let prompts = collect_then_prompts(&found.descriptors);
    assert_eq!(prompts.len(), 2);
    let kinds: Vec<_> = prompts.iter().map(|p| p.kind).collect();
    assert!(kinds.contains(&GenerationKind::StyleDefinition));
    assert!(kinds.contains(&GenerationKind::StyleInline));
}

#[test]
fn full_retry_regenerates_every_then_prompt_once() {
    let tree = parse(FIXTURE);
    let found = discover_generation(&tree, FIXTURE);
    let prompts = collect_then_prompts(&found.descriptors);
    // Named style once, two inline styles, the view renderer: repeated uses
    // add no new prompts.
    assert_eq!(prompts.len(), 4);
    let named: Vec<_> = prompts
        .iter()
        .filter(|p| p.kind == GenerationKind::StyleDefinition)
        .collect();
    assert_eq!(named.len(), 1);
    assert_eq!(named[0].label, "TaskSurface");
    assert!(prompts.iter().all(|p| !p.prompt.is_empty()));
    assert!(
        prompts
            .windows(2)
            .all(|pair| pair[0].anchor <= pair[1].anchor)
    );
}

#[test]
fn theme_allowlist_matches_the_shipped_theme_file() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let themes = std::fs::read_to_string(root.join("packages/ui/themes.css")).expect("themes.css");
    let mut vars = std::collections::BTreeSet::new();
    let bytes = themes.as_bytes();
    let mut index = 0;
    while let Some(found) = themes[index..].find("--") {
        let start = index + found + 2;
        let mut end = start;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-' || bytes[end] == b'_')
        {
            end += 1;
        }
        if end > start {
            vars.insert(themes[index + found..end].to_string());
        }
        index = end.max(start);
    }
    assert!(!vars.is_empty());
    for var in &vars {
        assert!(
            SHARED_THEME_VARS.contains(&var.as_str()),
            "theme variable {var} is not in the shared scope allowlist"
        );
    }
}
