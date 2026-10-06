//! Deploy-plan rendering (P06.2): reviewable `wrangler.toml` plus the
//! canonical JSON the diff gate compares. Pure port of `render.ts`.
//!
//! Both renders are deterministic: the TOML uses fixed section order
//! with minimally escaped strings; the JSON is byte-exact
//! `JSON.stringify(plan, null, 2)` (insertion order comes from the
//! `Node` trees `plan.rs` builds). Schedules render as an OPEN-139
//! comment only — no trigger is ever invented.
//!
//! Traversal is fail-closed: every TOML string position the host
//! loaders guarantee (names, bindings, ids, vars, handlers) refuses
//! with a stable `RenderError` when it is not text (the TS renderer
//! throws an engine-dependent `TypeError` there, which no port can
//! quote). Interpolated positions (bundle comment fields) render any
//! node exactly like the TS template.

#![allow(dead_code)]

use crate::input::{as_arr, as_obj, js_string, json_quote, obj_get, render_text, Node};

/// One render refusal. Only reachable for host-contract-violating
/// input (core-built plans over validated facts always render).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderError {
    pub message: String,
}

/// JS `String.prototype.trimEnd`: strip trailing WhiteSpace +
/// LineTerminators (this set differs subtly from Rust's
/// `char::is_whitespace`: `U+FEFF` trims, `U+0085` does not).
fn trim_end_js(text: &str) -> &str {
    text.trim_end_matches(|c| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                | '\u{2001}'
                | '\u{2002}'
                | '\u{2003}'
                | '\u{2004}'
                | '\u{2005}'
                | '\u{2006}'
                | '\u{2007}'
                | '\u{2008}'
                | '\u{2009}'
                | '\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

/// Minimal TOML string escape (mirrors `tomlString`): backslash,
/// quote, LF, CR, TAB. Single pass (later insertions are never
/// re-escaped). Surrogate pairs combine; lone units render lossy
/// exactly like the file write downstream does.
fn toml_escape(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x5C => out.push_str("\\\\"),
            0x22 => out.push_str("\\\""),
            0x0A => out.push_str("\\n"),
            0x0D => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0xD800..=0xDBFF => {
                if i + 1 < units.len() && (0xDC00..=0xDFFF).contains(&units[i + 1]) {
                    let hi = u as u32 - 0xD800;
                    let lo = units[i + 1] as u32 - 0xDC00;
                    if let Some(ch) = char::from_u32(0x1_0000 + (hi << 10) + lo) {
                        out.push(ch);
                    }
                    i += 1;
                } else {
                    out.push('\u{FFFD}');
                }
            }
            0xDC00..=0xDFFF => out.push('\u{FFFD}'),
            _ => out.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}')),
        }
        i += 1;
    }
    out.push('"');
    out
}

/// Exact compact `JSON.stringify` over the parsed/core domain (no
/// `undefined`/function/symbol/bigint/circular values exist here).
pub fn json_stringify(node: &Node) -> String {
    match node {
        Node::Null => "null".to_string(),
        Node::Bool(true) => "true".to_string(),
        Node::Bool(false) => "false".to_string(),
        Node::Num { spelling, .. } => spelling.clone(),
        Node::Text(units) => json_quote(units),
        Node::Arr(items) => {
            let mut out = String::from("[");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&json_stringify(item));
            }
            out.push(']');
            out
        }
        Node::Obj(entries) => {
            let mut out = String::from("{");
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&json_quote(key));
                out.push(':');
                out.push_str(&json_stringify(value));
            }
            out.push('}');
            out
        }
    }
}

/// Exact `JSON.stringify(node, null, 2)`: 2-space steps, `": "`
/// after keys, empties inline (`{}`, `[]`).
pub fn json_stringify_indent2(node: &Node) -> String {
    fn render(node: &Node, level: usize, out: &mut String) {
        match node {
            Node::Null => out.push_str("null"),
            Node::Bool(true) => out.push_str("true"),
            Node::Bool(false) => out.push_str("false"),
            Node::Num { spelling, .. } => out.push_str(spelling),
            Node::Text(units) => out.push_str(&json_quote(units)),
            Node::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(",\n");
                    }
                    for _ in 0..=level {
                        out.push_str("  ");
                    }
                    render(item, level + 1, out);
                }
                out.push('\n');
                for _ in 0..level {
                    out.push_str("  ");
                }
                out.push(']');
            }
            Node::Obj(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push_str(",\n");
                    }
                    for _ in 0..=level {
                        out.push_str("  ");
                    }
                    out.push_str(&json_quote(key));
                    out.push_str(": ");
                    render(value, level + 1, out);
                }
                out.push('\n');
                for _ in 0..level {
                    out.push_str("  ");
                }
                out.push('}');
            }
        }
    }
    let mut out = String::new();
    render(node, 0, &mut out);
    out
}

