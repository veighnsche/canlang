//! Given trait contributions and compiler-owned keyword producer contracts.
//!
//! Source, schema and authority checks stay together in this private checker.

use std::collections::{HashMap, HashSet};

use crate::analysis::{self as analysis, kids};
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::{
    FieldModifier, ResolvedType, Scalar, duration_millis, field_parts, is_placeholder_key,
    modifier_value, string_literal_value, valid_date, valid_datetime, validated_shape,
};

// --- BGI-07 Given trait/keyword contracts ----------------------------------
// Checked contracts for generated Given behavior: named/inline model/field
// trait contributions from saved `contributions.can` carriers, and named
// standalone custom-keyword bindings to compiler-owned owner-versioned
// producer schemas. Entry: [`check_given_contract_tables`] (aggregated by
// `analysis::check::check_given_contracts`).
//
// Carriers: trait contributions are ordinary Given model/field
// declarations parsed by the existing grammar and interpreted as
// contributions owned by the associated trait application — a named
// trait's carrier declares a template model named for the trait (one
// template instantiates every compatible application in source order),
// an inline trait's carrier declares its target model directly.
// Keyword owner-visible declarations are structured claims (producer,
// export, reads/effects/authority) checked against the definition
// signature and the compiler-owned producer schema: novel keyword
// semantics are never lowered to existing Can expressions, and no
// metadata string self-registers a producer, storage or authority.
//
// The saved implementation JavaScript is opaque here: it is fingerprinted
// into the contract (direct edits change the fingerprint and need
// re-activation downstream) but never parsed or executed — no module
// runs to discover schema or authority. Export/interface verification
// against actual JS is BGI-11 target validation, not this layer.

/// The initial compiler-owned Given producer: State computes canonical
/// unique keys from checked text input through its existing fenced
/// claim/release staging. One integration, not the extension ceiling:
/// future producers need explicit owner integration.
pub const GIVEN_PRODUCER_UNIQUE_KEY: &str = "state.unique-key@1";

/// Fixed key semantics of [`GIVEN_PRODUCER_UNIQUE_KEY`]: NFKC
/// normalization followed by ASCII lowercase. Compiler-owned, never
/// generator-chosen; stored spelling is preserved and no helper stored
/// field is introduced.
pub const GIVEN_UNIQUE_KEY_SEMANTICS: &str = "nfkc-ascii-lowercase";

/// Lifecycle binding of [`GIVEN_PRODUCER_UNIQUE_KEY`]: the pure
/// implementation evaluates old/final keys around the existing single
/// fenced commit; State owns claim namespaces, releases, collisions and
/// replay. Generated exports have no raw claim/store/commit authority.
pub const GIVEN_UNIQUE_KEY_LIFECYCLE: &str = "commit-keys";

/// Whether `producer` names a compiler-owned Given producer schema.
/// Unknown ids refuse (`E3023`): generated code selects from this
/// registry, it never invents producers.
pub fn given_producer_known(producer: &str) -> bool {
    matches!(
        producer,
        GIVEN_PRODUCER_UNIQUE_KEY | GIVEN_PRODUCER_FIELD_VALIDATION
    )
}

/// Owner-visible structured claims of one saved keyword unit: the
/// producer selection, saved export and declared reads/effects/
/// authority the compiler checks against the keyword definition and
/// the producer schema.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GivenSavedDeclaration {
    /// Selected owner-versioned producer (must be compiler-known).
    pub producer: String,
    /// Saved JS export implementing the behavior (recorded; BGI-11
    /// verifies it against the actual module).
    pub export: String,
    /// Declared staged reads (empty for pure producers).
    pub reads: Vec<String>,
    /// Declared effects (empty for pure producers).
    pub effects: Vec<String>,
    /// Declared authority (empty: canonical owners admit bindings).
    pub authority: Vec<String>,
}

/// Fixed export in the source-derived initial pure producer contract.
pub const GIVEN_UNIQUE_KEY_EXPORT: &str = "canonicalKey";

/// Fixed, source-derived field-trait validation seam.
pub const GIVEN_PRODUCER_FIELD_VALIDATION: &str = "state.field-validation@1";
pub const GIVEN_FIELD_VALIDATION_EXPORT: &str = "check";
pub const GIVEN_FIELD_VALIDATION_LIFECYCLE: &str = "validate-fields";

/// Derive the admitted v1 pure binding from the owning source signature.
/// Other producers require explicit compiler/owner admission; generated code
/// cannot choose a producer, claim namespace or authority through metadata.
pub fn given_declaration_for_source(
    definition: &analysis::generation::GenerationDescriptor,
) -> Option<GivenSavedDeclaration> {
    use analysis::generation::GenerationKind;
    let params = &definition.params;
    (definition.kind == GenerationKind::KeywordDefinition
        && params.len() == 2
        && params[0].kind == "model"
        && params[1].kind == "field"
        && params[1].target_param.as_deref() == Some(params[0].name.as_str())
        && params[1].type_name.as_deref() == Some("text"))
    .then(|| GivenSavedDeclaration {
        producer: GIVEN_PRODUCER_UNIQUE_KEY.to_string(),
        export: GIVEN_UNIQUE_KEY_EXPORT.to_string(),
        reads: Vec::new(),
        effects: Vec::new(),
        authority: Vec::new(),
    })
}

/// One consumed unit-local import of a saved implementation: the
/// resolved unit-relative path plus its exact bytes. The host resolves
/// the transitive closure (see `can gen validate`); this layer only
/// fingerprints what the host consumed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GivenSavedImport {
    /// Unit-relative path with `/` separators (e.g. `fold.js`).
    pub rel_path: String,
    /// Exact consumed bytes.
    pub bytes: Vec<u8>,
}

/// Saved implementation inputs for one generation unit, keyed by its
/// BGI-02 [`analysis::generation_intake::AssociationKey`]. The host
/// supplies these from the associated saved group; a definition with
/// no entry is pending generation (exposed for preparation, never an
/// error here).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GivenSavedUnit {
    /// Opaque unit id (association evidence, recorded in the contract).
    pub unit_id: String,
    /// `contributions.can` carrier text (a [`SourceDb`] entry holding
    /// ordinary Given declarations; traits require it, the v1 keyword
    /// producer admits none).
    pub contributions: Option<SourceId>,
    /// Saved implementation JavaScript bytes. Fingerprinted only, never
    /// parsed or executed.
    pub implementation_js: Option<String>,
    /// Consumed unit-local import closure of the saved implementation
    /// (transitively resolved by the host; empty when the root module
    /// imports nothing). Fingerprinted with the root bytes, never
    /// parsed or executed.
    pub implementation_imports: Vec<GivenSavedImport>,
    /// Structured owner-visible declaration (keyword units require it).
    pub declaration: Option<GivenSavedDeclaration>,
}

