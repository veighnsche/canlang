//! Source-owned runtime resource inventory. Selection filters owner closure;
//! deployment names never confer invocation or storage authority.
use super::ir::{IrItemKind, IrProgram, IrType};
use crate::analysis::resolve::ModuleKind;
use crate::analysis::types::{ResolvedType, Scalar};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeBinding {
    pub owner: String,
    pub name: String,
    pub binding: String,
    #[serde(flatten)]
    pub declaration: RuntimeBindingDeclaration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum RuntimeBindingDeclaration {
    #[serde(rename = "durable-object")]
    DurableObject { key: String },
    #[serde(rename = "queue")]
    Queue {
        r#type: String,
        handlers: Vec<String>,
        /// Retain the checked type for original event schema emission only.
        #[serde(skip)]
        resolved_type: ResolvedType,
    },
    #[serde(rename = "kv")]
    Cache {
        #[serde(rename = "ttlMilliseconds")]
        ttl_milliseconds: String,
    },
    #[serde(rename = "analytics-engine")]
    Analytics { schema: Vec<RuntimeBindingField> },
    #[serde(rename = "service")]
    Service { from: String, capability: String },
    #[serde(rename = "r2")]
    R2 { implicit: bool },
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeBindingField {
    pub name: String,
    pub r#type: String,
}

fn has_file(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(Scalar::File) => true,
        ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
            has_file(inner)
        }
        ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => {
            fields.iter().any(|(_, ty)| has_file(ty))
        }
        _ => false,
    }
}

pub fn owners(ir: &IrProgram, app: &str) -> Vec<String> {
    let mut pending = vec![app.to_string()];
    let mut owners = HashSet::new();
    while let Some(owner) = pending.pop() {
        if !owners.insert(owner.clone()) {
            continue;
        }
        let Some(module) = ir.modules.iter().find(|module| module.name == owner) else {
            continue;
        };
        pending.extend(module.uses_resolved.clone());
        pending.extend(
            module
                .imports
                .iter()
                .filter(|import| import.from.is_none())
                .map(|import| import.provider.clone()),
        );
    }
    ir.modules
        .iter()
        .filter(|module| owners.contains(&module.name))
        .map(|module| module.name.clone())
        .collect()
}

/// A bound import may also carry ordinary schemas. Only the owning capability
/// or judgment declaration defines an executable service binding.
pub(super) fn bound_import_kind(ir: &IrProgram, provider: &str, name: &str) -> Option<&'static str> {
    if provider == "std" && crate::analysis::catalog::std_capability(name).is_some() {
        return Some("capability");
    }
    let canonical = format!("{provider}.{name}");
    match &ir.items.iter().find(|item| item.canonical == canonical)?.kind {
        IrItemKind::Capability { .. } => Some("capability"),
        IrItemKind::Judgment { .. } => Some("judgment"),
        _ => None,
    }
}

pub fn inventory(ir: &IrProgram) -> Vec<RuntimeBinding> {
    let mut bindings = Vec::new();
    for module in &ir.modules {
        bindings.extend(module.runtime_bindings.clone());
        for import in &module.imports {
            let Some(from) = &import.from else { continue };
            for (name, alias, _) in &import.members {
                if bound_import_kind(ir, &import.provider, name).is_none() { continue; }
                bindings.push(RuntimeBinding {
                    owner: module.name.clone(),
                    name: alias.clone(),
                    binding: format!("{}.{}", module.name, alias),
                    declaration: RuntimeBindingDeclaration::Service {
                        from: from.clone(),
                        capability: format!("{}.{}", import.provider, name),
                    },
                });
            }
        }
    }
    // Follow unbound runtime imports and product composition only. Bound
    // capability schemas describe an external service, not installed storage.
    for app in ir.modules.iter().filter(|module| {
        matches!(
            module.kind,
            ModuleKind::ImplicitApp | ModuleKind::ComposedApp
        )
    }) {
        let owners: HashSet<_> = owners(ir, &app.name).into_iter().collect();
        let uses_files = ir.items.iter().any(|item| {
            owners.contains(&ir.module(item.module).name)
                && match &item.kind {
                    IrItemKind::Field {
                        ty: IrType::Known(ty),
                        ..
                    }
                    | IrItemKind::Param {
                        ty: IrType::Known(ty),
                        ..
                    } => has_file(ty),
                    IrItemKind::Scenario {
                        result: Some(ty), ..
                    }
                    | IrItemKind::DeriveFn {
                        result: IrType::Known(ty),
                        ..
                    } => has_file(ty),
                    _ => false,
                }
        });
        if uses_files {
            bindings.push(RuntimeBinding {
                owner: app.name.clone(),
                name: "FILES".into(),
                binding: "FILES".into(),
                declaration: RuntimeBindingDeclaration::R2 { implicit: true },
            });
        }
    }
    bindings
}
