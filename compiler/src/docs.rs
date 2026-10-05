//! Internal declaration reference extractor (D04b): frozen ReferenceModel v1.
//!
//! Builds the versioned reference model consumed by the TypeScript Markdown
//! renderer (D05a). The output shape matches
//! `packages/contracts/src/reference.ts` (D04a, frozen) exactly; JSON keys
//! use the contract's camelCase spellings and optional properties are
//! omitted when absent (absence stays distinct from empty text).
//!
//! ## Inputs (located facts only)
//!
//! - Owners, declarations and operations from [`CheckedProgram`] modules,
//!   symbols and [`EffectTables`](crate::analysis::effects::EffectTables).
//! - Field/parameter descriptions from the frozen D02 seam
//!   (`EffectTables::checked_descriptions`); declaration/operation `#`
//!   descriptions from recorded module description sets plus recorded
//!   message wording (lookup only).
//! - Types, nullability and operation results from
//!   [`TypeTable`](crate::analysis::types::TypeTable); defaults, bounds
//!   and type spellings as trimmed source slices.
//! - Labeled declaration examples from fixture recipes targeting the
//!   declaration; operation row examples from table-form `examples` blocks
//!   attached to user scenarios (row text sliced from the CST); catalog
//!   identity from `CheckedProgram::catalog_version`.
//!
//! The extractor performs no new semantic inference pass: it slices,
//! looks up, sorts and maps facts analysis already located. Rows that
//! fail to resolve (dangling ids, missing spans) are omitted, never
//! panicked on. Call only after required source analysis succeeds (the
//! `can docs` slice enforces this); passing analysis never implies
//! implementation availability.
//!
//! ## Deliberate v1 boundaries
//!
//! - User operations are user scenarios (`Scenario`, `trusted=false`).
//!   Trusted handlers, generated CRUD operations and capability operations
//!   are excluded: handlers are not user-callable, and CRUD/capability
//!   inputs would need synthesizing rather than locating.
//! - Declaration examples are fixtures targeting the declaration (the only
//!   labeled, declaration-attached example-surface facts); operation table
//!   rows never leak into them. Operation-owned examples are one entry per
//!   data row of every table-form `examples` block attached to the
//!   operation, in source order (positional `row-N` labels: tables are
//!   unlabeled in source). Row text is sliced from the existing parser's
//!   CST (a read-only re-parse: the same parser, not a second one), split
//!   at the authored `->` into input cells plus expectation. Sequence-form
//!   `examples`/`do` blocks have no row/expected shape and stay
//!   unextracted rather than inventing one.
//! - Availability is always `unknown`: analysis publishes no verified
//!   owner/catalog fact for reference-level availability, and v1 never
//!   invents one. The `available` shape exists for contract conformance.
//! - Declaration `#= name` references resolve to same-module messages plus
//!   bare names imported through the authoring module's established `use`
//!   scope (consumer-side alias to provider-local symbol, mirroring the
//!   checker's production scope). Dotted references stay unresolved (the
//!   checker rejects them; no new syntax). Unresolvable references leave
//!   the declaration undescribed rather than carrying wrong wording.
//! - `app_default_locale` is the single app module's `source=` tag when
//!   exactly one analyzed module declares an app; otherwise (package-only
//!   or multi-app inputs) it falls back to the first analyzed module's
//!   tag, `"en"` when nothing was analyzed. No locale-default machinery:
//!   pure module-kind selection over located facts. Per-description source
//!   languages still travel on each description value.
//! - `source_revision` is a content hash (lowercase hex SHA-256 over
//!   path-sorted `(portable_path, text)` pairs), never a wall-clock
//!   timestamp. Paths are portable identities so absolute/relative
//!   spellings of the same input hash identically.
//! - `creation_required` reuses the existing MCP caller-required rule
//!   (`js.rs`): no default, no `server=` owner (fields) and non-nullable.
//!   Creation metadata stays distinct from value nullability.
//!
//! ## Determinism
//!
//! Output is byte-identical for the same source/catalog versions: owners
//! sort by name, declarations by `(name, kind)`, operations by canonical
//! id, examples by label; fields, inputs, constraints and variants keep
//! analysis (source) order.

use crate::analysis::effects::{CheckedDescription, FieldData, ModifierData, ParamData};
use crate::analysis::resolve::{FixtureTarget, ModuleId, ModuleKind, Symbol, SymbolId, SymbolKind};
use crate::analysis::types::ResolvedType;
use crate::analysis::{CheckedProgram, NodeKey};
use crate::json::{self, Json};
use crate::source::{SourceDb, SourceId, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Frozen reference-model version. Matches `REFERENCE_MODEL_VERSION` in
/// `packages/contracts/src/reference.ts`; bump only with a contract revision.
pub const REFERENCE_MODEL_VERSION: u32 = 1;

/// Spelling for undeclared (void) operation results. The checker calls these
/// void (`None = void` in `symbol_results`); the reference renders that word.
const VOID_TYPE: &str = "void";

/// Fallback type spelling when a declared-type slice is unavailable.
/// Unreachable after successful analysis (the extraction input contract);
/// a truthful marker, never a guessed type.
const UNKNOWN_TYPE: &str = "unknown";

// --- Model -----------------------------------------------------------------

/// Project-relative source span of one owning declaration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceSourceLocation {
    /// Portable source identity (see [`portable_source_id`]): relative
    /// paths verbatim, absolute paths under the project root relativized,
    /// absolute paths outside marked `external:...`.
    pub source_id: String,
    /// Zero-based start offset in the source file.
    pub start: u32,
    /// Zero-based end offset in the source file.
    pub end: u32,
}

