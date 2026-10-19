//! Name resolution and type checking (lane-01 analysis, PR5).
//!
//! Pipeline: [`check_program`] runs parse (`E1xxx`, see [`crate::syntax`])
//! then resolve ([`resolve`], `E2xxx`) then types ([`types`], `E3xxx`)
//! then effects ([`effects`], `E4xxx`) then examples ([`examples`],
//! `E5xxx`), with cross-pass dedup/sort in [`check`]. The producer
//! catalog ([`catalog`], `E6xxx`) is loaded by the caller and consulted
//! for builtin call shapes; helpers are codegen-only and never callable
//! from source.
//!
//! The pipeline is complete: [`check_program`] runs every pass and callers
//! report `complete=true` (gated by [`check::readiness`]). See
//! [`CheckedProgram`] for the codegen input contract.
//!
//! Recorded hole (M6): catalog-item `NAME=word` options are catalog
//! vocabulary, not name references, so neither pass resolves them and
//! no `E2001` fires for an unknown option word; membership checking
//! needs the PR5 component catalogs. Complex positional catalog
//! domains (calls, member paths) and `slot`/`preferences` children
//! resolve and type normally.
//!
//! Recorded hole (M6 extension, PR6): bare-word catalog headers
//! (`input title`) are field-selector vocabulary, also silent: binding
//! them needs per-component header profiles, and no producer UI
//! catalog exists yet. Core leafs (`text`) stay strict. The boundary
//! is pinned by `ui_transparent_groups_resolve`.

pub mod catalog;
pub mod check;
mod cohort;
pub mod effects;
pub mod examples;
pub mod generation;
pub mod generation_config;
pub mod generation_intake;
pub mod generation_protocol;
pub(crate) mod generation_store;
mod icu;
pub mod migrate_check;
pub mod resolve;
pub mod scenario_disclosure;
pub mod types;

pub use catalog::Catalog;
pub use effects::EffectTables;
pub use examples::ExampleTables;
pub use generation::{
    GenerationDescriptor, GenerationDiscovery, GenerationKind, KeywordArgDescriptor,
    KeywordParamDescriptor, discover_generation, discover_program,
};
pub use resolve::{Module, ModuleId, ResolveTables, Symbol, SymbolId, SymbolKind};
pub use types::{ResolvedType, Scalar, TypeTable};

use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{SyntaxKind, SyntaxNode};

/// Identity of one CST node for analysis tables.
///
/// `(file, start, end, kind)` is unique per node: interior nodes spanning a
/// single child always differ in kind (e.g. `Argument` over `NameRef`),
/// and siblings never share a span. The `u8` is the [`SyntaxKind`]
/// discriminant order; it is a process-local key, never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeKey {
    /// Source containing the node.
    pub file: SourceId,
    /// Inclusive start byte offset.
    pub start: u32,
    /// Exclusive end byte offset.
    pub end: u32,
    /// [`SyntaxKind`] discriminant (`kind as u8`).
    pub kind: u8,
}

impl NodeKey {
    /// Key for `node`.
    pub fn of(node: &SyntaxNode) -> Self {
        Self {
            file: node.span.file,
            start: node.span.start,
            end: node.span.end,
            kind: node.kind as u8,
        }
    }
}

/// Checked program: the PR5/codegen input contract.
///
/// Constructed by [`check_program`] for one [`SourceDb`] owner and one
/// immutable [`Catalog`] owner (or no catalog). Lowering requires those
/// owners; moving them, appending sources, and cloning the catalog preserve
/// the association. Independently reconstructed equivalent inputs require
/// rechecking. The private association prevents external struct literals.
///
/// Stability: `modules` and `symbols` follow the selected file order and
/// declaration order within each file; ids are indices and never reused.
/// [`NodeKey`]s name CST nodes of the analyzed sources. [`ResolvedType`]
/// may gain variants as later stages type more positions; unknown future
/// positions are simply absent from [`TypeTable::node_types`].
/// Public tables remain editable: the input association does not authenticate
/// them or establish semantic correctness. Callers still own diagnostics and
/// shipping decisions.
pub struct CheckedProgram {
    /// One module per `app`/`package` declaration: identity, imports,
    /// ownership and declaration spans. Composed apps carry their `uses`
    /// expansion; migrations are not modules in PR4.
    pub modules: Vec<Module>,
    /// Canonical package-qualified symbols (`Package.Name`,
    /// `Package.Model.field`, `Package.Model.create`, ...).
    pub symbols: Vec<Symbol>,
    /// Resolved types per symbol and per typed CST node.
    pub types: TypeTable,
    /// Effects, handlers and rule tables (PR5A).
    pub effects: EffectTables,
    /// Fixture, behavior-table and sequence tables (PR5B).
    pub examples: ExampleTables,
    /// `catalog_version` of the producer catalog consulted, or the empty
    /// string when no catalog was available (an `E6xxx` is then reported).
    pub catalog_version: String,
    scenario_disclosures:
        std::collections::HashMap<SymbolId, scenario_disclosure::ScenarioDisclosure>,
    pub(crate) committed_handlers: Vec<CheckedCommittedHandler>,
    pub(crate) standard_completion_handlers: Vec<CheckedStandardCompletionHandler>,
    mailbox_handlers: Vec<CheckedMailboxHandler>,
    cohort: cohort::CheckedCohort,
    // Original check input, independent of editable public analysis tables.
    original_given: Option<types::GivenContractTables>,
}

