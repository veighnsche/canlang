//! Producer-catalog consumer: load the lane-02 `catalog.json` and parse
//! entry signatures into checkable overload shapes.
//!
//! Resolution order for the catalog file: `--catalog PATH` flag >
//! `CAN_CATALOG` env > `./can-catalog.json` >
//! `./packages/values/dist/catalog.json` (workspace-dev convenience,
//! emitted by `npm run catalog` in `packages/values`; gitignored build
//! output, never committed). A missing catalog is a precise `E6002`
//! naming every location tried and how to produce the file. There is no
//! hardcoded builtin table: without a catalog, builtin names do not
//! resolve (each use is `E2001`), on top of the single `E6002`.
//!
//! Envelope: `language_version` must be `"1.0"` (`E6003` otherwise);
//! `catalog_version` is recorded and exposed for diagnostics and the
//! [`crate::analysis::CheckedProgram`] artifact. Unknown `kind`,
//! `effects` or `availability` spellings are `E6003` naming the entry:
//! the checker never guesses what an entry means.
//!
//! Lane-05 components (`kind: "component"`, one file per producer) share
//! the envelope and the `{id,js,owner,kind,signature,availability}`
//! base but carry per-kind extras instead of overloads: a required
//! `profile` (8 words) and `header` (10 words) tag, optional
//! `attributes` (names), `slots` (`{name,required,repeatable}`) and
//! `alternates` (profiles); `appearance`/`notes` are ignored. Components
//! have NO `effects` field: one present is `E6003` (an effect claim on a
//! component would be ambiguous, so it is rejected, never guessed).
//! Unknown profile/header spellings and misshapen extras are `E6003`.
//! Component signatures are JS-factory prose, stored opaquely and never
//! parsed as overloads. The checker does not resolve component words in
//! PR4 (HO-05: L5-entry checking is PR5/emission work); the loader only
//! accepts and records them.
//!
//! Helpers (`kind: "helper"`) are codegen-only. Their signatures carry
//! producer-internal prose (`same currency`, JS-side types such as
//! `bigint`/`CanValue`) that is not a source-callable shape, so only the
//! leading `id(params)->result` spine is sanity-checked (name match,
//! balanced delimiters); the entry is recorded as not-callable and any
//! source reference to the id is `E2006`. Resolving a helper is never
//! silent and never a pass.
//!
//! ## Builtin signature subset
//!
//! Each builtin `signature` is `;`-separated overloads of
//! `id(name:Shape,...)->Shape`. Supported `Shape` forms (transcribed
//! from DESIGN §3 as emitted by lane 02):
//!
//! - `T`: generic variable, bound per call from actual argument types.
//! - `O`, `S`, `K`, `Display`: the §3 ordered-scalar, string-like,
//!   group-key and display classes.
//! - `C<Shape>`, `nonempty C<Shape>`, `ordered C<Shape>`: homogeneous
//!   collection domains (arrays and query results).
//! - `Shape|Shape`: unions of shapes; `Shape?`: nullable; `Shape[]`:
//!   arrays; `enum(a,b)`: anonymous enum cases.
//! - `{key:K,items:T[]}`: closed object literals (the `group` rows).
//! - `closed object of Display`: object values with all-`Display` fields.
//! - `message`: a message descriptor value.
//! - `C<T> as x`, `bool in x scope`: alias introductions and
//!   alias-scoped predicates (`any`/`all`/`group`).
//! - `canonical user mutation`, `closed object of every record
//!   parameter`, `singleton action(target)`: the `action` constructor
//!   forms, checked against canonical operation identities.
//! - Any other dotted or plain name (`int`, `text`, `currency`,
//!   `secret`, ...): a nominal type matched by the type checker.
//!
//! An overload that does not match this subset, an overload id that
//! differs from the entry id, or an empty `;` segment is `E6004` naming
//! the entry id. Entries are never skipped to pass.

use crate::diagnostic::Diagnostic;
use crate::json::{self, Json};
use crate::source::Span;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `CAN_CATALOG` environment variable: catalog path override.
pub const CATALOG_ENV_VAR: &str = "CAN_CATALOG";

/// Producer catalog: builtin overload shapes plus helper/codegen records.
#[derive(Debug, Clone)]
pub struct Catalog {
    /// Envelope `catalog_version` (e.g. `0.1.0-lane02-draft`).
    version: String,
    entries: HashMap<String, CatalogEntry>,
    order: Vec<String>,
}