/// One ordered locale variant of a checked description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceDescriptionVariant {
    /// BCP 47 tag as authored (canonicalized at render time).
    pub tag: String,
    /// `None` = absent translation (`null`); `Some("")` = authored empty text.
    pub text: Option<String>,
}

/// Checked description value: source prose plus owning source language,
/// ordered variants and the owning declaration location. No parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceDescriptionValue {
    /// Source-language prose (`""` is authored-empty text, not absence).
    pub source: String,
    /// Owning source language tag.
    pub source_lang: String,
    /// Variants in written order.
    pub variants: Vec<ReferenceDescriptionVariant>,
    /// Authored-value location.
    pub location: ReferenceSourceLocation,
}

/// One resolved value constraint on a field or operation input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceConstraint {
    /// Constraint kind as located by analysis (`trim`, `min`, `max`, `unique`).
    pub kind: String,
    /// Bound source spelling (`min`/`max`) or the modifier word (flags).
    pub detail: String,
}

/// One model/contract field with creation metadata kept separate from type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceField {
    /// Field name (never localized).
    pub name: String,
    /// Declared type spelling (never localized); `!` marks required arrays.
    pub ty: String,
    /// Value nullability from the resolved type.
    pub nullable: bool,
    /// Creation requiredness (distinct from value nullability).
    pub creation_required: bool,
    /// Default value spelling, when the declaration supplies one.
    pub default: Option<String>,
    /// Value constraints in written order.
    pub constraints: Vec<ReferenceConstraint>,
    /// Field description, when authored.
    pub description: Option<ReferenceDescriptionValue>,
}

/// One user-operation input parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceOperationInput {
    /// Input name (never localized).
    pub name: String,
    /// Declared type spelling (never localized).
    pub ty: String,
    /// Value nullability from the resolved type.
    pub nullable: bool,
    /// Creation requiredness (distinct from value nullability).
    pub creation_required: bool,
    /// Default value spelling, when the declaration supplies one.
    pub default: Option<String>,
    /// Value constraints (empty in v1: parameters carry no modifiers).
    pub constraints: Vec<ReferenceConstraint>,
    /// Input description, when authored.
    pub description: Option<ReferenceDescriptionValue>,
}

/// Declared result of one user operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceOperationResult {
    /// Declared result spelling, or `void` when undeclared (never localized).
    pub ty: String,
    /// Value nullability from the resolved type (`false` for `void`).
    pub nullable: bool,
    /// Result description (always `None` in v1: no source slot exists).
    pub description: Option<ReferenceDescriptionValue>,
}

/// One user operation: callable surface only, no inferred authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceOperation {
    /// Canonical operation id (never localized).
    pub id: String,
    /// Operation description, when authored.
    pub description: Option<ReferenceDescriptionValue>,
    /// Inputs in signature order.
    pub inputs: Vec<ReferenceOperationInput>,
    /// Declared result.
    pub result: ReferenceOperationResult,
    /// Operation-owned authored examples: one entry per data row of every
    /// attached table-form `examples` block, in source order. Always
    /// emitted (empty when the operation has no tables).
    pub examples: Vec<ReferenceExample>,
    /// Operation declaration location.
    pub location: ReferenceSourceLocation,
}

/// One source example with its expected result. V1 carries NO execution
/// status: generation never runs examples or invents passed/failed state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceExample {
    /// Example label from source (the fixture name).
    pub label: String,
    /// Example source text from the owning declaration.
    pub source: String,
    /// Expected result text, when the source states one (`None` in v1:
    /// fixtures state setup, not expectations).
    pub expected: Option<String>,
}

/// Declaration kind covered by v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReferenceDeclarationKind {
    /// Stored model.
    Model,
    /// Contract record.
    Contract,
}

impl ReferenceDeclarationKind {
    /// Contract spelling (`model` sorts after `contract`).
    fn as_str(self) -> &'static str {
        match self {
            ReferenceDeclarationKind::Model => "model",
            ReferenceDeclarationKind::Contract => "contract",
        }
    }
}

/// One model or contract declaration with its fields and examples.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceDeclaration {
    /// Owning module name (never localized).
    pub owner: String,
    /// Declaration name (never localized).
    pub name: String,
    /// Declaration kind.
    pub kind: ReferenceDeclarationKind,
    /// Declaration description, when authored.
    pub description: Option<ReferenceDescriptionValue>,
    /// Fields in declaration order.
    pub fields: Vec<ReferenceField>,
    /// Authored examples by label.
    pub examples: Vec<ReferenceExample>,
    /// Declaration location.
    pub location: ReferenceSourceLocation,
}

/// One canonical owner with its declarations and user operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceOwner {
    /// Module name (never localized).
    pub name: String,
    /// Declarations by `(name, kind)`.
    pub declarations: Vec<ReferenceDeclaration>,
    /// User operations by canonical id.
    pub operations: Vec<ReferenceOperation>,
}

