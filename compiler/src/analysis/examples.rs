//! Inline behavior examples: fixtures, tables and sequences (lane-01 analysis, PR5B).
//!
//! [`check_examples`] validates the test-only surface from DESIGN §5.1:
//! fixture recipes as referenced by examples, table headers/rows and
//! shared-state sequences, plus the message-pattern profile from DESIGN
//! §9.1. It owns every `E5xxx` diagnostic:
//!
//! - `E5001` unknown example binding, malformed `seed` or missing required
//!   input;
//! - `E5002` unknown example selector (bad roots, bad navigation, input
//!   positions holding non-selectors, observations over inputs);
//! - `E5003` conflicting example selectors (duplicate or overlapping
//!   initial-state paths);
//! - `E5004` invalid example caller (`as` cells, sequence `by=`);
//! - `E5005` invalid expected error code;
//! - `E5006` invalid example sequence (unresolved calls, bad envelopes,
//!   missing enclosing-scenario call);
//! - `E5007` invalid ICU message pattern;
//! - `E5008` fixture override of reserved metadata or recipe internals;
//! - `E5009` invalid message signature (parameter types).
//!
//! Division of labor with the earlier passes: the parser owns syntactic
//! shape and arity (`E1210`); resolve owns fixture/production name
//! binding, cycles and duplicates (`E2xxx`); types owns recipe field
//! typing, label tables, caption shapes and descriptor locale tags
//! (`E3013`–`E3016`). This pass never re-reports those faults: subtrees
//! containing a syntax error are skipped, unresolvable header names are
//! resolve's `E2001`, and placeholder/parameter *name* coverage stays
//! `E3016` (only structural ICU profile violations are `E5007`).
//!
//! Row-cell *values* (other than `as` caller cells and `error(code)`
//! cells) and observation expressions are runner-typed: this pass checks
//! their positions, not their types. Unknown names inside general row
//! expressions are deliberately not resolved here.

use std::collections::{HashMap, HashSet};

use super::catalog::Catalog;
use super::resolve::{
    CrudOp, FixtureTarget, ModelOwner, ModuleId, ResolveTables, ScopedName, SymbolId, SymbolKind,
    has_error, is_expression,
};
use super::types::{ResolvedType, Scalar, TypeTable};
use super::{
    NodeKey, attribute_parts, attribute_value, file_text, is_name, kids, name_text, path_segments,
};
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::lexer::TokenKind;
use crate::syntax::{Punct, SyntaxKind, SyntaxNode};

/// Business error codes observable through `error(code)`.
///
/// The closed set from DESIGN §§5.1/7/10: admission and guard outcomes
/// (`forbidden`, `not_found`, `conflict`, `validation`, `rule_failed`)
/// plus capacity/delivery outcomes (`busy`, `limit`, `delivery_unknown`).
/// Lifecycle `skipped` is a state, not a rejection code.
pub const ERROR_CODES: [&str; 8] = [
    "validation",
    "forbidden",
    "not_found",
    "conflict",
    "rule_failed",
    "busy",
    "limit",
    "delivery_unknown",
];

/// One fixture recipe declaration: the codegen fixture-table input.
///
/// Field-level recipe validity is the types pass (`E3015`); this table
/// carries identity, target and seed edges for the test-artifact
/// builders (`ir.rs`, `bdd.rs`).
#[derive(Debug, Clone)]
pub struct FixtureRecipe {
    /// Fixture symbol.
    pub symbol: SymbolId,
    /// Fixture declaration node.
    pub node: NodeKey,
    /// Declaration span.
    pub span: Span,
    /// Owning module.
    pub module: ModuleId,
    /// Recipe target (model, user, file, operation, unknown).
    pub target: FixtureTarget,
    /// Fixtures referenced by this recipe's values.
    pub seeds: Vec<SymbolId>,
}

/// One table-form `examples` block: the codegen behavior-table input.
#[derive(Debug, Clone)]
pub struct BehaviorTable {
    /// `examples` block node.
    pub node: NodeKey,
    /// Whole-block span.
    pub span: Span,
    /// Owning module.
    pub module: ModuleId,
    /// Enclosing scenario or generated CRUD operation, if resolvable.
    pub operation: Option<SymbolId>,
    /// CRUD operation under test, for CRUD-attached tables.
    pub crud_op: Option<CrudOp>,
    /// Common input binding names (excluding `seed`).
    pub bindings: Vec<String>,
    /// Resolved `seed` fixtures.
    pub seeds: Vec<SymbolId>,
    /// Input header selector spellings in column order.
    pub inputs: Vec<String>,
    /// Observation header spellings in column order.
    pub observations: Vec<String>,
    /// Data row count (excluding the header).
    pub rows: usize,
}

/// One sequence-form `examples`/`do` block.
#[derive(Debug, Clone)]
pub struct ExampleSequence {
    /// `examples` block node.
    pub node: NodeKey,
    /// Whole-block span.
    pub span: Span,
    /// Owning module.
    pub module: ModuleId,
    /// Enclosing user scenario, if resolvable.
    pub operation: Option<SymbolId>,
    /// Resolved `seed` fixtures.
    pub seeds: Vec<SymbolId>,
    /// Test calls in step order.
    pub calls: Vec<SequenceCall>,
    /// Observation assertion count (`as`-less `->` steps plus
    /// expected-error calls).
    pub assertions: usize,
}

/// One sequence test call.
#[derive(Debug, Clone)]
pub struct SequenceCall {
    /// Call step node.
    pub node: NodeKey,
    /// Step span.
    pub span: Span,
    /// Resolved target operation, if resolvable.
    pub target: Option<SymbolId>,
    /// `by=` caller spelling.
    pub caller: String,
    /// Whether the call expects `error(code)`.
    pub expects_error: bool,
}

/// Example tables: fixture recipes, behavior tables and sequences.
///
/// The PR5/codegen input contract for the test artifact. Entries are in
/// `(file, span.start)` order; blocks under a syntax error are still
/// recorded when their shape is recognizable so codegen sees every
/// authored example, but no `E5xxx` is reported for them.
#[derive(Debug, Clone, Default)]
pub struct ExampleTables {
    /// Fixture recipes in source order.
    pub fixtures: Vec<FixtureRecipe>,
    /// Table-form examples in source order.
    pub tables: Vec<BehaviorTable>,
    /// Sequence-form examples in source order.
    pub sequences: Vec<ExampleSequence>,
}

/// Validate fixtures, example tables/sequences and message patterns.
///
/// Walks every module body in `trees`, pushing `E5xxx` diagnostics into
/// `diags` and returning the codegen-facing [`ExampleTables`].
pub fn check_examples<'a>(
    db: &'a SourceDb,
    trees: &'a [(SourceId, SyntaxNode)],
    tables: &'a ResolveTables,
    type_table: &'a TypeTable,
    catalog: Option<&'a Catalog>,
    diags: &'a mut Vec<Diagnostic>,
) -> ExampleTables {
    let mut checker = Checker {
        db,
        tables,
        types: type_table,
        catalog,
        diags,
        nodes: HashMap::new(),
        imports: HashMap::new(),
        out: ExampleTables::default(),
    };
    checker.run(trees);
    checker.out
}

struct Checker<'a> {
    db: &'a SourceDb,
    tables: &'a ResolveTables,
    types: &'a TypeTable,
    catalog: Option<&'a Catalog>,
    diags: &'a mut Vec<Diagnostic>,
    /// Declaration nodes by symbol, for default/server inspection.
    nodes: HashMap<SymbolId, &'a SyntaxNode>,
    /// Imported member aliases per module (for import-aware leniency).
    imports: HashMap<ModuleId, HashSet<String>>,
    out: ExampleTables,
}

/// Operation under test for one `examples` block.
#[derive(Debug, Clone)]
enum OpCtx {
    Scenario {
        id: SymbolId,
        params: Vec<SymbolId>,
        trusted: bool,
        has_result: bool,
        /// Resolved trusted-event envelope for `on=` handlers
        /// (T35/R24): declared events carry their event record;
        /// `Cap.op.completed` carries the delivery envelope with
        /// the op's declared result. `None` keeps the opaque base.
        event: Option<ResolvedType>,
    },
    Crud {
        model: SymbolId,
        op: CrudOp,
    },
}

impl<'a> Checker<'a> {
    fn run(&mut self, trees: &'a [(SourceId, SyntaxNode)]) {
        self.collect_nodes(trees);
        for (file, tree) in trees {
            let Some(text) = file_text(self.db, *file) else {
                continue;
            };
            let text: &str = text;
            for child in kids(tree) {
                match child.kind {
                    SyntaxKind::App | SyntaxKind::Package => {
                        let Some(module) = module_for(self.tables, child.span) else {
                            continue;
                        };
                        self.check_module(*file, text, module, child);
                    }
                    _ => {}
                }
            }
        }
        // Anonymous (inline) descriptors anywhere outside `message`
        // declarations: structural ICU only, no declared signature.
        for (file, tree) in trees {
            let Some(text) = file_text(self.db, *file) else {
                continue;
            };
            self.check_inline_patterns(text, tree);
        }
    }

