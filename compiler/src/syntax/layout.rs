//! Layout: delimiter joining, logical lines, indentation and descriptions.
//!
//! Covers GRAMMAR.md layout rules: balanced `()[]{}` join physical lines
//! without introducing blocks; a block adds exactly one space; blank and
//! `##` lines emit nothing; `#` prose and `#= path` references attach to
//! the next eligible declaration at the same column.
//!
//! [`layout`] consumes lexer [`PhysLine`](crate::syntax::lexer::PhysLine)s
//! and produces a [`LogicalLine`] tree with descriptions attached.
//! Diagnostics use codes E1101–E1103 and E1120–E1126.

use crate::diagnostic::Diagnostic;
use crate::source::{SourceId, Span};
use crate::syntax::lexer::{PhysLine, Punct, Token, TokenKind, lex_fragment};

/// One decoded description-message variant (`locale=STRING|null`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptionVariant {
    pub locale: String,
    /// `None` for `null` (or for an already-reported invalid string).
    pub value: Option<String>,
}

/// Inline `@{...}` suffix on the final prose line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptionSuffix {
    pub variants: Vec<DescriptionVariant>,
}

/// Decoded description set: joined prose or a lone static reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptionData {
    Prose {
        /// Consecutive same-column prose lines joined with `\n`, with the
        /// marker consumed, one optional separating space before a suffix
        /// removed, and `\@{` unquoted to `@{`.
        text: String,
        suffix: Option<DescriptionSuffix>,
    },
    Reference {
        path: Vec<String>,
    },
}

/// Description lines attached to one logical line.
#[derive(Debug, Clone)]
pub struct AttachedDescription {
    /// Raw `#` tokens in source order (one per physical line).
    pub tokens: Vec<Token>,
    pub data: DescriptionData,
}

/// One logical source line: joined tokens, child suite, description.
#[derive(Debug, Clone)]
pub struct LogicalLine {
    /// Indentation in spaces (first physical line; continuations ignored).
    pub indent: usize,
    /// Code tokens; may contain inline [`TokenKind::Desc`] tokens when
    /// `#` lines occurred inside joined `()[]{}` (schema fields).
    pub tokens: Vec<Token>,
    pub children: Vec<LogicalLine>,
    pub description: Option<AttachedDescription>,
    /// 1-based physical line where this logical line starts.
    pub first_line: usize,
}