/// Implementation availability: `unknown` unless a verified owner/catalog
/// supplies a fact. The extractor always yields `Unknown` in v1 (no such
/// fact exists in analysis); passing analysis never implies availability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReferenceAvailability {
    /// No verified implementation fact.
    Unknown,
    /// Verified implementation fact (constructed only with one).
    Available {
        /// Verifying owner.
        owner: String,
        /// Verifying catalog version.
        catalog: String,
    },
}

/// Frozen reference model v1 root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceModel {
    /// [`REFERENCE_MODEL_VERSION`].
    pub version: u32,
    /// Content hash of the analyzed sources (hex SHA-256).
    pub source_revision: String,
    /// Catalog version, or `None` (`null`) when no catalog contributed.
    pub catalog_version: Option<String>,
    /// Language version identity.
    pub language_version: String,
    /// App default locale (BCP 47); render fallback route.
    pub app_default_locale: String,
    /// Owners by name.
    pub owners: Vec<ReferenceOwner>,
    /// Implementation availability.
    pub availability: ReferenceAvailability,
}

// --- Extraction ------------------------------------------------------------

/// Build the frozen reference model v1 from analyzed sources.
///
/// `db`/`files` are the analyzed sources (for canonical links and the
/// source-revision hash); `program` is the [`check_program`](crate::analysis::check_program)
/// output. Call only after required source analysis succeeds. The result is
/// deterministic for the same source/catalog versions.
pub fn extract_reference(
    db: &SourceDb,
    files: &[SourceId],
    program: &CheckedProgram,
) -> ReferenceModel {
    // Read-only re-parse of the analyzed sources (the existing parser, for
    // operation row slicing only); diagnostics are analysis's business and
    // already reported, so only the trees are kept.
    let trees: HashMap<SourceId, SyntaxNode> = files
        .iter()
        .map(|file| (*file, crate::syntax::parse(db, *file).0))
        .collect();
    let op_examples = operation_example_map(db, program, &trees);
    // Per-owner accumulation keyed by module name (BTreeMap: sorted owners).
    let mut owners: BTreeMap<String, (Vec<ReferenceDeclaration>, Vec<ReferenceOperation>)> =
        BTreeMap::new();
    for data in program.effects.models.values() {
        let (Some(owner), Some(declaration)) = (
            module_name(program, data.module),
            reference_declaration(
                db,
                program,
                data.module,
                data.model,
                ReferenceDeclarationKind::Model,
                &data.node,
                &data.fields,
            ),
        ) else {
            continue;
        };
        owners
            .entry(owner.to_string())
            .or_default()
            .0
            .push(declaration);
    }
    for data in program.effects.records.values() {
        let Some(symbol) = symbol(program, data.record) else {
            continue;
        };
        if !matches!(symbol.kind, SymbolKind::Contract { .. }) {
            continue;
        }
        let (Some(owner), Some(declaration)) = (
            module_name(program, data.module),
            reference_declaration(
                db,
                program,
                data.module,
                data.record,
                ReferenceDeclarationKind::Contract,
                &data.node,
                &data.fields,
            ),
        ) else {
            continue;
        };
        owners
            .entry(owner.to_string())
            .or_default()
            .0
            .push(declaration);
    }
    for scenario in program.effects.scenarios.values() {
        let (Some(owner), Some(operation)) = (
            module_name(program, scenario.module),
            reference_operation(db, program, scenario, &op_examples),
        ) else {
            continue;
        };
        owners
            .entry(owner.to_string())
            .or_default()
            .1
            .push(operation);
    }
    let owners = owners
        .into_iter()
        .map(|(name, (mut declarations, mut operations))| {
            declarations.sort_by(|a, b| {
                a.name
                    .cmp(&b.name)
                    .then(a.kind.as_str().cmp(b.kind.as_str()))
            });
            operations.sort_by(|a, b| a.id.cmp(&b.id));
            ReferenceOwner {
                name,
                declarations,
                operations,
            }
        })
        .collect();
    ReferenceModel {
        version: REFERENCE_MODEL_VERSION,
        source_revision: source_revision(db, files),
        catalog_version: if program.catalog_version.is_empty() {
            None
        } else {
            Some(program.catalog_version.clone())
        },
        language_version: crate::LANGUAGE_VERSION.to_string(),
        app_default_locale: app_default_locale(program),
        owners,
        availability: ReferenceAvailability::Unknown,
    }
}

/// Module name for `id`, or `None` for a dangling row (omitted, never panic).
fn module_name(program: &CheckedProgram, id: ModuleId) -> Option<&str> {
    program
        .modules
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.name.as_str())
}

/// Symbol for `id`, or `None` for a dangling row (omitted, never panic).
fn symbol(program: &CheckedProgram, id: SymbolId) -> Option<&Symbol> {
    program.symbols.get(id.0 as usize).filter(|s| s.id == id)
}