    /// Index scenario/model declaration nodes by symbol for
    /// default and server-initializer inspection.
    fn collect_nodes(&mut self, trees: &'a [(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let Some(text) = file_text(self.db, *file) else {
                continue;
            };
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = module_for(self.tables, child.span) else {
                    continue;
                };
                for top in kids(child) {
                    if top.kind == SyntaxKind::Import {
                        self.collect_import(text, module, top);
                    }
                }
                for section in kids(child) {
                    if section.kind != SyntaxKind::Section {
                        continue;
                    }
                    for item in kids(section) {
                        if item.kind == SyntaxKind::Import {
                            self.collect_import(text, module, item);
                            continue;
                        }
                        let heads: &[&str] = match item.kind {
                            SyntaxKind::Scenario => &["export", "scenario"],
                            SyntaxKind::Model => &["export"],
                            _ => continue,
                        };
                        if let Some(name) = decl_name(text, item, heads)
                            && let Some(id) = prod_symbol(self.tables, module, name)
                        {
                            self.nodes.insert(id, item);
                        }
                    }
                }
            }
        }
    }

    /// Record one import declaration's consumer-side aliases.
    fn collect_import(&mut self, text: &str, module: ModuleId, node: &SyntaxNode) {
        for member in node
            .descendants()
            .filter(|n| n.kind == SyntaxKind::ImportMember)
        {
            let alias = member
                .children
                .iter()
                .rev()
                .filter_map(|n| name_text(n, text))
                .find(|w| *w != "as")
                .map(str::to_string);
            if let Some(alias) = alias {
                self.imports.entry(module).or_default().insert(alias);
            }
        }
    }

    fn check_module(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        for section in kids(node) {
            if section.kind != SyntaxKind::Section {
                continue;
            }
            for item in kids(section) {
                if has_error(item) {
                    continue;
                }
                match item.kind {
                    SyntaxKind::Scenario => self.check_scenario(file, text, module, item),
                    SyntaxKind::Crud => self.check_crud(file, text, module, item),
                    SyntaxKind::Message => self.check_message(text, module, item),
                    SyntaxKind::Fixture => self.check_fixture(text, module, item),
                    _ => {}
                }
            }
        }
    }

    fn check_scenario(&mut self, _file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let name = decl_name(text, node, &["export", "scenario"]);
        let id = name.and_then(|n| prod_symbol(self.tables, module, n));
        let Some(id) = id else { return };
        let SymbolKind::Scenario {
            params, trusted, ..
        } = self.tables.symbols[id.0 as usize].kind.clone()
        else {
            return;
        };
        let has_result = matches!(self.types.symbol_results.get(&id), Some(Some(_)));
        let event = scenario_event_envelope(self.tables, self.types, text, module, node);
        let ctx = OpCtx::Scenario {
            id,
            params,
            trusted,
            has_result,
            event,
        };
        for child in kids(node) {
            if child.kind == SyntaxKind::Examples && !has_error(child) {
                self.check_block(text, module, &ctx, node, child);
            }
        }
    }

    fn check_crud(&mut self, _file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let model = kids(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::Path)
            .and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
        let Some(model) = model else { return };
        if !matches!(
            self.tables.symbols[model.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            return;
        }
        for child in kids(node) {
            if child.kind != SyntaxKind::Examples || has_error(child) {
                continue;
            }
            let op = kids(child).iter().find_map(|n| {
                let word = name_text(n, text)?;
                match word {
                    "create" => Some(CrudOp::Create),
                    "update" => Some(CrudOp::Update),
                    "delete" => Some(CrudOp::Delete),
                    _ => None,
                }
            });
            let Some(op) = op else { continue };
            // The parser pins the spelling; only enabled operations
            // accept examples (`E5001`).
            let enabled = self
                .tables
                .crud_of_model
                .get(&model)
                .and_then(|crud| match &self.tables.symbols[crud.0 as usize].kind {
                    SymbolKind::Crud {
                        create,
                        update,
                        delete,
                        ..
                    } => Some(match op {
                        CrudOp::Create => *create,
                        CrudOp::Update => *update,
                        CrudOp::Delete => *delete,
                    }),
                    _ => None,
                })
                .unwrap_or(false);
            if !enabled {
                let span = kids(child)
                    .iter()
                    .find(|n| {
                        name_text(n, text)
                            .is_some_and(|w| matches!(w, "create" | "update" | "delete"))
                    })
                    .map(|n| tight_span(text, n))
                    .unwrap_or_else(|| tight_span(text, child));
                self.diags.push(Diagnostic::error(
                    "E5001",
                    format!("examples {} names a disabled operation", op.as_str()),
                    span,
                ));
                continue;
            }
            let ctx = OpCtx::Crud { model, op };
            self.check_block(text, module, &ctx, node, child);
        }
    }

    /// Record one fixture recipe for the test artifact.
    ///
    /// Recipe field validity is the types pass (`E3015`); only identity,
    /// target and seed edges are recorded here.
    fn check_fixture(&mut self, text: &str, module: ModuleId, node: &SyntaxNode) {
        let name = decl_name(text, node, &["export", "fixture"]);
        let id = name.and_then(|n| test_symbol(self.tables, module, n));
        let Some(id) = id else { return };
        let target = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Fixture { target } => *target,
            _ => return,
        };
        let seeds = self
            .tables
            .fixture_edges
            .get(&id)
            .cloned()
            .unwrap_or_default();
        self.out.fixtures.push(FixtureRecipe {
            symbol: id,
            node: NodeKey::of(node),
            span: tight_span(text, node),
            module,
            target,
            seeds,
        });
    }

    /// Check a `message` declaration: parameter signature (`E5009`) plus
    /// the ICU profile of its source and variants (`E5007`).
    fn check_message(&mut self, text: &str, module: ModuleId, node: &SyntaxNode) {
        let name = decl_name(text, node, &["export", "message"]);
        let id = name.and_then(|n| prod_symbol(self.tables, module, n));
        let Some(id) = id else { return };
        let SymbolKind::Message { params } = self.tables.symbols[id.0 as usize].kind.clone() else {
            return;
        };
        for param in &params {
            let ty = self.types.symbol_types.get(param).cloned();
            let Some(ty) = ty else { continue };
            if message_param_ok(&ty) {
                continue;
            }
            let span = self
                .tables
                .symbols
                .get(param.0 as usize)
                .map(|s| match &s.kind {
                    SymbolKind::Param { type_node, .. } => {
                        Span::new(type_node.file, type_node.start, type_node.end)
                    }
                    _ => tight_span(text, node),
                })
                .unwrap_or_else(|| tight_span(text, node));
            let what = self.tables.symbols[param.0 as usize].name.clone();
            self.diags.push(Diagnostic::error(
                "E5009",
                format!(
                    "message parameter '{what}' must be a nonnullable text, bool, enum, int, decimal, money, date or datetime value"
                ),
                span,
            ));
        }
        let mut arg_types: HashMap<String, IcuType> = HashMap::new();
        for param in &params {
            let name = self.tables.symbols[param.0 as usize].name.clone();
            if let Some(ty) = self.types.symbol_types.get(param) {
                arg_types.insert(name, IcuType::of(ty));
            }
        }
        for value in node
            .children
            .iter()
            .filter(|n| n.kind == SyntaxKind::MessageValue)
        {
            self.check_message_value(text, value, Some(&arg_types));
        }
    }

    /// Structural ICU validation of inline descriptors outside
    /// `message` declarations (labels, titles, cells, ...).
    fn check_inline_patterns(&mut self, text: &str, node: &SyntaxNode) {
        if node.kind == SyntaxKind::Message {
            return;
        }
        if node.kind == SyntaxKind::MessageValue {
            self.check_message_value(text, node, None);
            return;
        }
        for child in &node.children {
            self.check_inline_patterns(text, child);
        }
    }

    /// Validate the ICU profile of one descriptor's source and variants
    /// (`E5007`). `params` carries declared argument types for named
    /// messages; anonymous descriptors get structural checks only.
    fn check_message_value(
        &mut self,
        text: &str,
        node: &SyntaxNode,
        params: Option<&HashMap<String, IcuType>>,
    ) {
        if has_error(node) || subtree_has(node, SyntaxKind::BadToken) {
            return;
        }
        let parts = kids(node);
        let templates: Vec<(&SyntaxNode, Option<String>)> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Literal)
            .map(|n| (*n, literal_string(text, n)))
            .chain(
                parts
                    .iter()
                    .filter(|n| n.kind == SyntaxKind::MessageVariant)
                    .filter_map(|variant| {
                        let value = kids(variant)
                            .iter()
                            .find(|n| n.kind == SyntaxKind::Literal)
                            .copied()?;
                        let text_value = literal_string(text, value);
                        if text_value.is_none() && !is_null_literal(text, value) {
                            return None;
                        }
                        Some((value, text_value))
                    }),
            )
            .collect();
        for (literal, template) in templates {
            let Some(template) = template else {
                continue;
            };
            if let Some(problem) = icu_error(&template, params) {
                self.diags.push(Diagnostic::error(
                    "E5007",
                    format!("invalid message pattern: {problem}"),
                    tight_span(text, literal),
                ));
            }
        }
    }

    // --- Example blocks ------------------------------------------------

    /// Dispatch one `examples` block to the table or sequence checker.
    fn check_block(
        &mut self,
        text: &str,
        module: ModuleId,
        ctx: &OpCtx,
        owner: &SyntaxNode,
        node: &SyntaxNode,
    ) {
        let bindings = example_bindings(text, node);
        if kids(node).iter().any(|n| n.kind == SyntaxKind::DoBlock) {
            self.check_sequence(text, module, ctx, node, &bindings);
        } else {
            self.check_table(text, module, ctx, owner, node, &bindings);
        }
    }

    /// Check a table-form block: bindings, selectors, rows.
    #[allow(clippy::too_many_arguments)]
    fn check_table(
        &mut self,
        text: &str,
        module: ModuleId,
        ctx: &OpCtx,
        owner: &SyntaxNode,
        node: &SyntaxNode,
        bindings: &[(&str, Span, &SyntaxNode)],
    ) {
        let mut seeds = Vec::new();
        let mut bound: HashMap<String, &SyntaxNode> = HashMap::new();
        for (key, span, value) in bindings {
            if *key == "seed" {
                seeds = self.check_seed(module, text, value);
                continue;
            }
            if !binding_names_input(self.tables, ctx, key) {
                self.diags.push(Diagnostic::error(
                    "E5001",
                    format!("unknown example binding '{key}'"),
                    *span,
                ));
                continue;
            }
            bound.insert((*key).to_string(), *value);
            self.elide_header_case(text, ctx, key, value);
        }
        let rows: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::ExampleRow)
            .collect();
        let Some((header, rest)) = rows.split_first() else {
            return;
        };
        let (header_inputs, header_expected) = split_row(text, header);
        let mut input_sels: Vec<CheckedSelector> = Vec::new();
        let mut as_column: Option<usize> = None;
        for (index, input) in header_inputs.iter().enumerate() {
            let sel = self.check_input_selector(text, module, ctx, &bound, input);
            if sel.is_as && as_column.is_none() {
                as_column = Some(index);
            }
            input_sels.push(sel);
        }
        for expected in &header_expected {
            self.check_observation_root(text, ctx, expected);
        }
        self.check_overlap(&input_sels);
        self.check_table_coverage(text, ctx, owner, node, &bound, &input_sels);
        for row in rest {
            let (cells, _) = split_row(text, row);
            if let Some(expected) = expected_error_node(row) {
                self.check_expected_error(text, expected);
            }
            for (index, cell) in cells.iter().enumerate() {
                if Some(index) == as_column {
                    self.check_table_caller(text, module, cell);
                } else if is_error_call(text, cell) {
                    self.diags.push(Diagnostic::error(
                        "E5002",
                        "error(code) replaces the expected row, not an input".to_string(),
                        tight_span(text, cell),
                    ));
                }
            }
        }
        // Trusted handlers keep their verified source context: `as`
        // cannot impersonate a caller for them.
        if matches!(ctx, OpCtx::Scenario { trusted: true, .. })
            && let Some(sel) = input_sels.iter().find(|s| s.is_as)
        {
            self.diags.push(Diagnostic::error(
                "E5004",
                "examples of a trusted handler take no `as` caller".to_string(),
                sel.span,
            ));
        }
        let (operation, crud_op) = match ctx {
            OpCtx::Scenario { id, .. } => (Some(*id), None),
            OpCtx::Crud { model, op } => (self.crud_op_symbol(module, *model, *op), Some(*op)),
        };
        self.out.tables.push(BehaviorTable {
            node: NodeKey::of(node),
            span: tight_span(text, node),
            module,
            operation,
            crud_op,
            bindings: bound.keys().cloned().collect(),
            seeds,
            inputs: header_inputs
                .iter()
                .map(|n| tight_slice(text, n).to_string())
                .collect(),
            observations: header_expected
                .iter()
                .map(|n| tight_slice(text, n).to_string())
                .collect(),
            rows: rest.len(),
        });
    }

    /// Check a `seed=` value: a static list of fixture names (`E5001`).
    /// Unresolvable names are resolve's `E2001` and stay silent here.
    fn check_seed(&mut self, module: ModuleId, text: &str, value: &SyntaxNode) -> Vec<SymbolId> {
        if value.kind != SyntaxKind::Array {
            self.diags.push(Diagnostic::error(
                "E5001",
                "seed= takes a list of fixtures".to_string(),
                tight_span(text, value),
            ));
            return Vec::new();
        }
        let mut seeds = Vec::new();
        for element in kids(value) {
            if !is_expression(element.kind) {
                continue;
            }
            let Some(word) = nameref_word(text, element) else {
                self.diags.push(Diagnostic::error(
                    "E5001",
                    "seed= takes fixture names".to_string(),
                    tight_span(text, element),
                ));
                continue;
            };
            match test_symbol(self.tables, module, word) {
                Some(id)
                    if matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::Fixture { .. }
                    ) =>
                {
                    seeds.push(id);
                }
                _ if prod_scope_has(self.tables, module, word) => {
                    self.diags.push(Diagnostic::error(
                        "E5001",
                        format!("seed '{word}' is not a fixture"),
                        tight_span(text, element),
                    ));
                }
                _ if self.catalog.is_some_and(|c| {
                    c.is_builtin(word) || c.is_helper(word) || c.is_component(word)
                }) =>
                {
                    self.diags.push(Diagnostic::error(
                        "E5001",
                        format!("seed '{word}' is not a fixture"),
                        tight_span(text, element),
                    ));
                }
                // Unresolvable names are resolve's `E2001`.
                _ => {}
            }
        }
        seeds
    }

    /// Retract the earlier `E2001` when a header binding value elides as
    /// an enum case (G4).
    ///
    /// The types pass checks header values without an expectation, so a
    /// bare case never gets claimed there and `emit_unresolved` (which
    /// runs before this pass) misfires on it. This retracts exactly that
    /// finding, mirroring `type_nameref` claiming case-for-case:
    /// lexical bindings first (a bound name is never a case), otherwise
    /// a bare case of the binding's uniquely expected enum type.
    /// Anything else keeps its `E2001`, exactly as in fixture values.
    fn elide_header_case(&mut self, text: &str, ctx: &OpCtx, key: &str, value: &SyntaxNode) {
        let mut target = value;
        while target.kind == SyntaxKind::Group {
            let Some(inner) = kids(target).into_iter().find(|n| is_expression(n.kind)) else {
                return;
            };
            target = inner;
        }
        if target.kind != SyntaxKind::NameRef {
            return;
        }
        let Some(word) = nameref_word(text, target) else {
            return;
        };
        let Some(expected) = self.header_expected_type(ctx, key) else {
            return;
        };
        let Some(cases) = enum_cases(&expected) else {
            return;
        };
        if !cases.iter().any(|c| c == word) {
            return;
        }
        if self.tables.node_binding.contains_key(&NodeKey::of(target)) {
            return;
        }
        let span = tight_span(text, target);
        let plain = format!("unresolved name '{word}'");
        let hinted = format!("{plain};");
        self.diags.retain(|d| {
            !(d.code == "E2001"
                && d.primary == span
                && (d.message == plain || d.message.starts_with(&hinted)))
        });
    }

    /// Expected type of a header binding: a scenario parameter type or
    /// a generated-create field type. Record, envelope and opaque
    /// bindings carry no elidable expectation.
    fn header_expected_type(&self, ctx: &OpCtx, key: &str) -> Option<ResolvedType> {
        match ctx {
            OpCtx::Scenario { params, .. } => params
                .iter()
                .find(|p| self.tables.symbols[p.0 as usize].name == key)
                .and_then(|p| self.types.symbol_types.get(p).cloned()),
            OpCtx::Crud { model, op } => match op {
                CrudOp::Create => self
                    .model_field_named(*model, key)
                    .and_then(|f| self.types.symbol_types.get(&f).cloned()),
                CrudOp::Update | CrudOp::Delete => None,
            },
        }
    }

    // --- Table selectors -------------------------------------------------

    /// Check one input header selector (`E5002`/`E5008`).
    fn check_input_selector(
        &mut self,
        text: &str,
        module: ModuleId,
        ctx: &OpCtx,
        bound: &HashMap<String, &SyntaxNode>,
        input: &SyntaxNode,
    ) -> CheckedSelector {
        let span = tight_span(text, input);
        let failed = || CheckedSelector::failed(span);
        if is_error_call(text, input) {
            self.diags.push(Diagnostic::error(
                "E5002",
                "error(code) replaces the expected row, not an input".to_string(),
                span,
            ));
            return failed();
        }
        let Some(sel) = parse_selector(text, input) else {
            self.diags.push(Diagnostic::error(
                "E5002",
                "example inputs must be selectors over declared inputs".to_string(),
                span,
            ));
            return failed();
        };
        if sel.optional {
            self.diags.push(Diagnostic::error(
                "E5002",
                "example selectors use plain member access".to_string(),
                span,
            ));
            return failed();
        }
        if sel.root == "as" {
            if !sel.path.is_empty() {
                self.diags.push(Diagnostic::error(
                    "E5002",
                    "`as` selects the caller and takes no path".to_string(),
                    span,
                ));
                return failed();
            }
            return CheckedSelector::as_column(span);
        }
        let Some(root) = self.resolve_selector_root(text, module, ctx, bound, &sel, span) else {
            return failed();
        };
        self.check_selector_path(text, ctx, &sel, &root, span)
    }

    /// Resolve an input selector root to its channel and identity.
    fn resolve_selector_root(
        &mut self,
        text: &str,
        module: ModuleId,
        ctx: &OpCtx,
        bound: &HashMap<String, &SyntaxNode>,
        sel: &Selector,
        span: Span,
    ) -> Option<SelRoot> {
        if let OpCtx::Scenario {
            params, trusted, ..
        } = ctx
        {
            if let Some(param) = params
                .iter()
                .find(|p| self.tables.symbols[p.0 as usize].name == sel.root)
                .copied()
            {
                let fixture = bound
                    .get(&sel.root)
                    .and_then(|value| binding_fixture(self.tables, module, text, value));
                return Some(SelRoot::Param { param, fixture });
            }
            if *trusted && sel.root == "event" {
                return Some(SelRoot::Event);
            }
        }
        if let OpCtx::Crud { model, op } = ctx {
            match sel.root.as_str() {
                "record" if matches!(op, CrudOp::Update | CrudOp::Delete) => {
                    return Some(SelRoot::Record {
                        model: *model,
                        changes: false,
                    });
                }
                "changes" if matches!(op, CrudOp::Update) => {
                    return Some(SelRoot::Record {
                        model: *model,
                        changes: true,
                    });
                }
                "record" | "changes" => {
                    self.diags.push(Diagnostic::error(
                        "E5002",
                        format!("'{}' is not an input here", sel.root),
                        span,
                    ));
                    return None;
                }
                _ => {}
            }
            if matches!(op, CrudOp::Create) {
                if let Some(field) = self.model_field_named(*model, &sel.root) {
                    return Some(SelRoot::CreateField(field));
                }
                if sel.root == "parent"
                    && let SymbolKind::Model { owner, .. } =
                        &self.tables.symbols[model.0 as usize].kind
                    && let ModelOwner::ChildOf(parent) = owner
                {
                    return Some(SelRoot::CreateParent(*parent));
                }
            }
        }
        if let Some(value) = bound.get(&sel.root) {
            return Some(SelRoot::Binding(binding_fixture(
                self.tables,
                module,
                text,
                value,
            )));
        }
        if let Some(id) = test_symbol(self.tables, module, &sel.root)
            && let SymbolKind::Fixture { .. } = &self.tables.symbols[id.0 as usize].kind
        {
            return Some(SelRoot::Fixture(id));
        }
        if sel.root == "request" {
            return Some(SelRoot::Request);
        }
        if sel.root == "result" {
            self.diags.push(Diagnostic::error(
                "E5002",
                "`result` is observable, not an input".to_string(),
                span,
            ));
            return None;
        }
        if matches!(sel.root.as_str(), "self" | "other" | "outsider") {
            self.diags.push(Diagnostic::error(
                "E5002",
                format!("'{}' is a test account, not an input selector", sel.root),
                span,
            ));
            return None;
        }
        // Import leniency covers only genuinely unresolvable names
        // (resolve's E2004/E2005); a name that resolves to the wrong
        // kind falls through to E5002 like a local one.
        if is_imported(&self.imports, module, &sel.root)
            && prod_symbol(self.tables, module, &sel.root).is_none()
        {
            return Some(SelRoot::Opaque);
        }
        self.diags.push(Diagnostic::error(
            "E5002",
            format!("unknown example selector '{}'", selector_spelling(sel)),
            span,
        ));
        None
    }

    /// Check a selector path against its root (`E5002`/`E5008`).
    fn check_selector_path(
        &mut self,
        text: &str,
        ctx: &OpCtx,
        sel: &Selector,
        root: &SelRoot,
        span: Span,
    ) -> CheckedSelector {
        let spans = selector_spans(text, sel.node);
        let seg_span = |index: usize| spans.get(index + 1).copied().unwrap_or(span);
        match root {
            SelRoot::Request => {
                return self.check_request_selector(text, ctx, sel, span);
            }
            SelRoot::Fixture(id) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Fixture {
                    target: FixtureTarget::User | FixtureTarget::File,
                } if !sel.path.is_empty() => {
                    self.diags.push(Diagnostic::error(
                        "E5008",
                        "user and file recipes are immutable and take no selector path".to_string(),
                        span,
                    ));
                    return CheckedSelector::failed(span);
                }
                SymbolKind::Fixture {
                    target: FixtureTarget::Operation(_),
                } => {
                    return self.check_recipe_selector(sel, span, *id);
                }
                _ => {}
            },
            _ => {}
        }
        let base = self.selector_base_type(ctx, root);
        let mut current = base;
        for (index, segment) in sel.path.iter().enumerate() {
            // Declared payload leaves first: a field the resolved
            // (non-stored) provenance declares shadows same-spelled
            // reserved metadata (T35/R24; T08 ordering precedent).
            // Stored records never resolve here, so identity/audit
            // protection below still fires for them.
            if let Some(next) = self.payload_leaf(&current, segment) {
                current = Some(next);
                continue;
            }
            if is_reserved_name(segment) {
                self.diags.push(Diagnostic::error(
                    "E5008",
                    format!("'{segment}' is reserved metadata and cannot be overridden"),
                    seg_span(index),
                ));
                return CheckedSelector::failed(span);
            }
            if segment == "parent" {
                match self.parent_step(&mut current, index + 1 == sel.path.len(), seg_span(index)) {
                    ParentStep::Done => continue,
                    ParentStep::Abort => return CheckedSelector::failed(span),
                    ParentStep::Fallthrough => {}
                }
            }
            let Some(ty) = current else {
                continue;
            };
            let inner = nullable_inner(&ty).cloned().unwrap_or(ty);
            // Completion envelopes navigate their declared leaves
            // (T35/R24); unknown leaves fail like unknown fields.
            if let ResolvedType::Object(fields) = &inner {
                match fields.iter().find(|(name, _)| name == segment) {
                    Some((_, ty)) => {
                        current = Some(ty.clone());
                        continue;
                    }
                    None => {
                        self.diags.push(Diagnostic::error(
                            "E5002",
                            format!("unknown field '{segment}' on event envelope"),
                            seg_span(index),
                        ));
                        return CheckedSelector::failed(span);
                    }
                }
            }
            let ResolvedType::Record { symbol, .. } = inner else {
                // Opaque/unknown/error bases cannot be navigated
                // statically; the runner owns those values.
                if navigable_unknown(&inner) {
                    current = None;
                    continue;
                }
                self.diags.push(Diagnostic::error(
                    "E5002",
                    format!("'{}' has no fields", sel.root),
                    seg_span(index),
                ));
                return CheckedSelector::failed(span);
            };
            match self.model_field_named(symbol, segment) {
                Some(field) => {
                    current = self.types.symbol_types.get(&field).cloned();
                }
                None => {
                    let owner = &self.tables.symbols[symbol.0 as usize];
                    self.diags.push(Diagnostic::error(
                        "E5002",
                        format!("unknown field '{segment}' on {}", owner.name),
                        seg_span(index),
                    ));
                    return CheckedSelector::failed(span);
                }
            }
        }
        let coverage = match root {
            SelRoot::Param { .. }
            | SelRoot::Binding(_)
            | SelRoot::Record { .. }
            | SelRoot::CreateField(_)
            | SelRoot::CreateParent(_) => Some(sel.root.as_str()),
            SelRoot::Fixture(_) | SelRoot::Request | SelRoot::Event | SelRoot::Opaque => None,
        };
        CheckedSelector::ok(span, coverage, overlap_key(root, sel))
    }

    /// Check a `request.*` envelope selector.
    fn check_request_selector(
        &mut self,
        text: &str,
        ctx: &OpCtx,
        sel: &Selector,
        span: Span,
    ) -> CheckedSelector {
        let spans = selector_spans(text, sel.node);
        let seg_span = |index: usize| spans.get(index + 1).copied().unwrap_or(span);
        let Some(first) = sel.path.first() else {
            self.diags.push(Diagnostic::error(
                "E5002",
                "`request` overrides a declared input envelope".to_string(),
                span,
            ));
            return CheckedSelector::failed(span);
        };
        if !request_input_named(self.tables, ctx, first) {
            self.diags.push(Diagnostic::error(
                "E5002",
                format!("unknown request input '{first}'"),
                seg_span(0),
            ));
            return CheckedSelector::failed(span);
        }
        if sel.path.len() > 2 || (sel.path.len() == 2 && sel.path[1] != "version") {
            self.diags.push(Diagnostic::error(
                "E5002",
                "request overrides a declared input or its submitted version".to_string(),
                seg_span(1),
            ));
            return CheckedSelector::failed(span);
        }
        CheckedSelector::ok(
            span,
            None,
            OverlapKey {
                channel: OverlapChannel::Request,
                root: sel.path.join("."),
                path: sel.path.clone(),
            },
        )
    }

    /// Check selectors over an operation-resolved delivery recipe: the
    /// whole `status`/`result`/`error` only, never descendant patches.
    fn check_recipe_selector(
        &mut self,
        sel: &Selector,
        span: Span,
        id: SymbolId,
    ) -> CheckedSelector {
        if sel.path.len() > 1 {
            self.diags.push(Diagnostic::error(
                "E5008",
                "delivery recipes vary only their whole status, result or error".to_string(),
                span,
            ));
            return CheckedSelector::failed(span);
        }
        if sel.path.len() == 1 && !matches!(sel.path[0].as_str(), "status" | "result" | "error") {
            self.diags.push(Diagnostic::error(
                "E5002",
                format!("unknown delivery recipe selector '{}'", sel.path[0]),
                span,
            ));
            return CheckedSelector::failed(span);
        }
        CheckedSelector::ok(
            span,
            None,
            OverlapKey {
                channel: OverlapChannel::State,
                root: format!("fixture{}", id.0),
                path: sel.path.clone(),
            },
        )
    }

    /// Step a `parent` segment: the containing record of a contained
    /// model mid-path, server-owned (`E5008`) at the leaf, and an
    /// ordinary unknown field elsewhere.
    fn parent_step(
        &mut self,
        current: &mut Option<ResolvedType>,
        last: bool,
        span: Span,
    ) -> ParentStep {
        let Some(ty) = current.clone() else {
            return ParentStep::Done;
        };
        let inner = nullable_inner(&ty).cloned().unwrap_or(ty);
        let contained = match &inner {
            ResolvedType::Record { symbol, .. } => {
                match &self.tables.symbols[symbol.0 as usize].kind {
                    SymbolKind::Model {
                        owner: ModelOwner::ChildOf(parent),
                        ..
                    } => Some(*parent),
                    _ => None,
                }
            }
            _ => None,
        };
        match (contained, last) {
            (Some(parent), false) => {
                *current = Some(ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                });
                ParentStep::Done
            }
            (Some(_), true) => {
                self.diags.push(Diagnostic::error(
                    "E5008",
                    "'parent' is server-owned and cannot be overridden".to_string(),
                    span,
                ));
                ParentStep::Abort
            }
            (None, _) if navigable_unknown(&inner) => {
                *current = None;
                ParentStep::Done
            }
            (None, _) => ParentStep::Fallthrough,
        }
    }

    /// Declared payload leaf of the current provenance, if it
    /// resolves to one (T35/R24): a declared field of a value
    /// nominal (contract/event/preferences — never carriers of
    /// reserved record metadata) or envelope object, mirroring
    /// the expression-lookup rule (declared fields first;
    /// reserved metadata only on stored models). Models return
    /// `None` so identity/audit protection below still fires.
    fn payload_leaf(&self, current: &Option<ResolvedType>, segment: &str) -> Option<ResolvedType> {
        let inner = match current.as_ref()? {
            ResolvedType::Nullable(inner) => inner.as_ref(),
            other => other,
        };
        match inner {
            ResolvedType::Record { symbol, .. } => {
                match &self.tables.symbols[symbol.0 as usize].kind {
                    SymbolKind::Contract { .. }
                    | SymbolKind::Event { .. }
                    | SymbolKind::Preferences { .. } => {
                        let field = self.model_field_named(*symbol, segment)?;
                        self.types.symbol_types.get(&field).cloned()
                    }
                    _ => None,
                }
            }
            ResolvedType::Object(fields) => fields
                .iter()
                .find(|(name, _)| name == segment)
                .map(|(_, ty)| ty.clone()),
            _ => None,
        }
    }

    /// Base type a selector root navigates from, if statically known.
    fn selector_base_type(&self, ctx: &OpCtx, root: &SelRoot) -> Option<ResolvedType> {
        match root {
            SelRoot::Param { param, .. } => self.types.symbol_types.get(param).cloned(),
            SelRoot::Binding(Some(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Fixture {
                    target: FixtureTarget::Model(model),
                } => Some(ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                }),
                _ => None,
            },
            SelRoot::Binding(None) => None,
            SelRoot::Fixture(id) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Fixture {
                    target: FixtureTarget::Model(model),
                } => Some(ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                }),
                _ => None,
            },
            SelRoot::Record { model, .. } => Some(ResolvedType::Record {
                symbol: *model,
                stored: true,
            }),
            SelRoot::CreateField(field) => self.types.symbol_types.get(field).cloned(),
            SelRoot::CreateParent(parent) => Some(ResolvedType::Record {
                symbol: *parent,
                stored: true,
            }),
            SelRoot::Event => match ctx {
                OpCtx::Scenario { event, .. } => event.clone(),
                OpCtx::Crud { .. } => None,
            },
            SelRoot::Request | SelRoot::Opaque => None,
        }
    }

    /// Check one observation (expected-side) header root (`E5002`).
    /// Observations are otherwise runner-typed expressions.
    fn check_observation_root(&mut self, text: &str, ctx: &OpCtx, expected: &SyntaxNode) {
        if expected.kind == SyntaxKind::ExpectedError {
            return;
        }
        let path = match expected.kind {
            SyntaxKind::NameRef | SyntaxKind::Member => member_names(text, expected),
            _ => return,
        };
        let Some(root) = path.first() else { return };
        let span = tight_span(text, expected);
        match root.as_str() {
            "changes" | "request" => {
                self.diags.push(Diagnostic::error(
                    "E5002",
                    format!("'{root}' is an input, not an observation"),
                    span,
                ));
            }
            "as" => {
                self.diags.push(Diagnostic::error(
                    "E5002",
                    "`as` selects the caller and is not observable".to_string(),
                    span,
                ));
            }
            "result" => {
                let void = matches!(
                    ctx,
                    OpCtx::Scenario {
                        has_result: false,
                        ..
                    }
                );
                if void {
                    self.diags.push(Diagnostic::error(
                        "E5002",
                        "`result` needs an operation with a declared result".to_string(),
                        span,
                    ));
                }
            }
            _ => {}
        }
    }

    /// Check input-header selectors for duplicate/overlapping initial
    /// state (`E5003`). `request.*` is a separate envelope channel and
    /// never conflicts with state; failed selectors stay silent.
    fn check_overlap(&mut self, selectors: &[CheckedSelector]) {
        for (index, sel) in selectors.iter().enumerate() {
            let Some(key) = &sel.overlap else {
                continue;
            };
            for earlier in selectors
                .iter()
                .take(index)
                .filter_map(|s| s.overlap.as_ref())
            {
                if earlier.channel != key.channel || earlier.root != key.root {
                    continue;
                }
                if earlier.path == key.path {
                    self.diags.push(Diagnostic::error(
                        "E5003",
                        "duplicate example selector".to_string(),
                        sel.span,
                    ));
                    break;
                }
                if paths_overlap(&earlier.path, &key.path) {
                    self.diags.push(Diagnostic::error(
                        "E5003",
                        "example selectors assign overlapping state".to_string(),
                        sel.span,
                    ));
                    break;
                }
            }
        }
    }

    /// Check that common bindings plus row selectors supply every
    /// required operation input (`E5001`).
    fn check_table_coverage(
        &mut self,
        text: &str,
        ctx: &OpCtx,
        owner: &SyntaxNode,
        node: &SyntaxNode,
        bound: &HashMap<String, &SyntaxNode>,
        selectors: &[CheckedSelector],
    ) {
        let roots: HashSet<&str> = selectors
            .iter()
            .filter(|s| s.overlap.is_some() || s.is_as)
            .filter_map(|s| s.root.as_deref())
            .collect();
        let header_span = examples_keyword(text, node);
        match ctx {
            OpCtx::Scenario { params, .. } => {
                let defaults = param_defaults(text, owner);
                for param in params {
                    let name = self.tables.symbols[param.0 as usize].name.clone();
                    if bound.contains_key(&name) || roots.contains(name.as_str()) {
                        continue;
                    }
                    if defaults.contains(&name) {
                        continue;
                    }
                    let nullable = self
                        .types
                        .symbol_types
                        .get(param)
                        .is_some_and(|ty| matches!(ty, ResolvedType::Nullable(_)));
                    if nullable {
                        continue;
                    }
                    if !self.types.symbol_types.contains_key(param) {
                        continue;
                    }
                    self.diags.push(Diagnostic::error(
                        "E5001",
                        format!("example is missing required input '{name}'"),
                        header_span,
                    ));
                }
            }
            OpCtx::Crud { model, op } => match op {
                CrudOp::Update => {
                    let record = bound.contains_key("record") || roots.contains("record");
                    let changes = bound.contains_key("changes") || roots.contains("changes");
                    if !record {
                        self.diags.push(Diagnostic::error(
                            "E5001",
                            "update examples need the record under test".to_string(),
                            header_span,
                        ));
                    }
                    if !changes {
                        self.diags.push(Diagnostic::error(
                            "E5001",
                            "update examples need submitted changes".to_string(),
                            header_span,
                        ));
                    }
                }
                CrudOp::Delete => {
                    if !(bound.contains_key("record") || roots.contains("record")) {
                        self.diags.push(Diagnostic::error(
                            "E5001",
                            "delete examples need the record under test".to_string(),
                            header_span,
                        ));
                    }
                }
                CrudOp::Create => {
                    for field in self.required_create_fields(*model) {
                        if bound.contains_key(&field) || roots.contains(field.as_str()) {
                            continue;
                        }
                        self.diags.push(Diagnostic::error(
                            "E5001",
                            format!("example is missing required input '{field}'"),
                            header_span,
                        ));
                    }
                }
            },
        }
    }

    /// Required writable inputs of a generated create: required model
    /// fields plus `parent` for contained models. Derived fields are
    /// computed, never required (mirrors `field_is_required`).
    fn required_create_fields(&self, model: SymbolId) -> Vec<String> {
        let mut required = Vec::new();
        if let SymbolKind::Model { owner, .. } = &self.tables.symbols[model.0 as usize].kind
            && matches!(owner, ModelOwner::ChildOf(_))
        {
            required.push("parent".to_string());
        }
        let optional = self
            .nodes
            .get(&model)
            .map(|node| field_optionals(self.db, node))
            .unwrap_or_default();
        for field in model_field_ids(self.tables, model) {
            if matches!(
                self.tables.symbols[field.0 as usize].kind,
                SymbolKind::DeriveField { .. }
            ) {
                continue;
            }
            let name = self.tables.symbols[field.0 as usize].name.clone();
            if optional.contains(&name) {
                continue;
            }
            let Some(ty) = self.types.symbol_types.get(&field) else {
                continue;
            };
            if matches!(ty, ResolvedType::Nullable(_)) {
                continue;
            }
            required.push(name);
        }
        required
    }

    /// Check one `as`-column caller cell (`E5004`).
    fn check_table_caller(&mut self, text: &str, module: ModuleId, cell: &SyntaxNode) {
        let span = tight_span(text, cell);
        if cell.kind == SyntaxKind::Array {
            for element in kids(cell) {
                if !is_expression(element.kind) {
                    continue;
                }
                let Some(word) = nameref_word(text, element) else {
                    self.diags.push(Diagnostic::error(
                        "E5004",
                        "`as` roles take static role names".to_string(),
                        tight_span(text, element),
                    ));
                    continue;
                };
                self.check_role_cell(module, word, tight_span(text, element));
            }
            return;
        }
        let Some(word) = nameref_word(text, cell) else {
            self.diags.push(Diagnostic::error(
                "E5004",
                "`as` selects a test account, a role or a user fixture".to_string(),
                span,
            ));
            return;
        };
        if matches!(word, "self" | "other" | "outsider" | "public") {
            return;
        }
        if word == "authenticated" {
            self.diags.push(Diagnostic::error(
                "E5004",
                "`authenticated` is a predicate, not a caller".to_string(),
                span,
            ));
            return;
        }
        if let Some(id) = test_symbol(self.tables, module, word) {
            match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Fixture {
                    target: FixtureTarget::User,
                } => return,
                SymbolKind::Fixture { .. } => {
                    self.diags.push(Diagnostic::error(
                        "E5004",
                        format!("only user fixtures select callers, not '{word}'"),
                        span,
                    ));
                    return;
                }
                _ => {}
            }
        }
        match prod_symbol_kind(self.tables, module, word) {
            Some(Kind::Role) | Some(Kind::OwnerWord) => {}
            Some(_) => {
                self.diags.push(Diagnostic::error(
                    "E5004",
                    format!("'{word}' cannot select a caller"),
                    span,
                ));
            }
            None if is_imported(&self.imports, module, word) => {}
            None => {
                self.diags.push(Diagnostic::error(
                    "E5004",
                    format!("unknown caller '{word}'"),
                    span,
                ));
            }
        }
    }

    /// Check one role-array member: a role, `owner` or `members` —
    /// never a user identity (`E5004`).
    fn check_role_cell(&mut self, module: ModuleId, word: &str, span: Span) {
        if matches!(
            word,
            "self" | "other" | "outsider" | "public" | "authenticated"
        ) {
            self.diags.push(Diagnostic::error(
                "E5004",
                format!("role arrays take roles, not '{word}'"),
                span,
            ));
            return;
        }
        if test_symbol(self.tables, module, word).is_some() {
            self.diags.push(Diagnostic::error(
                "E5004",
                "role arrays take roles, not user fixtures".to_string(),
                span,
            ));
            return;
        }
        match prod_symbol_kind(self.tables, module, word) {
            Some(Kind::Role) | Some(Kind::OwnerWord) => {}
            None if is_imported(&self.imports, module, word) => {}
            Some(_) | None => {
                self.diags.push(Diagnostic::error(
                    "E5004",
                    format!("unknown role '{word}'"),
                    span,
                ));
            }
        }
    }

    /// Check one `error(code)` expectation against the closed business
    /// vocabulary (`E5005`).
    fn check_expected_error(&mut self, text: &str, node: &SyntaxNode) {
        let call = kids(node).into_iter().find(|n| n.kind == SyntaxKind::Call);
        let arg = call.and_then(|call| {
            kids(call)
                .into_iter()
                .find(|n| n.kind == SyntaxKind::Argument)
                .and_then(|arg| kids(arg).into_iter().find(|n| is_expression(n.kind)))
        });
        let word = arg.and_then(|arg| nameref_word(text, arg));
        let span = arg
            .map(|a| tight_span(text, a))
            .unwrap_or_else(|| tight_span(text, node));
        match word {
            Some(code) if ERROR_CODES.contains(&code) => {}
            Some(code) => {
                self.diags.push(Diagnostic::error(
                    "E5005",
                    format!("unknown business error '{code}'"),
                    span,
                ));
            }
            None => {
                self.diags.push(Diagnostic::error(
                    "E5005",
                    "error(code) takes one business error code".to_string(),
                    span,
                ));
            }
        }
    }

    // --- Sequences -----------------------------------------------------

    /// Check a sequence-form block: seed-only header, calls, assertions.
    fn check_sequence(
        &mut self,
        text: &str,
        module: ModuleId,
        ctx: &OpCtx,
        node: &SyntaxNode,
        bindings: &[(&str, Span, &SyntaxNode)],
    ) {
        let mut seeds = Vec::new();
        for (key, span, value) in bindings {
            if *key != "seed" {
                self.diags.push(Diagnostic::error(
                    "E5001",
                    "sequence examples accept only seed on the header".to_string(),
                    *span,
                ));
                continue;
            }
            seeds = self.check_seed(module, text, value);
        }
        let body = kids(node)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::DoBlock);
        let Some(body) = body else { return };
        let mut state = SequenceState::default();
        for step in kids(body) {
            match step.kind {
                SyntaxKind::Let => self.check_sequence_let(text, step, &mut state),
                SyntaxKind::ExampleCall => {
                    self.check_sequence_call(text, module, step, &mut state);
                }
                SyntaxKind::ExampleAssert => {
                    self.check_sequence_assert(text, step, &mut state);
                }
                _ => {}
            }
        }
        // The sequence must exercise its enclosing scenario at least
        // once; the parser only requires one call in total.
        if let OpCtx::Scenario { id, .. } = ctx
            && !state.called.contains(id)
        {
            self.diags.push(Diagnostic::error(
                "E5006",
                "example sequences must call their enclosing scenario".to_string(),
                examples_keyword(text, node),
            ));
        }
        let operation = match ctx {
            OpCtx::Scenario { id, .. } => Some(*id),
            OpCtx::Crud { .. } => None,
        };
        self.out.sequences.push(ExampleSequence {
            node: NodeKey::of(node),
            span: tight_span(text, node),
            module,
            operation,
            seeds,
            calls: state.calls,
            assertions: state.assertions,
        });
    }

    /// Check a sequence `let`: collect its binding, watch `result` uses.
    fn check_sequence_let(&mut self, text: &str, node: &SyntaxNode, state: &mut SequenceState) {
        let mut name = None;
        let mut value = None;
        for part in kids(node) {
            if name.is_none()
                && let Some(word) = name_text(part, text)
                && word != "let"
            {
                name = Some((word.to_string(), tight_span(text, part)));
            } else if value.is_none() && is_expression(part.kind) {
                value = Some(part);
            }
        }
        if let Some((word, span)) = name
            && !state.names.insert(word.clone())
        {
            self.diags.push(Diagnostic::error(
                "E5006",
                format!("duplicate sequence binding '{word}'"),
                span,
            ));
        }
        if let Some(value) = value
            && !state.result_available
            && expr_uses_root(text, value, "result")
        {
            self.diags.push(Diagnostic::error(
                "E5006",
                "`result` needs a preceding successful call with a result".to_string(),
                tight_span(text, value),
            ));
        }
    }

    /// Check one sequence test call (`E5004`/`E5005`/`E5006`).
    fn check_sequence_call(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        state: &mut SequenceState,
    ) {
        let parts = kids(node);
        let target = parts.iter().find(|n| is_expression(n.kind)).copied();
        let mut caller = None;
        let mut request = None;
        let mut bound_as = None;
        let mut index = 0;
        while index < parts.len() {
            if is_name(parts[index], text, "by") {
                caller = parts[index + 1..]
                    .iter()
                    .find(|n| n.kind == SyntaxKind::Path)
                    .copied();
            } else if is_name(parts[index], text, "request") {
                request = parts[index + 1..]
                    .iter()
                    .find(|n| n.kind == SyntaxKind::Object)
                    .copied();
            } else if is_name(parts[index], text, "as") {
                bound_as = parts[index + 1..]
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .map(|w| {
                        let span = parts[index + 1..]
                            .iter()
                            .find(|n| name_text(n, text).is_some())
                            .map(|n| tight_span(text, n))
                            .unwrap_or_else(|| tight_span(text, node));
                        (w.to_string(), span)
                    });
            }
            index += 1;
        }
        let args = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let expects_error = parts.iter().any(|n| n.kind == SyntaxKind::ExpectedError);
        let resolved = target.and_then(|t| self.resolve_call_target(text, module, t));
        if let Some(id) = resolved {
            state.called.insert(id);
        }
        if let Some(path) = caller {
            self.check_sequence_caller(text, module, path);
        }
        if let (Some(op), Some(args)) = (resolved, args) {
            self.check_call_args(text, op, args);
            if let Some(request) = request {
                self.check_call_request(text, op, request);
            }
        }
        if let Some((word, span)) = bound_as {
            if !state.names.insert(word.clone()) {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("duplicate sequence binding '{word}'"),
                    span,
                ));
            }
            let has_result = resolved.is_some_and(|op| self.op_has_result(op));
            if !has_result {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    "`as` needs an operation with a declared result".to_string(),
                    span,
                ));
            }
        }
        if expects_error {
            state.result_available = false;
            state.assertions += 1;
            if let Some(expected) = parts.iter().find(|n| n.kind == SyntaxKind::ExpectedError) {
                self.check_expected_error(text, expected);
            }
        } else if let Some(op) = resolved {
            state.result_available = self.op_has_result(op);
        }
        state.calls.push(SequenceCall {
            node: NodeKey::of(node),
            span: tight_span(text, node),
            target: resolved,
            caller: caller
                .map(|c| tight_slice(text, c).to_string())
                .unwrap_or_default(),
            expects_error,
        });
    }

    /// Resolve a sequence call target to a user scenario or an enabled
    /// generated CRUD operation (`E5006`).
    fn resolve_call_target(
        &mut self,
        text: &str,
        module: ModuleId,
        target: &SyntaxNode,
    ) -> Option<SymbolId> {
        let span = tight_span(text, target);
        if target.kind == SyntaxKind::NameRef {
            let word = nameref_word(text, target).unwrap_or("");
            let id = prod_symbol(self.tables, module, word);
            let Some(id) = id else {
                if is_imported(&self.imports, module, word) {
                    return None;
                }
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("unknown operation '{word}'"),
                    span,
                ));
                return None;
            };
            match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Scenario { trusted, .. } if !trusted => return Some(id),
                SymbolKind::Scenario { .. } => {
                    self.diags.push(Diagnostic::error(
                        "E5006",
                        "trusted handlers cannot be invoked here".to_string(),
                        span,
                    ));
                    return None;
                }
                SymbolKind::Capability { .. } | SymbolKind::CapabilityOp { .. } => {
                    self.diags.push(Diagnostic::error(
                        "E5006",
                        "bound services cannot be invoked directly here".to_string(),
                        span,
                    ));
                    return None;
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E5006",
                        format!("'{word}' is not an invocable operation"),
                        span,
                    ));
                    return None;
                }
            }
        }
        if target.kind == SyntaxKind::Member {
            let names = member_names(text, target);
            if names.len() != 2 {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    "CRUD calls name Model.operation".to_string(),
                    span,
                ));
                return None;
            }
            let model = prod_symbol(self.tables, module, &names[0]).filter(|id| {
                matches!(
                    self.tables.symbols[id.0 as usize].kind,
                    SymbolKind::Model { .. }
                )
            });
            let Some(model) = model else {
                // Import leniency covers only genuinely unresolvable
                // heads (resolve's E2004/E2005); a head that resolves
                // to a non-model falls through to E5006 like a local one.
                if is_imported(&self.imports, module, &names[0])
                    && prod_symbol(self.tables, module, &names[0]).is_none()
                {
                    return None;
                }
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("unknown model '{}'", names[0]),
                    span,
                ));
                return None;
            };
            let op = match names[1].as_str() {
                "create" => CrudOp::Create,
                "update" => CrudOp::Update,
                "delete" => CrudOp::Delete,
                other => {
                    self.diags.push(Diagnostic::error(
                        "E5006",
                        format!("unknown CRUD operation '{other}'"),
                        span,
                    ));
                    return None;
                }
            };
            match self.crud_op_symbol(module, model, op) {
                Some(id) => return Some(id),
                None => {
                    self.diags.push(Diagnostic::error(
                        "E5006",
                        format!("'{}.{}' is not enabled", names[0], op.as_str()),
                        span,
                    ));
                    return None;
                }
            }
        }
        self.diags.push(Diagnostic::error(
            "E5006",
            "sequence calls name a scenario or Model.operation".to_string(),
            span,
        ));
        None
    }

    /// Check a sequence `by=` caller: a test account or a named user
    /// fixture — never roles (`E5004`).
    fn check_sequence_caller(&mut self, text: &str, module: ModuleId, caller: &SyntaxNode) {
        let segments = super::path_segments(caller, text);
        let span = tight_span(text, caller);
        if segments.len() != 1 {
            self.diags.push(Diagnostic::error(
                "E5004",
                "sequence callers name one test account or user fixture".to_string(),
                span,
            ));
            return;
        }
        let word = segments[0];
        if matches!(word, "self" | "other" | "outsider" | "public") {
            return;
        }
        if let Some(id) = test_symbol(self.tables, module, word) {
            match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Fixture {
                    target: FixtureTarget::User,
                } => return,
                SymbolKind::Fixture { .. } => {
                    self.diags.push(Diagnostic::error(
                        "E5004",
                        format!("only user fixtures select callers, not '{word}'"),
                        span,
                    ));
                    return;
                }
                _ => {}
            }
        }
        if matches!(word, "owner" | "members" | "authenticated")
            || matches!(
                prod_symbol_kind(self.tables, module, word),
                Some(Kind::Role)
            )
        {
            self.diags.push(Diagnostic::error(
                "E5004",
                "sequence callers take test accounts or user fixtures, not roles".to_string(),
                span,
            ));
            return;
        }
        // Import leniency covers only genuinely unresolvable names
        // (resolve's E2004/E2005). A resolved production name of the
        // wrong kind is a known name misused, not an unknown caller.
        match prod_symbol_kind(self.tables, module, word) {
            Some(_) => {
                self.diags.push(Diagnostic::error(
                    "E5004",
                    format!("'{word}' cannot select a caller"),
                    span,
                ));
            }
            None if is_imported(&self.imports, module, word) => {}
            None => {
                self.diags.push(Diagnostic::error(
                    "E5004",
                    format!("unknown caller '{word}'"),
                    span,
                ));
            }
        }
    }

    /// Check sequence call arguments: known inputs plus required
    /// coverage (`E5006`). Values stay runner-typed.
    fn check_call_args(&mut self, text: &str, op: SymbolId, args: &SyntaxNode) {
        let entries = object_entries(text, args);
        let mut seen: HashSet<String> = HashSet::new();
        for (key, key_node, _) in &entries {
            if !self.call_input_named(op, key) {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("unknown call input '{key}'"),
                    tight_span(text, key_node),
                ));
            }
            seen.insert((*key).to_string());
        }
        for required in self.required_call_inputs(op) {
            if !seen.contains(&required) {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("call is missing required input '{required}'"),
                    tight_span(text, args),
                ));
            }
        }
    }

    /// Check a sequence `request={...}` envelope: declared inputs
    /// only, with `version` the one nested override (`E5006`).
    fn check_call_request(&mut self, text: &str, op: SymbolId, request: &SyntaxNode) {
        for (key, key_node, value) in object_entries(text, request) {
            if !self.call_input_named(op, key) {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    format!("unknown request input '{key}'"),
                    tight_span(text, key_node),
                ));
                continue;
            }
            if let Some(object) = value
                && object.kind == SyntaxKind::Object
            {
                for (sub, sub_node, _) in object_entries(text, object) {
                    if sub != "version" {
                        self.diags.push(Diagnostic::error(
                            "E5006",
                            format!("unknown request override '{sub}'"),
                            tight_span(text, sub_node),
                        ));
                    }
                }
            }
        }
    }

    /// Check a sequence observation assertion: `result` needs a
    /// preceding successful result-bearing call (`E5006`).
    fn check_sequence_assert(&mut self, text: &str, node: &SyntaxNode, state: &mut SequenceState) {
        state.assertions += 1;
        if state.result_available {
            return;
        }
        for part in kids(node) {
            if is_expression(part.kind) && expr_uses_root(text, part, "result") {
                self.diags.push(Diagnostic::error(
                    "E5006",
                    "`result` needs a preceding successful call with a result".to_string(),
                    tight_span(text, part),
                ));
                return;
            }
        }
    }

    // --- Operation inputs ------------------------------------------------

    /// Whether `name` is a declared input of `op` (scenario parameter
    /// or generated CRUD input).
    fn call_input_named(&self, op: SymbolId, name: &str) -> bool {
        match &self.tables.symbols[op.0 as usize].kind {
            SymbolKind::Scenario { params, .. } => params
                .iter()
                .any(|p| self.tables.symbols[p.0 as usize].name == name),
            SymbolKind::CrudOp { model, op } => match op {
                CrudOp::Create => {
                    self.model_field_named(*model, name).is_some()
                        || (name == "parent" && model_is_contained(self.tables, *model))
                }
                CrudOp::Update => matches!(name, "record" | "changes"),
                CrudOp::Delete => name == "record",
            },
            _ => false,
        }
    }

    /// Required inputs of `op`: required scenario parameters, required
    /// create fields, or the record under test.
    fn required_call_inputs(&self, op: SymbolId) -> Vec<String> {
        match &self.tables.symbols[op.0 as usize].kind.clone() {
            SymbolKind::Scenario { params, .. } => {
                let params = params.clone();
                let defaults = self
                    .nodes
                    .get(&op)
                    .map(|node| {
                        let text = node_text(self.db, node);
                        param_defaults(&text, node)
                    })
                    .unwrap_or_default();
                params
                    .into_iter()
                    .filter_map(|p| {
                        let name = self.tables.symbols[p.0 as usize].name.clone();
                        if defaults.contains(&name) {
                            return None;
                        }
                        match self.types.symbol_types.get(&p) {
                            Some(ResolvedType::Nullable(_)) | None => None,
                            Some(_) => Some(name),
                        }
                    })
                    .collect()
            }
            SymbolKind::CrudOp { model, op } => match op {
                CrudOp::Create => self.required_create_fields(*model),
                CrudOp::Update | CrudOp::Delete => vec!["record".to_string()],
            },
            _ => Vec::new(),
        }
    }

    /// Whether `op` declares a bindable result.
    fn op_has_result(&self, op: SymbolId) -> bool {
        matches!(self.types.symbol_results.get(&op), Some(Some(_)))
    }

    /// Field of `model` (or contract/event/preferences record) by name.
    fn model_field_named(&self, model: SymbolId, name: &str) -> Option<SymbolId> {
        model_field_ids(self.tables, model)
            .into_iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
    }

    /// Generated CRUD operation symbol, present exactly when enabled.
    fn crud_op_symbol(&self, module: ModuleId, model: SymbolId, op: CrudOp) -> Option<SymbolId> {
        let module_name = &self.tables.modules[module.0 as usize].name;
        let model_name = &self.tables.symbols[model.0 as usize].name;
        let canonical = format!("{module_name}.{model_name}.{}", op.as_str());
        self.tables.by_canonical.get(&canonical).copied()
    }
}

