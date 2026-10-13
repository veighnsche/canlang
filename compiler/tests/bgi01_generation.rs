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
