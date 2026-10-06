//! Policy introspection: declared policy/invariant/role/`by=` surface per
//! model and operation, served (at integration) by `can policy --json`.
//!
//! The query walks the CST for `role`/`policy`/`invariant`/`crud`/
//! `scenario` declarations and qualifies every name through the resolve
//! tables (`CheckedProgram::symbols`/`modules`), with scenario parameter
//! types rendered from the types table (`TypeTable::symbol_types`).
//! Predicate spellings (`where=`, invariant bodies, `by=`, `require`) are
//! verbatim source slices: the dump reports what was declared, never a
//! paraphrase. Entries follow source order; models without any policy or
//! invariant are omitted (this is the policy surface, not the model list).
//!
//! [`policy_dump`] re-parses `files` because [`CheckedProgram`] retains no
//! trees; parse diagnostics are the caller's (the dump reads whatever the
//! parser recovered). JSON shape is versioned (`"version":1`) and consumed
//! by `packages/ui/src/policyPage.ts`; keep the two in sync.

use crate::analysis::resolve::{ModuleId, SymbolId, SymbolKind, is_expression};
use crate::analysis::types::{ResolvedType, Scalar};
use crate::analysis::{
    CheckedProgram, attribute_parts, attribute_value, file_text, kids, name_text, path_segments,
};
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{SyntaxKind, SyntaxNode, parse};

/// Dump schema version emitted by [`policy_dump_json`].
pub const POLICY_DUMP_VERSION: u32 = 1;

/// One declared role.
#[derive(Debug, Clone, PartialEq)]
pub struct RoleEntry {
    /// Declaring package.
    pub package: String,
    /// Local role name.
    pub name: String,
    /// Canonical identity (`Package.role`).
    pub canonical: String,
    /// Verbatim `label=` source slice, when one is authored.
    pub label: Option<String>,
}

/// One `policy Model kind=grantee [where=...]` declaration.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyEntry {
    /// Grant kind spelling (`read`).
    pub kind: String,
    /// Grantee spelling (`members`, a role name, ...).
    pub grantee: String,
    /// Verbatim `where=` predicate slice, when one is authored.
    pub where_predicate: Option<String>,
    /// Verbatim declaration line.
    pub source: String,
}

/// One `invariant Model: predicate` declaration.
#[derive(Debug, Clone, PartialEq)]
pub struct InvariantEntry {
    /// Verbatim predicate slice.
    pub predicate: String,
    /// Verbatim declaration line.
    pub source: String,
}

/// One model's declared policy surface.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelEntry {
    /// Canonical model identity.
    pub canonical: String,
    /// `policy` declarations in source order.
    pub policies: Vec<PolicyEntry>,
    /// `invariant` declarations in source order.
    pub invariants: Vec<InvariantEntry>,
}

/// One scenario parameter with its declared type.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamEntry {
    /// Parameter name.
    pub name: String,
    /// Declared type display (`{unknown}` when untypable).
    pub typ: String,
}

/// One operation's admission surface.
#[derive(Debug, Clone, PartialEq)]
pub struct OperationEntry {
    /// Canonical operation identity.
    pub canonical: String,
    /// `scenario`, `create`, `update` or `delete`.
    pub kind: String,
    /// Verbatim `by=` gate slice, when one is authored.
    pub by: Option<String>,
    /// Verbatim crud `when=` predicate slice, when one is authored.
    pub when: Option<String>,
    /// Verbatim `require` predicate slices in source order.
    pub requires: Vec<String>,
    /// Scenario parameters (empty for crud operations).
    pub params: Vec<ParamEntry>,
    /// Verbatim declaration header line.
    pub source: String,
}

/// The full introspected policy surface.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PolicyDump {
    /// Declared roles in source order.
    pub roles: Vec<RoleEntry>,
    /// Models carrying policy/invariants, in first-seen order.
    pub models: Vec<ModelEntry>,
    /// Operations in source order.
    pub operations: Vec<OperationEntry>,
}