/// Outcome of [`layout`].
#[derive(Debug)]
pub struct LayoutResult {
    pub roots: Vec<LogicalLine>,
    /// All `##` tokens in source order, for lossless CST trivia.
    pub comments: Vec<Token>,
    /// Physical line starts (offset after each `\n`, beginning with 0),
    /// for column checks on joined tokens.
    pub line_starts: Vec<u32>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Indentation-nesting budget for the layout tree (`levels` length).
/// Genuine Can nests a handful of levels; 128 leaves 10x headroom while
/// bounding every tree recursion — `attach_level` here, `parse_statements`
/// and `error_for_line` downstream — to a safe native-stack depth. Past
/// the budget the line attaches as a sibling of the deepest level with an
/// E1103 diagnostic instead of overflowing the stack.
pub const MAX_TREE_DEPTH: usize = 128;

/// Byte column (1-based) of an offset within its physical line.
pub fn column_of(line_starts: &[u32], offset: u32) -> usize {
    let line = line_starts.partition_point(|&s| s <= offset);
    let start = line_starts
        .get(line.saturating_sub(1))
        .copied()
        .unwrap_or(0);
    (offset.saturating_sub(start)) as usize + 1
}

/// Run delimiter joining, indentation tree building and description
/// attachment over lexed physical lines.
pub fn layout(file: SourceId, text: &str, lines: Vec<PhysLine>) -> LayoutResult {
    let mut diagnostics = Vec::new();
    let line_starts: Vec<u32> = lines.iter().map(|l| l.start).collect();

    // Stage 1: delimiter-depth joining into flat logical lines.
    let mut flat: Vec<TreeLine> = Vec::new();
    let mut comments: Vec<Token> = Vec::new();
    let mut pending: Vec<Token> = Vec::new();
    let mut pending_indent = 0usize;
    let mut pending_first_line = 1usize;
    let mut brackets: Vec<Token> = Vec::new();

    for phys in &lines {
        if phys.tokens.is_empty() {
            continue; // Blank line: emits nothing.
        }
        let head = &phys.tokens[0];
        match head.kind {
            TokenKind::Comment => {
                comments.push(head.clone());
                continue; // `##` lines emit nothing and never join.
            }
            TokenKind::Desc => {
                if brackets.is_empty() {
                    flat.push(TreeLine {
                        indent: phys.indent,
                        tokens: vec![head.clone()],
                        children: Vec::new(),
                        first_line: phys.number,
                        is_desc: true,
                    });
                } else {
                    // Inside joined delimiters: inline (schema fields).
                    pending.push(head.clone());
                }
                continue;
            }
            _ => {}
        }
        if pending.is_empty() {
            pending_indent = phys.indent;
            pending_first_line = phys.number;
        }
        for token in &phys.tokens {
            if let TokenKind::Punct(punct) = token.kind {
                if punct.is_opener() {
                    brackets.push(token.clone());
                } else if punct.is_closer() {
                    match brackets.last() {
                        Some(open) if matches!(open.kind, TokenKind::Punct(o) if o.matching_closer() == Some(punct)) =>
                        {
                            brackets.pop();
                        }
                        _ => {
                            diagnostics.push(Diagnostic::error(
                                "E1101",
                                format!("mismatched closing delimiter `{}`", token.text(text)),
                                token.span,
                            ));
                            // Recovery: pop one level when possible so the
                            // join usually still terminates.
                            brackets.pop();
                        }
                    }
                }
            }
            pending.push(token.clone());
        }
        if brackets.is_empty() {
            flat.push(TreeLine {
                indent: pending_indent,
                tokens: std::mem::take(&mut pending),
                children: Vec::new(),
                first_line: pending_first_line,
                is_desc: false,
            });
        }
    }
    if !brackets.is_empty() {
        let open = brackets.last().expect("nonempty brackets");
        diagnostics.push(Diagnostic::error(
            "E1102",
            format!("unclosed delimiter `{}`", open.text(text)),
            open.span,
        ));
        // Recovery: flush the pending line so its tokens stay covered.
        flat.push(TreeLine {
            indent: pending_indent,
            tokens: std::mem::take(&mut pending),
            children: Vec::new(),
            first_line: pending_first_line,
            is_desc: false,
        });
    }

    // Stage 2: indentation tree. `levels` is the child-index path of the
    // last placed line; its length is that line's depth.
    let mut roots: Vec<TreeLine> = Vec::new();
    let mut levels: Vec<usize> = Vec::new();
    for line in flat {
        if levels.is_empty() {
            if line.indent != 0 {
                diagnostics.push(Diagnostic::error(
                    "E1103",
                    "top-level declaration must start in column 1".to_string(),
                    line.tokens
                        .first()
                        .map(|t| t.span)
                        .unwrap_or_else(|| Span::new(file, 0, 0)),
                ));
            }
            roots.push(line);
            levels.push(roots.len() - 1);
            continue;
        }
        // Description lines never own a child suite: a deeper line after
        // one becomes its sibling, and attachment reports E1120 (no E1103
        // here; the column mismatch is the single root cause).
        if line.indent == levels.len()
            && let Some(parent) = navigate(&roots, &levels)
            && parent.is_desc
        {
            levels.pop();
            if levels.is_empty() {
                roots.push(line);
                levels.push(roots.len() - 1);
            } else {
                let slot = navigate_mut(&mut roots, &levels).expect("live level path");
                slot.children.push(line);
                levels.push(slot.children.len() - 1);
            }
            continue;
        }
        if line.indent == levels.len() {
            if levels.len() >= MAX_TREE_DEPTH {
                push_capped_sibling(file, &mut roots, &mut levels, line, &mut diagnostics);
            } else {
                let slot = navigate_mut(&mut roots, &levels).expect("live level path");
                slot.children.push(line);
                levels.push(slot.children.len() - 1);
            }
        } else if line.indent < levels.len() {
            levels.truncate(line.indent);
            if levels.is_empty() {
                roots.push(line);
                levels.push(roots.len() - 1);
            } else {
                let slot = navigate_mut(&mut roots, &levels).expect("live level path");
                slot.children.push(line);
                levels.push(slot.children.len() - 1);
            }
        } else {
            // Recovery: attach as a child of the deepest level, but never
            // inside a description line (descriptions own no suites) and
            // never past the nesting budget.
            if navigate(&roots, &levels).is_some_and(|parent| parent.is_desc) {
                levels.pop();
            }
            if !levels.is_empty() && levels.len() >= MAX_TREE_DEPTH {
                push_capped_sibling(file, &mut roots, &mut levels, line, &mut diagnostics);
                continue;
            }
            let span = line
                .tokens
                .first()
                .map(|t| t.span)
                .unwrap_or_else(|| Span::new(file, 0, 0));
            diagnostics.push(Diagnostic::error(
                "E1103",
                "child block must add exactly one space".to_string(),
                span,
            ));
            if levels.is_empty() {
                roots.push(line);
                levels.push(roots.len() - 1);
            } else {
                let slot = navigate_mut(&mut roots, &levels).expect("live level path");
                slot.children.push(line);
                levels.push(slot.children.len() - 1);
            }
        }
    }

    // Stage 3: description attachment.
    let converted = attach_level(file, text, &line_starts, roots, false, &mut diagnostics);

    LayoutResult {
        roots: converted,
        comments,
        line_starts,
        diagnostics,
    }
}

/// Pre-attachment tree line; description lines are still siblings.
struct TreeLine {
    indent: usize,
    tokens: Vec<Token>,
    children: Vec<TreeLine>,
    first_line: usize,
    is_desc: bool,
}

fn navigate<'a>(roots: &'a [TreeLine], path: &[usize]) -> Option<&'a TreeLine> {
    let mut slot = roots.get(*path.first()?)?;
    for index in &path[1..] {
        slot = slot.children.get(*index)?;
    }
    Some(slot)
}