/// Source declarations retained before the public analysis tables can be
/// edited. This census supports complete source publication, not authority.
#[derive(Debug, Clone)]
pub(crate) struct CheckedCommittedHandler {
    pub id: SymbolId,
    pub module: resolve::ModuleId,
    pub canonical: String,
    pub model: SymbolId,
    pub model_canonical: String,
    pub event: String,
    pub cohort: Option<effects::CohortData>,
    pub cohort_model: Option<String>,
    pub span: crate::source::Span,
}

#[derive(Debug, Clone)]
pub(crate) struct CheckedStandardCompletionHandler {
    pub id: SymbolId,
    pub module: resolve::ModuleId,
    pub canonical: String,
    pub node: NodeKey,
    pub on: NodeKey,
    pub completion: types::CheckedStdDeliveryCompletion,
    pub cohort: Option<effects::CohortData>,
    pub cohort_model: Option<String>,
    pub span: crate::source::Span,
}

/// Original checked Mailbox source requirement retained independently of the
/// editable effects, types and module tables. It supplies no ingress authority.
#[derive(Debug, Clone)]
pub(crate) struct CheckedMailboxHandler {
    pub id: SymbolId,
    pub module: ModuleId,
    pub module_name: String,
    pub file: SourceId,
    pub module_span: crate::source::Span,
    pub name: String,
    pub canonical: String,
    pub node: NodeKey,
    pub on: NodeKey,
    pub event: types::CheckedStdCapabilityEvent,
    pub span: crate::source::Span,
}

impl CheckedProgram {
    pub(crate) fn original_given(&self) -> Option<&types::GivenContractTables> {
        self.original_given.as_ref()
    }

    pub(crate) fn mailbox_handlers(&self) -> &[CheckedMailboxHandler] {
        &self.mailbox_handlers
    }

    /// Files selected for checking, in the caller's original order.
    ///
    /// Other entries in the source database are metadata inventory, not
    /// additional checked semantics. Appending sources does not extend this list.
    pub fn checked_files(&self) -> &[SourceId] {
        self.cohort.files()
    }

    /// Complete return closures or an explicit whole-scenario decline from
    /// the clean checked cohort. These facts alone do not publish runtime claims.
    pub fn scenario_disclosures(
        &self,
    ) -> &std::collections::HashMap<SymbolId, scenario_disclosure::ScenarioDisclosure> {
        &self.scenario_disclosures
    }

    pub(crate) fn validate_cohort(
        &self,
        db: &SourceDb,
        catalog: Option<&Catalog>,
    ) -> Result<(), Diagnostic> {
        self.cohort.validate(db, catalog)
    }
}

/// Run the full check pipeline over `files`.
///
/// Returns the checked program plus every diagnostic (`E1xxx` parse,
/// `E2xxx` resolve, `E6xxx` catalog-shape, `E3xxx` types, `E4xxx`
/// effects, `E5xxx` examples), deduplicated and sorted. The caller merges
/// catalog-*loading* diagnostics (see [`catalog::load_catalog`]).
pub fn check_program(
    db: &SourceDb,
    files: &[SourceId],
    catalog: Option<&Catalog>,
) -> (CheckedProgram, Vec<Diagnostic>) {
    check_program_with_given(db, files, catalog, None)
}