/// Introspect the policy surface of `files`.
///
/// Names qualify through `program` (resolve symbols/modules; types for
/// scenario parameters); predicate text is sliced from `db`. The query
/// never fails: unresolvable names fall back to `Module.Name` spelling
/// and unreadable spans slice to `""`.
pub fn policy_dump(db: &SourceDb, program: &CheckedProgram, files: &[SourceId]) -> PolicyDump {
    let mut dump = PolicyDump::default();
    for &file in files {
        let text = file_text(db, file).unwrap_or("");
        let (tree, _) = parse(db, file);
        let mut walker = Walker {
            program,
            text,
            module: None,
            dump: &mut dump,
        };
        walker.walk(&tree);
    }
    dump
}

/// Render a dump as deterministic pretty JSON (`"version":1`).
pub fn policy_dump_json(dump: &PolicyDump) -> String {
    let mut out = String::new();
    out.push_str("{\n  \"version\": ");
    out.push_str(&POLICY_DUMP_VERSION.to_string());
    out.push_str(",\n  \"roles\": [");
    for (i, role) in dump.roles.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("\n    {\"package\": ");
        push_str(&mut out, &role.package);
        out.push_str(", \"name\": ");
        push_str(&mut out, &role.name);
        out.push_str(", \"canonical\": ");
        push_str(&mut out, &role.canonical);
        if let Some(label) = &role.label {
            out.push_str(", \"label\": ");
            push_str(&mut out, label);
        }
        out.push('}');
    }
    if !dump.roles.is_empty() {
        out.push('\n');
        out.push_str("  ");
    }
    out.push_str("],\n  \"models\": [");
    for (i, model) in dump.models.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("\n    {\"canonical\": ");
        push_str(&mut out, &model.canonical);
        out.push_str(", \"policies\": [");
        for (j, policy) in model.policies.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("\n      {\"kind\": ");
            push_str(&mut out, &policy.kind);
            out.push_str(", \"grantee\": ");
            push_str(&mut out, &policy.grantee);
            if let Some(pred) = &policy.where_predicate {
                out.push_str(", \"where\": ");
                push_str(&mut out, pred);
            }
            out.push_str(", \"source\": ");
            push_str(&mut out, &policy.source);
            out.push('}');
        }
        if !model.policies.is_empty() {
            out.push_str("\n      ");
        }
        out.push_str("], \"invariants\": [");
        for (j, invariant) in model.invariants.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("\n      {\"predicate\": ");
            push_str(&mut out, &invariant.predicate);
            out.push_str(", \"source\": ");
            push_str(&mut out, &invariant.source);
            out.push('}');
        }
        if !model.invariants.is_empty() {
            out.push_str("\n      ");
        }
        out.push_str("]}");
    }
    if !dump.models.is_empty() {
        out.push('\n');
        out.push_str("  ");
    }
    out.push_str("],\n  \"operations\": [");
    for (i, operation) in dump.operations.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("\n    {\"canonical\": ");
        push_str(&mut out, &operation.canonical);
        out.push_str(", \"kind\": ");
        push_str(&mut out, &operation.kind);
        if let Some(by) = &operation.by {
            out.push_str(", \"by\": ");
            push_str(&mut out, by);
        }
        if let Some(when) = &operation.when {
            out.push_str(", \"when\": ");
            push_str(&mut out, when);
        }
        out.push_str(", \"requires\": [");
        for (j, require) in operation.requires.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            push_str(&mut out, require);
        }
        out.push_str("], \"params\": [");
        for (j, param) in operation.params.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str("{\"name\": ");
            push_str(&mut out, &param.name);
            out.push_str(", \"type\": ");
            push_str(&mut out, &param.typ);
            out.push('}');
        }
        out.push_str("], \"source\": ");
        push_str(&mut out, &operation.source);
        out.push('}');
    }
    if !dump.operations.is_empty() {
        out.push('\n');
        out.push_str("  ");
    }
    out.push_str("]\n}\n");
    out
}

/// JSON string literal (same escapes as the diagnostic envelope).
fn push_str(out: &mut String, value: &str) {
    crate::diagnostic::push_json_str(out, value);
}