// --- Selector model ----------------------------------------------------

/// One parsed input selector: a root name plus member segments.
struct Selector<'n> {
    node: &'n SyntaxNode,
    root: String,
    path: Vec<String>,
    optional: bool,
}

/// Resolved selector root.
enum SelRoot {
    /// Scenario parameter (fixture-backed when bound to one).
    Param {
        param: SymbolId,
        fixture: Option<SymbolId>,
    },
    /// Common input binding (fixture-backed when the value names one).
    Binding(Option<SymbolId>),
    /// Fixture referenced directly.
    Fixture(SymbolId),
    /// CRUD `record` (`changes=false`) or `changes` (`changes=true`).
    Record { model: SymbolId, changes: bool },
    /// Bare model field of a generated create.
    CreateField(SymbolId),
    /// Wire-envelope override.
    Request,
    /// Trusted-handler inferred `event` input (opaque here).
    Event,
    /// `parent` input of a generated create over `model`'s parent.
    CreateParent(SymbolId),
    /// Import member unresolvable in this check (opaque; resolve owns
    /// the import fault).
    Opaque,
}

/// Outcome of stepping one `parent` segment.
enum ParentStep {
    /// Handled (navigated or leniently skipped).
    Done,
    /// Rejected the selector.
    Abort,
    /// Not a contained traversal: run the ordinary field lookup.
    Fallthrough,
}

