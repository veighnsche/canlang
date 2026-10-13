//! BGI-01: generation source carriers, formatting and discovery.
use canlang_compiler::analysis::generation::{GenerationKind, discover_generation};
use canlang_compiler::format::format_source;
use canlang_compiler::source::SourceId;
use canlang_compiler::syntax::{SyntaxKind, parse_source};

const POSITIVE: &str = r#"app Tasks
Given
 trait completable $"Add done:bool=false with Open/Done labels."
 keyword canonical_identity(target:model,field:field(target,text)) $"Use the field NFKC-normalized key."
 Todo {title:text trim min=1 max=200} completable
 Note {body:text} trait $"Add pinned:bool=false."
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

fn parse(text: &str) -> (canlang_compiler::syntax::SyntaxNode, Vec<String>) {
    let (tree, diags) = parse_source(SourceId(0), text);
    (
        tree,
        diags
            .iter()
            .map(|d| format!("{} {}", d.code, d.message))
            .collect(),
    )
}

fn wrap(given: &str, when: &str, then: &str) -> String {
    format!("app Tasks\nGiven\n{given}When\n{when}Then\n{then}")
}

#[test]
fn positive_forms_parse_with_generation_kinds() {
    let (tree, diags) = parse(POSITIVE);
    assert!(diags.is_empty(), "{diags:?}\n{}", tree.dump(POSITIVE));
    for kind in [
        SyntaxKind::TraitDef,
        SyntaxKind::KeywordDef,
        SyntaxKind::KeywordParam,
        SyntaxKind::KeywordApp,
        SyntaxKind::StyleDef,
        SyntaxKind::GenPrompt,
        SyntaxKind::StyleSuffix,
        SyntaxKind::ViewStyle,
        SyntaxKind::TraitApp,
    ] {
        assert!(
            tree.descendants().any(|n| n.kind == kind),
            "missing {kind:?}"
        );
    }
    // Ordinary strings remain ordinary literals, not prompts.
    assert!(POSITIVE.contains("title=\"Todos\""));
}

#[test]
fn discovery_finds_units_before_saved_implementation_exists() {
    let (tree, diags) = parse(POSITIVE);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, POSITIVE);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let by = |k: GenerationKind| {
        found
            .descriptors
            .iter()
            .filter(|d| d.kind == k)
            .collect::<Vec<_>>()
    };
    assert_eq!(by(GenerationKind::NamedTrait).len(), 1);
    assert_eq!(
        by(GenerationKind::NamedTrait)[0].label.as_deref(),
        Some("completable")
    );
    assert!(by(GenerationKind::NamedTrait)[0].has_generation_identity);
    assert_eq!(by(GenerationKind::InlineTrait).len(), 1);
    assert_eq!(
        by(GenerationKind::InlineTrait)[0].target.as_deref(),
        Some("Note")
    );
    assert_eq!(by(GenerationKind::KeywordDefinition).len(), 1);
    let kw = by(GenerationKind::KeywordDefinition)[0];
    assert_eq!(kw.label.as_deref(), Some("canonical_identity"));
    assert_eq!(kw.params.len(), 2);
    assert_eq!(kw.params[0].kind, "model");
    assert_eq!(kw.params[1].kind, "field");
    assert_eq!(kw.params[1].target_param.as_deref(), Some("target"));
    assert_eq!(kw.params[1].type_name.as_deref(), Some("text"));
    assert_eq!(by(GenerationKind::KeywordApplication).len(), 1);
    assert!(!by(GenerationKind::KeywordApplication)[0].has_generation_identity);
    assert_eq!(by(GenerationKind::StyleDefinition).len(), 1);
    let style = by(GenerationKind::StyleDefinition)[0];
    assert_eq!(style.label.as_deref(), Some("TaskSurface"));
    // Uses (view root + input + list + show) get roots/hooks, no identity.
    assert_eq!(style.use_sites.len(), 4, "{:?}", found.descriptors);
    assert_eq!(by(GenerationKind::ViewDefinition).len(), 1);
    assert_eq!(
        by(GenerationKind::ViewDefinition)[0].target.as_deref(),
        Some("Todo")
    );
    assert_eq!(by(GenerationKind::StyleInline).len(), 2); // page + card
    let named_uses = by(GenerationKind::StyleNamedUse);
    assert_eq!(named_uses.len(), 3); // input, list, show
    assert!(named_uses.iter().all(|d| !d.has_generation_identity));
    assert_eq!(by(GenerationKind::ViewRootStyleNamed).len(), 1);
}