/// Current module context while walking one tree.
#[derive(Debug, Clone)]
struct ModuleCtx {
    id: Option<ModuleId>,
    name: String,
}

struct Walker<'a> {
    program: &'a CheckedProgram,
    text: &'a str,
    module: Option<ModuleCtx>,
    dump: &'a mut PolicyDump,
}

impl Walker<'_> {
    fn walk(&mut self, node: &SyntaxNode) {
        match node.kind {
            SyntaxKind::App | SyntaxKind::Package => {
                let name = kids(node)
                    .iter()
                    .find_map(|c| {
                        let n = name_text(c, self.text)?;
                        (n != "app" && n != "package").then_some(n)
                    })
                    .unwrap_or("")
                    .to_string();
                let id = self
                    .program
                    .modules
                    .iter()
                    .find(|m| m.name == name)
                    .map(|m| m.id);
                let saved = self.module.clone();
                self.module = Some(ModuleCtx { id, name });
                for child in &node.children {
                    self.walk(child);
                }
                self.module = saved;
                return;
            }
            SyntaxKind::Role => self.role(node),
            SyntaxKind::Policy => self.policy(node),
            SyntaxKind::Invariant => self.invariant(node),
            SyntaxKind::Scenario => self.scenario(node),
            SyntaxKind::Crud => self.crud(node),
            _ => {}
        }
        for child in &node.children {
            self.walk(child);
        }
    }

    /// Slice a span, trimmed; `""` when the span is unreadable.
    fn slice(&self, span: Span) -> String {
        let (start, end) = (span.start as usize, span.end as usize);
        self.text
            .get(start..end)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }

    /// First non-blank source line of a node, trimmed (header lines
    /// for bodies). Node spans include leading trivia, so blank lines
    /// are skipped rather than read.
    fn first_line(&self, node: &SyntaxNode) -> String {
        let (start, end) = (node.span.start as usize, node.span.end as usize);
        self.text
            .get(start..end)
            .and_then(|body| body.lines().map(str::trim).find(|line| !line.is_empty()))
            .unwrap_or("")
            .to_string()
    }

    /// Canonical identity for a module-local symbol, resolved when the
    /// resolve tables carry it, else `Module.Name` fallback.
    fn canonical(&self, name: &str, want: fn(&SymbolKind) -> bool) -> String {
        let module = self.module.as_ref();
        let found = module.and_then(|m| m.id).and_then(|id| {
            self.program
                .symbols
                .iter()
                .find(|s| s.module == id && s.name == name && want(&s.kind))
        });
        match found {
            Some(symbol) => symbol.canonical.clone(),
            None => format!(
                "{}.{}",
                module.map(|m| m.name.as_str()).unwrap_or("?"),
                name
            ),
        }
    }

    fn model_entry(&mut self, canonical: &str) -> &mut ModelEntry {
        if !self.dump.models.iter().any(|m| m.canonical == canonical) {
            self.dump.models.push(ModelEntry {
                canonical: canonical.to_string(),
                policies: Vec::new(),
                invariants: Vec::new(),
            });
        }
        self.dump
            .models
            .iter_mut()
            .find(|m| m.canonical == canonical)
            .expect("just inserted")
    }

    fn role(&mut self, node: &SyntaxNode) {
        let name = kids(node)
            .iter()
            .find_map(|c| {
                let n = name_text(c, self.text)?;
                (n != "role").then_some(n)
            })
            .unwrap_or("");
        if name.is_empty() {
            return;
        }
        let package = self
            .module
            .as_ref()
            .map(|m| m.name.clone())
            .unwrap_or_default();
        let canonical = self.canonical(name, |k| matches!(k, SymbolKind::Role));
        let label = attribute_value(node, "label", self.text).map(|v| self.slice(v.span));
        self.dump.roles.push(RoleEntry {
            package,
            name: name.to_string(),
            canonical,
            label,
        });
    }

    fn policy(&mut self, node: &SyntaxNode) {
        let target = kids(node)
            .iter()
            .find(|c| c.kind == SyntaxKind::Path)
            .map(|p| path_segments(p, self.text).join("."))
            .unwrap_or_default();
        if target.is_empty() {
            return;
        }
        let model = target.rsplit('.').next().unwrap_or("").to_string();
        if model.is_empty() || model == "preferences" {
            return;
        }
        let canonical = self.canonical(&model, |k| matches!(k, SymbolKind::Model { .. }));
        // `read=` carries the grant; any other first attribute degrades to
        // its key spelling rather than inventing a kind.
        let mut kind = String::new();
        let mut grantee = String::new();
        for child in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Attribute)
        {
            let Some((key, value)) = attribute_parts(child) else {
                continue;
            };
            let Some(key_text) = name_text(key, self.text) else {
                continue;
            };
            if key_text == "where" {
                continue;
            }
            if kind.is_empty() {
                kind = key_text.to_string();
                grantee = self.slice(value.span);
            }
        }
        if kind.is_empty() {
            return;
        }
        let where_predicate = attribute_value(node, "where", self.text).map(|v| self.slice(v.span));
        let source = self.first_line(node);
        self.model_entry(&canonical).policies.push(PolicyEntry {
            kind,
            grantee,
            where_predicate,
            source,
        });
    }

    fn invariant(&mut self, node: &SyntaxNode) {
        let target = kids(node)
            .iter()
            .find(|c| c.kind == SyntaxKind::Path)
            .map(|p| path_segments(p, self.text).join("."))
            .unwrap_or_default();
        let predicate = kids(node)
            .iter()
            .find(|c| is_expression(c.kind))
            .map(|e| self.slice(e.span))
            .unwrap_or_default();
        if target.is_empty() || predicate.is_empty() {
            return;
        }
        let model = target.rsplit('.').next().unwrap_or("").to_string();
        if model.is_empty() || model == "preferences" {
            return;
        }
        let canonical = self.canonical(&model, |k| matches!(k, SymbolKind::Model { .. }));
        let source = self.first_line(node);
        self.model_entry(&canonical)
            .invariants
            .push(InvariantEntry { predicate, source });
    }

    fn scenario(&mut self, node: &SyntaxNode) {
        let name = kids(node)
            .iter()
            .find_map(|c| {
                let n = name_text(c, self.text)?;
                (n != "scenario").then_some(n)
            })
            .unwrap_or("");
        if name.is_empty() {
            return;
        }
        let scenario_id = self.module.as_ref().and_then(|m| m.id).and_then(|id| {
            self.program
                .symbols
                .iter()
                .find(|s| {
                    s.module == id
                        && s.name == name
                        && matches!(s.kind, SymbolKind::Scenario { .. })
                })
                .map(|s| s.id)
        });
        let canonical = scenario_id
            .and_then(|id| self.program.symbols.get(id.0 as usize))
            .map(|s| s.canonical.clone())
            .unwrap_or_else(|| {
                format!(
                    "{}.{}",
                    self.module.as_ref().map(|m| m.name.as_str()).unwrap_or("?"),
                    name
                )
            });
        let by = attribute_value(node, "by", self.text).map(|v| self.slice(v.span));
        let mut requires = Vec::new();
        for child in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Require)
        {
            let predicate = kids(child)
                .iter()
                .find(|c| is_expression(c.kind))
                .map(|e| self.slice(e.span))
                .unwrap_or_default();
            if !predicate.is_empty() {
                requires.push(predicate);
            }
        }
        // Parameters in index order with types-table displays.
        let mut params: Vec<(usize, ParamEntry)> = Vec::new();
        if let Some(owner) = scenario_id {
            for symbol in &self.program.symbols {
                if let SymbolKind::Param {
                    owner: param_owner,
                    index,
                    ..
                } = &symbol.kind
                    && *param_owner == owner
                {
                    let typ = self
                        .program
                        .types
                        .symbol_types
                        .get(&symbol.id)
                        .map(|ty| display_type(self.program, symbol.module, ty))
                        .unwrap_or_else(|| "{unknown}".to_string());
                    params.push((
                        *index,
                        ParamEntry {
                            name: symbol.name.clone(),
                            typ,
                        },
                    ));
                }
            }
        }
        params.sort_by_key(|(index, _)| *index);
        let source = self.first_line(node);
        self.dump.operations.push(OperationEntry {
            canonical,
            kind: "scenario".to_string(),
            by,
            when: None,
            requires,
            params: params.into_iter().map(|(_, p)| p).collect(),
            source,
        });
    }

    fn crud(&mut self, node: &SyntaxNode) {
        let target = kids(node)
            .iter()
            .find(|c| c.kind == SyntaxKind::Path)
            .map(|p| path_segments(p, self.text).join("."))
            .unwrap_or_default();
        let model = target.rsplit('.').next().unwrap_or("").to_string();
        if model.is_empty() {
            return;
        }
        let by = attribute_value(node, "by", self.text).map(|v| self.slice(v.span));
        let when = attribute_value(node, "when", self.text).map(|v| self.slice(v.span));
        let source = self.first_line(node);
        // One entry per generated crud operation the resolve tables carry.
        let model_id = self.module.as_ref().and_then(|m| m.id).and_then(|id| {
            self.program
                .symbols
                .iter()
                .find(|s| {
                    s.module == id && s.name == model && matches!(s.kind, SymbolKind::Model { .. })
                })
                .map(|s| s.id)
        });
        let mut ops: Vec<(u8, String)> = Vec::new();
        if let Some(model_id) = model_id {
            for symbol in &self.program.symbols {
                if let SymbolKind::CrudOp { model: owner, op } = &symbol.kind
                    && *owner == model_id
                {
                    let order = match op {
                        crate::analysis::resolve::CrudOp::Create => 0,
                        crate::analysis::resolve::CrudOp::Update => 1,
                        crate::analysis::resolve::CrudOp::Delete => 2,
                    };
                    ops.push((order, symbol.canonical.clone()));
                }
            }
        }
        ops.sort();
        ops.dedup();
        if ops.is_empty() {
            // Unresolved target: still report the crud header once so the
            // `by=`/`when=` spellings are not silently dropped.
            let module = self.module.as_ref().map(|m| m.name.as_str()).unwrap_or("?");
            ops.push((0, format!("{module}.{model}")));
        }
        for (order, canonical) in ops {
            let kind = match order {
                0 => "create",
                1 => "update",
                _ => "delete",
            }
            .to_string();
            self.dump.operations.push(OperationEntry {
                canonical,
                kind,
                by: by.clone(),
                when: when.clone(),
                requires: Vec::new(),
                params: Vec::new(),
                source: source.clone(),
            });
        }
    }
}

