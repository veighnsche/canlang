//! Private checked/IR disclosure facts only; no artifact, marker or receipt qualification.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedScenarioDisclosure, DependencyRole, DisclosureChoice, InfluenceKind, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::{collections::HashSet, path::Path};

fn checked(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram) {
    let mut db = SourceDb::new();
    let files: Vec<_> = sources
        .iter()
        .map(|(path, text)| db.add((*path).into(), (*text).into()))
        .collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(files[0], 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &files, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for (id, fact) in program.scenario_disclosures() {
        let retained = lowered
            .scenario_disclosures
            .get(id)
            .expect("IR retains checked completeness/decline");
        assert_eq!(format!("{fact:?}"), format!("{retained:?}"));
    }
    (db, program)
}
fn fact<'a>(program: &'a CheckedProgram, name: &str) -> &'a ScenarioDisclosure {
    let symbol = program
        .symbols
        .iter()
        .find(|s| s.canonical == name)
        .unwrap();
    program
        .scenario_disclosures()
        .get(&symbol.id)
        .expect("explicit completeness or whole-scenario decline")
}
fn complete<'a>(program: &'a CheckedProgram, name: &str) -> &'a CheckedScenarioDisclosure {
    match fact(program, name) {
        ScenarioDisclosure::Complete(value) => value,
        other => panic!("{name}: {other:?}"),
    }
}
fn origins(db: &SourceDb, value: &CheckedScenarioDisclosure) {
    let verify = |source: &canlang_compiler::analysis::scenario_disclosure::DisclosureSource,
                  node: canlang_compiler::analysis::NodeKey| {
        let captured = db.get(node.file).unwrap();
        assert_eq!(source.path, captured.path);
        assert_eq!(source.sha256, sha256_hex(captured.text.as_bytes()));
        assert!(!source.module.is_empty());
        assert!(node.start <= node.end && node.end as usize <= captured.text.len());
    };
    let mut ids = HashSet::new();
    for path in &value.returns {
        verify(&path.source, path.node);
        assert!(ids.insert(&path.id));
        assert!(path.influences.is_empty());
        for dep in &path.dependencies {
            verify(&dep.source, dep.node);
            assert!(!dep.id.is_empty());
        }
    }
}
const SUPPORTED: &str = r#"app Disclosure
Given
 Item {title:text,enabled:bool,optional:text?}
 policy Item read=members
 derive title(item:Item):text = item.title
 derive echo(value:text="default"):text = value
 derive forwarded(item:Item,value:text=item.title):text = value
 derive discarded(value:text):int = 1
When
 scenario literal() -> int by=members
  do return 7
 scenario input(value:text) -> text by=members
  do return value
 scenario alias(value:text) -> text by=members
  do
   let copy=value
   return copy
 scenario finish() by=members
  do require true
 scenario decision(item:Item) -> int by=members
  do
   require item.enabled
   return 1
 scenario field(item:Item) -> text by=members
  do return item.title
 scenario derived(item:Item) -> text by=members
  do return title(item)
 scenario argument(item:Item) -> text by=members
  do return echo(item.title)
 scenario field_default(item:Item) -> text by=members
  do return forwarded(item)
 scenario discarded_argument(item:Item) -> int by=members
  do return discarded(item.title)
 scenario defaulted() -> text by=members
  do return echo()
 scenario repeated(item:Item) -> bool by=members
  do return title(item)==title(item)
 scenario branch(item:Item) -> text by=members
  do
   if item.enabled
    return item.title
   else
    return "hidden"
 scenario short(item:Item) -> bool by=members
  do return item.enabled and item.title=="yes"
 scenario either(item:Item) -> bool by=members
  do return item.enabled or item.title=="yes"
 scenario fallback(item:Item) -> text by=members
  do return item.optional ?? item.title
Then
"#;

