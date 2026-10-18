//! Hook classification uses real source checking and owning IR declarations.
//! It supplies no native consumer or execution evidence.
use canlang_compiler::{
    analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
        resolve::SymbolId,
    },
    codegen::{
        ir::{self, IrExpr, IrItemKind, IrProgram, IrStmt, TypedExpr},
        js,
        model_policy_profile::local_hook_supported,
    },
    source::{SourceDb, Span},
};

fn hook(source: &str, clean: bool) -> (IrProgram, SymbolId) {
    hook_with_expected_diagnostic(source, clean, None)
}

const CONTEXT_SOURCE: &str = r#"app HookContextProfile
Given
 Entry {title:text}
 Audit {explicit_author:user,explicit_at:datetime,team_id:text,team_timezone:timezone,operation_id:text,operation_source:text,actor_email:email,actor_verified:bool}
 policy Entry read=members
 policy Audit read=members
When
 crud Entry by=members fields=title
 scenario capture on=Entry.update
  do
   create Audit {explicit_author=actor,explicit_at=now,team_id=team.id,team_timezone=team.timezone,operation_id=operation.id,operation_source=operation.source,actor_email=actor.email,actor_verified=actor.email_verified} as audit
Then
"#;

/// Check the complete source unit and its real emitted policy claim together.
/// The original classification helpers retain their existing assertions.
fn contextual_hook(source: &str, admitted: bool) -> (IrProgram, SymbolId) {
    let mut db = SourceDb::new();
    let file = db.add("model-hook-context.can".into(), source.into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(
        diagnostics.is_empty(),
        "checked contextual source: {diagnostics:?}"
    );
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    let output = js::emit_program_with_native_source_receipts(&program, false, &db);
    if admitted {
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
        assert!(
            output.model_policies.is_some(),
            "complete owning policy claim is published"
        );
    } else {
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic.message.contains("hook contextual binding")),
            "unsupported complete graph retains the context refusal: {diagnostics:?}"
        );
        assert!(
            output.model_policies.is_none(),
            "unsupported complete graph publishes no partial policy claim"
        );
        assert!(!output.entry.js.contains("modelPolicyBindings:"));
    }
    let scenario = program
        .items
        .iter()
        .find(|item| matches!(item.kind, IrItemKind::Scenario { hook: Some(_), .. }))
        .unwrap()
        .id;
    assert_eq!(local_hook_supported(&program, scenario), admitted);
    (program, scenario)
}

fn expression_path(expr: &TypedExpr) -> Vec<&str> {
    match &expr.expr {
        IrExpr::Name(name) => vec![name],
        IrExpr::Member { base, field } => {
            let mut path = expression_path(base);
            path.push(field);
            path
        }
        other => panic!("expected exact checked path, got {other:?}"),
    }
}

#[test]
fn checked_authenticated_hook_context_stages_exact_native_scalar_values() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar};
    for operation in ["create", "update"] {
        let source = CONTEXT_SOURCE.replace("on=Entry.update", &format!("on=Entry.{operation}"));
        let (program, scenario) = contextual_hook(&source, true);
        let IrItemKind::Scenario { effects, .. } = &program.item(scenario).kind else {
            unreachable!()
        };
        let IrStmt::Create { model, input, .. } = &effects[0] else {
            panic!("actual staged create: {effects:?}")
        };
        assert_eq!(model, "HookContextProfile.Audit");
        let IrExpr::Object(entries) = &input.expr else {
            panic!("named staged values: {input:?}")
        };
        let expected = [
            ("explicit_author", Scalar::User, vec!["c", "actor"]),
            ("explicit_at", Scalar::Datetime, vec!["c", "now"]),
            ("team_id", Scalar::Text, vec!["c", "team", "id"]),
            (
                "team_timezone",
                Scalar::Timezone,
                vec!["c", "team", "timezone"],
            ),
            ("operation_id", Scalar::Text, vec!["c", "operation", "id"]),
            (
                "operation_source",
                Scalar::Text,
                vec!["c", "operation", "source"],
            ),
            (
                "actor_email",
                Scalar::Email,
                vec!["c", "actorFacts", "email"],
            ),
            (
                "actor_verified",
                Scalar::Bool,
                vec!["c", "actorFacts", "email_verified"],
            ),
        ];
        assert_eq!(entries.len(), expected.len());
        for ((name, value), (expected_name, scalar, path)) in entries.iter().zip(expected) {
            assert_eq!(name, expected_name);
            assert_eq!(value.ty, ResolvedType::Scalar(scalar));
            assert_eq!(expression_path(value), path);
        }
    }
}

