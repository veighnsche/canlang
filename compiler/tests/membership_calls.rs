//! Bounded selected membership admission; no native stage/runtime claims.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, Effects, load_catalog};
use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use std::path::Path;

fn catalog() -> Catalog {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    load(&root.join("packages/values/dist/catalog.json"))
}

fn load(path: &Path) -> Catalog {
    let mut db = SourceDb::new();
    let id = db.add("membership-anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(path),
        env: None,
        cwd: path.parent().unwrap(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn check(source: &str, catalog: &Catalog) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("membership-calls.can".into(), source.into());
    check_program(&db, &[id], Some(catalog))
}

const ORIGINAL_HELPER_SHAPE: &str = r#"app MembershipCalls
use std {TextGenerationV1 as LLM} from=deployment.llm
Given
 Conversation {account:user,active:bool}
 Run {author:user,conversation:Conversation?}
 derive can_use(person:user?,conversation:Conversation):bool = person!=null and active_member(person,team) and conversation.account==person and conversation.active
 derive can_view(person:user?,run:Run):bool = person!=null and active_member(person,team) and run.author==person and (run.conversation==null or can_use(person,run.conversation))
 policy Conversation read=members where=can_use(actor,row)
 policy Run read=members where=can_view(actor,row)
When
 scenario stop(run:Run) by=members
  require can_view(actor,run)
  do
   let visible=Run as candidate where can_view(actor,candidate)
   if not active_member(run.author,team)
    require false
   send LLM.cancel {revision=1,source="fixed"} when=active_member(run.author,team) and (run.conversation==null or can_use(run.author,run.conversation)) as stopped
Then
 page /runs title="Runs"
  list Run as run where can_view(actor,run)
   text "Visible run"
"#;

#[test]
fn original_transitive_derive_read_predicates_and_dispatch_are_checked_state_reads() {
    let catalog = catalog();
    assert_eq!(catalog.effects("active_member"), Some(Effects::StateRead));
    let (program, diagnostics) = check(ORIGINAL_HELPER_SHAPE, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let membership = program.types.selected_calls.iter().filter(|(_, call)| {
        matches!(&call.target, SelectedCallTarget::Builtin { id, overload: 0 } if id == "active_member")
    }).collect::<Vec<_>>();
    assert_eq!(
        membership.len(),
        4,
        "two helpers, body if and dispatch when"
    );
    for (node, call) in membership {
        assert_eq!(call.slots, [Some(0), Some(1)]);
        assert_eq!(
            program.types.node_types.get(node),
            Some(&ResolvedType::Scalar(Scalar::Bool))
        );
        assert_eq!(
            program.types.node_types.get(&call.arguments[0]),
            Some(&ResolvedType::Scalar(Scalar::User))
        );
        assert_eq!(
            program.types.node_types.get(&call.arguments[1]),
            Some(&ResolvedType::Team)
        );
    }
    assert_eq!(catalog.effects("active_member"), Some(Effects::StateRead));
}

#[test]
fn named_membership_arguments_keep_source_order_and_selected_slots() {
    let source = "app NamedMembership\nGiven\n derive member(person:user?):bool = person!=null and active_member(team=team,person=person)\nWhen\nThen\n";
    let (program, diagnostics) = check(source, &catalog());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (node, call) = program.types.selected_calls.iter().find(|(_, call)| {
        matches!(&call.target, SelectedCallTarget::Builtin { id, overload: 0 } if id == "active_member")
    }).unwrap();
    assert_eq!(
        source[node.start as usize..node.end as usize].trim(),
        "active_member(team=team,person=person)"
    );
    assert_eq!(call.slots, [Some(1), Some(0)]);
    assert_eq!(
        source[call.arguments[0].start as usize..call.arguments[0].end as usize].trim(),
        "team"
    );
    assert_eq!(
        source[call.arguments[1].start as usize..call.arguments[1].end as usize].trim(),
        "person"
    );
}

#[test]
fn unrelated_state_reads_still_fail_derive_and_dispatch_purity() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut payload: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("packages/values/dist/catalog.json")).unwrap(),
    )
    .unwrap();
    let abs = payload["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "abs")
        .unwrap();
    assert_eq!(abs["effects"], "pure");
    abs["effects"] = serde_json::Value::String("state-read".into());
    let path = std::env::temp_dir().join(format!(
        "can-membership-unrelated-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
    let catalog = load(&path);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(catalog.effects("abs"), Some(Effects::StateRead));
    for source in [
        "app Unbounded\nGiven\n derive nonempty():bool = abs(-1)>0\nWhen\nThen\n",
        "app Unbounded\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nGiven\nWhen\n scenario stop() by=members\n  do send LLM.cancel {revision=1,source=\"fixed\"} when=abs(-1)>0 as stopped\nThen\n",
    ] {
        let (_, diagnostics) = check(source, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E3010" && diagnostic.message.contains("abs")),
            "{diagnostics:?}"
        );
    }
}

#[test]
fn membership_cannot_enter_direct_or_transitive_defaults() {
    let catalog = catalog();
    for source in [
        "app UnsafeDefault\nGiven\nWhen\n scenario enter(person:user,allowed:bool=active_member(person,team)) by=members\n  do let accepted=true\nThen\n",
        "app UnsafeDefault\nGiven\n derive outer():bool = middle()\n derive middle():bool = member(actor)\n derive member(person:user?):bool = person!=null and active_member(person,team)\nWhen\n scenario enter(allowed:bool=outer()) by=members\n  do let accepted=true\nThen\n",
        "app UnsafeDefault\nGiven\n derive member(person:user?):bool = person!=null and active_member(person,team)\n Entry {allowed:bool=member(actor)}\nWhen\nThen\n",
        "app UnsafeDefault\nGiven\n Entry {allowed:bool=actor!=null and active_member(actor,team)}\nWhen\nThen\n",
        "app UnsafeDefault\nGiven\n derive member(person:user?):bool = person!=null and active_member(person,team)\n Entry {allowed:bool server=member(actor)}\nWhen\nThen\n",
        "app UnsafeField\nGiven\n Entry {label:text}\n derive member(person:user?):bool = person!=null and active_member(person,team)\n derive Entry.visible:text = first([\"yes\"] as value where member(actor))??\"no\"\nWhen\nThen\n",
        "app UnsafeFieldDefault\nGiven\n Entry {label:text}\n derive member(person:user?):bool = person!=null and active_member(person,team)\n derive Entry.visible:bool = member(actor)\nWhen\n scenario enter(entry:Entry,allowed:bool=entry.visible) by=members\n  do let accepted=true\nThen\n",
        "app UnsafePage\nGiven\n derive member(person:user?):bool = person!=null and active_member(person,team)\nWhen\nThen\n page /private title=\"Private\"\n  require member(actor)\n",
    ] {
        let (_, diagnostics) = check(source, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| matches!(diagnostic.code, "E3010" | "E3011")
                    && (diagnostic.message.contains("member")
                        || diagnostic.message.contains("outer"))),
            "{source}\n{diagnostics:?}"
        );
    }
    let pure = "app PurePage\nGiven\n derive allowed():bool = true\nWhen\nThen\n page /public title=\"Public\"\n  require members\n  require allowed()\n  text \"Accepted\"\n";
    let (_, diagnostics) = check(pure, &catalog);
    assert!(diagnostics.is_empty(), "{pure}\n{diagnostics:?}");
}

/// (R26 layer 1, T37 pilot — contract change from the frozen T02
/// positive "admitted-actor use passes in composite policies and CRUD
/// `when=`", now that T32's fence is adopted: a CRUD `when=` is a
/// bounded authorization guard like a send `when=` and like policy
/// `where=` (which already admits these calls, cf.
/// ORIGINAL_HELPER_SHAPE above). Membership reads admit in the guard;
/// impure builtins still reject, derive bodies stay pure-gated, and
/// commit-time revalidation (T32) backstops freshness. The retired
/// crud-guard rejection case moved here from
/// `membership_cannot_enter_direct_or_transitive_defaults` unchanged
/// in shape, asserting clean instead of refusal.)
#[test]
fn membership_reads_admit_in_actor_admitted_crud_guards() {
    let catalog = catalog();
    let source = "app UnsafeCrud\nGiven\n Entry {label:text}\n derive member(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members\nWhen\n crud Entry by=members fields=label when=member(actor)\nThen\n";
    let (_, diagnostics) = check(source, &catalog);
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
}

#[test]
fn a_different_selected_membership_signature_is_not_admitted() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut payload: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("packages/values/dist/catalog.json")).unwrap(),
    )
    .unwrap();
    let membership = payload["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "active_member")
        .unwrap();
    membership["signature"] =
        serde_json::Value::String("active_member(subject:user,team:Team)->bool".into());
    let path = std::env::temp_dir().join(format!(
        "can-membership-signature-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
    let changed = load(&path);
    std::fs::remove_file(&path).unwrap();
    let source = "app DifferentMembership\nGiven\n derive member(person:user):bool = active_member(person,team)\nWhen\nThen\n";
    let (_, diagnostics) = check(source, &changed);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"
                && diagnostic.message.contains("active_member")),
        "{diagnostics:?}"
    );
}

#[test]
fn record_page_and_boolean_field_admit_bounded_reads_without_relaxing_other_values() {
    let source = "app ContextualMembership\nGiven\n Entry {account:user}\n policy Entry read=members\n derive current(person:user):bool = active_member(person,team)\n derive Entry.visible:bool = current(row.account)\nWhen\nThen\n page /entries/{Entry.id}/access title=\"Access\"\n  require actor!=null and current(actor)\n  text row.visible\n";
    let (_, diagnostics) = check(source, &catalog());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let nonbool = source.replace("derive Entry.visible:bool = current(row.account)", "derive Entry.visible:text = first([\"yes\"] as value where current(row.account))??\"no\"")
        .replace(" and row.visible", "");
    let (_, diagnostics) = check(&nonbool, &catalog());
    assert!(
        diagnostics
            .iter()
            .any(|d| d.code == "E3010" && d.message.contains("current")),
        "{diagnostics:?}"
    );
}
