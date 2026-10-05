//! Migration directive + predecessor checking (lane-01 analysis, B3-I1).
//!
//! [`check_migration`] validates one decoded [`MigrationData`] before
//! codegen lowers it to an interim-intake transition: the `from=`
//! predecessor must name a snapshot ([`E6010`]), and directives must be
//! consistent — each `before` model/field handled exactly once, each
//! target claimed at most once, rename/backfill targets declared in the
//! owner module ([`E6009`]).
//!
//! What the compiler CANNOT prove (no old-schema tables: the `.can`
//! source declares the DESIRED state only) is left to the runtime's
//! `validateTransition`, which owns the old tables: retained-model
//! rename collisions, retained-field collisions, and backfill liveness
//! beyond "declared and not dropped". Those are loud runtime rejections,
//! never silent.
//!
//! [`E6009`]: `E6009` migration directive conflict
//! [`E6010`]: `E6010` migration predecessor problem
//! [`MigrationData`]: crate::analysis::effects::MigrationData

use crate::analysis::NodeKey;
use crate::analysis::effects::{MigrationData, MigrationDirective};
use crate::diagnostic::Diagnostic;
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet};

/// Unit pins for checker branches the parser makes unreachable from
/// source (hand-built tables still route through them): missing `from`,
/// target-less renames, non-`before` sources, and empty invalidates.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceId;

    fn key() -> NodeKey {
        NodeKey {
            file: SourceId(0),
            start: 0,
            end: 1,
            kind: 0,
        }
    }

    fn migration(directives: Vec<MigrationDirective>) -> MigrationData {
        MigrationData {
            node: key(),
            owner: "Shop".to_string(),
            module: None,
            from: Some("s".to_string()),
            from_node: None,
            directives,
            descriptions: Vec::new(),
        }
    }

    fn codes_of(migration: &MigrationData) -> Vec<String> {
        check_migration(migration, None, &[])
            .iter()
            .map(|d| d.code.to_string())
            .collect()
    }

    #[test]
    fn missing_from_is_e6010() {
        let mut far = migration(Vec::new());
        far.from = None;
        let codes = codes_of(&far);
        assert!(codes.contains(&"E6010".to_string()), "{codes:?}");
    }

    #[test]
    fn targetless_rename_is_e6009() {
        let far = migration(vec![MigrationDirective::Rename {
            node: key(),
            from: "before.Todo".to_string(),
            to: None,
            owner_only: false,
        }]);
        let codes = codes_of(&far);
        assert!(codes.contains(&"E6009".to_string()), "{codes:?}");
    }

    #[test]
    fn non_before_source_is_e6009() {
        let far = migration(vec![MigrationDirective::Rename {
            node: key(),
            from: "Todo".to_string(),
            to: Some("Task".to_string()),
            owner_only: false,
        }]);
        let codes = codes_of(&far);
        assert!(codes.contains(&"E6009".to_string()), "{codes:?}");
    }

    #[test]
    fn empty_invalidate_is_e6009() {
        let far = migration(vec![MigrationDirective::Invalidate {
            node: key(),
            handler: String::new(),
        }]);
        let codes = codes_of(&far);
        assert!(codes.contains(&"E6009".to_string()), "{codes:?}");
    }

    #[test]
    fn unknown_owner_stands_down_existence_but_keeps_exactly_once() {
        // Owner unknown (None view): undeclared targets pass, but a
        // double-handle still fails.
        let ok = migration(vec![MigrationDirective::Rename {
            node: key(),
            from: "before.Todo".to_string(),
            to: Some("Missing".to_string()),
            owner_only: false,
        }]);
        let codes = codes_of(&ok);
        assert!(
            !codes.contains(&"E6009".to_string()),
            "existence stands down: {codes:?}"
        );
        let doubled = migration(vec![
            MigrationDirective::Rename {
                node: key(),
                from: "before.Todo".to_string(),
                to: Some("Task".to_string()),
                owner_only: false,
            },
            MigrationDirective::Drop {
                node: key(),
                target: Some("before.Todo".to_string()),
                owner_only: false,
            },
        ]);
        let codes = codes_of(&doubled);
        assert!(codes.contains(&"E6009".to_string()), "{codes:?}");
    }
}