/// Builtin vs codegen-only helper vs lane-05 component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// Callable from source through the checked overloads.
    Builtin,
    /// Codegen-only; any source reference is `E2006`.
    Helper,
    /// Presentation word; recorded for PR5, never source-callable.
    Component,
}

/// Implementation status of one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Declared but unimplemented: calls are `E6001`.
    Planned,
    /// Implemented by the owning lane: callable.
    Implemented,
    /// Implemented by another lane: callable.
    External,
}

/// Effect class of one entry (enforced by later stages; exposed here).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effects {
    Pure,
    ServerDefaultOnly,
    StateRead,
}

/// One catalog entry with its checkable shape.
#[derive(Debug, Clone)]
pub struct CatalogEntry {
    /// Canonical Can name, e.g. `add_days`.
    pub id: String,
    /// JS factory name as exported by the producer (codegen-facing).
    pub js: String,
    /// Owning lane, e.g. `lane-02`.
    pub owner: String,
    /// Builtin (checked overloads), helper (not callable) or component.
    pub kind: EntryKind,
    /// Parsed overloads; empty for helpers and components.
    pub overloads: Vec<SigOverload>,
    /// Opaque JS-factory signature prose (components only).
    pub component_signature: Option<String>,
    /// Effect class (`None` for components, which have no such field).
    pub effects: Option<Effects>,
    /// Implementation status.
    pub availability: Availability,
    /// Deprecation notice when the producer marks one.
    pub deprecation: Option<String>,
    /// Component extras (`Some` exactly for components).
    pub component: Option<ComponentShape>,
}

/// Lane-05 component extras (transcribed from the lane-05 catalog
/// contract: 8 binding profiles, 10 header-expression payloads).
#[derive(Debug, Clone)]
pub struct ComponentShape {
    /// Binding profile word (`leaf`, `group`, ...).
    pub profile: String,
    /// Header-expression payload word (`none`, `value`, ...).
    pub header: String,
    /// Closed structural/binding attribute names admitted by the word.
    pub attributes: Vec<String>,
    /// Named-slot schema; empty means no slots.
    pub slots: Vec<ComponentSlot>,
    /// Alternate accepted profiles for two-shape words.
    pub alternates: Vec<String>,
}

/// One named slot in a component slot schema.
#[derive(Debug, Clone)]
pub struct ComponentSlot {
    /// Slot name.
    pub name: String,
    /// Whether the slot must be filled.
    pub required: bool,
    /// Whether the slot may repeat (only where permitted).
    pub repeatable: bool,
}

/// Binding-profile vocabulary (`ComponentProfile` on the L5 side).
pub const COMPONENT_PROFILES: [&str; 8] = [
    "leaf",
    "group",
    "slotted-group",
    "collection",
    "field-control",
    "bound-control",
    "shared-control",
    "shell",
];

/// Header-expression vocabulary (`ComponentHeaderExpr` on the L5 side).
pub const COMPONENT_HEADERS: [&str; 10] = [
    "none", "value", "text", "numeric", "bool", "image", "query", "sequence", "selector", "binding",
];

/// One `id(params)->result` overload shape.
#[derive(Debug, Clone)]
pub struct SigOverload {
    /// Parameters in order.
    pub params: Vec<SigParam>,
    /// Result shape.
    pub result: SigType,
}

/// One `name:Shape` parameter shape.
#[derive(Debug, Clone)]
pub struct SigParam {
    /// Parameter name.
    pub name: String,
    /// Parameter shape.
    pub ty: SigType,
    /// Alias introduced by this parameter (`C<T> as x`).
    pub alias: Option<String>,
    /// Alias whose scope this parameter is checked in (`bool in x scope`).
    pub in_scope: Option<String>,
}