#[test]
fn checked_hook_context_spellings_reject_authored_shadows_and_preserve_context_types() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar};
    use std::process::Command;
    let source = r#"app HookLexicalProfile
Given
 Entry {title:text}
 Audit {actor_value:text,now_value:text,team_value:text,operation_value:text}
 policy Entry read=members
 policy Audit read=members
When
 crud Entry by=members fields=title
 scenario capture on=Entry.update
  do
   let actor="lexical actor"
   let now="lexical now"
   let team="lexical team"
   let operation="lexical operation"
   create Audit {actor_value=actor,now_value=now,team_value=team,operation_value=operation} as audit
Then
"#;
    let mut db = SourceDb::new();
    let file = db.add("model-hook-shadow.can".into(), source.into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    let shadows: Vec<_> = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code == "E2012")
        .collect();
    assert_eq!(
        shadows.len(),
        4,
        "all active contexts reject shadows: {diagnostics:?}"
    );
    for (name, expected) in [
        ("actor", ResolvedType::Scalar(Scalar::User)),
        ("now", ResolvedType::Scalar(Scalar::Datetime)),
        ("team", ResolvedType::Team),
        ("operation", ResolvedType::OperationContext),
    ] {
        assert!(
            shadows
                .iter()
                .any(|diagnostic| diagnostic.message.contains(&format!(
                    "'{name}' hides the active contextual fact '{name}'"
                )))
        );
        let needle = format!("{name}_value={name}");
        let start = source.find(&needle).unwrap() + format!("{name}_value=").len();
        let end = start + name.len();
        assert!(
            checked
                .types
                .node_types
                .iter()
                .any(|(key, ty)| key.file == file
                    && key.start as usize <= start
                    && key.end as usize >= end
                    && source[key.start as usize..key.end as usize].trim() == name
                    && ty == &expected),
            "rejected let leaves the actual checked {name} context type intact"
        );
    }
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("model-hook-shadow.can");
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(path)
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!output.status.success(), "{result}");
    assert_eq!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|diagnostic| diagnostic["code"] == "E2012")
            .count(),
        4,
        "{result}"
    );
    assert!(
        result.get("modules").is_none(),
        "invalid source publishes no native modules or policy claim: {result}"
    );
}

#[test]
fn unsupported_hook_graphs_with_context_retain_refusal_and_no_policy_claim() {
    let delete = CONTEXT_SOURCE.replace("on=Entry.update", "on=Entry.delete");
    let create_line = delete
        .lines()
        .find(|line| line.trim_start().starts_with("create Audit"))
        .unwrap();
    let delete = delete.replace(create_line, "   let caller=actor\n   let clock=now");
    for source in [
        CONTEXT_SOURCE.replace(
            "  do\n",
            "  do\n   let unsupported=trim(event.after.title)\n",
        ),
        CONTEXT_SOURCE.replace("  do\n", "  do\n   let unsupported=count(Entry)\n"),
        CONTEXT_SOURCE.replace(
            " policy Entry read=members",
            " policy Entry read=members\n invariant Entry: trim(row.title)!=\"\"",
        ),
        delete,
    ] {
        contextual_hook(&source, false);
    }
}

