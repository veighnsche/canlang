//! Artifact semantic validation (P04.1): the exact
//! `runtime/artifact.ts` rules over an admitted `Node` tree.
//!
//! Same check order, same first-failure, same messages
//! (`artifact {path}: {detail}`; identity errors carry the bare
//! `compiled-identity:` prefix). Raw JSON text never reaches this
//! module — host parse errors stay host-side by construction
//! (malformed JSON remains a host parse error; see P04.1).
//! Unknown/additive keys are preserved structurally: validation
//! borrows the tree and indexes it without dropping anything.

use crate::input::Node;
use std::collections::{HashMap, HashSet};

/// One validation failure, message-identical to the TS loader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactError {
    pub message: String,
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Validated semantic indexes: validated views into the borrowed
/// tree in source order, for P05/P06 consumers.
#[derive(Debug)]
pub struct ValidatedArtifact<'a> {
    pub language_version: &'a [u16],
    pub tool_version: &'a [u16],
    pub source0_path: &'a [u16],
    pub source0_sha256: &'a [u16],
    pub modules: Vec<ModuleView<'a>>,
    pub module_paths: HashSet<Vec<u16>>,
    pub callables: Vec<CallableView<'a>>,
    pub operations: Vec<OperationView<'a>>,
    pub pages: Vec<PageView<'a>>,
    pub requires: usize,
    pub tests: usize,
}

#[derive(Debug)]
pub struct ModuleView<'a> {
    pub path: &'a [u16],
    pub js: &'a [u16],
}

#[derive(Debug)]
pub struct CallableView<'a> {
    pub id: &'a [u16],
    pub kind: &'a [u16],
    pub module: &'a [u16],
    pub export: &'a [u16],
}

#[derive(Debug)]
pub struct OperationView<'a> {
    pub name: &'a [u16],
    pub kind: &'a [u16],
}

#[derive(Debug)]
pub struct PageView<'a> {
    pub owner: &'a [u16],
    pub path: &'a [u16],
    pub module: &'a [u16],
    pub export: &'a [u16],
}

/// Compiled-identity expectation (mirrors `CompiledIdentityExpectation`).
#[derive(Debug)]
pub struct IdentityExpectation<'a> {
    pub source_path: &'a str,
    pub source_sha256: &'a str,
    pub tool_version: &'a str,
    pub language_version: &'a str,
}

const CALLABLE_KINDS: [&str; 5] = ["operation", "pure", "rule", "handler", "migration"];
const OPERATION_KINDS: [&str; 5] = ["read", "create", "update", "delete", "scenario"];
const OPERATION_FIELD_KINDS: [&str; 10] = [
    "ref", "string", "integer", "decimal", "money", "datetime", "boolean", "file", "enum",
    "delivery",
];

fn units_eq(units: &[u16], text: &str) -> bool {
    units.len() == text.len() && units.iter().zip(text.bytes()).all(|(u, b)| *u == b as u16)
}

fn get<'a>(node: &'a Node, key: &str) -> Option<&'a Node> {
    match node {
        Node::Obj(entries) => entries
            .iter()
            .find(|(k, _)| units_eq(k, key))
            .map(|(_, v)| v),
        _ => None,
    }
}

fn as_text(node: &Node) -> Option<&Vec<u16>> {
    match node {
        Node::Text(units) => Some(units),
        _ => None,
    }
}

fn nonempty_text(node: &Node) -> Option<&Vec<u16>> {
    as_text(node).filter(|units| !units.is_empty())
}

fn as_num(node: &Node) -> Option<(u64, &str)> {
    match node {
        Node::Num { bits, spelling } => Some((*bits, spelling.as_str())),
        _ => None,
    }
}

fn as_arr(node: &Node) -> Option<&Vec<Node>> {
    match node {
        Node::Arr(items) => Some(items),
        _ => None,
    }
}

fn as_obj(node: &Node) -> Option<&Vec<(Vec<u16>, Node)>> {
    match node {
        Node::Obj(entries) => Some(entries),
        _ => None,
    }
}

fn as_bool(node: &Node) -> Option<bool> {
    match node {
        Node::Bool(v) => Some(*v),
        _ => None,
    }
}