fn navigate_mut<'a>(roots: &'a mut [TreeLine], path: &[usize]) -> Option<&'a mut TreeLine> {
    let mut slot = roots.get_mut(*path.first()?)?;
    for index in &path[1..] {
        slot = slot.children.get_mut(*index)?;
    }
    Some(slot)
}

/// Attach `line` as a sibling of the last-placed line with an E1103
/// nesting-budget diagnostic, keeping the tree at most
/// [`MAX_TREE_DEPTH`] deep. `levels` must be nonempty.
fn push_capped_sibling(
    file: SourceId,
    roots: &mut Vec<TreeLine>,
    levels: &mut Vec<usize>,
    line: TreeLine,
    diagnostics: &mut Vec<Diagnostic>,
) {
    debug_assert!(!levels.is_empty());
    let span = line
        .tokens
        .first()
        .map(|t| t.span)
        .unwrap_or_else(|| Span::new(file, 0, 0));
    diagnostics.push(Diagnostic::error(
        "E1103",
        format!("nesting exceeds the {MAX_TREE_DEPTH}-level budget; flatten the block"),
        span,
    ));
    if levels.len() == 1 {
        roots.push(line);
        levels[0] = roots.len() - 1;
    } else {
        let index = {
            let slot = navigate_mut(roots, &levels[..levels.len() - 1]).expect("live level path");
            slot.children.push(line);
            slot.children.len() - 1
        };
        levels.truncate(levels.len() - 1);
        levels.push(index);
    }
}

/// Heads that can never carry a description (GRAMMAR ineligible list, by
/// written head word; effect/example descendants via `inert_context`).
fn is_ineligible_head(text: &str, line: &TreeLine) -> bool {
    matches!(
        line.tokens.first(),
        Some(token) if {
            let word = token.text(text);
            token.kind == TokenKind::Name
                && matches!(
                    word,
                    "Given" | "When" | "Then" | "do" | "require" | "if" | "else" | "for" | "examples"
                )
        }
    )
}