/// One desired (declared) model of the migration owner module: local
/// name plus local field names. `None` at [`check_migration`] means the
/// owner names no module (an [`E6010`]); target-existence checks then
/// stand down while exactly-once checks still run.
#[derive(Debug, Clone)]
pub struct OwnerModelView {
    /// Local model name as declared.
    pub name: String,
    /// Local field names as declared.
    pub fields: Vec<String>,
}

fn span_of(node: &NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}

/// Split a `before.Model[.field]` source path into `(model, field?)`.
/// Returns `None` for anything outside the `before` namespace or with
/// more than two segments.
fn split_before(path: &str) -> Option<(String, Option<String>)> {
    let rest = path.strip_prefix("before.")?;
    if rest.is_empty() {
        return None;
    }
    let mut segments = rest.split('.');
    let model = segments.next().unwrap_or("").to_string();
    if model.is_empty() {
        return None;
    }
    let field = segments.next().map(str::to_string);
    if segments.next().is_some() {
        return None;
    }
    if field.as_deref().is_some_and(str::is_empty) {
        return None;
    }
    Some((model, field))
}

/// Whether `name` is a single path segment (a plain model/field name).
fn is_single_segment(name: &str) -> bool {
    !name.is_empty() && !name.contains('.')
}

/// Check one migration: predecessor ([`E6010`]) plus directive
/// consistency ([`E6009`]).
///
/// `owner_models` is the owner module's declared models (`None` when the
/// owner names no module); `prior` holds the `(owner, from)` pairs of
/// already-checked migrations for duplicate-predecessor detection.
pub fn check_migration(
    migration: &MigrationData,
    owner_models: Option<&[OwnerModelView]>,
    prior: &[(String, String)],
) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    let head = span_of(&migration.node);

    // --- E6010: predecessor -------------------------------------------------
    let from = match &migration.from {
        Some(from) if !from.is_empty() => Some(from.clone()),
        _ => {
            let at = migration.from_node.as_ref().map(span_of).unwrap_or(head);
            diags.push(Diagnostic::error(
                "E6010",
                format!(
                    "migration {} declares no from= predecessor snapshot",
                    migration.owner
                ),
                at,
            ));
            None
        }
    };
    if owner_models.is_none() {
        diags.push(Diagnostic::error(
            "E6010",
            format!(
                "migration owner {} names no app or package module",
                migration.owner
            ),
            head,
        ));
    }
    if let Some(from) = &from
        && prior
            .iter()
            .any(|(owner, prev)| owner == &migration.owner && prev == from)
    {
        diags.push(Diagnostic::error(
            "E6010",
            format!(
                "duplicate migration {} from snapshot {from:?}: one transition per predecessor",
                migration.owner
            ),
            head,
        ));
    }

    // Declared-model lookup (empty when the owner is unknown: existence
    // checks stand down, exactly-once checks still run).
    let declared: BTreeMap<&str, BTreeSet<&str>> = owner_models
        .unwrap_or(&[])
        .iter()
        .map(|model| {
            (
                model.name.as_str(),
                model.fields.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    let owner_known = owner_models.is_some();

    // --- Pass 1: owner directives -------------------------------------------
    let mut owner_ops: Vec<(&str, Span)> = Vec::new();
    let mut structural = 0usize;
    for directive in &migration.directives {
        match directive {
            MigrationDirective::Rename {
                node, owner_only, ..
            } if *owner_only => {
                owner_ops.push(("rename", span_of(node)));
            }
            MigrationDirective::Drop {
                node, owner_only, ..
            } if *owner_only => {
                owner_ops.push(("drop", span_of(node)));
            }
            _ => structural += 1,
        }
    }
    let renames = owner_ops.iter().filter(|(op, _)| *op == "rename").count();
    let drops = owner_ops.iter().filter(|(op, _)| *op == "drop").count();
    if renames > 0 && drops > 0 {
        diags.push(Diagnostic::error(
            "E6009",
            format!(
                "migration {} cannot both rename and drop its owner",
                migration.owner
            ),
            owner_ops[0].1,
        ));
    } else if owner_ops.len() > 1 {
        diags.push(Diagnostic::error(
            "E6009",
            format!("migration {} handles its owner twice", migration.owner),
            owner_ops[1].1,
        ));
    }
    if drops > 0 && structural > 0 {
        diags.push(Diagnostic::error(
            "E6009",
            format!(
                "migration {} drops its owner and takes no model, field, or backfill directives",
                migration.owner
            ),
            head,
        ));
    }

    // --- Pass 2: exactly-once + targets --------------------------------------
    // Consumed before-models: model -> handling verb (first-use order).
    let mut consumed_models: BTreeMap<String, &str> = BTreeMap::new();
    // Consumed before-fields: (model, field) -> handling verb.
    let mut consumed_fields: BTreeMap<(String, String), &str> = BTreeMap::new();
    // Claimed rename targets: target model -> source model.
    let mut rename_targets: BTreeMap<String, String> = BTreeMap::new();
    // Claimed rename-field targets: (target model, target field) -> source.
    let mut field_targets: BTreeMap<(String, String), String> = BTreeMap::new();
    // Model rename sources: old model -> target model.
    let mut rename_sources: BTreeMap<String, String> = BTreeMap::new();
    let mut backfills: BTreeSet<String> = BTreeSet::new();

    for directive in &migration.directives {
        match directive {
            MigrationDirective::Rename {
                node,
                from,
                to,
                owner_only,
            } => {
                if *owner_only {
                    continue;
                }
                let at = span_of(node);
                let Some((model, field)) = split_before(from) else {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!(
                            "migration rename source {from:?} must be before.<model>[.<field>]"
                        ),
                        at,
                    ));
                    continue;
                };
                let Some(to) = to else {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!("migration rename of before.{model} needs a target"),
                        at,
                    ));
                    continue;
                };
                match field {
                    None => {
                        if !is_single_segment(to) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration rename target {to:?} must be a plain model name"
                                ),
                                at,
                            ));
                            continue;
                        }
                        if let Some(prior) = consumed_models.get(&model) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration handles before.{model} twice ({prior}, renameModel)"
                                ),
                                at,
                            ));
                            continue;
                        }
                        consumed_models.insert(model.clone(), "renameModel");
                        if let Some(prior) = rename_targets.get(to) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration target {to:?} has two sources ({prior:?}, {model:?})"
                                ),
                                at,
                            ));
                            continue;
                        }
                        if to == &model {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!("migration renames before.{model} onto itself"),
                                at,
                            ));
                            continue;
                        }
                        if owner_known && !declared.contains_key(to.as_str()) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!("migration renameModel targets undeclared model {to:?}"),
                                at,
                            ));
                            continue;
                        }
                        rename_targets.insert(to.clone(), model.clone());
                        rename_sources.insert(model, to.clone());
                    }
                    Some(field) => {
                        if consumed_models
                            .get(&model)
                            .is_some_and(|kind| *kind == "dropModel")
                        {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration field directive targets dropped model before.{model}"
                                ),
                                at,
                            ));
                            continue;
                        }
                        if let Some(prior) = consumed_fields.get(&(model.clone(), field.clone())) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration handles before.{model}.{field} twice ({prior}, renameField)"
                                ),
                                at,
                            ));
                            continue;
                        }
                        consumed_fields.insert((model.clone(), field.clone()), "renameField");
                        let target = rename_sources.get(&model).cloned().unwrap_or(model.clone());
                        // Field-rename targets spell `Model.field` (the
                        // parser enforces the two segments); a lone field
                        // reads against the resolved target model.
                        let (to_model, to_field) = match to.split_once('.') {
                            Some((m, f)) => (m.to_string(), f.to_string()),
                            None => (target.clone(), to.clone()),
                        };
                        if to_model != target {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration renameField target {to:?} names model {to_model:?}, expected the resolved target {target:?}"
                                ),
                                at,
                            ));
                            continue;
                        }
                        if owner_known {
                            match declared.get(target.as_str()) {
                                Some(fields) if fields.contains(to_field.as_str()) => {}
                                _ => {
                                    diags.push(Diagnostic::error(
                                        "E6009",
                                        format!(
                                            "migration renameField maps to undeclared field {to_field:?} on model {target:?}"
                                        ),
                                        at,
                                    ));
                                    continue;
                                }
                            }
                        }
                        let key = (target.clone(), to_field.clone());
                        if let Some(prior) = field_targets.get(&key) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration target field {target:?}.{to_field:?} has two sources ({prior:?}, before.{model}.{field})"
                                ),
                                at,
                            ));
                            continue;
                        }
                        field_targets.insert(key, format!("before.{model}.{field}"));
                    }
                }
            }
            MigrationDirective::Drop {
                node,
                target,
                owner_only,
            } => {
                if *owner_only {
                    continue;
                }
                let at = span_of(node);
                let Some(target) = target else {
                    diags.push(Diagnostic::error(
                        "E6009",
                        "migration drop needs a before.<model>[.<field>] target".to_string(),
                        at,
                    ));
                    continue;
                };
                let Some((model, field)) = split_before(target) else {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!(
                            "migration drop target {target:?} must be before.<model>[.<field>]"
                        ),
                        at,
                    ));
                    continue;
                };
                match field {
                    None => {
                        if let Some(prior) = consumed_models.get(&model) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration handles before.{model} twice ({prior}, dropModel)"
                                ),
                                at,
                            ));
                            continue;
                        }
                        consumed_models.insert(model.clone(), "dropModel");
                        if owner_known && declared.contains_key(model.as_str()) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration drops model {model:?} but desired models still declare it"
                                ),
                                at,
                            ));
                        }
                    }
                    Some(field) => {
                        if consumed_models
                            .get(&model)
                            .is_some_and(|kind| *kind == "dropModel")
                        {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration field directive targets dropped model before.{model}"
                                ),
                                at,
                            ));
                            continue;
                        }
                        if let Some(prior) = consumed_fields.get(&(model.clone(), field.clone())) {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration handles before.{model}.{field} twice ({prior}, dropField)"
                                ),
                                at,
                            ));
                            continue;
                        }
                        consumed_fields.insert((model.clone(), field.clone()), "dropField");
                        let target = rename_sources.get(&model).cloned().unwrap_or(model.clone());
                        if owner_known
                            && declared
                                .get(target.as_str())
                                .is_some_and(|fields| fields.contains(field.as_str()))
                        {
                            diags.push(Diagnostic::error(
                                "E6009",
                                format!(
                                    "migration drops field {model:?}.{field:?} but desired models still declare it"
                                ),
                                at,
                            ));
                        }
                    }
                }
            }
            MigrationDirective::Invalidate { node, handler } => {
                let at = span_of(node);
                if handler.is_empty() {
                    diags.push(Diagnostic::error(
                        "E6009",
                        "migration invalidate needs a before.<handler> path".to_string(),
                        at,
                    ));
                } else if !handler.starts_with("before.") {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!(
                            "migration invalidate handler {handler:?} must be before.<handler>"
                        ),
                        at,
                    ));
                }
            }
            MigrationDirective::Backfill { node, model, .. } => {
                let at = span_of(node);
                if !is_single_segment(model) {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!("migration backfill target {model:?} must be a plain model name"),
                        at,
                    ));
                    continue;
                }
                if owner_known && !declared.contains_key(model.as_str()) {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!("migration backfill names undeclared model {model:?}"),
                        at,
                    ));
                    continue;
                }
                if !backfills.insert(model.clone()) {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!("migration backfills model {model:?} twice"),
                        at,
                    ));
                    continue;
                }
                if consumed_models
                    .get(model)
                    .is_some_and(|kind| *kind == "dropModel")
                {
                    diags.push(Diagnostic::error(
                        "E6009",
                        format!("migration backfill for dropped model {model:?}"),
                        at,
                    ));
                }
            }
        }
    }
    diags
}
