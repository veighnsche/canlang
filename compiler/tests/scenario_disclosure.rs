//! Private checked/IR disclosure facts only; no artifact, marker or receipt qualification.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::{
    CheckedScenarioDisclosure, DependencyRole, DisclosureChoice, ScenarioDisclosure,
};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use std::{collections::HashSet, path::Path};

fn checked(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram) {
    let (db, program, _) = checked_with_ir(sources);
    (db, program)
}
fn checked_with_ir(sources: &[(&str, &str)]) -> (SourceDb, CheckedProgram, ir::IrProgram) {
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
    (db, program, lowered)
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
fn whole_decline_preserves_query_absence_and_composite_refusals_with_checked_model_identity() {
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
    let (db, program) = checked(&[("refused.can", source)]);
    for name in ["query", "composite"] {
        assert!(
            matches!(
                fact(&program, &format!("Refused.{name}")),
                ScenarioDisclosure::Declined(_)
            ),
            "{name} must decline the entire closure"
        );
    }
    let model = complete(&program, "Refused.model");
    assert_eq!(model.returns.len(), 1);
    assert_eq!(model.returns[0].dependencies.len(), 1);
    assert_eq!(model.returns[0].dependencies[0].field_name, "id");
    let called = complete(&program, "Refused.called");
    assert_eq!(called.effects.len(), 1);
    assert!(matches!(&called.effects[0].kind,
        canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind::Call {input_keys,..} if input_keys.is_empty()));
    let changed = complete(&program, "Refused.changed");
    assert_eq!(changed.effects.len(), 1);
    assert!(matches!(
        changed.effects[0].kind,
        canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind::Set { .. }
    ));
    assert!(
        changed.returns[0].dependencies.is_empty(),
        "a checked constant assignment retains its effect proof without inventing a stored read"
    );
    let absent = complete(&program, "Refused.absent");
    assert_eq!(absent.source.path, "refused.can");
    assert_eq!(absent.source.module, "Refused");
    assert_eq!(absent.source.sha256, sha256_hex(source.as_bytes()));
    assert_eq!(absent.returns.len(), 2);
    origins(&db, absent);
    let empty = absent
        .returns
        .iter()
        .find(|returned| returned.dependencies.is_empty())
        .expect("absent Else branch carries no stored read");
    assert!(empty.decisions.iter().any(|decision| decision.choice
        == canlang_compiler::analysis::scenario_disclosure::DisclosureChoice::Else));
    assert!(empty.influences.is_empty());
    let present = absent
        .returns
        .iter()
        .find(|returned| !returned.dependencies.is_empty())
        .expect("present Then branch reads the original title");
    assert!(present.decisions.iter().any(|decision| decision.choice
        == canlang_compiler::analysis::scenario_disclosure::DisclosureChoice::Then));
    assert_eq!(present.dependencies.len(), 1);
    assert_eq!(present.dependencies[0].field_name, "title");
    assert_eq!(present.dependencies[0].role, DependencyRole::Data);
    assert!(present.influences.is_empty());
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
fn nullable_model_and_scalar_presence_keep_original_reference_and_field_provenance() {
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
        let value = complete(&program, &format!("Presence.{name}"));
        assert!(!value.returns.is_empty());
        assert!(value.returns.iter().all(|returned| {
            returned
                .dependencies
                .iter()
                .all(|read| read.field_name == "id" && read.model_name == "Presence.Item")
        }));
        assert!(
            value
                .returns
                .iter()
                .all(|returned| returned.influences.is_empty()),
            "admitted nullable identity does not invent query or absent-row influence"
        );
    }
    let value = complete(&program, "Presence.scalar");
    assert_eq!(value.returns.len(), 1);
    assert_eq!(value.returns[0].dependencies.len(), 1);
    assert_eq!(value.returns[0].dependencies[0].type_id, "text?");
}

#[test]
fn stored_email_and_nullable_file_presence_preserve_proof_while_binary_and_secret_reads_decline() {
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
    let address = complete(&program, "StoredTypes.address");
    assert_eq!(address.returns.len(), 1);
    assert_eq!(address.returns[0].dependencies.len(), 1);
    assert_eq!(address.returns[0].dependencies[0].field_name, "address");
    assert_eq!(address.returns[0].dependencies[0].type_id, "email");
    let attachment = complete(&program, "StoredTypes.attachment");
    assert_eq!(attachment.returns.len(), 1);
    assert_eq!(attachment.returns[0].dependencies.len(), 1);
    assert_eq!(
        attachment.returns[0].dependencies[0].field_name,
        "attachment"
    );
    assert_eq!(attachment.returns[0].dependencies[0].type_id, "file?");
    for name in ["content", "private_value"] {
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
fn repeated_analysis_keeps_distinct_lexical_value_provenance() {
    let source = "app Reuse\nGiven\n Item {optional:int?,value:int}\n policy Item read=members\nWhen\n scenario probe(item:Item,other:Item,a:bool,b:bool) -> int[] by=members\n  require a and b\n  do\n   let first=item.optional ?? other.value\n   let second=other.optional ?? item.value\n   return [first,second]\nThen\n";
    let (db, program) = checked(&[("reuse.can", source)]);
    let proof = complete(&program, "Reuse.probe");
    assert_eq!(proof.returns.len(), 8);
    origins(&db, proof);
    for path in &proof.returns {
        let reads = path
            .dependencies
            .iter()
            .map(|read| {
                db.get(read.node.file).unwrap().text
                    [read.node.start as usize..read.node.end as usize]
                    .trim()
            })
            .collect::<HashSet<_>>();
        assert!(reads.contains("item.optional"));
        assert!(reads.contains("other.optional"));
        assert_eq!(
            reads.contains("other.value"),
            path.decisions[1].choice == DisclosureChoice::RhsEvaluated
        );
        assert_eq!(
            reads.contains("item.value"),
            path.decisions[2].choice == DisclosureChoice::RhsEvaluated
        );
    }
}

#[test]
fn actor_defaults_identity_and_checked_properties_keep_original_context_provenance() {
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
        let value = complete(&program, &format!("ActorDefaults.{name}"));
        origins(&db, value);
        assert!(!value.returns.is_empty());
        assert!(
            value
                .returns
                .iter()
                .all(|returned| returned.dependencies.is_empty()),
            "caller actor context is not a persisted model read"
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
fn transition_and_scalar_set_support_do_not_admit_delete_or_query_receivers() {
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
    for name in ["queried", "deleted"] {
        assert!(
            matches!(
                fact(&program, &format!("MachineRefusals.{name}")),
                ScenarioDisclosure::Declined(_)
            ),
            "{name}"
        );
    }
    let written = complete(&program, "MachineRefusals.written");
    assert_eq!(written.effects.len(), 1);
    assert!(matches!(
        written.effects[0].kind,
        canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind::Set { .. }
    ));
    assert_eq!(written.returns[0].dependencies.len(), 1);
    assert_eq!(written.returns[0].dependencies[0].field_name, "state");
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

#[test]
fn static_unused_scalar_calls_keep_authored_inputs_and_effect_selectors() {
    use canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind;
    let source = "app Calls\nGiven\n Item {value:int,private:bool}\n policy Item read=members fields=value\nWhen\n scenario child(first:int,second:int) -> int by=members\n  do return first+second\n scenario parent(item:Item,accept:bool) -> int by=members\n  do\n   if item.private\n    call child {second=item.value,first=1}\n   require accept\n   return 7\nThen\n";
    let (_, program) = checked(&[("calls.can", source)]);
    let parent = complete(&program, "Calls.parent");
    let child = program
        .symbols
        .iter()
        .find(|item| item.canonical == "Calls.child")
        .unwrap();
    assert_eq!(parent.effects.len(), 1);
    assert!(
        matches!(&parent.effects[0].kind, DisclosureEffectKind::Call {operation,input_keys}
        if *operation == child.id && input_keys == &["second", "first"])
    );
    assert_eq!(parent.effects[0].source, parent.source);
    assert_eq!(parent.returns.len(), 2);
    for path in &parent.returns {
        assert!(
            path.dependencies
                .iter()
                .any(|read| read.field_name == "private" && read.role == DependencyRole::Control)
        );
    }
    let called = parent
        .returns
        .iter()
        .find(|path| {
            path.dependencies
                .iter()
                .any(|read| read.field_name == "value")
        })
        .unwrap();
    assert!(
        called
            .intrinsics
            .iter()
            .any(|input| input.role == DependencyRole::Control)
    );
}

#[test]
fn static_call_preparation_resolves_children_independently_of_source_order() {
    use canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind;
    let source = "app Calls\nGiven\nWhen\n scenario parent(value:int) by=members\n  do call middle {value}\n scenario middle(value:int) by=members\n  do call child {value}\n scenario child(value:int) -> int by=members\n  do return value\nThen\n";
    let (_, program) = checked(&[("calls.can", source)]);
    for name in ["Calls.parent", "Calls.middle"] {
        let plan = complete(&program, name);
        assert!(
            matches!(&plan.effects[0].kind, DisclosureEffectKind::Call {input_keys,..} if input_keys == &["value"])
        );
        assert_eq!(plan.returns.len(), 1);
        assert_eq!(plan.returns[0].intrinsics.len(), 1);
    }
}

#[test]
fn static_call_preparation_declines_bound_read_crud_and_nullable_reference_profiles() {
    for source in [
        "app Calls\nGiven\nWhen\n scenario child(value:int) -> int by=members\n  do return value\n scenario parent(value:int) by=members\n  do call child {value} as result\nThen\n",
        "app Calls\nGiven\nWhen\n scenario child(value:int) read=true -> int by=members\n  do return value\n scenario parent(value:int) by=members\n  do call child {value}\nThen\n",
        "app Calls\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n crud Item by=members fields=value\n scenario parent(value:int) by=members\n  do call Item.create {value}\nThen\n",
        "app Calls\nGiven\n Item {value:int}\n policy Item read=members\nWhen\n scenario child(item:Item?) -> int by=members\n  do return 0\n scenario parent(item:Item?) by=members\n  do call child {item}\nThen\n",
    ] {
        let (_, program) = checked(&[("calls.can", source)]);
        assert!(
            matches!(
                fact(&program, "Calls.parent"),
                ScenarioDisclosure::Declined(_)
            ),
            "{source}"
        );
    }
}

fn finite_query_parent_source(parameters: &str, body: &str, parent_first: bool) -> String {
    let child = " scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members\n  require count(targets)>0\n  do\n   let visible=Task as task where task in targets and task.location==location\n   require count(visible)==count(targets)\n   return visible as task select Fact {task,version=task.version,title=task.title,description=task.description,due=task.due,priority=task.priority,done=task.done}\n";
    let parent = format!(" scenario parent({parameters}) -> int by=members\n  do\n{body}\n");
    let declarations = if parent_first {
        format!("{parent}{child}")
    } else {
        format!("{child}{parent}")
    };
    format!(
        "app QueryCalls\nGiven\n Location {{name:text}}\n Task {{location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}}\n contract Scope {{targets:Task[]! min=1 max=10}}\n contract Fact {{task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}}\n Holder {{location:Location,targets:Scope.targets}}\n fixture site=Location {{name=\"Site\"}}\n policy Location read=members\n policy Task read=members\n policy Holder read=members\nWhen\n{declarations}Then\n"
    )
}

#[test]
fn query_child_preparation_proves_original_inputs_and_unused_binding_in_source_order() {
    use canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind;
    for parent_first in [false, true] {
        for (inputs, keys) in [
            ("location,targets", vec!["location", "targets"]),
            ("targets,location", vec!["targets", "location"]),
        ] {
            let source = finite_query_parent_source(
                "location:Location,targets:Scope.targets",
                &format!("   call context {{{inputs}}} as facts\n   return 1"),
                parent_first,
            );
            let (db, program) = checked(&[("query-call.can", &source)]);
            let child = complete(&program, "QueryCalls.context");
            assert_eq!(child.returns[0].influences.len(), 4);
            let parent = complete(&program, "QueryCalls.parent");
            origins(&db, parent);
            assert_eq!(parent.effects.len(), 1);
            assert!(
                matches!(&parent.effects[0].kind, DisclosureEffectKind::Call {input_keys,..}
                if input_keys.iter().map(String::as_str).collect::<Vec<_>>() == keys)
            );
            assert!(parent.returns[0].dependencies.is_empty());
            assert!(parent.returns[0].intrinsics.is_empty());
            assert!(parent.returns[0].influences.is_empty());
        }
    }
}

#[test]
fn query_parent_full_emission_requires_immutable_prepared_child_receipt() {
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call context {location,targets} as facts\n   require count(facts)==2\n   return count(facts)",
        true,
    );
    let mut db = SourceDb::new();
    let file = db.add("query-call.can".into(), source);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let child = complete(&program, "QueryCalls.context");
    let parent = complete(&program, "QueryCalls.parent");
    assert_eq!(parent.effects.len(), 1);
    let queries = child
        .source_facts
        .as_ref()
        .unwrap()
        .queries
        .as_ref()
        .unwrap();
    assert_eq!(queries.len(), 1);
    let query = &queries[0];
    assert_eq!(child.returns[0].id, query.return_id());
    assert_eq!(child.returns[0].influences, query.influences);

    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("query-parent-emission", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: serde_json::Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    for name in ["QueryCalls.context", "QueryCalls.parent"] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert!(
            operation["result"].get("disclosure").is_some(),
            "{name} lost its actual prepared receipt"
        );
        assert!(matches!(
            fact(&program, name),
            ScenarioDisclosure::Complete(_)
        ));
    }
    let modules = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(modules.contains("export function canScenarioQuerySources()"));
    assert!(modules.contains(&query.id));
    assert!(modules.contains(&query.return_id()));
    for dependency in &query.dependencies {
        assert!(modules.contains(&dependency.id));
    }
    for helper in [
        "executeScenarioReceiptQuery",
        "observeScenarioReceiptQueryDependency",
        "bindScenarioReceiptQueryResult",
        "selectScenarioReceiptReturn",
        "invokeScenarioReceiptCall",
    ] {
        assert!(
            modules.contains(helper),
            "actual prepared child omitted {helper}"
        );
    }
    // Raw IR carries the checked Complete tag but cannot provide the immutable
    // fresh receipt map constructed by full emission.
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let raw = canlang_compiler::codegen::js::emit_program_with_native_source_receipts(
        &lowered, true, &db,
    );
    assert!(
        raw.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message.contains("QueryCalls.context")),
        "{:?}",
        raw.diagnostics
    );
    for name in ["QueryCalls.context", "QueryCalls.parent"] {
        let operation = raw
            .operations
            .iter()
            .find(|operation| operation.name == name)
            .unwrap();
        assert!(operation.disclosure.is_none(), "raw IR activated {name}");
    }
    for helper in [
        "executeScenarioReceiptQuery",
        "observeScenarioReceiptQueryDependency",
        "bindScenarioReceiptQueryResult",
        "selectScenarioReceiptReturn",
        "invokeScenarioReceiptCall",
    ] {
        assert!(!raw.entry.js.contains(helper), "raw IR activated {helper}");
    }
}

#[test]
fn bound_contract_collections_keep_complete_child_provenance_without_parent_row_observations() {
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call context {location,targets} as facts\n   require any(facts as current,current.done)\n   require all(facts as current,current.version>=1 and current.task==current.task)\n   require any(facts as current,current.title==\"second\" or not current.done)\n   require all(facts as current,true)\n   return count(facts)",
        true,
    );
    let (db, program, lowered) = checked_with_ir(&[("query-contract-collections.can", &source)]);
    let child = complete(&program, "QueryCalls.context");
    assert_eq!(child.returns[0].influences.len(), 4);
    let parent = complete(&program, "QueryCalls.parent");
    origins(&db, parent);
    assert_eq!(parent.effects.len(), 1);
    assert_eq!(parent.returns.len(), 1);
    let returned = &parent.returns[0];
    assert!(
        returned.dependencies.is_empty(),
        "child fields are not fabricated parent row reads"
    );
    assert!(returned.intrinsics.is_empty());
    assert!(returned.influences.is_empty());
    assert!(
        returned.decisions.is_empty(),
        "per-element lazy choices are not once-per-parent markers"
    );
    assert_eq!(program.types.checked_contract_collection_calls.len(), 4);
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "QueryCalls.parent")
        .unwrap();
    let ir::IrItemKind::Scenario { effects, .. } = &owner.kind else {
        panic!("actual parent");
    };
    let calls = effects
        .iter()
        .filter_map(|statement| {
            let ir::IrStmt::Require { cond, .. } = statement else {
                return None;
            };
            let ir::IrExpr::Call { args, .. } = &cond.expr else {
                return None;
            };
            let ir::IrExpr::Query(query) = &args[0].expr else {
                return None;
            };
            query.contract_collection_call.as_deref()
        })
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 4);
    for call in calls {
        assert_eq!(
            program
                .types
                .checked_contract_collection_calls
                .get(&call.node),
            Some(call)
        );
        assert!(
            !program
                .types
                .checked_collection_calls
                .contains_key(&call.node),
            "contract values never become stored model proof"
        );
    }
}

#[test]
fn bound_contract_collection_source_refuses_unproved_domains_and_predicate_reads() {
    // A declined source may also have an ordinary async-predicate lowering
    // refusal. Inspect checked closure before IR rather than hiding that error.
    let check_source = |source: &str| {
        let mut db = SourceDb::new();
        let file = db.add("query-contract-refusal.can".into(), source.into());
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        program
    };
    for body in [
        "   call context {location,targets} as facts\n   let copied=facts\n   require any(copied as current,current.done)\n   return 1",
        "   call context {location,targets} as facts\n   require any(facts as current select current,current.done)\n   return 1",
        "   call context {location,targets} as facts\n   require any(facts as current,identity(current.done))\n   return 1",
        "   call context {location,targets} as facts\n   require any(facts as current,current.task.done)\n   return 1",
        "   call context {location,targets} as facts\n   require any(facts as current,outer.done)\n   return 1",
        "   call context {location,targets} as facts\n   require any(facts as current,actor==actor)\n   return 1",
    ] {
        let source = finite_query_parent_source(
            "location:Location,targets:Scope.targets,outer:Task",
            body,
            false,
        )
        .replace(
            "Given\n",
            "Given\n derive identity(value:bool):bool=value\n",
        );
        let program = check_source(&source);
        complete(&program, "QueryCalls.context");
        assert!(
            matches!(
                fact(&program, "QueryCalls.parent"),
                ScenarioDisclosure::Declined(_)
            ),
            "{source}"
        );
    }
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call context {location,targets} as facts\n   require all(facts as current,current.version>=1)\n   return 1",
        false,
    ).replace("count(visible)==count(targets)", "count(visible)>=count(targets)");
    let program = check_source(&source);
    assert!(matches!(
        fact(&program, "QueryCalls.context"),
        ScenarioDisclosure::Declined(_)
    ));
    assert!(matches!(
        fact(&program, "QueryCalls.parent"),
        ScenarioDisclosure::Declined(_)
    ));
}

#[test]
fn bound_contract_collection_publication_requires_exact_fresh_alias_call_and_predicate_proof() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call context {location,targets} as facts\n   require any(facts as current,current.version>=1 and current.task==current.task)\n   return count(facts)",
        false,
    );
    let mut db = SourceDb::new();
    let file = db.add("query-contract-publication.can".into(), source);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    complete(&program, "QueryCalls.parent");
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "QueryCalls.parent")
        .unwrap()
        .id;
    let publish = |lowered: &ir::IrProgram| {
        serialize_decision_sources(
            &program,
            lowered,
            &lowered.items[owner.0 as usize],
            &db,
            catalog.as_ref(),
        )
    };
    assert!(
        publish(&lowered).is_some(),
        "genuine source/IR correspondence publishes"
    );
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("query-contract-publication", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: serde_json::Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    let parent = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "QueryCalls.parent")
        .unwrap();
    assert!(
        parent["result"].get("disclosure").is_some(),
        "actual native prepared parent is published"
    );
    for corruption in 0..4 {
        let mut changed = lowered.clone();
        let ir::IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("parent");
        };
        let ir::IrStmt::Call {
            target,
            inputs,
            binding,
            result,
            ..
        } = &mut effects[0]
        else {
            panic!("original child call");
        };
        match corruption {
            0 => *binding = Some("copied".into()),
            1 => *result = None,
            2 => {
                let ir::IrEffectCallTarget::Operation { operation, .. } = target else {
                    panic!("static checked child");
                };
                *operation = owner;
            }
            3 => {
                let ir::IrExpr::Object(entries) = &mut inputs.expr else {
                    panic!("authored inputs");
                };
                entries[0].1.expr = ir::IrExpr::Int(7);
            }
            _ => unreachable!(),
        }
        assert!(
            publish(&changed).is_none(),
            "forged original child call {corruption} published"
        );
    }
    for corruption in 0..6 {
        let mut changed = lowered.clone();
        let ir::IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("parent");
        };
        let ir::IrStmt::Require { cond, .. } = &mut effects[1] else {
            panic!("require");
        };
        let ir::IrExpr::Call { args, .. } = &mut cond.expr else {
            panic!("collection call");
        };
        let ir::IrExpr::Query(query) = &mut args[0].expr else {
            panic!("value query");
        };
        if corruption == 0 {
            query.contract_collection_call = None;
        } else {
            let proof = query.contract_collection_call.as_mut().unwrap();
            match corruption {
                1 => proof.call = Some(proof.alias),
                2 => proof.alias = proof.domain,
                3 => proof.domain = proof.query,
                4 => proof.slots.swap(0, 1),
                5 => proof.predicate.node = proof.domain,
                _ => unreachable!(),
            }
        }
        assert!(
            publish(&changed).is_none(),
            "forged optional query proof {corruption} published"
        );
    }
}