/// Checkable signature type shape (see the module docs for the subset).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigType {
    /// Generic variable `T`, bound per call.
    Any,
    /// Nominal type name (`int`, `text`, `secret`, ...).
    Named(String),
    /// Ordered-scalar class `O`.
    Ordered,
    /// String-like class `S`.
    StringLike,
    /// Group-key class `K`.
    GroupKey,
    /// Display class.
    Display,
    /// Homogeneous collection `C<Shape>`.
    Collection(Box<SigType>),
    /// Statically nonempty collection.
    NonemptyCollection(Box<SigType>),
    /// Stably ordered collection.
    OrderedCollection(Box<SigType>),
    /// Nullable `Shape?`.
    Nullable(Box<SigType>),
    /// Array `Shape[]`.
    Array(Box<SigType>),
    /// Union of shapes.
    Union(Vec<SigType>),
    /// Anonymous enum cases.
    EnumCases(Vec<String>),
    /// Closed object literal type (`{key:K,items:T[]}`).
    Object(Vec<(String, SigType)>),
    /// Closed object with all-`Display` fields.
    ClosedDisplayObject,
    /// Message descriptor value.
    Message,
    /// The `action` target form (`canonical user mutation`).
    ActionTarget,
    /// The `action` bindings form.
    ActionBindings,
    /// The `action` singleton result form.
    ActionResult,
}

/// Catalog load request: explicit inputs so tests never depend on process
/// state. Production callers pass the `--catalog` flag, the
/// `CAN_CATALOG` value and the process working directory.
pub struct CatalogRequest<'a> {
    /// `--catalog PATH` flag value.
    pub flag: Option<&'a Path>,
    /// `CAN_CATALOG` value, when set and nonempty.
    pub env: Option<String>,
    /// Working directory anchoring the `./` candidates.
    pub cwd: &'a Path,
    /// Primary span for `E6xxx` diagnostics (an empty span at the
    /// start of the first analyzed file: catalog faults name a file
    /// outside the analyzed sources).
    pub primary: Span,
}

/// Load the producer catalog following the documented resolution order.
///
/// Returns the catalog (when exactly one candidate loads and validates)
/// plus diagnostics. A missing file is one `E6002` naming every location
/// tried and how to produce the file; envelope/entry violations are
/// `E6003`; unparseable builtin signatures are `E6004` naming the entry.
pub fn load_catalog(request: &CatalogRequest<'_>) -> (Option<Catalog>, Vec<Diagnostic>) {
    let mut tried: Vec<String> = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(flag) = request.flag {
        tried.push(format!("--catalog {}", flag.display()));
        candidates.push(flag.to_path_buf());
    }
    if let Some(env) = request.env.as_ref().filter(|v| !v.is_empty()) {
        tried.push(format!("{CATALOG_ENV_VAR} {env}"));
        candidates.push(PathBuf::from(env));
    }
    for relative in ["can-catalog.json", "packages/values/dist/catalog.json"] {
        let path = request.cwd.join(relative);
        tried.push(path.display().to_string());
        candidates.push(path);
    }
    let mut diags = Vec::new();
    for path in &candidates {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                diags.push(Diagnostic::error(
                    "E6003",
                    format!("catalog '{}' is not valid UTF-8", path.display()),
                    request.primary,
                ));
                return (None, diags);
            }
        };
        return parse_catalog(&text, &path.display().to_string(), request.primary);
    }
    let tried_list = tried.join(", ");
    diags.push(Diagnostic::error(
        "E6002",
        format!(
            "producer catalog not found; tried {tried_list}. Emit it with `npm run catalog` in packages/values, pass --catalog PATH, or set {CATALOG_ENV_VAR}."
        ),
        request.primary,
    ));
    (None, diags)
}