fn num_value(bits: u64) -> f64 {
    f64::from_bits(bits)
}

/// Lowercase-hex check over units (ASCII ranges only, like the regex).
fn is_sha256_hex(units: &[u16]) -> bool {
    units.len() == 64 && units.iter().all(|u| matches!(u, 0x30..=0x39 | 0x61..=0x66))
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

fn hex4(n: u16) -> String {
    format!("{n:04x}")
}

/// JSON string escaping over UTF-16 units, ES2019 `JSON.stringify`
/// rules: paired surrogates pass through raw, lone surrogates escape
/// as lowercase `\uXXXX`, controls use short/long escapes.
pub fn escape_json_string(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x00..=0x1f => {
                out.push_str("\\u");
                out.push_str(&hex4(u));
            }
            0xd800..=0xdbff => {
                let next = units.get(i + 1).copied().unwrap_or(0);
                if (0xdc00..=0xdfff).contains(&next) {
                    let hi = (u - 0xd800) as u32;
                    let lo = (next - 0xdc00) as u32;
                    if let Some(ch) = char::from_u32(0x10000 + (hi << 10) + lo) {
                        out.push(ch);
                    }
                    i += 1;
                } else {
                    out.push_str("\\u");
                    out.push_str(&hex4(u));
                }
            }
            0xdc00..=0xdfff => {
                out.push_str("\\u");
                out.push_str(&hex4(u));
            }
            _ => {
                if let Some(ch) = char::from_u32(u as u32) {
                    out.push(ch);
                }
            }
        }
        i += 1;
    }
    out.push('"');
    out
}

