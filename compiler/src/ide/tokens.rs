//! Semantic tokens: legend plus delta-encoded token data.
//!
//! Tokens derive from CST leaf kinds plus resolved symbol kinds where
//! the analysis tables have them (declaration names, `NameRef`
//! bindings, type-position paths). Member-navigation names and other
//! unresolved positions fall back to syntactic coloring (`property`
//! for member names, `type` for annotation paths) or to no token when
//! no role is certain. Editor coloring is a fallback, never a second
//! checker: when in doubt this provider emits nothing.
//!
//! [`TOKEN_TYPES`] and [`TOKEN_MODIFIERS`] are the single source of
//! truth for the legend; the LSP server advertises exactly these.

use crate::analysis::NodeKey;
use crate::analysis::resolve::{Binding, SymbolKind};
use crate::ide::queries::{LocalKind, Snapshot};
use crate::source::LineIndex;
use crate::syntax::{SyntaxKind, SyntaxNode};

/// Semantic token type legend (LSP `tokenTypes`), in index order.
pub const TOKEN_TYPES: &[&str] = &[
    "namespace",
    "type",
    "class",
    "interface",
    "enum",
    "struct",
    "parameter",
    "variable",
    "property",
    "enumMember",
    "event",
    "function",
    "method",
    "keyword",
    "comment",
    "string",
    "number",
    "operator",
];

/// Semantic token modifier legend (LSP `tokenModifiers`), in bit order.
pub const TOKEN_MODIFIERS: &[&str] =
    &["declaration", "documentation", "defaultLibrary", "readonly"];

const MOD_DECLARATION: u32 = 1 << 0;
const MOD_DOCUMENTATION: u32 = 1 << 1;
const MOD_DEFAULT_LIBRARY: u32 = 1 << 2;
const MOD_READONLY: u32 = 1 << 3;

/// Legend as owned strings for capability advertisement.
pub fn legend() -> (Vec<String>, Vec<String>) {
    (
        TOKEN_TYPES.iter().map(|t| (*t).to_string()).collect(),
        TOKEN_MODIFIERS.iter().map(|t| (*t).to_string()).collect(),
    )
}

/// Full-document semantic tokens as LSP delta-encoded data
/// (`[line, col, len, type, mods, ...]`). Positions and lengths count
/// UTF-16 code units. Never fails; unresolvable leaves emit nothing.
pub fn semantic_tokens(snapshot: &Snapshot) -> Vec<u32> {
    let text = snapshot.text();
    let index = LineIndex::new(text);
    let mut classified: Vec<(u32, u32, u32, u32, u32)> = Vec::new();
    walk_inner(
        snapshot,
        text,
        &index,
        snapshot.tree(),
        None,
        &mut classified,
    );
    let mut data = Vec::with_capacity(classified.len() * 5);
    let mut prev_line = 0u32;
    let mut prev_col = 0u32;
    for (line, col, len, ty, mods) in classified {
        let delta_line = line - prev_line;
        let delta_col = if delta_line == 0 { col - prev_col } else { col };
        data.extend([delta_line, delta_col, len, ty, mods]);
        prev_line = line;
        prev_col = col;
    }
    data
}

/// One classified leaf: line, UTF-16 column, UTF-16 length, type, mods.
fn push_token(
    text: &str,
    index: &LineIndex,
    node: &SyntaxNode,
    ty: &str,
    mods: u32,
    out: &mut Vec<(u32, u32, u32, u32, u32)>,
) {
    let Some(type_index) = TOKEN_TYPES.iter().position(|t| *t == ty) else {
        return;
    };
    let (line, col) = index.to_lsp(text, node.span.start, true);
    let slice = text
        .get(node.span.start as usize..node.span.end as usize)
        .unwrap_or("");
    let len: u32 = slice.chars().map(|c| c.len_utf16() as u32).sum();
    if len == 0 {
        return;
    }
    out.push((line, col, len, type_index as u32, mods));
}