/// Parse and validate one catalog document.
fn parse_catalog(text: &str, origin: &str, primary: Span) -> (Option<Catalog>, Vec<Diagnostic>) {
    let mut diags = Vec::new();
    let value = match json::parse(text) {
        Ok(value) => value,
        Err(err) => {
            diags.push(Diagnostic::error(
                "E6003",
                format!("catalog '{origin}' is not valid JSON: {err}"),
                primary,
            ));
            return (None, diags);
        }
    };
    let language_version = value.get("language_version").and_then(Json::as_str);
    if language_version != Some("1.0") {
        diags.push(Diagnostic::error(
            "E6003",
            format!(
                "catalog '{origin}' has language_version {}, want \"1.0\"",
                language_version.map_or("missing".to_string(), |v| format!("\"{v}\"")),
            ),
            primary,
        ));
        return (None, diags);
    }
    let Some(version) = value.get("catalog_version").and_then(Json::as_str) else {
        diags.push(Diagnostic::error(
            "E6003",
            format!("catalog '{origin}' is missing catalog_version"),
            primary,
        ));
        return (None, diags);
    };
    let Some(entries) = value.get("entries").and_then(Json::as_arr) else {
        diags.push(Diagnostic::error(
            "E6003",
            format!("catalog '{origin}' is missing the entries array"),
            primary,
        ));
        return (None, diags);
    };
    let mut catalog = Catalog {
        version: version.to_string(),
        entries: HashMap::new(),
        order: Vec::new(),
    };
    for entry in entries {
        match parse_entry(entry) {
            Ok(parsed) => {
                if catalog.entries.contains_key(&parsed.id) {
                    diags.push(Diagnostic::error(
                        "E6003",
                        format!(
                            "catalog '{origin}' has a duplicate entry id '{}'",
                            parsed.id
                        ),
                        primary,
                    ));
                    continue;
                }
                catalog.order.push(parsed.id.clone());
                catalog.entries.insert(parsed.id.clone(), parsed);
            }
            Err((code, message)) => {
                diags.push(Diagnostic::error(
                    code,
                    format!("catalog '{origin}': {message}"),
                    primary,
                ));
            }
        }
    }
    if diags.iter().any(|d| d.code == "E6003" || d.code == "E6004") {
        return (None, diags);
    }
    (Some(catalog), diags)
}

/// Parse one entry object into its checkable shape.
fn parse_entry(entry: &Json) -> Result<CatalogEntry, (&'static str, String)> {
    let id = entry
        .get("id")
        .and_then(Json::as_str)
        .ok_or(("E6003", "entry is missing its id".to_string()))?;
    if id.is_empty() {
        return Err(("E6003", "entry has an empty id".to_string()));
    }
    let kind = match entry.get("kind").and_then(Json::as_str) {
        Some("builtin") => EntryKind::Builtin,
        Some("helper") => EntryKind::Helper,
        Some("component") => EntryKind::Component,
        other => {
            return Err((
                "E6003",
                format!(
                    "entry '{id}' has an unknown kind {}, want builtin|helper|component",
                    other.map_or("missing".to_string(), |v| format!("'{v}'")),
                ),
            ));
        }
    };
    let effects = match kind {
        EntryKind::Component => match entry.get("effects") {
            None | Some(Json::Null) => None,
            Some(_) => {
                return Err((
                    "E6003",
                    format!("entry '{id}' is a component and must not carry an effects field"),
                ));
            }
        },
        EntryKind::Builtin | EntryKind::Helper => match entry.get("effects").and_then(Json::as_str)
        {
            Some("pure") => Some(Effects::Pure),
            Some("server-default-only") => Some(Effects::ServerDefaultOnly),
            Some("state-read") => Some(Effects::StateRead),
            other => {
                return Err((
                    "E6003",
                    format!(
                        "entry '{id}' has unknown effects {}, want pure|server-default-only|state-read",
                        other.map_or("missing".to_string(), |v| format!("'{v}'")),
                    ),
                ));
            }
        },
    };
    let availability = match entry.get("availability").and_then(Json::as_str) {
        Some("planned") => Availability::Planned,
        Some("implemented") => Availability::Implemented,
        Some("external") => Availability::External,
        other => {
            return Err((
                "E6003",
                format!(
                    "entry '{id}' has unknown availability {}, want planned|implemented|external",
                    other.map_or("missing".to_string(), |v| format!("'{v}'")),
                ),
            ));
        }
    };
    let signature = entry
        .get("signature")
        .and_then(Json::as_str)
        .ok_or_else(|| ("E6003", format!("entry '{id}' is missing its signature")))?;
    let (overloads, component_signature, component) = match kind {
        EntryKind::Builtin => (parse_signature(id, signature)?, None, None),
        EntryKind::Helper => {
            check_helper_spine(id, signature)?;
            (Vec::new(), None, None)
        }
        EntryKind::Component => {
            if signature.trim().is_empty() {
                return Err((
                    "E6003",
                    format!("entry '{id}' is a component with an empty signature"),
                ));
            }
            (
                Vec::new(),
                Some(signature.to_string()),
                Some(parse_component_shape(id, entry)?),
            )
        }
    };
    Ok(CatalogEntry {
        id: id.to_string(),
        js: entry
            .get("js")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        owner: entry
            .get("owner")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        kind,
        overloads,
        component_signature,
        effects,
        availability,
        deprecation: entry
            .get("deprecation")
            .and_then(Json::as_str)
            .map(str::to_string),
        component,
    })
}

