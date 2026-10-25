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
 view TaskTile(row:Todo) $"Arrange admitted title/status and declared controls." $TaskSurface
  edit fields=title
  delete
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
    let root = view.root_style.as_ref().expect("root style suffix");
    assert_eq!(root.named.as_deref(), Some("TaskSurface"));
    assert_eq!(THEN_VIEW_CONTRACT_VERSION, "canlang.then-view/1");
}

#[test]
fn action_primitives_have_opaque_bindings_and_canonical_metadata() {
    let text = wrap(
        " view Tile(row:Todo) $\"Arrange actions first.\"\n  card row.title\n   require row.title != \"\"\n   primary \"Approve\" action=x arguments={t=row}\n   secondary \"Review\" action=x arguments={t=row}\n   secondary \"Inspect\" target=\"/inspect\"\n",
    );
    let tree = parse(&text);
    let lowering = lower_then_views(&tree, &text);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    let view = &lowering.views[0];
    assert_eq!(
        view.binding_names
            .iter()
            .map(|(_, name)| name.as_str())
            .collect::<Vec<_>>(),
        ["card"]
    );
    assert!(view.gates.is_empty(), "card guard stays local");
    assert_eq!(
        view.controls,
        [
            ThenControl::Primary,
            ThenControl::Form {
                operation: "x".into(),
                fields: vec![]
            },
            ThenControl::Secondary,
            ThenControl::Form {
                operation: "x".into(),
                fields: vec![]
            },
            ThenControl::Secondary
        ]
    );
}

#[test]
fn buttons_keep_source_bindings_and_nested_action_metadata() {
    let text = wrap(
        " view Tile(row:Todo) $\"Arrange checked bindings.\"\n  require row.title != \"\"\n  text row.title\n  content row.title\n  history\n  button action=x\n  button target=\"/archive\" caption=\"Archive\"\n  card row.title\n   require row.title != \"Hidden\"\n   card \"Details\"\n    button action=x arguments={t=row}\n    text row.title\n",
    );
    let tree = parse(&text);
    let lowering = lower_then_views(&tree, &text);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    let view = &lowering.views[0];
    assert_eq!(
        view.binding_names
            .iter()
            .map(|(_, name)| name.as_str())
            .collect::<Vec<_>>(),
        ["text", "content", "history", "button", "button", "card"],
        "nested descendants remain inside the one opaque card binding"
    );
    assert_eq!(
        view.controls,
        [
            ThenControl::Action {
                operation: "x".into()
            },
            ThenControl::Action {
                operation: "x".into()
            }
        ],
        "direct and nested action buttons each contribute once; navigation grants no operation"
    );
    assert_eq!(view.gates, ["row.title != \"\""], "card gate stays local");
    assert_eq!(view.leaves, ["text", "content", "history", "card"]);
}

#[test]
fn action_primitives_refuse_missing_bindings_old_suites_and_design_overrides() {
    for source in [
        "secondary\n delete",
        "primary action=x",
        "primary \"Approve\"",
        "secondary \"Delete\" action=x target=\"/\"",
        "primary\n form Todo.create",
        "secondary \"Delete\" action=x\n delete",
        "primary \"Approve\" action=x tone=primary",
        "primary \"Approve\" action=x $\"Red.\"",
    ] {
        let text = wrap(&format!(
            " page / title=\"Tasks\"\n  {}\n",
            source.replace('\n', "\n  ")
        ));
        let (_, diagnostics) = parse_source(SourceId(0), &text);
        assert!(!diagnostics.is_empty(), "accepted {source}");
    }
}