/// Attach consecutive description lines to the following sibling.
/// Trailing descriptions with no following declaration become in-tree
/// marker lines (empty tokens, E1125 reported) so the parser covers them
/// in document order.
fn attach_level(
    file: SourceId,
    text: &str,
    line_starts: &[u32],
    lines: Vec<TreeLine>,
    inert_context: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<LogicalLine> {
    let mut out = Vec::new();
    let mut pending: Vec<TreeLine> = Vec::new();
    for mut line in lines {
        if line.is_desc {
            debug_assert_eq!(line.tokens.len(), 1);
            debug_assert!(
                line.children.is_empty(),
                "tree building never nests under descriptions"
            );
            pending.push(line);
            continue;
        }
        let head_do_or_examples = matches!(
            line.tokens.first(),
            Some(token) if token.kind == TokenKind::Name
                && matches!(token.text(text), "do" | "examples")
        );
        let children = attach_level(
            file,
            text,
            line_starts,
            std::mem::take(&mut line.children),
            inert_context || head_do_or_examples,
            diagnostics,
        );
        let description = if pending.is_empty() {
            None
        } else {
            let target = line
                .tokens
                .first()
                .cloned()
                .expect("code lines always carry tokens");
            if inert_context || is_ineligible_head(text, &line) {
                let head_word = line
                    .tokens
                    .first()
                    .map(|t| t.text(text).to_string())
                    .unwrap_or_default();
                diagnostics.push(Diagnostic::error(
                    "E1126",
                    if inert_context {
                        "description cannot attach to a guard, effect or example row; use `##`".to_string()
                    } else {
                        format!(
                            "description cannot attach to `{head_word}`; use `##` (markers, guards, effects, control flow and examples are ineligible)"
                        )
                    },
                    pending[0].tokens[0].span,
                ));
            }
            let tokens: Vec<Token> = pending.iter().map(|line| line.tokens[0].clone()).collect();
            let data =
                decode_description_set(file, text, line_starts, &tokens, &target, diagnostics);
            pending.clear();
            Some(AttachedDescription { tokens, data })
        };
        out.push(LogicalLine {
            indent: line.indent,
            tokens: line.tokens,
            children,
            description,
            first_line: line.first_line,
        });
    }
    if !pending.is_empty() {
        diagnostics.push(Diagnostic::error(
            "E1125",
            "description has no following declaration at the same indentation".to_string(),
            pending[0].tokens[0].span,
        ));
        // Decode against the first line itself (no column noise; ref and
        // suffix shape errors are still genuine) and keep a marker line.
        let tokens: Vec<Token> = pending.iter().map(|line| line.tokens[0].clone()).collect();
        let target = tokens[0].clone();
        let data = decode_description_set(file, text, line_starts, &tokens, &target, diagnostics);
        out.push(LogicalLine {
            indent: pending[0].indent,
            tokens: Vec::new(),
            children: Vec::new(),
            description: Some(AttachedDescription { tokens, data }),
            first_line: pending[0].first_line,
        });
    }
    out
}

/// Decode one attached description set (expected same-column lines).
///
/// `target` is the declaration's first token (or a field/parameter name
/// for inline schema descriptions). Recovery: on any error a diagnostic
/// is recorded and decoding continues with a best-effort value.
pub fn decode_description_set(
    file: SourceId,
    text: &str,
    line_starts: &[u32],
    descs: &[Token],
    target: &Token,
    diagnostics: &mut Vec<Diagnostic>,
) -> DescriptionData {
    debug_assert!(!descs.is_empty());
    let target_column = column_of(line_starts, target.span.start);
    for desc in descs {
        let column = column_of(line_starts, desc.span.start);
        if column != target_column {
            diagnostics.push(Diagnostic::error(
                "E1120",
                "description and declaration must occupy the same column".to_string(),
                desc.span,
            ));
        }
    }

    let is_reference = |token: &Token| token.text(text).starts_with("#=");
    if descs.iter().any(is_reference) {
        if descs.len() != 1 {
            diagnostics.push(Diagnostic::error(
                "E1121",
                "one description cannot mix prose and references or contain multiple references"
                    .to_string(),
                descs[1.min(descs.len() - 1)].span,
            ));
        }
        return decode_reference(file, text, &descs[0], diagnostics);
    }

    // Prose: join same-column lines, honoring `\@{` quotes and a single
    // trailing `@{...}` suffix on the final line.
    let mut lines_out: Vec<String> = Vec::new();
    let mut suffix: Option<DescriptionSuffix> = None;
    for (index, desc) in descs.iter().enumerate() {
        let raw = desc.text(text);
        let prefix_len = if raw.starts_with("# ") { 2 } else { 1 };
        let content = &raw[prefix_len..];
        let mut chars: Vec<char> = Vec::new();
        let mut position = 0usize;
        let mut found_suffix_at: Option<usize> = None;
        while position < content.len() {
            if content[position..].starts_with("\\@{") {
                chars.push('@');
                chars.push('{');
                position += 3;
            } else if content[position..].starts_with("@{") {
                if index != descs.len() - 1 {
                    diagnostics.push(Diagnostic::error(
                        "E1123",
                        "description suffix must occupy the final prose line".to_string(),
                        Span::new(
                            file,
                            desc.span.start + prefix_len as u32 + position as u32,
                            desc.span.start + prefix_len as u32 + position as u32 + 2,
                        ),
                    ));
                    // Recovery: treat the marker as literal prose.
                    chars.push('@');
                    chars.push('{');
                    position += 2;
                } else {
                    // Remove exactly one optional separating space.
                    if chars.last() == Some(&' ') {
                        chars.pop();
                    }
                    found_suffix_at = Some(position);
                    break;
                }
            } else {
                let ch = content[position..].chars().next().expect("char boundary");
                chars.push(ch);
                position += ch.len_utf8();
            }
        }
        lines_out.push(chars.into_iter().collect());
        if let Some(at) = found_suffix_at {
            let base = desc.span.start + prefix_len as u32 + at as u32;
            suffix = decode_suffix(file, text, &content[at..], base, diagnostics);
        }
    }
    DescriptionData::Prose {
        text: lines_out.join("\n"),
        suffix,
    }
}

/// Decode a `#= path` reference line.
fn decode_reference(
    file: SourceId,
    text: &str,
    desc: &Token,
    diagnostics: &mut Vec<Diagnostic>,
) -> DescriptionData {
    let raw = desc.text(text);
    let fragment = &raw[2..]; // After `#=`.
    let base = desc.span.start + 2;
    let before = diagnostics.len();
    let tokens = lex_fragment(file, fragment, base, diagnostics);
    if diagnostics.len() != before {
        return DescriptionData::Reference { path: Vec::new() };
    }
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0usize;
    // Exactly `NAME (. NAME)*`, no call or extra tokens.
    loop {
        match tokens.get(i) {
            Some(token) if token.kind == TokenKind::Name => {
                parts.push(token.text(text).to_string());
                i += 1;
            }
            _ => break,
        }
        match tokens.get(i) {
            Some(token) if token.is_punct(Punct::Dot) => {
                i += 1;
            }
            _ => break,
        }
    }
    if parts.is_empty() || i != tokens.len() {
        let span = tokens
            .get(i)
            .map(|t| t.span)
            .unwrap_or_else(|| Span::new(file, base, desc.span.end.max(base)));
        diagnostics.push(Diagnostic::error(
            "E1122",
            "`#=` must be followed by exactly one message path (no call or extra tokens)"
                .to_string(),
            span,
        ));
        return DescriptionData::Reference { path: Vec::new() };
    }
    DescriptionData::Reference { path: parts }
}

/// Decode an inline `@{...}` suffix fragment with absolute `base` offset.
///
/// `text` is the full source (fragment token spans are absolute into it).
fn decode_suffix(
    file: SourceId,
    text: &str,
    fragment: &str,
    base: u32,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<DescriptionSuffix> {
    let before = diagnostics.len();
    let tokens = lex_fragment(file, fragment, base, diagnostics);
    if diagnostics.len() != before {
        return None;
    }
    let mut fail = |message: &str, span: Span| {
        diagnostics.push(Diagnostic::error("E1124", message.to_string(), span));
    };
    let mut i = 0usize;
    let at = match tokens.get(i) {
        Some(token) if token.is_punct(Punct::At) => {
            i += 1;
            token.clone()
        }
        _ => {
            let span = tokens
                .first()
                .map(|t| t.span)
                .unwrap_or_else(|| Span::new(file, base, base));
            fail("description suffix must start with `@{`", span);
            return None;
        }
    };
    match tokens.get(i) {
        Some(token) if token.is_punct(Punct::LBrace) => {
            if token.span.start != at.span.end {
                fail("message suffix marker must be contiguous `@{`", token.span);
                return None;
            }
            i += 1;
        }
        _ => {
            let span = tokens
                .get(i)
                .map(|t| t.span)
                .unwrap_or_else(|| Span::new(file, at.span.end, at.span.end));
            fail("description suffix must start with `@{`", span);
            return None;
        }
    }
    let mut variants = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    while tokens.get(i).is_some_and(|t| !t.is_punct(Punct::RBrace)) {
        let key = &tokens[i];
        let locale = match key.kind {
            TokenKind::Name => key.text(text).to_string(),
            // A bad string was already reported by the lexer; skip variant.
            TokenKind::String => key.string_value.clone()?,
            _ => {
                fail(
                    "message locale key must be an identifier or quoted tag",
                    key.span,
                );
                return None;
            }
        };
        let folded = locale.to_lowercase();
        if seen.contains(&folded) {
            fail("duplicate message locale variant", key.span);
            return None;
        }
        seen.push(folded);
        i += 1;
        match tokens.get(i) {
            Some(token) if token.is_punct(Punct::Eq) => i += 1,
            _ => {
                let span = tokens
                    .get(i)
                    .map(|t| t.span)
                    .unwrap_or_else(|| Span::new(file, base, base));
                fail("expected `=` after message locale key", span);
                return None;
            }
        }
        let value_token = match tokens.get(i) {
            Some(token) => {
                i += 1;
                token.clone()
            }
            None => {
                fail(
                    "message variant requires a JSON string or null",
                    Span::new(file, base, base),
                );
                return None;
            }
        };
        let value = if value_token.kind == TokenKind::String {
            // A bad string was already reported by the lexer; skip variant.
            Some(value_token.string_value.clone()?)
        } else if value_token.kind == TokenKind::Name && value_token.text(text) == "null" {
            None
        } else {
            fail(
                "message variant requires a JSON string or null",
                value_token.span,
            );
            return None;
        };
        variants.push(DescriptionVariant { locale, value });
        match tokens.get(i) {
            Some(token) if token.is_punct(Punct::Comma) => {
                i += 1;
            }
            _ => break,
        }
    }
    match tokens.get(i) {
        Some(token) if token.is_punct(Punct::RBrace) => {
            i += 1;
        }
        _ => {
            let span = tokens
                .get(i)
                .map(|t| t.span)
                .unwrap_or_else(|| Span::new(file, base, base));
            fail("expected `}` to close the description suffix", span);
            return None;
        }
    }
    if i != tokens.len() {
        fail(
            "description suffix consumes the remainder of the line",
            tokens[i].span,
        );
        return None;
    }
    Some(DescriptionSuffix { variants })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::lexer::lex;

    fn laid_out(text: &str) -> LayoutResult {
        let lexed = lex(SourceId(0), text);
        assert!(
            lexed.diagnostics.is_empty(),
            "unexpected lex diags: {:?}",
            lexed.diagnostics
        );
        layout(SourceId(0), text, lexed.lines)
    }

    #[test]
    fn brackets_join_without_blocks() {
        let result =
            laid_out("app Test\nGiven\n Thing {\n  title:text,\n  done:bool\n }\nWhen\nThen\n");
        assert!(result.diagnostics.is_empty());
        // The brace-joined schema is one logical line with no suite.
        let given = &result.roots[1];
        assert_eq!(given.children.len(), 1);
        assert!(given.children[0].children.is_empty());
        assert!(given.children[0].tokens.len() > 5);
    }

    #[test]
    fn one_space_indent_and_dedent() {
        let result = laid_out("app Test\nGiven\n Thing {value:int}\nWhen\nThen\n");
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.roots.len(), 4); // app, Given, When, Then
        let bad = laid_out("app Test\nGiven\n  Thing {value:int}\nWhen\nThen\n");
        assert_eq!(bad.diagnostics.len(), 1);
        assert_eq!(bad.diagnostics[0].code, "E1103");
    }

    #[test]
    fn blank_and_comment_lines_emit_nothing() {
        let result = laid_out("app Test\n\n## ignored\nGiven\nWhen\nThen\n");
        assert!(result.diagnostics.is_empty());
        assert_eq!(result.roots.len(), 4);
        assert_eq!(result.comments.len(), 1);
    }

    #[test]
    fn prose_attaches_at_same_column() {
        let result = laid_out("# Work.\napp Test\nGiven\nWhen\nThen\n");
        assert!(result.diagnostics.is_empty());
        let attached = result.roots[0].description.as_ref().expect("attached");
        assert_eq!(attached.tokens.len(), 1);
        assert!(matches!(attached.data, DescriptionData::Prose { .. }));
        let bad = laid_out(" # Indented.\napp Test\nGiven\nWhen\nThen\n");
        // Both the leading-indent error and the column mismatch are genuine.
        assert!(bad.diagnostics.iter().any(|d| d.code == "E1103"));
        assert!(bad.diagnostics.iter().any(|d| d.code == "E1120"));
    }

    #[test]
    fn ref_rules_and_suffix_rules() {
        let good = laid_out("#= heading\napp Test\nGiven\nWhen\nThen\n");
        assert!(good.diagnostics.is_empty());
        assert!(matches!(
            good.roots[0].description.as_ref().unwrap().data,
            DescriptionData::Reference { .. }
        ));
        for (source, code) in [
            ("#= a\n#= b\napp Test\nGiven\nWhen\nThen\n", "E1121"),
            ("#= heading()\napp Test\nGiven\nWhen\nThen\n", "E1122"),
            (
                "# Prose\n#= heading\napp Test\nGiven\nWhen\nThen\n",
                "E1121",
            ),
            (
                "# A @{nl=\"x\"}\n# B\napp Test\nGiven\nWhen\nThen\n",
                "E1123",
            ),
            ("# A @{nl=42}\napp Test\nGiven\nWhen\nThen\n", "E1124"),
            (
                "# A @{nl=\"x\",NL=\"y\"}\napp Test\nGiven\nWhen\nThen\n",
                "E1124",
            ),
            ("# Dangling.\n", "E1125"),
        ] {
            let result = laid_out(source);
            assert!(
                result.diagnostics.iter().any(|d| d.code == code),
                "{source}: {:?}",
                result.diagnostics
            );
        }
    }

    #[test]
    fn ineligible_heads_rejected() {
        let result = laid_out("app Test\n# About given.\nGiven\nWhen\nThen\n");
        assert_eq!(result.diagnostics[0].code, "E1126");
        let result = laid_out(
            "app Test\nGiven\nWhen\n scenario change(thing:Thing) by=members\n  # Guard note.\n  require thing.value>0\n  do set thing {value=1}\nThen\n",
        );
        assert!(
            result.diagnostics.iter().any(|d| d.code == "E1126"),
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn mismatched_and_unclosed_delimiters() {
        let lexed = lex(
            SourceId(0),
            "app Test\nGiven\n Thing {value:int\nWhen\nThen\n",
        );
        let result = layout(
            SourceId(0),
            "app Test\nGiven\n Thing {value:int\nWhen\nThen\n",
            lexed.lines,
        );
        assert!(result.diagnostics.iter().any(|d| d.code == "E1102"));
    }
}