/// Overlap channel: state, submitted changes and the wire envelope
/// never conflict with each other; `as` only conflicts with `as`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlapChannel {
    State,
    Changes,
    Request,
    Caller,
}

/// Overlap identity of one validated input selector.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OverlapKey {
    channel: OverlapChannel,
    root: String,
    path: Vec<String>,
}

/// One validated input header selector.
struct CheckedSelector {
    span: Span,
    is_as: bool,
    root: Option<String>,
    overlap: Option<OverlapKey>,
}

impl CheckedSelector {
    fn failed(span: Span) -> Self {
        Self {
            span,
            is_as: false,
            root: None,
            overlap: None,
        }
    }

    fn as_column(span: Span) -> Self {
        Self {
            span,
            is_as: true,
            root: Some("as".to_string()),
            overlap: Some(OverlapKey {
                channel: OverlapChannel::Caller,
                root: String::new(),
                path: Vec::new(),
            }),
        }
    }

    fn ok(span: Span, root: Option<&str>, overlap: OverlapKey) -> Self {
        Self {
            span,
            is_as: false,
            root: root.map(str::to_string),
            overlap: Some(overlap),
        }
    }
}

/// Sequence-local checking state.
#[derive(Debug, Default)]
struct SequenceState {
    /// Resolved call targets in this sequence.
    called: HashSet<SymbolId>,
    /// `let`/`as` binding names in this sequence.
    names: HashSet<String>,
    /// Whether `result` currently names a bound business result.
    result_available: bool,
    /// Recorded calls in step order.
    calls: Vec<SequenceCall>,
    /// Observation assertions plus expected-error calls.
    assertions: usize,
}