/// Fingerprint one saved implementation plus its exact consumed
/// unit-local import closure. This is the cross-host activation
/// identity both the Rust check and the Node runtime share:
///
/// * no imports: `sha256_hex(root)` — the historical single-file
///   fingerprint, unchanged;
/// * otherwise: `sha256_hex` over `len(root)` as eight big-endian
///   bytes, the root bytes, then one length-framed entry per import in
///   byte-ascending `rel_path` order (`len(rel)` big-endian, the
///   UTF-8 path, `len(bytes)` big-endian, the bytes).
///
/// Length framing keeps distinct closures distinct; path ordering
/// keeps the hash independent of source order. Any consumed-byte
/// change alters the fingerprint, so root-only equality can never
/// hide changed behavior.
pub fn given_closure_fingerprint(root: &[u8], imports: &[(&str, &[u8])]) -> String {
    if imports.is_empty() {
        return sha256_hex(root);
    }
    let mut ordered: Vec<(&str, &[u8])> = imports.to_vec();
    ordered.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut input = Vec::new();
    input.extend_from_slice(&(root.len() as u64).to_be_bytes());
    input.extend_from_slice(root);
    for (rel, bytes) in ordered {
        input.extend_from_slice(&(rel.len() as u64).to_be_bytes());
        input.extend_from_slice(rel.as_bytes());
        input.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        input.extend_from_slice(bytes);
    }
    sha256_hex(&input)
}

/// One typed schema leaf of a checked Given contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenFieldSchema {
    /// Leaf name (field or binding name).
    pub name: String,
    /// Checked type text (`text`, `bool`, `int`, ...).
    pub type_name: String,
}

/// One field contributed by a trait template to its applications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GivenContributedField {
    /// Checked static literal caption. Generated descriptors and references
    /// are not admitted; authored field-constraint captions remain authoritative.
    pub label: Option<String>,
    /// Contributed field name.
    pub name: String,
    /// Checked contributed type text.
    pub type_name: String,
    /// Checked default constant (source text). Model applications
    /// require one (existing creates and fixtures stay valid only
    /// with it); field-constraint templates may omit it to carry no
    /// default opinion.
    pub default: Option<String>,
    /// Contributed `trim` normalization.
    pub trim: bool,
    /// Contributed `min=` bound (source text), when given.
    pub min: Option<String>,
    /// Contributed `max=` bound (source text), when given.
    pub max: Option<String>,
}

/// One checked trait application: the instantiation site of a saved
/// trait template, in explicit source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedTraitApplication {
    /// Target model name as written.
    pub target_model: String,
    /// Target field name for field attachments (`None` for models).
    pub target_field: Option<String>,
    /// Canonical target identity (`Owner.Model[.field]`).
    pub target_canonical: String,
    /// Application span (inline attachments: the definition span).
    pub span: Span,
    /// Source order among the definition's applications.
    pub order: usize,
}

/// Checked contract of one trait definition: its saved template plus
/// every compatible application reusing that saved unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedTraitContract {
    /// Trait name (`None` for one-off inline attachments).
    pub name: Option<String>,
    /// Whether this contract owns a one-off inline attachment.
    pub inline: bool,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit every application reuses (zero AI per application).
    pub unit_id: String,
    /// Applications in explicit source order.
    pub applications: Vec<CheckedTraitApplication>,
    /// Template fields instantiated per model application (a single
    /// constraint template for field-only traits).
    pub contributed_fields: Vec<GivenContributedField>,
    /// SHA-256 over the contributions carrier bytes; direct edits
    /// change it and need downstream re-activation.
    pub fingerprint: String,
    /// Exact saved check implementation closure, separate from carrier identity.
    pub validation_fingerprint: Option<String>,
}

/// One checked keyword application: a standalone use bound to the
/// definition's saved implementation and producer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedKeywordApplication {
    /// Compiler-owned rule identity
    /// (`Owner.Model.field#keyword`).
    pub rule_id: String,
    /// Canonical target model identity.
    pub target_model: String,
    /// Canonical target field identity.
    pub target_field: String,
    /// Resolved arguments: reference kinds carry canonical identities,
    /// constants carry their checked source text.
    pub args: Vec<(String, String)>,
    /// Application span.
    pub span: Span,
    /// Source order among the definition's applications.
    pub order: usize,
}

/// Checked owner-producer descriptor of one keyword definition: the
/// declaring identity, signature/targets, typed inputs/outputs,
/// lifecycle, reads/dependencies, effects, authority and saved binding
/// its new behavior needs. Keyword semantics are never lowered to
/// existing Can expressions or model/field/default/check roles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedKeywordContract {
    /// Keyword name (the standalone declaration form it defines).
    pub name: String,
    /// Definition anchor (the stable association key).
    pub anchor: String,
    /// Saved unit every application reuses (zero AI per application).
    pub unit_id: String,
    /// Bound owner-versioned producer (compiler-known).
    pub producer: String,
    /// Fixed producer semantics id (compiler-owned).
    pub semantics: String,
    /// Producer lifecycle binding (compiler-owned).
    pub lifecycle: String,
    /// Saved export implementing the behavior.
    pub export: String,
    /// Typed input schema derived from the bound arguments.
    pub input: GivenFieldSchema,
    /// Typed result schema (producer-fixed).
    pub result: String,
    /// Admitted reads (empty for pure producers).
    pub reads: Vec<String>,
    /// Admitted effects (empty for pure producers).
    pub effects: Vec<String>,
    /// Admitted authority (empty: canonical owners admit bindings).
    pub authority: Vec<String>,
    /// Canonical value dependencies (the bound field).
    pub dependencies: Vec<String>,
    /// SHA-256 over the saved implementation closure bytes; direct
    /// edits change it and need downstream re-activation.
    pub fingerprint: String,
    /// Applications in explicit source order.
    pub applications: Vec<CheckedKeywordApplication>,
}

/// Checked Given contracts: trait contributions and keyword bindings.
/// Only clean units appear here — a unit with any diagnostic keeps its
/// diagnostics and contributes no contract (fail-closed per contract,
/// other units unaffected).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GivenContractTables {
    /// Trait contracts in definition source order.
    pub traits: Vec<CheckedTraitContract>,
    /// Keyword contracts in definition source order.
    pub keywords: Vec<CheckedKeywordContract>,
}

/// `E3020`: a contribution or binding targets the wrong declaration or
/// shape (wrong model/field, producer-signature mismatch, ill-formed
/// contributed type).
fn given_target_mismatch(what: &str, detail: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        "E3020",
        format!("incompatible given contribution: {what} {detail}"),
        span,
    )
}

/// `E3021`: a contribution or binding conflicts (already declared,
/// already contributed, already bound, or clashing with a builtin).
fn given_conflict(what: &str, detail: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        "E3021",
        format!("conflicting given contribution: {what} {detail}"),
        span,
    )
}

/// `E3022`: a contribution carries a contradictory or ill-typed value
/// (contradictory default, default violating its type or bounds,
/// missing default on a contributed field).
fn given_bad_value(what: &str, detail: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        "E3022",
        format!("contradictory given contribution: {what} {detail}"),
        span,
    )
}

/// `E3023`: a keyword unit cannot bind its producer (unknown producer,
/// missing declaration or missing saved implementation).
fn given_producer_refused(what: &str, detail: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        "E3023",
        format!("given producer binding refused: {what} {detail}"),
        span,
    )
}

/// `E3024`: a saved declaration does not match its keyword definition
/// (missing export, undeclared inputs/outputs).
fn given_declaration_mismatch(what: &str, detail: &str, span: Span) -> Diagnostic {
    Diagnostic::error(
        "E3024",
        format!("given declaration mismatch: {what} {detail}"),
        span,
    )
}