#[test]
fn field_inline_trait_and_profile_discovery() {
    let src = wrap(
        " Item {name:text trait $\"Normalize the name.\",qty:int}\n trait tagged agent=fast $\"Tag it.\"\n keyword stamp(target:model,flag:bool,count:int) agent=fast $\"Stamp.\"\n Item2 {x:text}\n stamp target=Item2 flag=true count=2\n",
        "",
        " page / title=\"T\"\n  text \"hi\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let inline = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::InlineTrait)
        .expect("field inline trait");
    assert_eq!(inline.target.as_deref(), Some("Item.name"));
    let tagged = found
        .descriptors
        .iter()
        .find(|d| d.label.as_deref() == Some("tagged"))
        .expect("tagged trait");
    assert_eq!(tagged.profile.as_deref(), Some("fast"));
    let kw = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::KeywordDefinition)
        .expect("keyword");
    assert_eq!(kw.profile.as_deref(), Some("fast"));
}

#[test]
fn format_is_canonical_and_idempotent_for_new_forms() {
    let messy = POSITIVE
        .replace("trait completable", "trait   completable")
        .replace("canonical_identity target=", "canonical_identity   target=")
        .replace("input title $TaskSurface", "input title    $TaskSurface");
    let once = format_source(SourceId(0), &messy).expect("format");
    assert!(once.text.contains("trait completable $\"Add done"));
    assert!(
        once.text
            .contains("canonical_identity target=Account field=Account.handle")
    );
    assert!(once.text.contains("input title $TaskSurface"));
    assert!(once.text.contains("view TaskTile(row:Todo) $\"Arrange"));
    let twice = format_source(SourceId(0), &once.text).expect("reformat");
    assert_eq!(once.text, twice.text);
    assert!(!twice.changed);
    // Anchors ignore formatting: discovery anchors match after formatting.
    let (t1, _) = parse(POSITIVE);
    let a1: Vec<String> = discover_generation(&t1, POSITIVE)
        .descriptors
        .iter()
        .map(|d| d.anchor.clone())
        .collect();
    let (t2, _) = parse(&once.text);
    let a2: Vec<String> = discover_generation(&t2, &once.text)
        .descriptors
        .iter()
        .map(|d| d.anchor.clone())
        .collect();
    assert_eq!(a1, a2);
}