/// Parse the per-kind extras of a component entry: required
/// `profile`/`header` vocabulary tags plus optional `attributes`,
/// `slots` and `alternates`. `appearance`/`notes` are ignored.
fn parse_component_shape(id: &str, entry: &Json) -> Result<ComponentShape, (&'static str, String)> {
    let word = |key: &str, vocab: &[&str]| -> Result<String, (&'static str, String)> {
        match entry.get(key).and_then(Json::as_str) {
            Some(value) if vocab.contains(&value) => Ok(value.to_string()),
            other => Err((
                "E6003",
                format!(
                    "entry '{id}' has an unknown {key} {}, want one of {}",
                    other.map_or("missing".to_string(), |v| format!("'{v}'")),
                    vocab.join("|"),
                ),
            )),
        }
    };
    let profile = word("profile", &COMPONENT_PROFILES)?;
    let header = word("header", &COMPONENT_HEADERS)?;
    let strings = |key: &str| -> Result<Vec<String>, (&'static str, String)> {
        match entry.get(key) {
            None | Some(Json::Null) => Ok(Vec::new()),
            Some(value) => match value.as_arr() {
                Some(items) => {
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        match item.as_str() {
                            Some(name) => out.push(name.to_string()),
                            None => {
                                return Err((
                                    "E6003",
                                    format!("entry '{id}' has a non-string in its {key} array"),
                                ));
                            }
                        }
                    }
                    Ok(out)
                }
                None => Err((
                    "E6003",
                    format!("entry '{id}' has a non-array {key}; want an array of strings"),
                )),
            },
        }
    };
    let attributes = strings("attributes")?;
    let alternates = strings("alternates")?;
    for alternate in &alternates {
        if !COMPONENT_PROFILES.contains(&alternate.as_str()) {
            return Err((
                "E6003",
                format!("entry '{id}' has an unknown alternates profile '{alternate}'"),
            ));
        }
    }
    let mut slots = Vec::new();
    match entry.get("slots") {
        None | Some(Json::Null) => {}
        Some(value) => match value.as_arr() {
            Some(items) => {
                for item in items {
                    let name = item.get("name").and_then(Json::as_str).ok_or((
                        "E6003",
                        format!("entry '{id}' has a slot without a string name"),
                    ))?;
                    let required = item.get("required").and_then(Json::as_bool).ok_or((
                        "E6003",
                        format!("entry '{id}' has a slot '{name}' without a boolean required"),
                    ))?;
                    let repeatable = item.get("repeatable").and_then(Json::as_bool).ok_or((
                        "E6003",
                        format!("entry '{id}' has a slot '{name}' without a boolean repeatable"),
                    ))?;
                    slots.push(ComponentSlot {
                        name: name.to_string(),
                        required,
                        repeatable,
                    });
                }
            }
            None => {
                return Err((
                    "E6003",
                    format!("entry '{id}' has a non-array slots; want an array of slot objects"),
                ));
            }
        },
    }
    Ok(ComponentShape {
        profile,
        header,
        attributes,
        slots,
        alternates,
    })
}

/// Sanity-check a helper signature spine: it must start with the entry id
/// followed by balanced `(...)`, then `->`, then a result. Trailing
/// `;`-prose is producer-internal notes, never a source-callable shape.
fn check_helper_spine(id: &str, signature: &str) -> Result<(), (&'static str, String)> {
    let head = format!("{id}(");
    let rest = signature.strip_prefix(head.as_str()).ok_or_else(|| {
        (
            "E6004",
            format!("entry '{id}' has a signature that does not start with '{id}(...)->...'"),
        )
    })?;
    let mut depth = 1u32;
    let mut end = None;
    for (i, b) in rest.bytes().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(end) = end else {
        return Err((
            "E6004",
            format!("entry '{id}' has unbalanced parentheses in its signature"),
        ));
    };
    if !rest[end + 1..].starts_with("->") {
        return Err((
            "E6004",
            format!("entry '{id}' has a signature without '->' after its parameters"),
        ));
    }
    Ok(())
}