#[test]
fn query_child_preparation_refuses_nonoriginal_inputs_and_unproved_result_use() {
    for (parameters, body) in [
        (
            "location:Location,targets:Scope.targets",
            "   let copied=targets\n   call context {location,targets=copied} as facts\n   return 1",
        ),
        (
            "holder:Holder",
            "   call context {location=holder.location,targets=holder.targets} as facts\n   return 1",
        ),
        (
            "location:Location,task:Task",
            "   call context {location,targets=[task]} as facts\n   return 1",
        ),
        (
            // Ordinary array parameters support literal empty defaults. The
            // owning positive bounds govern admission; the producer refuses
            // this defaulted operand before claiming original input provenance.
            "location:Location,targets:Scope.targets=[]",
            "   call context {location,targets} as facts\n   return 1",
        ),
        (
            "location:Location,targets:Scope.targets",
            "   call context {location,targets} as facts\n   require first(facts)!=null\n   return 1",
        ),
        (
            "location:Location,targets:Scope.targets",
            "   call context {location,targets} as facts\n   let copied=facts\n   return 1",
        ),
        (
            "location:Location,targets:Task[]",
            "   call context {location,targets} as facts\n   return 1",
        ),
    ] {
        let source = finite_query_parent_source(parameters, body, false);
        let (_, program) = checked(&[("query-call.can", &source)]);
        assert!(
            matches!(
                fact(&program, "QueryCalls.parent"),
                ScenarioDisclosure::Declined(_)
            ),
            "{source}"
        );
    }
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call context {location,targets} as facts\n   return 1",
        false,
    )
    .replace(
        "count(visible)==count(targets)",
        "count(visible)>=count(targets)",
    );
    let (_, program) = checked(&[("query-call.can", &source)]);
    assert!(matches!(
        fact(&program, "QueryCalls.context"),
        ScenarioDisclosure::Declined(_)
    ));
    assert!(matches!(
        fact(&program, "QueryCalls.parent"),
        ScenarioDisclosure::Declined(_)
    ));
}