/// Short type display over [`CheckedProgram`] tables, mirroring
/// [`ResolvedType::display`] (which needs the unretained resolve tables).
/// Same-module records render short, others canonical.
fn display_type(program: &CheckedProgram, module: ModuleId, ty: &ResolvedType) -> String {
    let name = |id: SymbolId| -> String {
        program.symbols.get(id.0 as usize).map_or_else(
            || "?".to_string(),
            |s| {
                if s.module == module {
                    s.name.clone()
                } else {
                    s.canonical.clone()
                }
            },
        )
    };
    match ty {
        ResolvedType::Error => "{error}".to_string(),
        ResolvedType::Unknown => "{unknown}".to_string(),
        ResolvedType::Null => "null".to_string(),
        ResolvedType::Scalar(s) => scalar_name(s).to_string(),
        ResolvedType::Team => "Team".to_string(),
        ResolvedType::OperationContext => "OperationContext".to_string(),
        ResolvedType::Enum { cases, .. } => format!("enum({})", cases.join(",")),
        ResolvedType::Record { symbol, .. } => name(*symbol),
        ResolvedType::Message(id) => format!("message {}", name(*id)),
        ResolvedType::Action {
            targets, external, ..
        } => {
            let mut ops: Vec<String> = targets.iter().map(|t| name(*t)).collect();
            ops.extend(external.iter().cloned());
            format!("action({})", ops.join(","))
        }
        ResolvedType::Invocation { targets } => {
            let ops: Vec<String> = targets.iter().map(|t| name(*t)).collect();
            format!("invocation({})", ops.join(","))
        }
        ResolvedType::Delivery { op } => format!("delivery({})", name(*op)),
        // T14c: typed external receipts name their consumed `std`
        // target (mirrors `ResolvedType::display`).
        ResolvedType::StdDelivery { capability, op } => {
            format!("delivery({capability}.{})", op.name)
        }
        ResolvedType::Array { element, .. } => {
            format!("array of {}", display_type(program, module, element))
        }
        ResolvedType::Nullable(inner) => format!("{}?", display_type(program, module, inner)),
        ResolvedType::Union(arms) => arms.iter().map(|a| name(*a)).collect::<Vec<_>>().join("|"),
        ResolvedType::Object(fields) => {
            let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
            format!("object{{{}}}", keys.join(","))
        }
        ResolvedType::Operation(id) => name(*id),
        ResolvedType::Opaque(_) => "{opaque}".to_string(),
    }
}

