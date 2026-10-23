//! Immutable original-source preparation; a single borrowed context and invocation-local cache.
use super::ir::*;
use super::scenario_decisions::{
    SerialDecisionSite, serialize_read_predicates, serialize_read_rule,
};
use super::source_correspondence::{SemanticJoin, same_scenario_semantics};
use crate::analysis::catalog::Catalog;
use crate::analysis::{CheckedProgram, SymbolId};
use crate::source::{SourceDb, Span};
use crate::syntax::{self, SyntaxNode};
use std::collections::{HashMap, HashSet};

/// One fresh, invocation-local source cohort. No authority or global cache;
/// all consumers borrow the exact supplied inputs and retain their own checks.
pub(super) struct FreshSourceContext<'a> {
    program: &'a CheckedProgram,
    ir: &'a IrProgram,
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    original: CheckedProgram,
    fresh: IrProgram,
    has_ir_diagnostics: bool,
    ir_diagnostics: Vec<crate::diagnostic::Diagnostic>,
    trees: Vec<(crate::source::SourceId, SyntaxNode)>,
    resolved: crate::analysis::resolve::ResolveTables,
    scenario_semantics: std::sync::Mutex<HashMap<SymbolId, bool>>,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum SourcePreparationGap {
    Cohort,
    Analysis,
    Ir,
    MissingSource,
    Cst(Span),
    Resolution,
}

impl<'a> FreshSourceContext<'a> {
    pub(super) fn prepare(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
    ) -> Result<Self, SourcePreparationGap> {
        Self::prepare_inner(program, ir, db, catalog, false)
    }

    /// Query association may borrow a partial lowering, never execution authority.
    /// The query consumer still seals its complete original consumed closure.
    pub(super) fn prepare_queries(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
    ) -> Result<Self, SourcePreparationGap> {
        Self::prepare_inner(program, ir, db, catalog, true)
    }

    fn prepare_inner(
        program: &'a CheckedProgram,
        ir: &'a IrProgram,
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
        query_association: bool,
    ) -> Result<Self, SourcePreparationGap> {
        program
            .validate_cohort(db, catalog)
            .map_err(|_| SourcePreparationGap::Cohort)?;
        let (original, diagnostics) = crate::analysis::check_program_with_given(
            db,
            program.checked_files(),
            catalog,
            program.original_given(),
        );
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return Err(SourcePreparationGap::Analysis);
        }
        let (fresh, diagnostics) = if ir
            .standard_completion_sources
            .is_private_terminal_candidate()
        {
            super::ir::build_standard_terminal_candidates(&original, db, catalog)
        } else {
            super::ir::build(&original, db, catalog)
        };
        let has_ir_diagnostics = !diagnostics.is_empty();
        if diagnostics.iter().any(|d| {
            d.severity == crate::diagnostic::Severity::Error
                && (!query_association || !matches!(d.code, "E6007" | "E6008"))
        }) {
            return Err(SourcePreparationGap::Ir);
        }
        let ir_diagnostics = diagnostics;
        let mut trees = Vec::new();
        for &file in original.checked_files() {
            let input = db.get(file).ok_or(SourcePreparationGap::MissingSource)?;
            let (tree, diagnostics) = syntax::parse_source(file, &input.text);
            if diagnostics
                .iter()
                .any(|d| d.severity == crate::diagnostic::Severity::Error)
            {
                return Err(SourcePreparationGap::Cst(tree.span));
            }
            trees.push((file, tree));
        }
        let mut diagnostics = Vec::new();
        let resolved = crate::analysis::resolve::try_resolve_program_with_given(
            db,
            &trees,
            catalog,
            program.original_given(),
            &mut diagnostics,
        )
        .map_err(|_| SourcePreparationGap::Resolution)?;
        if diagnostics
            .iter()
            .any(|d| d.severity == crate::diagnostic::Severity::Error)
        {
            return Err(SourcePreparationGap::Resolution);
        }
        Ok(Self {
            program,
            ir,
            db,
            catalog,
            original,
            fresh,
            has_ir_diagnostics,
            ir_diagnostics,
            trees,
            resolved,
            scenario_semantics: std::sync::Mutex::new(HashMap::new()),
        })
    }

    pub(super) fn program(&self) -> &CheckedProgram {
        self.program
    }
    pub(super) fn ir(&self) -> &IrProgram {
        self.ir
    }
    pub(super) fn db(&self) -> &SourceDb {
        self.db
    }
    pub(super) fn catalog(&self) -> Option<&Catalog> {
        self.catalog
    }
    pub(super) fn original(&self) -> &CheckedProgram {
        &self.original
    }
    pub(super) fn fresh(&self) -> &IrProgram {
        &self.fresh
    }
    pub(super) fn has_ir_errors(&self) -> bool {
        self.ir_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    }
    pub(super) fn ir_diagnostics(&self) -> &[crate::diagnostic::Diagnostic] {
        &self.ir_diagnostics
    }
    pub(super) fn has_ir_diagnostics(&self) -> bool {
        self.has_ir_diagnostics
    }
    pub(super) fn trees(&self) -> &[(crate::source::SourceId, SyntaxNode)] {
        &self.trees
    }
    /// The IR and source cohort are immutable for this context. Reuse a
    /// complete owner comparison only for its exact borrowed item; detached
    /// items and other IRs retain the uncached structural comparison.
    pub(super) fn same_scenario(&self, ir: &IrProgram, owner: &IrItem) -> Option<()> {
        if !std::ptr::eq(ir, self.ir)
            || !ir
                .items
                .get(owner.id.0 as usize)
                .is_some_and(|item| std::ptr::eq(item, owner))
        {
            return same_scenario_semantics(&self.original, ir, &self.fresh, owner);
        }
        if let Some(result) = self.scenario_semantics.lock().ok()?.get(&owner.id).copied() {
            return result.then_some(());
        }
        let result = same_scenario_semantics(&self.original, ir, &self.fresh, owner).is_some();
        self.scenario_semantics
            .lock()
            .ok()?
            .insert(owner.id, result);
        result.then_some(())
    }
    pub(super) fn same_event_schema(&self, event: &str) -> Option<()> {
        SemanticJoin {
            program: self.program,
            actual: self.ir,
            expected: &self.fresh,
            nodes: 0,
            stack: HashSet::new(),
        }
        .event_schema(event, 0)
    }
    pub(super) fn same_expression(&self, actual: &TypedExpr, expected: &TypedExpr) -> Option<()> {
        SemanticJoin {
            program: self.program,
            actual: self.ir,
            expected: &self.fresh,
            nodes: 0,
            stack: HashSet::new(),
        }
        .expression(actual, expected, 0)
    }
    pub(super) fn resolved(&self) -> &crate::analysis::resolve::ResolveTables {
        &self.resolved
    }
    pub(super) fn serialize_rule(&self, rule: &IrRuleFn) -> Option<Vec<SerialDecisionSite>> {
        serialize_read_rule(self, rule)
    }
    pub(super) fn serialize_predicates(&self) -> Option<Vec<SerialDecisionSite>> {
        serialize_read_predicates(self)
    }
}