/// One model/contract declaration with fields, examples and description.
#[allow(clippy::too_many_arguments)]
fn reference_declaration(
    db: &SourceDb,
    program: &CheckedProgram,
    module: ModuleId,
    id: SymbolId,
    kind: ReferenceDeclarationKind,
    node: &NodeKey,
    fields: &[FieldData],
) -> Option<ReferenceDeclaration> {
    let symbol = symbol(program, id)?;
    let owner = module_name(program, module)?.to_string();
    let fields = fields
        .iter()
        .filter_map(|f| reference_field(db, program, f))
        .collect();
    Some(ReferenceDeclaration {
        owner,
        name: symbol.name.clone(),
        kind,
        description: declaration_description(db, program, module, node),
        fields,
        examples: declaration_examples(db, program, id),
        location: location(db, node),
    })
}

/// One stored field: declared spelling, nullability, creation requiredness,
/// default, constraints and checked description.
fn reference_field(
    db: &SourceDb,
    program: &CheckedProgram,
    data: &FieldData,
) -> Option<ReferenceField> {
    let symbol = symbol(program, data.field)?;
    let mut ty = slice_key(db, &data.type_node)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| UNKNOWN_TYPE.to_string());
    if data.required_array && !ty.ends_with('!') {
        ty.push('!');
    }
    let nullable = program
        .types
        .symbol_types
        .get(&data.field)
        .is_some_and(is_nullable);
    let default = data
        .default
        .as_ref()
        .and_then(|key| slice_key(db, key))
        .filter(|s| !s.is_empty());
    // MCP caller-required rule plus `server=` ownership: server-set fields
    // are never caller-provided. Distinct from value nullability.
    let creation_required = data.default.is_none() && data.server.is_none() && !nullable;
    let constraints = data
        .modifiers
        .iter()
        .map(|m| modifier_constraint(db, m))
        .collect();
    let description = program
        .effects
        .checked_descriptions
        .get(&data.node)
        .map(|checked| checked_description_value(db, checked));
    Some(ReferenceField {
        name: symbol.name.clone(),
        ty,
        nullable,
        creation_required,
        default,
        constraints,
        description,
    })
}

/// One signature parameter: same shape as a field, without modifiers or
/// server ownership (parameters carry neither).
fn reference_input(
    db: &SourceDb,
    program: &CheckedProgram,
    data: &ParamData,
) -> Option<ReferenceOperationInput> {
    let symbol = symbol(program, data.param)?;
    let ty = slice_key(db, &data.type_node)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| UNKNOWN_TYPE.to_string());
    let nullable = program
        .types
        .symbol_types
        .get(&data.param)
        .is_some_and(is_nullable);
    let default = data
        .default
        .as_ref()
        .and_then(|key| slice_key(db, key))
        .filter(|s| !s.is_empty());
    let creation_required = data.default.is_none() && !nullable;
    let description = program
        .effects
        .checked_descriptions
        .get(&data.node)
        .map(|checked| checked_description_value(db, checked));
    Some(ReferenceOperationInput {
        name: symbol.name.clone(),
        ty,
        nullable,
        creation_required,
        default,
        constraints: Vec::new(),
        description,
    })
}

/// One user scenario: canonical id, inputs in signature order, declared
/// result, attached description and owned row examples. Trusted handlers
/// are not user operations and yield `None`; no caller permission is
/// inferred.
fn reference_operation(
    db: &SourceDb,
    program: &CheckedProgram,
    scenario: &crate::analysis::effects::ScenarioData,
    op_examples: &HashMap<SymbolId, Vec<ReferenceExample>>,
) -> Option<ReferenceOperation> {
    let symbol = symbol(program, scenario.scenario)?;
    if !matches!(symbol.kind, SymbolKind::Scenario { trusted: false, .. }) {
        return None;
    }
    let inputs = scenario
        .params
        .iter()
        .filter_map(|p| reference_input(db, program, p))
        .collect();
    let published = program.types.symbol_results.get(&scenario.scenario);
    let (ty, nullable) = match (&scenario.result, published) {
        (_, Some(Some(resolved))) => (
            slice_key_or_unknown(db, scenario.result.as_ref()),
            is_nullable(resolved),
        ),
        // Declared but unpublished (analysis gap): truthful marker.
        (Some(_), _) => (UNKNOWN_TYPE.to_string(), false),
        // Undeclared result: void.
        (None, _) => (VOID_TYPE.to_string(), false),
    };
    Some(ReferenceOperation {
        id: symbol.canonical.clone(),
        description: declaration_description(db, program, scenario.module, &scenario.node),
        inputs,
        result: ReferenceOperationResult {
            ty,
            nullable,
            description: None,
        },
        examples: op_examples
            .get(&scenario.scenario)
            .cloned()
            .unwrap_or_default(),
        location: location(db, &scenario.node),
    })
}

/// Whether a resolved type is nullable (one `?` layer; deeper nesting never
/// occurs in declared types).
fn is_nullable(ty: &ResolvedType) -> bool {
    matches!(ty, ResolvedType::Nullable(_))
}

/// One field modifier as a resolved constraint: bound spellings for
/// `min`/`max`, the modifier word itself for flag modifiers.
fn modifier_constraint(db: &SourceDb, modifier: &ModifierData) -> ReferenceConstraint {
    let detail = match modifier.name.as_str() {
        "min" | "max" => modifier
            .value
            .as_ref()
            .and_then(|key| slice_key(db, key))
            .unwrap_or_default(),
        _ => modifier.name.clone(),
    };
    ReferenceConstraint {
        kind: modifier.name.clone(),
        detail,
    }
}

