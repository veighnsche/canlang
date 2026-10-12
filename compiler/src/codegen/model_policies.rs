//! Checked local model-policy descriptors for the defining State owner ABI.
//! Unsupported declarations never acquire an empty dependency certificate.
use crate::analysis::resolve::{CrudOp, SymbolId};
use crate::analysis::{CheckedProgram, catalog::Catalog};
use crate::codegen::ir::{self, IrItemKind, IrModelRuleKind, IrProgram, IrType, TypedExpr};
use crate::codegen::model_policy_profile::{
    CurrentRevisionRuleKind, CurrentRevisionRuleProfile, current_revision_lock_target,
    current_revision_rule_profile, local_hook_supported, local_rule_fields,
    local_stored_field_type,
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
    collect_policies(ir, emitted_module, None)
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
    if let Some(existing) = collect_local_policies(ir, emitted_module) {
        return Some(existing);
    }
    let (fresh, diagnostics) = ir::build(program, db, catalog);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
        || !source::matches(program, ir, &fresh)
    {
        return None;
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
    collect_policies(ir, emitted_module, Some(&profiles))
}

fn collect_policies(
    ir: &IrProgram,
    emitted_module: &str,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
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
            if current_revision.is_none() {
                local_rule_fields(ir, model.id, &rule.pred)?;
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
                });
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
                                profiles.iter().any(|profile| profile.origin.model == model.id
                                    && current_revision_lock_target(ir, profile, item.id, field, ty)))))
                })
                })
            {
                return None;
            }
            if let Some(predicate) = &rule.when {
                local_rule_fields(ir, model.id, predicate)?;
            }
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
}