/// Walk the tree in document order, classifying leaves.
fn walk_inner(
    snapshot: &Snapshot,
    text: &str,
    index: &LineIndex,
    node: &SyntaxNode,
    parent: Option<&SyntaxNode>,
    out: &mut Vec<(u32, u32, u32, u32, u32)>,
) {
    match node.kind {
        SyntaxKind::Comment => push_token(text, index, node, "comment", 0, out),
        SyntaxKind::Description => {
            push_token(text, index, node, "comment", MOD_DOCUMENTATION, out);
        }
        SyntaxKind::String => push_token(text, index, node, "string", 0, out),
        SyntaxKind::Integer | SyntaxKind::Decimal | SyntaxKind::Duration | SyntaxKind::Bytes => {
            push_token(text, index, node, "number", 0, out);
        }
        SyntaxKind::Punct => push_token(text, index, node, "operator", 0, out),
        SyntaxKind::Name => {
            if let Some((ty, mods)) = classify_name(snapshot, text, node, parent) {
                push_token(text, index, node, ty, mods, out);
            }
        }
        _ => {}
    }
    if node.is_leaf() {
        return;
    }
    for child in &node.children {
        walk_inner(snapshot, text, index, child, Some(node), out);
    }
}

/// Classify a `Name` leaf: declarations and resolved uses first, then
/// syntactic keyword roles, else no token.
fn classify_name(
    snapshot: &Snapshot,
    text: &str,
    node: &SyntaxNode,
    parent: Option<&SyntaxNode>,
) -> Option<(&'static str, u32)> {
    let tables = snapshot.tables();
    // Declaration names match symbol spans exactly.
    if let Some(symbol) = tables.symbols.iter().find(|s| s.span == node.span) {
        return Some((symbol_token_type(&symbol.kind), MOD_DECLARATION));
    }
    // Local declaration names match the locals index.
    if let Some(construct) = parent
        && let Some((_, kind)) = snapshot.local_at(&NodeKey::of(construct))
    {
        // Only the declaration's own name token, not sibling keywords.
        if parent_is_decl_construct(construct, node, text) {
            return Some((local_token_type(kind), MOD_DECLARATION));
        }
    }
    let word = node.token().map(|t| t.text(text)).unwrap_or("");
    let parent_kind = parent.map(|p| p.kind);
    match parent_kind {
        Some(SyntaxKind::NameRef) => {
            let binding = tables
                .node_binding
                .get(&NodeKey::of(parent.expect("matched")))?;
            match binding {
                Binding::Symbol(id) => {
                    let symbol = tables.symbols.get(id.0 as usize)?;
                    Some((symbol_token_type(&symbol.kind), 0))
                }
                Binding::Builtin { .. } => Some(("function", MOD_DEFAULT_LIBRARY)),
                Binding::Predicate => Some(("keyword", 0)),
                Binding::Context(_) => Some(("variable", MOD_READONLY)),
                Binding::External { .. } => Some(("variable", 0)),
                Binding::Let { .. }
                | Binding::QueryAlias { .. }
                | Binding::ForItem { .. }
                | Binding::CreateAs { .. }
                | Binding::CallAs { .. }
                | Binding::SendAs { .. }
                | Binding::RouteParam { .. } => Some(("variable", 0)),
                Binding::Error => None,
            }
        }
        Some(SyntaxKind::Path) => Some(classify_path_segment(snapshot, text, node, parent)),
        Some(SyntaxKind::Member) => {
            // Member-navigation names have no resolution entry (analysis
            // records only failures); color the syntactic role.
            Some(("property", 0))
        }
        Some(SyntaxKind::ObjectEntry) => Some(("property", 0)),
        Some(SyntaxKind::ImportMember) => Some(("variable", 0)),
        Some(SyntaxKind::LabelCase | SyntaxKind::OrderCase) => Some(("enumMember", 0)),
        Some(SyntaxKind::MatchArm) => {
            if is_first_name_child(parent.expect("matched"), node) {
                Some(("keyword", 0))
            } else {
                Some(("enumMember", 0))
            }
        }
        Some(SyntaxKind::Attribute) => {
            if is_first_name_child(parent.expect("matched"), node) {
                Some(("keyword", 0))
            } else {
                None
            }
        }
        Some(SyntaxKind::QueryClause) => {
            if is_first_name_child(parent.expect("matched"), node) {
                Some(("keyword", 0))
            } else {
                Some(("variable", 0))
            }
        }
        Some(SyntaxKind::Binary | SyntaxKind::Unary) => {
            if matches!(word, "and" | "or" | "not" | "in" | "is") {
                Some(("keyword", 0))
            } else {
                None
            }
        }
        Some(SyntaxKind::Literal) => {
            if matches!(word, "true" | "false" | "null") {
                Some(("keyword", 0))
            } else {
                None
            }
        }
        _ => {
            if word == "export" && is_first_name_child_opt(parent, node) {
                return Some(("keyword", 0));
            }
            if is_introducer(parent_kind, word) && is_first_name_child_opt(parent, node) {
                return Some(("keyword", 0));
            }
            // `as` alias markers, `by`/`request` example markers,
            // `when` send guards and `at`/`event` schedule markers.
            if matches!(word, "as" | "by" | "request" | "when")
                && matches!(
                    parent_kind,
                    Some(
                        SyntaxKind::ImportMember
                            | SyntaxKind::Create
                            | SyntaxKind::Call
                            | SyntaxKind::Send
                            | SyntaxKind::ExampleCall
                    )
                )
            {
                return Some(("keyword", 0));
            }
            if matches!(word, "at" | "event") && parent_kind == Some(SyntaxKind::Schedule) {
                return Some(("keyword", 0));
            }
            if matches!(word, "for" | "in" | "limit") && parent_kind == Some(SyntaxKind::For) {
                return Some(("keyword", 0));
            }
            if word == "match" && parent_kind == Some(SyntaxKind::Match) {
                return Some(("keyword", 0));
            }
            if matches!(word, "if" | "else") && parent_kind == Some(SyntaxKind::If) {
                return Some(("keyword", 0));
            }
            if matches!(word, "to" | "owner" | "before")
                && matches!(
                    parent_kind,
                    Some(SyntaxKind::Rename | SyntaxKind::Drop | SyntaxKind::Invalidate)
                )
            {
                return Some(("keyword", 0));
            }
            None
        }
    }
}