#[test]
fn query_parent_self_call_is_rejected_before_disclosure_admission() {
    let source = finite_query_parent_source(
        "location:Location,targets:Scope.targets",
        "   call parent {location,targets}\n   call context {location,targets} as facts\n   return 1",
        false,
    );
    let mut db = SourceDb::new();
    let file = db.add("query-call-cycle.can".into(), source);
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (_, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3005"),
        "{diagnostics:?}"
    );
}

#[test]
fn supplied_reference_array_loop_retains_empty_nonempty_and_exact_ir_correspondence() {
    use canlang_compiler::codegen::{
        ir::{IrExpr, IrItemKind, IrStmt},
        js,
    };
    let source = include_str!("../../tests/integration/can-dev-server/NativeRefArrays.can");
    let (db, program, lowered) = checked_with_ir(&[("NativeRefArrays.can", source)]);
    let closure = complete(&program, "NativeRefArrays.step");
    origins(&db, closure);
    assert_eq!(closure.returns.len(), 2);
    let empty = closure
        .returns
        .iter()
        .find(|path| path.dependencies.is_empty())
        .unwrap();
    let nonempty = closure
        .returns
        .iter()
        .find(|path| !path.dependencies.is_empty())
        .unwrap();
    assert_eq!(empty.decisions.len(), 1);
    assert_eq!(nonempty.decisions.len(), 1);
    assert_eq!(empty.decisions[0].choice, DisclosureChoice::Else);
    assert_eq!(nonempty.decisions[0].choice, DisclosureChoice::Then);
    assert_eq!(empty.decisions[0].node, nonempty.decisions[0].node);
    assert_eq!(nonempty.dependencies.len(), 1);
    assert_eq!(nonempty.dependencies[0].model_name, "NativeRefArrays.Item");
    assert_eq!(nonempty.dependencies[0].field_name, "value");
    assert_eq!(nonempty.dependencies[0].role, DependencyRole::Data);
    assert!(empty.intrinsics.is_empty());
    assert!(nonempty.intrinsics.is_empty());
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "NativeRefArrays.step")
        .unwrap()
        .id;
    let emit = |ir: &ir::IrProgram| js::emit_program_with_native_source_receipts(ir, true, &db);
    assert!(
        emit(&lowered)
            .operations
            .iter()
            .find(|operation| operation.name == "NativeRefArrays.step")
            .unwrap()
            .disclosure
            .is_some()
    );
    for corruption in 0..9 {
        let mut changed = lowered.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            panic!("scenario")
        };
        let IrStmt::For {
            item,
            domain,
            limit,
            body,
            ..
        } = &mut effects[0]
        else {
            panic!("actual supplied array loop")
        };
        match corruption {
            0 => limit.as_mut().unwrap().expr = IrExpr::Int(4),
            1 => *item = "foreign".into(),
            2 => domain.span.start += 1,
            3 => {
                let IrStmt::Set { changes, .. } = &mut body[0] else {
                    panic!("actual Set")
                };
                let IrExpr::Object(entries) = &mut changes.expr else {
                    panic!("actual changes object")
                };
                entries[0].0 = "foreign".into();
            }
            4 => domain.expr = IrExpr::Name("foreign".into()),
            5 => body.push(body[0].clone()),
            6 => body.clear(),
            7 => {
                let IrStmt::Set { record, .. } = &mut body[0] else {
                    panic!("actual Set")
                };
                record.expr = IrExpr::Name("foreign".into());
            }
            _ => {
                let IrStmt::Set { changes, .. } = &mut body[0] else {
                    panic!("actual Set")
                };
                let IrExpr::Object(entries) = &mut changes.expr else {
                    panic!("actual changes object")
                };
                let IrExpr::Binary { left, .. } = &mut entries[0].1.expr else {
                    panic!("actual arithmetic")
                };
                let IrExpr::Member { base, .. } = &mut left.expr else {
                    panic!("actual stored read")
                };
                base.expr = IrExpr::Name("foreign".into());
            }
        }
        assert!(
            emit(&changed)
                .operations
                .iter()
                .find(|operation| operation.name == "NativeRefArrays.step")
                .unwrap()
                .disclosure
                .is_none(),
            "source/IR skew {corruption} cannot publish a native recipe"
        );
    }
    for body in [
        "for item in Item limit=3\n    set item {value=item.value+1}",
        "for item in items limit=3\n    if item.value>0\n     set item {value=item.value+1}",
        "for item in items limit=3\n    for other in items limit=3\n     set other {value=other.value+1}",
    ] {
        let refused = source.replace(
            "for item in items limit=3\n    set item {value=item.value+1}",
            body,
        );
        let (_, program) = checked(&[("NativeRefArrays.can", &refused)]);
        assert!(
            matches!(
                fact(&program, "NativeRefArrays.step"),
                ScenarioDisclosure::Declined(_)
            ),
            "general loop profile remains refused: {body}"
        );
    }
}

