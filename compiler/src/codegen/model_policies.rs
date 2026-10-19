//! Checked local model-policy descriptors for the defining State owner ABI.
//! Unsupported declarations never acquire an empty dependency certificate.
use crate::analysis::resolve::{CrudOp, SymbolId};
use crate::analysis::{CheckedProgram, catalog::Catalog};
use crate::codegen::ir::{
    self, IrHook, IrItem, IrItemKind, IrLockFn, IrModelRuleKind, IrProgram, IrRuleFn, IrType,
    TypedExpr,
};
use crate::codegen::model_policy_profile::{
    CheckedQueryRuleProfile, CurrentRevisionRuleKind, CurrentRevisionRuleProfile,
    RequiredModelRuleDependency, checked_chat_invariant_fields, checked_chat_lock_target,
    checked_local_rule_fields, checked_query_rule_fields, checked_stored_lock_target,
    current_revision_lock_target, current_revision_rule_profile, local_hook_supported,
    local_rule_fields, local_stored_field_type, required_model_rule_dependencies,
    required_model_rule_fields,
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
    let (fresh, diagnostics) = ir::rebuild_policy_source(program, ir, db, catalog);
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

fn collect_hook_triggers(ir: &IrProgram) -> Option<Vec<(&IrItem, IrHook, String)>> {
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
    Some(checked_hooks)
}

fn resolve_rule_fallback(
    ir: &IrProgram,
    model: &IrItem,
    rule: &IrRuleFn,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
    current_revision: &Option<CurrentRevisionRuleProfile>,
    query_profile: &Option<CheckedQueryRuleProfile>,
) -> Option<()> {
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
    Some(())
}

fn push_template_dependency(
    ir: &IrProgram,
    model: &IrItem,
    owner_package: &str,
    id: &str,
    current_revision: &Option<CurrentRevisionRuleProfile>,
    dependencies: &mut Vec<ModelDependency>,
    dependency_bindings: &mut Vec<DependencyBinding>,
) -> Option<()> {
    if let Some(CurrentRevisionRuleProfile {
        kind: CurrentRevisionRuleKind::Template { revision, .. },
        ..
    }) = current_revision
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
            owner_package: owner_package.to_string(),
            changed_model: *revision,
            path: Vec::new(),
            all_owners: false,
        });
    }
    Some(())
}

fn push_reference_dependencies(
    ir: &IrProgram,
    model: &IrItem,
    owner_package: &str,
    id: &str,
    reads: Vec<RequiredModelRuleDependency>,
    dependencies: &mut Vec<ModelDependency>,
    dependency_bindings: &mut Vec<DependencyBinding>,
) -> Option<()> {
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
            owner_package: owner_package.to_string(),
            changed_model,
            path,
            all_owners: false,
        });
    }
    Some(())
}

fn push_query_dependencies(
    ir: &IrProgram,
    model: &IrItem,
    owner_package: &str,
    id: &str,
    profile: &CheckedQueryRuleProfile,
    dependencies: &mut Vec<ModelDependency>,
    dependency_bindings: &mut Vec<DependencyBinding>,
) -> Option<()> {
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
            owner_package: owner_package.to_string(),
            changed_model,
            path: Vec::new(),
            all_owners: true,
        });
    }
    Some(())
}