/// Labeled examples for one declaration: fixtures targeting it, by label.
/// Fixtures targeting users, files, operations or nothing have no
/// declaration home and stay out of v1; no execution status is invented.
fn declaration_examples(
    db: &SourceDb,
    program: &CheckedProgram,
    declaration: SymbolId,
) -> Vec<ReferenceExample> {
    let mut examples: Vec<ReferenceExample> = program
        .examples
        .fixtures
        .iter()
        .filter(|f| matches!(f.target, FixtureTarget::Model(id) if id == declaration))
        .filter_map(|f| {
            let symbol = symbol(program, f.symbol)?;
            let source = slice_span(db, &f.span).filter(|s| !s.is_empty())?;
            Some(ReferenceExample {
                label: symbol.name.clone(),
                source,
                expected: None,
            })
        })
        .collect();
    examples.sort_by(|a, b| a.label.cmp(&b.label));
    examples
}

/// Operation-owned authored examples keyed by scenario symbol: one entry
/// per data row of every table-form `examples` block attached to the
/// operation. Tables arrive in source order and rows keep block order, so
/// per-operation `row-N` labels are positional, unique and deterministic.
/// Blocks detached from any operation (CRUD-attached tables have no
/// reference home: generated CRUD operations are excluded from v1) and
/// rows that fail to slice are omitted, never panicked on.
fn operation_example_map(
    db: &SourceDb,
    program: &CheckedProgram,
    trees: &HashMap<SourceId, SyntaxNode>,
) -> HashMap<SymbolId, Vec<ReferenceExample>> {
    let mut counters: HashMap<SymbolId, usize> = HashMap::new();
    let mut map: HashMap<SymbolId, Vec<ReferenceExample>> = HashMap::new();
    for table in &program.examples.tables {
        let Some(operation) = table.operation else {
            continue;
        };
        let (Some(tree), Some(text)) = (
            trees.get(&table.node.file),
            db.get(table.node.file).map(|s| s.text.as_str()),
        ) else {
            continue;
        };
        let Some(block) = tree.descendants().find(|n| NodeKey::of(n) == table.node) else {
            continue;
        };
        let rows: Vec<&SyntaxNode> = block
            .children
            .iter()
            .filter(|n| n.kind == SyntaxKind::ExampleRow)
            .collect();
        for row in rows.into_iter().skip(1) {
            let (Some(source), expected) = split_example_row(text, row) else {
                continue;
            };
            let count = counters.entry(operation).or_insert(0);
            *count += 1;
            map.entry(operation).or_default().push(ReferenceExample {
                label: format!("row-{}", *count),
                source,
                expected,
            });
        }
    }
    map
}

/// Authored input cells plus expectation of one table data row: the
/// trimmed source slice left of the row's `->` arrow, with the trimmed
/// slice right of it as the expectation (`None` when the row carries no
/// arrow). Slicing is purely positional over authored text: expected-error
/// rows keep their `error(code)` spelling as the expectation, and no
/// execution status is invented. `None` source (unsliceable/empty) omits
/// the row.
fn split_example_row(text: &str, row: &SyntaxNode) -> (Option<String>, Option<String>) {
    let arrow = crate::analysis::kids(row)
        .into_iter()
        .find(|n| n.kind == SyntaxKind::Punct && n.token().is_some_and(|t| t.text(text) == "->"));
    let Some(arrow) = arrow else {
        return (
            text.get(row.span.start as usize..row.span.end as usize)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            None,
        );
    };
    let source = text
        .get(row.span.start as usize..arrow.span.start as usize)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let expected = text
        .get(arrow.span.end as usize..row.span.end as usize)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (source, expected)
}

/// Declaration/operation description from the recorded `#` set whose owner
/// is `node` (first in source order), with lone `#= message` references
/// resolved to recorded message wording. `None` is undescribed (distinct
/// from authored-empty text); unresolvable references also yield `None`
/// rather than wrong wording.
fn declaration_description(
    db: &SourceDb,
    program: &CheckedProgram,
    module: ModuleId,
    node: &NodeKey,
) -> Option<ReferenceDescriptionValue> {
    let module_data = program.effects.modules.get(&module)?;
    let entry = module_data.descriptions.iter().find(|e| e.owner == *node)?;
    if let Some(reference) = entry.reference.as_deref() {
        let (source, source_lang, variants) = local_message_wording(program, module, reference)?;
        return Some(ReferenceDescriptionValue {
            source,
            source_lang,
            variants,
            location: location(db, &entry.node),
        });
    }
    Some(ReferenceDescriptionValue {
        source: entry.text.clone(),
        source_lang: module_data.source_lang.clone(),
        variants: entry
            .variants
            .iter()
            .map(|v| ReferenceDescriptionVariant {
                tag: v.locale.clone(),
                text: v.value.clone(),
            })
            .collect(),
        location: location(db, &entry.node),
    })
}