#[test]
fn original_file_attachment_has_assignment_only_proof_and_native_void_disclosure() {
    use canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind;
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::{
        ir::{IrExpr, IrItemKind, IrStmt, IrType},
        js,
    };
    let source = include_str!("../../packages/cloudflare/test/fixtures/typed-file-journey.can");
    let (db, program, lowered) = checked_with_ir(&[("typed-file-journey.can", source)]);
    let closure = complete(&program, "TypedFileJourney.attach");
    origins(&db, closure);
    assert_eq!(closure.effects.len(), 1);
    assert_eq!(closure.returns.len(), 1);
    let DisclosureEffectKind::Set {
        fields,
        file_inputs,
        ..
    } = &closure.effects[0].kind
    else {
        panic!("original attachment Set");
    };
    assert_eq!(fields.len(), 1);
    assert_eq!(file_inputs.len(), 1);
    let input = &file_inputs[0];
    assert_eq!(input.field, fields[0]);
    assert_eq!(
        program.symbols[input.field.0 as usize].canonical,
        "TypedFileJourney.Entry.attachment"
    );
    assert_eq!(
        program.symbols[input.parameter.0 as usize].canonical,
        "TypedFileJourney.attach.attachment"
    );
    assert_eq!(
        &source[input.value.start as usize..input.value.end as usize],
        "attachment"
    );
    assert_eq!(
        program.types.symbol_types.get(&input.parameter),
        Some(&ResolvedType::Scalar(Scalar::File))
    );
    assert!(
        closure.returns[0]
            .dependencies
            .iter()
            .all(|dependency| dependency.type_id != "file"),
        "assignment proof does not manufacture finalized File observations"
    );
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "TypedFileJourney.attach")
        .unwrap()
        .id;
    let IrItemKind::Scenario {
        effects, result, ..
    } = &lowered.items[owner.0 as usize].kind
    else {
        panic!("actual attachment scenario");
    };
    assert!(result.is_none());
    assert!(matches!(
        effects.as_slice(),
        [IrStmt::Set { .. }, IrStmt::Require { .. }]
    ));
    let emit = |ir: &ir::IrProgram| js::emit_program_with_native_source_receipts(ir, true, &db);
    let native = emit(&lowered);
    let operation = native
        .operations
        .iter()
        .find(|operation| operation.name == "TypedFileJourney.attach")
        .unwrap();
    assert_eq!(operation.result.as_deref(), Some("void"));
    assert!(operation.disclosure.is_some());
    assert!(
        native.entry.js.contains("await set("),
        "original owning Set is awaited"
    );

    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("typed-file-journey", "1.0", 1);
    result.complete = true;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    // Full emission consumes this exact checked source cohort, not a substitute
    // File observation or a separately constructed runtime context.
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(input.value.file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (fresh, diagnostics) = check_program(&db, program.checked_files(), catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        &fresh,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: serde_json::Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "TypedFileJourney.attach")
        .unwrap();
    assert_eq!(operation["result"]["type"], "void");
    assert!(operation["result"].get("disclosure").is_some());

    for corruption in 0..10 {
        let mut changed = lowered.clone();
        match corruption {
            0..=3 => {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!("actual scenario");
                };
                let IrStmt::Set { changes, .. } = &mut effects[0] else {
                    panic!("actual Set");
                };
                let IrExpr::Object(entries) = &mut changes.expr else {
                    panic!("authored assignment");
                };
                match corruption {
                    0 => entries[0].1.expr = IrExpr::Name("accept".into()),
                    1 => entries[0].1.ty = ResolvedType::Scalar(Scalar::Bool),
                    2 => entries[0].1.span.start += 1,
                    3 => entries[0].0 = "label".into(),
                    _ => unreachable!(),
                }
            }
            4..=6 => {
                let IrItemKind::Field {
                    ty,
                    owner: field_owner,
                    ..
                } = &mut changed.items[input.field.0 as usize].kind
                else {
                    panic!("owning attachment field");
                };
                match corruption {
                    4 => {
                        *ty = IrType::Known(ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
                            Scalar::Text,
                        ))))
                    }
                    5 => *field_owner = owner,
                    6 => changed.items[input.field.0 as usize].name = "label".into(),
                    _ => unreachable!(),
                }
            }
            _ => {
                let ScenarioDisclosure::Complete(closure) =
                    changed.scenario_disclosures.get_mut(&owner).unwrap()
                else {
                    panic!("private checked closure");
                };
                let DisclosureEffectKind::Set { file_inputs, .. } = &mut closure.effects[0].kind
                else {
                    panic!("private assignment proof");
                };
                match corruption {
                    7 => file_inputs[0].parameter = owner,
                    8 => file_inputs[0].field = owner,
                    9 => file_inputs[0].value.start += 1,
                    _ => unreachable!(),
                }
            }
        }
        assert!(
            emit(&changed)
                .operations
                .iter()
                .find(|operation| operation.name == "TypedFileJourney.attach")
                .unwrap()
                .disclosure
                .is_none(),
            "File source/IR input or schema skew {corruption} must refuse native publication"
        );
    }
}