fn hook_with_expected_diagnostic(
    source: &str,
    clean: bool,
    expected: Option<&str>,
) -> (IrProgram, SymbolId) {
    let mut db = SourceDb::new();
    let file = db.add("model-hook.can".into(), source.into());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(
        diagnostics.iter().all(|d| !d.code.starts_with("E1")),
        "{diagnostics:?}"
    );
    if clean {
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
    if let Some(code) = expected {
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{diagnostics:?}"
        );
        assert!(
            diagnostics.iter().all(|diagnostic| diagnostic.code == code),
            "{diagnostics:?}"
        );
    }
    let (program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    if clean {
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
    let scenario = program
        .items
        .iter()
        .find(|item| matches!(item.kind, IrItemKind::Scenario { hook: Some(_), .. }))
        .expect("real hook declaration")
        .id;
    (program, scenario)
}

#[test]
fn checked_ordered_candidate_adjustments_and_staged_create_are_supported() {
    let (program, scenario) = hook(include_str!("fixtures/hook_order_rollback.can"), true);
    assert!(
        local_hook_supported(&program, scenario),
        "{:#?}",
        program.item(scenario)
    );
}

#[test]
fn checked_update_before_leaves_are_readonly_and_keep_exact_snapshot_types() {
    use canlang_compiler::analysis::types::{ResolvedType, Scalar};
    let source = r#"app BeforeProfile
Given
 Entry {state:text,accept:bool,note:text?,phase:enum(draft,done)=draft}
 Audit {old_state:text,old_id:text,old_version:int}
 policy Entry read=members
 policy Audit read=members
When
 crud Entry by=members fields=state,accept,note,phase
 scenario adjust on=Entry.update
  do
   require event.before.state=="initial"
   require event.before.id==event.after.id
   require event.before.version+1==event.after.version
   require event.before.accept
   require event.before.note==null
   require event.before.phase==draft
   set event.after {state="first"}
   require event.before.state=="initial"
   create Audit {old_state=event.before.state,old_id=event.before.id,old_version=event.before.version} as audit
   set event.after {state="second"}
   require event.before.state=="initial"
Then
"#;
    let (program, scenario) = contextual_hook(source, true);
    let IrItemKind::Scenario { effects, .. } = &program.item(scenario).kind else {
        panic!("hook");
    };
    let IrStmt::Require { cond, .. } = &effects[0] else {
        panic!("before guard");
    };
    let IrExpr::Binary { left, .. } = &cond.expr else {
        panic!("comparison");
    };
    assert_eq!(expression_path(left), ["event", "before", "state"]);
    assert_eq!(left.ty, ResolvedType::Scalar(Scalar::Text));
    let IrStmt::Create { input, .. } = &effects[8] else {
        panic!("snapshot capture");
    };
    let IrExpr::Object(values) = &input.expr else {
        panic!("capture values");
    };
    assert_eq!(
        values
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["old_state", "old_id", "old_version"]
    );
    for ((_, value), (field, ty)) in values.iter().zip([
        ("state", Scalar::Text),
        ("id", Scalar::Text),
        ("version", Scalar::Int),
    ]) {
        assert_eq!(expression_path(value), ["event", "before", field]);
        assert_eq!(value.ty, ResolvedType::Scalar(ty));
    }
}

#[test]
fn checked_before_paths_preserve_create_delete_nullable_unknown_and_write_refusals() {
    let original = include_str!("fixtures/hook_order_rollback.can");
    for source in [
        // Valid source, but create's bare null side is outside this update-leaf profile.
        original.replace("on=Entry.update", "on=Entry.create")
            .replace("require event.after.accept", "require event.before==null"),
        original.replace("on=Entry.update", "on=Entry.delete")
            .replace("   require event.after.state==\"proposed\"\n   set event.after {state=\"first\"}\n   create Audit {note=event.after.state} as audit\n   require event.after.state==\"first\"\n   set event.after {state=\"second\"}\n   require event.after.state==\"second\"\n   require event.after.accept", "   require event.before.accept"),
        original.replace("Entry {state:text,accept:bool}", "Entry {state:text,accept:bool,note:text?}")
            .replace("require event.after.accept", "let unsupported=event.before.note.length"),
        original.replace("require event.after.accept", "let unknown=event.before.missing"),
        original.replace("require event.after.accept", "set event.before {state=\"changed\"}"),
        original.replace("require event.after.accept", "set event.before {version=2}"),
        original.replace("require event.after.accept", "let transitive=event.before.parent"),
        original.replace("on=Entry.update", "on=Entry.create")
            .replace("require event.after.accept", "require event.before.accept"),
    ] {
        let (program, scenario) = hook(&source, false);
        assert!(!local_hook_supported(&program, scenario), "{source}");
        let output = js::emit_program(&program);
        assert!(output.model_policies.is_none(), "refused source publishes no partial policy claim: {source}");
    }
}

#[test]
fn checked_candidate_identity_and_native_version_are_readonly_supported_leaves() {
    let source = include_str!("fixtures/hook_order_rollback.can").replace(
        "   require event.after.accept",
        "   require event.after.version>0\n   let id=event.after.id\n   require id!=\"\"\n   require event.after.accept",
    );
    let (program, scenario) = hook(&source, true);
    assert!(
        local_hook_supported(&program, scenario),
        "{:#?}",
        program.item(scenario)
    );
}

#[test]
fn checked_scalar_lets_owned_cases_and_bounded_branches_preserve_state_defaults() {
    let source = r#"app HookProfile
Given
 Entry {title:text,count:int,accept:bool,phase:enum(draft,done)=draft}
 Audit {note:text,author:user server=actor,at:datetime server=now}
 policy Entry read=members
 policy Audit read=members
When
 crud Entry by=members fields=title,count,accept,phase
 scenario adjust on=Entry.update
  do
   let title=event.after.title
   let count=event.after.count
   require count>=0 and not event.after.accept==false
   if event.after.accept
    set event.after {title=title,count=count+1,phase=done}
    create Audit {note=event.after.title} as audit
   else
    set event.after {phase=draft}
Then
"#;
    let (program, scenario) = hook(source, true);
    assert!(
        local_hook_supported(&program, scenario),
        "{:#?}",
        program.item(scenario)
    );
}

#[test]
fn checked_metadata_queries_calls_unknown_leaves_and_delete_hooks_are_refused() {
    let original = include_str!("fixtures/hook_order_rollback.can");
    for source in [
        original.replace("require event.after.accept", "let created=event.after.created"),
        original.replace("require event.after.accept", "require count(Audit)>0"),
        original.replace(" Audit {note:text}", " Audit {note:text}\n derive accepted(value:bool):bool = value")
            .replace("require event.after.accept", "require accepted(event.after.accept)"),
        original.replace(" Entry {state:text,accept:bool}", " Entry {state:text,accept:bool,values:text[]}"),
        original.replace(" scenario adjustEntry on=Entry.update", " scenario adjustEntry on=Entry.delete")
            .replace("   require event.after.state==\"proposed\"\n   set event.after {state=\"first\"}\n   create Audit {note=event.after.state} as audit\n   require event.after.state==\"first\"\n   set event.after {state=\"second\"}\n   require event.after.state==\"second\"\n   require event.after.accept", "   require event.before.accept"),
    ] {
        let (program, scenario) = hook(&source, false);
        assert!(!local_hook_supported(&program, scenario), "{source}");
    }
}

#[test]
fn source_rejected_same_trigger_staging_and_metadata_writes_do_not_qualify() {
    let original = include_str!("fixtures/hook_order_rollback.can");
    for source in [
        original.replace(
            "create Audit {note=event.after.state} as audit",
            "create Entry {state=\"another\",accept=true} as entry",
        ),
        original.replace(
            "set event.after {state=\"first\"}",
            "set event.after {version=1}",
        ),
    ] {
        let (program, scenario) = hook(&source, false);
        assert!(!local_hook_supported(&program, scenario), "{source}");
    }
}

#[test]
fn checked_cross_package_reference_timezone_reads_through_genuine_linkage() {
    // Whole original asset retirement shape: a hook in one package reads a
    // declared leaf through a stored reference owned by another package
    // (`event.after.site.timezone`) and stages it through a pure temporal
    // builtin. The declaration is resolved on the read model's owning
    // module; same-module rows keep their exact gate.
    let source = r#"app CrossPackageTimezone uses=[Work]
package Work
 use Catalog {Site}
 Given
  Asset {site:Site, retired:bool=false, epoch:int=0}
  Ticket in Asset {cutoff:date}
  event Stepped {ticket:Ticket}
  policy Asset read=members
  policy Ticket read=members
 When
  crud Asset by=members fields=retired,epoch
  scenario retire on=Asset.update
   do
    if event.after.retired and not event.before.retired
     create Ticket {parent=event.after,cutoff=local_date(now,event.after.site.timezone)} as ticket
     emit Stepped {ticket=ticket}
 Then
package Catalog
 Given
  export Site {timezone:timezone}
 When
 Then
"#;
    let (program, scenario) = contextual_hook(source, true);
    assert!(
        local_hook_supported(&program, scenario),
        "{:#?}",
        program.item(scenario)
    );
}

#[test]
fn source_rejected_foreign_staged_models_do_not_acquire_local_hook_coverage() {
    let source = include_str!("fixtures/hook_order_rollback.can")
        .replace(
            "app HookOrder\n",
            "app HookOrder\nuse Foreign {ForeignAudit}\n",
        )
        .replace(
            "create Audit {note=event.after.state} as audit",
            "create ForeignAudit {note=event.after.state} as audit",
        )
        + "package Foreign\n Given\n  export ForeignAudit {note:text}\n When\n Then\n";
    let (program, scenario) = hook_with_expected_diagnostic(&source, false, Some("E4001"));
    assert!(!local_hook_supported(&program, scenario));
}