/// Wording of a lone `#= name` declaration reference: a static zero-parameter
/// message resolved through the authoring module's established scope —
/// same-module declarations first, then bare names imported via `use`
/// (see [`imported_message_symbol`]). Dotted references stay unresolved
/// (the checker rejects them; no new syntax).
fn local_message_wording(
    program: &CheckedProgram,
    module: ModuleId,
    reference: &str,
) -> Option<(String, String, Vec<ReferenceDescriptionVariant>)> {
    if reference.is_empty() || reference.contains('.') {
        return None;
    }
    let id = program
        .symbols
        .iter()
        .find(|s| s.module == module && s.name == reference)
        .map(|s| s.id)
        .or_else(|| imported_message_symbol(program, module, reference))?;
    let symbol = symbol(program, id)?;
    if !matches!(symbol.kind, SymbolKind::Message { ref params } if params.is_empty()) {
        return None;
    }
    let data = program.effects.messages.get(&symbol.id)?;
    Some((
        data.source.clone(),
        data.source_lang.clone(),
        data.variants
            .iter()
            .map(|v| ReferenceDescriptionVariant {
                tag: v.locale.clone(),
                text: v.value.clone(),
            })
            .collect(),
    ))
}

/// Provider-local symbol for a bare name imported into `module` through
/// its established `use` scope: the consumer-side alias resolves to the
/// provider-side member name in the named provider module. This mirrors
/// the checker's production scope (`Local | Imported` resolve): the
/// checker only binds imports to provider-local symbols (transitive
/// imports are `E2004`), so only provider-local symbols are followed, and
/// unresolvable providers (external bindings) yield `None`.
fn imported_message_symbol(
    program: &CheckedProgram,
    module: ModuleId,
    reference: &str,
) -> Option<SymbolId> {
    let importing = program.modules.iter().find(|m| m.id == module)?;
    for import in &importing.imports {
        let Some(member) = import.members.iter().find(|m| m.alias == reference) else {
            continue;
        };
        let Some(provider) = program.modules.iter().find(|m| m.name == import.provider) else {
            continue;
        };
        if let Some(symbol) = program
            .symbols
            .iter()
            .find(|s| s.module == provider.id && s.name == member.name)
        {
            return Some(symbol.id);
        }
    }
    None
}

/// Frozen-seam mapping: one checked field/parameter description.
fn checked_description_value(
    db: &SourceDb,
    checked: &CheckedDescription,
) -> ReferenceDescriptionValue {
    ReferenceDescriptionValue {
        source: checked.source.clone(),
        source_lang: checked.source_lang.clone(),
        variants: checked
            .variants
            .iter()
            .map(|v| ReferenceDescriptionVariant {
                tag: v.locale.clone(),
                text: v.value.clone(),
            })
            .collect(),
        location: location(db, &checked.node),
    }
}

/// Default reading locale: the single app module's `source=` tag when
/// exactly one analyzed module declares an app (implicit or composed),
/// else the first analyzed module's tag (package-only/multi-app fallback),
/// or `"en"` when nothing was analyzed. Pure module-kind selection over
/// located facts — no invented locale policy.
fn app_default_locale(program: &CheckedProgram) -> String {
    let mut apps = program
        .modules
        .iter()
        .filter(|m| m.kind != ModuleKind::Package);
    let selected = match (apps.next(), apps.next()) {
        (Some(only), None) => Some(only),
        _ => program.modules.first(),
    };
    selected
        .and_then(|m| program.effects.modules.get(&m.id))
        .map(|d| d.source_lang.clone())
        .unwrap_or_else(|| "en".to_string())
}

/// Content hash over path-sorted `(portable_path, text)` pairs of the
/// analyzed sources: deterministic file-order-independent revision identity.
/// Paths are portable identities (see [`portable_source_id`]) so absolute
/// and relative spellings of the same input hash identically.
fn source_revision(db: &SourceDb, files: &[SourceId]) -> String {
    let root = docs_project_root();
    let mut pairs: Vec<(String, &str)> = files
        .iter()
        .filter_map(|id| db.get(*id))
        .map(|s| (portable_source_id(&s.path, &root), s.text.as_str()))
        .collect();
    pairs.sort();
    let mut bytes = Vec::new();
    for (path, text) in pairs {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(text.as_bytes());
        bytes.push(0);
    }
    sha256_hex(&bytes)
}

/// Trimmed source slice for `key`, or `None` when unavailable.
fn slice_key(db: &SourceDb, key: &NodeKey) -> Option<String> {
    let text = db.get(key.file)?.text.as_str();
    text.get(key.start as usize..key.end as usize)
        .map(|s| s.trim().to_string())
}

/// Trimmed source slice for `span`, or `None` when unavailable.
fn slice_span(db: &SourceDb, span: &Span) -> Option<String> {
    let text = db.get(span.file)?.text.as_str();
    text.get(span.start as usize..span.end as usize)
        .map(|s| s.trim().to_string())
}

/// Declared-type spelling for an optional type node, or [`UNKNOWN_TYPE`].
fn slice_key_or_unknown(db: &SourceDb, key: Option<&NodeKey>) -> String {
    key.and_then(|k| slice_key(db, k))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| UNKNOWN_TYPE.to_string())
}

/// Canonical link for one CST node.
fn location(db: &SourceDb, key: &NodeKey) -> ReferenceSourceLocation {
    ReferenceSourceLocation {
        source_id: source_id(db, key.file),
        start: key.start,
        end: key.end,
    }
}

/// Portable source identity for `file` (the registered path normalized
/// against the project root, see [`portable_source_id`]), or a synthetic
/// `source-{n}` identity when the file is unknown to `db`.
fn source_id(db: &SourceDb, file: SourceId) -> String {
    db.get(file).map_or_else(
        || format!("source-{}", file.0),
        |s| portable_source_id(&s.path, &docs_project_root()),
    )
}