/// Whitespace-collapsed source text of a node (comments never appear:
/// the parser keeps them out of significant structure).
fn given_normalized(node: &SyntaxNode, text: &str) -> String {
    text[node.span.start as usize..node.span.end as usize]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Source text of a constant expression, retaining quoted whitespace even
/// inside arrays. Whitespace normalization must never change literal values.
fn given_const_text(node: &SyntaxNode, text: &str) -> String {
    text[node.span.start as usize..node.span.end as usize]
        .trim()
        .to_string()
}

/// First `Name` leaf text of a node (model/field/section heads).
fn given_first_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .find_map(|c| c.token().map(|t| t.text(text)))
}

/// Constants use the ordinary scalar shape/range validators and the exact
/// Values decimal owner. No ambient expression or nominal handle can become
/// a source default through a string/bare-token fallback.
fn given_const_matches_type(type_text: &str, const_text: &str) -> bool {
    let value = const_text.trim();
    if let Some(inner) = type_text.strip_suffix('?') {
        return value == "null" || given_const_matches_type(inner, value);
    }
    if let Some(elem) = type_text.strip_suffix("[]") {
        if !(value.starts_with('[') && value.ends_with(']')) {
            return false;
        }
        let inner = &value[1..value.len().saturating_sub(1)];
        return inner.trim().is_empty()
            || split_given_consts(inner)
                .iter()
                .all(|el| given_const_matches_type(elem, el));
    }
    if let Some(cases) = type_text
        .strip_prefix("enum(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return cases.split(',').any(|c| c.trim() == value);
    }
    match type_text {
        "bool" | "boolean" => matches!(value, "true" | "false"),
        "int" | "integer" => value.parse::<i64>().is_ok(),
        "decimal" => given_decimal(value).is_some(),
        "duration" => duration_millis(value).is_some(),
        "text" | "email" | "timezone" | "date" | "datetime" => {
            let Ok(text) = serde_json::from_str::<String>(value) else {
                return false;
            };
            match type_text {
                "text" => true,
                "email" => validated_shape(Scalar::Email, &text).is_none(),
                "timezone" => validated_shape(Scalar::Timezone, &text).is_none(),
                "date" => valid_date(&text).is_ok(),
                _ => valid_datetime(&text).is_ok(),
            }
        }
        // These native leaves remain available with explicit nullable/array
        // defaults, but source constants cannot manufacture their values.
        _ => false,
    }
}

/// Reuse exact native decimal parsing; never round a checked constant via f64.
fn given_decimal(value: &str) -> Option<values_semantics::representations::numeric::Value> {
    use values_semantics::numeric::decimal::parse_decimal;
    use values_semantics::representations::numeric::Value;
    parse_decimal(&Value::Str(value.to_string()))
        .ok()
        .map(Value::Decimal)
}

/// Bound shapes mirror ordinary fields. Native Money constants need their
/// constructor/owner, which the finite contributed-constant path cannot carry.
fn given_bound_matches_type(type_text: &str, value: &str) -> bool {
    let leaf = type_text.strip_suffix('?').unwrap_or(type_text);
    if leaf.ends_with("[]") || matches!(leaf, "text" | "email" | "timezone") {
        return value
            .parse::<u64>()
            .is_ok_and(|n| n <= 9_007_199_254_740_991);
    }
    match leaf {
        "int" | "integer" => value.parse::<i64>().is_ok(),
        "decimal" => given_decimal(value).is_some(),
        "duration" => duration_millis(value).is_some(),
        _ => false,
    }
}

/// Split a bracket body on top-level commas (string/nesting aware).
pub(crate) fn split_given_consts(inner: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    let mut start = 0usize;
    for (i, ch) in inner.char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
        } else if ch == '"' {
            in_str = true;
        } else if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth = depth.saturating_sub(1);
        } else if ch == ',' && depth == 0 {
            parts.push(inner[start..i].trim().to_string());
            start = i + 1;
        }
    }
    parts.push(inner[start..].trim().to_string());
    parts.into_iter().filter(|p| !p.is_empty()).collect()
}

/// One authored model field read structurally from app source.
#[derive(Debug, Clone)]
struct GivenAuthoredField {
    type_text: String,
    default: Option<String>,
    unique: bool,
    min: Option<String>,
    max: Option<String>,
}

/// One authored model read structurally from app source.
#[derive(Debug, Clone, Default)]
struct GivenAuthoredModel {
    fields: HashMap<String, GivenAuthoredField>,
}

/// Read authored models/fields structurally from the checked files:
/// field types, defaults, `unique`/`trim`/`min=`/`max=` modifiers and
/// server/machine markers — the compatibility baseline trait
/// contributions and keyword bindings check against. Keyed by canonical
/// `Owner.Model` (owners from the checked modules, never guessed).
fn given_authored_models(
    db: &SourceDb,
    program: &analysis::CheckedProgram,
) -> HashMap<String, GivenAuthoredModel> {
    let mut out: HashMap<String, GivenAuthoredModel> = HashMap::new();
    for &file in program.checked_files() {
        let Some(source) = db.get(file) else { continue };
        let text = source.text.as_str();
        let (tree, _) = crate::syntax::parse(db, file);
        for node in tree.descendants() {
            if node.kind != SyntaxKind::Model {
                continue;
            }
            let Some(model) = analysis::generation::model_name(node, text) else {
                continue;
            };
            let Some(owner) = program
                .modules
                .iter()
                .find(|module| {
                    module.file == file
                        && module.span.start <= node.span.start
                        && module.span.end >= node.span.end
                })
                .map(|module| &module.name)
            else {
                continue;
            };
            let canonical = format!("{owner}.{model}");
            let entry = out.entry(canonical).or_insert_with(|| GivenAuthoredModel {
                fields: HashMap::new(),
            });
            for child in kids(node) {
                if child.kind != SyntaxKind::Field {
                    continue;
                }
                let Some(name) = given_first_name(child, text) else {
                    continue;
                };
                let parts = field_parts(child, text);
                let type_text = parts
                    .type_node
                    .map(|n| given_normalized(n, text).replace(' ', ""))
                    .unwrap_or_default();
                let default = parts.default.map(|n| given_const_text(n, text));
                let mut field = GivenAuthoredField {
                    type_text,
                    default,
                    unique: false,
                    min: None,
                    max: None,
                };
                for modifier in &parts.modifiers {
                    match modifier {
                        FieldModifier::Unique(_) => field.unique = true,
                        FieldModifier::Min(word) => {
                            field.min =
                                modifier_value(child, word).map(|n| given_const_text(n, text));
                        }
                        FieldModifier::Max(word) => {
                            field.max =
                                modifier_value(child, word).map(|n| given_const_text(n, text));
                        }
                        FieldModifier::Trim(_) | FieldModifier::Machine(_) => {}
                    }
                }
                entry.fields.insert(name.to_string(), field);
            }
        }
    }
    out
}

/// One contributed field read structurally from a carrier.
#[derive(Debug, Clone)]
struct GivenCarrierField {
    label: Option<SyntaxNode>,
    name: String,
    type_text: String,
    default: Option<String>,
    unique: bool,
    trim: bool,
    min: Option<String>,
    max: Option<String>,
    server: bool,
    machine: bool,
    span: Span,
}

/// One model-shaped declaration read from a contributions carrier.
#[derive(Debug, Clone)]
struct GivenCarrierModel {
    name: String,
    span: Span,
    fields: Vec<GivenCarrierField>,
}

/// A refused carrier declaration: its display kind and span.
#[derive(Debug, Clone)]
struct GivenCarrierRefusal {
    kind: String,
    span: Span,
}