#[test]
fn checked_scalar_alias_void_and_ir_facts_have_exact_origins() {
    let (db, program) = checked(&[("disclosure.can", SUPPORTED)]);
    for name in [
        "literal",
        "input",
        "alias",
        "finish",
        "decision",
        "field",
        "derived",
        "argument",
        "field_default",
        "discarded_argument",
        "defaulted",
        "repeated",
        "branch",
        "short",
        "either",
        "fallback",
    ] {
        let value = complete(&program, &format!("Disclosure.{name}"));
        assert_eq!(value.source.path, "disclosure.can");
        assert_eq!(value.source.module, "Disclosure");
        assert_eq!(value.source.sha256, sha256_hex(SUPPORTED.as_bytes()));
        origins(&db, value);
    }
    for name in [
        "literal",
        "input",
        "alias",
        "finish",
        "decision",
        "defaulted",
        "discarded_argument",
    ] {
        assert!(
            complete(&program, &format!("Disclosure.{name}"))
                .returns
                .iter()
                .all(|r| r.dependencies.is_empty()),
            "decision-only checks do not disclose independent returns"
        );
    }
    for name in ["field", "derived", "argument", "field_default"] {
        let value = complete(&program, &format!("Disclosure.{name}"));
        assert_eq!(value.returns.len(), 1);
        let deps = &value.returns[0].dependencies;
        assert_eq!(deps.len(), 1);
        assert_eq!(
            (
                &*deps[0].model_name,
                &*deps[0].field_name,
                &*deps[0].type_id
            ),
            ("Disclosure.Item", "title", "text")
        );
        assert_eq!(deps[0].role, DependencyRole::Data);
    }
    let repeated = &complete(&program, "Disclosure.repeated").returns[0].dependencies;
    assert_eq!(repeated.len(), 2);
    assert_ne!(repeated[0].id, repeated[1].id);
    assert_eq!(repeated[0].node, repeated[1].node);
    assert_ne!(repeated[0].calls, repeated[1].calls);
    for dep in repeated {
        assert_eq!(dep.calls.len(), 1);
        let call = dep.calls[0];
        let text = &db.get(call.file).unwrap().text;
        assert_eq!(
            text[call.start as usize..call.end as usize].trim(),
            "title(item)"
        );
    }
    let branches = &complete(&program, "Disclosure.branch").returns;
    assert_eq!(branches.len(), 2);
    for branch in branches {
        assert!(
            branch
                .dependencies
                .iter()
                .any(|d| d.field_name == "enabled" && d.role == DependencyRole::Control)
        );
    }
    assert_eq!(
        branches
            .iter()
            .filter(|r| r
                .dependencies
                .iter()
                .any(|d| d.field_name == "title" && d.role == DependencyRole::Data))
            .count(),
        1
    );
    for name in ["short", "either", "fallback"] {
        let paths = &complete(&program, &format!("Disclosure.{name}")).returns;
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().any(|r| {
            r.decisions
                .iter()
                .any(|d| d.choice == DisclosureChoice::RhsEvaluated)
        }));
        assert!(paths.iter().any(|r| {
            r.decisions
                .iter()
                .any(|d| d.choice == DisclosureChoice::RhsSkipped)
        }));
        assert_ne!(paths[0].dependencies.len(), paths[1].dependencies.len());
    }
}

#[test]
fn whole_decline_never_certifies_query_absence_composite_model_or_effect() {
    let source = r#"app Refused
Given
 Item {title:text}
 policy Item read=members
When
 scenario query() read=true -> int by=members
  do return count(Item)
 scenario absent(item:Item?) -> text? by=members
  do return item?.title
 scenario composite(value:bytes[]) -> bytes[] by=members
  do return value
 scenario model(item:Item) -> Item by=members
  do return item
 scenario finish() by=members
  do require true
 scenario called() -> int by=members
  do
   call finish {}
   return 1
 scenario changed(item:Item) -> text by=members
  do
   set item {title="new"}
   return "independent"
Then
"#;
    let (_, program) = checked(&[("refused.can", source)]);
    for name in ["query", "absent", "composite", "model", "called", "changed"] {
        assert!(
            matches!(
                fact(&program, &format!("Refused.{name}")),
                ScenarioDisclosure::Declined(_)
            ),
            "{name} must decline the entire closure"
        );
    }
    let ScenarioDisclosure::Declined(absent) = fact(&program, "Refused.absent") else {
        unreachable!()
    };
    assert!(
        absent
            .influences
            .iter()
            .any(|i| i.kind == InfluenceKind::AbsentReference)
    );
    let ScenarioDisclosure::Declined(query) = fact(&program, "Refused.query") else {
        unreachable!()
    };
    assert!(!query.influences.is_empty());
}