// --- Module and symbol lookup ------------------------------------------

/// Module whose span contains `span`.
fn module_for(tables: &ResolveTables, span: Span) -> Option<ModuleId> {
    tables
        .modules
        .iter()
        .find(|m| m.file == span.file && m.span.start <= span.start && span.end <= m.span.end)
        .map(|m| m.id)
}

/// First `Name` child outside the introducer heads.
fn decl_name<'t>(text: &'t str, node: &SyntaxNode, heads: &[&str]) -> Option<&'t str> {
    kids(node).iter().find_map(|n| {
        let word = name_text(n, text)?;
        (!heads.contains(&word)).then_some(word)
    })
}

/// Production symbol named `name` in `module` (locals and imports).
fn prod_symbol(tables: &ResolveTables, module: ModuleId, name: &str) -> Option<SymbolId> {
    match tables
        .module_scopes
        .get(module.0 as usize)?
        .prod
        .get(name)?
    {
        ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => Some(*id),
        ScopedName::External { .. } => None,
    }
}

/// Test-namespace symbol named `name` in `module` (fixtures).
fn test_symbol(tables: &ResolveTables, module: ModuleId, name: &str) -> Option<SymbolId> {
    match tables
        .module_scopes
        .get(module.0 as usize)?
        .test
        .get(name)?
    {
        ScopedName::Local(id) | ScopedName::Imported { target: id, .. } => Some(*id),
        ScopedName::External { .. } => None,
    }
}