/// Project root for portable source identities: the process working
/// directory — the same root that anchors the catalog `./` candidates
/// ([`CatalogAnalyzer`](crate::cli::CatalogAnalyzer),
/// [`load_catalog`](crate::analysis::catalog::load_catalog)) — or `.`
/// when unreadable.
fn docs_project_root() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Portable source identity for `path` against project `root`.
///
/// - Relative paths pass through verbatim (byte-identical for relative
///   operands, including `..` spellings: they leak no absolute prefix).
/// - Absolute paths under `root` become project-relative (`/`-separated).
/// - Absolute paths outside `root` become `external:<absolute>`
///   (truthful, stable, never silently relabeled as project-relative).
///
/// Canonicalization (when paths resolve) makes equivalent spellings agree
/// (`./x` vs `x`, symlinks, redundant components — the same ownership rule
/// as the `can docs --out` self-overwrite check); a lexical fallback keeps
/// unresolvable absolutes deterministic.
pub fn portable_source_id(path: &str, root: &Path) -> String {
    let candidate = Path::new(path);
    if candidate.is_relative() {
        return path.to_string();
    }
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if let Ok(canonical_path) = std::fs::canonicalize(candidate) {
        if let Ok(rel) = canonical_path.strip_prefix(&canonical_root) {
            return rel_to_portable(rel);
        }
        return format!("external:{}", canonical_path.to_string_lossy());
    }
    if let Ok(rel) = candidate.strip_prefix(&canonical_root) {
        return rel_to_portable(rel);
    }
    if let Ok(rel) = candidate.strip_prefix(root) {
        return rel_to_portable(rel);
    }
    format!("external:{path}")
}

/// `/`-separated relative form of a stripped prefix (portable across
/// platform separators; empty stays empty).
fn rel_to_portable(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

// --- JSON ------------------------------------------------------------------

impl ReferenceModel {
    /// Render the model as compact JSON matching `reference.ts` exactly:
    /// camelCase keys in contract order, `None` optionals omitted, `null`
    /// for absent translations and missing catalog versions. This is the
    /// `can docs` stdin payload shape (rendering/CLI are later slices).
    pub fn to_json_string(&self) -> String {
        json::render(&self.to_json())
    }

    /// The model as a [`Json`] value (same shape as [`Self::to_json_string`]).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("version".to_string(), Json::Num(self.version.to_string())),
            (
                "sourceRevision".to_string(),
                Json::Str(self.source_revision.clone()),
            ),
            (
                "catalogVersion".to_string(),
                match &self.catalog_version {
                    Some(version) => Json::Str(version.clone()),
                    None => Json::Null,
                },
            ),
            (
                "languageVersion".to_string(),
                Json::Str(self.language_version.clone()),
            ),
            (
                "appDefaultLocale".to_string(),
                Json::Str(self.app_default_locale.clone()),
            ),
            (
                "owners".to_string(),
                Json::Arr(self.owners.iter().map(ReferenceOwner::to_json).collect()),
            ),
            ("availability".to_string(), self.availability.to_json()),
        ])
    }
}

impl ReferenceOwner {
    /// Owner as JSON (`name`, `declarations`, `operations`).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("name".to_string(), Json::Str(self.name.clone())),
            (
                "declarations".to_string(),
                Json::Arr(
                    self.declarations
                        .iter()
                        .map(ReferenceDeclaration::to_json)
                        .collect(),
                ),
            ),
            (
                "operations".to_string(),
                Json::Arr(
                    self.operations
                        .iter()
                        .map(ReferenceOperation::to_json)
                        .collect(),
                ),
            ),
        ])
    }
}

impl ReferenceDeclaration {
    /// Declaration as JSON (`description` omitted when undescribed).
    pub fn to_json(&self) -> Json {
        let mut members = vec![
            ("owner".to_string(), Json::Str(self.owner.clone())),
            ("name".to_string(), Json::Str(self.name.clone())),
            (
                "kind".to_string(),
                Json::Str(self.kind.as_str().to_string()),
            ),
        ];
        if let Some(description) = &self.description {
            members.push(("description".to_string(), description.to_json()));
        }
        members.push((
            "fields".to_string(),
            Json::Arr(self.fields.iter().map(ReferenceField::to_json).collect()),
        ));
        members.push((
            "examples".to_string(),
            Json::Arr(
                self.examples
                    .iter()
                    .map(ReferenceExample::to_json)
                    .collect(),
            ),
        ));
        members.push(("location".to_string(), self.location.to_json()));
        Json::Obj(members)
    }
}

impl ReferenceField {
    /// Field as JSON (`default`/`description` omitted when absent).
    pub fn to_json(&self) -> Json {
        let mut members = vec![
            ("name".to_string(), Json::Str(self.name.clone())),
            ("type".to_string(), Json::Str(self.ty.clone())),
            ("nullable".to_string(), Json::Bool(self.nullable)),
            (
                "creationRequired".to_string(),
                Json::Bool(self.creation_required),
            ),
        ];
        if let Some(default) = &self.default {
            members.push(("default".to_string(), Json::Str(default.clone())));
        }
        members.push((
            "constraints".to_string(),
            Json::Arr(
                self.constraints
                    .iter()
                    .map(ReferenceConstraint::to_json)
                    .collect(),
            ),
        ));
        if let Some(description) = &self.description {
            members.push(("description".to_string(), description.to_json()));
        }
        Json::Obj(members)
    }
}

