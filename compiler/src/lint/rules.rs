//! First lint rule set: deprecated, unreachable, unused, shadowing,
//! redundant null-handling and description nits.
//!
//! Every rule carries an id, title and rationale (see [`RULES`]), warns
//! (never errors) with a precise span, and never duplicates a compiler
//! `E` code. Rules that cannot be both useful and false-positive-free
//! are left out; the bounds are documented on each rule:
//!
//! - `??` on a non-null left is `E3004` in strict positions, so no lint
//!   covers it (a lint would duplicate the error); `?.` on a non-null
//!   receiver is silently accepted by the checker and is the
//!   `redundant-null-marker` rule instead. A literal `T?` annotation is
//!   never redundant (it widens the accepted value set), so the rule
//!   covers null-*handling* markers only.
//! - `require` with an exact literal-`false` predicate always rejects
//!   and counts as terminal for `unreachable-statement`; anything more
//!   complex (`false and x`, grouped literals) is left out, as is
//!   scenario-level `require false` (only `do`/`if`/`for` statement
//!   lists are analyzed). `return` is not terminal for the lint:
//!   statements after it are `E4030` (error), and lints never
//!   duplicate a compiler `E` code.
//! - `unused-binding` covers `let` and query aliases only
//!   (`for`/`create`/`call`/`send` bindings are out of scope); a
//!   same-named binding anywhere in the enclosing `do` block suppresses
//!   the finding rather than risk attribution.
//! - `shadowed-binding` covers a nested `let` hiding a top-level `let`
//!   of the same `do` block only, and only when the outer binding is
//!   still referenced nearby. Contextual names (which would be `E2012`)
//!   are excluded.
//! - `duplicate-description` compares prose only: `#=` references exist
//!   for reuse (GRAMMAR), so flagging shared references would be noise.
//! - No rule offers a fix that removes or renames an author-visible
//!   binding, migrates a deprecation, or deletes a description: those
//!   need an authored decision. Fixes exist only for dead-statement
//!   removal and `?.`-to-`.` narrowing.
//!
//! Every rule skips subtrees that already contain `Error`/`BadToken`
//! nodes (already diagnosed by the parser): lints never pile onto
//! syntax errors.

use std::collections::{HashMap, HashSet};

use crate::analysis::{CheckedProgram, NodeKey};
use crate::diagnostic::{Diagnostic, Related, Severity};
use crate::source::Span;
use crate::syntax::{NodeDetail, SyntaxKind, SyntaxNode};

use super::driver::{DeprecatedSet, RuleSet};

/// Rule metadata: id, code, title, rationale and normative basis.
#[derive(Debug, Clone, Copy)]
pub struct RuleMeta {
    /// Kebab-case rule id, used as the fix `rule` tag.
    pub id: &'static str,
    /// Stable diagnostic code.
    pub code: &'static str,
    /// Short title.
    pub title: &'static str,
    /// Severity findings under this rule carry (never `Error`).
    pub severity: Severity,
    /// Why the rule exists.
    pub rationale: &'static str,
    /// Normative basis, or heuristic-with-conservative-bounds.
    pub basis: &'static str,
}

/// The shipped rule table.
pub const RULES: [RuleMeta; 7] = [
    RuleMeta {
        id: "deprecated-builtin",
        code: "W3001",
        title: "deprecated-capability",
        severity: Severity::Warning,
        rationale: "A call still resolves but its producer has marked it \
            deprecated with a migration notice; surfacing the notice at \
            the call site keeps migrations visible.",
        basis: "DIAGNOSTICS.md severity table (deprecated capability); \
            DESIGN §3 closed builtin catalog; producer `deprecation` field.",
    },
    RuleMeta {
        id: "unreachable-statement",
        code: "W1001",
        title: "unreachable-effect",
        severity: Severity::Warning,
        rationale: "Statements after unconditional termination can never \
            execute; they are dead weight that misleads readers about \
            control flow.",
        basis: "DESIGN §5.1 (`require` rejection); DIAGNOSTICS.md \
            unreachable-execution. Statements after `return` are the \
            E4030 analysis error, never this lint.",
    },
    RuleMeta {
        id: "unused-binding",
        code: "I1001",
        title: "unused-symbol",
        severity: Severity::Info,
        rationale: "A `let` or query alias that is never read adds \
            nothing; removing it (an authored decision, never an \
            autofix) simplifies the code.",
        basis: "Heuristic-with-conservative-bounds over DESIGN §3 \
            lexical binding and GRAMMAR query-alias scope; Info per \
            DIAGNOSTICS.md (proven unused pure local).",
    },
    RuleMeta {
        id: "shadowed-binding",
        code: "W2001",
        title: "suspicious-shadowing",
        severity: Severity::Warning,
        rationale: "A nested `let` hiding an outer `let` that is still \
            referenced nearby is usually an accident (e.g. an intended \
            update that became a shadow).",
        basis: "DESIGN §3 (nested shadowing legal; same-scope dupes are \
            E2002; contextual shadowing is E2012); DIAGNOSTICS.md \
            safe-but-suspicious shadowing (opt-in).",
    },
    RuleMeta {
        id: "redundant-null-marker",
        code: "I1002",
        title: "redundant-marker",
        severity: Severity::Info,
        rationale: "`?.` on a provably non-null receiver misleads \
            readers into expecting nullability where none exists.",
        basis: "Heuristic-with-conservative-bounds over the analysis \
            type table (`is_proven_nonnull`; the checker's own E3003 \
            rule establishes `.` as sound on non-null); Info per \
            DIAGNOSTICS.md (redundant equivalent guards).",
    },
    RuleMeta {
        id: "empty-description",
        code: "I1003",
        title: "empty-description",
        severity: Severity::Info,
        rationale: "A `#` description that carries no prose is vacuous \
            metadata; it should say something or go away.",
        basis: "GRAMMAR Descriptions (prose marker rules); Info \
            (redundant metadata).",
    },
    RuleMeta {
        id: "duplicate-description",
        code: "I1004",
        title: "duplicate-description",
        severity: Severity::Info,
        rationale: "Adjacent siblings sharing an identical description \
            usually means copy-paste: each declaration deserves its own \
            description.",
        basis: "GRAMMAR Descriptions; Info (redundant metadata). \
            `#=` references excluded: reuse is their purpose.",
    },
];