/// Whether `word` names anything in the production namespace
/// (locals, imports and bound-external members alike).
fn prod_scope_has(tables: &ResolveTables, module: ModuleId, word: &str) -> bool {
    tables
        .module_scopes
        .get(module.0 as usize)
        .is_some_and(|scopes| scopes.prod.contains_key(word))
}

/// Whether `name` is an imported member alias of `module`.
/// Unresolvable imports are resolve's `E2004`/`E2005`; example checks
/// stay silent on those names instead of cascading.
fn is_imported(imports: &HashMap<ModuleId, HashSet<String>>, module: ModuleId, name: &str) -> bool {
    imports
        .get(&module)
        .is_some_and(|names| names.contains(name))
}

/// Coarse caller-role classification of a production name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Role,
    OwnerWord,
    Other,
}

/// Classify `word` for caller validation: roles, the `owner`/`members`
/// keywords, other production names, or unresolvable.
fn prod_symbol_kind(tables: &ResolveTables, module: ModuleId, word: &str) -> Option<Kind> {
    if matches!(word, "owner" | "members") {
        return Some(Kind::OwnerWord);
    }
    let id = prod_symbol(tables, module, word)?;
    if matches!(tables.symbols[id.0 as usize].kind, SymbolKind::Role) {
        Some(Kind::Role)
    } else {
        Some(Kind::Other)
    }
}

/// Resolved trusted-event envelope for a scenario's `on=`
/// source (T35/R24): declared events (one or two segments,
/// mirroring the types pass `on_event_payload`) carry their
/// event record; `Cap.op.completed` carries the delivery
/// envelope with the op's declared result (`result:R?` per
/// DESIGN §8.1, member types mirroring `Delivery` lookup).
/// Anything else (queues, scenario completions, unresolvable
/// sources) stays opaque.
fn scenario_event_envelope(
    tables: &ResolveTables,
    types: &TypeTable,
    text: &str,
    module: ModuleId,
    node: &SyntaxNode,
) -> Option<ResolvedType> {
    let on = attribute_value(node, "on", text)?;
    if on.kind != SyntaxKind::Path {
        return None;
    }
    let segments = path_segments(on, text);
    match segments.len() {
        1 => {
            let id = prod_symbol(tables, module, segments[0])?;
            match &tables.symbols[id.0 as usize].kind {
                SymbolKind::Event { .. } => Some(ResolvedType::Record {
                    symbol: id,
                    stored: false,
                }),
                _ => None,
            }
        }
        2 => {
            let head = prod_symbol(tables, module, segments[0])?;
            match &tables.symbols[head.0 as usize].kind {
                SymbolKind::Capability { events, .. } => {
                    let event = events
                        .iter()
                        .copied()
                        .find(|e| tables.symbols[e.0 as usize].name == segments[1])?;
                    Some(ResolvedType::Record {
                        symbol: event,
                        stored: false,
                    })
                }
                _ => None,
            }
        }
        3 if segments[2] == "completed" => {
            let head = prod_symbol(tables, module, segments[0])?;
            let SymbolKind::Capability { ops, .. } = &tables.symbols[head.0 as usize].kind else {
                return None;
            };
            let op = ops
                .iter()
                .copied()
                .find(|o| tables.symbols[o.0 as usize].name == segments[1])?;
            let result = match types.symbol_results.get(&op).cloned() {
                Some(Some(ty)) => ResolvedType::Nullable(Box::new(ty)),
                Some(None) | None => ResolvedType::Null,
            };
            Some(ResolvedType::Object(vec![
                (
                    "delivery_id".to_string(),
                    ResolvedType::Scalar(Scalar::Text),
                ),
                (
                    "status".to_string(),
                    ResolvedType::Opaque("delivery status"),
                ),
                ("result".to_string(), result),
                ("error".to_string(), ResolvedType::Opaque("delivery error")),
            ]))
        }
        _ => None,
    }
}

/// Field symbols of a record symbol (model, contract, event).
fn model_field_ids(tables: &ResolveTables, model: SymbolId) -> Vec<SymbolId> {
    match &tables.symbols[model.0 as usize].kind {
        SymbolKind::Model { fields, .. }
        | SymbolKind::Contract { fields }
        | SymbolKind::Event { fields }
        | SymbolKind::Preferences { fields } => fields.clone(),
        _ => Vec::new(),
    }
}

/// Whether `model` is a contained child model.
fn model_is_contained(tables: &ResolveTables, model: SymbolId) -> bool {
    matches!(
        tables.symbols[model.0 as usize].kind,
        SymbolKind::Model {
            owner: ModelOwner::ChildOf(_),
            ..
        }
    )
}