#[test]
fn file_assignment_retains_unused_staged_alias_and_refuses_unsupported_file_flows() {
    let original = include_str!("../../packages/cloudflare/test/fixtures/typed-file-journey.can");
    let body = "   set entry {attachment=attachment}\n   require accept";
    let mut cases = vec![
        original.replace(body, "   let copied=attachment\n   set entry {attachment=copied}\n   require accept"),
        original.replace("Given\n", "Given\n derive identity(value:file):file=value\n")
            .replace("attachment=attachment", "attachment=identity(attachment)"),
        original.replace("attachment:file,accept", "attachment:file?,accept"),
        original.replace(body, "   set entry {attachment=attachment}\n   let observed=entry.attachment\n   require accept"),
        original.replace(") by=owner\n  do", ") -> file by=owner\n  do")
            .replace(body, "   set entry {attachment=attachment}\n   require accept\n   return attachment"),
        original.replace(body, "   let files=[attachment]\n   set entry {attachment=attachment}\n   require accept"),
        original.replace("attachment:file,accept", "attachment:file,attachments:file[],accept")
            .replace(body, "   for supplied in attachments limit=3\n    set entry {attachment=supplied}\n   require accept"),
    ];
    cases.push(original.replace("When\n", "When\n scenario child(attachment:file) by=owner\n  do require true\n")
        .replace(body, "   set entry {attachment=attachment}\n   call child {attachment}\n   require accept"));
    for (case, source) in cases.into_iter().enumerate() {
        let mut db = SourceDb::new();
        let file = db.add("file-profile-refusal.can".into(), source.clone());
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(
            diagnostics.is_empty(),
            "valid unsupported source {source}\n{diagnostics:?}"
        );
        if case == 3 {
            let value = complete(&program, "TypedFileJourney.attach");
            assert!(
                value
                    .returns
                    .iter()
                    .all(|returned| returned.dependencies.is_empty()),
                "unused staged File alias creates no persisted read or File disclosure"
            );
            assert_eq!(value.effects.len(), 1);
        } else {
            assert!(
                matches!(
                    fact(&program, "TypedFileJourney.attach"),
                    ScenarioDisclosure::Declined(_)
                ),
                "unsupported File flow case {case} must decline"
            );
        }
    }
}