/// Declaration kinds a contributions carrier may never hold: operations
/// and scenarios, Given rules and authority, examples, presentation,
/// generation carriers and migrations. Carriers hold model-shaped
/// contribution declarations only; anything else is hidden authority.
fn given_carrier_refused_kind(kind: SyntaxKind) -> Option<&'static str> {
    match kind {
        SyntaxKind::Scenario
        | SyntaxKind::Crud
        | SyntaxKind::Policy
        | SyntaxKind::Invariant
        | SyntaxKind::Unique
        | SyntaxKind::Lock
        | SyntaxKind::Retain
        | SyntaxKind::Fixture
        | SyntaxKind::Capability
        | SyntaxKind::CapabilityOp
        | SyntaxKind::Message
        | SyntaxKind::Contract
        | SyntaxKind::Event
        | SyntaxKind::Role
        | SyntaxKind::Derive => carrier_authority_refusal(kind),
        _ => carrier_content_refusal(kind),
    }
}

/// Operations and scenarios, Given rules and authority: hidden authority
/// a contributions carrier may never hold.
fn carrier_authority_refusal(kind: SyntaxKind) -> Option<&'static str> {
    match kind {
        SyntaxKind::Scenario => Some("scenario"),
        SyntaxKind::Crud => Some("crud"),
        SyntaxKind::Policy => Some("policy"),
        SyntaxKind::Invariant => Some("invariant"),
        SyntaxKind::Unique => Some("unique rule"),
        SyntaxKind::Lock => Some("lock"),
        SyntaxKind::Retain => Some("retain"),
        SyntaxKind::Fixture => Some("fixture"),
        SyntaxKind::Capability | SyntaxKind::CapabilityOp => Some("capability"),
        SyntaxKind::Message => Some("message"),
        SyntaxKind::Contract | SyntaxKind::Event | SyntaxKind::Role => Some("contract"),
        SyntaxKind::Derive => Some("derive"),
        _ => None,
    }
}

/// Examples, presentation, generation carriers and migrations: content a
/// contributions carrier may never hold.
fn carrier_content_refusal(kind: SyntaxKind) -> Option<&'static str> {
    match kind {
        SyntaxKind::Preferences => Some("preferences"),
        SyntaxKind::Corpus => Some("corpus"),
        SyntaxKind::Judgment => Some("judgment"),
        SyntaxKind::Examples => Some("examples"),
        SyntaxKind::View
        | SyntaxKind::Page
        | SyntaxKind::Show
        | SyntaxKind::Form
        | SyntaxKind::Edit => Some("presentation"),
        SyntaxKind::TraitDef | SyntaxKind::TraitApp => Some("nested trait"),
        SyntaxKind::KeywordDef | SyntaxKind::KeywordApp => Some("keyword"),
        SyntaxKind::StyleDef | SyntaxKind::StyleSuffix | SyntaxKind::ViewStyle => Some("style"),
        SyntaxKind::Rename | SyntaxKind::Drop | SyntaxKind::Invalidate | SyntaxKind::Backfill => {
            Some("migration")
        }
        _ => None,
    }
}

/// Parse the accepted Given-only saved contribution carrier. Unit checking
/// separately enforces its declarations, types and absence of effects.
pub(crate) fn parse_given_carrier(file: SourceId, text: &str) -> (SyntaxNode, Vec<Diagnostic>) {
    let (tree, diagnostics) = crate::syntax::parse_source(file, text);
    // Only missing When/Then section notes are expected for this profile.
    // Missing Given and every real syntax error must still be reported.
    let diagnostics = diagnostics
        .into_iter()
        .filter(|d| {
            !(d.code == "E1204"
                && d.message.starts_with("package is missing")
                && !d.message.contains("Given"))
        })
        .collect();
    (tree, diagnostics)
}

/// Read one contributions carrier: model-shaped declarations plus one
/// refusal per unadmitted declaration kind. `##` comments and ordinary
/// descriptions never participate (the parser keeps them out of
/// significant structure).
fn given_read_carrier(
    tree: &SyntaxNode,
    text: &str,
) -> (Vec<GivenCarrierModel>, Vec<GivenCarrierRefusal>) {
    let mut models = Vec::new();
    let mut refusals = Vec::new();
    for node in tree.descendants() {
        if let Some(kind) = given_carrier_refused_kind(node.kind) {
            refusals.push(GivenCarrierRefusal {
                kind: kind.to_string(),
                span: node.span,
            });
            continue;
        }
        if node.kind != SyntaxKind::Model {
            continue;
        }
        let Some(name) = given_first_name(node, text) else {
            continue;
        };
        let mut fields = Vec::new();
        for child in kids(node) {
            if child.kind != SyntaxKind::Field {
                continue;
            }
            let Some(field) = given_first_name(child, text) else {
                continue;
            };
            let parts = field_parts(child, text);
            let mut carrier = GivenCarrierField {
                label: parts.label.cloned(),
                name: field.to_string(),
                type_text: parts
                    .type_node
                    .map(|n| given_normalized(n, text).replace(' ', ""))
                    .unwrap_or_default(),
                default: parts.default.map(|n| given_const_text(n, text)),
                unique: false,
                trim: false,
                min: None,
                max: None,
                server: parts.server.is_some(),
                machine: false,
                span: child.span,
            };
            for modifier in &parts.modifiers {
                match modifier {
                    FieldModifier::Trim(_) => carrier.trim = true,
                    FieldModifier::Unique(_) => carrier.unique = true,
                    FieldModifier::Machine(_) => carrier.machine = true,
                    FieldModifier::Min(word) => {
                        carrier.min =
                            modifier_value(child, word).map(|n| given_const_text(n, text));
                    }
                    FieldModifier::Max(word) => {
                        carrier.max =
                            modifier_value(child, word).map(|n| given_const_text(n, text));
                    }
                }
            }
            fields.push(carrier);
        }
        models.push(GivenCarrierModel {
            name: name.to_string(),
            span: node.span,
            fields,
        });
    }
    (models, refusals)
}

/// Whether a contribution has an existing native State/Values leaf:
/// supported scalars or `enum(...)`, at most one array wrapper, and
/// optional outer nullability. Other types need explicit owner integration;
/// recognizing their spelling alone does not establish native admission.
fn given_wellformed_leaf(type_text: &str) -> bool {
    let mut rest = type_text;
    if let Some(inner) = rest.strip_suffix('?') {
        rest = inner;
    }
    if let Some(elem) = rest.strip_suffix("[]") {
        rest = elem;
    }
    if rest.starts_with("enum(") && rest.ends_with(')') {
        let cases = &rest["enum(".len()..rest.len() - 1];
        let mut seen = HashSet::new();
        return cases.split(',').all(|case| {
            let case = case.trim();
            is_placeholder_key(case) && seen.insert(case)
        });
    }
    matches!(
        rest,
        "bool"
            | "boolean"
            | "int"
            | "integer"
            | "decimal"
            | "text"
            | "email"
            | "date"
            | "datetime"
            | "duration"
            | "timezone"
            | "money"
            | "user"
            | "file"
    )
}

/// Parse an exact numeric/duration bound through the existing scalar owners.
fn given_bound_number(bound: &str) -> Option<values_semantics::representations::numeric::Value> {
    given_decimal(bound.trim()).or_else(|| {
        duration_millis(bound.trim()).and_then(|value| given_decimal(&value.to_string()))
    })
}