/// Apply checked owner-attached Given fields before resolving/checking bodies.
pub(crate) fn check_program_with_given(
    db: &SourceDb,
    files: &[SourceId],
    catalog: Option<&Catalog>,
    given: Option<&types::GivenContractTables>,
) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut trees = Vec::with_capacity(files.len());
    let mut diagnostics = Vec::new();
    for &file in files {
        let (tree, mut parse_diags) = crate::syntax::parse(db, file);
        diagnostics.append(&mut parse_diags);
        trees.push((file, tree));
    }
    // BGI-01 discovery-level generation diagnostics (definitions collected
    // before applications; works before any saved implementation exists).
    for (file, tree) in &trees {
        if let Some(source) = db.get(*file) {
            let found = generation::discover_generation(tree, &source.text);
            diagnostics.extend(found.diagnostics);
        }
    }
    let resolve_tables =
        match resolve::try_resolve_program_with_given(db, &trees, catalog, given, &mut diagnostics)
        {
            Ok(tables) => tables,
            Err(diagnostic) => {
                diagnostics.push(diagnostic);
                let mut diagnostics = check::dedup_diagnostics(diagnostics);
                check::sort_diagnostics(&mut diagnostics);
                return (
                    CheckedProgram {
                        modules: Vec::new(),
                        symbols: Vec::new(),
                        types: TypeTable::default(),
                        effects: EffectTables::default(),
                        examples: ExampleTables::default(),
                        catalog_version: catalog
                            .map_or_else(String::new, |c| c.version().to_string()),
                        scenario_disclosures: std::collections::HashMap::new(),
                        committed_handlers: Vec::new(),
                        standard_completion_handlers: Vec::new(),
                        mailbox_handlers: Vec::new(),
                        cohort: cohort::CheckedCohort::new(db, files, catalog),
                        original_given: given.cloned(),
                    },
                    diagnostics,
                );
            }
        };
    let types = types::check_types(db, &trees, catalog, &resolve_tables, &mut diagnostics);
    resolve::emit_unresolved(db, &resolve_tables, &types, &mut diagnostics);
    let effects = effects::check_effects(
        db,
        &trees,
        &resolve_tables,
        &types,
        catalog,
        &mut diagnostics,
    );
    let examples = examples::check_examples(
        db,
        &trees,
        &resolve_tables,
        &types,
        catalog,
        &mut diagnostics,
    );
    let mut diagnostics = check::dedup_diagnostics(diagnostics);
    check::sort_diagnostics(&mut diagnostics);
    let scenario_disclosures = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        std::collections::HashMap::new()
    } else {
        scenario_disclosure::analyze_scenario_disclosure_with_catalog(
            db,
            &trees,
            &resolve_tables,
            &types,
            &effects,
            catalog,
        )
    };
    let committed_handlers = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        Vec::new()
    } else {
        resolve_tables
            .symbols
            .iter()
            .filter_map(|symbol| {
                let data = effects.scenarios.get(&symbol.id)?;
                let Some(effects::HandlerSource::Committed { model, event }) = &data.on else {
                    return None;
                };
                Some(CheckedCommittedHandler {
                    id: symbol.id,
                    module: symbol.module,
                    canonical: symbol.canonical.clone(),
                    model: *model,
                    model_canonical: resolve_tables.symbols[model.0 as usize].canonical.clone(),
                    event: event.clone(),
                    cohort: data.cohort.clone(),
                    cohort_model: data.cohort.as_ref().map(|cohort| {
                        resolve_tables.symbols[cohort.model.0 as usize]
                            .canonical
                            .clone()
                    }),
                    span: symbol.span,
                })
            })
            .collect()
    };
    let standard_completion_handlers = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        Vec::new()
    } else {
        resolve_tables
            .symbols
            .iter()
            .filter_map(|symbol| {
                let data = effects.scenarios.get(&symbol.id)?;
                let Some(effects::HandlerSource::StdDeliveryCompleted { source, .. }) = &data.on
                else {
                    return None;
                };
                let on = data.on_node.as_ref()?;
                let completion = types.std_delivery_completion_handlers.get(on)?;
                if completion.module != symbol.module || completion.source != *source {
                    return None;
                }
                Some(CheckedStandardCompletionHandler {
                    id: symbol.id,
                    module: symbol.module,
                    canonical: symbol.canonical.clone(),
                    node: data.node,
                    on: *on,
                    completion: completion.clone(),
                    cohort: data.cohort.clone(),
                    cohort_model: data.cohort.as_ref().map(|cohort| {
                        resolve_tables.symbols[cohort.model.0 as usize]
                            .canonical
                            .clone()
                    }),
                    span: symbol.span,
                })
            })
            .collect()
    };
    let mailbox_handlers = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        Vec::new()
    } else {
        resolve_tables
            .symbols
            .iter()
            .filter_map(|symbol| {
                let data = effects.scenarios.get(&symbol.id)?;
                let on = data.on_node?;
                let event = types.std_capability_event_handlers.get(&on)?;
                let Some(effects::HandlerSource::StdCapabilityEvent {
                    capability,
                    event: name,
                    source,
                }) = &data.on
                else {
                    return None;
                };
                if capability != "std.MailboxV1"
                    || name != "received"
                    || event.capability != *capability
                    || event.event != *name
                    || event.source != *source
                {
                    return None;
                }
                let module = resolve_tables.modules.get(symbol.module.0 as usize)?;
                Some(CheckedMailboxHandler {
                    id: symbol.id,
                    module: symbol.module,
                    module_name: module.name.clone(),
                    file: module.file,
                    module_span: module.span,
                    name: symbol.name.clone(),
                    canonical: symbol.canonical.clone(),
                    node: data.node,
                    on,
                    event: event.clone(),
                    span: symbol.span,
                })
            })
            .collect()
    };
    let program = CheckedProgram {
        modules: resolve_tables.modules.clone(),
        symbols: resolve_tables.symbols.clone(),
        types,
        effects,
        examples,
        catalog_version: catalog.map_or_else(String::new, |c| c.version().to_string()),
        scenario_disclosures,
        committed_handlers,
        standard_completion_handlers,
        mailbox_handlers,
        cohort: cohort::CheckedCohort::new(db, files, catalog),
        original_given: given.cloned(),
    };
    (program, diagnostics)
}