/// One rule finding: the diagnostic plus an optional safe fix.
pub(crate) struct Finding {
    pub diagnostic: Diagnostic,
    pub fix: Option<PendingFix>,
}

/// A fix before the driver attaches the source hash.
#[derive(Debug, Clone)]
pub(crate) struct PendingFix {
    pub rule: &'static str,
    pub title: String,
    pub span: Span,
    pub replacement: String,
}

/// Shared rule input for one source file.
pub(crate) struct RuleCtx<'a> {
    pub program: &'a CheckedProgram,
    pub text: &'a str,
    pub deprecated: Option<&'a DeprecatedSet>,
    /// Program-wide symbol names plus import aliases (conservative
    /// superset used to suppress ambiguous findings).
    pub declared: &'a HashSet<String>,
}

/// Run every enabled rule over one parsed file.
pub(crate) fn check_file(
    ctx: &RuleCtx<'_>,
    tree: &SyntaxNode,
    enabled: &RuleSet,
    out: &mut Vec<Finding>,
) {
    if enabled.deprecated {
        rule_deprecated(ctx, tree, out);
    }
    if enabled.unreachable_code {
        rule_unreachable(ctx, tree, out);
    }
    if enabled.unused {
        rule_unused_let(ctx, tree, out);
        rule_unused_alias(ctx, tree, out);
    }
    if enabled.shadowing {
        rule_shadowing(ctx, tree, out);
    }
    if enabled.redundant_null {
        rule_redundant_null(ctx, tree, out);
    }
    if enabled.description_nits {
        rule_descriptions(ctx, tree, out);
    }
}

// --- Local CST helpers (self-contained; analysis-owned helpers are
// --- sibling-owned and must not be modified, so they are not reused) ---

/// Significant children: skips `Trivia`/`Comment` leaves.
fn kids(node: &SyntaxNode) -> Vec<&SyntaxNode> {
    node.children
        .iter()
        .filter(|c| !matches!(c.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
        .collect()
}

/// Source text of a token leaf, if `node` is one.
fn token_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    node.token().map(|token| token.text(text))
}

/// Text of a `Name` leaf, if `node` is one.
fn name_text<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        token_text(node, text)
    } else {
        None
    }
}

/// Whether `node` is a `Name` leaf with spelling `word`.
fn is_name(node: &SyntaxNode, text: &str, word: &str) -> bool {
    name_text(node, text) == Some(word)
}

/// Whether the subtree already holds a syntax error (parser-diagnosed).
fn has_errors(node: &SyntaxNode) -> bool {
    node.descendants()
        .any(|n| matches!(n.kind, SyntaxKind::Error | SyntaxKind::BadToken))
}

/// `(name, name span)` of a `let` statement, if well-formed.
fn let_binding<'a>(node: &SyntaxNode, text: &'a str) -> Option<(&'a str, Span)> {
    let parts = kids(node);
    if node.kind == SyntaxKind::Let
        && parts.len() >= 4
        && is_name(parts[0], text, "let")
        && parts[1].kind == SyntaxKind::Name
    {
        Some((name_text(parts[1], text)?, parts[1].span))
    } else {
        None
    }
}

/// Alias of an `as` query clause, if `node` is one.
fn query_alias_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<(&'a str, Span)> {
    let parts = kids(node);
    if node.kind == SyntaxKind::QueryClause
        && parts.len() == 2
        && is_name(parts[0], text, "as")
        && parts[1].kind == SyntaxKind::Name
    {
        Some((name_text(parts[1], text)?, parts[1].span))
    } else {
        None
    }
}

/// Item name of a `for` statement, if well-formed.
fn for_item_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    let parts = kids(node);
    if node.kind == SyntaxKind::For
        && parts.len() >= 2
        && is_name(parts[0], text, "for")
        && parts[1].kind == SyntaxKind::Name
    {
        name_text(parts[1], text)
    } else {
        None
    }
}