#[test]
fn action_primitives_admit_only_declared_owner_regions() {
    for suite in [
        "  primary \"Browse\" target=\"/\"\n",
        "  card \"Task\"\n   primary \"Browse\" target=\"/\"\n",
        "  list Todo\n   secondary \"Browse\" target=\"/\"\n",
        "  table Todo columns=title\n   primary \"Browse\" target=\"/\"\n",
        "  board Todo by=title\n   primary \"Browse\" target=\"/\"\n",
        "  modal \"Panel\" id=panel\n   slot content\n    text \"Body\"\n   slot actions\n    primary \"Browse\" target=\"/\"\n    secondary \"More\" target=\"/more\"\n",
        "  drawer \"Panel\" id=panel\n   slot content\n    text \"Body\"\n   slot actions\n    primary \"Browse\" target=\"/\"\n",
        "  list Todo\n   details \"Task\" display=drawer\n    secondary \"Browse\" target=\"/\"\n",
        "  form x\n   primary \"Submit\" submit=true\n",
        "  list Todo\n   edit fields=title\n    primary \"Submit\" submit=true\n",
    ] {
        let text = wrap(&format!(" page / title=\"Tasks\"\n{suite}"));
        let mut db = canlang_compiler::source::SourceDb::new();
        let id = db.add("owners.can".into(), text);
        let (_, diagnostics) = canlang_compiler::analysis::check_program(&db, &[id], None);
        assert!(
            !diagnostics
                .iter()
                .any(|d| d.message.contains("action owner") || d.message.contains("action region")),
            "{suite}: {diagnostics:?}"
        );
    }
    for suite in [
        "  tooltip \"Hint\"\n   primary \"Browse\" target=\"/\"\n",
        "  details \"Task\"\n   primary \"Browse\" target=\"/\"\n",
        "  collapse \"Task\"\n   primary \"Browse\" target=\"/\"\n",
        "  gallery Todo image=title\n   primary \"Browse\" target=\"/\"\n",
        "  calendar Todo start=title end=title\n   primary \"Browse\" target=\"/\"\n",
        "  form x\n   fieldset \"Inputs\"\n    primary \"Submit\" submit=true\n",
        "  form x\n   card \"Nested\"\n    primary \"Call\" action=x\n",
        "  form x\n   secondary \"Submit\" submit=true\n",
        "  modal \"Panel\" id=panel\n   slot content\n    primary \"Browse\" target=\"/\"\n",
    ] {
        let text = wrap(&format!(" page / title=\"Tasks\"\n{suite}"));
        let mut db = canlang_compiler::source::SourceDb::new();
        let id = db.add("wrong-owners.can".into(), text);
        let (_, diagnostics) = canlang_compiler::analysis::check_program(&db, &[id], None);
        assert!(
            diagnostics.iter().any(|d| d.code == "E3001"
                && (d.message.contains("action owner") || d.message.contains("action region"))),
            "{suite}: {diagnostics:?}"
        );
    }
    let text =
        wrap(" view Tile(row:Todo) $\"Arrange.\"\n  primary \"Call\" action=x arguments={t=row}\n");
    let tree = parse(&text);
    assert!(
        lower_then_views(&tree, &text)
            .diagnostics
            .iter()
            .any(|d| d.message.contains("owning card"))
    );
    let mut db = canlang_compiler::source::SourceDb::new();
    let id = db.add("unowned-view.can".into(), text);
    let (_, diagnostics) = canlang_compiler::analysis::check_program(&db, &[id], None);
    assert!(
        diagnostics
            .iter()
            .any(|d| d.code == "E3001" && d.message.contains("action owner")),
        "{diagnostics:?}"
    );
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
    const { assert!(ROW_EVALUATED_ONCE) };
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
    assert!(host.css.contains("[data-can-style-root*=\" u7:\"]"));
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

// ## Production join: ordinary compilation emits saved-renderer calls,
// ownership hooks, saved imports, and packed scoped CSS.

use canlang_compiler::cli::dispatch as then_dispatch;
use canlang_compiler::source::sha256_hex as then_sha256;

fn then_argv(parts: &[&str]) -> Vec<String> {
    let mut args = vec!["can".to_string()];
    args.extend(parts.iter().map(|part| part.to_string()));
    args
}

fn then_write(dir: &std::path::Path, name: &str, text: &str) -> String {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().to_string()
}

fn then_bind(root: &str, file: &str, text: &str, kind: GenerationKind, label: &str) -> String {
    let revision = then_sha256(text.as_bytes());
    let (tree, _) = parse_source(SourceId(0), text);
    let found = discover_generation(&tree, text);
    let descriptor = found
        .descriptors
        .iter()
        .find(|d| d.kind == kind && d.label.as_deref() == Some(label))
        .unwrap_or_else(|| panic!("no {kind:?} descriptor for {label:?}"));
    let bound = then_dispatch(&then_argv(&[
        "gen",
        "bind",
        root,
        file,
        &descriptor.span.start.to_string(),
        &descriptor.span.end.to_string(),
        &revision,
        "new",
    ]));
    assert_eq!(bound.code, 0, "stderr: {}", bound.stderr);
    bound.stdout.split_whitespace().nth(1).unwrap().to_string()
}

/// Release probe: a prompted row view plus a named style, each used.
const THEN_JOIN_APP: &str = "app Tasks\nGiven\n Todo {title:text}\nWhen\nThen\n style TaskSurface $\"Readable task surfaces.\"\n view TaskTile(row:Todo) $\"Arrange admitted title.\" $TaskSurface\n  text row.title\n page / title=\"Todos\"\n  list Todo as row $TaskSurface\n   show TaskTile {row=row} $TaskSurface\n";
const THEN_JOIN_CSS: &str = "section { padding: 1rem; }\nsection h2 { font-weight: 600; }\n";
const THEN_JOIN_VIEW_JS: &str = "export function render(row, bindings, context) {\n  return `<section><h2>${bindings.text}</h2></section>`;\n}\nexport function mount(root, context) {}\n";
const THEN_JOIN_CATALOG: &str =
    r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[]}"#;