/// Whether `node` is the declared name (not a sibling keyword) of a
/// local-binding construct.
fn parent_is_decl_construct(construct: &SyntaxNode, node: &SyntaxNode, text: &str) -> bool {
    let word = node.token().map(|t| t.text(text)).unwrap_or("");
    match construct.kind {
        // The name follows its marker; the marker itself is also a `Name`.
        SyntaxKind::Let => word != "let",
        SyntaxKind::QueryClause => word != "as",
        SyntaxKind::For => word != "for" && word != "in" && word != "limit",
        SyntaxKind::Create | SyntaxKind::Call | SyntaxKind::Send => word != "as" && word != "when",
        SyntaxKind::RouteScalar => true,
        _ => false,
    }
}

/// Token type for a local declaration name.
fn local_token_type(kind: &LocalKind) -> &'static str {
    match kind {
        LocalKind::RouteParam => "parameter",
        _ => "variable",
    }
}

/// Token type for a type-position path segment.
fn classify_path_segment(
    snapshot: &Snapshot,
    text: &str,
    node: &SyntaxNode,
    parent: Option<&SyntaxNode>,
) -> (&'static str, u32) {
    let tables = snapshot.tables();
    let path = parent.expect("path parent");
    if let Some(typeref) = tables.node_typeref.get(&NodeKey::of(path)) {
        match typeref {
            crate::analysis::resolve::TypeRef::Scalar(_) => {
                return ("type", MOD_DEFAULT_LIBRARY);
            }
            crate::analysis::resolve::TypeRef::Symbol(_) => return ("type", 0),
            crate::analysis::resolve::TypeRef::FieldChain {
                fields, consumed, ..
            } => {
                let word = node.token().map(|t| t.text(text)).unwrap_or("");
                if tables.module_by_name.contains_key(word) {
                    return ("namespace", 0);
                }
                let segments: Vec<&SyntaxNode> = path
                    .children
                    .iter()
                    .filter(|c| c.kind == SyntaxKind::Name)
                    .collect();
                let here = segments
                    .iter()
                    .position(|s| s.span == node.span)
                    .unwrap_or(0);
                let field_base = consumed.saturating_sub(fields.len());
                if here < field_base {
                    return ("type", 0);
                }
                return ("property", 0);
            }
            crate::analysis::resolve::TypeRef::External => return ("type", 0),
        }
    }
    if tables.node_symbol.contains_key(&NodeKey::of(path)) {
        return ("type", 0);
    }
    // Unresolved paths: syntactic fallback by position.
    let word = node.token().map(|t| t.text(text)).unwrap_or("");
    if tables.module_by_name.contains_key(word) {
        return ("namespace", 0);
    }
    // Selectors and label paths name fields.
    ("property", 0)
}

/// Token type for a declared or referenced symbol.
fn symbol_token_type(kind: &SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Model { .. } => "class",
        SymbolKind::Contract { .. } => "interface",
        SymbolKind::Event { .. } => "event",
        SymbolKind::Role => "enum",
        SymbolKind::Capability { .. } => "class",
        SymbolKind::CapabilityOp { .. } => "method",
        SymbolKind::Message { .. } => "function",
        SymbolKind::Fixture { .. } => "variable",
        SymbolKind::Scenario { .. } => "function",
        SymbolKind::Crud { .. } => "class",
        SymbolKind::CrudOp { .. } => "method",
        SymbolKind::Field { .. } => "property",
        SymbolKind::Param { .. } => "parameter",
        SymbolKind::DeriveField { .. } => "property",
        SymbolKind::DeriveFn { .. } => "function",
        SymbolKind::Preferences { .. } => "struct",
    }
}