// --- Header bindings ---------------------------------------------------

/// `(key, key span, value)` of an `examples` header's bindings.
fn example_bindings<'n>(
    text: &'n str,
    node: &'n SyntaxNode,
) -> Vec<(&'n str, Span, &'n SyntaxNode)> {
    let mut out = Vec::new();
    for child in kids(node) {
        if child.kind != SyntaxKind::Attribute {
            continue;
        }
        let Some((key, value)) = attribute_parts(child) else {
            continue;
        };
        let Some(word) = name_text(key, text) else {
            continue;
        };
        out.push((word, tight_span(text, key), value));
    }
    out
}

/// Whether a header binding names a declared operation input.
fn binding_names_input(tables: &ResolveTables, ctx: &OpCtx, key: &str) -> bool {
    match ctx {
        OpCtx::Scenario {
            params, trusted, ..
        } => {
            (*trusted && key == "event")
                || params
                    .iter()
                    .any(|p| tables.symbols[p.0 as usize].name == key)
        }
        OpCtx::Crud { model, op } => match op {
            CrudOp::Create => {
                model_field_ids(tables, *model)
                    .iter()
                    .any(|f| tables.symbols[f.0 as usize].name == key)
                    || (key == "parent" && model_is_contained(tables, *model))
            }
            CrudOp::Update => matches!(key, "record" | "changes"),
            CrudOp::Delete => key == "record",
        },
    }
}

/// Whether `name` is a declared input a `request.*` selector may wrap.
fn request_input_named(tables: &ResolveTables, ctx: &OpCtx, name: &str) -> bool {
    match ctx {
        OpCtx::Scenario {
            params, trusted, ..
        } => {
            (*trusted && name == "event")
                || params
                    .iter()
                    .any(|p| tables.symbols[p.0 as usize].name == name)
        }
        OpCtx::Crud { model, op } => match op {
            CrudOp::Create => model_field_ids(tables, *model)
                .iter()
                .any(|f| tables.symbols[f.0 as usize].name == name),
            CrudOp::Update | CrudOp::Delete => name == "record",
        },
    }
}

/// Fixture named by a binding value, if it names one.
fn binding_fixture(
    tables: &ResolveTables,
    module: ModuleId,
    text: &str,
    value: &SyntaxNode,
) -> Option<SymbolId> {
    let word = nameref_word(text, value)?;
    let id = test_symbol(tables, module, word)?;
    matches!(
        tables.symbols[id.0 as usize].kind,
        SymbolKind::Fixture { .. }
    )
    .then_some(id)
}

/// Overlap identity of a validated selector: bindings and parameters
/// backed by one fixture share that fixture's identity so aliasing
/// overrides conflict.
fn overlap_key(root: &SelRoot, sel: &Selector) -> OverlapKey {
    match root {
        SelRoot::Param {
            fixture: Some(id), ..
        }
        | SelRoot::Binding(Some(id))
        | SelRoot::Fixture(id) => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("fixture{}", id.0),
            path: sel.path.clone(),
        },
        SelRoot::Param { param, .. } => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("param{}", param.0),
            path: sel.path.clone(),
        },
        SelRoot::Binding(None) => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("binding{}", sel.root),
            path: sel.path.clone(),
        },
        SelRoot::Record { model, changes } => OverlapKey {
            channel: if *changes {
                OverlapChannel::Changes
            } else {
                OverlapChannel::State
            },
            root: format!("record{}", model.0),
            path: sel.path.clone(),
        },
        SelRoot::CreateField(field) => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("field{}", field.0),
            path: sel.path.clone(),
        },
        SelRoot::Event => OverlapKey {
            channel: OverlapChannel::State,
            root: "event".to_string(),
            path: sel.path.clone(),
        },
        SelRoot::CreateParent(parent) => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("parent{}", parent.0),
            path: sel.path.clone(),
        },
        SelRoot::Opaque => OverlapKey {
            channel: OverlapChannel::State,
            root: format!("opaque{}", sel.root),
            path: sel.path.clone(),
        },
        SelRoot::Request => OverlapKey {
            channel: OverlapChannel::Request,
            root: sel.root.clone(),
            path: sel.path.clone(),
        },
    }
}

/// Whether one path strictly contains the other.
fn paths_overlap(a: &[String], b: &[String]) -> bool {
    if a.len() == b.len() {
        return false;
    }
    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    long.starts_with(short)
}

// --- CST readers -------------------------------------------------------

/// Split an `ExampleRow`/`ExampleAssert` at its `->` into input and
/// expected expressions (expected-error rows excluded from the latter).
fn split_row<'x>(text: &'x str, row: &'x SyntaxNode) -> (Vec<&'x SyntaxNode>, Vec<&'x SyntaxNode>) {
    let mut inputs = Vec::new();
    let mut expected = Vec::new();
    let mut right = false;
    for part in kids(row) {
        if part.kind == SyntaxKind::Punct && part.token().is_some_and(|t| t.text(text) == "->") {
            right = true;
            continue;
        }
        if part.kind == SyntaxKind::ExpectedError {
            continue;
        }
        if !is_expression(part.kind) {
            continue;
        }
        if right {
            expected.push(part);
        } else {
            inputs.push(part);
        }
    }
    (inputs, expected)
}

/// The `ExpectedError` child of a row, if it expects `error(code)`.
fn expected_error_node(row: &SyntaxNode) -> Option<&SyntaxNode> {
    kids(row)
        .into_iter()
        .find(|n| n.kind == SyntaxKind::ExpectedError)
}

/// Whether `node` is an `error(...)` expectation call.
fn is_error_call(text: &str, node: &SyntaxNode) -> bool {
    if node.kind != SyntaxKind::Call {
        return false;
    }
    kids(node).first().is_some_and(|callee| {
        callee.kind == SyntaxKind::NameRef && nameref_word(text, callee) == Some("error")
    })
}

/// Bare word of a `NameRef` expression, if it is one.
fn nameref_word<'t>(text: &'t str, node: &SyntaxNode) -> Option<&'t str> {
    if node.kind != SyntaxKind::NameRef {
        return None;
    }
    kids(node).iter().find_map(|n| name_text(n, text))
}

/// `Name` leaves of a path expression in order (`a.b.c` → `[a,b,c]`).
fn member_names(text: &str, node: &SyntaxNode) -> Vec<String> {
    node.descendants()
        .filter(|n| n.kind == SyntaxKind::Name)
        .filter_map(|n| name_text(n, text).map(str::to_string))
        .collect()
}

/// Parse an input header into a selector, if it is a plain path.
fn parse_selector<'n>(text: &str, node: &'n SyntaxNode) -> Option<Selector<'n>> {
    if !matches!(node.kind, SyntaxKind::NameRef | SyntaxKind::Member) {
        return None;
    }
    let mut names = member_names(text, node);
    if names.is_empty() {
        return None;
    }
    let root = names.remove(0);
    let optional = node
        .descendants()
        .filter(|n| n.kind == SyntaxKind::Punct)
        .filter_map(|n| n.token().map(|t| t.text(text)))
        .any(|spell| spell == "?." || spell == "?");
    Some(Selector {
        node,
        root,
        path: names,
        optional,
    })
}

/// Tight spans of a selector's root and segments in order.
fn selector_spans(text: &str, node: &SyntaxNode) -> Vec<Span> {
    node.descendants()
        .filter(|n| n.kind == SyntaxKind::Name)
        .map(|n| tight_span(text, n))
        .collect()
}

/// Dotted spelling of a selector.
fn selector_spelling(sel: &Selector) -> String {
    let mut parts = vec![sel.root.clone()];
    parts.extend(sel.path.iter().cloned());
    parts.join(".")
}

/// Entries of an `Object` node: (key, key node, value node).
fn object_entries<'a>(
    text: &'a str,
    object: &'a SyntaxNode,
) -> Vec<(&'a str, &'a SyntaxNode, Option<&'a SyntaxNode>)> {
    let mut entries = Vec::new();
    for entry in object
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::ObjectEntry)
    {
        let parts = kids(entry);
        let Some(key_node) = parts
            .first()
            .copied()
            .filter(|n| n.kind == SyntaxKind::Name)
        else {
            continue;
        };
        let Some(key) = name_text(key_node, text) else {
            continue;
        };
        let value = parts.iter().find(|n| is_expression(n.kind)).copied();
        entries.push((key, key_node, value));
    }
    entries
}

/// Whether `node` mentions the bare root `name` (a `NameRef` head or
/// member root), without descending into queries.
fn expr_uses_root(text: &str, node: &SyntaxNode, name: &str) -> bool {
    match node.kind {
        SyntaxKind::Query => false,
        SyntaxKind::NameRef => nameref_word(text, node).is_some_and(|w| w == name),
        SyntaxKind::Member => member_names(text, node)
            .first()
            .is_some_and(|root| root == name),
        _ => node.children.iter().any(|c| expr_uses_root(text, c, name)),
    }
}

/// Scenario parameters carrying a `= default` (a bare `=` whose
/// previous sibling is the type, not `label`).
fn param_defaults(text: &str, scenario: &SyntaxNode) -> HashSet<String> {
    let mut defaults = HashSet::new();
    for param in scenario
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Parameter)
    {
        let parts = kids(param);
        let name = parts.iter().find_map(|n| name_text(n, text));
        let Some(name) = name else { continue };
        if has_bare_default(&parts) {
            defaults.insert(name.to_string());
        }
    }
    defaults
}

/// Model fields with a `= default` or `server=` initializer.
fn field_optionals(db: &SourceDb, model: &SyntaxNode) -> HashSet<String> {
    let mut optional = HashSet::new();
    let Some(source) = db.get(model.span.file) else {
        return optional;
    };
    for field in model
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Field)
    {
        let parts = kids(field);
        let name = parts.iter().find_map(|n| name_text(n, &source.text));
        let Some(name) = name else { continue };
        let server = parts
            .iter()
            .any(|n| name_text(n, &source.text) == Some("server"));
        if server || has_bare_default(&parts) {
            optional.insert(name.to_string());
        }
    }
    optional
}

/// Whether significant siblings hold a default `=`: an `=` punct whose
/// previous sibling is not a `Name` (attribute spellings like
/// `label=`/`min=`/`server=` all start from one).
fn has_bare_default(parts: &[&SyntaxNode]) -> bool {
    for (index, part) in parts.iter().enumerate() {
        if part.kind != SyntaxKind::Punct {
            continue;
        }
        let is_eq = part
            .token()
            .is_some_and(|t| matches!(t.kind, TokenKind::Punct(Punct::Eq)));
        if !is_eq {
            continue;
        }
        let prev_is_name = index > 0 && parts[index - 1].kind == SyntaxKind::Name;
        if !prev_is_name {
            return true;
        }
    }
    false
}

/// Span of the `examples` keyword of a block.
fn examples_keyword(text: &str, node: &SyntaxNode) -> Span {
    kids(node)
        .iter()
        .find(|n| name_text(n, text) == Some("examples"))
        .map(|n| tight_span(text, n))
        .unwrap_or_else(|| tight_span(text, node))
}

/// Tight source slice covered by `node` (trivia trimmed).
fn tight_slice<'t>(text: &'t str, node: &SyntaxNode) -> &'t str {
    span_slice(text, tight_span(text, node))
}

/// Source slice covered by `node`.
fn slice_of<'t>(text: &'t str, node: &SyntaxNode) -> &'t str {
    span_slice(text, node.span)
}

/// Source slice covered by `span`.
fn span_slice(text: &str, span: Span) -> &str {
    text.get(span.start as usize..span.end as usize)
        .unwrap_or("")
}

/// Tight span of `node`: surrounding trivia trimmed so primaries point
/// at significant source.
fn tight_span(text: &str, node: &SyntaxNode) -> Span {
    let raw = slice_of(text, node);
    let leading = raw.len() - raw.trim_start().len();
    let trimmed = raw.trim();
    let start = node.span.start + leading as u32;
    Span::new(node.span.file, start, start + trimmed.len() as u32)
}

/// Decoded value of a string `Literal` node (`None` when not one).
fn literal_string(text: &str, node: &SyntaxNode) -> Option<String> {
    if node.kind != SyntaxKind::Literal {
        return None;
    }
    for leaf in kids(node) {
        if leaf.kind != SyntaxKind::String {
            continue;
        }
        if let Some(token) = leaf.token()
            && let Some(decoded) = token.string_value.clone()
        {
            return Some(decoded);
        }
        let raw = slice_of(text, leaf);
        return raw
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .map(str::to_string);
    }
    None
}