/// `as` binding of a `create`/`call`/`send` effect, if present.
/// Expression calls never carry a direct `as` child, so this is `None`
/// for them.
fn as_binding_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if !matches!(
        node.kind,
        SyntaxKind::Create | SyntaxKind::Call | SyntaxKind::Send
    ) {
        return None;
    }
    let parts = kids(node);
    for pair in parts.windows(2) {
        if is_name(pair[0], text, "as") && pair[1].kind == SyntaxKind::Name {
            return name_text(pair[1], text);
        }
    }
    None
}

/// Declared name of a `Parameter` (`name:type`) or `Fixture`
/// (`fixture name=...`) node.
fn declared_binding_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    let parts = kids(node);
    match node.kind {
        SyntaxKind::Parameter => {
            if parts
                .first()
                .is_some_and(|first| first.kind == SyntaxKind::Name)
            {
                name_text(parts[0], text)
            } else {
                None
            }
        }
        SyntaxKind::Fixture => {
            for pair in parts.windows(2) {
                if is_name(pair[0], text, "fixture") && pair[1].kind == SyntaxKind::Name {
                    return name_text(pair[1], text);
                }
            }
            None
        }
        _ => None,
    }
}

/// Consumer-side name of an import member (`Name` or `Alias`).
fn import_member_name<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind != SyntaxKind::ImportMember {
        return None;
    }
    let parts = kids(node);
    if parts.len() == 4 && is_name(parts[2], text, "as") && parts[3].kind == SyntaxKind::Name {
        name_text(parts[3], text)
    } else if parts.len() == 1 && parts[0].kind == SyntaxKind::Name {
        name_text(parts[0], text)
    } else {
        None
    }
}

/// Every authored binding name in one app/package/migration subtree.
///
/// A conservative visibility superset for the deprecated rule: a call
/// whose name is bound anywhere in the unit may resolve to that
/// binding instead of the builtin, so the rule stays silent.
fn collect_unit_bindings(unit: &SyntaxNode, text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for node in unit.descendants() {
        let name = match node.kind {
            SyntaxKind::Let => let_binding(node, text).map(|(name, _)| name),
            SyntaxKind::QueryClause => query_alias_name(node, text).map(|(alias, _)| alias),
            SyntaxKind::For => for_item_name(node, text),
            SyntaxKind::Create | SyntaxKind::Call | SyntaxKind::Send => as_binding_name(node, text),
            SyntaxKind::Parameter | SyntaxKind::Fixture => declared_binding_name(node, text),
            SyntaxKind::ImportMember => import_member_name(node, text),
            _ => None,
        };
        if let Some(name) = name {
            out.insert(name.to_string());
        }
    }
    out
}

/// One lexical read: the spelling plus the precise name-token span.
type Read = (String, Span);

