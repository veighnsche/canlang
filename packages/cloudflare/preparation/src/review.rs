//! Deploy review (P06.2): diff-vs-previous, previous-plan shape
//! check, preview print. Pure port of `review.ts` (`diffPlans`,
//! `isDeployPlan`, `formatPreview`); file reads stay host-side
//! (`loadPreviousPlan`'s ENOENT/parse arms) while the shape check and
//! the keyed diff run here. Unknown previous-plan fields stay
//! permitted: only the `{ wrangler, schedules }` spine plus the
//! nested shapes the projection traverses are validated.
//!
//! Line templates interpolate values exactly like TS (raw `String()`
//! rendering, `JSON.stringify` for var values); key equality is
//! UTF-16-unit equality (exact `Map`/`Set` string semantics,
//! duplicates included). Nested-shape garbage fails closed with the
//! stable review voice (TS throws engine-dependent `TypeError`s
//! there); value-level variation is exact for every input.

#![allow(dead_code)]

use crate::input::{js_string, obj_get, render_text, Node};
use crate::render::{json_stringify, render_wrangler_toml, RenderError};

/// Keyed diff result (mirrors `PlanDiff`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanDiff {
    pub changed: bool,
    pub lines: Vec<String>,
}

/// One review refusal. Only reachable for host-contract-violating
/// input (core-built plans and canonical sidecars always diff).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewError {
    pub message: String,
}

fn refuse(message: String) -> ReviewError {
    ReviewError { message }
}

/// Previous-plan shape check (mirrors `isDeployPlan` + its throw in
/// `loadPreviousPlan`): a non-array object with an object `wrangler`
/// and an array `schedules`. `path` names the sidecar in the message.
pub fn check_previous_plan(node: &Node, path: &str) -> Result<(), ReviewError> {
    let valid = match node {
        Node::Obj(_) => {
            let wrangler_ok = matches!(obj_get(node, "wrangler"), Some(Node::Obj(_)));
            // Note: TS only requires `typeof wrangler === "object"`
            // (arrays pass!); arrays are objects with no string keys,
            // so traversal below treats them as empty. Match that:
            // accept arrays here, handle them in projection.
            let wrangler_ok =
                wrangler_ok || matches!(obj_get(node, "wrangler"), Some(Node::Arr(_)));
            let schedules_ok = matches!(obj_get(node, "schedules"), Some(Node::Arr(_)));
            wrangler_ok && schedules_ok
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(refuse(format!(
            "deploy review: previous plan {path} is not a DeployPlan (want {{ wrangler, schedules }})"
        )))
    }
}

struct ProjectedLine {
    key: String,
    line: String,
}

/// Template interpolation of one field: objects read the field
/// (`undefined` when absent); primitives read `undefined`; null
/// throws (like the TS property access). The caller pre-checks the
/// entry itself; this covers the field read.
fn prop(entry: &Node, key: &str) -> Result<String, ReviewError> {
    if matches!(entry, Node::Null) {
        return Err(refuse(
            "deploy review: plan entry must be an object".to_string(),
        ));
    }
    match entry {
        Node::Obj(_) => Ok(obj_get(entry, key)
            .map(js_string)
            .unwrap_or_else(|| "undefined".to_string())),
        _ => Ok("undefined".to_string()),
    }
}

/// `for..of` over a binding list: arrays yield items, strings yield
/// their code points as texts (strings are iterable), anything else
/// throws (like the TS iteration).
fn iter_list(node: &Node, which: &str, path: &str) -> Result<Vec<Node>, ReviewError> {
    match node {
        Node::Arr(items) => Ok(items.clone()),
        Node::Text(units) => Ok(units.iter().map(|u| Node::Text(vec![*u])).collect()),
        _ => Err(refuse(format!(
            "deploy review: {which} {path} must be an array"
        ))),
    }
}

/// Canonical line projection in fixed order (mirrors `project`).
/// `which` names the plan in refusal messages (`plan` / `previous
/// plan`). Values render exactly at every shape; structure the
/// traversal needs is guarded.
fn project(plan: &Node, which: &str) -> Result<Vec<ProjectedLine>, ReviewError> {
    let bad = |what: &str| refuse(format!("deploy review: {which} {what}"));
    let wrangler = match plan {
        Node::Obj(_) => obj_get(plan, "wrangler").unwrap_or(&Node::Null),
        // TS reads `.wrangler` then `.name`: null plans throw on the
        // first access, primitives on the second. All throw.
        _ => return Err(bad("is not a DeployPlan (want { wrangler, schedules })")),
    };
    // Arrays pass `typeof === "object"` but throw at the first list;
    // require objects strictly (same outcome class, stable text).
    if !matches!(wrangler, Node::Obj(_)) {
        return Err(bad("wrangler must be an object"));
    }
    let mut out = vec![ProjectedLine {
        key: "worker".to_string(),
        line: format!(
            "worker {} main={} compat={}",
            prop(wrangler, "name")?,
            prop(wrangler, "main")?,
            prop(wrangler, "compatibility_date")?
        ),
    }];
    // `Object.keys(vars).sort()`: objects yield keys, arrays and
    // strings yield indices, other scalars yield nothing, null
    // throws. (Same entries as the spread rule.)
    let vars = obj_get(wrangler, "vars").unwrap_or(&Node::Null);
    if matches!(vars, Node::Null) {
        return Err(bad("wrangler.vars must be an object"));
    }
    let mut var_entries = crate::plan::spread_vars(vars);
    var_entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, value) in &var_entries {
        out.push(ProjectedLine {
            key: format!("var:{}", render_text(name)),
            line: format!("var {}={}", render_text(name), json_stringify(value)),
        });
    }
    // Fixed projection order: d1, r2, do, queue, service, ae.
    for (field_name, prefix) in [("d1_databases", "d1"), ("r2_buckets", "r2")] {
        let list = obj_get(wrangler, field_name).unwrap_or(&Node::Null);
        for entry in iter_list(list, which, &format!("wrangler.{field_name}"))? {
            let binding = prop(&entry, "binding")?;
            let line = if prefix == "d1" {
                format!(
                    "d1 {binding} name={} id={}",
                    prop(&entry, "database_name")?,
                    prop(&entry, "database_id")?
                )
            } else {
                format!("r2 {binding} name={}", prop(&entry, "bucket_name")?)
            };
            out.push(ProjectedLine {
                key: format!("{prefix}:{binding}"),
                line,
            });
        }
    }
    for (container, items_key, prefix) in [
        ("durable_objects", "bindings", "do"),
        ("queues", "producers", "queue"),
    ] {
        let node = obj_get(wrangler, container).unwrap_or(&Node::Null);
        if !matches!(node, Node::Obj(_)) {
            return Err(bad(&format!("wrangler.{container} must be an object")));
        }
        let list = obj_get(node, items_key).unwrap_or(&Node::Null);
        for entry in iter_list(list, which, &format!("wrangler.{container}.{items_key}"))? {
            let (key_field, line) = if prefix == "do" {
                let name = prop(&entry, "name")?;
                (
                    name.clone(),
                    format!("do {name} class={}", prop(&entry, "class_name")?),
                )
            } else {
                let binding = prop(&entry, "binding")?;
                (
                    binding.clone(),
                    format!("queue {binding} queue={}", prop(&entry, "queue")?),
                )
            };
            out.push(ProjectedLine {
                key: format!("{prefix}:{key_field}"),
                line,
            });
        }
    }
    for (field_name, prefix) in [("services", "service"), ("analytics_engine_datasets", "ae")] {
        let list = obj_get(wrangler, field_name).unwrap_or(&Node::Null);
        for entry in iter_list(list, which, &format!("wrangler.{field_name}"))? {
            let binding = prop(&entry, "binding")?;
            let line = if prefix == "service" {
                format!("service {binding} service={}", prop(&entry, "service")?)
            } else {
                format!("ae {binding} dataset={}", prop(&entry, "dataset")?)
            };
            out.push(ProjectedLine {
                key: format!("{prefix}:{binding}"),
                line,
            });
        }
    }
    let schedules = obj_get(plan, "schedules").unwrap_or(&Node::Null);
    for schedule in iter_list(schedules, which, "schedules")? {
        // Null schedules throw on `.handler` (like the TS access).
        if matches!(schedule, Node::Null) {
            return Err(bad("schedules must list schedule objects"));
        }
        let handler = prop(&schedule, "handler")?;
        out.push(ProjectedLine {
            key: format!("schedule:{handler}"),
            line: format!("schedule {handler} (unmapped OPEN-139)"),
        });
    }
    Ok(out)
}