/// Compare every admitted min/max pair exactly. Symbolic authored bounds
/// retain the existing conservative textual contradiction rule.
fn given_bounds_contradict(mins: &[&str], maxes: &[&str]) -> bool {
    use values_semantics::numeric::decimal::compare_decimal;
    let numbers: Option<Vec<_>> = mins.iter().map(|bound| given_bound_number(bound)).collect();
    let max_numbers: Option<Vec<_>> = maxes
        .iter()
        .map(|bound| given_bound_number(bound))
        .collect();
    if let (Some(numbers), Some(max_numbers)) = (numbers, max_numbers) {
        return numbers.iter().any(|min| {
            max_numbers
                .iter()
                .any(|max| compare_decimal(min, max).is_ok_and(|order| order > 0))
        });
    }
    let mut seen = HashSet::new();
    for bound in mins.iter().chain(maxes.iter()) {
        seen.insert(bound.trim());
    }
    seen.len() > 1 && !mins.is_empty() && !maxes.is_empty()
}

fn check_trait_template_field(
    field: &GivenCarrierField,
    failed: &mut bool,
    diags: &mut Vec<Diagnostic>,
) -> Option<GivenContributedField> {
    // Generated captions are static literals only. Retain their checked
    // text for the ordinary label pipeline; never resolve ambient names
    // or silently drop a descriptor/table that this contract cannot carry.
    let label = if let Some(node) = &field.label {
        let Some(text) = string_literal_value(node) else {
            *failed = true;
            diags.push(Diagnostic::error(
                "E3016",
                "contributed field label must be a static text literal; generated descriptor, reference and table captions are not admitted".to_string(),
                node.span,
            ));
            return None;
        };
        if let Some(problem) = analysis::icu::static_caption_error(&text) {
            *failed = true;
            diags.push(Diagnostic::error(
                "E5007",
                format!("invalid contributed field label: {problem}"),
                node.span,
            ));
            return None;
        }
        Some(text)
    } else {
        None
    };
    if field.unique {
        *failed = true;
        diags.push(analysis::effects::refuse_given_authority(
            &format!("contributed field `{}`", field.name),
            "claims unique storage semantics, which traits never invent",
            field.span,
        ));
        return None;
    }
    if field.machine {
        *failed = true;
        diags.push(analysis::effects::refuse_given_authority(
            &format!("contributed field `{}`", field.name),
            "claims machine lifecycle semantics, which need explicit integration",
            field.span,
        ));
        return None;
    }
    if field.server {
        *failed = true;
        diags.push(analysis::effects::refuse_given_authority(
            &format!("contributed field `{}`", field.name),
            "claims server-only semantics, which traits never invent",
            field.span,
        ));
        return None;
    }
    if !given_wellformed_leaf(&field.type_text) {
        // A declared model name in this position is a scope refusal,
        // not a dangling reference: v1 contributions are leaves.
        *failed = true;
        diags.push(given_target_mismatch(
            &format!("contributed field `{}`", field.name),
            &format!(
                "has type `{}`; v1 trait contributions require supported native scalar/enum leaves with at most one array and optional outer nullability",
                field.type_text
            ),
            field.span,
        ));
        return None;
    }
    if let Some(default) = field.default.as_deref()
        && !given_const_matches_type(&field.type_text, default)
    {
        *failed = true;
        diags.push(given_bad_value(
            &format!("contributed field `{}`", field.name),
            &format!(
                "default `{default}` does not inhabit `{}`",
                field.type_text
            ),
            field.span,
        ));
        return None;
    }
    if field.trim
        && !matches!(
            field.type_text.trim_end_matches('?'),
            "text" | "email" | "timezone"
        )
    {
        *failed = true;
        diags.push(given_bad_value(
            &format!("contributed field `{}`", field.name),
            "trim requires a string-like native field",
            field.span,
        ));
        return None;
    }
    if let Some((which, value)) = [("min", &field.min), ("max", &field.max)]
        .into_iter()
        .find_map(|(which, value)| {
            value
                .as_deref()
                .filter(|value| !given_bound_matches_type(&field.type_text, value))
                .map(|value| (which, value))
        })
    {
        *failed = true;
        diags.push(given_bad_value(
            &format!("contributed field `{}`", field.name),
            &format!(
                "{which} bound `{value}` is not a supported native bound for `{}`",
                field.type_text
            ),
            field.span,
        ));
        return None;
    }
    if let (Some(min), Some(max)) = (field.min.as_deref(), field.max.as_deref())
        && given_bounds_contradict(&[min], &[max])
    {
        *failed = true;
        diags.push(given_bad_value(
            &format!("contributed field `{}`", field.name),
            &format!("bounds contradict: min={min} exceeds max={max}"),
            field.span,
        ));
        return None;
    }
    Some(GivenContributedField {
        label,
        name: field.name.clone(),
        type_name: field.type_text.clone(),
        default: field.default.clone(),
        trim: field.trim,
        min: field.min.clone(),
        max: field.max.clone(),
    })
}

fn collect_trait_applications(
    inline: bool,
    descriptors: &[analysis::generation::GenerationDescriptor],
    def: &analysis::generation::GenerationDescriptor,
    refs: &analysis::resolve::GivenReferenceTables,
    label: &str,
) -> Vec<CheckedTraitApplication> {
    use analysis::generation::GenerationKind;
    let mut apps: Vec<CheckedTraitApplication> = Vec::new();
    if inline {
        let target = def.target.as_deref().unwrap_or_default();
        let mut parts = target.splitn(2, '.');
        let (model, field) = (parts.next().unwrap_or_default(), parts.next());
        if analysis::resolve::resolve_given_model(refs, &def.owner, model).is_some()
            && field.is_none_or(|f| {
                analysis::resolve::resolve_given_field(refs, &def.owner, model, f).is_some()
            })
        {
            let canonical = format!("{}.{target}", def.owner);
            apps.push(CheckedTraitApplication {
                target_model: model.to_string(),
                target_field: field.map(str::to_string),
                target_canonical: canonical,
                span: def.span,
                order: 0,
            });
        }
        // Dangling inline targets stay silent here: the attachment sits
        // on its target, so a missing model is the pipeline's own error.
    } else {
        let mut uses: Vec<&analysis::generation::GenerationDescriptor> = descriptors
            .iter()
            .filter(|d| {
                d.kind == GenerationKind::TraitApplication
                    && d.owner == def.owner
                    && d.label.as_deref() == Some(label)
            })
            .collect();
        uses.sort_by_key(|d| (d.span.file.0, d.span.start));
        for (order, app) in uses.iter().enumerate() {
            let target = app.target.as_deref().unwrap_or_default();
            let mut parts = target.splitn(2, '.');
            let (model, field) = (parts.next().unwrap_or_default(), parts.next());
            if analysis::resolve::resolve_given_model(refs, &def.owner, model).is_none() {
                // Dangling targets are the resolve helper's `E2011`.
                continue;
            }
            if let Some(field) = field
                && analysis::resolve::resolve_given_field(refs, &def.owner, model, field).is_none()
            {
                continue;
            }
            apps.push(CheckedTraitApplication {
                target_model: model.to_string(),
                target_field: field.map(str::to_string),
                target_canonical: format!("{}.{target}", def.owner),
                span: app.span,
                order,
            });
        }
    }
    apps
}