/// Canonical JSON: the bytes the review gate diffs and stores
/// (`JSON.stringify(plan, null, 2)` plus trailing newline).
pub fn render_plan_json(plan: &Node) -> String {
    format!("{}\n", json_stringify_indent2(plan))
}

fn refuse(path: &str, want: &str) -> RenderError {
    RenderError {
        message: format!("deploy render: {path} must be {want}"),
    }
}

fn expect_text<'a>(node: &'a Node, path: &str) -> Result<&'a [u16], RenderError> {
    match node {
        Node::Text(units) => Ok(units.as_slice()),
        _ => Err(refuse(path, "a string")),
    }
}

fn expect_obj<'a>(node: &'a Node, path: &str) -> Result<&'a Vec<(Vec<u16>, Node)>, RenderError> {
    as_obj(node).ok_or_else(|| refuse(path, "an object"))
}

fn expect_arr<'a>(node: &'a Node, path: &str) -> Result<&'a Vec<Node>, RenderError> {
    as_arr(node).ok_or_else(|| refuse(path, "an array"))
}

fn field<'a>(node: &'a Node, key: &str, path: &str) -> Result<&'a Node, RenderError> {
    obj_get(node, key).ok_or_else(|| refuse(&format!("{path}.{key}"), "present"))
}

/// Reviewable `wrangler.toml` with fixed section order (mirrors
/// `renderWranglerToml`, including the trailing-trim + newline).
pub fn render_wrangler_toml(plan: &Node) -> Result<String, RenderError> {
    let wrangler = field(plan, "wrangler", "plan")?;
    expect_obj(wrangler, "plan.wrangler")?;
    let mut lines: Vec<String> =
        vec!["# Generated by can-platform deploy -- review before applying.".to_string()];
    // `plan.bundle !== null`: null skips; objects interpolate their
    // fields (`undefined` when absent); anything else interpolates
    // `undefined` exactly like the TS property access does.
    match obj_get(plan, "bundle") {
        None | Some(Node::Null) => {}
        Some(Node::Obj(_)) => {
            let bundle = obj_get(plan, "bundle").expect("matched");
            let count = obj_get(bundle, "moduleCount")
                .map(js_string)
                .unwrap_or_else(|| "undefined".to_string());
            let sha = obj_get(bundle, "sha256")
                .map(js_string)
                .unwrap_or_else(|| "undefined".to_string());
            lines.push(format!("# bundle: {count} modules, sha256 {sha}"));
        }
        Some(_) => {
            lines.push("# bundle: undefined modules, sha256 undefined".to_string());
        }
    }
    let get = |key: &str| {
        field(wrangler, key, "plan.wrangler")
            .and_then(|n| expect_text(n, &format!("plan.wrangler.{key}")))
    };
    lines.push(format!("name = {}", toml_escape(get("name")?)));
    lines.push(format!("main = {}", toml_escape(get("main")?)));
    lines.push(format!(
        "compatibility_date = {}",
        toml_escape(get("compatibility_date")?)
    ));
    lines.push(String::new());

    let vars = field(wrangler, "vars", "plan.wrangler")?;
    let var_entries = expect_obj(vars, "plan.wrangler.vars")?;
    let mut var_names: Vec<&Vec<u16>> = var_entries.iter().map(|(k, _)| k).collect();
    var_names.sort();
    if !var_names.is_empty() {
        lines.push("[vars]".to_string());
        for name in var_names {
            let value = var_entries
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v)
                .expect("sorted from entries");
            let value = expect_text(value, "plan.wrangler.vars[*]")?;
            lines.push(format!("{} = {}", render_text(name), toml_escape(value)));
        }
        lines.push(String::new());
    }

    // Each binding list: descriptor order preserved, fixed fields.
    let list = |key: &str| {
        field(wrangler, key, "plan.wrangler")
            .and_then(|n| expect_arr(n, &format!("plan.wrangler.{key}")))
    };
    for db in list("d1_databases")? {
        let binding = expect_text(field(db, "binding", "plan.d1")?, "plan.d1.binding")?;
        let name = expect_text(
            field(db, "database_name", "plan.d1")?,
            "plan.d1.database_name",
        )?;
        let id = expect_text(field(db, "database_id", "plan.d1")?, "plan.d1.database_id")?;
        lines.push("[[d1_databases]]".to_string());
        lines.push(format!("binding = {}", toml_escape(binding)));
        lines.push(format!("database_name = {}", toml_escape(name)));
        lines.push(format!("database_id = {}", toml_escape(id)));
        lines.push(String::new());
    }
    for bucket in list("r2_buckets")? {
        let binding = expect_text(field(bucket, "binding", "plan.r2")?, "plan.r2.binding")?;
        let name = expect_text(
            field(bucket, "bucket_name", "plan.r2")?,
            "plan.r2.bucket_name",
        )?;
        lines.push("[[r2_buckets]]".to_string());
        lines.push(format!("binding = {}", toml_escape(binding)));
        lines.push(format!("bucket_name = {}", toml_escape(name)));
        lines.push(String::new());
    }
    let dob = field(wrangler, "durable_objects", "plan.wrangler")?;
    expect_obj(dob, "plan.durable_objects")?;
    let do_bindings = expect_arr(
        field(dob, "bindings", "plan.durable_objects")?,
        "plan.durable_objects.bindings",
    )?;
    for binding in do_bindings {
        let name = expect_text(field(binding, "name", "plan.do")?, "plan.do.name")?;
        let class = expect_text(
            field(binding, "class_name", "plan.do")?,
            "plan.do.class_name",
        )?;
        lines.push("[[durable_objects.bindings]]".to_string());
        lines.push(format!("name = {}", toml_escape(name)));
        lines.push(format!("class_name = {}", toml_escape(class)));
        lines.push(String::new());
    }
    let queues = field(wrangler, "queues", "plan.wrangler")?;
    expect_obj(queues, "plan.queues")?;
    let producers = expect_arr(
        field(queues, "producers", "plan.queues")?,
        "plan.queues.producers",
    )?;
    for producer in producers {
        let binding = expect_text(
            field(producer, "binding", "plan.queue")?,
            "plan.queue.binding",
        )?;
        let queue = expect_text(field(producer, "queue", "plan.queue")?, "plan.queue.queue")?;
        lines.push("[[queues.producers]]".to_string());
        lines.push(format!("binding = {}", toml_escape(binding)));
        lines.push(format!("queue = {}", toml_escape(queue)));
        lines.push(String::new());
    }
    for service in list("services")? {
        let binding = expect_text(
            field(service, "binding", "plan.service")?,
            "plan.service.binding",
        )?;
        let name = expect_text(
            field(service, "service", "plan.service")?,
            "plan.service.service",
        )?;
        lines.push("[[services]]".to_string());
        lines.push(format!("binding = {}", toml_escape(binding)));
        lines.push(format!("service = {}", toml_escape(name)));
        lines.push(String::new());
    }
    for dataset in list("analytics_engine_datasets")? {
        let binding = expect_text(field(dataset, "binding", "plan.ae")?, "plan.ae.binding")?;
        let name = expect_text(field(dataset, "dataset", "plan.ae")?, "plan.ae.dataset")?;
        lines.push("[[analytics_engine_datasets]]".to_string());
        lines.push(format!("binding = {}", toml_escape(binding)));
        lines.push(format!("dataset = {}", toml_escape(name)));
        lines.push(String::new());
    }
    let schedules = expect_arr(field(plan, "schedules", "plan")?, "plan.schedules")?;
    if !schedules.is_empty() {
        lines.push(format!(
            "# OPEN-139: {} schedule(s) pass through unmapped;",
            schedules.len()
        ));
        lines.push("# no trigger section is emitted until the schedule-backend".to_string());
        lines.push("# decision lands. Handlers:".to_string());
        for schedule in schedules {
            // Raw template interpolation: null throws (like the TS
            // property access), anything else renders (`undefined`
            // when the field is absent).
            if matches!(schedule, Node::Null) {
                return Err(refuse("plan.schedule", "a schedule object"));
            }
            let handler = match schedule {
                Node::Obj(_) => obj_get(schedule, "handler")
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".to_string()),
                _ => "undefined".to_string(),
            };
            lines.push(format!("# - {handler}"));
        }
    }
    Ok(format!("{}\n", trim_end_js(&lines.join("\n"))))
}
