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
mod construct_candidates;
mod cohort;
pub mod effects;
pub mod examples;
pub mod migrate_check;
pub mod resolve;
pub mod types;

pub use catalog::Catalog;
pub use effects::EffectTables;
pub use examples::ExampleTables;
pub use resolve::{Module, ModuleId, ResolveTables, Symbol, SymbolId, SymbolKind};
pub use types::{ResolvedType, Scalar, TypeTable};

use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId};
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
    cohort: cohort::CheckedCohort,
}

impl CheckedProgram {
    /// Files selected for checking, in the caller's original order.
    ///
    /// Other entries in the source database are metadata inventory, not
    /// additional checked semantics. Appending sources does not extend this list.
    pub fn checked_files(&self) -> &[SourceId] {
        self.cohort.files()
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
    let mut trees = Vec::with_capacity(files.len());
    let mut diagnostics = Vec::new();
    for &file in files {
        let (tree, mut parse_diags) = crate::syntax::parse(db, file);
        diagnostics.append(&mut parse_diags);
        trees.push((file, tree));
    }
    let resolve_tables = match resolve::try_resolve_program(db, &trees, catalog, &mut diagnostics) {
        Ok(tables) => tables,
        Err(diagnostic) => {
            diagnostics.push(diagnostic);
            let mut diagnostics = check::dedup_diagnostics(diagnostics);
            check::sort_diagnostics(&mut diagnostics);
            construct_candidates::annotate(db, &trees, &mut diagnostics);
            return (
                CheckedProgram {
                    modules: Vec::new(),
                    symbols: Vec::new(),
                    types: TypeTable::default(),
                    effects: EffectTables::default(),
                    examples: ExampleTables::default(),
                    catalog_version: catalog.map_or_else(String::new, |c| c.version().to_string()),
                    cohort: cohort::CheckedCohort::new(db, files, catalog),
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
    construct_candidates::annotate(db, &trees, &mut diagnostics);
    let program = CheckedProgram {
        modules: resolve_tables.modules.clone(),
        symbols: resolve_tables.symbols.clone(),
        types,
        effects,
        examples,
        catalog_version: catalog.map_or_else(String::new, |c| c.version().to_string()),
        cohort: cohort::CheckedCohort::new(db, files, catalog),
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

/// Text of a `Name` leaf, if `node` is one.
pub(crate) fn name_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        node.token().map(|t| t.text(text))
    } else {
        None
    }
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