#[test]
fn file_assignment_paired_proof_and_value_corruption_still_requires_original_source_binding() {
    use canlang_compiler::analysis::scenario_disclosure::DisclosureEffectKind;
    use canlang_compiler::codegen::{
        ir::{IrExpr, IrItemKind, IrStmt},
        js,
    };
    let source = include_str!("../../packages/cloudflare/test/fixtures/typed-file-journey.can")
        .replace(
            "attachment:file,accept",
            "attachment:file,second:file,accept",
        );
    let (db, program, lowered) = checked_with_ir(&[("file-paired-binding.can", &source)]);
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "TypedFileJourney.attach")
        .unwrap()
        .id;
    let second = program
        .symbols
        .iter()
        .find(|symbol| symbol.canonical == "TypedFileJourney.attach.second")
        .unwrap()
        .id;
    let disclosed = |ir: &ir::IrProgram, db: &SourceDb| {
        js::emit_program_with_native_source_receipts(ir, true, db)
            .operations
            .iter()
            .find(|operation| operation.name == "TypedFileJourney.attach")
            .unwrap()
            .disclosure
            .is_some()
    };
    assert!(
        disclosed(&lowered, &db),
        "original required File assignment qualifies"
    );

    let mut changed = lowered.clone();
    let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
        panic!("original attachment scenario");
    };
    let IrStmt::Set { changes, .. } = &mut effects[0] else {
        panic!("original Set");
    };
    let IrExpr::Object(entries) = &mut changes.expr else {
        panic!("original inputs");
    };
    let original_span = entries[0].1.span;
    entries[0].1.expr = IrExpr::Name("second".into());
    let ScenarioDisclosure::Complete(closure) =
        changed.scenario_disclosures.get_mut(&owner).unwrap()
    else {
        panic!("immutable checked closure");
    };
    let DisclosureEffectKind::Set { file_inputs, .. } = &mut closure.effects[0].kind else {
        panic!("original File assignment proof");
    };
    assert_eq!(file_inputs.len(), 1);
    let original_value = file_inputs[0].value;
    file_inputs[0].parameter = second;
    assert_eq!(file_inputs[0].value, original_value);
    assert_eq!(
        (
            original_value.file,
            original_value.start,
            original_value.end
        ),
        (original_span.file, original_span.start, original_span.end)
    );
    assert!(
        !disclosed(&changed, &db),
        "agreeing forged File value and parameter cannot replace the original source binding"
    );

    assert!(
        !disclosed(&lowered, &SourceDb::new()),
        "missing original source bytes refuse native publication"
    );
    let mut changed_db = SourceDb::new();
    changed_db.add(
        "file-paired-binding.can".into(),
        source.replace("attachment=attachment", "attachment=second"),
    );
    assert!(
        !disclosed(&lowered, &changed_db),
        "changed source bytes cannot qualify the previous checked assignment"
    );
}

fn stored_input_query_parent_source() -> String {
    let input = include_str!("../../draft/apps/CanWorkbench/CanWorkbench.can")
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("export contract Input "))
        .expect("actual owning Workbench Input declaration");
    finite_query_parent_source(
        "step:Step,location:Location,targets:Scope.targets",
        "   call context {location,targets} as fresh\n   require count(fresh)==count(step.input.facts) and all(step.input.facts as old,any(fresh as current,current.task==old.task and current.version==old.version))\n   return count(step.input.facts)",
        false,
    ).replace(" Holder {", &format!(" contract Input {input}\n Step {{input:Input}}\n policy Step read=members\n Holder {{"))
}