/// Collect every read of a lexical name in `node`'s subtree:
/// `NameRef` spellings, single-name `ObjectEntry` shorthand (`{x}`),
/// and `set`/`delete` target paths. Type/import/route/selector paths
/// never denote locals and are not collected.
fn collect_reads(node: &SyntaxNode, text: &str, out: &mut Vec<Read>) {
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        match current.kind {
            SyntaxKind::NameRef => {
                if let Some(name) = kids(current)
                    .iter()
                    .find(|c| c.kind == SyntaxKind::Name)
                    .and_then(|leaf| name_text(leaf, text))
                {
                    let span = kids(current)
                        .iter()
                        .find(|c| c.kind == SyntaxKind::Name)
                        .map(|leaf| leaf.span)
                        .unwrap_or(current.span);
                    out.push((name.to_string(), span));
                }
            }
            SyntaxKind::ObjectEntry => {
                // A single-child entry is the `{field}` shorthand, which
                // reads the same-named local (parser `parse_object`).
                let parts = kids(current);
                if parts.len() == 1
                    && parts[0].kind == SyntaxKind::Name
                    && let Some(name) = name_text(parts[0], text)
                {
                    out.push((name.to_string(), parts[0].span));
                }
            }
            SyntaxKind::Set | SyntaxKind::Transition | SyntaxKind::Delete => {
                for child in kids(current) {
                    if child.kind == SyntaxKind::Path {
                        for segment in kids(child) {
                            if segment.kind == SyntaxKind::Name
                                && let Some(name) = name_text(segment, text)
                            {
                                out.push((name.to_string(), segment.span));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        stack.extend(current.children.iter());
    }
}

/// Count every shadowing-capable binding per spelling in a subtree
/// (`let`, query alias, `for` item, effect `as`).
fn count_bindings(node: &SyntaxNode, text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for current in node.descendants() {
        let name = match current.kind {
            SyntaxKind::Let => let_binding(current, text).map(|(name, _)| name),
            SyntaxKind::QueryClause => query_alias_name(current, text).map(|(alias, _)| alias),
            SyntaxKind::For => for_item_name(current, text),
            SyntaxKind::Create | SyntaxKind::Call | SyntaxKind::Send => {
                as_binding_name(current, text)
            }
            _ => None,
        };
        if let Some(name) = name {
            *counts.entry(name.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

/// Active contextual facts: authoring one of these where the fact is
/// active is `E2012`, never a lint.
fn is_contextual_fact(name: &str) -> bool {
    matches!(
        name,
        "actor"
            | "team"
            | "now"
            | "operation"
            | "row"
            | "event"
            | "preferences"
            | "result"
            | "before"
    )
}

/// Contextual facts plus actor predicates: shadowing one of these is
/// either `E2012` or attribution-uncertain (predicate positions may
/// resolve specially), never a lint.
fn is_contextual_or_predicate(name: &str) -> bool {
    is_contextual_fact(name) || matches!(name, "members" | "owner" | "authenticated" | "public")
}

fn push(
    out: &mut Vec<Finding>,
    rule: &RuleMeta,
    message: String,
    primary: Span,
    related: Vec<Related>,
    fix: Option<PendingFix>,
) {
    out.push(Finding {
        diagnostic: Diagnostic {
            code: rule.code,
            severity: rule.severity,
            message,
            primary,
            related,
            tags: Vec::new(),
        },
        fix,
    });
}

// --- W3001 deprecated-builtin ------------------------------------------

/// Warn on calls to builtins the linked catalog marks deprecated.
///
/// Guards (all must pass): a deprecation snapshot is configured and
/// names the callee; no same-named authored binding exists in the
/// enclosing app/package/migration; no same-named module symbol or
/// import alias exists; the name is not contextual; and the analysis
/// type table types the call without error (which proves builtin
/// resolution and suppresses the lint on already-invalid calls).
fn rule_deprecated(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let Some(deprecated) = ctx.deprecated else {
        return;
    };
    if deprecated.is_empty() {
        return;
    }
    let rule = &RULES[0];
    debug_assert_eq!(rule.id, "deprecated-builtin");
    for unit in tree.descendants().filter(|n| {
        matches!(
            n.kind,
            SyntaxKind::App | SyntaxKind::Package | SyntaxKind::Migration
        )
    }) {
        let bindings = collect_unit_bindings(unit, ctx.text);
        for call in unit.descendants().filter(|n| n.kind == SyntaxKind::Call) {
            if has_errors(call) {
                continue;
            }
            let parts = kids(call);
            // Effect `call` statements start with the `call` head word;
            // expression calls start with the callee expression.
            let Some(callee) = parts.first() else {
                continue;
            };
            if callee.kind == SyntaxKind::Name {
                continue;
            }
            if callee.kind != SyntaxKind::NameRef {
                continue;
            }
            let Some(name) = kids(callee)
                .iter()
                .find(|c| c.kind == SyntaxKind::Name)
                .and_then(|leaf| name_text(leaf, ctx.text))
            else {
                continue;
            };
            let Some(notice) = deprecated.notice(name) else {
                continue;
            };
            if bindings.contains(name)
                || ctx.declared.contains(name)
                || is_contextual_or_predicate(name)
            {
                continue;
            }
            let typed = ctx
                .program
                .types
                .node_types
                .get(&NodeKey::of(call))
                .is_some_and(|ty| !ty.is_error());
            if !typed {
                continue;
            }
            let callee_span = kids(callee)
                .iter()
                .find(|c| c.kind == SyntaxKind::Name)
                .map(|leaf| leaf.span)
                .unwrap_or(callee.span);
            push(
                out,
                rule,
                format!("builtin `{name}` is deprecated: {}", truncate(notice, 160)),
                callee_span,
                Vec::new(),
                None,
            );
        }
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", text[..end].trim_end())
}

// --- W1001 unreachable-statement ---------------------------------------

/// Statement kinds that can appear in an execution suite.
fn is_statement_kind(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Let
            | SyntaxKind::Create
            | SyntaxKind::Set
            | SyntaxKind::Transition
            | SyntaxKind::Delete
            | SyntaxKind::Call
            | SyntaxKind::Emit
            | SyntaxKind::Send
            | SyntaxKind::Schedule
            | SyntaxKind::Cancel
            | SyntaxKind::Return
            | SyntaxKind::Require
            | SyntaxKind::If
            | SyntaxKind::For
    )
}

/// Whether `node` unconditionally ends the statement list for lint
/// purposes: only `require` with an exact literal-`false` predicate
/// (which always rejects per DESIGN §5.1). `return` is deliberately
/// not terminal here: analysis reports statements after `return` as
/// `E4030` (error), and lints never duplicate a compiler `E` code.
fn terminal_kind(node: &SyntaxNode, text: &str) -> bool {
    if node.kind != SyntaxKind::Require {
        return false;
    }
    let parts = kids(node);
    parts.len() >= 2
        && parts[1].kind == SyntaxKind::Literal
        && kids(parts[1]).len() == 1
        && is_name(kids(parts[1])[0], text, "false")
}

/// Statement lists of a suite node: one for `DoBlock`/`For`, then/else
/// halves for `If` (split at the `else` head word).
fn statement_lists<'a>(node: &'a SyntaxNode, text: &str) -> Vec<Vec<&'a SyntaxNode>> {
    let parts = kids(node);
    match node.kind {
        SyntaxKind::If => {
            let mut then_branch = Vec::new();
            let mut else_branch = Vec::new();
            let mut in_else = false;
            for child in parts {
                if !in_else && is_name(child, text, "else") {
                    in_else = true;
                    continue;
                }
                if is_statement_kind(child.kind) {
                    if in_else {
                        else_branch.push(child);
                    } else {
                        then_branch.push(child);
                    }
                }
            }
            vec![then_branch, else_branch]
        }
        SyntaxKind::DoBlock | SyntaxKind::For => {
            vec![
                parts
                    .into_iter()
                    .filter(|c| is_statement_kind(c.kind))
                    .collect(),
            ]
        }
        _ => Vec::new(),
    }
}

/// Whether deleting `span` cannot strand a `;` separator.
///
/// The span carries its own leading newline and indentation (trivia
/// lives inside the statement node), so removal is clean unless a `;`
/// piece separator sits on the same physical line before or after the
/// statement.
fn whole_line(text: &str, span: Span) -> bool {
    let bytes = text.as_bytes();
    let (start, end) = (span.start as usize, span.end as usize);
    if start > end || end > bytes.len() {
        return false;
    }
    // Before: anything past the previous newline belongs to an earlier
    // line and is unaffected; only a `;` on our own line forbids.
    let mut i = start;
    while i > 0 && bytes[i - 1] != b'\n' {
        if bytes[i - 1] == b';' {
            return false;
        }
        if !bytes[i - 1].is_ascii_whitespace() {
            break;
        }
        i -= 1;
    }
    // After: to the end of our line only whitespace may follow.
    let mut j = end;
    while j < bytes.len() && bytes[j] != b'\n' {
        if bytes[j] == b';' || !bytes[j].is_ascii_whitespace() {
            return false;
        }
        j += 1;
    }
    true
}

/// Remove executable source while retaining every explanatory comment at
/// its original indentation and in source order. CST ownership is a byte
/// coverage detail, not permission to erase author prose. Comment tokens
/// cover whole physical lines; retain their preceding line break too (CRLF
/// included), so comments remain separate from the surviving code.
///
/// Descriptions are declaration metadata, not comments. Refuse removal
/// when it would delete nested metadata or leave an attached description
/// behind to describe a different sibling.
fn unreachable_replacement(suite: &SyntaxNode, stmt: &SyntaxNode, text: &str) -> Option<String> {
    if !whole_line(text, stmt.span)
        || stmt
            .descendants()
            .any(|node| node.kind == SyntaxKind::Description)
    {
        return None;
    }
    let siblings = kids(suite);
    let position = siblings.iter().position(|node| std::ptr::eq(*node, stmt))?;
    if position > 0 && siblings[position - 1].kind == SyntaxKind::Description {
        return None;
    }
    let mut replacement = String::new();
    for comment in stmt
        .descendants()
        .filter(|node| node.kind == SyntaxKind::Comment)
    {
        let start = comment.span.start as usize;
        let end = comment.span.end as usize;
        let line_start = text[..start].rfind('\n').map_or(0, |newline| {
            if newline > 0 && text.as_bytes()[newline - 1] == b'\r' {
                newline - 1
            } else {
                newline
            }
        });
        // Never copy bytes from an earlier sibling, even if CST ownership
        // changes. Current comment leaves always have their line prefix.
        if line_start < stmt.span.start as usize || end > stmt.span.end as usize {
            return None;
        }
        replacement.push_str(&text[line_start..end]);
    }
    Some(replacement)
}

/// Warn on statements after unconditional termination in the same list.
///
/// Only exact `require false` is terminal (`require` with any other
/// predicate, `cancel`, and friends let execution continue; statements
/// after `return` are the `E4030` analysis error, never this lint).
/// Each unreachable statement gets one diagnostic pointing at the
/// decisive terminator, plus a removal fix when it spans whole lines.
fn rule_unreachable(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let rule = &RULES[1];
    debug_assert_eq!(rule.id, "unreachable-statement");
    for suite in tree.descendants().filter(|n| {
        matches!(
            n.kind,
            SyntaxKind::DoBlock | SyntaxKind::If | SyntaxKind::For
        )
    }) {
        if has_errors(suite) {
            continue;
        }
        for list in statement_lists(suite, ctx.text) {
            let mut terminator: Option<&SyntaxNode> = None;
            for stmt in list {
                if let Some(decisive) = terminator {
                    // `terminal_kind` only yields `require` now; the
                    // message pair is fixed.
                    let message = "statement after `require false` never executes".to_string();
                    let related = "this `require` always rejects".to_string();
                    let fix = unreachable_replacement(suite, stmt, ctx.text).map(|replacement| {
                        PendingFix {
                            rule: rule.id,
                            title: "remove unreachable statement".to_string(),
                            span: stmt.span,
                            replacement,
                        }
                    });
                    push(
                        out,
                        rule,
                        message,
                        stmt.span,
                        vec![Related {
                            span: decisive.span,
                            message: related,
                        }],
                        fix,
                    );
                    continue;
                }
                if terminal_kind(stmt, ctx.text) {
                    terminator = Some(stmt);
                }
            }
        }
    }
}

// --- I1001 unused-binding (`let`) --------------------------------------

/// Warn on `let` bindings never read in their `do` block.
///
/// A binding counts as read when a same-spelled `NameRef`, `{shorthand}`
/// entry or `set`/`delete` target path starts after the `let` statement
/// ends (the binding is introduced after its initializer per DESIGN
/// §3). Underscore-prefixed names are intentionally-unused markers.
/// Any second same-named binding in the block, or any same-named module
/// symbol/import, suppresses the finding: attribution would be a
/// guess. Removal is never offered as a fix: the initializer may fail
/// (DIAGNOSTICS.md).
fn rule_unused_let(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let rule = &RULES[2];
    debug_assert_eq!(rule.id, "unused-binding");
    for block in tree.descendants().filter(|n| n.kind == SyntaxKind::DoBlock) {
        if has_errors(block) {
            continue;
        }
        let mut lets = Vec::new();
        for node in block.descendants().filter(|n| n.kind == SyntaxKind::Let) {
            if let Some((name, span)) = let_binding(node, ctx.text)
                && !name.starts_with('_')
                && !is_contextual_fact(name)
            {
                lets.push((name, span, node));
            }
        }
        if lets.is_empty() {
            continue;
        }
        let counts = count_bindings(block, ctx.text);
        let mut reads = Vec::new();
        collect_reads(block, ctx.text, &mut reads);
        for (name, span, node) in lets {
            if ctx.declared.contains(name) {
                continue;
            }
            if counts.get(name).copied().unwrap_or(0) != 1 {
                continue;
            }
            let read = reads
                .iter()
                .any(|(word, at)| word == name && at.start > node.span.end);
            if !read {
                push(
                    out,
                    rule,
                    format!("`let {name}` is never read"),
                    span,
                    Vec::new(),
                    None,
                );
            }
        }
    }
}

// --- I1001 unused-binding (query alias) ---------------------------------

/// Unwrap `(...)` groups to the inner expression, if well-formed.
fn unwrap_groups(mut node: &SyntaxNode) -> &SyntaxNode {
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

/// Warn on a query alias never read in its scope: its following
/// clauses (GRAMMAR: never backward into the domain, never into
/// unrelated siblings), plus `extra` scope roots for the
/// `any`/`all`/`group` second argument and presentation-collection
/// descendants (DESIGN §3).
fn check_query_alias(
    ctx: &RuleCtx<'_>,
    query: &SyntaxNode,
    extra: &[&SyntaxNode],
    out: &mut Vec<Finding>,
) {
    let rule = &RULES[2];
    if has_errors(query) || extra.iter().any(|root| has_errors(root)) {
        return;
    }
    let parts = kids(query);
    let mut alias: Option<(&str, Span)> = None;
    let mut following: Vec<&SyntaxNode> = Vec::new();
    for child in &parts {
        if alias.is_none() {
            alias = query_alias_name(child, ctx.text);
        } else if child.kind == SyntaxKind::QueryClause {
            following.push(child);
        }
    }
    let Some((name, span)) = alias else {
        return;
    };
    if name.starts_with('_') || is_contextual_fact(name) || ctx.declared.contains(name) {
        return;
    }
    let mut scope: Vec<&SyntaxNode> = following;
    scope.extend(extra.iter().copied());
    // A nested same-named alias would steal references: stay silent.
    for root in &scope {
        for node in root.descendants() {
            if node.kind == SyntaxKind::QueryClause
                && let Some((nested, _)) = query_alias_name(node, ctx.text)
                && nested == name
            {
                return;
            }
        }
    }
    let mut reads = Vec::new();
    for root in &scope {
        collect_reads(root, ctx.text, &mut reads);
    }
    if reads.iter().all(|(word, _)| word != name) {
        push(
            out,
            rule,
            format!("query alias `{name}` is never read"),
            span,
            Vec::new(),
            None,
        );
    }
}

/// Warn on unread query aliases, threading extended scopes into
/// the queries that own them: the `any`/`all`/`group` second
/// argument, and presentation-collection descendants (DESIGN §3: an
/// explicit collection alias remains visible to descendants).
fn rule_unused_alias(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let mut scoped = HashSet::new();
    for collection in tree
        .descendants()
        .filter(|n| n.kind == SyntaxKind::Collection)
    {
        let parts = kids(collection);
        for (index, child) in parts.iter().enumerate() {
            let query = unwrap_groups(child);
            if query.kind != SyntaxKind::Query {
                continue;
            }
            // Every sibling subtree stays in scope except the query
            // itself: the domain must never count as a backward read.
            let extra: Vec<&SyntaxNode> = parts
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != index)
                .map(|(_, sibling)| *sibling)
                .collect();
            scoped.insert(NodeKey::of(query));
            check_query_alias(ctx, query, &extra, out);
        }
    }
    for call in tree.descendants().filter(|n| n.kind == SyntaxKind::Call) {
        let parts = kids(call);
        let Some(callee) = parts.first() else {
            continue;
        };
        if callee.kind != SyntaxKind::NameRef {
            continue;
        }
        let callee_name = kids(callee)
            .iter()
            .find(|c| c.kind == SyntaxKind::Name)
            .and_then(|leaf| name_text(leaf, ctx.text));
        if !matches!(callee_name, Some("any" | "all" | "group")) {
            continue;
        }
        let args: Vec<&SyntaxNode> = parts
            .iter()
            .filter(|c| c.kind == SyntaxKind::Argument)
            .copied()
            .collect();
        if args.len() < 2 {
            continue;
        }
        let domain = kids(args[0]).first().copied().map(unwrap_groups);
        if domain.is_some_and(|expr| expr.kind == SyntaxKind::Query)
            && let Some(domain) = domain
        {
            scoped.insert(NodeKey::of(domain));
            check_query_alias(ctx, domain, &[args[1]], out);
        }
    }
    for query in tree.descendants().filter(|n| n.kind == SyntaxKind::Query) {
        if scoped.contains(&NodeKey::of(query)) {
            continue;
        }
        check_query_alias(ctx, query, &[], out);
    }
}

// --- W2001 shadowed-binding ---------------------------------------------

/// Smallest `if`/`for` in `block` strictly containing `node`, if any.
fn enclosing_suite<'a>(block: &'a SyntaxNode, node: &SyntaxNode) -> Option<&'a SyntaxNode> {
    block
        .descendants()
        .filter(|n| {
            matches!(n.kind, SyntaxKind::If | SyntaxKind::For)
                && n.span.start <= node.span.start
                && node.span.end <= n.span.end
                && n.span.len() > node.span.len()
        })
        .min_by_key(|n| n.span.len())
}

/// Warn when a nested `let` hides a top-level `let` of the same `do`
/// block while the outer binding is still referenced nearby.
///
/// The outer binding must be a top-level statement declared before the
/// nested one (anything else is disjoint scope or a same-list
/// duplicate, which is `E2002`); a nearby reference is a read after
/// the outer `let` that still resolves to it (outside the shadowing
/// suite, or before the shadowing point inside it — including the
/// shadowing let's own initializer, the classic `let total = total+1`
/// accident). Contextual names are `E2012` territory and excluded.
/// Renaming needs an authored decision, so no fix is offered.
fn rule_shadowing(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let rule = &RULES[3];
    debug_assert_eq!(rule.id, "shadowed-binding");
    for block in tree.descendants().filter(|n| n.kind == SyntaxKind::DoBlock) {
        if has_errors(block) {
            continue;
        }
        let mut top = Vec::new();
        for child in kids(block) {
            if let Some((name, span)) = let_binding(child, ctx.text) {
                top.push((name, span, child));
            }
        }
        if top.is_empty() {
            continue;
        }
        let top_ptrs: HashSet<*const SyntaxNode> = top
            .iter()
            .map(|(_, _, node)| *node as *const SyntaxNode)
            .collect();
        let mut nested = Vec::new();
        for node in block.descendants().filter(|n| n.kind == SyntaxKind::Let) {
            if top_ptrs.contains(&(node as *const SyntaxNode)) {
                continue;
            }
            if let Some((name, span)) = let_binding(node, ctx.text)
                && !name.starts_with('_')
                && !is_contextual_or_predicate(name)
            {
                nested.push((name, span, node));
            }
        }
        if nested.is_empty() {
            continue;
        }
        let counts = count_bindings(block, ctx.text);
        let mut reads = Vec::new();
        collect_reads(block, ctx.text, &mut reads);
        for (name, span, inner) in nested {
            if ctx.declared.contains(name) {
                continue;
            }
            if counts.get(name).copied().unwrap_or(0) != 2 {
                continue;
            }
            let Some((_, outer_span, outer)) = top.iter().find(|(top_name, _, top_node)| {
                *top_name == name && top_node.span.start < inner.span.start
            }) else {
                continue;
            };
            let Some(suite) = enclosing_suite(block, inner) else {
                continue;
            };
            let nearby = reads.iter().any(|(word, at)| {
                word == name
                    && at.start > outer.span.end
                    && (at.start < suite.span.start
                        || at.start >= suite.span.end
                        || at.start < inner.span.end)
            });
            if nearby {
                push(
                    out,
                    rule,
                    format!("`let {name}` shadows the outer binding"),
                    span,
                    vec![Related {
                        span: *outer_span,
                        message: "outer binding is here".to_string(),
                    }],
                    None,
                );
            }
        }
    }
}

// --- I1002 redundant-null-marker ----------------------------------------

/// Warn on `?.` whose receiver the type table proves non-null.
///
/// The checker accepts `?.` on non-null receivers silently (only
/// `.`-on-nullable is `E3003`), so this duplicates no error. The fix
/// narrows `?.` to `.`, which is sound exactly when the receiver
/// cannot be null.
fn rule_redundant_null(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let rule = &RULES[4];
    debug_assert_eq!(rule.id, "redundant-null-marker");
    for member in tree.descendants().filter(|n| n.kind == SyntaxKind::Member) {
        if has_errors(member) {
            continue;
        }
        let parts = kids(member);
        if parts.len() != 3 || token_text(parts[1], ctx.text) != Some("?.") {
            continue;
        }
        let proven = ctx
            .program
            .types
            .node_types
            .get(&NodeKey::of(parts[0]))
            .is_some_and(|ty| ty.is_proven_nonnull());
        if !proven {
            continue;
        }
        push(
            out,
            rule,
            "`?.` is redundant: the receiver is never null; use `.`".to_string(),
            parts[1].span,
            Vec::new(),
            Some(PendingFix {
                rule: rule.id,
                title: "replace redundant `?.` with `.`".to_string(),
                span: parts[1].span,
                replacement: ".".to_string(),
            }),
        );
    }
}

// --- I1003/I1004 descriptions -------------------------------------------

/// Whether a node kind may own a `#` description (GRAMMAR
/// "Descriptions and comments": eligible declarations; section
/// markers, guards, effects, control flow, examples and presentation
/// `require` are ineligible and owned by `E1126`).
fn owner_eligible(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::App
            | SyntaxKind::Context
            | SyntaxKind::ContextDecl
            | SyntaxKind::Package
            | SyntaxKind::Import
            | SyntaxKind::Model
            | SyntaxKind::Field
            | SyntaxKind::Parameter
            | SyntaxKind::Contract
            | SyntaxKind::Event
            | SyntaxKind::Role
            | SyntaxKind::Derive
            | SyntaxKind::Capability
            | SyntaxKind::CapabilityOp
            | SyntaxKind::Message
            | SyntaxKind::Policy
            | SyntaxKind::Invariant
            | SyntaxKind::Unique
            | SyntaxKind::Lock
            | SyntaxKind::Retain
            | SyntaxKind::Fixture
            | SyntaxKind::Crud
            | SyntaxKind::Scenario
            | SyntaxKind::Page
            | SyntaxKind::Route
            | SyntaxKind::Card
            | SyntaxKind::Details
            | SyntaxKind::Tabs
            | SyntaxKind::Tab
            | SyntaxKind::Collection
            | SyntaxKind::Form
            | SyntaxKind::Edit
            | SyntaxKind::UiLeaf
            | SyntaxKind::PreferenceOrder
            | SyntaxKind::Migration
            | SyntaxKind::Rename
            | SyntaxKind::Drop
            | SyntaxKind::Invalidate
            | SyntaxKind::Backfill
    )
}

/// Raw `#` line tokens of a description node, if any.
fn description_lines<'a>(node: &'a SyntaxNode, text: &'a str) -> Option<Vec<&'a str>> {
    if node.kind != SyntaxKind::Description {
        return None;
    }
    match &node.detail {
        NodeDetail::Description { tokens, .. } => {
            Some(tokens.iter().map(|token| token.text(text)).collect())
        }
        _ => None,
    }
}

/// Prose content of one `#` line: the marker plus one optional space
/// consumed (GRAMMAR). `#= path` references keep their `=` body so
/// they never compare empty.
fn prose_content(line: &str) -> &str {
    let body = line.strip_prefix('#').unwrap_or(line);
    body.strip_prefix(' ').unwrap_or(body)
}

/// Normalized prose of a description: `None` for `#=` references
/// (reuse is their purpose; never flagged as duplicates).
fn normalized_prose(lines: &[&str]) -> Option<String> {
    if lines.iter().any(|line| line.starts_with("#=")) {
        return None;
    }
    Some(
        lines
            .iter()
            .map(|line| prose_content(line))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Warn on empty `#` descriptions and on identical prose shared by
/// adjacent owned siblings.
///
/// Descriptions on ineligible owners, dangling descriptions, and
/// descriptions of error subtrees belong to the layout/parser errors
/// (`E1125`/`E1126`/recovery) and are skipped. Neither nit offers a
/// fix: an empty description may satisfy a presence requirement (so
/// only its author can decide), and deleting a duplicate would strip
/// its owner's metadata.
fn rule_descriptions(ctx: &RuleCtx<'_>, tree: &SyntaxNode, out: &mut Vec<Finding>) {
    let empty_rule = &RULES[5];
    let dup_rule = &RULES[6];
    debug_assert_eq!(empty_rule.id, "empty-description");
    debug_assert_eq!(dup_rule.id, "duplicate-description");
    for parent in tree.descendants() {
        if parent.is_leaf() {
            continue;
        }
        let parts = kids(parent);
        // Owned sibling with an attached prose description, for
        // adjacency comparison: (normalized prose, description span).
        let mut previous: Option<(String, Span)> = None;
        for (index, child) in parts.iter().enumerate() {
            if child.kind == SyntaxKind::Description {
                let owner = parts.get(index + 1).copied();
                let eligible = owner.is_some_and(|o| owner_eligible(o.kind) && !has_errors(o));
                if !eligible {
                    continue;
                }
                if let Some(lines) = description_lines(child, ctx.text)
                    && !lines.is_empty()
                    && lines
                        .iter()
                        .all(|line| prose_content(line).trim().is_empty())
                {
                    push(
                        out,
                        empty_rule,
                        "description is empty; write a description or remove the `#` line"
                            .to_string(),
                        child.span,
                        Vec::new(),
                        None,
                    );
                }
                continue;
            }
            let attached = index > 0 && parts[index - 1].kind == SyntaxKind::Description;
            if !attached || !owner_eligible(child.kind) || has_errors(child) {
                previous = None;
                continue;
            }
            let desc = parts[index - 1];
            let prose = description_lines(desc, ctx.text).and_then(|lines| {
                if lines.is_empty() {
                    None
                } else {
                    normalized_prose(&lines)
                }
            });
            let Some(prose) = prose else {
                previous = None;
                continue;
            };
            if let Some((prev_prose, prev_span)) = &previous
                && *prev_prose == prose
            {
                push(
                    out,
                    dup_rule,
                    "description duplicates the adjacent sibling's description".to_string(),
                    desc.span,
                    vec![Related {
                        span: *prev_span,
                        message: "identical description is here".to_string(),
                    }],
                    None,
                );
            }
            previous = Some((prose, desc.span));
        }
    }
}