// --- Shared CST helpers -------------------------------------------------

/// Significant children: skips `Trivia`/`Comment` leaves interleaved by the
/// lossless builder. `BadToken` leaves are kept: callers treat a subtree
/// containing one as already-diagnosed (`E1xxx`) and stay silent.
pub(crate) fn kids(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| !matches!(c.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

/// Unwrap `(...)` groups to the middle child, if exactly 3-part.
/// Single home for lint and types (their bodies were behavior-identical):
/// strict shape key — malformed groups are returned as-is so callers'
/// kind checks bail instead of deriving facts from broken syntax.
pub(crate) fn unwrap_groups(mut node: &SyntaxNode) -> &SyntaxNode {
    loop {
        if node.kind != SyntaxKind::Group {
            return node;
        }
        let parts = kids(node);
        if parts.len() == 3 {
            node = parts[1];
        } else {
            return node;
        }
    }
}

/// Text of a `Name` leaf, if `node` is one.
pub(crate) fn name_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        node.token().map(|t| t.text(text))
    } else {
        None
    }
}

/// Word of a `NameRef` leaf (first named child), if `node` is one.
pub(crate) fn nameref_word<'a>(text: &'a str, node: &SyntaxNode) -> Option<&'a str> {
    if node.kind != SyntaxKind::NameRef {
        return None;
    }
    kids(node).iter().find_map(|n| name_text(n, text))
}

/// Tight span of `node`: surrounding trivia trimmed so primaries point at significant source.
pub(crate) fn tight_span(text: &str, node: &SyntaxNode) -> Span {
    let raw = text
        .get(node.span.start as usize..node.span.end as usize)
        .unwrap_or("");
    let leading = raw.len() - raw.trim_start().len();
    let trimmed = raw.trim();
    let start = node.span.start + leading as u32;
    Span::new(node.span.file, start, start + trimmed.len() as u32)
}

/// Whether `node` is a `Name` leaf with spelling `word`.
pub(crate) fn is_name(node: &SyntaxNode, text: &str, word: &str) -> bool {
    name_text(node, text) == Some(word)
}

/// Whether `node` is a `Punct` leaf with spelling `spell`.
pub(crate) fn is_punct(node: &SyntaxNode, text: &str, spell: &str) -> bool {
    node.kind == SyntaxKind::Punct && node.token().is_some_and(|t| t.text(text) == spell)
}

/// Operator spelling of a `Binary`/`Unary` node (the operator leaf between
/// the operands), e.g. `+`, `and`, `is`, `not`.
pub(crate) fn op_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    node.children.iter().find_map(|c| match c.kind {
        SyntaxKind::Punct | SyntaxKind::Name => c.token().map(|t| t.text(text)),
        _ => None,
    })
}

/// Dotted segments of a `Path` node.
pub(crate) fn path_segments<'a>(node: &SyntaxNode, text: &'a str) -> Vec<&'a str> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .filter_map(|c| c.token().map(|t| t.text(text)))
        .collect()
}

/// `(key, value)` of an `Attribute` node (`key = value`).
pub(crate) fn attribute_parts(node: &SyntaxNode) -> Option<(&SyntaxNode, &SyntaxNode)> {
    let parts = kids(node);
    if parts.len() == 3 && parts[1].kind == SyntaxKind::Punct {
        Some((parts[0], parts[2]))
    } else {
        None
    }
}

/// Attribute value node for `key` among the direct `Attribute` children.
pub(crate) fn attribute_value<'a>(
    node: &'a SyntaxNode,
    key: &str,
    text: &str,
) -> Option<&'a SyntaxNode> {
    node.children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Attribute)
        .find_map(|attr| {
            let (name, value) = attribute_parts(attr)?;
            if is_name(name, text, key) {
                Some(value)
            } else {
                None
            }
        })
}

/// Source text of `file`, or `None` for an unknown id.
pub(crate) fn file_text(db: &SourceDb, file: SourceId) -> Option<&str> {
    db.get(file).map(|s| s.text.as_str())
}