impl ReferenceOperationInput {
    /// Input as JSON (`default`/`description` omitted when absent).
    pub fn to_json(&self) -> Json {
        let mut members = vec![
            ("name".to_string(), Json::Str(self.name.clone())),
            ("type".to_string(), Json::Str(self.ty.clone())),
            ("nullable".to_string(), Json::Bool(self.nullable)),
            (
                "creationRequired".to_string(),
                Json::Bool(self.creation_required),
            ),
        ];
        if let Some(default) = &self.default {
            members.push(("default".to_string(), Json::Str(default.clone())));
        }
        members.push((
            "constraints".to_string(),
            Json::Arr(
                self.constraints
                    .iter()
                    .map(ReferenceConstraint::to_json)
                    .collect(),
            ),
        ));
        if let Some(description) = &self.description {
            members.push(("description".to_string(), description.to_json()));
        }
        Json::Obj(members)
    }
}

impl ReferenceOperationResult {
    /// Result as JSON (`description` omitted when absent).
    pub fn to_json(&self) -> Json {
        let mut members = vec![
            ("type".to_string(), Json::Str(self.ty.clone())),
            ("nullable".to_string(), Json::Bool(self.nullable)),
        ];
        if let Some(description) = &self.description {
            members.push(("description".to_string(), description.to_json()));
        }
        Json::Obj(members)
    }
}

impl ReferenceOperation {
    /// Operation as JSON: callable surface only (`id`, `description`,
    /// `inputs`, `result`, `examples`, `location`) — no authorization
    /// material. `examples` is always present (possibly empty), mirroring
    /// declarations; pre-R4 payloads omit the key and still render.
    pub fn to_json(&self) -> Json {
        let mut members = vec![("id".to_string(), Json::Str(self.id.clone()))];
        if let Some(description) = &self.description {
            members.push(("description".to_string(), description.to_json()));
        }
        members.push((
            "inputs".to_string(),
            Json::Arr(
                self.inputs
                    .iter()
                    .map(ReferenceOperationInput::to_json)
                    .collect(),
            ),
        ));
        members.push(("result".to_string(), self.result.to_json()));
        members.push((
            "examples".to_string(),
            Json::Arr(
                self.examples
                    .iter()
                    .map(ReferenceExample::to_json)
                    .collect(),
            ),
        ));
        members.push(("location".to_string(), self.location.to_json()));
        Json::Obj(members)
    }
}

impl ReferenceExample {
    /// Example as JSON (`expected` omitted when the source states none).
    pub fn to_json(&self) -> Json {
        let mut members = vec![
            ("label".to_string(), Json::Str(self.label.clone())),
            ("source".to_string(), Json::Str(self.source.clone())),
        ];
        if let Some(expected) = &self.expected {
            members.push(("expected".to_string(), Json::Str(expected.clone())));
        }
        Json::Obj(members)
    }
}

impl ReferenceDescriptionValue {
    /// Description as JSON (`source`, `sourceLang`, `variants`, `location`).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("source".to_string(), Json::Str(self.source.clone())),
            (
                "sourceLang".to_string(),
                Json::Str(self.source_lang.clone()),
            ),
            (
                "variants".to_string(),
                Json::Arr(
                    self.variants
                        .iter()
                        .map(ReferenceDescriptionVariant::to_json)
                        .collect(),
                ),
            ),
            ("location".to_string(), self.location.to_json()),
        ])
    }
}

impl ReferenceDescriptionVariant {
    /// Variant as JSON (`text` is `null` for absent translations).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("tag".to_string(), Json::Str(self.tag.clone())),
            (
                "text".to_string(),
                match &self.text {
                    Some(text) => Json::Str(text.clone()),
                    None => Json::Null,
                },
            ),
        ])
    }
}

impl ReferenceConstraint {
    /// Constraint as JSON (`kind`, `detail`).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("kind".to_string(), Json::Str(self.kind.clone())),
            ("detail".to_string(), Json::Str(self.detail.clone())),
        ])
    }
}

impl ReferenceSourceLocation {
    /// Location as JSON (`sourceId`, `start`, `end`).
    pub fn to_json(&self) -> Json {
        Json::Obj(vec![
            ("sourceId".to_string(), Json::Str(self.source_id.clone())),
            ("start".to_string(), Json::Num(self.start.to_string())),
            ("end".to_string(), Json::Num(self.end.to_string())),
        ])
    }
}

impl ReferenceAvailability {
    /// Availability as JSON (`{status}` or `{status, owner, catalog}`).
    pub fn to_json(&self) -> Json {
        match self {
            ReferenceAvailability::Unknown => Json::Obj(vec![(
                "status".to_string(),
                Json::Str("unknown".to_string()),
            )]),
            ReferenceAvailability::Available { owner, catalog } => Json::Obj(vec![
                ("status".to_string(), Json::Str("available".to_string())),
                ("owner".to_string(), Json::Str(owner.clone())),
                ("catalog".to_string(), Json::Str(catalog.clone())),
            ]),
        }
    }
}
