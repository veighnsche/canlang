//! Checked local model-policy descriptors for the defining State owner ABI.
//! Unsupported declarations never acquire an empty dependency certificate.
use crate::analysis::resolve::SymbolId;
use crate::codegen::ir::{IrItemKind, IrModelRuleKind, IrProgram, IrType, TypedExpr};
use crate::codegen::model_policy_profile::{local_rule_fields, local_stored_field_type};
use serde::Serialize;

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
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPolicies {
    pub descriptors: Vec<ModelPolicies>,
    pub bindings: Vec<PredicateBinding>,
}

/// A missing result preserves activation refusal for the entire source unit.
/// There is no partial declaration coverage or guessed reverse selector.
pub(crate) fn collect_local_policies(
    ir: &IrProgram,
    emitted_module: &str,
) -> Option<LocalPolicies> {
    if ir
        .items
        .iter()
        .any(|item| matches!(item.kind, IrItemKind::Scenario { hook: Some(_), .. }))
    {
        return None;
    }
    let mut descriptors = Vec::new();
    let mut bindings = Vec::new();
    for model in &ir.items {
        let IrItemKind::Model {
            invariants, locks, ..
        } = &model.kind
        else {
            continue;
        };
        if invariants.is_empty() && locks.is_empty() {
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
            local_rule_fields(ir, model.id, &rule.pred)?;
            let id = format!("{owner_package}.{}", origin.registry_id);
            rules.push((
                origin.ordinal,
                ModelRule::Invariant {
                    id: id.clone(),
                    dependencies: Vec::new(),
                },
            ));
            bindings.push(PredicateBinding {
                id,
                model: model.id,
                owner_package: owner_package.clone(),
                kind: origin.kind,
                predicate: Some(rule.pred.clone()),
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
                        && matches!(&item.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. } if *owner == model.id && local_stored_field_type(ir, model.id, ty))
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
            });
        }
        if rules.len() != invariants.len() + locks.len() {
            return None;
        }
        rules.sort_by_key(|(ordinal, _)| *ordinal);
        descriptors.push(ModelPolicies {
            abi: "state.owner-model-policies@1",
            model: model.canonical.clone(),
            owner_package,
            module: emitted_module.to_string(),
            rules: rules.into_iter().map(|(_, rule)| rule).collect(),
            hooks: Vec::new(),
        });
    }
    if descriptors.is_empty() {
        None
    } else {
        Some(LocalPolicies {
            descriptors,
            bindings,
        })
    }
}