/// Recursive `JSON.stringify` for error interpolations: numbers use
/// their canonical spelling (nonfinite already `"null"`), objects
/// keep entry order, text escapes per `escape_json_string`.
pub fn stringify(node: &Node) -> String {
    match node {
        Node::Null => "null".to_string(),
        Node::Bool(true) => "true".to_string(),
        Node::Bool(false) => "false".to_string(),
        Node::Num { spelling, .. } => spelling.clone(),
        Node::Text(units) => escape_json_string(units),
        Node::Arr(items) => {
            let parts: Vec<String> = items.iter().map(stringify).collect();
            format!("[{}]", parts.join(","))
        }
        Node::Obj(entries) => {
            let parts: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}:{}", escape_json_string(k), stringify(v)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

struct Checker<'a> {
    path: &'a str,
}

impl<'a> Checker<'a> {
    fn fail(&self, detail: String) -> ArtifactError {
        ArtifactError {
            message: format!("artifact {}: {detail}", self.path),
        }
    }

    fn module(
        &self,
        value: &'a Node,
        location: &str,
        validated: &mut ValidatedArtifact<'a>,
    ) -> Result<(), ArtifactError> {
        let obj =
            as_obj(value).ok_or_else(|| self.fail(format!("{location} must be an object")))?;
        let _ = obj;
        let path = get(value, "path")
            .and_then(nonempty_text)
            .ok_or_else(|| self.fail(format!("{location}.path must be a non-empty string")))?;
        let js = get(value, "js")
            .and_then(as_text)
            .ok_or_else(|| self.fail(format!("{location}.js must be a string")))?;
        let map = get(value, "map")
            .filter(|m| as_obj(m).is_some())
            .ok_or_else(|| self.fail(format!("{location}.map must be an object")))?;
        let version_ok = get(map, "version")
            .and_then(as_num)
            .map(|(bits, _)| num_value(bits) == 3.0)
            .unwrap_or(false);
        if !version_ok {
            let got = get(map, "version")
                .map(stringify)
                .unwrap_or("undefined".to_string());
            return Err(self.fail(format!("{location}.map.version must be 3 (got {got})")));
        }
        validated.module_paths.insert(path.clone());
        validated.modules.push(ModuleView {
            path: path.as_slice(),
            js: js.as_slice(),
        });
        Ok(())
    }
}

/// Validate one admitted artifact tree with the exact loader rules,
/// in source order, first failure wins.
pub fn validate_artifact<'a>(
    root: &'a Node,
    source_path: &'a str,
) -> Result<ValidatedArtifact<'a>, ArtifactError> {
    let c = Checker { path: source_path };
    as_obj(root).ok_or_else(|| c.fail("root must be a JSON object".to_string()))?;

    let version_ok = get(root, "artifact_version")
        .and_then(as_num)
        .map(|(bits, _)| num_value(bits) == 1.0)
        .unwrap_or(false);
    if !version_ok {
        let got = get(root, "artifact_version")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(c.fail(format!("unsupported artifact_version {got} (want 1)")));
    }
    let language_version = get(root, "language_version")
        .and_then(nonempty_text)
        .ok_or_else(|| c.fail("language_version must be a non-empty string".to_string()))?;
    let tool_version = get(root, "tool_version")
        .and_then(nonempty_text)
        .ok_or_else(|| c.fail("tool_version must be a non-empty string".to_string()))?;

    let sources = get(root, "sources")
        .and_then(as_arr)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| c.fail("sources must be a non-empty array".to_string()))?;
    let source0 = sources.first().expect("non-empty");
    as_obj(source0).ok_or_else(|| c.fail("sources[0] must be an object".to_string()))?;
    let source0_path = get(source0, "path")
        .and_then(nonempty_text)
        .ok_or_else(|| c.fail("sources[0].path must be a non-empty string".to_string()))?;
    let source0_sha_ok = get(source0, "sha256")
        .and_then(as_text)
        .map(|units| is_sha256_hex(units))
        .unwrap_or(false);
    if !source0_sha_ok {
        return Err(c.fail("sources[0].sha256 must be 64-char lowercase hex".to_string()));
    }
    let source0_sha256 = get(source0, "sha256").and_then(as_text).expect("checked");

    let mut validated = ValidatedArtifact {
        language_version: language_version.as_slice(),
        tool_version: tool_version.as_slice(),
        source0_path: source0_path.as_slice(),
        source0_sha256: source0_sha256.as_slice(),
        modules: Vec::new(),
        module_paths: HashSet::new(),
        callables: Vec::new(),
        operations: Vec::new(),
        pages: Vec::new(),
        requires: 0,
        tests: 0,
    };

    let modules = get(root, "modules")
        .and_then(as_arr)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            c.fail("modules must be a non-empty array; modules[0] is the entrypoint".to_string())
        })?;
    for (index, module) in modules.iter().enumerate() {
        c.module(module, &format!("modules[{index}]"), &mut validated)?;
    }

    let callables = get(root, "callables")
        .and_then(as_arr)
        .ok_or_else(|| c.fail("callables must be an array".to_string()))?;
    for (index, callable) in callables.iter().enumerate() {
        let location = format!("callables[{index}]");
        as_obj(callable).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
        let id = get(callable, "id")
            .and_then(nonempty_text)
            .ok_or_else(|| c.fail(format!("{location}.id must be a non-empty string")))?;
        let kind = get(callable, "kind")
            .and_then(as_text)
            .filter(|units| CALLABLE_KINDS.iter().any(|k| units_eq(units, k)));
        if kind.is_none() {
            let got = get(callable, "kind")
                .map(stringify)
                .unwrap_or("undefined".to_string());
            return Err(c.fail(format!(
                "{location}.kind must be one of operation|pure|rule|handler|migration (got {got})"
            )));
        }
        let module = get(callable, "module")
            .and_then(nonempty_text)
            .ok_or_else(|| c.fail(format!("{location}.module must be a non-empty string")))?;
        if !validated.module_paths.contains(module) {
            let got = stringify(get(callable, "module").expect("checked"));
            return Err(c.fail(format!("{location}.module {got} names no modules[] entry")));
        }
        let export = get(callable, "export")
            .and_then(nonempty_text)
            .ok_or_else(|| c.fail(format!("{location}.export must be a non-empty string")))?;
        let member_ok = get(callable, "member")
            .and_then(as_arr)
            .map(|items| !items.is_empty() && items.iter().all(|s| nonempty_text(s).is_some()))
            .unwrap_or(false);
        if !member_ok {
            return Err(c.fail(format!(
                "{location}.member for callable {} must be a non-empty array of non-empty strings (registry path into canApp()); recompile with the fixed `can compile`",
                escape_json_string(id)
            )));
        }
        validated.callables.push(CallableView {
            id: id.as_slice(),
            kind: kind.expect("checked").as_slice(),
            module: module.as_slice(),
            export: export.as_slice(),
        });
    }

    if let Some(operations_node) = get(root, "operations") {
        let operations = as_arr(operations_node)
            .ok_or_else(|| c.fail("operations must be an array".to_string()))?;
        let mut seen: HashSet<Vec<u16>> = HashSet::new();
        for (index, operation) in operations.iter().enumerate() {
            let location = format!("operations[{index}]");
            as_obj(operation).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
            let name = get(operation, "name")
                .and_then(nonempty_text)
                .ok_or_else(|| c.fail(format!("{location}.name must be a non-empty string")))?;
            if seen.contains(name) {
                return Err(c.fail(format!(
                    "operations repeats operation {}",
                    escape_json_string(name)
                )));
            }
            seen.insert(name.clone());
            let kind_ok = get(operation, "kind")
                .and_then(as_text)
                .map(|units| OPERATION_KINDS.iter().any(|k| units_eq(units, k)))
                .unwrap_or(false);
            if !kind_ok {
                let got = get(operation, "kind")
                    .map(stringify)
                    .unwrap_or("undefined".to_string());
                return Err(c.fail(format!(
                    "{location}.kind must be one of read|create|update|delete|scenario (got {got})"
                )));
            }
            get(operation, "description")
                .and_then(as_text)
                .ok_or_else(|| c.fail(format!("{location}.description must be a string")))?;
            let inputs = get(operation, "inputs")
                .filter(|n| as_obj(n).is_some())
                .ok_or_else(|| c.fail(format!("{location}.inputs must be an object")))?;
            let fields = get(inputs, "fields")
                .and_then(as_arr)
                .ok_or_else(|| c.fail(format!("{location}.inputs.fields must be an array")))?;
            let mut seen_fields: HashSet<Vec<u16>> = HashSet::new();
            for (field_index, field) in fields.iter().enumerate() {
                let field_where = format!("{location}.inputs.fields[{field_index}]");
                as_obj(field).ok_or_else(|| c.fail(format!("{field_where} must be an object")))?;
                let field_name = get(field, "name").and_then(nonempty_text).ok_or_else(|| {
                    c.fail(format!("{field_where}.name must be a non-empty string"))
                })?;
                if seen_fields.contains(field_name) {
                    return Err(c.fail(format!(
                        "{location} repeats input {}",
                        escape_json_string(field_name)
                    )));
                }
                seen_fields.insert(field_name.clone());
                get(field, "required")
                    .and_then(as_bool)
                    .ok_or_else(|| c.fail(format!("{field_where}.required must be a boolean")))?;
                if let Some(description) = get(field, "description") {
                    as_text(description).ok_or_else(|| {
                        c.fail(format!("{field_where}.description must be a string"))
                    })?;
                }
                let schema = get(field, "field")
                    .filter(|n| as_obj(n).is_some())
                    .ok_or_else(|| c.fail(format!("{field_where}.field must be an object")))?;
                let schema_kind = get(schema, "kind")
                    .and_then(as_text)
                    .filter(|units| OPERATION_FIELD_KINDS.iter().any(|k| units_eq(units, k)));
                if schema_kind.is_none() {
                    let got = get(schema, "kind")
                        .map(stringify)
                        .unwrap_or("undefined".to_string());
                    return Err(c.fail(format!(
                        "{field_where}.field.kind must be one of ref|string|integer|decimal|money|datetime|boolean|file|enum|delivery (got {got})"
                    )));
                }
                let schema_kind = schema_kind.expect("checked");
                if units_eq(schema_kind, "ref") {
                    get(schema, "model")
                        .and_then(nonempty_text)
                        .ok_or_else(|| {
                            c.fail(format!(
                                "{field_where}.field.model must be a non-empty string"
                            ))
                        })?;
                    get(schema, "requireVersion")
                        .and_then(as_bool)
                        .ok_or_else(|| {
                            c.fail(format!(
                                "{field_where}.field.requireVersion must be a boolean"
                            ))
                        })?;
                }
                if units_eq(schema_kind, "enum") {
                    let values_ok = get(schema, "values")
                        .and_then(as_arr)
                        .map(|items| {
                            !items.is_empty() && items.iter().all(|v| as_text(v).is_some())
                        })
                        .unwrap_or(false);
                    if !values_ok {
                        return Err(c.fail(format!(
                            "{field_where}.field.values must be a non-empty array of strings"
                        )));
                    }
                }
                if units_eq(schema_kind, "delivery") {
                    get(schema, "capability")
                        .and_then(nonempty_text)
                        .ok_or_else(|| {
                            c.fail(format!(
                                "{field_where}.field.capability must be a non-empty string"
                            ))
                        })?;
                    get(schema, "operation")
                        .and_then(nonempty_text)
                        .ok_or_else(|| {
                            c.fail(format!(
                                "{field_where}.field.operation must be a non-empty string"
                            ))
                        })?;
                    get(schema, "version").and_then(as_num).ok_or_else(|| {
                        c.fail(format!("{field_where}.field.version must be a number"))
                    })?;
                    let result = get(schema, "result")
                        .filter(|n| as_obj(n).is_some())
                        .ok_or_else(|| {
                            c.fail(format!("{field_where}.field.result must be an object"))
                        })?;
                    get(result, "name").and_then(nonempty_text).ok_or_else(|| {
                        c.fail(format!(
                            "{field_where}.field.result.name must be a non-empty string"
                        ))
                    })?;
                    let leaves_ok = get(result, "fields")
                        .and_then(as_arr)
                        .map(|items| {
                            items.iter().all(|leaf| {
                                as_obj(leaf).is_some()
                                    && get(leaf, "name").and_then(nonempty_text).is_some()
                                    && get(leaf, "type").and_then(as_text).is_some()
                            })
                        })
                        .unwrap_or(false);
                    if !leaves_ok {
                        return Err(c.fail(format!(
                            "{field_where}.field.result.fields must be an array of {{name, type}} leaves"
                        )));
                    }
                }
            }
            validated.operations.push(OperationView {
                name: name.as_slice(),
                kind: get(operation, "kind")
                    .and_then(as_text)
                    .expect("checked")
                    .as_slice(),
            });
        }
    }

    let pages = get(root, "pages")
        .and_then(as_arr)
        .ok_or_else(|| c.fail("pages must be an array".to_string()))?;
    for (index, page) in pages.iter().enumerate() {
        let location = format!("pages[{index}]");
        as_obj(page).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
        let mut views: HashMap<&str, &[u16]> = HashMap::new();
        for field in ["owner", "path", "module", "export"] {
            let value = get(page, field)
                .and_then(nonempty_text)
                .ok_or_else(|| c.fail(format!("{location}.{field} must be a non-empty string")))?;
            views.insert(field, value.as_slice());
        }
        let module = views["module"];
        if !validated.module_paths.contains(module) {
            let got = stringify(get(page, "module").expect("checked"));
            return Err(c.fail(format!("{location}.module {got} names no modules[] entry")));
        }
        validated.pages.push(PageView {
            owner: views["owner"],
            path: views["path"],
            module,
            export: views["export"],
        });
    }

    let requires = get(root, "requires")
        .and_then(as_arr)
        .ok_or_else(|| c.fail("requires must be an array".to_string()))?;
    for (index, requirement) in requires.iter().enumerate() {
        let location = format!("requires[{index}]");
        as_obj(requirement).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
        get(requirement, "capability")
            .and_then(nonempty_text)
            .ok_or_else(|| c.fail(format!("{location}.capability must be a non-empty string")))?;
        let version_ok = get(requirement, "min_version")
            .and_then(as_num)
            .map(|(bits, _)| {
                let v = num_value(bits);
                is_integer(v) && v >= 0.0
            })
            .unwrap_or(false);
        if !version_ok {
            return Err(c.fail(format!("{location}.min_version must be an integer >= 0")));
        }
        validated.requires += 1;
    }

    let tests = get(root, "tests")
        .and_then(as_arr)
        .ok_or_else(|| c.fail("tests must be an array".to_string()))?;
    for (index, test) in tests.iter().enumerate() {
        let location = format!("tests[{index}]");
        as_obj(test).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
        get(test, "scope")
            .and_then(nonempty_text)
            .ok_or_else(|| c.fail(format!("{location}.scope must be a non-empty string")))?;
        let module = get(test, "module")
            .ok_or_else(|| c.fail(format!("{location}.module must be an object")))?;
        // checkModule shape without indexing test modules into module_paths.
        check_test_module(&c, module, &format!("{location}.module"))?;
        let fixtures_ok = get(test, "fixtures")
            .and_then(as_arr)
            .map(|items| items.iter().all(|f| as_text(f).is_some()))
            .unwrap_or(false);
        if !fixtures_ok {
            return Err(c.fail(format!("{location}.fixtures must be an array of strings")));
        }
        validated.tests += 1;
    }

    Ok(validated)
}