fn then_compile(dir: &std::path::Path, file: &str) -> canlang_compiler::cli::DispatchResult {
    let catalog = then_write(dir, "catalog.json", THEN_JOIN_CATALOG);
    then_dispatch(&then_argv(&[
        "compile",
        "--format=json",
        &format!("--catalog={catalog}"),
        file,
    ]))
}

fn then_envelope(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).unwrap()
}

#[test]
fn compile_emits_saved_renderer_call_hooks_import_and_css() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = then_write(dir.path(), "app.can", THEN_JOIN_APP);
    let u_style = then_bind(
        &root,
        &file,
        THEN_JOIN_APP,
        GenerationKind::StyleDefinition,
        "TaskSurface",
    );
    then_write(
        dir.path(),
        &format!("can.generated/{u_style}/style.css"),
        THEN_JOIN_CSS,
    );
    let u_view = then_bind(
        &root,
        &file,
        THEN_JOIN_APP,
        GenerationKind::ViewDefinition,
        "TaskTile",
    );
    then_write(
        dir.path(),
        &format!("can.generated/{u_view}/implementation.js"),
        THEN_JOIN_VIEW_JS,
    );
    then_write(
        dir.path(),
        &format!("can.generated/{u_view}/style.css"),
        ":host { border: 1px solid green; }\n",
    );
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 0, "stdout: {}", compiled.stdout);
    let body = then_envelope(&compiled.stdout);
    let modules = body["modules"].as_array().unwrap();
    let entry = &modules[0];
    let js = entry["js"].as_str().unwrap();
    // The saved import and the UI factory arrive with the entry.
    assert!(
        js.contains(&format!("from \"./can.generated/{u_view}/view.js\"")),
        "saved renderer import"
    );
    assert!(js.contains("generatedViewInstance"), "UI factory import");
    // The child expansion calls the saved renderer with ownership
    // hooks: descriptor, instance use id, root style, row, bindings.
    assert!(
        js.contains("version:\"canlang.presentation.generated-view/1\""),
        "wire version"
    );
    assert!(js.contains("view:\"TaskTile\""), "view name");
    assert!(
        js.contains(&format!("rendererStyle:\"{u_view}\"")),
        "renderer CSS ownership"
    );
    assert!(
        js.contains("rowModel:\"Tasks.Todo\""),
        "canonical row model"
    );
    assert!(
        js.contains(&format!("rootStyle:\"{u_style}\"")),
        "root style hook"
    );
    assert!(js.contains("useId:\"can-view-m0-f0-s"), "instance hook");
    assert!(
        js.contains("{name:\"text\",html:"),
        "pre-rendered leaf binding"
    );
    assert!(js.contains("render:$can$v$"), "renderer reference");
    // The staged server+browser view module packs after the entry.
    let paths: Vec<&str> = modules
        .iter()
        .map(|m| m["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths.len(), 2);
    assert_eq!(paths[1], format!("can.generated/{u_view}/view.js"));
    assert_eq!(modules[1]["js"], THEN_JOIN_VIEW_JS);
    assert_eq!(
        body["generatedViews"],
        serde_json::json!([{
            "view": "TaskTile",
            "module": format!("can.generated/{u_view}/view.js"),
            "renderExport": "render",
            "mountExport": "mount",
        }])
    );
    // The scoped CSS packs with its owner link for the deploy host.
    let sheets = body["stylesheets"].as_array().unwrap();
    assert_eq!(sheets.len(), 2);
    let sheet = sheets
        .iter()
        .find(|sheet| sheet["owner"]["unitId"] == u_style)
        .expect("named style output");
    assert_eq!(sheet["path"], format!("can.generated/{u_style}/style.css"));
    let css = sheet["css"].as_str().unwrap();
    assert!(
        css.contains(&format!("[data-can-style~=\"{u_style}\"]")),
        "{css}"
    );
    assert_eq!(sheet["owner"]["unitId"], u_style);
    assert_eq!(sheet["owner"]["kind"], "style");
    // Repeat saved builds are byte-identical with zero AI.
    assert!(!dir.path().join("can.gen.toml").exists());
    let again = then_compile(dir.path(), &file);
    assert_eq!(again.code, 0, "stdout: {}", again.stdout);
    assert_eq!(again.stdout, compiled.stdout);
    // A renderer without the optional mount carries no browser registration.
    then_write(
        dir.path(),
        &format!("can.generated/{u_view}/implementation.js"),
        &THEN_JOIN_VIEW_JS.replace("export function mount(root, context) {}\n", ""),
    );
    let inert = then_compile(dir.path(), &file);
    assert_eq!(inert.code, 0, "stdout: {}", inert.stdout);
    let inert = then_envelope(&inert.stdout);
    assert!(inert["generatedViews"][0].get("mountExport").is_none());
}

#[test]
fn compile_without_then_units_diagnoses_units_and_actions() {
    let dir = tempfile::tempdir().unwrap();
    let file = then_write(dir.path(), "app.can", THEN_JOIN_APP);
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 10, "stdout: {}", compiled.stdout);
    let body = then_envelope(&compiled.stdout);
    let diags = body["diagnostics"].as_array().unwrap();
    assert_eq!(diags.len(), 2);
    for diag in diags {
        assert_eq!(diag["code"], "E6008");
        let message = diag["message"].as_str().unwrap();
        assert!(message.contains("no saved unit"), "{message}");
        assert!(message.contains("action: generate"), "{message}");
    }
    let joined: Vec<&str> = diags
        .iter()
        .map(|d| d["message"].as_str().unwrap())
        .collect();
    assert!(
        joined.iter().any(|m| m.contains("view `TaskTile`")),
        "{joined:?}"
    );
    assert!(
        joined.iter().any(|m| m.contains("style `TaskSurface`")),
        "{joined:?}"
    );
}