/// Diff `next` against `previous` (`None` = first deploy: every line
/// `+`). Deterministic: next-plan order for `+`/`~`, previous-plan
/// order for `-`. Duplicate keys behave exactly like the TS
/// Map/Set loop (no dedup assumptions).
pub fn diff_plans(previous: Option<&Node>, next: &Node) -> Result<PlanDiff, ReviewError> {
    let next_lines = project(next, "plan")?;
    let Some(prev) = previous else {
        return Ok(PlanDiff {
            changed: !next_lines.is_empty(),
            lines: next_lines
                .iter()
                .map(|entry| format!("+ {}", entry.line))
                .collect(),
        });
    };
    let prev_lines = project(prev, "previous plan")?;
    let prev_by_key: std::collections::HashMap<&str, &str> = prev_lines
        .iter()
        .map(|entry| (entry.key.as_str(), entry.line.as_str()))
        .collect();
    let next_keys: std::collections::HashSet<&str> =
        next_lines.iter().map(|entry| entry.key.as_str()).collect();
    let mut lines: Vec<String> = Vec::new();
    for entry in &next_lines {
        match prev_by_key.get(entry.key.as_str()) {
            None => lines.push(format!("+ {}", entry.line)),
            Some(old) => {
                if *old != entry.line.as_str() {
                    lines.push(format!("~ {}: {} -> {}", entry.key, old, entry.line));
                }
            }
        }
    }
    for entry in &prev_lines {
        if !next_keys.contains(entry.key.as_str()) {
            lines.push(format!("- {}", entry.line));
        }
    }
    Ok(PlanDiff {
        changed: !lines.is_empty(),
        lines,
    })
}

/// Human-reviewable preview (mirrors `formatPreview`): the header,
/// the rendered TOML, then the diff body.
pub fn format_preview(plan: &Node, diff: &PlanDiff) -> Result<String, RenderError> {
    let header = if diff.changed {
        format!(
            "deploy preview: {} change(s) vs previous plan",
            diff.lines.len()
        )
    } else {
        "deploy preview: no changes vs previous plan".to_string()
    };
    let body = if diff.changed {
        diff.lines.join("\n")
    } else {
        "(identical)".to_string()
    };
    Ok(format!("{header}\n\n{}changes:\n{body}\n", {
        let toml = render_wrangler_toml(plan)?;
        format!("{toml}\n")
    }))
}
