//! Checked local model-policy descriptors for the defining State owner ABI.
//! Unsupported declarations never acquire an empty dependency certificate.
use crate::analysis::resolve::{CrudOp, SymbolId};
use crate::analysis::{CheckedProgram, catalog::Catalog};
use crate::codegen::ir::{self, IrItemKind, IrModelRuleKind, IrProgram, IrType, TypedExpr};
use crate::codegen::model_policy_profile::{
    CurrentRevisionRuleKind, CurrentRevisionRuleProfile, checked_chat_invariant_fields,
    checked_chat_lock_target, checked_local_rule_fields, checked_query_rule_fields,
    checked_stored_lock_target, current_revision_lock_target, current_revision_rule_profile,
    local_hook_supported, local_rule_fields, local_stored_field_type,
    required_model_rule_dependencies, required_model_rule_fields,
};
use crate::diagnostic::Severity;
use crate::source::SourceDb;
use serde::Serialize;

#[path = "model_policy_sources.rs"]
mod source;

#[derive(Debug, Clone, Serialize)]
pub struct ModelPolicies {
    pub abi: &'static str,
    pub model: String,
    #[serde(rename = "ownerPackage")]
    pub owner_package: String,
    pub module: String,
    pub rules: Vec<ModelRule>,
    pub hooks: Vec<ModelHook>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ModelRule {
    Invariant {
        id: String,
        dependencies: Vec<ModelDependency>,
    },
    Lock {
        id: String,
        fields: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelDependency {
    pub id: String,
    pub model: String,
    #[serde(rename = "maxTargets")]
    pub max_targets: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelHook {
    pub id: String,
    pub op: String,
    pub operation: String,
}

/// The checked predicate is reused, rather than a second expression interpreter.
#[derive(Debug, Clone)]
pub(crate) struct PredicateBinding {
    pub id: String,
    pub model: SymbolId,
    pub owner_package: String,
    pub kind: IrModelRuleKind,
    pub predicate: Option<TypedExpr>,
    /// Only the source-sealed original nullable current rule owns this path.
    pub current_revision: Option<CurrentRevisionRuleProfile>,
    /// Original checked Model query roots; empty on all other bindings.
    pub query_models: Vec<SymbolId>,
    /// Source-sealed extended pure predicate lowering, including no-query bodies.
    pub checked_body: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPolicies {
    pub descriptors: Vec<ModelPolicies>,
    pub bindings: Vec<PredicateBinding>,
    pub hook_bindings: Vec<HookBinding>,
    pub dependency_bindings: Vec<DependencyBinding>,
}

/// Existing dependency binding ABI: one changed Revision selects its immutable
/// owning Template parent. The selector is emitted separately from evaluation.
#[derive(Debug, Clone)]
pub(crate) struct DependencyBinding {
    pub id: String,
    pub model: SymbolId,
    pub owner_package: String,
    pub changed_model: SymbolId,
    /// Checked required-reference path for bounded reverse final-view joins.
    /// Empty only for the existing original current-Revision selector.
    pub path: Vec<(SymbolId, String, SymbolId)>,
    /// Checked root-query/filter reads invalidate every bounded owning row.
    /// Kept distinct from the original empty current-Revision path.
    pub all_owners: bool,
}

/// Link the descriptor to the original emitted hooks[operation].run function.
#[derive(Debug, Clone)]
pub(crate) struct HookBinding {
    pub id: String,
    pub model: SymbolId,
    pub owner_package: String,
    pub operation: String,
}

/// A missing result preserves activation refusal for the entire source unit.
/// There is no partial declaration coverage or guessed reverse selector.
pub(crate) fn collect_local_policies(
    ir: &IrProgram,
    emitted_module: &str,
) -> Option<LocalPolicies> {
    collect_policies(ir, emitted_module, None, None, None)
}

/// Source-backed intake for the original current-Revision policy closure.
/// Raw IR never enters this profile: all original models, fields, source rules,
/// defaults and lock entries must agree with a fresh checked build first.
pub(crate) fn collect_checked_policies(
    program: &CheckedProgram,
    ir: &IrProgram,
    db: &SourceDb,
    catalog: Option<&Catalog>,
    emitted_module: &str,
) -> Option<LocalPolicies> {
    program.validate_cohort(db, catalog).ok()?;
    let entry = super::js::pick_entrypoint(ir)?;
    if super::js::module_path(&ir.module(entry).name) != emitted_module {
        return None;
    }
    let (fresh, diagnostics) = ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
        || !source::matches(program, ir, &fresh)
    {
        return None;
    }
    if let Some(existing) = collect_local_policies(ir, emitted_module) {
        return Some(existing);
    }
    let profiles = ir
        .invariants
        .iter()
        .filter_map(|rule| current_revision_rule_profile(ir, rule))
        .collect::<Vec<_>>();
    // Both mandatory original rules are needed together, from the same owning
    // source model pair; matching names alone never closes rule coverage.
    for profile in &profiles {
        let companion = match profile.kind {
            CurrentRevisionRuleKind::Template { revision, .. } => profiles.iter().filter(|other|
                other.origin.model == revision && other.origin.module == profile.origin.module
                    && matches!(other.kind, CurrentRevisionRuleKind::Revision { .. })).count(),
            CurrentRevisionRuleKind::Revision { .. } => profiles.iter().filter(|other|
                other.origin.module == profile.origin.module && matches!(other.kind,
                    CurrentRevisionRuleKind::Template { revision, .. } if revision == profile.origin.model)).count(),
        };
        if companion != 1 {
            return None;
        }
    }
    let chat_fields = source::checked_chat_field_annotations(program, ir, db);
    collect_policies(
        ir,
        emitted_module,
        Some(&profiles),
        Some(&chat_fields),
        Some((program, db, catalog)),
    )
}

fn collect_policies(
    ir: &IrProgram,
    emitted_module: &str,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
) -> Option<LocalPolicies> {
    let mut checked_hooks = Vec::new();
    let mut operations = std::collections::HashSet::new();
    for item in &ir.items {
        let IrItemKind::Scenario {
            hook: Some(hook), ..
        } = &item.kind
        else {
            continue;
        };
        if !local_hook_supported(ir, item.id) {
            return None;
        }
        let model = ir.items.get(hook.model.0 as usize)?;
        let operation = format!("{}.{}", model.canonical, hook.op.as_str());
        if !operations.insert(operation.clone()) {
            return None;
        }
        checked_hooks.push((item, *hook, operation));
    }
    let mut descriptors = Vec::new();
    let mut bindings = Vec::new();
    let mut hook_bindings = Vec::new();
    let mut dependency_bindings = Vec::new();
    for model in &ir.items {
        let IrItemKind::Model {
            invariants, locks, ..
        } = &model.kind
        else {
            continue;
        };
        let model_hooks: Vec<_> = checked_hooks
            .iter()
            .filter(|(_, hook, _)| hook.model == model.id)
            .collect();
        if invariants.is_empty() && locks.is_empty() && model_hooks.is_empty() {
            continue;
        }
        let owner_package = ir.module(model.module).name.clone();
        let mut rules = Vec::new();
        for rule in ir.invariants.iter().filter(|rule| {
            rule.origin
                .as_ref()
                .is_some_and(|origin| origin.model == model.id)
        }) {
            let origin = rule.origin.as_ref()?;
            if origin.kind != IrModelRuleKind::Invariant
                || origin.module != model.module
                || !invariants.contains(&origin.registry_id)
            {
                return None;
            }
            let current_revision = checked_profiles
                .and_then(|profiles| profiles.iter().find(|profile| &profile.origin == origin))
                .cloned();
            let query_profile = if current_revision.is_none() {
                checked_context.and_then(|(program, db, catalog)| {
                    checked_query_rule_fields(program, ir, model.id, &rule.pred, db, catalog)
                })
            } else { None };
            if current_revision.is_none() && query_profile.is_none() {
                local_rule_fields(ir, model.id, &rule.pred)
                    .or_else(|| {
                        checked_context.and_then(|(program, db, catalog)| {
                            checked_local_rule_fields(
                                program, ir, model.id, &rule.pred, db, catalog,
                            )
                        })
                    })
                    .or_else(|| {
                        checked_profiles
                            .and_then(|_| required_model_rule_fields(ir, model.id, &rule.pred))
                    })
                    .or_else(|| {
                        checked_profiles
                            .and_then(|_| checked_chat_invariant_fields(ir, rule))
                            .filter(|fields| {
                                checked_chat_fields.is_some_and(|checked| {
                                    fields.iter().all(|field| checked.contains(field))
                                })
                            })
                    })?;
            }
            let id = format!("{owner_package}.{}", origin.registry_id);
            let mut dependencies = Vec::new();
            if let Some(CurrentRevisionRuleProfile {
                kind: CurrentRevisionRuleKind::Template { revision, .. },
                ..
            }) = &current_revision
            {
                let changed = ir.items.get(revision.0 as usize)?;
                let dependency_id = format!("{id}.current");
                dependencies.push(ModelDependency {
                    id: dependency_id.clone(),
                    model: changed.canonical.clone(),
                    max_targets: 1,
                });
                dependency_bindings.push(DependencyBinding {
                    id: dependency_id,
                    model: model.id,
                    owner_package: owner_package.clone(),
                    changed_model: *revision,
                    path: Vec::new(),
                    all_owners: false,
                });
            }
            if current_revision.is_none()
                && query_profile.is_none()
                && checked_profiles.is_some()
                && let Some(reads) = required_model_rule_dependencies(ir, model.id, &rule.pred)
            {
                for (index, (changed_model, path)) in reads.into_iter().enumerate() {
                    let dependency_id = format!("{id}.reference.{}", index + 1);
                    dependencies.push(ModelDependency {
                        id: dependency_id.clone(),
                        model: ir.items.get(changed_model.0 as usize)?.canonical.clone(),
                        max_targets: 200,
                    });
                    dependency_bindings.push(DependencyBinding {
                        id: dependency_id,
                        model: model.id,
                        owner_package: owner_package.clone(),
                        changed_model,
                        path,
                        all_owners: false,
                    });
                }
            }
            if let Some(profile) = &query_profile {
                for (index, changed_model) in profile.dependencies.iter().copied().enumerate() {
                    let dependency_id = format!("{id}.query.{}", index + 1);
                    dependencies.push(ModelDependency {
                        id: dependency_id.clone(),
                        model: ir.items.get(changed_model.0 as usize)?.canonical.clone(),
                        // The existing transaction bound remains authoritative.
                        max_targets: u32::MAX,
                    });
                    dependency_bindings.push(DependencyBinding {
                        id: dependency_id,
                        model: model.id,
                        owner_package: owner_package.clone(),
                        changed_model,
                        path: Vec::new(),
                        all_owners: true,
                    });
                }
            }
            rules.push((
                origin.ordinal,
                ModelRule::Invariant {
                    id: id.clone(),
                    dependencies,
                },
            ));
            bindings.push(PredicateBinding {
                id,
                model: model.id,
                owner_package: owner_package.clone(),
                kind: origin.kind,
                predicate: Some(rule.pred.clone()),
                current_revision,
                checked_body: query_profile.is_some(),
                query_models: query_profile
                    .map(|profile| profile.query_models)
                    .unwrap_or_default(),
            });
        }
        for rule in ir.locks.iter().filter(|rule| rule.origin.model == model.id) {
            let origin = &rule.origin;
            if origin.kind != IrModelRuleKind::Lock
                || origin.module != model.module
                || !locks.contains(&origin.registry_id)
            {
                return None;
            }
            if rule.fields.is_empty()
                || rule.fields.iter().any(|field| {
                    field.contains('.') || !ir.items.iter().any(|item| {
                    item.name == *field
                        && matches!(&item.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. } if *owner == model.id &&
                            (local_stored_field_type(ir, model.id, ty) || checked_profiles.is_some_and(|profiles|
                                checked_stored_lock_target(ir, model.id, item.id, field, ty)
                                    || (checked_chat_fields.is_some_and(|checked| checked.contains(&item.id))
                                    && checked_chat_lock_target(ir, model.id, item.id, field, ty))
                                    || profiles.iter().any(|profile| profile.origin.model == model.id
                                        && current_revision_lock_target(ir, profile, item.id, field, ty)))))
                })
                })
            {
                return None;
            }
            let lock_profile = if let Some(predicate) = &rule.when {
                let profile = checked_context.and_then(|(program, db, catalog)| {
                    checked_query_rule_fields(program, ir, model.id, predicate, db, catalog)
                });
                if profile.is_none() { local_rule_fields(ir, model.id, predicate)?; }
                profile
            } else { None };
            let id = format!("{owner_package}.{}", origin.registry_id);
            rules.push((
                origin.ordinal,
                ModelRule::Lock {
                    id: id.clone(),
                    fields: rule.fields.clone(),
                },
            ));
            bindings.push(PredicateBinding {
                id,
                model: model.id,
                owner_package: owner_package.clone(),
                kind: origin.kind,
                predicate: rule.when.clone(),
                current_revision: None,
                checked_body: lock_profile.is_some(),
                query_models: lock_profile.map(|profile| profile.query_models).unwrap_or_default(),
            });
        }
        if rules.len() != invariants.len() + locks.len() {
            return None;
        }
        rules.sort_by_key(|(ordinal, _)| *ordinal);
        let mut hooks = Vec::new();
        for (item, hook, operation) in model_hooks {
            hooks.push(ModelHook {
                id: item.canonical.clone(),
                op: match hook.op {
                    CrudOp::Create => "create",
                    CrudOp::Update => "update",
                    CrudOp::Delete => "remove",
                }
                .to_string(),
                operation: operation.clone(),
            });
            hook_bindings.push(HookBinding {
                id: item.canonical.clone(),
                model: model.id,
                owner_package: owner_package.clone(),
                operation: operation.clone(),
            });
        }
        descriptors.push(ModelPolicies {
            abi: "state.owner-model-policies@1",
            model: model.canonical.clone(),
            owner_package,
            module: emitted_module.to_string(),
            rules: rules.into_iter().map(|(_, rule)| rule).collect(),
            hooks,
        });
    }
    if descriptors.is_empty() {
        None
    } else {
        Some(LocalPolicies {
            descriptors,
            bindings,
            hook_bindings,
            dependency_bindings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::catalog::{CatalogRequest, load_catalog};
    use crate::analysis::{ResolvedType, Scalar, check_program};
    use crate::codegen::ir::{IrBinOp, IrDefault, IrExpr, IrOwner, IrServer};
    use crate::source::Span;

    const SOURCE: &str = include_str!("../../tests/fixtures/source-current-revision.can");
    fn checked() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/cloudflare/dist/native-catalog.json");
        let mut db = SourceDb::new();
        let file = db.add("current-revision.can".into(), SOURCE.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        (db, program, ir, catalog)
    }
    fn symbol(ir: &IrProgram, name: &str) -> SymbolId {
        ir.items
            .iter()
            .find(|item| item.canonical == format!("SourceCurrentRevision.{name}"))
            .unwrap()
            .id
    }
    const MODULE: &str = "$can$m$536f7572636543757272656e745265766973696f6e.mjs";

    #[test]
    fn checked_original_policies_publish_complete_rules_and_one_genuine_parent_dependency() {
        let (db, program, ir, catalog) = checked();
        let policies = collect_checked_policies(&program, &ir, &db, Some(&catalog), MODULE)
            .expect("complete source/fresh policy closure");
        assert_eq!(
            serde_json::to_value(&policies.descriptors).unwrap(),
            serde_json::json!([
                {"abi":"state.owner-model-policies@1","model":"SourceCurrentRevision.Template","ownerPackage":"SourceCurrentRevision","module":MODULE,
                 "rules":[{"kind":"invariant","id":"SourceCurrentRevision.Template.require.1","dependencies":[
                     {"id":"SourceCurrentRevision.Template.require.1.current","model":"SourceCurrentRevision.Revision","maxTargets":1}]},
                     {"kind":"lock","id":"SourceCurrentRevision.Template.lock.1","fields":["owner"]}],"hooks":[]},
                {"abi":"state.owner-model-policies@1","model":"SourceCurrentRevision.Revision","ownerPackage":"SourceCurrentRevision","module":MODULE,
                 "rules":[{"kind":"invariant","id":"SourceCurrentRevision.Revision.require.1","dependencies":[]},
                     {"kind":"lock","id":"SourceCurrentRevision.Revision.lock.1","fields":["number","definition","outputs","duration","validation"]},
                     {"kind":"lock","id":"SourceCurrentRevision.Revision.lock.2","fields":["published","digest"]}],"hooks":[]}
            ])
        );
        assert_eq!(policies.bindings.len(), 5);
        assert_eq!(
            policies
                .bindings
                .iter()
                .filter(|binding| binding.current_revision.is_some())
                .count(),
            2
        );
        assert_eq!(policies.dependency_bindings.len(), 1);
        let dependency = &policies.dependency_bindings[0];
        assert_eq!(
            dependency.id,
            "SourceCurrentRevision.Template.require.1.current"
        );
        assert_eq!(dependency.model, symbol(&ir, "Template"));
        assert_eq!(dependency.changed_model, symbol(&ir, "Revision"));
        assert_eq!(dependency.owner_package, "SourceCurrentRevision");
        assert!(policies.hook_bindings.is_empty());
        assert!(
            collect_local_policies(&ir, MODULE).is_none(),
            "raw IR has no source intake for this profile"
        );
    }

    #[test]
    fn all_original_rule_source_schema_default_server_parent_and_lock_mutants_refuse() {
        let (db, program, original, catalog) = checked();
        let template = symbol(&original, "Template");
        let revision = symbol(&original, "Revision");
        let current = symbol(&original, "Template.current");
        let definition = symbol(&original, "Revision.definition");
        let digest = symbol(&original, "Revision.digest");
        for mutation in [
            "ordinal",
            "kind",
            "source",
            "owner",
            "current-nullable",
            "parent",
            "default",
            "server",
            "schema",
            "delivery-target",
            "lock-order",
            "lock-omit",
            "condition",
            "predicate",
        ] {
            let mut ir = original.clone();
            match mutation {
                "ordinal" => ir.invariants[0].origin.as_mut().unwrap().ordinal += 1,
                "kind" => ir.invariants[0].origin.as_mut().unwrap().kind = IrModelRuleKind::Lock,
                "source" => ir.invariants[0].pred.span.start += 1,
                "owner" => {
                    ir.items[definition.0 as usize].module = crate::analysis::ModuleId(u32::MAX)
                }
                "current-nullable" => {
                    let IrItemKind::Field { ty, .. } = &mut ir.items[current.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *ty = IrType::Known(ResolvedType::Record {
                        symbol: revision,
                        stored: true,
                    });
                }
                "parent" => {
                    let IrItemKind::Model { owner, .. } = &mut ir.items[revision.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *owner = IrOwner::ChildOf(revision);
                }
                "default" => {
                    let span = ir.items[digest.0 as usize].span;
                    let IrItemKind::Field { default, .. } = &mut ir.items[digest.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *default = Some(IrDefault::Literal(TypedExpr::new(
                        IrExpr::Text("forged".into()),
                        ResolvedType::Scalar(Scalar::Text),
                        span,
                    )));
                }
                "server" => {
                    let IrItemKind::Field { server, .. } = &mut ir.items[digest.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *server = Some(IrServer::Actor);
                }
                "schema" => {
                    let IrItemKind::Field {
                        ty: IrType::Known(ResolvedType::StdNominal { fields, .. }),
                        ..
                    } = &mut ir.items[definition.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    fields.pop();
                }
                "delivery-target" => {
                    let validation = symbol(&ir, "Revision.validation");
                    let IrItemKind::Field { ty, .. } = &mut ir.items[validation.0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *ty = IrType::Known(ResolvedType::Nullable(Box::new(
                        ResolvedType::StdDelivery {
                            capability: "std.ImagesV1",
                            op: crate::analysis::catalog::std_operation("std.ImagesV1", "inspect")
                                .unwrap(),
                        },
                    )));
                }
                "lock-order" => ir.locks[1].fields.swap(0, 1),
                "lock-omit" => {
                    ir.locks[1].fields.pop();
                }
                "condition" => ir.locks[2].when = None,
                "predicate" => {
                    let IrExpr::Binary { op, .. } = &mut ir.invariants[0].pred.expr else {
                        unreachable!()
                    };
                    *op = IrBinOp::Or;
                }
                _ => unreachable!(),
            }
            assert!(
                collect_checked_policies(&program, &ir, &db, Some(&catalog), MODULE).is_none(),
                "{mutation}"
            );
        }
        let mut stale = SourceDb::new();
        stale.add(
            "current-revision.can".into(),
            SOURCE.replace("digest:text?", "digest:bool?"),
        );
        assert!(
            collect_checked_policies(&program, &original, &stale, Some(&catalog), MODULE).is_none()
        );
        assert!(collect_checked_policies(&program, &original, &db, None, MODULE).is_none());
        let mut missing = original.clone();
        missing
            .invariants
            .retain(|rule| rule.origin.as_ref().unwrap().model == template);
        assert!(
            collect_checked_policies(&program, &missing, &db, Some(&catalog), MODULE).is_none(),
            "mandatory companion omitted"
        );
    }

    #[test]
    fn whole_original_chat_policies_preserve_all_rules_and_refuse_corrupt_closure() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let source = include_str!("../../tests/fixtures/original-a850/CanChat.can");
        let mut db = SourceDb::new();
        let file = db.add("CanChat.can".into(), source.into());
        let path = root.join("packages/cloudflare/dist/native-catalog.json");
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let catalog = catalog.unwrap();
        let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (original, diagnostics) = ir::build(&program, &db, Some(&catalog));
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let module = super::super::js::module_path(&original.modules[0].name);
        let policies = collect_checked_policies(&program, &original, &db, Some(&catalog), &module)
            .expect("all four invariants and six locks from the original owning Chat source");
        assert_eq!(policies.descriptors.len(), 6);
        assert_eq!(policies.bindings.len(), 10);
        assert_eq!(
            policies
                .bindings
                .iter()
                .filter(|b| b.kind == IrModelRuleKind::Invariant)
                .count(),
            4
        );
        assert!(policies.dependency_bindings.is_empty());
        assert!(policies.hook_bindings.is_empty());
        assert!(policies.descriptors.iter().flat_map(|d| &d.rules).all(
            |r| !matches!(r, ModelRule::Invariant { dependencies, .. } if !dependencies.is_empty())
        ));
        assert!(collect_local_policies(&original, &module).is_none());
        let field = |name: &str| {
            original
                .items
                .iter()
                .find(|i| i.canonical == format!("chat.{name}"))
                .unwrap()
                .id
        };
        for mutation in [
            "role-schema",
            "message-schema",
            "request-schema",
            "delivery-target",
            "nullable-used",
            "origin",
            "ordinal",
            "predicate",
            "lock-order",
            "lock-omit",
            "missing-invariant",
            "missing-lock",
            "field-owner",
            "import",
            "field-source",
        ] {
            let mut ir = original.clone();
            match mutation {
                "role-schema" | "message-schema" | "request-schema" | "delivery-target"
                | "nullable-used" => {
                    let name = match mutation {
                        "role-schema" => "Turn.role",
                        "message-schema" => "Branch.prefix",
                        "request-schema" => "Run.request_value",
                        "delivery-target" => "Run.request",
                        _ => "Run.used",
                    };
                    let IrItemKind::Field { ty, .. } = &mut ir.items[field(name).0 as usize].kind
                    else {
                        unreachable!()
                    };
                    *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
                }
                "origin" => {
                    ir.invariants[0].origin.as_mut().unwrap().module =
                        crate::analysis::ModuleId(u32::MAX)
                }
                "ordinal" => ir.invariants[0].origin.as_mut().unwrap().ordinal += 1,
                "predicate" => {
                    let IrExpr::Binary { op, .. } = &mut ir.invariants[0].pred.expr else {
                        unreachable!()
                    };
                    *op = IrBinOp::Eq;
                }
                "lock-order" => ir.locks[0].fields.swap(0, 1),
                "lock-omit" => {
                    ir.locks[0].fields.pop();
                }
                "missing-invariant" => {
                    ir.invariants.pop();
                }
                "missing-lock" => {
                    ir.locks.pop();
                }
                "field-owner" => {
                    ir.items[field("Turn.role").0 as usize].module =
                        crate::analysis::ModuleId(u32::MAX)
                }
                "import" => ir
                    .modules
                    .iter_mut()
                    .find(|m| m.name == "chat")
                    .unwrap()
                    .imports
                    .clear(),
                "field-source" => ir.items[field("Turn.role").0 as usize].span.start += 1,
                _ => unreachable!(),
            }
            assert!(
                collect_checked_policies(&program, &ir, &db, Some(&catalog), &module).is_none(),
                "{mutation}"
            );
        }
        let mut stripped = original.clone();
        stripped
            .invariants
            .retain(|rule| rule.id == "Profile.require.1");
        stripped.locks.retain(|rule| rule.id == "Profile.lock.1");
        for item in &mut stripped.items {
            if let IrItemKind::Model {
                invariants, locks, ..
            } = &mut item.kind
            {
                invariants.retain(|id| id == "Profile.require.1");
                locks.retain(|id| id == "Profile.lock.1");
            }
        }
        assert!(collect_local_policies(&stripped, &module).is_some());
        assert!(
            collect_checked_policies(&program, &stripped, &db, Some(&catalog), &module).is_none(),
            "coherent rule withdrawal cannot publish a partial original policy set"
        );
        let mut stale = SourceDb::new();
        stale.add(
            "CanChat.can".into(),
            source.replace("row.used<=row.reserved", "row.used>=row.reserved"),
        );
        assert!(
            collect_checked_policies(&program, &original, &stale, Some(&catalog), &module)
                .is_none()
        );
        assert!(collect_checked_policies(&program, &original, &db, None, &module).is_none());
    }

    #[test]
    fn checked_required_paths_refuse_changed_receiver_parent_and_money_member() {
        let source = "app RequiredRules\nGiven\n Customer {active:bool}\n Contact in Customer {name:text}\n Location {currency:currency}\n Checked {customer:Customer,contact:Contact,location:Location,value:money}\n invariant Checked: row.contact.parent==row.customer and row.value.minor>=0 and row.value.currency==row.location.currency\nWhen\nThen\n";
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let mut db = SourceDb::new();
        let file = db.add("required-rules.can".into(), source.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (original, diagnostics) = ir::build(&program, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let module = super::super::js::module_path("RequiredRules");
        assert!(
            collect_checked_policies(&program, &original, &db, catalog.as_ref(), &module).is_some()
        );
        assert!(
            collect_local_policies(&original, &module).is_none(),
            "raw IR supplies no source-backed required-path admission"
        );
        fn change(value: &mut TypedExpr, corruption: usize) -> bool {
            if let IrExpr::Member { base, field } = &mut value.expr {
                if corruption == 0 && field == "minor" {
                    *field = "currency".into();
                    return true;
                }
                if corruption == 1 && field == "parent" {
                    *field = "customer".into();
                    return true;
                }
                if corruption == 2 && field == "location" {
                    base.expr = IrExpr::Name("copied".into());
                    return true;
                }
                return change(base, corruption);
            }
            if let IrExpr::Binary { left, right, .. } = &mut value.expr {
                return change(left, corruption) || change(right, corruption);
            }
            false
        }
        for corruption in 0..3 {
            let mut lowered = original.clone();
            assert!(change(&mut lowered.invariants[0].pred, corruption));
            assert!(
                collect_checked_policies(&program, &lowered, &db, catalog.as_ref(), &module)
                    .is_none(),
                "corruption {corruption}"
            );
        }
    }

    #[test]
    fn required_record_locks_need_original_fields_and_contract_order() {
        let source = "app NominalLocks\nGiven\n Account {active:bool}\n contract Reviewed {account:Account,notes:text}\n Stored {input:Reviewed,account:Account}\n lock Stored fields=input,account\nWhen\nThen\n";
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let path = root.join("packages/values/dist/catalog.json");
        let mut db = SourceDb::new();
        let file = db.add("nominal-locks.can".into(), source.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest {
            flag: Some(&path),
            env: None,
            cwd: root,
            primary: Span::new(file, 0, 0),
        });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (original, diagnostics) = ir::build(&program, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let module = super::super::js::module_path("NominalLocks");
        let policies =
            collect_checked_policies(&program, &original, &db, catalog.as_ref(), &module).unwrap();
        assert_eq!(policies.descriptors.len(), 1);
        assert!(
            matches!(&policies.descriptors[0].rules[0], ModelRule::Lock { fields, .. }
            if fields == &["input", "account"])
        );
        assert!(
            collect_local_policies(&original, &module).is_none(),
            "raw nominal types cannot supply original source authority"
        );
        for corruption in 0..2 {
            let mut changed = original.clone();
            if corruption == 0 {
                let account = changed
                    .items
                    .iter()
                    .find(|item| item.canonical == "NominalLocks.Account")
                    .unwrap()
                    .id;
                let input = changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "NominalLocks.Stored.input")
                    .unwrap();
                let IrItemKind::Field { ty, .. } = &mut input.kind else {
                    panic!("field");
                };
                *ty = IrType::Known(ResolvedType::Record {
                    symbol: account,
                    stored: true,
                });
            } else {
                let reviewed = changed
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "NominalLocks.Reviewed")
                    .unwrap();
                let IrItemKind::Contract { fields, .. } = &mut reviewed.kind else {
                    panic!("contract");
                };
                fields.swap(0, 1);
            }
            assert!(
                collect_checked_policies(&program, &changed, &db, catalog.as_ref(), &module)
                    .is_none(),
                "corruption {corruption}"
            );
        }
    }
    #[test]
    fn transitive_computed_rules_and_contained_lock_keep_dependencies_and_source() {
        let source = r#"app ComputedRules
Given
 Location {active:bool}
 Budget {total:money,locations:Location[],zone:timezone}
 Slot in Budget {state:enum(held,pending,confirmed),until:datetime}
 Request in Budget {amount:money,location:Location,actual:money?}
 Increase in Request {amount:money}
 Document in Budget {document:file}
 lock Document fields=document
 derive Request.authorized:money = row.amount+sum(row.Increase as increase select increase.amount,row.amount.currency)
 derive Budget.committed:money = sum(row.Request as request select request.authorized,row.total.currency)
 derive Budget.remaining:money = row.total-row.committed
 derive Budget.available:int = count(row.Slot as slot where slot.state==confirmed or (slot.state in [held,pending] and now<slot.until))
 invariant Budget: row.available>=0
 lock Budget fields=zone
 invariant Budget: row.remaining.minor>=0
 invariant Request: row.location in row.parent.locations and (row.actual ?? row.amount).currency==row.parent.total.currency
 lock Request fields=amount when=count(row.Increase)>0
When
Then
"#;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut db = SourceDb::new();
        let file = db.add("computed-rules.can".into(), source.into());
        let (catalog, diagnostics) = load_catalog(&CatalogRequest { flag: Some(&root.join("packages/cloudflare/dist/native-catalog.json")), env: None, cwd: root, primary: Span::new(file, 0, 0) });
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (mut program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let (original, diagnostics) = ir::build(&program, &db, catalog.as_ref());
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let module = super::super::js::module_path("ComputedRules");
        let policies = collect_checked_policies(&program, &original, &db, catalog.as_ref(), &module).expect("complete transitive policy closure");
        let model = |name: &str| original.items.iter().find(|item| item.canonical == format!("ComputedRules.{name}")).unwrap().id;
        let available = policies.bindings.iter().find(|binding| binding.id.ends_with("Budget.require.1")).unwrap();
        assert!(available.checked_body);
        assert_eq!(available.query_models, vec![model("Slot")]);
        assert!(policies.descriptors.iter().find(|policy| policy.model == "ComputedRules.Budget").unwrap().rules.iter()
            .any(|rule| matches!(rule, ModelRule::Lock { fields, .. } if fields == &["zone"])));
        let original_contexts = std::mem::take(&mut program.types.contextual_references);
        let missing_context_refuses = checked_query_rule_fields(&program, &original, model("Budget"), available.predicate.as_ref().unwrap(), &db, catalog.as_ref()).is_none();
        program.types.contextual_references = original_contexts;
        assert!(missing_context_refuses, "a same-spelled unbound clock cannot replace the checked frozen context");
        let budget = policies.bindings.iter().find(|binding| binding.id.ends_with("Budget.require.2")).unwrap();
        assert!(budget.checked_body);
        assert_eq!(budget.query_models, vec![model("Request"), model("Increase")]);
        let targets = policies.dependency_bindings.iter().filter(|binding| binding.id.contains("Budget.require.2")).map(|binding| { assert!(binding.all_owners); binding.changed_model }).collect::<Vec<_>>();
        assert_eq!(targets, vec![model("Request"), model("Increase")]);
        let lock = policies.bindings.iter().find(|binding| binding.id.ends_with("Request.lock.1")).unwrap();
        assert!(lock.checked_body);
        assert_eq!(lock.query_models, vec![model("Increase")]);
        for corruption in 0..2 {
            let mut changed = original.clone();
            let derived = changed.items.iter_mut().find(|item| item.canonical == "ComputedRules.Budget.remaining").unwrap();
            let IrItemKind::DeriveField { expr: Some(body), .. } = &mut derived.kind else { panic!("derived body"); };
            if corruption == 0 { body.expr = IrExpr::Int(0); }
            else { let IrExpr::Binary { op, .. } = &mut body.expr else { panic!("subtraction"); }; *op = IrBinOp::Add; }
            assert!(collect_checked_policies(&program, &changed, &db, catalog.as_ref(), &module).is_none(), "retained derived body corruption {corruption}");
        }
    }

}