#[allow(clippy::too_many_arguments)]
fn apply_trait_model_fields(
    label: &str,
    app: &CheckedTraitApplication,
    model_canonical: &str,
    template_fields: &[GivenContributedField],
    has_check: bool,
    authored: &HashMap<String, GivenAuthoredModel>,
    contributed_by: &mut HashMap<(String, String), String>,
    failed: &mut bool,
    diags: &mut Vec<Diagnostic>,
) {
    if has_check {
        *failed = true;
        diags.push(analysis::effects::refuse_given_authority(
            "saved JavaScript on a model trait",
            "is not admitted; pure checks attach only to nonnullable native text fields",
            app.span,
        ));
    }
    for field in template_fields {
        if field.default.is_none() {
            *failed = true;
            diags.push(given_bad_value(
                &format!("trait `{label}` on {}", app.target_canonical),
                &format!(
                    "contributes `{}` with no default; existing creates and fixtures stay valid only with one",
                    field.name
                ),
                app.span,
            ));
            continue;
        }
        let key = (model_canonical.to_string(), field.name.clone());
        if authored
            .get(model_canonical)
            .is_some_and(|m| m.fields.contains_key(&field.name))
        {
            *failed = true;
            diags.push(given_conflict(
                &format!("trait `{label}` on {}", app.target_canonical),
                &format!("contributes `{}`, already declared", field.name),
                app.span,
            ));
            continue;
        }
        if let Some(first) = contributed_by.get(&key) {
            *failed = true;
            diags.push(given_conflict(
                &format!("trait `{label}` on {}", app.target_canonical),
                &format!(
                    "contributes `{}`, already contributed by {first}",
                    field.name
                ),
                app.span,
            ));
            continue;
        }
        contributed_by.insert(key, format!("trait `{label}`"));
    }
}

fn apply_trait_field_constraints(
    label: &str,
    app: &CheckedTraitApplication,
    field_name: &str,
    model: &GivenAuthoredModel,
    template_fields: &[GivenContributedField],
    failed: &mut bool,
    diags: &mut Vec<Diagnostic>,
) {
    if template_fields.len() != 1 {
        *failed = true;
        diags.push(given_target_mismatch(
            &format!("trait `{label}` on {}", app.target_canonical),
            "needs a single-field constraint template for a field attachment",
            app.span,
        ));
        return;
    }
    let Some(authored_field) = model.fields.get(field_name) else {
        // Dangling field: the resolve helper owns `E2011`.
        return;
    };
    let template = &template_fields[0];
    if template.type_name != authored_field.type_text {
        *failed = true;
        diags.push(given_target_mismatch(
            &format!("trait `{label}` on {}", app.target_canonical),
            &format!(
                "has type `{}`, cannot change `{field_name}` from `{}`",
                template.type_name, authored_field.type_text
            ),
            app.span,
        ));
        return;
    }
    match (&authored_field.default, template.default.as_deref()) {
        (Some(authored), Some(contributed)) if authored != contributed => {
            *failed = true;
            diags.push(given_bad_value(
                &format!("trait `{label}` on {}", app.target_canonical),
                &format!("default `{contributed}` contradicts declared `{authored}`"),
                app.span,
            ));
        }
        _ => {}
    }
    let mut mins: Vec<&str> = Vec::new();
    let mut maxes: Vec<&str> = Vec::new();
    for bound in [&authored_field.min, &template.min] {
        if let Some(b) = bound {
            mins.push(b.as_str());
        }
    }
    for bound in [&authored_field.max, &template.max] {
        if let Some(b) = bound {
            maxes.push(b.as_str());
        }
    }
    if given_bounds_contradict(&mins, &maxes) {
        *failed = true;
        diags.push(given_bad_value(
            &format!("trait `{label}` on {}", app.target_canonical),
            "bounds contradict the declared bounds",
            app.span,
        ));
    }
}

/// Check one trait definition's saved template and instantiate it at
/// every compatible application in source order. Named traits reuse one
/// template across applications; inline attachments own their one-off
/// target. Emits the contract plus diagnostics; a failing unit keeps
/// its diagnostics and contributes no contract.
#[allow(clippy::too_many_arguments)]
fn given_check_trait_definition(
    db: &SourceDb,
    program: &analysis::CheckedProgram,
    refs: &analysis::resolve::GivenReferenceTables,
    authored: &HashMap<String, GivenAuthoredModel>,
    descriptors: &[analysis::generation::GenerationDescriptor],
    def: &analysis::generation::GenerationDescriptor,
    inline: bool,
    saved: &HashMap<analysis::generation_intake::AssociationKey, GivenSavedUnit>,
    contributed_by: &mut HashMap<(String, String), String>,
    diags: &mut Vec<Diagnostic>,
) -> Option<CheckedTraitContract> {
    use analysis::generation_intake::{AssociationKey, UnitKind};
    let label = def.label.clone().unwrap_or_default();
    let kind = if inline {
        UnitKind::InlineTrait
    } else {
        UnitKind::NamedTrait
    };
    let key = AssociationKey {
        owner: def.owner.clone(),
        kind,
        label: def.label.clone(),
        anchor: def.anchor.clone(),
    };
    let Some(unit) = saved.get(&key) else {
        // Pending generation: the unit stays exposed for preparation.
        return None;
    };
    let mut failed = false;
    let mut fail = |d: Diagnostic| {
        failed = true;
        diags.push(d);
    };
    let has_check = unit.implementation_js.is_some();
    if unit.declaration.is_some() {
        fail(analysis::effects::refuse_given_authority(
            "trait declaration sidecar",
            "cannot select a producer or authority; field checks derive their contract from source",
            def.span,
        ));
    }
    let Some(carrier_id) = unit.contributions else {
        fail(given_target_mismatch(
            &format!("trait unit `{}`", unit.unit_id),
            "carries no contributions.can carrier",
            def.span,
        ));
        return None;
    };
    let Some(carrier) = db.get(carrier_id) else {
        fail(given_target_mismatch(
            &format!("trait unit `{}`", unit.unit_id),
            "names a contributions carrier the compiler was not given",
            def.span,
        ));
        return None;
    };
    let (carrier_tree, parse_diags) = parse_given_carrier(carrier_id, &carrier.text);
    if !parse_diags.is_empty() {
        diags.extend(parse_diags);
        return None;
    }
    let (models, refusals) = given_read_carrier(&carrier_tree, &carrier.text);
    for refusal in &refusals {
        fail(analysis::effects::refuse_given_authority(
            &format!("contributed {}", refusal.kind),
            "is not admitted by a trait contract (traits add fields, constraints and defaults; they never invent operations or authority)",
            refusal.span,
        ));
    }
    // Template selection: named traits declare a template model named
    // for the trait; inline attachments declare their target directly.
    let template_name = if inline {
        def.target
            .as_deref()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default()
            .to_string()
    } else {
        label.clone()
    };
    let templates: Vec<&GivenCarrierModel> =
        models.iter().filter(|m| m.name == template_name).collect();
    if templates.is_empty() {
        fail(given_target_mismatch(
            &format!("trait `{label}` contributions"),
            &format!("declare no `{template_name}` template"),
            def.span,
        ));
        return None;
    }
    if templates.len() > 1 {
        fail(given_conflict(
            &format!("trait `{label}` contributions"),
            &format!("declare `{template_name}` twice"),
            templates[1].span,
        ));
        return None;
    }
    for other in models.iter().filter(|m| m.name != template_name) {
        fail(given_target_mismatch(
            &format!("trait `{label}` contributions"),
            &format!("declare unexpected model `{}`", other.name),
            other.span,
        ));
    }
    let template = templates[0];
    drop(fail);
    // Template field checks: well-formed leaf types, admitted modifiers
    // and required checked defaults.
    let mut template_fields: Vec<GivenContributedField> = Vec::new();
    for field in &template.fields {
        if let Some(contributed) =
            check_trait_template_field(field, &mut failed, diags)
        {
            template_fields.push(contributed);
        }
    }
    if has_check && (template_fields.len() != 1 || template_fields[0].type_name != "text") {
        failed = true;
        diags.push(given_target_mismatch(
            &format!("trait `{label}` field check"),
            "requires one nonnullable native text field template",
            def.span,
        ));
    }
    // Applications in explicit source order. Inline attachments apply
    // once at their own target; named traits apply at every written use.
    let apps =
        collect_trait_applications(inline, descriptors, def, refs, &label);
    // Instantiate the template at every application: model attachments
    // add fields, field attachments add compatible constraints/defaults.
    for app in &apps {
        let model_canonical = format!("{}.{}", def.owner, app.target_model);
        let authored_model = authored.get(&model_canonical);
        match (&app.target_field, authored_model) {
            (None, _) => apply_trait_model_fields(
                &label,
                app,
                &model_canonical,
                &template_fields,
                has_check,
                authored,
                contributed_by,
                &mut failed,
                diags,
            ),
            (Some(field_name), Some(model)) => apply_trait_field_constraints(
                &label,
                app,
                field_name,
                model,
                &template_fields,
                &mut failed,
                diags,
            ),
            (Some(_), None) => {
                // Dangling model: the resolve helper owns `E2011`.
            }
        }
    }
    let _ = program;
    if failed {
        return None;
    }
    Some(CheckedTraitContract {
        name: if inline { None } else { Some(label) },
        inline,
        anchor: def.anchor.clone(),
        unit_id: unit.unit_id.clone(),
        applications: apps,
        contributed_fields: template_fields,
        fingerprint: sha256_hex(carrier.text.as_bytes()),
        validation_fingerprint: unit.implementation_js.as_ref().map(|js| {
            let imports: Vec<(&str, &[u8])> = unit
                .implementation_imports
                .iter()
                .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
                .collect();
            given_closure_fingerprint(js.as_bytes(), &imports)
        }),
    })
}