/// Parse a builtin `;`-separated overload list.
fn parse_signature(id: &str, signature: &str) -> Result<Vec<SigOverload>, (&'static str, String)> {
    let mut overloads = Vec::new();
    for part in split_top_level(signature, &[';']) {
        let part = part.trim();
        if part.is_empty() {
            return Err((
                "E6004",
                format!("entry '{id}' has an empty overload segment in its signature"),
            ));
        }
        overloads.push(parse_overload(id, part)?);
    }
    if overloads.is_empty() {
        return Err(("E6004", format!("entry '{id}' has an empty signature")));
    }
    Ok(overloads)
}

/// Parse one `id(params)->result` overload.
fn parse_overload(id: &str, text: &str) -> Result<SigOverload, (&'static str, String)> {
    let head = format!("{id}(");
    let rest = text.strip_prefix(head.as_str()).ok_or_else(|| {
        (
            "E6004",
            format!("entry '{id}' has an overload that does not start with '{id}(' in '{text}'"),
        )
    })?;
    let mut depth = 1u32;
    let mut end = None;
    for (i, b) in rest.bytes().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(end) = end else {
        return Err((
            "E6004",
            format!("entry '{id}' has unbalanced parentheses in '{text}'"),
        ));
    };
    let params_text = &rest[..end];
    let after = rest[end + 1..].trim();
    let result_text = after.strip_prefix("->").ok_or_else(|| {
        (
            "E6004",
            format!("entry '{id}' has an overload without '->' in '{text}'"),
        )
    })?;
    let mut parser = SigParser {
        id,
        text: result_text.trim(),
        pos: 0,
    };
    let result = parser.parse_shape()?;
    parser.expect_end()?;
    let mut params = Vec::new();
    if !params_text.trim().is_empty() {
        for part in split_top_level(params_text, &[',']) {
            let part = part.trim();
            if part.is_empty() {
                return Err((
                    "E6004",
                    format!("entry '{id}' has an empty parameter in '{text}'"),
                ));
            }
            params.push(parse_param(id, part)?);
        }
    }
    Ok(SigOverload { params, result })
}

/// Parse one `name:Shape` parameter, with optional `as x` / `in x scope`.
fn parse_param(id: &str, text: &str) -> Result<SigParam, (&'static str, String)> {
    let (name, shape_text) = text.split_once(':').ok_or_else(|| {
        (
            "E6004",
            format!("entry '{id}' has a parameter without ':' in '{text}'"),
        )
    })?;
    let name = name.trim();
    if name.is_empty() || !is_sig_name(name) {
        return Err((
            "E6004",
            format!("entry '{id}' has an invalid parameter name in '{text}'"),
        ));
    }
    let mut shape_text = shape_text.trim().to_string();
    let mut alias = None;
    let mut in_scope = None;
    if let Some((before, after)) = split_scope_suffix(&shape_text) {
        in_scope = Some(after);
        shape_text = before;
    } else if let Some((before, after)) = split_alias_suffix(&shape_text) {
        alias = Some(after);
        shape_text = before;
    }
    let mut parser = SigParser {
        id,
        text: shape_text.as_str(),
        pos: 0,
    };
    let ty = parser.parse_shape()?;
    parser.expect_end()?;
    Ok(SigParam {
        name: name.to_string(),
        ty,
        alias,
        in_scope,
    })
}

/// Split a trailing ` in x scope` marker.
fn split_scope_suffix(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let (before, marker) = text.rsplit_once(" in ")?;
    let marker = marker.trim();
    let var = marker.strip_suffix(" scope")?.trim();
    if !is_sig_name(var) || before.trim().is_empty() {
        return None;
    }
    Some((before.trim().to_string(), var.to_string()))
}

/// Split a trailing ` as x` marker.
fn split_alias_suffix(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let (before, var) = text.rsplit_once(" as ")?;
    let var = var.trim();
    if !is_sig_name(var) || before.trim().is_empty() {
        return None;
    }
    Some((before.trim().to_string(), var.to_string()))
}

/// Whether `word` is a signature identifier.
fn is_sig_name(word: &str) -> bool {
    let mut chars = word.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Split on any of `seps` at angle/paren/brace depth zero.
fn split_top_level(text: &str, seps: &[char]) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth_paren = 0u32;
    let mut depth_angle = 0u32;
    let mut depth_brace = 0u32;
    let mut start = 0usize;
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth_paren += 1,
            ')' => depth_paren = depth_paren.saturating_sub(1),
            '<' => depth_angle += 1,
            '>' => depth_angle = depth_angle.saturating_sub(1),
            '{' => depth_brace += 1,
            '}' => depth_brace = depth_brace.saturating_sub(1),
            _ => {}
        }
        if depth_paren == 0 && depth_angle == 0 && depth_brace == 0 && seps.contains(&c) {
            parts.push(text[start..i].to_string());
            start = i + c.len_utf8();
        }
    }
    parts.push(text[start..].to_string());
    parts
}