fn collect_invariant_rule(
    ir: &IrProgram,
    model: &IrItem,
    owner_package: &str,
    rule: &IrRuleFn,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
    invariants: &[String],
    rules: &mut Vec<(u32, ModelRule)>,
    bindings: &mut Vec<PredicateBinding>,
    dependency_bindings: &mut Vec<DependencyBinding>,
) -> Option<()> {
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
    resolve_rule_fallback(
        ir,
        model,
        rule,
        checked_profiles,
        checked_chat_fields,
        checked_context,
        &current_revision,
        &query_profile,
    )?;
    let id = format!("{owner_package}.{}", origin.registry_id);
    let mut dependencies = Vec::new();
    push_template_dependency(
        ir,
        model,
        owner_package,
        &id,
        &current_revision,
        &mut dependencies,
        dependency_bindings,
    )?;
    if current_revision.is_none()
        && query_profile.is_none()
        && checked_profiles.is_some()
        && let Some(reads) = required_model_rule_dependencies(ir, model.id, &rule.pred)
    {
        push_reference_dependencies(
            ir,
            model,
            owner_package,
            &id,
            reads,
            &mut dependencies,
            dependency_bindings,
        )?;
    }
    if let Some(profile) = &query_profile {
        push_query_dependencies(
            ir,
            model,
            owner_package,
            &id,
            profile,
            &mut dependencies,
            dependency_bindings,
        )?;
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
        owner_package: owner_package.to_string(),
        kind: origin.kind,
        predicate: Some(rule.pred.clone()),
        current_revision,
        checked_body: query_profile.is_some(),
        query_models: query_profile
            .map(|profile| profile.query_models)
            .unwrap_or_default(),
    });
    Some(())
}

fn collect_lock_rule(
    ir: &IrProgram,
    model: &IrItem,
    owner_package: &str,
    rule: &IrLockFn,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
    locks: &[String],
    rules: &mut Vec<(u32, ModelRule)>,
    bindings: &mut Vec<PredicateBinding>,
) -> Option<()> {
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
        owner_package: owner_package.to_string(),
        kind: origin.kind,
        predicate: rule.when.clone(),
        current_revision: None,
        checked_body: lock_profile.is_some(),
        query_models: lock_profile.map(|profile| profile.query_models).unwrap_or_default(),
    });
    Some(())
}

fn collect_model_policies(
    ir: &IrProgram,
    model: &IrItem,
    model_hooks: &[(&IrItem, IrHook, String)],
    emitted_module: &str,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
    descriptors: &mut Vec<ModelPolicies>,
    bindings: &mut Vec<PredicateBinding>,
    hook_bindings: &mut Vec<HookBinding>,
    dependency_bindings: &mut Vec<DependencyBinding>,
) -> Option<()> {
    let IrItemKind::Model {
        invariants, locks, ..
    } = &model.kind
    else {
        return Some(());
    };
    let model_hooks: Vec<_> = model_hooks
        .iter()
        .filter(|(_, hook, _)| hook.model == model.id)
        .collect();
    if invariants.is_empty() && locks.is_empty() && model_hooks.is_empty() {
        return Some(());
    }
    let owner_package = ir.module(model.module).name.clone();
    let mut rules = Vec::new();
    for rule in ir.invariants.iter().filter(|rule| {
        rule.origin
            .as_ref()
            .is_some_and(|origin| origin.model == model.id)
    }) {
        collect_invariant_rule(
            ir,
            model,
            &owner_package,
            rule,
            checked_profiles,
            checked_chat_fields,
            checked_context,
            invariants,
            &mut rules,
            bindings,
            dependency_bindings,
        )?;
    }
    for rule in ir.locks.iter().filter(|rule| rule.origin.model == model.id) {
        collect_lock_rule(
            ir,
            model,
            &owner_package,
            rule,
            checked_profiles,
            checked_chat_fields,
            checked_context,
            locks,
            &mut rules,
            bindings,
        )?;
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
    Some(())
}

fn collect_policies(
    ir: &IrProgram,
    emitted_module: &str,
    checked_profiles: Option<&[CurrentRevisionRuleProfile]>,
    checked_chat_fields: Option<&std::collections::HashSet<SymbolId>>,
    checked_context: Option<(&CheckedProgram, &SourceDb, Option<&Catalog>)>,
) -> Option<LocalPolicies> {
    let checked_hooks = collect_hook_triggers(ir)?;
    let mut descriptors = Vec::new();
    let mut bindings = Vec::new();
    let mut hook_bindings = Vec::new();
    let mut dependency_bindings = Vec::new();
    for model in &ir.items {
        collect_model_policies(
            ir,
            model,
            &checked_hooks,
            emitted_module,
            checked_profiles,
            checked_chat_fields,
            checked_context,
            &mut descriptors,
            &mut bindings,
            &mut hook_bindings,
            &mut dependency_bindings,
        )?;
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