#[test]
fn imported_derive_source_and_ids_survive_checked_cohort_reordering() {
    let library = r#"package library
 Given
  export Item {title:text}
  policy Item read=members
  export derive caption(item:Item):text = item.title
 When
 Then
"#;
    let app = r#"app Imported
use library {Item,caption}
Given
When
 scenario captioned(item:Item) -> text by=members
  do return caption(item)
Then
"#;
    let (db, first) = checked(&[("library.can", library), ("app.can", app)]);
    let (_, second) = checked(&[("app.can", app), ("library.can", library)]);
    let a = complete(&first, "Imported.captioned");
    let b = complete(&second, "Imported.captioned");
    origins(&db, a);
    assert_eq!(a.source.path, "app.can");
    assert_eq!(a.source.module, "Imported");
    assert_eq!(a.source, b.source);
    assert_eq!(a.returns.len(), 1);
    assert_eq!(a.returns[0].id, b.returns[0].id);
    let dep = &a.returns[0].dependencies[0];
    let other = &b.returns[0].dependencies[0];
    assert_eq!(dep.source.path, "library.can");
    assert_eq!(dep.source.module, "library");
    assert_eq!(dep.source.sha256, sha256_hex(library.as_bytes()));
    assert_eq!(dep.model_name, "library.Item");
    assert_eq!(dep.field_name, "title");
    assert_eq!(dep.id, other.id);
    assert_eq!(dep.calls.len(), 1);
    let call = dep.calls[0];
    assert_eq!(
        db.get(call.file).unwrap().text[call.start as usize..call.end as usize].trim(),
        "caption(item)"
    );
}

#[test]
fn eager_derive_argument_decisions_keep_authored_order() {
    let source = r#"app Ordered
Given
 Item {a:bool,b:bool,c:bool,d:bool}
 policy Item read=members
 derive ignore(a:bool,b:bool):int = 1
When
 scenario selected(item:Item) -> int by=members
  do return ignore(item.a and item.b,item.c and item.d)
Then
"#;
    let (db, program) = checked(&[("ordered.can", source)]);
    let value = complete(&program, "Ordered.selected");
    assert_eq!(value.returns.len(), 4);
    for path in &value.returns {
        assert!(path.dependencies.is_empty());
        assert_eq!(path.decisions.len(), 2);
        let anchors: Vec<_> = path
            .decisions
            .iter()
            .map(|d| {
                db.get(d.node.file).unwrap().text[d.node.start as usize..d.node.end as usize].trim()
            })
            .collect();
        assert_eq!(anchors, ["item.a and item.b", "item.c and item.d"]);
    }
}

#[test]
fn context_dependent_returns_decline_but_authorization_does_not_taint_literals() {
    let source = r#"app Contextual
Given
 role reviewer
When
 scenario role_value(person:user) -> bool by=members
  do return reviewer(person)
 scenario members_value() -> bool by=members
  do return members
 scenario role_branch(person:user) -> int by=members
  do
   if reviewer(person)
    return 1
   else
    return 2
 scenario authorized(person:user) -> int by=reviewer(person)
  do return 1
Then
"#;
    let (_, program) = checked(&[("context.can", source)]);
    for name in ["role_value", "members_value", "role_branch"] {
        assert!(matches!(
            fact(&program, &format!("Contextual.{name}")),
            ScenarioDisclosure::Declined(_)
        ));
    }
    assert!(
        complete(&program, "Contextual.authorized")
            .returns
            .iter()
            .all(|r| r.dependencies.is_empty())
    );
}

#[test]
fn stored_nullable_choice_alias_retains_owner_type_or_declines() {
    let source = r#"app Bounded
Given
 judgment Choice version=1
  pick choice "Pick" options=runtime {fallback="Fallback",other="Other"}
 Item {selected:Choice.pick.choice?}
 policy Item read=members
When
 scenario selected(item:Item) -> Choice.pick.choice? by=members
  do return item.selected
Then
"#;
    let (_, program) = checked(&[("bounded.can", source)]);
    if let ScenarioDisclosure::Complete(value) = fact(&program, "Bounded.selected") {
        assert_eq!(value.returns.len(), 1);
        assert_eq!(value.returns[0].dependencies.len(), 1);
        assert_eq!(
            value.returns[0].dependencies[0].type_id,
            "Bounded.Choice.pick.choice?"
        );
    }
}

#[test]
fn erroneous_unresolved_and_recursive_cohorts_publish_no_private_map() {
    for source in [
        "app Broken\nGiven\nWhen\n scenario missing() -> int by=members\n  do return absent\nThen\n",
        "app Broken\nGiven\n derive recur():int = recur()\nWhen\n scenario recursive() -> int by=members\n  do return recur()\nThen\n",
    ] {
        let mut db = SourceDb::new();
        let file = db.add("broken.can".into(), source.into());
        let (program, diagnostics) = check_program(&db, &[file], None);
        assert!(!diagnostics.is_empty());
        assert!(program.scenario_disclosures().is_empty());
    }
}