/// Recursive-descent parser for one signature `Shape`.
struct SigParser<'a> {
    id: &'a str,
    text: &'a str,
    pos: usize,
}

impl SigParser<'_> {
    fn error(&self, what: &str) -> (&'static str, String) {
        (
            "E6004",
            format!(
                "entry '{}' has an unsupported signature shape: {what}",
                self.id
            ),
        )
    }

    fn expect_end(&self) -> Result<(), (&'static str, String)> {
        if self.text[self.pos..].trim().is_empty() {
            Ok(())
        } else {
            Err(self.error(&format!("trailing text in '{}'", self.text)))
        }
    }

    /// Parse `Shape := Postfix { '|' Postfix }`.
    fn parse_shape(&mut self) -> Result<SigType, (&'static str, String)> {
        let mut arms = vec![self.parse_postfix()?];
        loop {
            self.skip_ws();
            if self.consume('|') {
                arms.push(self.parse_postfix()?);
            } else {
                break;
            }
        }
        if arms.len() == 1 {
            Ok(arms.pop().expect("one arm"))
        } else {
            Ok(SigType::Union(arms))
        }
    }

    /// Parse `Postfix := Atom { '?' | '[]' }`.
    fn parse_postfix(&mut self) -> Result<SigType, (&'static str, String)> {
        let mut ty = self.parse_atom()?;
        loop {
            self.skip_ws();
            if self.consume('?') {
                ty = SigType::Nullable(Box::new(ty));
            } else if self.text[self.pos..].starts_with("[]") {
                self.pos += 2;
                ty = SigType::Array(Box::new(ty));
            } else {
                break;
            }
        }
        Ok(ty)
    }

    /// Parse one atomic shape.
    fn parse_atom(&mut self) -> Result<SigType, (&'static str, String)> {
        self.skip_ws();
        let rest = &self.text[self.pos..];
        if rest.starts_with("nonempty C<") {
            self.pos += "nonempty C<".len();
            let inner = self.parse_shape()?;
            self.expect('>')?;
            return Ok(SigType::NonemptyCollection(Box::new(inner)));
        }
        if rest.starts_with("ordered C<") {
            self.pos += "ordered C<".len();
            let inner = self.parse_shape()?;
            self.expect('>')?;
            return Ok(SigType::OrderedCollection(Box::new(inner)));
        }
        if rest.starts_with("C<") {
            self.pos += 2;
            let inner = self.parse_shape()?;
            self.expect('>')?;
            return Ok(SigType::Collection(Box::new(inner)));
        }
        if rest.starts_with("enum(") {
            self.pos += "enum(".len();
            let mut cases = Vec::new();
            loop {
                self.skip_ws();
                let case = self.parse_ident()?;
                cases.push(case);
                self.skip_ws();
                if self.consume(',') {
                    continue;
                }
                break;
            }
            self.expect(')')?;
            return Ok(SigType::EnumCases(cases));
        }
        if rest.starts_with("closed object of Display") {
            self.pos += "closed object of Display".len();
            return Ok(SigType::ClosedDisplayObject);
        }
        if rest.starts_with("closed object of every record parameter") {
            self.pos += "closed object of every record parameter".len();
            return Ok(SigType::ActionBindings);
        }
        // Lane-02's live wording for the same closed identity-input
        // object (its `invocation` entry); enforced identically.
        if rest.starts_with("complete owning input object") {
            self.pos += "complete owning input object".len();
            return Ok(SigType::ActionBindings);
        }
        // Lane-02 writes both `canonical user mutation` (older entries)
        // and `canonical local user mutation` (live `invocation` entry)
        // for an untrusted local operation target.
        if let Some(after) = rest.strip_prefix("canonical ") {
            let after = after.strip_prefix("local ").unwrap_or(after);
            if let Some(tail) = after.strip_prefix("user mutation") {
                self.pos += rest.len() - tail.len();
                return Ok(SigType::ActionTarget);
            }
        }
        if rest.starts_with("singleton action(target)") {
            self.pos += "singleton action(target)".len();
            return Ok(SigType::ActionResult);
        }
        // Lane-02's live constructor result wording.
        if rest.starts_with("singleton invocation(target)") {
            self.pos += "singleton invocation(target)".len();
            return Ok(SigType::ActionResult);
        }
        if rest.starts_with('{') {
            self.pos += 1;
            let mut fields = Vec::new();
            loop {
                self.skip_ws();
                if self.consume('}') {
                    break;
                }
                let name = self.parse_ident()?;
                self.skip_ws();
                self.expect(':')?;
                let ty = self.parse_shape()?;
                fields.push((name, ty));
                self.skip_ws();
                if self.consume(',') {
                    self.skip_ws();
                    if self.text[self.pos..].starts_with('}') {
                        continue;
                    }
                    continue;
                }
                self.skip_ws();
                if self.text[self.pos..].starts_with('}') {
                    continue;
                }
                return Err(self.error(&format!("expected ',' or '}}' in '{}'", self.text)));
            }
            return Ok(SigType::Object(fields));
        }
        let ident = self.parse_ident()?;
        match ident.as_str() {
            "T" => Ok(SigType::Any),
            "O" => Ok(SigType::Ordered),
            "S" => Ok(SigType::StringLike),
            "K" => Ok(SigType::GroupKey),
            "Display" => Ok(SigType::Display),
            "message" => Ok(SigType::Message),
            _ => Ok(SigType::Named(ident)),
        }
    }

    fn parse_ident(&mut self) -> Result<String, (&'static str, String)> {
        self.skip_ws();
        let start = self.pos;
        let mut chars = self.text[self.pos..].chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {
                self.pos += c.len_utf8();
            }
            _ => return Err(self.error(&format!("expected a name in '{}'", self.text))),
        }
        for c in chars {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        Ok(self.text[start..self.pos].to_string())
    }

    fn skip_ws(&mut self) {
        while self.text[self.pos..].starts_with([' ', '\t']) {
            self.pos += 1;
        }
    }

    fn consume(&mut self, c: char) -> bool {
        if self.text[self.pos..].starts_with(c) {
            self.pos += c.len_utf8();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: char) -> Result<(), (&'static str, String)> {
        self.skip_ws();
        if self.consume(c) {
            Ok(())
        } else {
            Err(self.error(&format!("expected '{c}' in '{}'", self.text)))
        }
    }
}