#[test]
fn ordinary_strings_are_not_generation_prompts() {
    let src = wrap(
        " Todo {title:text label=\"Title\"}\n",
        "",
        " page / title=\"Todos\"\n  card \"Add a task\"\n   text \"hello\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.descriptors.is_empty(), "{:?}", found.descriptors);
}

fn expect_parse_err(src: &str, needle: &str) {
    let (_t, diags) = parse(src);
    assert!(
        diags.iter().any(|d| d.contains(needle)),
        "expected diagnostic containing {needle:?}, got {diags:?}"
    );
}

fn expect_discovery_err(src: &str, needle: &str) {
    let (tree, diags) = parse(src);
    assert!(diags.is_empty(), "parse: {diags:?}");
    let found = discover_generation(&tree, src);
    assert!(
        found.diagnostics.iter().any(|d| d.message.contains(needle)),
        "expected discovery diagnostic containing {needle:?}, got {:?}",
        found.diagnostics
    );
}

#[test]
fn negative_parse_diagnostics() {
    // Anonymous keyword definition.
    expect_parse_err(
        &wrap(
            " keyword $\"Do a thing.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "anonymous keyword",
    );
    // Standalone inline trait in Given (must attach to a model/field).
    expect_parse_err(
        &wrap(
            " trait $\"Do a thing.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "must be attached",
    );
    // Prompt on a keyword application.
    expect_parse_err(
        &wrap(
            " keyword stamp(target:model) $\"Stamp.\"\n Item {x:text}\n stamp target=Item $\"again\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "keyword applications cannot carry a generation prompt",
    );
    // Built-in redefinition.
    expect_parse_err(
        &wrap(
            " keyword policy(target:model) $\"Redefine.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "redefines a built-in",
    );
    expect_parse_err(
        &wrap(
            " trait unique $\"Redefine.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "redefines a built-in",
    );
    // Unmarked generation slot (ordinary string where $ is mandatory).
    expect_parse_err(
        &wrap(
            " trait completable \"Add done.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "static $\"...\"",
    );
    // Non-adjacent dollar.
    expect_parse_err(
        &wrap(
            " trait completable $ \"Add done.\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "adjacent",
    );
    // Prompt as a When do body.
    expect_parse_err(
        &wrap(
            " Todo {title:text}\n",
            " scenario complete(task:Todo) by=members\n  do $\"Generate the body.\"\n",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "not a valid `do` body",
    );
    // Wrong row signature.
    expect_parse_err(
        &wrap(
            " Todo {title:text}\n",
            "",
            " view Bad(rows:Todo) $\"Render.\"\n  delete\n",
        ),
        "row",
    );
    expect_parse_err(
        &wrap(
            " Todo {title:text}\n",
            "",
            " view Bad(row:Todo?) $\"Render.\"\n  delete\n",
        ),
        "view requires one nonnullable",
    );
    // Forbidden prompted-view children: arbitrary group, slot, nested show.
    expect_parse_err(
        &wrap(
            " Todo {title:text}\n",
            "",
            " view Tile(row:Todo) $\"Render.\"\n  card \"Nope\"\n   text row.title\n",
        ),
        "prompted view accepts only canonical controls",
    );
    expect_parse_err(
        &wrap(
            " Todo {title:text}\n Other {x:text}\n",
            "",
            " view Tile(row:Todo) $\"Render.\"\n  show OtherTile {row=row}\n view OtherTile(row:Other)\n  text row.x\n",
        ),
        "prompted view accepts only canonical controls",
    );
    // Catalog `button` controls are admitted in prompted views: resolve,
    // check, and codegen all support them (draft `button action=` shape).
    {
        let src = wrap(
            " Todo {title:text}\n",
            "",
            " view Tile(row:Todo) $\"Render.\"\n  button action=reopen\n",
        );
        let (_t, diags) = parse(&src);
        assert!(
            diags.is_empty(),
            "button should parse in prompted views, got {diags:?}"
        );
    }
    // Duplicate keyword argument (parser) and positional argument.
    expect_parse_err(
        &wrap(
            " keyword stamp(target:model) $\"Stamp.\"\n Item {x:text}\n stamp target=Item target=Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "duplicate keyword argument",
    );
    expect_parse_err(
        &wrap(
            " keyword stamp(target:model) $\"Stamp.\"\n Item {x:text}\n stamp Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "named",
    );
}

#[test]
fn named_field_trait_targets_are_distinguished() {
    // Expected: checked field attachments carry Model.field targets/anchors.
    let src = wrap(
        " trait clean $\"Clean.\"\n Item {a:text clean,b:text clean}\n",
        "",
        " page / title=\"T\"\n  text \"hi\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let apps: Vec<_> = found
        .descriptors
        .iter()
        .filter(|d| d.kind == GenerationKind::TraitApplication)
        .collect();
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0].target.as_deref(), Some("Item.a"));
    assert_eq!(apps[1].target.as_deref(), Some("Item.b"));
    assert_ne!(apps[0].anchor, apps[1].anchor);
    // Refusal: an unknown field trait still diagnoses.
    expect_discovery_err(
        &wrap(
            " Item {a:text nosuchtrait}\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "unknown trait `nosuchtrait`",
    );
}

#[test]
fn keyword_argument_admission_is_strict() {
    // Expected: an existing operation, fully typed array elements, a bound
    // dependent field, and a plain compile-time constant all check.
    let src = wrap(
        " keyword observe(op:operation) $\"Observe.\"\n keyword count(xs:int[]) $\"Count.\"\n keyword key(target:model,field:field(target,text)) $\"Key.\"\n keyword label(value:text) $\"Label.\"\n Item {a:text}\n observe op=poke\n count xs=[1, 2]\n key target=Item field=Item.a\n label value=\"ok\"\n",
        " scenario poke(item:Item) by=members\n  do set item {a=\"ok\"}\n",
        " page / title=\"T\"\n  text \"hi\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    // Refusals: nonexistent operation, mistyped element, dangling dependent
    // target, executable expression binding.
    expect_discovery_err(
        &wrap(
            " keyword observe(op:operation) $\"Observe.\"\n Item {x:text}\n observe op=Item.nosuch\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "must name a known operation",
    );
    expect_discovery_err(
        &wrap(
            " keyword count(xs:int[]) $\"Count.\"\n Item {x:text}\n count xs=[\"wrong\"]\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "requires int array elements",
    );
    expect_discovery_err(
        &wrap(
            " keyword key(field:field(nosuch,text)) $\"Key.\"\n Item {a:text}\n key field=Item.a\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "targets unknown parameter `nosuch`",
    );
    expect_discovery_err(
        &wrap(
            " keyword label(value:text) $\"Label.\"\n Item {a:text}\n label value=\"x\" + Item.a\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "requires a checked text constant",
    );
}

#[test]
fn keyword_string_arguments_preserve_literal_contents() {
    // Expected: literal contents survive exactly; surrounding trivia
    // normalizes around them.
    for given in [
        " keyword label(value:text) $\"Label.\"\n Item {a:text}\n label value=\"A  B\"\n",
        " keyword label(value:text) $\"Label.\"\n Item {a:text}\n label    value=\"A  B\"\n",
    ] {
        let src = wrap(given, "", " page / title=\"T\"\n  text \"hi\"\n");
        let (tree, diags) = parse(&src);
        assert!(diags.is_empty(), "{diags:?}");
        let found = discover_generation(&tree, &src);
        assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
        let app = found
            .descriptors
            .iter()
            .find(|d| d.kind == GenerationKind::KeywordApplication)
            .expect("keyword app");
        assert_eq!(app.args.len(), 1);
        assert_eq!(app.args[0].value, "\"A  B\"");
    }
    // Refusal: a compound expression is not a preserved literal.
    expect_discovery_err(
        &wrap(
            " keyword label(value:text) $\"Label.\"\n Item {a:text}\n label value=\"A\" + \"B\"\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "requires a checked text constant",
    );
}

#[test]
fn ambiguous_keyword_declaration_names_diagnose() {
    // Expected: distinct keyword/model/trait names check.
    let src = wrap(
        " keyword stamp(target:model) $\"Stamp.\"\n trait tagged $\"Tag.\"\n Item {a:text}\n stamp target=Item\n",
        "",
        " page / title=\"T\"\n  text \"hi\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    // Refusals: keyword/model and keyword/trait collisions.
    expect_discovery_err(
        &wrap(
            " keyword Item(target:model) $\"X.\"\n Item {a:text}\n Item target=Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "ambiguous declaration name `Item`",
    );
    expect_discovery_err(
        &wrap(
            " keyword clean(target:model) $\"X.\"\n trait clean $\"Clean.\"\n Item {a:text}\n clean target=Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "ambiguous declaration name `clean`",
    );
}

#[test]
fn style_suffix_is_refused_on_nonvisual_require() {
    // Expected: a plain guard parses and visual leaves keep suffixes.
    let src = wrap(
        " Item {a:text}\n",
        "",
        " style S $\"Style.\"\n page / title=\"T\"\n  require true\n  text \"hi\" $S\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    assert_eq!(
        found
            .descriptors
            .iter()
            .filter(|d| d.kind == GenerationKind::StyleNamedUse)
            .count(),
        1
    );
    // Refusal: a style attachment on the guard diagnoses.
    expect_parse_err(
        &wrap(
            " Item {a:text}\n",
            "",
            " style S $\"Style.\"\n page / title=\"T\"\n  require true $S\n",
        ),
        "not admitted on nonvisual",
    );
}

#[test]
fn inline_prompt_owner_propagates_agent_profile() {
    // Expected: agent= on the owning declaration reaches the inline unit.
    let src = wrap(
        " Item {a:text}\n",
        "",
        " page / title=\"T\" agent=fast $\"Style.\"\n  text \"hi\"\n",
    );
    let (tree, diags) = parse(&src);
    assert!(diags.is_empty(), "{diags:?}");
    let found = discover_generation(&tree, &src);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let inline = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::StyleInline)
        .expect("inline style");
    assert_eq!(inline.profile.as_deref(), Some("fast"));
    // Refusals: a named use cannot select a recipe; agent without a prompt
    // diagnoses.
    expect_parse_err(
        &wrap(
            " Item {a:text}\n",
            "",
            " style S $\"Style.\"\n page / title=\"T\" agent=fast $S\n  text \"hi\"\n",
        ),
        "cannot select its shared definition's recipe",
    );
    expect_parse_err(
        &wrap(
            " Item {a:text}\n",
            "",
            " page / title=\"T\" agent=fast\n  text \"hi\"\n",
        ),
        "requires an inline",
    );
}

#[test]
fn negative_discovery_diagnostics() {
    // Duplicate style definitions.
    expect_discovery_err(
        &wrap(
            " Todo {title:text}\n",
            "",
            " style Surface $\"One.\"\n style Surface $\"Two.\"\n page / title=\"T\"\n  text \"hi\"\n",
        ),
        "duplicate style",
    );
    // Unknown style reference.
    expect_discovery_err(
        &wrap(
            " Todo {title:text}\n",
            "",
            " page / title=\"T\"\n  text \"hi\" $Missing\n",
        ),
        "unknown style",
    );
    // Unknown custom keyword (definition collection precedes resolution).
    expect_discovery_err(
        &wrap(
            " Item {x:text}\n mystery target=Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "unknown custom keyword",
    );
    // Missing and unknown keyword arguments.
    expect_discovery_err(
        &wrap(
            " keyword stamp(target:model,flag:bool) $\"Stamp.\"\n Item {x:text}\n stamp target=Item\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "requires argument `flag`",
    );
    expect_discovery_err(
        &wrap(
            " keyword stamp(target:model) $\"Stamp.\"\n Item {x:text}\n stamp target=Item bogus=1\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "unknown argument `bogus`",
    );
    // Field target and type mismatches.
    expect_discovery_err(
        &wrap(
            " keyword canonical_identity(target:model,field:field(target,text)) $\"Key.\"\n Account {handle:text}\n Todo {title:text}\n canonical_identity target=Account field=Todo.title\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "does not belong to target model",
    );
    expect_discovery_err(
        &wrap(
            " keyword canonical_identity(target:model,field:field(target,int)) $\"Key.\"\n Account {handle:text}\n canonical_identity target=Account field=Account.handle\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "expected `int`",
    );
    // Unknown trait application.
    expect_discovery_err(
        &wrap(
            " Todo {title:text} missingtrait\n",
            "",
            " page / title=\"T\"\n  text \"hi\"\n",
        ),
        "unknown trait",
    );
}

#[test]
fn view_header_keeps_renderer_and_root_style_ownership_separate() {
    let source = wrap(
        " Todo {title:text}\n",
        "",
        " style Surface $\"Shared appearance.\"\n view Named(row:Todo) $\"Arrange title.\" $Surface\n  text row.title\n view Inline(row:Todo) agent=frontend $\"Arrange title.\" $\"Quiet root.\"\n  text row.title\n page / title=\"T\"\n  card \"Entry\" $Surface\n   text \"Hi\"\n",
    );
    let (tree, diagnostics) = parse(&source);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let found = discover_generation(&tree, &source);
    assert!(found.diagnostics.is_empty(), "{:?}", found.diagnostics);
    let renderer = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::ViewDefinition && d.label.as_deref() == Some("Inline"))
        .unwrap();
    assert_eq!(renderer.prompt.as_deref(), Some("Arrange title."));
    let root = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::ViewRootStyleInline)
        .unwrap();
    assert_eq!(root.prompt.as_deref(), Some("Quiet root."));
    assert_eq!(root.profile.as_deref(), Some("frontend"));
    assert_eq!(root.anchor, "Tasks:view-style-inline:Inline:Inline");
    assert_eq!(root.target.as_deref(), Some("Inline"));
    let named = found
        .descriptors
        .iter()
        .find(|d| d.kind == GenerationKind::ViewRootStyleNamed)
        .unwrap();
    assert_eq!(named.label.as_deref(), Some("Surface"));
    let once = format_source(SourceId(0), &source).expect("format");
    assert!(once.text.contains("$\"Arrange title.\" $Surface"));
    assert!(once.text.contains("$\"Arrange title.\" $\"Quiet root.\""));
    let twice = format_source(SourceId(0), &once.text).expect("format again");
    assert_eq!(once.text, twice.text);
}

#[test]
fn style_leaf_wrapper_and_multiple_suffixes_refuse() {
    for then in [
        " view Tile(row:Todo) $\"Arrange.\"\n  style $\"Quiet.\"\n",
        " style $\"Quiet.\"\n  page / title=\"T\"\n   text \"Hi\"\n",
        " view Tile(row:Todo) $\"Arrange.\" $\"Quiet.\" $\"Extra.\"\n",
        " page / title=\"T\" $\"Quiet.\" $\"Extra.\"\n  text \"Hi\"\n",
    ] {
        let source = wrap(" Todo {title:text}\n", "", then);
        assert!(
            !parse(&source).1.is_empty(),
            "unexpected admission: {source}"
        );
    }
}