/// Whether `word` is the fixed introducer of a `parent_kind` header.
fn is_introducer(parent_kind: Option<SyntaxKind>, word: &str) -> bool {
    matches!(
        (parent_kind, word),
        (Some(SyntaxKind::App), "app")
            | (Some(SyntaxKind::Package), "package")
            | (Some(SyntaxKind::Migration), "migration")
            | (Some(SyntaxKind::Context), "context")
            | (Some(SyntaxKind::ContextDecl), "theme")
            | (Some(SyntaxKind::ContextDecl), "files")
            | (Some(SyntaxKind::ContextDecl), "locale")
            | (Some(SyntaxKind::ContextDecl), "binding")
            | (Some(SyntaxKind::ContextDecl), "queue")
            | (Some(SyntaxKind::ContextDecl), "cache")
            | (Some(SyntaxKind::ContextDecl), "analytics")
            | (Some(SyntaxKind::Import), "use")
            | (Some(SyntaxKind::Preferences), "preferences")
            | (Some(SyntaxKind::Contract), "contract")
            | (Some(SyntaxKind::Event), "event")
            | (Some(SyntaxKind::Role), "role")
            | (Some(SyntaxKind::Derive), "derive")
            | (Some(SyntaxKind::Policy), "policy")
            | (Some(SyntaxKind::Invariant), "invariant")
            | (Some(SyntaxKind::Unique), "unique")
            | (Some(SyntaxKind::Lock), "lock")
            | (Some(SyntaxKind::Retain), "retain")
            | (Some(SyntaxKind::Fixture), "fixture")
            | (Some(SyntaxKind::Capability), "capability")
            | (Some(SyntaxKind::Message), "message")
            | (Some(SyntaxKind::Crud), "crud")
            | (Some(SyntaxKind::Scenario), "scenario")
            | (Some(SyntaxKind::DoBlock), "do")
            | (Some(SyntaxKind::Let), "let")
            | (Some(SyntaxKind::Create), "create")
            | (Some(SyntaxKind::Set), "set")
            | (Some(SyntaxKind::Transition), "transition")
            | (Some(SyntaxKind::Delete), "delete")
            | (Some(SyntaxKind::Call), "call")
            | (Some(SyntaxKind::Emit), "emit")
            | (Some(SyntaxKind::Send), "send")
            | (Some(SyntaxKind::Schedule), "schedule")
            | (Some(SyntaxKind::Cancel), "cancel")
            | (Some(SyntaxKind::Return), "return")
            | (Some(SyntaxKind::Require), "require")
            | (Some(SyntaxKind::Examples), "examples")
            | (Some(SyntaxKind::Page), "page")
            | (Some(SyntaxKind::Card), "card")
            | (Some(SyntaxKind::Details), "details")
            | (Some(SyntaxKind::Tabs), "tabs")
            | (Some(SyntaxKind::Tab), "tab")
            | (Some(SyntaxKind::Collection), "list")
            | (Some(SyntaxKind::Collection), "table")
            | (Some(SyntaxKind::Collection), "board")
            | (Some(SyntaxKind::Collection), "calendar")
            | (Some(SyntaxKind::Form), "form")
            | (Some(SyntaxKind::Edit), "edit")
            | (Some(SyntaxKind::Rename), "rename")
            | (Some(SyntaxKind::Drop), "drop")
            | (Some(SyntaxKind::Invalidate), "invalidate")
            | (Some(SyntaxKind::Backfill), "backfill")
    ) || matches!(parent_kind, Some(SyntaxKind::Section))
        || matches!(parent_kind, Some(SyntaxKind::UiLeaf))
}

/// Whether `node` is the first `Name` child of `parent`.
fn is_first_name_child(parent: &SyntaxNode, node: &SyntaxNode) -> bool {
    parent
        .children
        .iter()
        .find(|c| c.kind == SyntaxKind::Name)
        .is_some_and(|first| first.span == node.span)
}

fn is_first_name_child_opt(parent: Option<&SyntaxNode>, node: &SyntaxNode) -> bool {
    parent.is_some_and(|p| is_first_name_child(p, node))
}