impl Catalog {
    /// Envelope `catalog_version`.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Entry ids in catalog order.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.order.iter().map(String::as_str)
    }

    /// Look up one entry by id.
    pub fn lookup(&self, id: &str) -> Option<&CatalogEntry> {
        self.entries.get(id)
    }

    /// Checked overloads of a builtin id, or `None` when the id names a
    /// helper or is absent.
    pub fn overloads(&self, id: &str) -> Option<&[SigOverload]> {
        match self.entries.get(id) {
            Some(entry) if entry.kind == EntryKind::Builtin => Some(&entry.overloads),
            _ => None,
        }
    }

    /// Availability of one entry id.
    pub fn availability(&self, id: &str) -> Option<Availability> {
        self.entries.get(id).map(|e| e.availability)
    }

    /// Effect class of one entry id (`None` for components, which
    /// carry no such field, and for unknown ids).
    pub fn effects(&self, id: &str) -> Option<Effects> {
        self.entries.get(id).and_then(|e| e.effects)
    }

    /// Deprecation notice of one entry id, when the producer marks one.
    pub fn deprecation(&self, id: &str) -> Option<&str> {
        self.entries.get(id).and_then(|e| e.deprecation.as_deref())
    }

    /// Whether `id` names a codegen-only helper.
    pub fn is_helper(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.kind == EntryKind::Helper)
    }

    /// Whether `id` names a builtin (callable shape present).
    pub fn is_builtin(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.kind == EntryKind::Builtin)
    }

    /// Whether `id` names a lane-05 component (recorded, never
    /// source-callable; PR5 interprets the shape).
    pub fn is_component(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.kind == EntryKind::Component)
    }

    /// Component extras of one entry id, when it names a component.
    pub fn component(&self, id: &str) -> Option<&ComponentShape> {
        self.entries.get(id).and_then(|e| e.component.as_ref())
    }
}