/// Check one keyword definition's producer binding and bind every
/// compatible application in source order. The definition signature,
/// the saved declaration and the compiler-owned producer schema must
/// agree; keyword semantics are never lowered to existing Can
/// expressions. Emits the contract plus diagnostics; a failing unit
/// keeps its diagnostics and contributes no contract.
#[allow(clippy::too_many_arguments)]
fn given_check_keyword_definition(
    program: &analysis::CheckedProgram,
    refs: &analysis::resolve::GivenReferenceTables,
    authored: &HashMap<String, GivenAuthoredModel>,
    descriptors: &[analysis::generation::GenerationDescriptor],
    def: &analysis::generation::GenerationDescriptor,
    saved: &HashMap<analysis::generation_intake::AssociationKey, GivenSavedUnit>,
    bound_by: &mut HashMap<(String, String), String>,
    diags: &mut Vec<Diagnostic>,
) -> Option<CheckedKeywordContract> {
    use analysis::generation::GenerationKind;
    use analysis::generation_intake::{AssociationKey, UnitKind};
    let label = def.label.clone().unwrap_or_default();
    let key = AssociationKey {
        owner: def.owner.clone(),
        kind: UnitKind::Keyword,
        label: def.label.clone(),
        anchor: def.anchor.clone(),
    };
    let Some(unit) = saved.get(&key) else {
        // Pending generation: the unit stays exposed for preparation.
        return None;
    };
    let mut failed = false;
    let mut fail = |d: Diagnostic| {
        failed = true;
        diags.push(d);
    };
    let Some(js) = unit.implementation_js.as_deref() else {
        fail(given_producer_refused(
            &format!("keyword `{label}` unit `{}`", unit.unit_id),
            "carries no saved implementation",
            def.span,
        ));
        return None;
    };
    if js.trim().is_empty() {
        fail(given_producer_refused(
            &format!("keyword `{label}` unit `{}`", unit.unit_id),
            "carries an empty saved implementation",
            def.span,
        ));
        return None;
    }
    if unit.contributions.is_some() {
        fail(analysis::effects::refuse_given_authority(
            "contributed declarations",
            "are not admitted by a v1 keyword contract (the descriptor derives owner-visible declarations from the definition, not from a carrier)",
            def.span,
        ));
    }
    let Some(declaration) = unit.declaration.as_ref() else {
        fail(given_producer_refused(
            &format!("keyword `{label}` unit `{}`", unit.unit_id),
            "carries no owner-visible declaration to bind a producer",
            def.span,
        ));
        return None;
    };
    if declaration.producer != GIVEN_PRODUCER_UNIQUE_KEY {
        fail(given_producer_refused(
            &format!("keyword `{label}`"),
            &format!(
                "selects unknown producer `{}` for this keyword contract; generated code never self-registers producers",
                declaration.producer
            ),
            def.span,
        ));
        return None;
    }
    // Producer/signature agreement: `state.unique-key@1` binds exactly
    // one target model and one text field of that target.
    let unique_shape = def.params.len() == 2
        && def.params[0].kind == "model"
        && def.params[1].kind == "field"
        && def.params[1].target_param.as_deref() == Some(def.params[0].name.as_str())
        && def.params[1].type_name.as_deref() == Some("text");
    if declaration.producer == GIVEN_PRODUCER_UNIQUE_KEY && !unique_shape {
        fail(given_target_mismatch(
            &format!("keyword `{label}`"),
            &format!(
                "signature does not satisfy `{GIVEN_PRODUCER_UNIQUE_KEY}` (want exactly `(target:model, field:field(target,text))`)"
            ),
            def.span,
        ));
        return None;
    }
    for d in analysis::effects::check_given_declaration_authority(
        &declaration.reads,
        &declaration.effects,
        &declaration.authority,
        &declaration.producer,
        def.span,
    ) {
        fail(d);
    }
    if declaration.export.trim().is_empty() {
        fail(given_declaration_mismatch(
            &format!("keyword `{label}`"),
            "declares no saved export",
            def.span,
        ));
    }
    // Applications in explicit source order; only resolved arguments
    // bind (dangling references are the resolve helper's `E2011`).
    let mut uses: Vec<&analysis::generation::GenerationDescriptor> = descriptors
        .iter()
        .filter(|d| {
            d.kind == GenerationKind::KeywordApplication
                && d.owner == def.owner
                && d.label.as_deref() == Some(label.as_str())
        })
        .collect();
    uses.sort_by_key(|d| (d.span.file.0, d.span.start));
    let mut apps: Vec<CheckedKeywordApplication> = Vec::new();
    for (order, app) in uses.iter().enumerate() {
        if let Some(bound) = bind_keyword_application(
            program,
            refs,
            authored,
            def,
            &label,
            app,
            order,
            bound_by,
            &mut failed,
            diags,
        ) {
            apps.push(bound);
        }
    }
    if failed {
        return None;
    }
    Some(CheckedKeywordContract {
        name: label,
        anchor: def.anchor.clone(),
        unit_id: unit.unit_id.clone(),
        producer: declaration.producer.clone(),
        semantics: GIVEN_UNIQUE_KEY_SEMANTICS.to_string(),
        lifecycle: GIVEN_UNIQUE_KEY_LIFECYCLE.to_string(),
        export: declaration.export.clone(),
        input: GivenFieldSchema {
            name: def
                .params
                .iter()
                .find(|p| p.kind == "field")
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "field".to_string()),
            type_name: "text".to_string(),
        },
        result: "text".to_string(),
        reads: Vec::new(),
        effects: Vec::new(),
        authority: Vec::new(),
        dependencies: apps
            .iter()
            .map(|a| a.target_field.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect(),
        fingerprint: {
            let closure: Vec<(&str, &[u8])> = unit
                .implementation_imports
                .iter()
                .map(|import| (import.rel_path.as_str(), import.bytes.as_slice()))
                .collect();
            given_closure_fingerprint(js.as_bytes(), &closure)
        },
        applications: apps,
    })
}