#[test]
fn nullable_model_presence_comparisons_decline_but_scalar_presence_is_supported() {
    let source = r#"app Presence
Given
 Item {optional:text?}
 policy Item read=members
When
 scenario equal(item:Item?) -> bool by=members
  do return item==null
 scenario unequal(item:Item?) -> bool by=members
  do return null!=item
 scenario control(item:Item?) -> int by=members
  do
   if item!=null
    return 1
   else
    return 2
 scenario scalar(item:Item) -> bool by=members
  do return item.optional==null
Then
"#;
    let (_, program) = checked(&[("presence.can", source)]);
    for name in ["equal", "unequal", "control"] {
        let ScenarioDisclosure::Declined(value) = fact(&program, &format!("Presence.{name}"))
        else {
            panic!("{name} must decline reference-presence influence");
        };
        assert!(
            value
                .influences
                .iter()
                .any(|i| i.kind == InfluenceKind::AbsentReference)
        );
    }
    let value = complete(&program, "Presence.scalar");
    assert_eq!(value.returns.len(), 1);
    assert_eq!(value.returns[0].dependencies.len(), 1);
    assert_eq!(value.returns[0].dependencies[0].type_id, "text?");
}

#[test]
fn unsupported_stored_scalar_types_decline_even_when_the_result_is_boolean() {
    let source = r#"app StoredTypes
Given
 Item {address:email,content:bytes,attachment:file?,private_value:secret? server=random_secret()}
 policy Item read=members
When
 scenario address(item:Item,value:email) -> bool by=members
  do return item.address==value
 scenario content(item:Item,value:bytes) -> bool by=members
  do return item.content==value
 scenario attachment(item:Item) -> bool by=members
  do return item.attachment==null
 scenario private_value(item:Item) -> bool by=members
  do return item.private_value==null
Then
"#;
    let (_, program) = checked(&[("stored-types.can", source)]);
    for name in ["address", "content", "attachment", "private_value"] {
        let ScenarioDisclosure::Declined(value) = fact(&program, &format!("StoredTypes.{name}"))
        else {
            panic!("{name} must decline the unsupported stored dependency type");
        };
        assert_eq!(value.reason, "unsupported stored field type");
    }
}

#[test]
fn primitive_arrays_preserve_ordered_element_closure_and_nullable_inventory() {
    let source = r#"app Arrays
Given
 Item {values:int[],optional_values:text[]?,first:int,optional:int?,fallback:int,required:int[]!}
 policy Item read=members
When
 scenario input(values:int[]) -> int[] by=members
  do return values
 scenario nullable(values:text[]?) -> text[]? by=members
  do return values
 scenario stored(item:Item) -> int[] by=members
  do return item.values
 scenario optional_stored(item:Item) -> text[]? by=members
  do return item.optional_values
 scenario literal() -> int[] by=members
  do return [1,2]
 scenario elements(item:Item) -> int[] by=members
  do return [item.first,item.optional ?? item.fallback]
 scenario required(item:Item) -> int[] by=members
  do return item.required
Then
"#;
    let (db, program) = checked(&[("arrays.can", source)]);
    for name in ["input", "nullable", "literal"] {
        let value = complete(&program, &format!("Arrays.{name}"));
        origins(&db, value);
        assert_eq!(value.returns.len(), 1);
        assert!(value.returns[0].dependencies.is_empty());
    }
    for (name, ty) in [("stored", "int[]"), ("optional_stored", "text[]?")] {
        let value = complete(&program, &format!("Arrays.{name}"));
        assert_eq!(value.returns[0].dependencies.len(), 1);
        assert_eq!(value.returns[0].dependencies[0].type_id, ty);
    }
    let paths = &complete(&program, "Arrays.elements").returns;
    assert_eq!(paths.len(), 2);
    for path in paths {
        assert_eq!(path.dependencies[0].field_name, "first");
        assert_eq!(path.dependencies[0].role, DependencyRole::Data);
        assert_eq!(path.decisions.len(), 1);
        assert_eq!(
            path.dependencies
                .iter()
                .any(|dep| dep.field_name == "fallback"),
            path.decisions[0].choice == DisclosureChoice::RhsEvaluated
        );
    }
    assert!(matches!(
        fact(&program, "Arrays.required"),
        ScenarioDisclosure::Declined(_)
    ));
}