/// Module shape check for test-embedded modules: same rules as
/// `Checker::module` but without indexing into module paths (the TS
/// loader likewise only indexes top-level `modules[]`).
fn check_test_module(c: &Checker<'_>, value: &Node, location: &str) -> Result<(), ArtifactError> {
    as_obj(value).ok_or_else(|| c.fail(format!("{location} must be an object")))?;
    get(value, "path")
        .and_then(nonempty_text)
        .ok_or_else(|| c.fail(format!("{location}.path must be a non-empty string")))?;
    get(value, "js")
        .and_then(as_text)
        .ok_or_else(|| c.fail(format!("{location}.js must be a string")))?;
    let map = get(value, "map")
        .filter(|m| as_obj(m).is_some())
        .ok_or_else(|| c.fail(format!("{location}.map must be an object")))?;
    let version_ok = get(map, "version")
        .and_then(as_num)
        .map(|(bits, _)| num_value(bits) == 3.0)
        .unwrap_or(false);
    if !version_ok {
        let got = get(map, "version")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(c.fail(format!("{location}.map.version must be 3 (got {got})")));
    }
    Ok(())
}

/// Provenance on top of structure: the exact
/// `assertCompiledIdentity` bindings in order.
pub fn assert_compiled_identity(
    root: &Node,
    expected: &IdentityExpectation<'_>,
) -> Result<(), ArtifactError> {
    let fail = |detail: String| ArtifactError {
        message: format!("compiled-identity: {detail}"),
    };
    let version_ok = get(root, "artifact_version")
        .and_then(as_num)
        .map(|(bits, _)| num_value(bits) == 1.0)
        .unwrap_or(false);
    if !version_ok {
        let got = get(root, "artifact_version")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(fail(format!("artifact_version {got} is not 1")));
    }
    let language = get(root, "language_version").and_then(as_text);
    if language.map(|u| units_eq(u, expected.language_version)) != Some(true) {
        let got = get(root, "language_version")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(fail(format!(
            "language_version {got} is not the toolchain language {}",
            escape_json_string(&str_units(expected.language_version))
        )));
    }
    let tool = get(root, "tool_version").and_then(as_text);
    if tool.map(|u| units_eq(u, expected.tool_version)) != Some(true) {
        let got = get(root, "tool_version")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(fail(format!(
            "tool_version {got} is not the toolchain version {}",
            escape_json_string(&str_units(expected.tool_version))
        )));
    }
    let source0 = get(root, "sources")
        .and_then(as_arr)
        .and_then(|items| items.first());
    let source0 = match source0 {
        Some(node) => node,
        None => {
            return Err(fail(
                "artifact has no sources; sources[0] must bind the origin".to_string(),
            ))
        }
    };
    let path = get(source0, "path").and_then(as_text);
    if path.map(|u| units_eq(u, expected.source_path)) != Some(true) {
        let got = get(source0, "path")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(fail(format!(
            "sources[0].path {got} is not the compiled path {}",
            escape_json_string(&str_units(expected.source_path))
        )));
    }
    let sha = get(source0, "sha256").and_then(as_text);
    if sha.map(|u| units_eq(u, expected.source_sha256)) != Some(true) {
        let got = get(source0, "sha256")
            .map(stringify)
            .unwrap_or("undefined".to_string());
        return Err(fail(format!(
            "sources[0].sha256 {got} does not match the compiled bytes {}",
            escape_json_string(&str_units(expected.source_sha256))
        )));
    }
    Ok(())
}

fn str_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