/// Scalar leaf spelling.
fn scalar_name(scalar: &Scalar) -> &'static str {
    scalar.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::check_program;
    use std::path::PathBuf;

    fn check_source(name: &str, text: String) -> (SourceDb, SourceId, CheckedProgram) {
        let mut db = SourceDb::new();
        let id = db.add(name.to_string(), text);
        let (program, _) = check_program(&db, &[id], None);
        (db, id, program)
    }

    #[test]
    fn minimal_source_dump_reports_every_surface() {
        let text = r#"app Demo
package shop
 Given
  role clerk label="Clerk"
  export Widget {
   title:text,
   price:money,
  }
  policy Widget read=members where=row.price.minor>0
  invariant Widget: row.price.minor>0
 When
  crud Widget by=members fields=title,price
  scenario checkout(cart:Widget) by=clerk
   require cart.price.minor>0
   do set cart {title="sold"}
 Then
  page / title="Shop"
"#;
        let (db, id, program) = check_source("mini.can", text.to_string());
        let dump = policy_dump(&db, &program, &[id]);
        assert_eq!(dump.roles.len(), 1);
        assert_eq!(dump.roles[0].canonical, "shop.clerk");
        assert_eq!(dump.models.len(), 1);
        assert_eq!(dump.models[0].canonical, "shop.Widget");
        assert_eq!(dump.models[0].policies.len(), 1);
        assert_eq!(dump.models[0].policies[0].grantee, "members");
        assert_eq!(
            dump.models[0].policies[0].where_predicate.as_deref(),
            Some("row.price.minor>0")
        );
        assert_eq!(dump.models[0].invariants.len(), 1);
        let ops: Vec<&str> = dump
            .operations
            .iter()
            .map(|o| o.canonical.as_str())
            .collect();
        assert!(ops.contains(&"shop.Widget.create"), "ops: {ops:?}");
        assert!(ops.contains(&"shop.checkout"), "ops: {ops:?}");
        let checkout = dump
            .operations
            .iter()
            .find(|o| o.canonical == "shop.checkout")
            .expect("checkout");
        assert_eq!(checkout.by.as_deref(), Some("clerk"));
        assert_eq!(checkout.requires, vec!["cart.price.minor>0".to_string()]);
        assert_eq!(checkout.params.len(), 1);
        assert_eq!(checkout.params[0].name, "cart");
        assert_eq!(checkout.params[0].typ, "Widget");
    }

    #[test]
    fn golden_expenseflow_policy_dump() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("examples")
            .join("ExpenseFlow.can");
        let text = std::fs::read_to_string(&path).expect("read ExpenseFlow.can");
        let (db, id, program) = check_source("examples/ExpenseFlow.can", text);
        let dump = policy_dump(&db, &program, &[id]);
        let json = policy_dump_json(&dump);
        // Stable content pins (survive formatting shifts).
        for marker in [
            "\"canonical\": \"expenses.reviewer\"",
            "policy Expense read=members where=row.submitted_by==actor",
            "\"grantee\": \"members\"",
            "\"grantee\": \"reviewer\"",
            "invariant Expense: row.amount.minor>0",
            "\"predicate\": \"row.amount.minor>0\"",
            "\"canonical\": \"expenses.submit\"",
            "\"canonical\": \"expenses.approve\"",
            "\"canonical\": \"expenses.reject\"",
            "\"by\": \"reviewer\"",
            "expense.status==submitted and expense.submitted_by!=actor",
            "\"canonical\": \"expenses.Expense.create\"",
            "\"canonical\": \"expenses.Expense.update\"",
            "\"canonical\": \"reporting.summarize\"",
        ] {
            assert!(json.contains(marker), "missing marker: {marker}\n{json}");
        }
        assert!(
            !json.contains("expenses.Expense.delete"),
            "delete=none:\n{json}"
        );
        assert_eq!(json, EXPECTED_EXPENSEFLOW_JSON);
    }

    const EXPECTED_EXPENSEFLOW_JSON: &str = r#"{
  "version": 1,
  "roles": [
    {"package": "expenses", "name": "reviewer", "canonical": "expenses.reviewer", "label": "\"Reviewer\"@{nl=\"Beoordelaar\"}"}
  ],
  "models": [
    {"canonical": "expenses.Expense", "policies": [
      {"kind": "read", "grantee": "members", "where": "row.submitted_by==actor", "source": "policy Expense read=members where=row.submitted_by==actor"},
      {"kind": "read", "grantee": "reviewer", "source": "policy Expense read=reviewer"}
      ], "invariants": [
      {"predicate": "row.amount.minor>0", "source": "invariant Expense: row.amount.minor>0"}
      ]}
  ],
  "operations": [
    {"canonical": "expenses.Expense.create", "kind": "create", "by": "members", "when": "row.submitted_by==actor and row.status==draft", "requires": [], "params": [], "source": "crud Expense by=members fields=purpose,amount when=row.submitted_by==actor and row.status==draft delete=none"},
    {"canonical": "expenses.Expense.update", "kind": "update", "by": "members", "when": "row.submitted_by==actor and row.status==draft", "requires": [], "params": [], "source": "crud Expense by=members fields=purpose,amount when=row.submitted_by==actor and row.status==draft delete=none"},
    {"canonical": "expenses.submit", "kind": "scenario", "by": "members", "requires": ["expense.submitted_by==actor and expense.status==draft"], "params": [{"name": "expense", "type": "Expense"}], "source": "scenario submit(expense:Expense) by=members"},
    {"canonical": "expenses.approve", "kind": "scenario", "by": "reviewer", "requires": ["expense.status==submitted and expense.submitted_by!=actor"], "params": [{"name": "expense", "type": "Expense"}, {"name": "note", "type": "text?"}], "source": "scenario approve(expense:Expense,note:text? label=label_Expense_decision_note) by=reviewer label=\"Approve expense\"@{nl=\"Onkost goedkeuren\"}"},
    {"canonical": "expenses.reject", "kind": "scenario", "by": "reviewer", "requires": ["expense.status==submitted and expense.submitted_by!=actor and trim(note)!=\"\""], "params": [{"name": "expense", "type": "Expense"}, {"name": "note", "type": "text"}], "source": "scenario reject(expense:Expense,note:text label=label_Expense_decision_note) by=reviewer label=\"Reject expense\"@{nl=\"Onkost afwijzen\"}"},
    {"canonical": "reporting.summarize", "kind": "scenario", "by": "members", "requires": [], "params": [{"name": "currency", "type": "currency"}, {"name": "status", "type": "enum(draft,submitted,approved,rejected)"}], "source": "scenario summarize(currency:currency,status:Expense.status) read=true -> Summary by=members label=\"Summarize expenses\"@{nl=\"Onkosten samenvatten\"}"}
  ]
}
"#;
}