#[test]
fn array_paths_retain_the_existing_finite_cartesian_bound() {
    let elements = std::iter::repeat_n("item.optional ?? 0", 11)
        .collect::<Vec<_>>()
        .join(",");
    let source = format!(
        "app ArrayBound\nGiven\n Item {{optional:int?}}\n policy Item read=members\nWhen\n scenario many(item:Item) -> int[] by=members\n  do return [{elements}]\nThen\n"
    );
    let (_, program) = checked(&[("array-bound.can", &source)]);
    let ScenarioDisclosure::Declined(value) = fact(&program, "ArrayBound.many") else {
        panic!("array element choices must not expand beyond the finite path limit");
    };
    assert!(value.reason.contains("path bound"));
}

#[test]
fn actor_defaults_are_admitted_inputs_without_admitting_body_context_reads() {
    let source = r#"app ActorDefaults
Given
 derive actor_copy(value:user?):user? = value
When
 scenario nullable(value:user?=actor) -> user? by=members
  do return value
 scenario grouped(value:user?=(actor)) -> user? by=members
  do return value
 scenario direct() -> user by=members
  do return actor
 scenario grouped_body() -> user by=members
  do return (actor)
 scenario derived_default(value:user?=actor_copy(actor)) -> user? by=members
  do return value
 scenario body_property() -> bool by=members
  do return actor.email_verified
Then
"#;
    let (db, program) = checked(&[("actor-defaults.can", source)]);
    for name in ["nullable", "grouped"] {
        let value = complete(&program, &format!("ActorDefaults.{name}"));
        origins(&db, value);
        let symbol = program
            .symbols
            .iter()
            .find(|symbol| symbol.canonical == format!("ActorDefaults.{name}"))
            .unwrap();
        let expected = canlang_compiler::analysis::ResolvedType::Nullable(Box::new(
            canlang_compiler::analysis::ResolvedType::Scalar(
                canlang_compiler::analysis::Scalar::User,
            ),
        ));
        assert_eq!(program.types.symbol_results[&symbol.id], Some(expected));
        assert_eq!(value.returns.len(), 1);
        assert!(value.returns[0].dependencies.is_empty());
        assert!(value.returns[0].decisions.is_empty());
    }
    for name in ["direct", "grouped_body", "derived_default", "body_property"] {
        assert!(
            matches!(
                fact(&program, &format!("ActorDefaults.{name}")),
                ScenarioDisclosure::Declined(_)
            ),
            "{name}"
        );
    }
}

#[test]
fn transitions_keep_original_state_and_write_selecting_controls_in_void_returns() {
    let source = r#"app MachineClosure
Given
 Job {state:enum(idle,queued,ready,failed)=idle machine,private_choice:bool}
 policy Job read=members fields=state
When
 scenario branch(job:Job) by=members
  do
   if job.private_choice
    transition job.state idle -> ready
   else
    transition job.state idle -> failed
 scenario ordered(job:Job) by=members
  do
   let target=job
   transition target.state idle -> queued
   transition target.state queued -> ready
 scenario input(job:Job,ready:bool) -> int by=members
  do
   if ready
    transition job.state idle -> ready
   else
    transition job.state idle -> failed
   return 1
 scenario early(job:Job,skip:bool) -> int by=members
  do
   if skip
    return 0
   transition job.state idle -> ready
   return 1
 scenario returned(job:Job) -> int[] by=members
  do
   transition job.state idle -> ready
   return [1,2]
Then
"#;
    let (db, program) = checked(&[("machine-closure.can", source)]);
    for name in ["branch", "ordered", "input", "early", "returned"] {
        origins(&db, complete(&program, &format!("MachineClosure.{name}")));
    }
    let branch = complete(&program, "MachineClosure.branch");
    assert_eq!(branch.returns.len(), 2);
    for path in &branch.returns {
        assert!(
            path.dependencies.iter().any(
                |dep| dep.field_name == "private_choice" && dep.role == DependencyRole::Control
            )
        );
        let old = path
            .dependencies
            .iter()
            .find(|dep| dep.node.kind == canlang_compiler::syntax::SyntaxKind::Transition as u8)
            .unwrap();
        assert_eq!(old.role, DependencyRole::Control);
        assert_eq!(old.model_name, "MachineClosure.Job");
        assert_eq!(old.field_name, "state");
        assert_eq!(old.type_id, "MachineClosure.Job.state");
        assert_eq!(path.decisions.len(), 1);
    }
    let ordered = &complete(&program, "MachineClosure.ordered").returns[0].dependencies;
    assert_eq!(ordered.len(), 2);
    assert_ne!(ordered[0].id, ordered[1].id);
    assert!(ordered[0].node.start < ordered[1].node.start);
    let text = &db.get(ordered[0].node.file).unwrap().text;
    assert!(
        text[ordered[0].node.start as usize..ordered[0].node.end as usize]
            .contains("idle -> queued")
    );
    assert!(
        text[ordered[1].node.start as usize..ordered[1].node.end as usize]
            .contains("queued -> ready")
    );
    let input = complete(&program, "MachineClosure.input");
    assert_eq!(input.returns.len(), 2);
    assert!(
        input
            .returns
            .iter()
            .all(|path| path.dependencies.len() == 1 && path.decisions.len() == 1)
    );
    let early = complete(&program, "MachineClosure.early");
    assert_eq!(early.returns.len(), 2);
    assert_eq!(
        early
            .returns
            .iter()
            .filter(|path| path.dependencies.is_empty())
            .count(),
        1
    );
    assert_eq!(
        complete(&program, "MachineClosure.returned").returns[0]
            .dependencies
            .len(),
        1
    );
}