#[test]
fn stored_input_fact_comparison_retains_whole_owner_and_complete_query_child() {
    use canlang_compiler::analysis::{ResolvedType, Scalar};
    use canlang_compiler::codegen::{js, scenario_decisions::serialize_decision_sources};
    let source = stored_input_query_parent_source();
    let mut db = SourceDb::new();
    let file = db.add("stored-input-facts.can".into(), source.clone());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    complete(&program, "QueryCalls.context");
    let parent = complete(&program, "QueryCalls.parent");
    origins(&db, parent);
    assert_eq!(parent.effects.len(), 1);
    assert!(!parent.returns.is_empty());
    for returned in &parent.returns {
        assert!(
            returned
                .dependencies
                .iter()
                .any(|dep| dep.role == DependencyRole::Control)
        );
        assert!(
            returned
                .dependencies
                .iter()
                .any(|dep| dep.role == DependencyRole::Data)
        );
        for dependency in &returned.dependencies {
            assert_eq!(dependency.model_name, "QueryCalls.Step");
            assert_eq!(dependency.field_name, "input");
            assert_eq!(dependency.type_id, "QueryCalls.Input");
            assert_eq!(
                &source[dependency.node.start as usize..dependency.node.end as usize],
                "step.input"
            );
            assert!(matches!(dependency.ty, ResolvedType::Record { .. }));
        }
        assert!(
            returned.intrinsics.is_empty(),
            "contract callbacks do not manufacture admitted row observations"
        );
        assert!(
            returned.influences.is_empty(),
            "the complete child retains its own query influences"
        );
    }
    let proofs = &program.types.checked_contract_collection_calls;
    assert_eq!(proofs.len(), 2);
    assert_eq!(
        proofs.values().filter(|proof| proof.call.is_some()).count(),
        1
    );
    assert_eq!(
        proofs.values().filter(|proof| proof.call.is_none()).count(),
        1
    );
    let (lowered, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = lowered
        .items
        .iter()
        .find(|item| item.canonical == "QueryCalls.parent")
        .unwrap()
        .id;
    let publish = |lowered: &ir::IrProgram| {
        serialize_decision_sources(
            &program,
            lowered,
            &lowered.items[owner.0 as usize],
            &db,
            catalog.as_ref(),
        )
    };
    assert!(
        publish(&lowered).is_some(),
        "original nested checked source/IR correspondence publishes"
    );
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("stored-input-facts", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: serde_json::Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    for name in ["QueryCalls.context", "QueryCalls.parent"] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap();
        assert!(
            operation["result"].get("disclosure").is_some(),
            "{name} actual prepared disclosure"
        );
    }
    for corruption in 0..5 {
        let mut changed = lowered.clone();
        let ir::IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
        else {
            panic!("parent");
        };
        let ir::IrStmt::Require { cond, .. } = &mut effects[1] else {
            panic!("original guard");
        };
        let ir::IrExpr::Binary { right, .. } = &mut cond.expr else {
            panic!("original count and all");
        };
        let ir::IrExpr::Call { args, .. } = &mut right.expr else {
            panic!("original all");
        };
        let ir::IrExpr::Query(query) = &mut args[0].expr else {
            panic!("stored facts query");
        };
        match corruption {
            0 => query.contract_collection_call = None,
            1 => {
                let proof = query.contract_collection_call.as_mut().unwrap();
                proof.domain = proof.alias;
            }
            2 => {
                let ir::IrQueryDomain::Value { alias, .. } = &mut query.domain else {
                    panic!("owning contract domain");
                };
                *alias = "copied".into();
            }
            3 => {
                let ir::IrQueryDomain::Value { base, .. } = &mut query.domain else {
                    panic!("owning contract domain");
                };
                let ir::IrExpr::Member { base, .. } = &mut base.expr else {
                    panic!("facts member");
                };
                let ir::IrExpr::Member { base, .. } = &mut base.expr else {
                    panic!("Input root");
                };
                base.expr = ir::IrExpr::Name("foreign".into());
            }
            4 => {
                let ir::IrExpr::Lambda { body, .. } = &mut args[1].expr else {
                    panic!("old predicate");
                };
                let ir::IrExpr::Call { args, .. } = &mut body.expr else {
                    panic!("fresh any");
                };
                let ir::IrExpr::Query(query) = &mut args[0].expr else {
                    panic!("fresh query");
                };
                query.contract_collection_call.as_mut().unwrap().call = None;
            }
            _ => unreachable!(),
        }
        assert!(
            publish(&changed).is_none(),
            "forged owning contract/fresh proof {corruption} must refuse"
        );
    }
    // Raw IR cannot provide the immutable prepared child receipt used above.
    // Check whole Input schema matching on the independently supported scalar
    // DATA count consumer, which has no query child or source Require frame.
    // The original guarded source was qualified through the public emitter above.
    let count_source=source.replace(
        "   call context {location,targets} as fresh\n   require count(fresh)==count(step.input.facts) and all(step.input.facts as old,any(fresh as current,current.task==old.task and current.version==old.version))",
        "",
    );
    let (count_db, count_program, count_ir) =
        checked_with_ir(&[("stored-input-count.can", &count_source)]);
    complete(&count_program, "QueryCalls.parent");
    let native = |lowered: &ir::IrProgram| {
        js::emit_program_with_native_source_receipts(lowered, true, &count_db)
            .operations
            .iter()
            .find(|operation| operation.name == "QueryCalls.parent")
            .unwrap()
            .disclosure
            .is_some()
    };
    assert!(native(&count_ir));
    assert!(
        js::emit_program_with_native_receipts(&count_ir, true)
            .operations
            .iter()
            .find(|operation| operation.name == "QueryCalls.parent")
            .unwrap()
            .disclosure
            .is_none(),
        "whole stored contracts require their actual source"
    );
    let mut changed_db = SourceDb::new();
    changed_db.add(
        "stored-input-count.can".into(),
        format!("{count_source}\n## changed schema source\n"),
    );
    assert!(
        js::emit_program_with_native_source_receipts(&count_ir, true, &changed_db)
            .operations
            .iter()
            .find(|operation| operation.name == "QueryCalls.parent")
            .unwrap()
            .disclosure
            .is_none(),
        "stale owning schema source must refuse"
    );
    for (canonical, corruption) in [("QueryCalls.Input.facts", 0), ("QueryCalls.Step.input", 1)] {
        let mut changed = count_ir.clone();
        let item = changed
            .items
            .iter_mut()
            .find(|item| item.canonical == canonical)
            .unwrap();
        let ir::IrItemKind::Field { ty, .. } = &mut item.kind else {
            panic!("owning field");
        };
        if corruption == 0 {
            *ty = ir::IrType::Known(ResolvedType::Scalar(Scalar::Bool));
        } else {
            item.name = "foreign".into();
        }
        assert!(
            !native(&changed),
            "owning Input field/schema mismatch {canonical} must refuse native publication"
        );
    }
}

#[test]
fn original_root_create_archive_native_capture_refuses_ir_skew() {
    use canlang_compiler::codegen::ir::{IrDefault, IrDeleteMode, IrExpr, IrItemKind, IrStmt};
    use canlang_compiler::codegen::js;

    let source = include_str!("../../packages/cloudflare/test/fixtures/typed-scenario-values.can");
    assert_eq!(
        sha256_hex(source.as_bytes()),
        "57100433b813b279e68aa3409864f5bfd7bb6487502a8b2fe55fcff24b4223b4"
    );
    let (db, program, lowered) = checked_with_ir(&[(
        "packages/cloudflare/test/fixtures/typed-scenario-values.can",
        source,
    )]);
    for name in ["TypedScenarioValues.born", "TypedScenarioValues.discard"] {
        origins(&db, complete(&program, name));
    }
    let item = |name: &str| {
        lowered
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap()
            .id
    };
    let born = item("TypedScenarioValues.born");
    let discard = item("TypedScenarioValues.discard");
    let count = item("TypedScenarioValues.Counter.count");
    let emit =
        |lowered: &ir::IrProgram| js::emit_program_with_native_source_receipts(lowered, true, &db);
    let genuine = emit(&lowered);
    for name in ["TypedScenarioValues.born", "TypedScenarioValues.discard"] {
        assert!(
            genuine
                .operations
                .iter()
                .find(|operation| operation.name == name)
                .unwrap()
                .disclosure
                .is_some(),
            "original checked {name} publishes its whole native capture"
        );
    }
    for corruption in 0..9 {
        let mut changed = lowered.clone();
        let target = match corruption {
            0..=2 => {
                let IrItemKind::Scenario { effects, .. } = &mut changed.items[born.0 as usize].kind
                else {
                    panic!("original born scenario");
                };
                let IrStmt::Create { model, binding, .. } = &mut effects[0] else {
                    panic!("original CreateAs");
                };
                match corruption {
                    0 => *model = "TypedScenarioValues.unchecked".into(),
                    1 => *binding = Some("copied".into()),
                    2 => *binding = None,
                    _ => unreachable!(),
                }
                "TypedScenarioValues.born"
            }
            3 => {
                let IrItemKind::Field {
                    default: Some(IrDefault::Literal(value)),
                    ..
                } = &mut changed.items[count.0 as usize].kind
                else {
                    panic!("original model literal default");
                };
                assert!(matches!(value.expr, IrExpr::Int(1)));
                value.expr = IrExpr::Int(2);
                "TypedScenarioValues.born"
            }
            4..=5 => {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[discard.0 as usize].kind
                else {
                    panic!("original discard scenario");
                };
                let IrStmt::Delete { record, mode, .. } = &mut effects[0] else {
                    panic!("original direct archive Delete");
                };
                if corruption == 4 {
                    assert!(matches!(&record.expr, IrExpr::Name(name) if name == "counter"));
                    record.expr = IrExpr::Name("copied".into());
                } else {
                    assert_eq!(*mode, IrDeleteMode::Archive);
                    *mode = IrDeleteMode::Remove;
                }
                "TypedScenarioValues.discard"
            }
            6 => {
                let IrItemKind::Scenario { effects, .. } = &mut changed.items[born.0 as usize].kind
                else {
                    panic!("original born scenario");
                };
                assert!(matches!(
                    effects.as_slice(),
                    [
                        IrStmt::Create { .. },
                        IrStmt::Set { .. },
                        IrStmt::Return { .. }
                    ]
                ));
                effects.swap(0, 1);
                "TypedScenarioValues.born"
            }
            7..=8 => {
                let IrItemKind::Scenario { effects, .. } = &mut changed.items[born.0 as usize].kind
                else {
                    panic!("original born scenario");
                };
                if corruption == 7 {
                    let IrStmt::Set { record, .. } = &mut effects[1] else {
                        panic!("original created-row Set");
                    };
                    assert!(matches!(&record.expr, IrExpr::Name(name) if name == "counter"));
                    record.expr = IrExpr::Name("copied".into());
                } else {
                    let IrStmt::Return {
                        value: Some(value), ..
                    } = &mut effects[2]
                    else {
                        panic!("original created-row return");
                    };
                    let IrExpr::Member { base, .. } = &mut value.expr else {
                        panic!("original returned count field");
                    };
                    assert!(matches!(&base.expr, IrExpr::Name(name) if name == "counter"));
                    base.expr = IrExpr::Name("copied".into());
                }
                "TypedScenarioValues.born"
            }
            _ => unreachable!(),
        };
        assert!(
            emit(&changed)
                .operations
                .iter()
                .find(|operation| operation.name == target)
                .unwrap()
                .disclosure
                .is_none(),
            "original source/IR target, binding, default, mode or order skew {corruption} must withdraw {target} capture"
        );
    }
    let unchanged = emit(&lowered);
    for name in ["TypedScenarioValues.born", "TypedScenarioValues.discard"] {
        assert_eq!(
            unchanged
                .operations
                .iter()
                .find(|operation| operation.name == name)
                .unwrap()
                .disclosure,
            genuine
                .operations
                .iter()
                .find(|operation| operation.name == name)
                .unwrap()
                .disclosure,
            "cloned skew controls preserve the original checked capture"
        );
    }
}

#[test]
fn stored_input_fact_comparison_refuses_nonowning_and_unsupported_origins() {
    let original = stored_input_query_parent_source();
    let mut cases = vec![
        original
            .replace("step:Step,location", "input:Input,location")
            .replace("step.input", "input"),
        original
            .replace(
                "   require count(fresh)",
                "   let copied=step.input.facts\n   require count(fresh)",
            )
            .replace("all(step.input.facts as old", "all(copied as old"),
        original
            .replace(
                "Given\n",
                "Given\n derive identity(value:Input):Input=value\n",
            )
            .replace(
                "count(step.input.facts)",
                "count(identity(step.input).facts)",
            ),
        original
            .replace(
                "Given\n",
                "Given\n derive identity(value:bool):bool=value\n",
            )
            .replace(
                "current.task==old.task and current.version==old.version",
                "identity(current.task==old.task and current.version==old.version)",
            ),
        original.replace("current.version==old.version", "old.task.title==\"old\""),
        original.replace(
            "current.version==old.version",
            "old.task.version==old.version",
        ),
        original.replace(
            "count(visible)==count(targets)",
            "count(visible)>=count(targets)",
        ),
        original
            .replace("Step {input:Input}", "Step {input:Input?}")
            .replace(
                "   call context",
                "   require step.input!=null\n   call context",
            ),
    ];
    cases.push(
        original
            .replace(
                "previous:text[] max=8",
                "previous:text[] max=8,files:file[]",
            )
            .replace(
                "   return count(step.input.facts)",
                "   require count(step.input.files)>0\n   return count(step.input.facts)",
            ),
    );
    for source in cases {
        let mut db = SourceDb::new();
        let file = db.add("stored-input-refusal.can".into(), source.clone());
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(
            diagnostics.is_empty(),
            "valid unsupported source {source}\n{diagnostics:?}"
        );
        assert!(
            matches!(
                fact(&program, "QueryCalls.parent"),
                ScenarioDisclosure::Declined(_)
            ),
            "unsupported owning Input closure must decline: {source}"
        );
    }
}
