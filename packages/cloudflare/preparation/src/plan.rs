//! Resource resolution + deploy-plan calculations (P06.1).
//!
//! Pure port of `deploy/plan.ts` (`buildDeployPlan`): deterministic
//! plan generation over owner-produced descriptor/environment facts
//! plus host-built options. Output is a `Node` tree with exact TS
//! insertion order (P06.2 renders/diffs from it); schedules pass
//! through unmapped and the bundle ref (or null) is preserved.
//!
//! Value semantics (comparisons, interpolation, kind dispatch, vars
//! spread, entry cloning) are exact TS for EVERY input shape. The
//! shapes the host loaders guarantee (objects/arrays at the
//! traversed positions) are guarded with the loaders' verbatim
//! messages — mirroring what the host would have said — because the
//! TS failures there are engine-version-dependent `TypeError` text
//! no port can match. Option keys are required (the host always
//! builds them; see `PlanError`).

// Staged: P06.3 wires this into the job loop; differential tests
// already pin the calculation contract. Remove when consumed.
#![allow(dead_code)]

use crate::input::{as_arr, as_obj, js_string, obj_get, Node};

/// One plan refusal, message-identical to the TS throw for every
/// TS-stable case (see module docs for the guarded shapes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub message: String,
}

/// JS `===` over reachable nodes: same-type scalar equality
/// (numbers by f64 value: NaN differs, -0 equals 0); objects and
/// arrays are reference-identity (distinct parses never match);
/// cross-type pairs never match.
fn strict_equal(a: &Node, b: &Node) -> bool {
    match (a, b) {
        (Node::Null, Node::Null) => true,
        (Node::Bool(x), Node::Bool(y)) => x == y,
        (Node::Num { bits: x, .. }, Node::Num { bits: y, .. }) => {
            f64::from_bits(*x) == f64::from_bits(*y)
        }
        (Node::Text(x), Node::Text(y)) => x == y,
        _ => false,
    }
}

fn text_key(units: &str) -> Vec<u16> {
    units.encode_utf16().collect()
}

/// Resolve one requirement's selected resource id (mirrors
/// `resolveId`): first environment resource whose binding `===`s,
/// then kind/logicalName agreement, else the exact TS refusal.
fn resolve_id<'a>(requirement: &'a Node, resources: &'a [Node]) -> Result<&'a Node, PlanError> {
    let binding = obj_get(requirement, "binding").unwrap_or(&Node::Null);
    let mut resolved: Option<&Node> = None;
    for candidate in resources {
        let candidate_binding = obj_get(candidate, "requirement")
            .and_then(|req| obj_get(req, "binding"))
            .unwrap_or(&Node::Null);
        if strict_equal(candidate_binding, binding) {
            resolved = Some(candidate);
            break;
        }
    }
    let resolved = resolved.ok_or_else(|| PlanError {
        message: format!(
            "deploy plan needs a selected resource for binding {}",
            js_string(binding)
        ),
    })?;
    let resolved_req = obj_get(resolved, "requirement").unwrap_or(&Node::Null);
    let kind_ok = strict_equal(
        obj_get(resolved_req, "kind").unwrap_or(&Node::Null),
        obj_get(requirement, "kind").unwrap_or(&Node::Null),
    );
    let name_ok = strict_equal(
        obj_get(resolved_req, "logicalName").unwrap_or(&Node::Null),
        obj_get(requirement, "logicalName").unwrap_or(&Node::Null),
    );
    if !kind_ok || !name_ok {
        return Err(PlanError {
            message: format!(
                "binding {} resolves to a different requirement",
                js_string(binding)
            ),
        });
    }
    Ok(obj_get(resolved, "resourceId").unwrap_or(&Node::Null))
}