#[test]
fn compile_saved_view_keeps_button_names_after_protected_form_lowering() {
    let source = wrap(
        " view Tile(row:Todo) $\"Arrange checked bindings.\"\n  require row.title != \"\"\n  button action=x\n  button target=\"/archive\" caption=\"Archive\"\n  card row.title\n   require row.title != \"Hidden\"\n   button action=x arguments={t=row}\n   text row.title\n page / title=\"Tasks\"\n  list Todo\n   show Tile {row=row}\n",
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = then_write(dir.path(), "app.can", &source);
    let unit = then_bind(
        &root,
        &file,
        &source,
        GenerationKind::ViewDefinition,
        "Tile",
    );
    then_write(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function render({bindings}) { return bindings.button + bindings.button2 + bindings.card; }\n",
    );
    let catalog = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages/values/dist/catalog.json");
    let compiled = then_dispatch(&then_argv(&[
        "compile",
        "--format=json",
        &format!("--catalog={}", catalog.display()),
        &file,
    ]));
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = then_envelope(&compiled.stdout);
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    let action_button = js
        .find("{name:\"button\",html:")
        .expect("source button binding");
    let navigation_button = js
        .find("{name:\"button2\",html:")
        .expect("second source button binding");
    let card = js
        .find("{name:\"card\",html:")
        .expect("opaque card binding");
    assert!(action_button < navigation_button && navigation_button < card);
    assert!(
        !js.contains("{name:\"form\",html:"),
        "protected lowering must retain button identity"
    );
    assert!(
        !js.contains("{name:\"button3\",html:"),
        "card descendants are not separate bindings"
    );
    assert!(
        js.contains("prepareForm"),
        "action buttons retain canonical preparation"
    );
}

#[test]
fn inline_root_style_suffix_lowers_without_replacing_renderer_prompt() {
    let source = wrap(
        " view Tile(row:Todo) $\"Arrange admitted title.\" $\"Readable root.\"\n  edit fields=title\n",
    );
    let tree = parse(&source);
    let lowering = lower_then_views(&tree, &source);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    let view = &lowering.views[0];
    assert_eq!(view.prompt, "Arrange admitted title.");
    assert_eq!(
        view.root_style.as_ref().unwrap().inline_prompt.as_deref(),
        Some("Readable root.")
    );
    let discovery = discover_generation(&tree, &source);
    let prompts = collect_then_prompts(&discovery.descriptors);
    assert_eq!(prompts.len(), 2);
    assert!(
        prompts
            .iter()
            .any(|p| p.kind == GenerationKind::ViewRootStyleInline && p.prompt == "Readable root.")
    );
}

#[test]
fn compile_emits_ordinary_named_and_inline_style_hosts() {
    let source = "app Tasks\nGiven\n Todo {title:text}\nWhen\nThen\n style Surface $\"Shared.\"\n page / title=\"Tasks\" $\"Page.\"\n  card \"Named\" $Surface\n   text \"Inside named\"\n  card \"Inline\" $\"Card.\"\n   text \"Inside inline\"\n";
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = then_write(dir.path(), "app.can", source);
    let mut units = Vec::new();
    for (kind, label) in [
        (GenerationKind::StyleDefinition, "Surface"),
        (GenerationKind::StyleInline, "Page"),
        (GenerationKind::StyleInline, "Card"),
    ] {
        let unit = then_bind(&root, &file, source, kind, label);
        then_write(
            dir.path(),
            &format!("can.generated/{unit}/style.css"),
            "section { padding: 1rem; }\n",
        );
        units.push(unit);
    }
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = then_envelope(&compiled.stdout);
    let js = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(js.contains("styledComponent as"), "{js}");
    assert!(
        js.contains(&format!(
            "style:{{unitId:\"{}\",useId:\"can-style-f0-s",
            units[1]
        )),
        "{js}"
    );
    for unit in [&units[0], &units[2]] {
        assert!(
            js.contains(&format!(",\"{unit}\",\"can-style-f0-s")),
            "{unit}: {js}"
        );
    }
    assert_eq!(artifact["stylesheets"].as_array().unwrap().len(), 3);
}

#[test]
fn repeated_saved_view_rows_have_distinct_stable_rendered_instance_ids() {
    let source = "app Tasks\nGiven\n Todo {title:text}\nWhen\n crud Todo by=members fields=title\nThen\n view Tile(row:Todo) $\"Arrange admitted title.\"\n  edit fields=title\n  delete\n page / title=\"Tasks\"\n  list Todo as row\n   show Tile {row=row}\n";
    // Place the emitted entry beneath the workspace so the actual shipped
    // UI package resolves, rather than replacing the renderer with a stub.
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target"))
        .unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = then_write(dir.path(), "app.can", source);
    let unit = then_bind(&root, &file, source, GenerationKind::ViewDefinition, "Tile");
    then_write(
        dir.path(),
        &format!("can.generated/{unit}/implementation.js"),
        "export function render({row,bindings,ui}) { return `<p>${ui.escapeHtml(row.fields.title)}</p>${bindings.edit}${bindings.delete}`; }\n",
    );
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = then_envelope(&compiled.stdout);
    for module in artifact["modules"].as_array().unwrap() {
        // The delivery host resolves the canonical stdlib to its defining
        // runtime, including CRUD handlers imported by this form fixture.
        let js = module["js"].as_str().unwrap().replace(
            "\"@canlang/stdlib\"",
            "\"@canlang/cloudflare/runtime/stdlib\"",
        );
        then_write(dir.path(), module["path"].as_str().unwrap(), &js);
    }
    then_write(dir.path(), "artifact.json", &compiled.stdout);
    let entry = artifact["modules"][0]["path"].as_str().unwrap();
    let page = artifact["pages"][0]["export"].as_str().unwrap();
    let script = format!(
        r#"import assert from 'node:assert/strict';
import fs from 'node:fs';
import {{generatedFields}} from '@canlang/ui';
import {{catalogFromArtifactOperations}} from '../../../packages/interfaces/dist/src/http/operations.js';
import {{{page} as page}} from './{entry}';
const rows=[{{id:'row-a',version:1,fields:{{title:'One'}}}},{{id:'row-b',version:1,fields:{{title:'Two'}}}}];
const context={{preferredLocales:[],appDefaultLocale:'en',theme:{{mode:'system',accent:'blue',density:'comfortable'}},path:'/',isPartial:false,csrfToken:'test',principal:null,invocation:{{request:'test'}},query:async()=>({{rows,columns:[]}})}};
const catalog=catalogFromArtifactOperations(JSON.parse(fs.readFileSync(new URL('./artifact.json',import.meta.url),'utf8')));
context.prepareForm=request=>{{const derived=catalog.derivedFor(request.operation);return {{status:'ready',props:{{context,operation:request.operation,action:'/api/operations/'+request.operation,operationId:'test-operation',mode:'update',derived,fields:generatedFields(derived,'update'),submit:'Edit',timeZone:'UTC',idPrefix:request.occurrence,record:{{id:request.arguments.record.id,version:String(request.arguments.record.version)}}}}}};}};
const html=await page.render(context,{{}});
const ids=[...html.matchAll(/data-can-view="([^"]+)"/g)].map(match=>match[1]);
assert.equal(ids.length,2); assert.notEqual(ids[0],ids[1]);
assert.match(html,/<p>One<\/p>/); assert.match(html,/<p>Two<\/p>/);
assert.equal([...html.matchAll(/action="\/api\/operations\/Tasks.Todo.update"/g)].length,2);
assert.equal([...html.matchAll(/action="\/api\/operations\/Tasks.Todo.delete"/g)].length,2);
assert.ok(!html.includes('undefined'));
assert.deepEqual([...String(await page.render(context,{{}})).matchAll(/data-can-view="([^"]+)"/g)].map(match=>match[1]),ids);
"#
    );
    then_write(dir.path(), "render.mjs", &script);
    let output = std::process::Command::new("node")
        .arg(dir.path().join("render.mjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn repeated_native_row_panels_match_activation_safe_external_openers() {
    let source = "app Tasks\nGiven\n Todo {title:text}\n policy Todo read=members\nWhen\nThen\n page / title=\"Tasks\"\n  list Todo\n   card row.title\n    primary \"Details\" opens=details\n    secondary \"Drawer\" opens=tools\n    secondary \"Notes\" target=\"/notes\"\n    modal \"Details panel\" id=details\n     slot content\n      text row.title\n    drawer \"Tools panel\" id=tools\n     slot content\n      text row.title\n";
    let dir = tempfile::tempdir_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target"))
        .unwrap();
    let file = then_write(dir.path(), "app.can", source);
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = then_envelope(&compiled.stdout);
    for module in artifact["modules"].as_array().unwrap() {
        let js = module["js"].as_str().unwrap().replace(
            "\"@canlang/stdlib\"",
            "\"@canlang/cloudflare/runtime/stdlib\"",
        );
        then_write(dir.path(), module["path"].as_str().unwrap(), &js);
    }
    let entry = artifact["modules"][0]["path"].as_str().unwrap();
    let page = artifact["pages"][0]["export"].as_str().unwrap();
    let script = format!(
        r#"import assert from 'node:assert/strict';
import {{{page} as page}} from './{entry}';
const rows=[{{id:'row-a',version:1,fields:{{title:'One'}}}},{{id:'row-b',version:1,fields:{{title:'Two'}}}}];
const context={{preferredLocales:[],appDefaultLocale:'en',theme:{{mode:'system',accent:'blue',density:'comfortable'}},path:'/',isPartial:false,csrfToken:'test',principal:null,invocation:{{request:'test'}},query:async()=>({{rows,columns:[]}})}};
const html=await page.render(context,{{}});
const cards=[...html.matchAll(/<section\b[^>]*data-can-card[^>]*>[\s\S]*?<\/section>/g)].map(match=>match[0]);
assert.equal(cards.length,2);
const all=[];
for(const card of cards){{
 const targets=[...card.matchAll(/data-can-panel-open="([^"]+)"/g)].map(match=>match[1]);
 const ids=new Set([...card.matchAll(/<(?:dialog|input)\b[^>]*\bid="([^"]+)"/g)].map(match=>match[1]));
 assert.equal(targets.length,2,'external openers suppress implicit duplicates');
 for(const target of targets){{assert.match(target,/^[A-Za-z][A-Za-z0-9_-]*$/);assert.ok(ids.has(target),'opener belongs to this row panel');}}
 assert.ok(card.includes('href="/notes"'),'navigation URL retains its exact value');
 all.push(...targets);
}}
assert.equal(new Set(all).size,4,'repeated rows have distinct modal and drawer identities');
assert.deepEqual([...String(await page.render(context,{{}})).matchAll(/data-can-panel-open="([^"]+)"/g)].map(match=>match[1]),all,'row activation identities are stable');
"#
    );
    then_write(dir.path(), "render.mjs", &script);
    let output = std::process::Command::new("node")
        .arg(dir.path().join("render.mjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn composed_packages_keep_same_named_view_owners_through_saved_emission() {
    let source = r#"app Composed uses=[one,two]
package one
 Given
  Item {title:text}
 When
 Then
  view Tile(row:Item) $"Arrange the first package's opaque card."
   card row.title
    text row.title
  page /one title="One"
   list Item
    show Tile {row=row}
package two
 Given
  Item {title:text}
 When
 Then
  view Tile(row:Item) $"Arrange the second package's opaque card."
   card row.title
    text row.title
  page /two title="Two"
   list Item
    show Tile {row=row}
"#;
    let tree = parse(source);
    let lowering = lower_then_views(&tree, source);
    assert!(
        lowering.diagnostics.is_empty(),
        "{:?}",
        lowering.diagnostics
    );
    assert_eq!(
        lowering
            .views
            .iter()
            .map(|view| view.anchor.as_str())
            .collect::<Vec<_>>(),
        ["one:view:Tile:Item", "two:view:Tile:Item"]
    );
    let discovery = discover_generation(&tree, source);
    assert!(
        discovery.diagnostics.is_empty(),
        "{:?}",
        discovery.diagnostics
    );
    let edges = walk_generation_uses(&tree, source, &discovery.descriptors);
    assert_eq!(edges.len(), 2);
    for edge in &edges {
        assert_eq!(
            edge.definition_anchor,
            format!("{}:view:Tile:Item", edge.owner)
        );
        let view = lowering
            .views
            .iter()
            .find(|view| view.anchor == edge.definition_anchor)
            .unwrap();
        assert!(edge.use_span.start > view.span.end);
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let file = then_write(dir.path(), "app.can", source);
    let revision = then_sha256(source.as_bytes());
    let mut units = Vec::new();
    for owner in ["one", "two"] {
        let descriptor = discovery
            .descriptors
            .iter()
            .find(|descriptor| {
                descriptor.kind == GenerationKind::ViewDefinition && descriptor.owner == owner
            })
            .unwrap();
        let bound = then_dispatch(&then_argv(&[
            "gen",
            "bind",
            &root,
            &file,
            &descriptor.span.start.to_string(),
            &descriptor.span.end.to_string(),
            &revision,
            "new",
        ]));
        assert_eq!(bound.code, 0, "{}", bound.stderr);
        let unit = bound.stdout.split_whitespace().nth(1).unwrap().to_string();
        then_write(
            dir.path(),
            &format!("can.generated/{unit}/implementation.js"),
            "export function render({bindings}) { return bindings.card; }\n",
        );
        units.push((owner, unit));
    }
    let compiled = then_compile(dir.path(), &file);
    assert_eq!(compiled.code, 0, "{}", compiled.stdout);
    let artifact = then_envelope(&compiled.stdout);
    let modules = artifact["modules"].as_array().unwrap();
    // The composed app entry owns every joined page and its renderer imports;
    // package modules carry identities, rather than duplicate page runtimes.
    let entry = &modules[0];
    assert_eq!(entry["path"], "$can$m$436f6d706f736564.mjs");
    let js = entry["js"].as_str().unwrap();
    let binding = |domain: &str, identity: &str| {
        format!(
            "$can${domain}${}",
            identity
                .bytes()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    };
    for (owner, unit) in &units {
        assert!(
            js.contains(&format!("from \"./can.generated/{unit}/view.js\"")),
            "{js}"
        );
        let render = binding("p", &format!("{owner}:render:/{owner}"));
        let page = js
            .lines()
            .find(|line| line.starts_with(&format!("export async function {render}(")))
            .expect("each composed package keeps its own page runtime");
        assert!(
            page.contains(&format!("rowModel:\"{owner}.Item\"")),
            "{page}"
        );
        assert!(page.contains("{name:\"card\",html:"), "{page}");
        assert!(
            page.contains(&format!("render:{}", binding("v", unit))),
            "{page}"
        );
        let other = units
            .iter()
            .find(|(candidate, _)| candidate != owner)
            .unwrap();
        assert!(
            !page.contains(&format!("render:{}", binding("v", &other.1))),
            "{page}"
        );
        assert!(
            !page.contains(&format!("rowModel:\"{}.Item\"", other.0)),
            "{page}"
        );
    }
}