#[test]
fn transition_support_does_not_admit_other_mutations_or_query_receivers() {
    let source = r#"app MachineRefusals
Given
 Job {state:enum(idle,ready)=idle machine,value:int}
 policy Job read=members
When
 scenario written(job:Job) by=members
  do
   transition job.state idle -> ready
   set job {value=1}
 scenario queried() by=members
  do
   let job=first(Job)
   require job!=null
   transition job.state idle -> ready
 scenario deleted(job:Job) by=members
  do
   transition job.state idle -> ready
   delete job
Then
"#;
    let (_, program) = checked(&[("machine-refusals.can", source)]);
    for name in ["written", "queried", "deleted"] {
        assert!(
            matches!(
                fact(&program, &format!("MachineRefusals.{name}")),
                ScenarioDisclosure::Declined(_)
            ),
            "{name}"
        );
    }
    let source = "app MissingMachine\nGiven\n Job {state:enum(idle,ready)=idle}\nWhen\n scenario bad(job:Job) by=members\n  do transition job.state idle -> ready\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("missing-machine.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    assert!(!diagnostics.is_empty());
    assert!(program.scenario_disclosures().is_empty());
}

#[test]
fn optional_transitions_keep_write_existence_controls_on_no_write_paths() {
    let source = r#"app OptionalWrites
Given
 Job {state:enum(idle,ready)=idle machine,private_choice:bool,choice:enum(write,skip)=skip}
 policy Job read=members fields=state
When
 scenario finish(job:Job) by=members
  do
   if job.private_choice
    transition job.state idle -> ready
 scenario scalar(job:Job) -> int by=members
  do
   if job.private_choice
    transition job.state idle -> ready
   return 7
 scenario explicit_else(job:Job) by=members
  do
   if job.private_choice
    transition job.state idle -> ready
   else
    require true
 scenario matched(job:Job) by=members
  do
   match job.choice
    case write
     transition job.state idle -> ready
    case skip
     require true
 scenario readonly(job:Job) -> int by=members
  do
   if job.private_choice
    require true
   else
    require true
   return 7
Then
"#;
    let (db, program) = checked(&[("optional-writes.can", source)]);
    for (name, selector) in [
        ("finish", "private_choice"),
        ("scalar", "private_choice"),
        ("explicit_else", "private_choice"),
        ("matched", "choice"),
    ] {
        let value = complete(&program, &format!("OptionalWrites.{name}"));
        origins(&db, value);
        assert_eq!(value.returns.len(), 2);
        for path in &value.returns {
            assert_eq!(path.decisions.len(), 1);
            assert!(path.dependencies.iter().any(|read| read.field_name == selector && read.role == DependencyRole::Control));
            let writes = path
                .dependencies
                .iter()
                .filter(|read| {
                    read.node.kind == canlang_compiler::syntax::SyntaxKind::Transition as u8
                })
                .count();
            let selected = matches!(path.decisions[0].choice, DisclosureChoice::Then)
                || matches!(&path.decisions[0].choice, DisclosureChoice::Match(case) if case == "write");
            assert_eq!(writes, usize::from(selected));
            assert_eq!(path.dependencies.len(), if selected { 2 } else { 1 });
        }
    }
    let readonly = complete(&program, "OptionalWrites.readonly");
    assert_eq!(readonly.returns.len(), 2);
    assert!(
        readonly
            .returns
            .iter()
            .all(|path| path.dependencies.is_empty())
    );
}