/// Whether a `Literal` node is the `null` literal.
fn is_null_literal(text: &str, node: &SyntaxNode) -> bool {
    if node.kind != SyntaxKind::Literal {
        return false;
    }
    kids(node)
        .iter()
        .any(|leaf| leaf.kind == SyntaxKind::Name && name_text(leaf, text) == Some("null"))
}

/// Whether a subtree contains a node of `kind`.
fn subtree_has(node: &SyntaxNode, kind: SyntaxKind) -> bool {
    node.descendants().any(|n| n.kind == kind)
}

/// Source text of a declaration node's file (empty when unknown).
fn node_text(db: &SourceDb, node: &SyntaxNode) -> String {
    file_text(db, node.span.file).unwrap_or("").to_string()
}

// --- Type helpers ------------------------------------------------------

/// Whether `name` is reserved record metadata and so never settable.
fn is_reserved_name(name: &str) -> bool {
    matches!(
        name,
        "id" | "version" | "created" | "updated" | "created_by" | "updated_by" | "archived_at"
    )
}

/// One nullable layer stripped, if present.
fn nullable_inner(ty: &ResolvedType) -> Option<&ResolvedType> {
    match ty {
        ResolvedType::Nullable(inner) => Some(inner),
        _ => None,
    }
}

/// Cases of a uniquely expected enum type, through nullability.
/// Mirrors the types pass `enum_expectation` for header elision.
fn enum_cases(ty: &ResolvedType) -> Option<&[String]> {
    match ty {
        ResolvedType::Nullable(inner) => enum_cases(inner),
        ResolvedType::Enum { cases, .. } => Some(cases),
        _ => None,
    }
}

/// Whether navigation through `ty` is unverifiable but legal (opaque
/// imports, unknowns and already-diagnosed errors stay silent).
fn navigable_unknown(ty: &ResolvedType) -> bool {
    matches!(
        ty,
        ResolvedType::Opaque(_) | ResolvedType::Unknown | ResolvedType::Error | ResolvedType::Null
    )
}

/// Whether a message parameter type is admissible: a nonnullable
/// text-like, bool, enum, int, decimal, money, date or datetime value.
fn message_param_ok(ty: &ResolvedType) -> bool {
    matches!(
        ty,
        ResolvedType::Scalar(
            Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency
                | Scalar::Bool
                | Scalar::Int
                | Scalar::Decimal
                | Scalar::Money
                | Scalar::Date
                | Scalar::Datetime,
        ) | ResolvedType::Enum { .. }
    )
}

// --- ICU message patterns ------------------------------------------------

/// Coarse argument type for ICU selector compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IcuType {
    Int,
    Decimal,
    TextLike,
    Bool,
    Enum,
    Date,
    DateTime,
    Other,
}

impl IcuType {
    fn of(ty: &ResolvedType) -> Self {
        let inner = nullable_inner(ty).unwrap_or(ty);
        match inner {
            ResolvedType::Scalar(Scalar::Int) => IcuType::Int,
            ResolvedType::Scalar(Scalar::Decimal) => IcuType::Decimal,
            ResolvedType::Scalar(
                Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency,
            ) => IcuType::TextLike,
            ResolvedType::Scalar(Scalar::Bool) => IcuType::Bool,
            ResolvedType::Enum { .. } => IcuType::Enum,
            ResolvedType::Scalar(Scalar::Date) => IcuType::Date,
            ResolvedType::Scalar(Scalar::Datetime) => IcuType::DateTime,
            _ => IcuType::Other,
        }
    }
}

/// First ICU profile violation in `template`, if any.
///
/// Accepts the bounded DESIGN §9.1 profile: named `{name}` arguments,
/// `{n,number}`/`{n,number,integer}`, `{d,date}`/`{d,time}` with short
/// to full styles, and nested plural/selectordinal/select with a
/// mandatory `other` branch. Rejects offsets, choice/skeleton styles,
/// duplicate branches, `#` outside a plural and unbalanced patterns.
/// The profile is implementation-defined pending a DESIGN ruling.
/// Declared-variable *coverage* stays the types pass (`E3016`); only
/// structurally typed selectors are checked against `params` here.
fn icu_error(template: &str, params: Option<&HashMap<String, IcuType>>) -> Option<String> {
    let chars: Vec<char> = template.chars().collect();
    IcuParser {
        chars: &chars,
        pos: 0,
        params,
        plural_depth: 0,
    }
    .parse_message(0)
    .err()
}

struct IcuParser<'t> {
    chars: &'t [char],
    pos: usize,
    params: Option<&'t HashMap<String, IcuType>>,
    plural_depth: usize,
}

impl<'t> IcuParser<'t> {
    fn parse_message(&mut self, depth: usize) -> Result<(), String> {
        if depth > 32 {
            return Err("message nesting is too deep".to_string());
        }
        while let Some(&c) = self.chars.get(self.pos) {
            match c {
                '\'' => self.parse_quote()?,
                '{' => self.parse_argument(depth)?,
                '}' => return Err("unmatched '}'".to_string()),
                '#' if self.plural_depth == 0 => {
                    return Err("'#' needs an enclosing plural".to_string());
                }
                _ => self.pos += 1,
            }
        }
        Ok(())
    }

    /// Parse a message nested in a plural/select branch (stops before
    /// the branch's closing `}`, which the caller consumes).
    fn parse_nested(&mut self, depth: usize) -> Result<(), String> {
        if depth > 32 {
            return Err("message nesting is too deep".to_string());
        }
        while let Some(&c) = self.chars.get(self.pos) {
            match c {
                '\'' => self.parse_quote()?,
                '{' => self.parse_argument(depth)?,
                '}' => return Ok(()),
                '#' if self.plural_depth == 0 => {
                    return Err("'#' needs an enclosing plural".to_string());
                }
                _ => self.pos += 1,
            }
        }
        Err("unclosed '{'".to_string())
    }

    /// ICU apostrophe quoting: `''` is literal; `'` before syntax
    /// quotes until the next `'`; a lone `'` is literal text.
    fn parse_quote(&mut self) -> Result<(), String> {
        let next = self.chars.get(self.pos + 1).copied();
        if next == Some('\'') {
            self.pos += 2;
            return Ok(());
        }
        if matches!(next, Some('{' | '}' | '#' | '|')) {
            self.pos += 1;
            while let Some(&c) = self.chars.get(self.pos) {
                self.pos += 1;
                if c == '\'' {
                    if self.chars.get(self.pos) == Some(&'\'') {
                        self.pos += 1;
                    } else {
                        return Ok(());
                    }
                }
            }
            return Err("unterminated quoted text".to_string());
        }
        self.pos += 1;
        Ok(())
    }

    fn parse_argument(&mut self, depth: usize) -> Result<(), String> {
        self.pos += 1; // `{`
        self.skip_ws();
        let name = self.parse_name()?;
        self.skip_ws();
        let end = self.chars.get(self.pos).copied();
        if end == Some('}') {
            self.pos += 1;
            return Ok(());
        }
        if end != Some(',') {
            return Err(format!("expected ',' or '}}' after '{{{name}'"));
        }
        self.pos += 1;
        self.skip_ws();
        let format = self.parse_name()?;
        self.skip_ws();
        match format.as_str() {
            "number" => {
                let mut integer_style = false;
                if self.chars.get(self.pos) == Some(&',') {
                    self.pos += 1;
                    self.skip_ws();
                    let style = self.parse_name()?;
                    if style != "integer" {
                        return Err(format!("unsupported number style '{style}'"));
                    }
                    integer_style = true;
                    self.skip_ws();
                }
                let allowed: &[IcuType] = if integer_style {
                    &[IcuType::Int]
                } else {
                    &[IcuType::Int, IcuType::Decimal]
                };
                self.check_arg(&name, allowed, "number")?;
                self.expect_close(&name)?;
            }
            "date" | "time" => {
                let allowed: &[IcuType] = if format == "date" {
                    &[IcuType::Date, IcuType::DateTime]
                } else {
                    &[IcuType::DateTime]
                };
                self.check_arg(&name, allowed, format.as_str())?;
                if self.chars.get(self.pos) == Some(&',') {
                    self.pos += 1;
                    self.skip_ws();
                    let style = self.parse_name()?;
                    if !matches!(style.as_str(), "short" | "medium" | "long" | "full") {
                        return Err(format!("unsupported {format} style '{style}'"));
                    }
                    self.skip_ws();
                }
                self.expect_close(&name)?;
            }
            "plural" | "selectordinal" => {
                let allowed: &[IcuType] = if format == "selectordinal" {
                    &[IcuType::Int]
                } else {
                    &[IcuType::Int, IcuType::Decimal]
                };
                self.check_arg(&name, allowed, format.as_str())?;
                self.expect_comma(&name, format.as_str())?;
                self.plural_depth += 1;
                let result = self.parse_options(&name, true, depth);
                self.plural_depth -= 1;
                result?;
                self.expect_close(&name)?;
            }
            "select" => {
                self.check_arg(
                    &name,
                    &[IcuType::TextLike, IcuType::Bool, IcuType::Enum],
                    "select",
                )?;
                self.expect_comma(&name, "select")?;
                self.parse_options(&name, false, depth)?;
                self.expect_close(&name)?;
            }
            other => return Err(format!("unsupported format '{other}'")),
        }
        Ok(())
    }

    fn parse_options(&mut self, name: &str, plural: bool, depth: usize) -> Result<(), String> {
        let mut seen: Vec<String> = Vec::new();
        loop {
            self.skip_ws();
            let Some(&c) = self.chars.get(self.pos) else {
                return Err(format!("unclosed '{{{name}'"));
            };
            if c == '}' {
                break;
            }
            let key = if plural && c == '=' {
                self.pos += 1;
                self.parse_number_key()?
            } else {
                let word = self.parse_name()?;
                if plural && word == "offset" && self.chars.get(self.pos) == Some(&':') {
                    return Err("plural offsets are not supported".to_string());
                }
                word
            };
            if seen.contains(&key) {
                return Err(format!("duplicate '{key}' branch"));
            }
            seen.push(key);
            self.skip_ws();
            if self.chars.get(self.pos) != Some(&'{') {
                return Err("expected '{' to open the branch".to_string());
            }
            self.pos += 1;
            self.parse_nested(depth + 1)?;
            self.pos += 1; // branch `}`
        }
        if !seen.contains(&"other".to_string()) {
            return Err("plural and select need an 'other' branch".to_string());
        }
        Ok(())
    }

    fn parse_number_key(&mut self) -> Result<String, String> {
        let start = self.pos;
        if self.chars.get(self.pos) == Some(&'-') {
            self.pos += 1;
        }
        let mut digits = 0;
        let mut dot = false;
        while let Some(&c) = self.chars.get(self.pos) {
            if c.is_ascii_digit() {
                digits += 1;
                self.pos += 1;
            } else if c == '.' && !dot {
                dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        if digits == 0 {
            return Err("expected a number after '='".to_string());
        }
        Ok(format!(
            "={}",
            self.chars[start..self.pos].iter().collect::<String>()
        ))
    }

    fn parse_name(&mut self) -> Result<String, String> {
        let start = self.pos;
        let first = self.chars.get(self.pos).copied().unwrap_or('\0');
        if !(first.is_ascii_alphabetic() || first == '_') {
            return Err("expected an argument name".to_string());
        }
        while let Some(&c) = self.chars.get(self.pos) {
            if c.is_ascii_alphanumeric() || c == '_' {
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(self.chars[start..self.pos].iter().collect())
    }

    fn skip_ws(&mut self) {
        while self.chars.get(self.pos).is_some_and(|c| c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn expect_close(&mut self, name: &str) -> Result<(), String> {
        if self.chars.get(self.pos) == Some(&'}') {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("unclosed '{{{name}'"))
        }
    }

    fn expect_comma(&mut self, name: &str, format: &str) -> Result<(), String> {
        if self.chars.get(self.pos) == Some(&',') {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("{format} '{{{name}' needs branches"))
        }
    }

    /// Selector/argument type compatibility for declared parameters.
    /// Undeclared variables stay the types pass (`E3016`).
    fn check_arg(&self, name: &str, allowed: &[IcuType], what: &str) -> Result<(), String> {
        let Some(params) = self.params else {
            return Ok(());
        };
        let Some(ty) = params.get(name) else {
            return Ok(());
        };
        if allowed.contains(ty) {
            Ok(())
        } else {
            Err(format!("{what} argument '{name}' has an incompatible type"))
        }
    }
}