/// Spread `{...vars}` exactly: objects clone entries in order, arrays
/// and strings spread indices, other scalars spread nothing. Values
/// (even non-strings) clone as-is, like the TS spread. Shared with
/// the review projection (`Object.keys` yields the same entries).
pub(crate) fn spread_vars(vars: &Node) -> Vec<(Vec<u16>, Node)> {
    match vars {
        Node::Obj(entries) => entries.clone(),
        Node::Arr(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (text_key(&i.to_string()), v.clone()))
            .collect(),
        Node::Text(units) => {
            // JS strings spread UTF-16 code units by index.
            units
                .iter()
                .enumerate()
                .map(|(i, u)| (text_key(&i.to_string()), Node::Text(vec![*u])))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn entry(key: &str, value: Node) -> (Vec<u16>, Node) {
    (text_key(key), value)
}

/// Deterministic deploy-plan generator (mirrors `buildDeployPlan`).
/// `options` carries `workerName`/`main`/`compatibilityDate` (any
/// nodes, cloned) plus optional `bundle` (absent/null selects the
/// legacy main and a null plan bundle).
pub fn build_deploy_plan(
    descriptor: &Node,
    environment: &Node,
    options: &Node,
) -> Result<Node, PlanError> {
    let invalid = |message: &str| PlanError {
        message: message.to_string(),
    };
    if as_obj(descriptor).is_none() {
        return Err(invalid("descriptor must be a JSON object"));
    }
    if as_obj(environment).is_none() {
        return Err(invalid("environment must be a JSON object"));
    }
    let bindings = obj_get(descriptor, "resourceBindings")
        .and_then(as_arr)
        .ok_or_else(|| invalid("descriptor.resourceBindings must be an array"))?;
    let resources = obj_get(environment, "resources")
        .and_then(as_arr)
        .ok_or_else(|| invalid("environment.resources must be an array"))?;
    for (index, requirement) in bindings.iter().enumerate() {
        if as_obj(requirement).is_none() {
            return Err(invalid(&format!(
                "descriptor.resourceBindings[{index}] must be a JSON object"
            )));
        }
    }
    for (index, resource) in resources.iter().enumerate() {
        if as_obj(resource).is_none() {
            return Err(invalid(&format!(
                "environment.resources[{index}] must be a JSON object"
            )));
        }
        if obj_get(resource, "requirement").and_then(as_obj).is_none() {
            return Err(invalid(&format!(
                "environment.resources[{index}].requirement must be a JSON object"
            )));
        }
    }
    let schedules = obj_get(descriptor, "schedules")
        .and_then(as_arr)
        .ok_or_else(|| invalid("descriptor.schedules must be an array"))?;

    let worker_name = obj_get(options, "workerName")
        .cloned()
        .ok_or_else(|| invalid("deploy plan options must include \"workerName\""))?;
    let legacy_main = obj_get(options, "main")
        .cloned()
        .ok_or_else(|| invalid("deploy plan options must include \"main\""))?;
    let compatibility_date = obj_get(options, "compatibilityDate")
        .cloned()
        .ok_or_else(|| invalid("deploy plan options must include \"compatibilityDate\""))?;
    // `options.bundle?.main ?? options.main`: nullish bundle (or a
    // bundle whose main is nullish) selects legacy; any other main
    // value clones as-is.
    let bundle_node = obj_get(options, "bundle").unwrap_or(&Node::Null);
    let main = match bundle_node {
        Node::Obj(_) => match obj_get(bundle_node, "main") {
            None | Some(Node::Null) => legacy_main.clone(),
            Some(other) => other.clone(),
        },
        _ => legacy_main.clone(),
    };

    let mut d1: Vec<Node> = Vec::new();
    let mut r2: Vec<Node> = Vec::new();
    let mut dob: Vec<Node> = Vec::new();
    let mut queues: Vec<Node> = Vec::new();
    let mut services: Vec<Node> = Vec::new();
    let mut analytics: Vec<Node> = Vec::new();
    for requirement in bindings {
        let id = resolve_id(requirement, resources)?;
        let binding = obj_get(requirement, "binding")
            .cloned()
            .unwrap_or(Node::Null);
        let logical = obj_get(requirement, "logicalName")
            .cloned()
            .unwrap_or(Node::Null);
        let kind = obj_get(requirement, "kind").unwrap_or(&Node::Null);
        let kind_is = |name: &str| match kind {
            Node::Text(units) => {
                units.iter().zip(name.bytes()).all(|(u, b)| *u == b as u16)
                    && units.len() == name.len()
            }
            _ => false,
        };
        if kind_is("d1") {
            d1.push(Node::Obj(vec![
                entry("binding", binding),
                entry("database_name", logical),
                entry("database_id", id.clone()),
            ]));
        } else if kind_is("r2") {
            r2.push(Node::Obj(vec![
                entry("binding", binding),
                entry("bucket_name", logical),
            ]));
        } else if kind_is("durable-object") {
            dob.push(Node::Obj(vec![
                entry("name", binding),
                entry("class_name", logical),
            ]));
        } else if kind_is("queue") {
            queues.push(Node::Obj(vec![
                entry("binding", binding),
                entry("queue", logical),
            ]));
        } else if kind_is("service") {
            services.push(Node::Obj(vec![
                entry("binding", binding),
                entry("service", logical),
            ]));
        } else if kind_is("analytics-engine") {
            analytics.push(Node::Obj(vec![
                entry("binding", binding),
                entry("dataset", logical),
            ]));
        } else {
            return Err(PlanError {
                message: format!(
                    "deploy plan has no mapping for resource kind {}",
                    js_string(kind)
                ),
            });
        }
    }

    let vars = obj_get(environment, "vars").unwrap_or(&Node::Null);
    let wrangler = Node::Obj(vec![
        entry("name", worker_name),
        entry("main", main),
        entry("compatibility_date", compatibility_date),
        entry("vars", Node::Obj(spread_vars(vars))),
        entry("d1_databases", Node::Arr(d1)),
        entry("r2_buckets", Node::Arr(r2)),
        entry(
            "durable_objects",
            Node::Obj(vec![entry("bindings", Node::Arr(dob))]),
        ),
        entry(
            "queues",
            Node::Obj(vec![entry("producers", Node::Arr(queues))]),
        ),
        entry("services", Node::Arr(services)),
        entry("analytics_engine_datasets", Node::Arr(analytics)),
    ]);
    let bundle_out = match bundle_node {
        Node::Null => Node::Null,
        _ => bundle_node.clone(),
    };
    Ok(Node::Obj(vec![
        entry("wrangler", wrangler),
        entry("schedules", Node::Arr(schedules.clone())),
        entry("bundle", bundle_out),
    ]))
}