fn bind_keyword_application(
    program: &analysis::CheckedProgram,
    refs: &analysis::resolve::GivenReferenceTables,
    authored: &HashMap<String, GivenAuthoredModel>,
    def: &analysis::generation::GenerationDescriptor,
    label: &str,
    app: &analysis::generation::GenerationDescriptor,
    order: usize,
    bound_by: &mut HashMap<(String, String), String>,
    failed: &mut bool,
    diags: &mut Vec<Diagnostic>,
) -> Option<CheckedKeywordApplication> {
    let by_name: HashMap<&str, &str> = app
        .args
        .iter()
        .map(|a| (a.name.as_str(), a.value.trim()))
        .collect();
    let model_value = def
        .params
        .iter()
        .find(|p| p.kind == "model")
        .and_then(|p| by_name.get(p.name.as_str()).copied())
        .unwrap_or_default();
    let field_value = def
        .params
        .iter()
        .find(|p| p.kind == "field")
        .and_then(|p| by_name.get(p.name.as_str()).copied())
        .unwrap_or_default();
    // Missing/unknown arguments are discovery's `E2001`; unusable
    // applications simply do not bind here.
    if model_value.is_empty() || field_value.is_empty() {
        return None;
    }
    if analysis::resolve::resolve_given_model(refs, &def.owner, model_value).is_none() {
        return None;
    }
    let mut parts = field_value.splitn(2, '.');
    let (field_model, field_name) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let field_symbol =
        analysis::resolve::resolve_given_field(refs, &def.owner, field_model, field_name);
    if field_symbol.is_none() {
        return None;
    }
    // The bound field must be checked `text`: `state.unique-key@1`
    // computes over text only (no nullable/model-typed keys without
    // explicit null-key semantics).
    let field_type = field_symbol.and_then(|s| program.types.symbol_types.get(&s));
    if !matches!(field_type, Some(ResolvedType::Scalar(Scalar::Text))) {
        if field_type.is_some_and(|t| !matches!(t, ResolvedType::Error)) {
            *failed = true;
            diags.push(given_target_mismatch(
                &format!("keyword `{label}` on {field_value}"),
                "needs a checked text field",
                app.span,
            ));
        }
        return None;
    }
    let model_canonical = format!("{}.{model_value}", def.owner);
    let field_canonical = format!("{model_canonical}.{field_name}");
    if authored
        .get(&model_canonical)
        .and_then(|m| m.fields.get(field_name))
        .is_some_and(|f| f.unique)
    {
        *failed = true;
        diags.push(given_conflict(
            &format!("keyword `{label}` on {field_value}"),
            "conflicts with the declared builtin unique",
            app.span,
        ));
        return None;
    }
    let bind_key = (model_canonical.clone(), field_name.to_string());
    if let Some(first) = bound_by.get(&bind_key) {
        *failed = true;
        diags.push(given_conflict(
            &format!("keyword `{label}` on {field_value}"),
            &format!("is already bound by {first}"),
            app.span,
        ));
        return None;
    }
    bound_by.insert(bind_key, format!("keyword `{label}`"));
    let mut args: Vec<(String, String)> = Vec::new();
    for param in &def.params {
        let Some(value) = by_name.get(param.name.as_str()) else {
            continue;
        };
        let resolved = match param.kind.as_str() {
            "model" => format!("{}.{value}", def.owner),
            "field" => format!("{}.{value}", def.owner),
            "operation" => format!("{}.{value}", def.owner),
            _ => value.to_string(),
        };
        args.push((param.name.clone(), resolved));
    }
    Some(CheckedKeywordApplication {
        rule_id: format!("{field_canonical}#{label}"),
        target_model: model_canonical.clone(),
        target_field: field_canonical.clone(),
        args,
        span: app.span,
        order,
    })
}

/// Check Given trait contributions and custom-keyword producer bindings
/// for a checked program against host-supplied saved units.
///
/// Consumes BGI-01 discovery descriptors (definitions before
/// applications, working before any implementation exists), BGI-02
/// association keys and the checked resolve/type facts; returns the
/// checked contract tables plus diagnostics. Definitions without a
/// saved entry are pending generation and stay silent. Diagnostics use
/// `E2011` (dangling references, via resolve), `E3020`–`E3024`
/// (contribution/contract checks) and `E4056` (unadmitted authority,
/// via effects); definition shape/duplicates stay with discovery and
/// the parser and are never re-reported here.
pub fn check_given_contract_tables(
    db: &SourceDb,
    program: &analysis::CheckedProgram,
    saved: &HashMap<analysis::generation_intake::AssociationKey, GivenSavedUnit>,
) -> (GivenContractTables, Vec<Diagnostic>) {
    use analysis::generation::GenerationKind;
    let mut diags = Vec::new();
    let found = analysis::generation::discover_program(db, program.checked_files());
    let (refs, mut ref_diags) =
        analysis::resolve::check_given_application_refs(program, &found.descriptors);
    diags.append(&mut ref_diags);
    let authored = given_authored_models(db, program);
    let mut tables = GivenContractTables::default();
    let mut contributed_by: HashMap<(String, String), String> = HashMap::new();
    let mut bound_by: HashMap<(String, String), String> = HashMap::new();
    // Duplicate anchors are discovery's `E2002`; check each anchor once.
    let mut seen_anchors: HashSet<String> = HashSet::new();
    let mut defs: Vec<&analysis::generation::GenerationDescriptor> = found
        .descriptors
        .iter()
        .filter(|d| {
            matches!(
                d.kind,
                GenerationKind::NamedTrait
                    | GenerationKind::InlineTrait
                    | GenerationKind::KeywordDefinition
            )
        })
        .collect();
    defs.sort_by_key(|d| (d.span.file.0, d.span.start));
    for def in defs {
        if !seen_anchors.insert(def.anchor.clone()) {
            continue;
        }
        match def.kind {
            GenerationKind::NamedTrait | GenerationKind::InlineTrait => {
                if let Some(contract) = given_check_trait_definition(
                    db,
                    program,
                    &refs,
                    &authored,
                    &found.descriptors,
                    def,
                    def.kind == GenerationKind::InlineTrait,
                    saved,
                    &mut contributed_by,
                    &mut diags,
                ) {
                    tables.traits.push(contract);
                }
            }
            GenerationKind::KeywordDefinition => {
                if let Some(contract) = given_check_keyword_definition(
                    program,
                    &refs,
                    &authored,
                    &found.descriptors,
                    def,
                    saved,
                    &mut bound_by,
                    &mut diags,
                ) {
                    tables.keywords.push(contract);
                }
            }
            _ => {}
        }
    }
    (tables, diags)
}
