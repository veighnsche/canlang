//! Parser: full GRAMMAR.md productions with per-declaration recovery.
//!
//! Consumes the [`LogicalLine`](crate::syntax::layout::LogicalLine) tree and
//! builds a lossless [`SyntaxNode`](crate::syntax::cst::SyntaxNode). Every
//! declaration boundary recovers independently: one bad declaration becomes
//! an [`SyntaxKind::Error`](crate::syntax::cst::SyntaxKind::Error) subtree
//! and parsing continues with the next sibling, so a multi-error file
//! yields one diagnostic per defect without cascades.
//!
//! This parser implements the complete normative grammar, including the
//! prototype gaps recorded in GRAMMAR.md: `delivery(path)` and
//! `invocation(paths)` types, sequence-form examples, preference
//! ordering, CSV form import attributes, page `refresh`, structured
//! derived-field labels and CRUD `expose`, plus `corpus`/`judgment`
//! declarations, `gallery` collections, `slot` items, `preferences`
//! panels, `edit` suites and generic catalog component items.
//! Diagnostics use codes E1200–E1216 (see `syntax::mod` catalog).

use crate::diagnostic::Diagnostic;
use crate::source::{SourceId, Span};
use crate::syntax::cst::{SyntaxKind, SyntaxNode};
use crate::syntax::layout::{LayoutResult, LogicalLine, decode_description_set};
use crate::syntax::lexer::{Punct, Token, TokenKind};

/// Parse failure caught at a declaration boundary.
struct Fail {
    code: &'static str,
    message: String,
    span: Span,
}

impl Fail {
    fn new(code: &'static str, message: impl Into<String>, span: Span) -> Self {
        Self {
            code,
            message: message.into(),
            span,
        }
    }

    fn diag(self) -> Diagnostic {
        Diagnostic::error(self.code, self.message, self.span)
    }
}

/// Token cursor over one header/piece with source text for names.
struct Cursor<'a> {
    toks: &'a [Token],
    pos: usize,
    text: &'a str,
    eof: Span,
}

impl<'a> Cursor<'a> {
    fn new(toks: &'a [Token], text: &'a str, eof: Span) -> Self {
        Self {
            toks,
            pos: 0,
            text,
            eof,
        }
    }

    fn peek(&self) -> Option<&'a Token> {
        self.toks.get(self.pos)
    }

    fn peek2(&self) -> Option<&'a Token> {
        self.toks.get(self.pos + 1)
    }

    fn peek3(&self) -> Option<&'a Token> {
        self.toks.get(self.pos + 2)
    }

    fn done(&self) -> bool {
        self.pos >= self.toks.len()
    }

    fn span_here(&self) -> Span {
        self.peek().map(|t| t.span).unwrap_or(self.eof)
    }

    fn err<T>(&self, code: &'static str, message: impl Into<String>) -> Result<T, Fail> {
        Err(Fail::new(code, message, self.span_here()))
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.toks.get(self.pos).cloned()?;
        self.pos += 1;
        Some(token)
    }

    fn at_p(&self, punct: Punct) -> bool {
        self.peek().is_some_and(|t| t.is_punct(punct))
    }

    fn at_name(&self, word: &str) -> bool {
        self.peek().is_some_and(|t| t.is_name(self.text, word))
    }

    fn at_any_name(&self) -> bool {
        self.peek().is_some_and(|t| t.kind == TokenKind::Name)
    }

    /// Whether the token after peek is `=` (attribute boundary lookahead).
    fn peek_is_eq(&self) -> bool {
        self.peek2().is_some_and(|t| t.is_punct(Punct::Eq))
    }

    fn word(&self) -> Option<&'a str> {
        match self.peek() {
            Some(token) if token.kind == TokenKind::Name => Some(token.text(self.text)),
            _ => None,
        }
    }

    fn expect_p(&mut self, punct: Punct) -> Result<Token, Fail> {
        if self.at_p(punct) {
            Ok(self.next().expect("peeked punct"))
        } else {
            self.err("E1200", format!("expected `{}`", punct.spell()))
        }
    }

    fn expect_name(&mut self) -> Result<Token, Fail> {
        if self.at_any_name() {
            Ok(self.next().expect("peeked name"))
        } else {
            self.err("E1200", "expected identifier")
        }
    }

    fn expect_name_is(&mut self, word: &str) -> Result<Token, Fail> {
        if self.at_name(word) {
            Ok(self.next().expect("peeked word"))
        } else {
            self.err("E1200", format!("expected `{word}`"))
        }
    }

    fn expect_string(&mut self) -> Result<Token, Fail> {
        match self.peek() {
            Some(token) if token.kind == TokenKind::String => {
                Ok(self.next().expect("peeked string"))
            }
            _ => self.err("E1200", "expected a double-quoted string"),
        }
    }

    /// Enforce end of header: no production permits an unparsed tail.
    fn end(&self) -> Result<(), Fail> {
        match self.peek() {
            None => Ok(()),
            Some(token) => Err(Fail::new(
                "E1201",
                format!(
                    "unexpected token `{}`; expected end of statement",
                    token.text(self.text)
                ),
                token.span,
            )),
        }
    }
}

/// End-of-input span for a token piece (empty span at its end).
fn piece_eof(piece: &[Token], file: SourceId, fallback: Span) -> Span {
    piece
        .last()
        .map(|t| Span::new(file, t.span.end, t.span.end))
        .unwrap_or(fallback)
}

/// CST builder: pushes leaves in document order, flushing trivia gaps and
/// `##` comments between them so every byte stays covered exactly once.
struct Builder<'a> {
    file: SourceId,
    comments: &'a [Token],
    comment_pos: usize,
    last_end: u32,
}

impl<'a> Builder<'a> {
    fn new(file: SourceId, comments: &'a [Token]) -> Self {
        Self {
            file,
            comments,
            comment_pos: 0,
            last_end: 0,
        }
    }

    /// Push a leaf built elsewhere (token or description): flush the gap
    /// since the previous leaf, then claim the leaf's span.
    fn push_leaf(&mut self, out: &mut Vec<SyntaxNode>, node: SyntaxNode) {
        debug_assert!(
            node.span.start >= self.last_end,
            "leaves must be pushed in document order"
        );
        self.gap(out, node.span.start);
        self.last_end = self.last_end.max(node.span.end);
        out.push(node);
    }

    /// Push one source token as a leaf.
    fn leaf(&mut self, out: &mut Vec<SyntaxNode>, token: &Token) {
        self.push_leaf(out, SyntaxNode::token_leaf(token.clone()));
    }

    /// Push an interior node whose children were already pushed through
    /// this builder (no gap to flush; ends exactly at the cursor).
    fn push_inner(&mut self, out: &mut Vec<SyntaxNode>, node: SyntaxNode) {
        debug_assert!(
            node.span.end == self.last_end,
            "interior node must end at the builder cursor"
        );
        out.push(node);
    }

    /// Emit trivia/comments covering `[last_end, upto)`.
    fn gap(&mut self, out: &mut Vec<SyntaxNode>, upto: u32) {
        while self.comment_pos < self.comments.len()
            && self.comments[self.comment_pos].span.start < upto
        {
            let comment = &self.comments[self.comment_pos];
            debug_assert!(
                comment.span.start >= self.last_end,
                "comments must be consumed in document order"
            );
            if comment.span.start > self.last_end {
                out.push(SyntaxNode::trivia(Span::new(
                    self.file,
                    self.last_end,
                    comment.span.start,
                )));
            }
            self.last_end = comment.span.end;
            out.push(SyntaxNode::token_leaf(comment.clone()));
            self.comment_pos += 1;
        }
        if upto > self.last_end {
            out.push(SyntaxNode::trivia(Span::new(
                self.file,
                self.last_end,
                upto,
            )));
            self.last_end = upto;
        }
    }

    /// Flush trailing trivia through end of source.
    fn finish(&mut self, out: &mut Vec<SyntaxNode>, total: u32) {
        self.gap(out, total);
        debug_assert_eq!(
            self.comment_pos,
            self.comments.len(),
            "every comment must be consumed"
        );
    }
}

/// Split header tokens at depth-zero `;`. Returns pieces plus separators.
fn split_pieces(toks: &[Token], file: SourceId) -> Result<(Vec<&[Token]>, Vec<Token>), Fail> {
    if toks.is_empty() {
        return Err(Fail::new(
            "E1205",
            "empty statement".to_string(),
            Span::new(file, 0, 0),
        ));
    }
    let mut pieces: Vec<&[Token]> = Vec::new();
    let mut seps: Vec<Token> = Vec::new();
    let mut depth = 0u32;
    let mut start = 0usize;
    for (index, token) in toks.iter().enumerate() {
        if let TokenKind::Punct(punct) = token.kind {
            if punct.is_opener() {
                depth += 1;
            } else if punct.is_closer() {
                depth = depth.saturating_sub(1);
            } else if punct == Punct::Semicolon && depth == 0 {
                if start == index {
                    return Err(Fail::new(
                        "E1205",
                        "empty semicolon entry".to_string(),
                        token.span,
                    ));
                }
                pieces.push(&toks[start..index]);
                seps.push(token.clone());
                start = index + 1;
            }
        }
    }
    if start == toks.len() {
        debug_assert!(!seps.is_empty(), "nonempty input with trailing separator");
        return Err(Fail::new(
            "E1205",
            "trailing semicolon is not supported".to_string(),
            seps.last().map(|t| t.span).unwrap_or(Span::new(file, 0, 0)),
        ));
    }
    pieces.push(&toks[start..]);
    Ok((pieces, seps))
}

/// Heads that are never semicolon leaves (GRAMMAR compound headers).
fn is_compound_head(text: &str, piece: &[Token]) -> bool {
    matches!(piece.first(), Some(token) if token.kind == TokenKind::Name && matches!(
        token.text(text),
        "Given"
            | "When"
            | "Then"
            | "scenario"
            | "capability"
            | "judgment"
            | "page"
            | "examples"
            | "backfill"
            | "tab"
            | "card"
            | "details"
            | "if"
            | "for"
            | "do"
            | "else"
    ))
}

/// Reject compound headers inside a multi-piece line before dispatching.
fn check_semi_heads(text: &str, pieces: &[&[Token]]) -> Result<(), Fail> {
    if pieces.len() > 1 {
        for piece in pieces {
            if is_compound_head(text, piece) {
                let head = &piece[0];
                return Err(Fail::new(
                    "E1205",
                    format!(
                        "compound `{}` cannot form a semicolon sequence; give it its own logical line",
                        head.text(text)
                    ),
                    head.span,
                ));
            }
        }
    }
    Ok(())
}

/// Whether any token in the piece is a lexer-level error (already
/// reported; the parser wraps the piece without a new diagnostic).
fn piece_has_error(piece: &[Token]) -> bool {
    piece.iter().any(|t| t.kind == TokenKind::Error)
}

/// Whether the app header carries the `uses=` attribute. GRAMMAR: "The
/// presence of `uses=` selects the composed-app production" — an
/// attribute, not a token. A stray `uses` (app name, caption value) or
/// a nested `uses=` inside delimiters must not select composed.
fn app_has_uses_attr(text: &str, toks: &[Token]) -> bool {
    header_has_attr(text, toks, "uses")
}

/// Whether header tokens carry a depth-zero `name=` attribute. Nested
/// `name=` inside delimiters never counts.
fn header_has_attr(text: &str, toks: &[Token], name: &str) -> bool {
    let mut depth = 0u32;
    for (index, token) in toks.iter().enumerate() {
        if let TokenKind::Punct(punct) = token.kind {
            if punct.is_opener() {
                depth += 1;
            } else if punct.is_closer() {
                depth = depth.saturating_sub(1);
            }
            continue;
        }
        if depth == 0
            && token.is_name(text, name)
            && toks
                .get(index + 1)
                .is_some_and(|next| next.is_punct(Punct::Eq))
        {
            return true;
        }
    }
    false
}

/// Expression-nesting budget shared by `parse_expr` and `parse_value`.
/// Every expression cycle (`parse_primary`, `parse_object`, `parse_call`,
/// prefix/binary recursion) funnels through one of those two choke
/// points, so guarding them bounds all five; each nesting level costs
/// ~2 units. The budget caps NATIVE stack use, not abstract levels: one
/// level is ~5 native frames (expr/inner/value/inner/primary) at ~1-2KB
/// each in unoptimized builds, so 64 units (~32 levels, ~160 frames,
/// ~300KB) stays 6x clear of the 2MB default thread stack while leaving
/// genuine code (a handful of levels) 3x headroom. Past the budget
/// parsing fails with E1215 instead of overflowing the stack.
const MAX_EXPR_DEPTH: u32 = 64;

/// Suite-nesting budget shared by statement suites (`parse_statements`)
/// and UI subtrees (`parse_ui_line`, `parse_ui_tab_children`), which
/// never nest inside each other. Statement/UI frames are fat in
/// unoptimized builds (~20KB per level measured: 96-deep `if` nesting
/// overflows a 2MB debug test thread), so 16 levels (~320KB) stays 6x
/// under the observed cliff while leaving genuine code (a handful of
/// levels) headroom; expressions can add ~300KB more at the deepest
/// point (see [`MAX_EXPR_DEPTH`]), still 3x clear overall. Past the
/// budget the subtree is flat-wrapped as errors with E1216/E1200
/// instead of overflowing the stack.
const MAX_SUITE_DEPTH: u32 = 16;

/// Whole-program parser state.
struct Parser<'a> {
    file: SourceId,
    text: &'a str,
    line_starts: &'a [u32],
    diags: Vec<Diagnostic>,
    builder: Builder<'a>,
    /// Current expression-nesting depth (see [`MAX_EXPR_DEPTH`]).
    expr_depth: u32,
    /// Current suite-nesting depth (see [`MAX_SUITE_DEPTH`]).
    /// `error_for_line` is iterative (heap stack), and `attach_level` is
    /// bounded by the layout tree cap, so no other counter is needed.
    suite_depth: u32,
}

impl<'a> Parser<'a> {
    fn cursor(&self, toks: &'a [Token], eof: Span) -> Cursor<'a> {
        Cursor::new(toks, self.text, eof)
    }

    fn line_eof(&self, line: &LogicalLine) -> Span {
        piece_eof(&line.tokens, self.file, Span::new(self.file, 0, 0))
    }

    /// Push the attached description node, if any.
    fn push_description(&mut self, out: &mut Vec<SyntaxNode>, line: &LogicalLine) {
        if let Some(attached) = &line.description {
            let node = SyntaxNode::description(attached.tokens.clone(), attached.data.clone());
            self.builder.push_leaf(out, node);
        }
    }

    /// Push a dangling-description marker line (empty tokens, E1125
    /// already reported by layout) as an error node in position.
    fn push_dangling(&mut self, out: &mut Vec<SyntaxNode>, line: &LogicalLine) {
        debug_assert!(line.tokens.is_empty());
        let mut kids = Vec::new();
        self.push_description(&mut kids, line);
        debug_assert!(!kids.is_empty(), "dangling marker carries a description");
        let node = SyntaxNode::enclosing(SyntaxKind::Error, kids);
        self.builder.push_inner(out, node);
    }

    /// Push raw tokens in order, decoding inline `#` groups into
    /// Description nodes. Desc tokens are never token leaves (that
    /// panics); every unclassified-token site routes through here.
    fn push_tokens_with_descs(&mut self, out: &mut Vec<SyntaxNode>, toks: &[Token]) {
        let mut descs: Vec<Token> = Vec::new();
        for token in toks {
            if token.kind == TokenKind::Desc {
                descs.push(token.clone());
                continue;
            }
            if !descs.is_empty() {
                let target = descs[0].clone();
                let data = decode_description_set(
                    self.file,
                    self.text,
                    self.line_starts,
                    &descs,
                    &target,
                    &mut self.diags,
                );
                let node = SyntaxNode::description(std::mem::take(&mut descs), data);
                self.builder.push_leaf(out, node);
            }
            self.builder.leaf(out, token);
        }
        if !descs.is_empty() {
            let target = descs[0].clone();
            let data = decode_description_set(
                self.file,
                self.text,
                self.line_starts,
                &descs,
                &target,
                &mut self.diags,
            );
            let node = SyntaxNode::description(std::mem::take(&mut descs), data);
            self.builder.push_leaf(out, node);
        }
    }

    /// Wrap raw tokens (with inline `#` groups decoded) in an error node.
    fn error_for_tokens(&mut self, out: &mut Vec<SyntaxNode>, toks: &[Token]) {
        let mut kids = Vec::new();
        self.push_tokens_with_descs(&mut kids, toks);
        if !kids.is_empty() {
            let node = SyntaxNode::enclosing(SyntaxKind::Error, kids);
            self.builder.push_inner(out, node);
        }
    }

    /// Wrap child lines (already parsed or raw) in error nodes.
    fn error_for_children(&mut self, out: &mut Vec<SyntaxNode>, children: &'a [LogicalLine]) {
        for child in children {
            self.error_for_line(out, child);
        }
    }

    /// Wrap a whole logical line (description, tokens, children) as one
    /// error subtree, preserving document order. Iterative over an
    /// explicit heap stack: error wrapping must survive arbitrarily deep
    /// subtrees (including over-budget suites) without native recursion.
    fn error_for_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        if line.tokens.is_empty() {
            self.push_dangling(out, line);
            return;
        }
        struct Frame<'x> {
            line: &'x LogicalLine,
            kids: Vec<SyntaxNode>,
            next: usize,
        }
        let mut root_kids = Vec::new();
        self.push_description(&mut root_kids, line);
        self.push_tokens_with_descs(&mut root_kids, &line.tokens);
        let mut stack = vec![Frame {
            line,
            kids: root_kids,
            next: 0,
        }];
        while !stack.is_empty() {
            let advance = {
                let frame = stack.last_mut().expect("nonempty stack");
                if frame.next >= frame.line.children.len() {
                    None
                } else {
                    let child: &'a LogicalLine = &frame.line.children[frame.next];
                    frame.next += 1;
                    Some(child)
                }
            };
            match advance {
                Some(child) if child.tokens.is_empty() => {
                    let frame = stack.last_mut().expect("nonempty stack");
                    self.push_dangling(&mut frame.kids, child);
                }
                Some(child) => {
                    let mut kids = Vec::new();
                    self.push_description(&mut kids, child);
                    self.push_tokens_with_descs(&mut kids, &child.tokens);
                    stack.push(Frame {
                        line: child,
                        kids,
                        next: 0,
                    });
                }
                None => {
                    let frame = stack.pop().expect("nonempty stack");
                    let node = SyntaxNode::enclosing(SyntaxKind::Error, frame.kids);
                    match stack.last_mut() {
                        Some(parent) => self.builder.push_inner(&mut parent.kids, node),
                        None => self.builder.push_inner(out, node),
                    }
                }
            }
        }
    }

    /// Flat-wrap an over-budget suite: one nesting diagnostic plus
    /// iterative error nodes, without recursing further.
    fn cap_suite(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        lines: &'a [LogicalLine],
        what: &str,
        code: &'static str,
    ) {
        let span = lines
            .first()
            .and_then(|line| line.tokens.first())
            .map(|token| token.span)
            .unwrap_or_else(|| Span::new(self.file, 0, 0));
        self.diags.push(
            Fail::new(
                code,
                format!("{what} nesting exceeds the {MAX_SUITE_DEPTH}-level budget"),
                span,
            )
            .diag(),
        );
        for line in lines {
            self.error_for_line(out, line);
        }
    }

    /// Record a failure and wrap the line as an error subtree.
    fn recover(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine, fail: Fail) {
        self.diags.push(fail.diag());
        self.error_for_line(out, line);
    }

    /// Run one declaration attempt into scratch: on success commit the
    /// nodes to `out`, on failure rewind the builder (byte cursor and
    /// comment queue) so recovery re-pushes the same span exactly once.
    /// Diagnostics are transactional too: speculative pushes inside the
    /// attempt (inline description decodes) are truncated on failure,
    /// since recovery re-decodes the same groups — otherwise every
    /// shape error would double (same code + span).
    fn attempt<R>(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        run: impl FnOnce(&mut Self, &mut Vec<SyntaxNode>) -> Result<R, Fail>,
    ) -> Result<R, Fail> {
        let mark_end = self.builder.last_end;
        let mark_comments = self.builder.comment_pos;
        let mark_diags = self.diags.len();
        let mut scratch = Vec::new();
        match run(&mut *self, &mut scratch) {
            Ok(value) => {
                out.extend(scratch);
                Ok(value)
            }
            Err(fail) => {
                self.builder.last_end = mark_end;
                self.builder.comment_pos = mark_comments;
                self.diags.truncate(mark_diags);
                Err(fail)
            }
        }
    }

    /// Leaf-only lines: report E1200 and swallow an unexpected suite.
    fn swallow_children(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        what: &str,
        span: Span,
    ) {
        if !children.is_empty() {
            self.diags.push(
                Fail::new(
                    "E1200",
                    format!("{what} cannot own an indented suite"),
                    span,
                )
                .diag(),
            );
            self.error_for_children(out, children);
        }
    }
}

/// Parse a laid-out file into a lossless CST plus diagnostics.
pub fn parse_program(
    file: SourceId,
    text: &str,
    layout: &LayoutResult,
) -> (SyntaxNode, Vec<Diagnostic>) {
    let mut parser = Parser {
        file,
        text,
        line_starts: &layout.line_starts,
        diags: Vec::new(),
        builder: Builder::new(file, &layout.comments),
        expr_depth: 0,
        suite_depth: 0,
    };
    let mut kids = Vec::new();
    let mut index = 0usize;
    while index < layout.roots.len() {
        let line = &layout.roots[index];
        if line.tokens.is_empty() {
            parser.push_dangling(&mut kids, line);
            index += 1;
            continue;
        }
        match split_pieces(&line.tokens, file) {
            Err(fail) => {
                parser.recover(&mut kids, line, fail);
                index += 1;
                continue;
            }
            Ok((pieces, _)) if pieces.len() > 1 => {
                let fail = Fail::new(
                    "E1205",
                    "top-level declarations cannot form a semicolon sequence".to_string(),
                    line.tokens[0].span,
                );
                parser.recover(&mut kids, line, fail);
                index += 1;
                continue;
            }
            Ok(_) => {}
        }
        let head_is = |word: &str| line.tokens[0].is_name(text, word);
        if head_is("app") {
            index = parser.parse_app(&mut kids, &layout.roots, index);
        } else if head_is("package") {
            parser.parse_package(&mut kids, line);
            index += 1;
        } else if head_is("migration") {
            parser.parse_migration(&mut kids, line);
            index += 1;
        } else {
            let fail = Fail::new(
                "E1211",
                "expected app, package or migration".to_string(),
                line.tokens[0].span,
            );
            parser.recover(&mut kids, line, fail);
            index += 1;
        }
    }
    parser.builder.finish(&mut kids, text.len() as u32);
    let node = if kids.is_empty() {
        SyntaxNode::interior(SyntaxKind::File, Span::new(file, 0, 0), Vec::new())
    } else {
        SyntaxNode::interior(
            SyntaxKind::File,
            Span::new(file, 0, text.len() as u32),
            kids,
        )
    };
    (node, parser.diags)
}

// File structure: apps, packages, imports, contexts -----------------------

impl<'a> Parser<'a> {
    /// Parse an app header plus following siblings; return next index.
    fn parse_app(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        roots: &'a [LogicalLine],
        index: usize,
    ) -> usize {
        let line = &roots[index];
        // Descriptions precede their owner as siblings at every level.
        self.push_description(out, line);
        let mut all = Vec::new();
        let eof = self.line_eof(line);
        let uses_present = app_has_uses_attr(self.text, &line.tokens);
        let mut cursor = self.cursor(&line.tokens, eof);
        if let Err(fail) = self.attempt(&mut all, |parser, scratch| {
            parser.parse_app_header(&mut cursor, scratch)
        }) {
            // Shallow recovery: the header tokens become an error node
            // and sibling consumption continues with the body.
            self.diags.push(fail.diag());
            self.error_for_tokens(&mut all, &line.tokens);
        }
        if !line.children.is_empty() {
            self.diags.push(
                Fail::new(
                    "E1200",
                    "app header cannot own an indented suite; sections are siblings".to_string(),
                    line.tokens[0].span,
                )
                .diag(),
            );
            self.error_for_children(&mut all, &line.children);
        }
        let mut next = index + 1;
        // Optional context immediately follows its app.
        if next < roots.len()
            && !roots[next].tokens.is_empty()
            && roots[next].tokens[0].is_name(self.text, "context")
        {
            self.parse_context(&mut all, &roots[next]);
            next += 1;
        }
        if uses_present {
            // Composed app: trailing `use` lines only.
            while next < roots.len() {
                let candidate = &roots[next];
                if candidate.tokens.is_empty() {
                    break; // Dangling marker belongs to the top level.
                }
                if !candidate.tokens[0].is_name(self.text, "use") {
                    break;
                }
                self.parse_import_line(&mut all, candidate);
                next += 1;
            }
        } else {
            // Implicit app: imports plus the ordered section triple wins
            // the following siblings up to the next top-level head.
            let mut body: Vec<&'a LogicalLine> = Vec::new();
            while next < roots.len() {
                let candidate = &roots[next];
                if !candidate.tokens.is_empty()
                    && matches!(
                        candidate.tokens[0].text(self.text),
                        "app" | "package" | "migration"
                    )
                {
                    break;
                }
                body.push(candidate);
                next += 1;
            }
            let owner = line.tokens[0].span;
            self.parse_package_body(&mut all, &body, owner);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::App, all);
        self.builder.push_inner(out, node);
        next
    }

    /// Parse `app NAME` attributes into header children.
    fn parse_app_header(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let head = cursor.expect_name_is("app")?;
        self.builder.leaf(kids, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(kids, &name);
        self.parse_attributes(cursor, kids, HeaderKind::App)?;
        cursor.end()?;
        Ok(())
    }

    fn parse_package(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        self.push_description(out, line);
        let mut kids = Vec::new();
        let eof = self.line_eof(line);
        let mut cursor = self.cursor(&line.tokens, eof);
        if let Err(fail) = self.attempt(&mut kids, |parser, scratch| {
            let head = cursor.expect_name_is("package")?;
            parser.builder.leaf(scratch, &head);
            let name = cursor.expect_name()?;
            parser.builder.leaf(scratch, &name);
            parser.parse_attributes(&mut cursor, scratch, HeaderKind::Package)?;
            cursor.end()?;
            Ok(())
        }) {
            self.diags.push(fail.diag());
            self.error_for_tokens(&mut kids, &line.tokens);
        }
        if line.children.is_empty() {
            self.diags.push(
                Fail::new(
                    "E1204",
                    "package requires an ordered Given/When/Then body".to_string(),
                    line.tokens[0].span,
                )
                .diag(),
            );
        } else {
            let body: Vec<&LogicalLine> = line.children.iter().collect();
            let owner = line.tokens[0].span;
            self.parse_package_body(&mut kids, &body, owner);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Package, kids);
        self.builder.push_inner(out, node);
    }

    /// Shared implicit-app/package body: imports then Given/When/Then.
    fn parse_package_body(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        body: &[&'a LogicalLine],
        owner: Span,
    ) {
        let mut expected: Vec<&str> = vec!["Given", "When", "Then"];
        let mut sections_seen = 0usize;
        let mut preferences_seen = false;
        for line in body {
            if line.tokens.is_empty() {
                self.push_dangling(out, line);
                continue;
            }
            let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
                Ok(split) => split,
                Err(fail) => {
                    self.recover(out, line, fail);
                    continue;
                }
            };
            if pieces.len() > 1 {
                if !line.children.is_empty() {
                    self.recover(
                        out,
                        line,
                        Fail::new(
                            "E1205",
                            "semicolon sequences cannot own an indented suite".to_string(),
                            line.tokens[0].span,
                        ),
                    );
                    continue;
                }
                if let Err(fail) = check_semi_heads(self.text, &pieces) {
                    self.recover(out, line, fail);
                    continue;
                }
            }
            self.push_description(out, line);
            for (index, piece) in pieces.iter().enumerate() {
                if piece_has_error(piece) {
                    self.error_for_tokens(out, piece);
                } else if piece[0].is_name(self.text, "use") {
                    if sections_seen > 0 {
                        self.diags.push(
                            Fail::new(
                                "E1211",
                                "imports must precede Given".to_string(),
                                piece[0].span,
                            )
                            .diag(),
                        );
                        self.error_for_tokens(out, piece);
                    } else {
                        let eof = piece_eof(piece, self.file, self.line_eof(line));
                        let mut cursor = self.cursor(piece, eof);
                        let result = self.attempt(out, |parser, scratch| {
                            parser.parse_import(&mut cursor, scratch)
                        });
                        if let Err(fail) = result {
                            self.diags.push(fail.diag());
                            self.error_for_tokens(out, piece);
                        }
                        let span = piece[0].span;
                        self.swallow_children(out, &line.children, "import", span);
                    }
                } else {
                    let word = piece[0].text(self.text);
                    let section_kind = match word {
                        "Given" | "When" | "Then" => Some(word),
                        _ => None,
                    };
                    match section_kind {
                        None => {
                            self.diags.push(
                                Fail::new(
                                    "E1211",
                                    format!(
                                        "expected package import or {}",
                                        expected.first().copied().unwrap_or("end of package")
                                    ),
                                    piece[0].span,
                                )
                                .diag(),
                            );
                            self.error_for_tokens(out, piece);
                            self.error_for_children(out, &line.children);
                        }
                        Some(kind) => {
                            if expected.first() != Some(&kind) {
                                self.diags.push(
                                    Fail::new(
                                        "E1211",
                                        "sections must appear once in Given/When/Then order"
                                            .to_string(),
                                        piece[0].span,
                                    )
                                    .diag(),
                                );
                            } else {
                                expected.remove(0);
                            }
                            sections_seen += 1;
                            // Trailing header tokens are still an error,
                            // but the section kind is known: parse items.
                            if piece.len() > 1 {
                                self.diags.push(
                                    Fail::new(
                                        "E1201",
                                        "unexpected token after section marker".to_string(),
                                        piece[1].span,
                                    )
                                    .diag(),
                                );
                            }
                            let mut kids = Vec::new();
                            self.builder.leaf(&mut kids, &piece[0]);
                            self.push_tokens_with_descs(&mut kids, &piece[1..]);
                            self.parse_section_items(
                                &mut kids,
                                &line.children,
                                kind,
                                &mut preferences_seen,
                            );
                            let node = SyntaxNode::enclosing(SyntaxKind::Section, kids);
                            self.builder.push_inner(out, node);
                        }
                    }
                }
                if index < seps.len() {
                    self.builder.leaf(out, &seps[index]);
                }
            }
        }
        if !expected.is_empty() {
            self.diags.push(
                Fail::new(
                    "E1204",
                    format!("package is missing {}", expected.join("/")),
                    owner,
                )
                .diag(),
            );
        }
    }

    /// Parse one `use` import line (semicolon pieces allowed).
    fn parse_import_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_import(&mut cursor, scratch)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(out, piece);
                }
                let span = piece.first().map(|t| t.span).unwrap_or(self.line_eof(line));
                self.swallow_children(out, &line.children, "import", span);
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    /// Parse `use path {members} [from=path]` into `out`.
    fn parse_import(
        &mut self,
        cursor: &mut Cursor<'a>,
        out: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let mut kids = Vec::new();
        let head = cursor.expect_name_is("use")?;
        self.builder.leaf(&mut kids, &head);
        let _provider = self.parse_path(cursor, &mut kids)?;
        let open = cursor.expect_p(Punct::LBrace)?;
        self.builder.leaf(&mut kids, &open);
        if cursor.at_p(Punct::RBrace) {
            return cursor.err("E1204", "an import must enumerate at least one member");
        }
        loop {
            let mut member_kids = Vec::new();
            let name = cursor.expect_name()?;
            self.builder.leaf(&mut member_kids, &name);
            if cursor.at_name("as") {
                let as_token = cursor.next().expect("peeked as");
                self.builder.leaf(&mut member_kids, &as_token);
                let alias = cursor.expect_name()?;
                self.builder.leaf(&mut member_kids, &alias);
            }
            let member = SyntaxNode::enclosing(SyntaxKind::ImportMember, member_kids);
            self.builder.push_inner(&mut kids, member);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
            if cursor.at_p(Punct::RBrace) {
                break;
            }
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        self.parse_attributes(cursor, &mut kids, HeaderKind::Import)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Import, kids);
        self.builder.push_inner(out, node);
        Ok(())
    }

    fn parse_context(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        self.push_description(out, line);
        let mut kids = Vec::new();
        let eof = self.line_eof(line);
        let mut cursor = self.cursor(&line.tokens, eof);
        let head = match cursor.expect_name_is("context").and_then(|head| {
            cursor.end()?;
            Ok(head)
        }) {
            Ok(head) => head,
            Err(fail) => {
                self.diags.push(fail.diag());
                self.error_for_tokens(&mut kids, &line.tokens);
                self.error_for_children(&mut kids, &line.children);
                let node = SyntaxNode::enclosing(SyntaxKind::Context, kids);
                self.builder.push_inner(out, node);
                return;
            }
        };
        self.builder.leaf(&mut kids, &head);
        if line.children.is_empty() {
            self.diags
                .push(Fail::new("E1204", "omit an empty context".to_string(), head.span).diag());
        }
        for child in &line.children {
            self.parse_context_line(&mut kids, child);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Context, kids);
        self.builder.push_inner(out, node);
    }

    fn parse_context_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        if line.tokens.is_empty() {
            self.push_dangling(out, line);
            return;
        }
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_context_decl(&mut cursor, scratch)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(out, piece);
                }
                let span = piece.first().map(|t| t.span).unwrap_or(eof);
                self.swallow_children(out, &line.children, "context declaration", span);
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    fn parse_context_decl(
        &mut self,
        cursor: &mut Cursor<'a>,
        out: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let mut kids = Vec::new();
        let head = cursor.expect_name()?;
        let word = self.text_of_owned(&head);
        self.builder.leaf(&mut kids, &head);
        match word.as_str() {
            "locale" => {
                self.parse_attributes(cursor, &mut kids, HeaderKind::Locale)?;
                cursor.end()?;
            }
            "theme" => {
                let before = self.diags.len();
                self.parse_attributes(cursor, &mut kids, HeaderKind::Theme)?;
                cursor.end()?;
                if self.diags.len() == before && Self::attr_count(&kids) == 0 {
                    return Err(Fail::new(
                        "E1204",
                        "theme must declare a setting difference".to_string(),
                        head.span,
                    ));
                }
            }
            "files" => {
                let before = self.diags.len();
                self.parse_attributes(cursor, &mut kids, HeaderKind::Files)?;
                cursor.end()?;
                if self.diags.len() == before && Self::attr_count(&kids) == 0 {
                    return Err(Fail::new(
                        "E1204",
                        "files must declare a policy difference".to_string(),
                        head.span,
                    ));
                }
            }
            "binding" => {
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut kids, &name);
                let durable = cursor.expect_name_is("DurableObject")?;
                self.builder.leaf(&mut kids, &durable);
                self.parse_attributes(cursor, &mut kids, HeaderKind::Binding)?;
                cursor.end()?;
            }
            "queue" => {
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut kids, &name);
                self.parse_attributes(cursor, &mut kids, HeaderKind::Queue)?;
                cursor.end()?;
            }
            "cache" => {
                let kv = cursor.expect_name_is("KV")?;
                self.builder.leaf(&mut kids, &kv);
                self.parse_attributes(cursor, &mut kids, HeaderKind::Cache)?;
                cursor.end()?;
            }
            "analytics" => {
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut kids, &name);
                self.parse_schema_fields(cursor, &mut kids)?;
                cursor.end()?;
            }
            _ => {
                return Err(Fail::new(
                    "E1200",
                    "unsupported context declaration; omit unchanged runtime/auth/database/teams defaults".to_string(),
                    head.span,
                ));
            }
        }
        let node = SyntaxNode::enclosing(SyntaxKind::ContextDecl, kids);
        self.builder.push_inner(out, node);
        Ok(())
    }

    fn attr_count(kids: &[SyntaxNode]) -> usize {
        kids.iter()
            .filter(|n| n.kind == SyntaxKind::Attribute)
            .count()
    }

    fn text_of_owned(&self, token: &Token) -> String {
        token.text(self.text).to_string()
    }
}

// Expressions, types, labels, fields ----------------------------------------

/// Word stoplist for one expression slot: returns true for words that end
/// the current value (attribute names, modifiers, clause words, `{`).
type Stop<'s> = &'s dyn Fn(&str) -> bool;

fn never(_word: &str) -> bool {
    false
}

impl<'a> Parser<'a> {
    /// Enter one expression-nesting level, failing past the budget.
    fn enter_expr(&mut self, span: Span) -> Result<(), Fail> {
        if self.expr_depth >= MAX_EXPR_DEPTH {
            return Err(Fail::new(
                "E1215",
                format!("expression nesting exceeds the {MAX_EXPR_DEPTH}-level budget"),
                span,
            ));
        }
        self.expr_depth += 1;
        Ok(())
    }

    /// Parse `expr`: an ordinary value plus an optional low-binding query
    /// tail. Clause words stop the tail when the slot's stoplist claims
    /// them (header attributes win over query clauses unparenthesized).
    fn parse_expr(
        &mut self,
        cursor: &mut Cursor<'a>,
        stop: Stop,
        query: bool,
        construct: bool,
    ) -> Result<SyntaxNode, Fail> {
        self.enter_expr(cursor.span_here())?;
        let result = self.parse_expr_inner(cursor, stop, query, construct);
        self.expr_depth -= 1;
        result
    }

    /// Unbudgeted `parse_expr` body; callers use the guarded wrapper.
    fn parse_expr_inner(
        &mut self,
        cursor: &mut Cursor<'a>,
        stop: Stop,
        query: bool,
        construct: bool,
    ) -> Result<SyntaxNode, Fail> {
        let domain = self.parse_value(cursor, 0, stop, construct)?;
        if !query {
            return Ok(domain);
        }
        let mut clauses: Vec<SyntaxNode> = Vec::new();
        let mut last_rank = -1i32;
        while let Some(word) = cursor.word() {
            let rank = match word {
                "archived" => 0,
                "as" => 1,
                "where" => 2,
                "order" => 3,
                "select" => 4,
                _ => break,
            };
            if stop(word) && (matches!(word, "as" | "select" | "where") || cursor.peek_is_eq()) {
                break;
            }
            if matches!(word, "archived" | "order") && !cursor.peek_is_eq() {
                break;
            }
            let keyword = cursor.next().expect("peeked clause word");
            if rank <= last_rank {
                return Err(Fail::new(
                    "E1206",
                    "query clauses are unique and ordered archived/as/where/order/select"
                        .to_string(),
                    keyword.span,
                ));
            }
            last_rank = rank;
            let mut kids = Vec::new();
            self.builder.leaf(&mut kids, &keyword);
            match word {
                "as" => {
                    let alias = cursor.expect_name()?;
                    self.builder.leaf(&mut kids, &alias);
                }
                "archived" => {
                    let eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut kids, &eq);
                    let include = cursor.expect_name_is("include")?;
                    self.builder.leaf(&mut kids, &include);
                }
                "order" => {
                    let eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut kids, &eq);
                    let clause_stop: Stop = &|w| {
                        stop(w) || matches!(w, "archived" | "as" | "where" | "order" | "select")
                    };
                    let value = self.parse_value(cursor, 0, clause_stop, true)?;
                    self.builder.push_inner(&mut kids, value);
                }
                _ => {
                    // `where` / `select`.
                    let clause_stop: Stop = &|w| {
                        stop(w) || matches!(w, "archived" | "as" | "where" | "order" | "select")
                    };
                    let value = self.parse_value(cursor, 0, clause_stop, true)?;
                    self.builder.push_inner(&mut kids, value);
                }
            }
            clauses.push(SyntaxNode::enclosing(SyntaxKind::QueryClause, kids));
        }
        if last_rank < 0 {
            return Ok(domain);
        }
        let mut kids = vec![domain];
        kids.extend(clauses);
        Ok(SyntaxNode::enclosing(SyntaxKind::Query, kids))
    }

    /// Whether the cursor ends the current value: input end, an enclosing
    /// delimiter/comma/semicolon/`->`, a stopped word, or any `NAME =`
    /// attribute boundary (`==` never splits).
    fn stopped(&self, cursor: &Cursor<'a>, stop: Stop) -> bool {
        let Some(token) = cursor.peek() else {
            return true;
        };
        if let TokenKind::Punct(punct) = token.kind
            && matches!(
                punct,
                Punct::Comma
                    | Punct::RParen
                    | Punct::RBracket
                    | Punct::RBrace
                    | Punct::Semicolon
                    | Punct::Arrow
            )
        {
            return true;
        }
        if stop(token.text(cursor.text)) {
            return true;
        }
        token.kind == TokenKind::Name && cursor.peek_is_eq()
    }

    /// Infix operator power, if the cursor holds one.
    fn infix_power(cursor: &Cursor<'a>) -> Option<u8> {
        let token = cursor.peek()?;
        match token.kind {
            TokenKind::Name => match token.text(cursor.text) {
                "or" => Some(20),
                "and" => Some(30),
                "in" | "is" => Some(40),
                _ => None,
            },
            TokenKind::Punct(punct) => match punct {
                Punct::QuestionQuestion => Some(10),
                Punct::EqEq | Punct::NotEq | Punct::Lt | Punct::LtEq | Punct::Gt | Punct::GtEq => {
                    Some(40)
                }
                Punct::Plus | Punct::Minus => Some(50),
                Punct::Star | Punct::Slash | Punct::Percent => Some(60),
                _ => None,
            },
            _ => None,
        }
    }

    /// Precedence-climbing value with prefix/postfix/binary layers.
    fn parse_value(
        &mut self,
        cursor: &mut Cursor<'a>,
        minimum: u8,
        stop: Stop,
        construct: bool,
    ) -> Result<SyntaxNode, Fail> {
        self.enter_expr(cursor.span_here())?;
        let result = self.parse_value_inner(cursor, minimum, stop, construct);
        self.expr_depth -= 1;
        result
    }

    /// Unbudgeted `parse_value` body; callers use the guarded wrapper.
    fn parse_value_inner(
        &mut self,
        cursor: &mut Cursor<'a>,
        minimum: u8,
        stop: Stop,
        construct: bool,
    ) -> Result<SyntaxNode, Fail> {
        let mut left = if cursor.at_name("not") || cursor.at_p(Punct::Minus) {
            let op = cursor.next().expect("peeked prefix");
            let is_not = op.kind == TokenKind::Name;
            if is_not && minimum > 35 {
                return Err(Fail::new(
                    "E1215",
                    "parenthesize `not` when used as an arithmetic/comparison operand".to_string(),
                    op.span,
                ));
            }
            // Leaf the operator before its operand: builder order is global.
            let mut kids = Vec::new();
            self.builder.leaf(&mut kids, &op);
            let operand =
                self.parse_value(cursor, if is_not { 35 } else { 70 }, stop, construct)?;
            self.builder.push_inner(&mut kids, operand);
            SyntaxNode::enclosing(SyntaxKind::Unary, kids)
        } else {
            self.parse_primary(cursor, stop)?
        };

        loop {
            if cursor.at_p(Punct::Dot) || cursor.at_p(Punct::QuestionDot) {
                let dot = cursor.next().expect("peeked dot");
                let member = cursor.expect_name()?;
                let mut kids = vec![left];
                self.builder.leaf(&mut kids, &dot);
                self.builder.leaf(&mut kids, &member);
                left = SyntaxNode::enclosing(SyntaxKind::Member, kids);
            } else if cursor.at_p(Punct::LParen) {
                if self.is_optional_member(&left) {
                    return cursor.err("E1215", "optional calls are not supported");
                }
                left = self.parse_call(cursor, left)?;
            } else if cursor.at_p(Punct::LBrace) && construct && !stop("{") {
                if !self.is_path_value(&left) {
                    return cursor.err("E1215", "typed value constructor requires a type path");
                }
                let object = self.parse_object(cursor)?;
                let mut kids = vec![left];
                self.builder.push_inner(&mut kids, object);
                left = SyntaxNode::enclosing(SyntaxKind::Construct, kids);
            } else if cursor.at_p(Punct::LBracket) {
                return cursor.err(
                    "E1215",
                    "postfix indexing is unsupported; use at(array,index)",
                );
            } else {
                break;
            }
        }

        loop {
            if self.stopped(cursor, stop) {
                break;
            }
            let Some(power) = Self::infix_power(cursor) else {
                break;
            };
            if power < minimum {
                break;
            }
            if power == 40 && self.is_comparison_binary(&left) {
                return Err(Fail::new(
                    "E1207",
                    "comparisons cannot chain".to_string(),
                    cursor.span_here(),
                ));
            }
            let op = cursor.next().expect("peeked operator");
            let op_span = op.span;
            let right_assoc = op.text(self.text) == "??";
            let mut kids = vec![left];
            self.builder.leaf(&mut kids, &op);
            let right = self.parse_value(
                cursor,
                if right_assoc { power } else { power + 1 },
                stop,
                construct,
            )?;
            self.builder.push_inner(&mut kids, right);
            left = SyntaxNode::enclosing(SyntaxKind::Binary, kids);
            if self.mixes_fallback_boolean(&left) {
                return Err(Fail::new(
                    "E1208",
                    "parenthesize mixing of `??` with `and`/`or`".to_string(),
                    op_span,
                ));
            }
        }
        Ok(left)
    }

    fn parse_primary(&mut self, cursor: &mut Cursor<'a>, stop: Stop) -> Result<SyntaxNode, Fail> {
        let token = cursor.peek().cloned();
        match token {
            Some(token) if token.kind == TokenKind::String => {
                let token = cursor.next().expect("peeked string");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &token);
                let literal = SyntaxNode::enclosing(SyntaxKind::Literal, kids);
                if cursor.at_p(Punct::At) {
                    self.parse_message_suffix(cursor, literal)
                } else {
                    Ok(literal)
                }
            }
            Some(token)
                if matches!(
                    token.kind,
                    TokenKind::Integer
                        | TokenKind::Decimal
                        | TokenKind::Duration
                        | TokenKind::Bytes
                ) =>
            {
                let token = cursor.next().expect("peeked number");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &token);
                // A bare name immediately after a literal is a spaced unit
                // (`5 m`): units must be adjacent, so name the real fix.
                // Attribute boundaries, stopped words, infix names and
                // query clauses are legitimate continuations, not units.
                if let Some(word) = cursor.word()
                    && !cursor.peek_is_eq()
                    && !stop(word)
                    && !matches!(
                        word,
                        "and"
                            | "or"
                            | "in"
                            | "is"
                            | "not"
                            | "as"
                            | "where"
                            | "select"
                            | "order"
                            | "archived"
                    )
                {
                    return Err(Fail::new(
                        "E1005",
                        format!(
                            "unexpected `{word}` after numeric literal; duration/byte units must be adjacent (`5m`, not `5 m`)"
                        ),
                        cursor.span_here(),
                    ));
                }
                Ok(SyntaxNode::enclosing(SyntaxKind::Literal, kids))
            }
            Some(token)
                if token.kind == TokenKind::Name
                    && matches!(token.text(cursor.text), "true" | "false" | "null") =>
            {
                let token = cursor.next().expect("peeked literal");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &token);
                Ok(SyntaxNode::enclosing(SyntaxKind::Literal, kids))
            }
            Some(token) if token.kind == TokenKind::Name => {
                let token = cursor.next().expect("peeked name");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &token);
                Ok(SyntaxNode::enclosing(SyntaxKind::NameRef, kids))
            }
            Some(token) if token.is_punct(Punct::LParen) => {
                let open = cursor.next().expect("peeked paren");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &open);
                let inner = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut kids, inner);
                let close = cursor.expect_p(Punct::RParen)?;
                self.builder.leaf(&mut kids, &close);
                Ok(SyntaxNode::enclosing(SyntaxKind::Group, kids))
            }
            Some(token) if token.is_punct(Punct::LBracket) => {
                let open = cursor.next().expect("peeked bracket");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &open);
                while !cursor.at_p(Punct::RBracket) {
                    if cursor.done() {
                        return cursor.err("E1200", "expected `]` to close the array");
                    }
                    let value = self.parse_expr(cursor, &never, true, true)?;
                    self.builder.push_inner(&mut kids, value);
                    if !cursor.at_p(Punct::Comma) {
                        break;
                    }
                    let comma = cursor.next().expect("peeked comma");
                    self.builder.leaf(&mut kids, &comma);
                }
                let close = cursor.expect_p(Punct::RBracket)?;
                self.builder.leaf(&mut kids, &close);
                Ok(SyntaxNode::enclosing(SyntaxKind::Array, kids))
            }
            Some(token) if token.is_punct(Punct::LBrace) => self.parse_object(cursor),
            _ => cursor.err("E1215", "expected value expression"),
        }
    }

    fn parse_call(
        &mut self,
        cursor: &mut Cursor<'a>,
        callee: SyntaxNode,
    ) -> Result<SyntaxNode, Fail> {
        let mut unwrapped = &callee;
        while unwrapped.kind == SyntaxKind::Group {
            unwrapped = &unwrapped.children[1];
        }
        let anonymous = unwrapped.kind == SyntaxKind::MessageValue;
        let mut kids = vec![callee];
        let open = cursor.next().expect("peeked call paren");
        self.builder.leaf(&mut kids, &open);
        let mut names: Vec<String> = Vec::new();
        let mut named = false;
        let mut count = 0usize;
        while !cursor.at_p(Punct::RParen) {
            if cursor.done() {
                return cursor.err("E1200", "expected `)` to close the call");
            }
            let mut arg_kids = Vec::new();
            if cursor.at_any_name() && cursor.peek_is_eq() {
                let name = cursor.next().expect("peeked arg name");
                if names.contains(&name.text(cursor.text).to_string()) {
                    return Err(Fail::new(
                        "E1202",
                        format!("duplicate named argument `{}`", name.text(cursor.text)),
                        name.span,
                    ));
                }
                names.push(name.text(cursor.text).to_string());
                named = true;
                self.builder.leaf(&mut arg_kids, &name);
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut arg_kids, &eq);
            } else if anonymous {
                return cursor.err(
                    "E1215",
                    "anonymous message arguments must be explicitly named",
                );
            } else if named {
                return cursor.err("E1215", "positional arguments must precede named arguments");
            }
            let value = self.parse_expr(cursor, &never, true, true)?;
            self.builder.push_inner(&mut arg_kids, value);
            let arg = SyntaxNode::enclosing(SyntaxKind::Argument, arg_kids);
            self.builder.push_inner(&mut kids, arg);
            count += 1;
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RParen)?;
        self.builder.leaf(&mut kids, &close);
        if anonymous && count == 0 {
            return cursor.err("E1215", "omit an empty anonymous message call");
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::Call, kids))
    }

    /// Parse a `{...}` structural value object (shorthand included).
    fn parse_object(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let open = cursor.expect_p(Punct::LBrace)?;
        self.builder.leaf(&mut kids, &open);
        let mut seen: Vec<String> = Vec::new();
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1200", "expected `}` to close the object");
            }
            let mut entry = Vec::new();
            let key = cursor.expect_name()?;
            if seen.contains(&key.text(cursor.text).to_string()) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate object field `{}`", key.text(cursor.text)),
                    key.span,
                ));
            }
            seen.push(key.text(cursor.text).to_string());
            self.builder.leaf(&mut entry, &key);
            if cursor.at_p(Punct::Eq) {
                let eq = cursor.next().expect("peeked eq");
                self.builder.leaf(&mut entry, &eq);
                let value = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut entry, value);
            }
            // A single-child entry is the `{field}` shorthand.
            let entry = SyntaxNode::enclosing(SyntaxKind::ObjectEntry, entry);
            self.builder.push_inner(&mut kids, entry);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        Ok(SyntaxNode::enclosing(SyntaxKind::Object, kids))
    }

    /// First source token among a wrapper's children, skipping trivia
    /// gaps and `##` comments that the builder interleaves as siblings.
    fn first_token<'n>(&self, node: &'n SyntaxNode) -> Option<&'n Token> {
        node.children.iter().find_map(|child| match child.token() {
            Some(token) if token.kind != TokenKind::Comment => Some(token),
            _ => None,
        })
    }

    /// Text of the first source token among a wrapper's children.
    fn first_token_text<'t>(&self, node: &'t SyntaxNode) -> Option<&'t str>
    where
        'a: 't,
    {
        self.first_token(node).map(|token| token.text(self.text))
    }

    fn is_optional_member(&self, node: &SyntaxNode) -> bool {
        node.kind == SyntaxKind::Member && self.first_token_text(node) == Some("?.")
    }

    fn is_path_value(&self, node: &SyntaxNode) -> bool {
        // Iterative: member chains are built in a loop, so they can run
        // deeper than any recursion budget.
        let mut current = node;
        loop {
            match current.kind {
                SyntaxKind::NameRef => return true,
                SyntaxKind::Member => {
                    if self.is_optional_member(current) {
                        return false;
                    }
                    match current.children.first() {
                        Some(receiver) => current = receiver,
                        None => return false,
                    }
                }
                _ => return false,
            }
        }
    }

    fn is_comparison_binary(&self, node: &SyntaxNode) -> bool {
        node.kind == SyntaxKind::Binary
            && self
                .first_token_text(node)
                .is_some_and(|op| matches!(op, "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "is"))
    }

    /// Whether one unparenthesized segment mixes `??` with `and`/`or`.
    /// Only [`SyntaxKind::Binary`] is descended into, so parentheses,
    /// calls, arrays, objects and queries start fresh segments.
    fn mixes_fallback_boolean(&self, node: &SyntaxNode) -> bool {
        // Iterative over an explicit stack: left-associative chains are
        // built in a loop and can outgrow the native stack.
        let mut has_fallback = false;
        let mut has_boolean = false;
        let mut stack = vec![node];
        while let Some(node) = stack.pop() {
            if node.kind != SyntaxKind::Binary {
                continue;
            }
            match self.first_token_text(node) {
                Some("??") => has_fallback = true,
                Some("and" | "or") => has_boolean = true,
                _ => {}
            }
            if has_fallback && has_boolean {
                return true;
            }
            // Operands are always the first and last children; trivia and
            // the operator leaf sit between them.
            if let Some(left) = node.children.first() {
                stack.push(left);
            }
            if let Some(right) = node.children.last() {
                stack.push(right);
            }
        }
        false
    }

    /// Parse an `@{...}` inline descriptor suffix onto a source literal.
    fn parse_message_suffix(
        &mut self,
        cursor: &mut Cursor<'a>,
        source: SyntaxNode,
    ) -> Result<SyntaxNode, Fail> {
        let mut kids = vec![source];
        let at = cursor.expect_p(Punct::At)?;
        let brace = cursor.expect_p(Punct::LBrace)?;
        if brace.span.start != at.span.end {
            return Err(Fail::new(
                "E1214",
                "message suffix marker must be contiguous `@{`".to_string(),
                brace.span,
            ));
        }
        self.builder.leaf(&mut kids, &at);
        self.builder.leaf(&mut kids, &brace);
        let mut seen: Vec<String> = Vec::new();
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1214", "expected `}` to close the message suffix");
            }
            let key = cursor.next().expect("peeked variant key");
            let locale = match key.kind {
                TokenKind::Name => key.text(cursor.text).to_string(),
                TokenKind::String => key
                    .string_value
                    .clone()
                    .unwrap_or_else(|| key.text(cursor.text).to_string()),
                _ => {
                    return Err(Fail::new(
                        "E1214",
                        "message locale key must be an identifier or quoted tag".to_string(),
                        key.span,
                    ));
                }
            };
            if seen.contains(&locale.to_lowercase()) {
                return Err(Fail::new(
                    "E1214",
                    "duplicate message locale variant".to_string(),
                    key.span,
                ));
            }
            seen.push(locale.to_lowercase());
            let mut variant = Vec::new();
            self.builder.leaf(&mut variant, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut variant, &eq);
            let value_token = cursor.next().ok_or_else(|| {
                Fail::new(
                    "E1214",
                    "message variant requires a JSON string or null".to_string(),
                    cursor.eof,
                )
            })?;
            let valid = value_token.kind == TokenKind::String
                || (value_token.kind == TokenKind::Name && value_token.text(cursor.text) == "null");
            if !valid {
                return Err(Fail::new(
                    "E1214",
                    "message variant requires a JSON string or null".to_string(),
                    value_token.span,
                ));
            }
            let mut literal = Vec::new();
            self.builder.leaf(&mut literal, &value_token);
            let literal = SyntaxNode::enclosing(SyntaxKind::Literal, literal);
            self.builder.push_inner(&mut variant, literal);
            let variant = SyntaxNode::enclosing(SyntaxKind::MessageVariant, variant);
            self.builder.push_inner(&mut kids, variant);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        Ok(SyntaxNode::enclosing(SyntaxKind::MessageValue, kids))
    }

    /// Parse a scalar caption: literal source STRING with optional
    /// descriptor suffix, or a static message path.
    fn parse_caption(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        match cursor.peek() {
            Some(token) if token.kind == TokenKind::String => {
                let token = cursor.next().expect("peeked string");
                let mut kids = Vec::new();
                self.builder.leaf(&mut kids, &token);
                let literal = SyntaxNode::enclosing(SyntaxKind::Literal, kids);
                if cursor.at_p(Punct::At) {
                    self.parse_message_suffix(cursor, literal)
                } else {
                    Ok(literal)
                }
            }
            _ => Ok(self.parse_path_node(cursor)?.0),
        }
    }

    /// Parse a label value in the given closed shape.
    fn parse_label(
        &mut self,
        cursor: &mut Cursor<'a>,
        shape: LabelShape,
    ) -> Result<SyntaxNode, Fail> {
        if !cursor.at_p(Punct::LBrace) {
            if shape == LabelShape::Crud {
                return cursor.err("E1214", "CRUD label requires a closed operation map");
            }
            match cursor.peek() {
                Some(token) if token.kind == TokenKind::String || token.kind == TokenKind::Name => {
                    return self.parse_caption(cursor);
                }
                _ => {
                    return cursor.err("E1214", "label requires a string caption or message path");
                }
            }
        }
        if shape == LabelShape::Scalar {
            return cursor.err("E1214", "this declaration label requires a scalar caption");
        }
        let mut kids = Vec::new();
        let open = cursor.next().expect("peeked brace");
        self.builder.leaf(&mut kids, &open);
        let mut seen: Vec<String> = Vec::new();
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1214", "expected `}` to close the label object");
            }
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            let allowed = match shape {
                LabelShape::Field => ["text", "values"].contains(&word.as_str()),
                LabelShape::Crud => ["create", "update", "delete"].contains(&word.as_str()),
                LabelShape::Scalar => false,
            };
            if !allowed {
                return Err(Fail::new(
                    "E1214",
                    format!("unsupported label slot `{word}`"),
                    key.span,
                ));
            }
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate label slot `{word}`"),
                    key.span,
                ));
            }
            seen.push(word.clone());
            if word == "values" {
                let mut entry = Vec::new();
                self.builder.leaf(&mut entry, &key);
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut entry, &eq);
                let inner_open = cursor.expect_p(Punct::LBrace)?;
                self.builder.leaf(&mut entry, &inner_open);
                let mut cases = 0usize;
                let mut case_seen: Vec<String> = Vec::new();
                while !cursor.at_p(Punct::RBrace) {
                    if cursor.done() {
                        return cursor.err("E1214", "expected `}` to close the label cases");
                    }
                    let case = cursor.expect_name()?;
                    let case_name = case.text(cursor.text).to_string();
                    if case_seen.contains(&case_name) {
                        return Err(Fail::new(
                            "E1202",
                            "duplicate label case".to_string(),
                            case.span,
                        ));
                    }
                    case_seen.push(case_name);
                    let mut case_kids = Vec::new();
                    self.builder.leaf(&mut case_kids, &case);
                    let case_eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut case_kids, &case_eq);
                    let caption = self.parse_caption(cursor)?;
                    self.builder.push_inner(&mut case_kids, caption);
                    let case_node = SyntaxNode::enclosing(SyntaxKind::LabelCase, case_kids);
                    self.builder.push_inner(&mut entry, case_node);
                    cases += 1;
                    if !cursor.at_p(Punct::Comma) {
                        break;
                    }
                    let comma = cursor.next().expect("peeked comma");
                    self.builder.leaf(&mut entry, &comma);
                }
                let inner_close = cursor.expect_p(Punct::RBrace)?;
                self.builder.leaf(&mut entry, &inner_close);
                if cases == 0 {
                    return Err(Fail::new(
                        "E1214",
                        "label values must contain at least one case".to_string(),
                        key.span,
                    ));
                }
                // `values={...}` stays flat inside the label object.
                // (Extend: only the final node ends at the builder cursor.)
                kids.extend(entry);
            } else {
                self.builder.leaf(&mut kids, &key);
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut kids, &eq);
                let caption = self.parse_caption(cursor)?;
                self.builder.push_inner(&mut kids, caption);
            }
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        if seen.is_empty() {
            return Err(Fail::new(
                "E1214",
                "label object must contain at least one slot".to_string(),
                open.span,
            ));
        }
        let kind = if shape == LabelShape::Crud {
            SyntaxKind::CrudLabels
        } else {
            SyntaxKind::Label
        };
        Ok(SyntaxNode::enclosing(kind, kids))
    }

    /// Parse a dotted path, returning the node plus its name parts.
    fn parse_path_node(
        &mut self,
        cursor: &mut Cursor<'a>,
    ) -> Result<(SyntaxNode, Vec<String>), Fail> {
        let mut kids = Vec::new();
        let mut parts = Vec::new();
        let first = cursor.expect_name()?;
        parts.push(first.text(cursor.text).to_string());
        self.builder.leaf(&mut kids, &first);
        while cursor.at_p(Punct::Dot) {
            let dot = cursor.next().expect("peeked dot");
            self.builder.leaf(&mut kids, &dot);
            let part = cursor.expect_name()?;
            parts.push(part.text(cursor.text).to_string());
            self.builder.leaf(&mut kids, &part);
        }
        Ok((SyntaxNode::enclosing(SyntaxKind::Path, kids), parts))
    }

    /// Parse a dotted path and push it into `kids`.
    fn parse_path(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<Vec<String>, Fail> {
        let (node, parts) = self.parse_path_node(cursor)?;
        self.builder.push_inner(kids, node);
        Ok(parts)
    }

    /// Parse a comma-separated selector list (`[-]path`, ...).
    fn parse_selectors(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        loop {
            if cursor.at_p(Punct::Minus) {
                let minus = cursor.next().expect("peeked minus");
                let mut descending = Vec::new();
                self.builder.leaf(&mut descending, &minus);
                let (path, _) = self.parse_path_node(cursor)?;
                self.builder.push_inner(&mut descending, path);
                let node = SyntaxNode::enclosing(SyntaxKind::Descending, descending);
                self.builder.push_inner(&mut kids, node);
            } else {
                let (path, _) = self.parse_path_node(cursor)?;
                self.builder.push_inner(&mut kids, path);
            }
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::Selectors, kids))
    }

    /// Parse one singular `selector` (a plain path): no sign prefix, no
    /// comma continuation. Wrapped as [`SyntaxKind::Selectors`] so selector
    /// attributes share one node shape.
    fn parse_selector(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let (path, _) = self.parse_path_node(cursor)?;
        self.builder.push_inner(&mut kids, path);
        if cursor.at_p(Punct::Comma) {
            return Err(Fail::new(
                "E1200",
                "this attribute takes one selector".to_string(),
                cursor.span_here(),
            ));
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::Selectors, kids))
    }

    /// Parse comma-separated observation expressions into `kids`,
    /// interleaving values and separators in document order. Returns the
    /// value nodes (cloned) for arity and shape checks.
    fn parse_expression_list(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<Vec<SyntaxNode>, Fail> {
        let mut values = Vec::new();
        loop {
            let value = self.parse_expr(cursor, &never, true, true)?;
            self.builder.push_inner(kids, value.clone());
            values.push(value);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
        }
        Ok(values)
    }

    /// Parse a type: named/union/enum/action/delivery/invocation with flat suffixes.
    fn parse_type(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut node = if matches!(
            cursor.word(),
            Some("enum" | "action" | "delivery" | "invocation")
        ) && cursor.peek2().is_some_and(|t| t.is_punct(Punct::LParen))
        {
            let head = cursor.next().expect("peeked type head");
            let word = head.text(cursor.text).to_string();
            let mut kids = Vec::new();
            self.builder.leaf(&mut kids, &head);
            let open = cursor.expect_p(Punct::LParen)?;
            self.builder.leaf(&mut kids, &open);
            if word == "delivery" {
                let (path, _) = self.parse_path_node(cursor)?;
                self.builder.push_inner(&mut kids, path);
            } else if word == "enum" {
                self.parse_enum_items(cursor, &mut kids)?;
            } else {
                self.parse_path_items(cursor, &mut kids, word.as_str())?;
            }
            let close = cursor.expect_p(Punct::RParen)?;
            self.builder.leaf(&mut kids, &close);
            let kind = match word.as_str() {
                "enum" => SyntaxKind::EnumType,
                "action" => SyntaxKind::ActionType,
                "invocation" => SyntaxKind::InvocationType,
                _ => SyntaxKind::DeliveryType,
            };
            SyntaxNode::enclosing(kind, kids)
        } else {
            let mut kids = Vec::new();
            let (first, _) = self.parse_path_node(cursor)?;
            self.builder.push_inner(&mut kids, first);
            let mut arms = 1usize;
            while cursor.at_p(Punct::Pipe) {
                let pipe = cursor.next().expect("peeked pipe");
                self.builder.leaf(&mut kids, &pipe);
                let (arm, _) = self.parse_path_node(cursor)?;
                self.builder.push_inner(&mut kids, arm);
                arms += 1;
            }
            if arms == 1 {
                SyntaxNode::enclosing(SyntaxKind::NamedType, kids)
            } else {
                SyntaxNode::enclosing(SyntaxKind::UnionType, kids)
            }
        };
        if cursor.at_p(Punct::LBracket) {
            let open = cursor.next().expect("peeked bracket");
            let close = cursor.expect_p(Punct::RBracket)?;
            let mut kids = vec![node];
            self.builder.leaf(&mut kids, &open);
            self.builder.leaf(&mut kids, &close);
            node = SyntaxNode::enclosing(SyntaxKind::ArrayType, kids);
        }
        if cursor.at_p(Punct::Question) {
            let mark = cursor.next().expect("peeked nullable");
            let mut kids = vec![node];
            self.builder.leaf(&mut kids, &mark);
            node = SyntaxNode::enclosing(SyntaxKind::NullableType, kids);
        }
        if cursor.at_p(Punct::LBracket)
            || cursor.at_p(Punct::Question)
            || cursor.at_p(Punct::Pipe)
            || cursor.at_p(Punct::LParen)
        {
            return Err(Fail::new(
                "E1213",
                "type permits one array suffix followed by one nullable suffix".to_string(),
                cursor.span_here(),
            ));
        }
        Ok(node)
    }

    fn parse_enum_items(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        if cursor.at_p(Punct::RParen) {
            return cursor.err("E1213", "enum requires at least one entry");
        }
        loop {
            let name = cursor.expect_name()?;
            let mut entry = Vec::new();
            self.builder.leaf(&mut entry, &name);
            let entry = SyntaxNode::enclosing(SyntaxKind::Path, entry);
            self.builder.push_inner(kids, entry);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
            if cursor.at_p(Punct::RParen) {
                break;
            }
        }
        Ok(())
    }

    /// Parse a nonempty comma-separated path list for `action(...)` and
    /// `invocation(...)` (distinctness is a semantic check).
    fn parse_path_items(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        what: &str,
    ) -> Result<(), Fail> {
        if cursor.at_p(Punct::RParen) {
            return cursor.err("E1213", format!("{what} requires at least one entry"));
        }
        loop {
            let (path, _) = self.parse_path_node(cursor)?;
            self.builder.push_inner(kids, path);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
            if cursor.at_p(Punct::RParen) {
                break;
            }
        }
        Ok(())
    }

    /// Count the name parts of a [`SyntaxKind::NamedType`] node.
    fn named_type_parts(node: &SyntaxNode) -> Option<usize> {
        if node.kind != SyntaxKind::NamedType {
            return None;
        }
        let path = node.children.first()?;
        if path.kind != SyntaxKind::Path {
            return None;
        }
        Some(
            path.children
                .iter()
                .filter(|n| n.kind == SyntaxKind::Name)
                .count(),
        )
    }

    /// Parse `{...}` schema fields, decoding inline `#` lines against
    /// each field's own column.
    fn parse_schema_fields(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let open = cursor.expect_p(Punct::LBrace)?;
        self.builder.leaf(kids, &open);
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1200", "expected `}` to close the schema");
            }
            let mut descs = Vec::new();
            while cursor.peek().is_some_and(|t| t.kind == TokenKind::Desc) {
                descs.push(cursor.next().expect("peeked desc"));
            }
            if cursor.at_p(Punct::RBrace) {
                if !descs.is_empty() {
                    self.push_inline_description(kids, descs, None, "field");
                }
                break;
            }
            let target = cursor.peek().cloned();
            if !descs.is_empty() {
                self.push_inline_description(kids, descs, target.as_ref(), "field");
            }
            let field = self.parse_field_or_param(cursor, false)?;
            self.builder.push_inner(kids, field);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(kids, &close);
        Ok(())
    }

    /// Parse `(...)` signature parameters; returns the parameter count.
    fn parse_params(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<usize, Fail> {
        let open = cursor.expect_p(Punct::LParen)?;
        self.builder.leaf(kids, &open);
        let mut count = 0usize;
        while !cursor.at_p(Punct::RParen) {
            if cursor.done() {
                return cursor.err("E1200", "expected `)` to close the parameter list");
            }
            let mut descs = Vec::new();
            while cursor.peek().is_some_and(|t| t.kind == TokenKind::Desc) {
                descs.push(cursor.next().expect("peeked desc"));
            }
            if cursor.at_p(Punct::RParen) {
                if !descs.is_empty() {
                    self.push_inline_description(kids, descs, None, "parameter");
                }
                break;
            }
            let target = cursor.peek().cloned();
            if !descs.is_empty() {
                self.push_inline_description(kids, descs, target.as_ref(), "parameter");
            }
            let param = self.parse_field_or_param(cursor, true)?;
            self.builder.push_inner(kids, param);
            count += 1;
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
        }
        let close = cursor.expect_p(Punct::RParen)?;
        self.builder.leaf(kids, &close);
        Ok(count)
    }

    /// Decode and push an inline description group. With no target (stray
    /// group before a closer), report E1125 and decode silently aligned.
    fn push_inline_description(
        &mut self,
        kids: &mut Vec<SyntaxNode>,
        descs: Vec<Token>,
        target: Option<&Token>,
        what: &str,
    ) {
        let fallback;
        let target = match target {
            Some(token) => token,
            None => {
                self.diags.push(
                    Fail::new(
                        "E1125",
                        format!("description has no following {what}"),
                        descs[0].span,
                    )
                    .diag(),
                );
                fallback = descs[0].clone();
                &fallback
            }
        };
        // Column rules apply to inline groups; the target dance ends here.
        let target_owned = target.clone();
        let data = decode_description_set(
            self.file,
            self.text,
            self.line_starts,
            &descs,
            &target_owned,
            &mut self.diags,
        );
        let node = SyntaxNode::description(descs, data);
        self.builder.push_leaf(kids, node);
    }

    /// Parse one schema field or signature parameter.
    fn parse_field_or_param(
        &mut self,
        cursor: &mut Cursor<'a>,
        is_param: bool,
    ) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut kids, &name);
        let colon = cursor.expect_p(Punct::Colon)?;
        self.builder.leaf(&mut kids, &colon);
        let field_type = self.parse_type(cursor)?;
        let reusable = Self::named_type_parts(&field_type).is_some_and(|parts| parts > 1);
        let is_array = field_type.kind == SyntaxKind::ArrayType;
        self.builder.push_inner(&mut kids, field_type);
        let mut required = false;
        if cursor.at_p(Punct::Bang) {
            let mark = cursor.next().expect("peeked bang");
            if is_param || (!is_array && !reusable) {
                return Err(Fail::new(
                    "E1213",
                    "`!` is required-array field metadata, not a scalar/parameter suffix"
                        .to_string(),
                    mark.span,
                ));
            }
            required = true;
            self.builder.leaf(&mut kids, &mark);
        }
        let field_stop: Stop =
            &|w| matches!(w, "trim" | "min" | "max" | "unique" | "server" | "label");
        let mut initialized = false;
        if cursor.at_p(Punct::Eq) {
            let eq = cursor.next().expect("peeked eq");
            self.builder.leaf(&mut kids, &eq);
            let default = self.parse_expr(cursor, field_stop, true, true)?;
            self.builder.push_inner(&mut kids, default);
            initialized = true;
        } else if cursor.at_name("server") {
            let server = cursor.next().expect("peeked server");
            if is_param {
                return Err(Fail::new(
                    "E1200",
                    "parameters do not accept server initialization".to_string(),
                    server.span,
                ));
            }
            self.builder.leaf(&mut kids, &server);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut kids, &eq);
            let value = self.parse_expr(cursor, field_stop, true, true)?;
            self.builder.push_inner(&mut kids, value);
            initialized = true;
        }
        let mut seen: Vec<String> = Vec::new();
        while matches!(cursor.word(), Some("trim" | "unique" | "min" | "max")) {
            let modifier = cursor.next().expect("peeked modifier");
            let word = modifier.text(cursor.text).to_string();
            if is_param {
                return Err(Fail::new(
                    "E1200",
                    "parameters do not accept stored-field modifiers".to_string(),
                    modifier.span,
                ));
            }
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    "duplicate field modifier".to_string(),
                    modifier.span,
                ));
            }
            seen.push(word.clone());
            self.builder.leaf(&mut kids, &modifier);
            if matches!(word.as_str(), "min" | "max") {
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut kids, &eq);
                let bound = self.parse_expr(cursor, field_stop, true, true)?;
                self.builder.push_inner(&mut kids, bound);
            }
        }
        // A `NAME=` matching no modifier is an unknown attribute, not a
        // missing comma (which would show `NAME:` or a delimiter).
        if let Some(word) = cursor.word()
            && word != "label"
            && cursor.peek_is_eq()
        {
            return cursor.err("E1203", format!("unsupported field modifier `{word}`"));
        }
        if cursor.at_name("label") {
            let label_word = cursor.next().expect("peeked label");
            self.builder.leaf(&mut kids, &label_word);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut kids, &eq);
            let label = self.parse_label(cursor, LabelShape::Field)?;
            self.builder.push_inner(&mut kids, label);
        }
        if required && initialized {
            return Err(Fail::new(
                "E1200",
                "required-array field cannot also initialize its input".to_string(),
                name.span,
            ));
        }
        let kind = if is_param {
            SyntaxKind::Parameter
        } else {
            SyntaxKind::Field
        };
        Ok(SyntaxNode::enclosing(kind, kids))
    }
}

/// Closed label shapes per declaration slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LabelShape {
    Scalar,
    Field,
    Crud,
}

// Attributes, routes, Given declarations -------------------------------------

/// Header attribute vocabularies (GRAMMAR closed table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderKind {
    App,
    Package,
    Import,
    Preferences,
    Model,
    Contract,
    Role,
    Policy,
    Unique,
    Lock,
    Retain,
    Capability,
    Corpus,
    Judgment,
    Crud,
    GuardRequire,
    Page,
    Card,
    Details,
    List,
    Table,
    Board,
    Calendar,
    Gallery,
    Form,
    Edit,
    Migration,
    Theme,
    Files,
    Binding,
    Queue,
    Cache,
    Locale,
}

/// Attribute value shapes per header row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttrKind {
    Expr,
    Selectors,
    Selector,
    UiOrder,
    Type,
    Path,
    Name,
    String,
    Members,
    Label,
    CrudLabel,
    Object,
}

fn attr_kind(header: HeaderKind, name: &str) -> Option<AttrKind> {
    Some(match (header, name) {
        (HeaderKind::App, "uses") => AttrKind::Members,
        (HeaderKind::App, "source") => AttrKind::String,
        (HeaderKind::App, "label") => AttrKind::Label,
        (HeaderKind::Package, "source") => AttrKind::String,
        (HeaderKind::Package, "label") => AttrKind::Label,
        (HeaderKind::Import, "from") => AttrKind::Path,
        (HeaderKind::Preferences, "label") => AttrKind::Label,
        (HeaderKind::Model, "label") => AttrKind::Label,
        (HeaderKind::Contract, "label") => AttrKind::Label,
        (HeaderKind::Role, "label") => AttrKind::Label,
        (HeaderKind::Policy, "read") => AttrKind::Expr,
        (HeaderKind::Policy, "where") => AttrKind::Expr,
        (HeaderKind::Policy, "fields") => AttrKind::Selectors,
        (HeaderKind::Unique, "fields") => AttrKind::Selectors,
        (HeaderKind::Unique, "where") => AttrKind::Expr,
        (HeaderKind::Lock, "fields") => AttrKind::Selectors,
        (HeaderKind::Lock, "when") => AttrKind::Expr,
        (HeaderKind::Retain, "until") => AttrKind::Expr,
        (HeaderKind::Capability, "version") => AttrKind::Expr,
        (HeaderKind::Corpus, "model" | "scope" | "title" | "from") => AttrKind::Path,
        (HeaderKind::Corpus, "content") => AttrKind::Selectors,
        (HeaderKind::Corpus, "where") => AttrKind::Expr,
        (HeaderKind::Judgment, "version") => AttrKind::Expr,
        (HeaderKind::Crud, "by") => AttrKind::Expr,
        (HeaderKind::Crud, "fields") => AttrKind::Selectors,
        (HeaderKind::Crud, "create_fields") => AttrKind::Selectors,
        (HeaderKind::Crud, "expose") => AttrKind::Selectors,
        (HeaderKind::Crud, "when") => AttrKind::Expr,
        (HeaderKind::Crud, "create" | "update" | "delete") => AttrKind::Name,
        (HeaderKind::Crud, "label") => AttrKind::CrudLabel,
        (HeaderKind::GuardRequire, "message") => AttrKind::Expr,
        (HeaderKind::Page, "title") => AttrKind::Expr,
        (HeaderKind::Page, "data" | "order" | "group") => AttrKind::Expr,
        (HeaderKind::Page, "nav") => AttrKind::Name,
        (HeaderKind::Page, "poll") => AttrKind::Expr,
        (HeaderKind::Page, "refresh") => AttrKind::Path,
        (HeaderKind::Card, "layout") => AttrKind::Name,
        (HeaderKind::Details, "display") => AttrKind::Name,
        (HeaderKind::Details, "open") => AttrKind::Expr,
        (HeaderKind::List | HeaderKind::Table, "columns") => AttrKind::Selectors,
        (HeaderKind::List | HeaderKind::Table, "order") => AttrKind::UiOrder,
        (HeaderKind::List | HeaderKind::Table, "search" | "filter") => AttrKind::Selectors,
        (HeaderKind::List | HeaderKind::Table, "empty") => AttrKind::Expr,
        (HeaderKind::List | HeaderKind::Table, "defaults") => AttrKind::Object,
        (HeaderKind::List | HeaderKind::Table, "display") => AttrKind::Name,
        (HeaderKind::Board, "by" | "columns") => AttrKind::Selectors,
        (HeaderKind::Board, "order") => AttrKind::UiOrder,
        (HeaderKind::Board, "search" | "filter") => AttrKind::Selectors,
        (HeaderKind::Board, "empty") => AttrKind::Expr,
        (HeaderKind::Board, "defaults") => AttrKind::Object,
        (HeaderKind::Calendar, "start" | "end" | "columns") => AttrKind::Selectors,
        (HeaderKind::Calendar, "order") => AttrKind::UiOrder,
        (HeaderKind::Calendar, "search" | "filter") => AttrKind::Selectors,
        (HeaderKind::Calendar, "empty") => AttrKind::Expr,
        (HeaderKind::Calendar, "defaults") => AttrKind::Object,
        (HeaderKind::Gallery, "image") => AttrKind::Selector,
        (HeaderKind::Gallery, "columns") => AttrKind::Selectors,
        (HeaderKind::Gallery, "order") => AttrKind::UiOrder,
        (HeaderKind::Gallery, "search" | "filter") => AttrKind::Selectors,
        (HeaderKind::Gallery, "empty") => AttrKind::Expr,
        (HeaderKind::Gallery, "defaults") => AttrKind::Object,
        (HeaderKind::Form, "arguments") => AttrKind::Object,
        (HeaderKind::Form, "fields") => AttrKind::Selectors,
        (HeaderKind::Form, "submit") => AttrKind::Expr,
        (HeaderKind::Form, "display" | "import") => AttrKind::Name,
        (HeaderKind::Form, "review") => AttrKind::Path,
        (HeaderKind::Edit, "fields") => AttrKind::Selectors,
        (HeaderKind::Migration, "from") => AttrKind::String,
        (HeaderKind::Theme, "mode" | "accent" | "density") => AttrKind::Name,
        (HeaderKind::Files, "types") => AttrKind::String,
        (HeaderKind::Files, "max") => AttrKind::Expr,
        (HeaderKind::Binding, "key") => AttrKind::Path,
        (HeaderKind::Queue, "type") => AttrKind::Type,
        (HeaderKind::Cache, "ttl") => AttrKind::Expr,
        (HeaderKind::Locale, "default") => AttrKind::String,
        _ => return None,
    })
}

fn required_attrs(header: HeaderKind) -> &'static [&'static str] {
    match header {
        HeaderKind::Policy => &["read"],
        HeaderKind::Unique | HeaderKind::Lock => &["fields"],
        HeaderKind::Retain => &["until"],
        HeaderKind::Capability => &["version"],
        HeaderKind::Corpus => &["model", "scope", "title", "content", "where", "from"],
        HeaderKind::Judgment => &["version"],
        HeaderKind::Crud => &["by", "fields"],
        HeaderKind::Page => &["title"],
        HeaderKind::Table => &["columns"],
        HeaderKind::Board => &["by"],
        HeaderKind::Calendar => &["start", "end"],
        HeaderKind::Gallery => &["image"],
        HeaderKind::Migration => &["from"],
        HeaderKind::Binding => &["key"],
        HeaderKind::Queue => &["type"],
        HeaderKind::Cache => &["ttl"],
        HeaderKind::Locale => &["default"],
        _ => &[],
    }
}

impl<'a> Parser<'a> {
    /// Parse closed-vocabulary header attributes into `kids`.
    fn parse_attributes(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        header: HeaderKind,
    ) -> Result<(), Fail> {
        let mut seen: Vec<String> = Vec::new();
        while !cursor.done() {
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            let kind = attr_kind(header, &word).ok_or_else(|| {
                Fail::new("E1203", format!("unsupported attribute `{word}`"), key.span)
            })?;
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate attribute `{word}`"),
                    key.span,
                ));
            }
            seen.push(word);
            let mut attr = Vec::new();
            self.builder.leaf(&mut attr, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut attr, &eq);
            match kind {
                AttrKind::Expr => {
                    let stop: Stop = &|w| attr_kind(header, w).is_some();
                    let value = self.parse_expr(cursor, stop, true, true)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Selectors => {
                    let value = self.parse_selectors(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Selector => {
                    let value = self.parse_selector(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::UiOrder => {
                    let value = if cursor.at_p(Punct::LBrace) {
                        self.parse_preference_order(cursor)?
                    } else {
                        self.parse_selectors(cursor)?
                    };
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Type => {
                    let value = self.parse_type(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Path => {
                    let (value, _) = self.parse_path_node(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Name => {
                    let name = cursor.expect_name()?;
                    let mut value = Vec::new();
                    self.builder.leaf(&mut value, &name);
                    let value = SyntaxNode::enclosing(SyntaxKind::NameRef, value);
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::String => {
                    let string = cursor.expect_string()?;
                    let mut value = Vec::new();
                    self.builder.leaf(&mut value, &string);
                    let value = SyntaxNode::enclosing(SyntaxKind::Literal, value);
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Members => {
                    let value = self.parse_members(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Label => {
                    let value = self.parse_label(cursor, LabelShape::Scalar)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::CrudLabel => {
                    let value = self.parse_label(cursor, LabelShape::Crud)?;
                    self.builder.push_inner(&mut attr, value);
                }
                AttrKind::Object => {
                    let value = self.parse_object(cursor)?;
                    self.builder.push_inner(&mut attr, value);
                }
            }
            let attr = SyntaxNode::enclosing(SyntaxKind::Attribute, attr);
            self.builder.push_inner(kids, attr);
        }
        for required in required_attrs(header) {
            if !seen.contains(&required.to_string()) {
                return Err(Fail::new(
                    "E1204",
                    format!("missing required attribute `{required}`"),
                    cursor.eof,
                ));
            }
        }
        Ok(())
    }

    /// Reject any attribute where the production takes none.
    fn parse_no_attributes(&self, cursor: &Cursor<'a>) -> Result<(), Fail> {
        match cursor.peek() {
            None => Ok(()),
            Some(token) if token.kind == TokenKind::Name => Err(Fail::new(
                "E1203",
                format!("unsupported attribute `{}`", token.text(cursor.text)),
                token.span,
            )),
            Some(_) => cursor.end(),
        }
    }

    /// Parse a `[NAME, ...]` member array (possibly empty: an empty `uses`
    /// group is a semantic error, accepted by the parser).
    fn parse_members(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let open = cursor.expect_p(Punct::LBracket)?;
        self.builder.leaf(&mut kids, &open);
        while !cursor.at_p(Punct::RBracket) {
            if cursor.done() {
                return cursor.err("E1200", "expected `]` to close the member list");
            }
            let name = cursor.expect_name()?;
            let mut entry = Vec::new();
            self.builder.leaf(&mut entry, &name);
            let entry = SyntaxNode::enclosing(SyntaxKind::NameRef, entry);
            self.builder.push_inner(&mut kids, entry);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBracket)?;
        self.builder.leaf(&mut kids, &close);
        Ok(SyntaxNode::enclosing(SyntaxKind::Array, kids))
    }

    /// Parse a `{by=..., default=[...], cases={...}}` preference order.
    fn parse_preference_order(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let open = cursor.expect_p(Punct::LBrace)?;
        self.builder.leaf(&mut kids, &open);
        let mut seen: Vec<String> = Vec::new();
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1200", "expected `}` to close the preference order");
            }
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            if !matches!(word.as_str(), "by" | "default" | "cases") {
                return Err(Fail::new(
                    "E1203",
                    format!("unsupported preference order member `{word}`"),
                    key.span,
                ));
            }
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate preference order member `{word}`"),
                    key.span,
                ));
            }
            seen.push(word.clone());
            let mut member = Vec::new();
            self.builder.leaf(&mut member, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut member, &eq);
            match word.as_str() {
                "by" => {
                    let (path, _) = self.parse_path_node(cursor)?;
                    self.builder.push_inner(&mut member, path);
                }
                "default" => {
                    let list = self.parse_order_list(cursor)?;
                    self.builder.push_inner(&mut member, list);
                }
                _ => {
                    let cases = self.parse_order_cases(cursor)?;
                    self.builder.push_inner(&mut member, cases);
                }
            }
            let member = SyntaxNode::enclosing(SyntaxKind::Attribute, member);
            self.builder.push_inner(&mut kids, member);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        for required in ["by", "default", "cases"] {
            if !seen.contains(&required.to_string()) {
                return Err(Fail::new(
                    "E1204",
                    format!("preference ordering requires `{required}`"),
                    cursor.eof,
                ));
            }
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::PreferenceOrder, kids))
    }

    /// Parse a nonempty `[ordering]` selector list with optional trailing comma.
    fn parse_order_list(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let open = cursor.expect_p(Punct::LBracket)?;
        self.builder.leaf(&mut kids, &open);
        let selectors = self.parse_selectors(cursor)?;
        self.builder.push_inner(&mut kids, selectors);
        if cursor.at_p(Punct::Comma) {
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBracket)?;
        self.builder.leaf(&mut kids, &close);
        Ok(SyntaxNode::enclosing(SyntaxKind::OrderList, kids))
    }

    /// Parse a nonempty `{case=[ordering], ...}` override map.
    fn parse_order_cases(&mut self, cursor: &mut Cursor<'a>) -> Result<SyntaxNode, Fail> {
        let mut kids = Vec::new();
        let open = cursor.expect_p(Punct::LBrace)?;
        self.builder.leaf(&mut kids, &open);
        let mut seen: Vec<String> = Vec::new();
        while !cursor.at_p(Punct::RBrace) {
            if cursor.done() {
                return cursor.err("E1200", "expected `}` to close the order cases");
            }
            let name = cursor.expect_name()?;
            if seen.contains(&name.text(cursor.text).to_string()) {
                return Err(Fail::new(
                    "E1202",
                    "duplicate order case".to_string(),
                    name.span,
                ));
            }
            seen.push(name.text(cursor.text).to_string());
            let mut case = Vec::new();
            self.builder.leaf(&mut case, &name);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut case, &eq);
            let list = self.parse_order_list(cursor)?;
            self.builder.push_inner(&mut case, list);
            let case = SyntaxNode::enclosing(SyntaxKind::OrderCase, case);
            self.builder.push_inner(&mut kids, case);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(&mut kids, &comma);
        }
        let close = cursor.expect_p(Punct::RBrace)?;
        self.builder.leaf(&mut kids, &close);
        if seen.is_empty() {
            return Err(Fail::new(
                "E1204",
                "order cases must contain at least one case".to_string(),
                open.span,
            ));
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::OrderCases, kids))
    }

    /// Whether the route scan ends here: input end or an attribute boundary.
    fn route_ended(&self, cursor: &Cursor<'a>, header: HeaderKind) -> bool {
        if cursor.done() {
            return true;
        }
        match cursor.peek() {
            Some(token) if token.kind == TokenKind::Name => {
                attr_kind(header, token.text(cursor.text)).is_some() && cursor.peek_is_eq()
            }
            _ => false,
        }
    }

    /// Parse a page route: `/`-joined static segments and `{...}` slots,
    /// contiguous on one physical line.
    fn parse_route(
        &mut self,
        cursor: &mut Cursor<'a>,
        header: HeaderKind,
    ) -> Result<SyntaxNode, Fail> {
        let first = cursor.pos;
        let mut kids = Vec::new();
        let slash = cursor.expect_p(Punct::Slash)?;
        self.builder.leaf(&mut kids, &slash);
        loop {
            if self.route_ended(cursor, header) {
                break;
            }
            if cursor.at_p(Punct::Slash) {
                return cursor.err("E1209", "route segments cannot be empty");
            }
            if cursor.at_p(Punct::LBrace) {
                let brace = cursor.next().expect("peeked brace");
                let brace_span = brace.span;
                // Leaves go out in document order; a validation failure
                // below discards this scratch via the declaration attempt.
                let mut scratch = Vec::new();
                self.builder.leaf(&mut scratch, &brace);
                let (path, parts) = self.parse_path_node(cursor)?;
                let path_end = path.span.end;
                self.builder.push_inner(&mut scratch, path);
                let is_scalar = cursor.at_p(Punct::Colon);
                if is_scalar && parts.len() != 1 {
                    return Err(Fail::new(
                        "E1209",
                        "scalar route parameter must have one name".to_string(),
                        Span::new(self.file, brace_span.start, path_end),
                    ));
                }
                if !is_scalar && (parts.len() < 2 || parts[parts.len() - 1] != "id") {
                    let mut end = path_end;
                    if let Some(close) = cursor.peek()
                        && close.is_punct(Punct::RBrace)
                    {
                        end = close.span.end;
                    }
                    return Err(Fail::new(
                        "E1209",
                        "record route parameter must name Model.id".to_string(),
                        Span::new(self.file, brace_span.start, end),
                    ));
                }
                if is_scalar {
                    let colon = cursor.next().expect("peeked colon");
                    self.builder.leaf(&mut scratch, &colon);
                    let param_type = self.parse_type(cursor)?;
                    self.builder.push_inner(&mut scratch, param_type);
                    let close = cursor.expect_p(Punct::RBrace)?;
                    self.builder.leaf(&mut scratch, &close);
                    let scalar = SyntaxNode::enclosing(SyntaxKind::RouteScalar, scratch);
                    self.builder.push_inner(&mut kids, scalar);
                } else {
                    let close = cursor.expect_p(Punct::RBrace)?;
                    self.builder.leaf(&mut scratch, &close);
                    let record = SyntaxNode::enclosing(SyntaxKind::RouteRecord, scratch);
                    self.builder.push_inner(&mut kids, record);
                }
            } else {
                let mut static_kids = Vec::new();
                while !self.route_ended(cursor, header) && !cursor.at_p(Punct::Slash) {
                    let token = cursor.next().expect("peeked segment");
                    let valid = matches!(
                        token.kind,
                        TokenKind::Name | TokenKind::Integer | TokenKind::Decimal
                    ) || token.is_punct(Punct::Minus);
                    // Decimal dots are rejected: dots never occur in static
                    // segments, so any Decimal token is a lexed `a.b` pair.
                    let valid = valid && token.kind != TokenKind::Decimal;
                    if !valid {
                        return Err(Fail::new(
                            "E1209",
                            "invalid static route segment".to_string(),
                            token.span,
                        ));
                    }
                    self.builder.leaf(&mut static_kids, &token);
                }
                if static_kids.is_empty() {
                    return cursor.err("E1209", "route segments cannot be empty");
                }
                let segment = SyntaxNode::enclosing(SyntaxKind::RouteStatic, static_kids);
                self.builder.push_inner(&mut kids, segment);
            }
            if self.route_ended(cursor, header) {
                break;
            }
            if !cursor.at_p(Punct::Slash) {
                return cursor.err("E1209", "expected `/` between route segments");
            }
            let slash = cursor.next().expect("peeked slash");
            self.builder.leaf(&mut kids, &slash);
            if self.route_ended(cursor, header) {
                return Err(Fail::new(
                    "E1209",
                    "only the root route may end in `/`".to_string(),
                    slash.span,
                ));
            }
        }
        // Contiguity: one physical line, no gaps between route tokens.
        let consumed = &cursor.toks[first..cursor.pos];
        for pair in consumed.windows(2) {
            let (previous, following) = (&pair[0], &pair[1]);
            let same_line = line_of(self.line_starts, previous.span.start)
                == line_of(self.line_starts, following.span.start);
            let adjacent = following.span.start
                == previous.span.start + (previous.span.end - previous.span.start);
            if !same_line || !adjacent {
                return Err(Fail::new(
                    "E1209",
                    "route syntax must be contiguous on one physical line".to_string(),
                    following.span,
                ));
            }
        }
        Ok(SyntaxNode::enclosing(SyntaxKind::Route, kids))
    }
}

/// Physical line index (0-based) of a byte offset.
fn line_of(line_starts: &[u32], offset: u32) -> usize {
    line_starts
        .partition_point(|&s| s <= offset)
        .saturating_sub(1)
}

impl<'a> Parser<'a> {
    /// Parse one section's item lines.
    fn parse_section_items(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        section: &str,
        preferences_seen: &mut bool,
    ) {
        for child in children {
            if child.tokens.is_empty() {
                self.push_dangling(out, child);
                continue;
            }
            match section {
                "Given" => self.parse_given_line(out, child, preferences_seen),
                "When" => self.parse_when_line(out, child),
                _ => self.parse_ui_line(out, child, true),
            }
        }
    }

    /// Parse one Given item line (semicolon leaves allowed).
    fn parse_given_line(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        line: &'a LogicalLine,
        preferences_seen: &mut bool,
    ) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let children = if pieces.len() == 1 {
                    line.children.as_slice()
                } else {
                    &[][..]
                };
                let outcome = self.attempt(out, |parser, scratch| {
                    parser.parse_given_piece(&mut cursor, scratch, children)
                });
                match outcome {
                    Ok(is_preferences) => {
                        if let Some(empty) = is_preferences {
                            if empty {
                                self.diags.push(
                                    Fail::new(
                                        "E1200",
                                        "omit an empty preferences schema".to_string(),
                                        piece[0].span,
                                    )
                                    .diag(),
                                );
                            }
                            if *preferences_seen {
                                self.diags.push(
                                    Fail::new(
                                        "E1200",
                                        "each owner may declare only one preferences schema"
                                            .to_string(),
                                        piece[0].span,
                                    )
                                    .diag(),
                                );
                            }
                            *preferences_seen = true;
                        }
                    }
                    Err(fail) => {
                        self.diags.push(fail.diag());
                        self.error_for_tokens(out, piece);
                        self.error_for_children(out, children);
                    }
                }
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    /// Parse one Given piece; returns `Some(empty)` for preferences.
    fn parse_given_piece(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<Option<bool>, Fail> {
        let mut prelude = Vec::new();
        let exported = cursor.at_name("export");
        if exported {
            prelude.push(cursor.next().expect("peeked export"));
        }
        let head_word = cursor.word().map(str::to_string);
        let peek2_is =
            |cursor: &Cursor<'a>, punct: Punct| cursor.peek2().is_some_and(|t| t.is_punct(punct));
        let peek2_word = cursor.peek2().and_then(|t| {
            if t.kind == TokenKind::Name {
                Some(t.text(cursor.text))
            } else {
                None
            }
        });
        let peek3_is_eq = cursor.peek3().is_some_and(|t| t.is_punct(Punct::Eq));
        // Written-shape selection: a keyword followed by schema/ownership
        // shape is a stored model with a contextual name.
        let model_shaped = cursor.at_any_name()
            && (peek2_is(cursor, Punct::LBrace)
                || peek2_word == Some("in")
                || (peek2_word == Some("at") && peek3_is_eq));
        // `preferences {...}` is checked before the model production.
        if head_word.as_deref() == Some("preferences")
            && cursor.peek2().is_some_and(|t| t.is_punct(Punct::LBrace))
        {
            if exported {
                return Err(Fail::new(
                    "E1212",
                    "preferences cannot be exported".to_string(),
                    prelude[0].span,
                ));
            }
            return self.parse_preferences(cursor, kids, children);
        }
        if !model_shaped {
            match head_word.as_deref() {
                Some("message") => {
                    self.parse_message(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("contract" | "event") => {
                    self.parse_contract_or_event(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("role") => {
                    self.parse_role(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("capability") => {
                    self.parse_capability(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("corpus") => {
                    self.parse_corpus(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("judgment") => {
                    self.parse_judgment(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("derive") => {
                    self.parse_derive(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("fixture") => {
                    self.parse_fixture(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("policy" | "lock" | "unique" | "retain") => {
                    self.parse_policy_rule(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                Some("invariant") => {
                    self.parse_invariant(cursor, kids, children, prelude)?;
                    return Ok(None);
                }
                _ => {}
            }
        }
        self.parse_model(cursor, kids, children, prelude)?;
        Ok(None)
    }

    /// Parse `preferences {...}`; returns `Some(empty)`.
    fn parse_preferences(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<Option<bool>, Fail> {
        let mut inner = Vec::new();
        let head = cursor.expect_name_is("preferences")?;
        self.builder.leaf(&mut inner, &head);
        let field_mark = inner.len();
        self.parse_schema_fields(cursor, &mut inner)?;
        let empty = !inner[field_mark..]
            .iter()
            .any(|n| n.kind == SyntaxKind::Field);
        self.parse_attributes(cursor, &mut inner, HeaderKind::Preferences)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Preferences, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "preferences", span);
        Ok(Some(empty))
    }

    fn parse_message(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("message")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        if cursor.at_p(Punct::LParen) {
            let count = self.parse_params(cursor, &mut inner)?;
            if count == 0 {
                return Err(Fail::new(
                    "E1200",
                    "omit an empty message parameter list".to_string(),
                    name.span,
                ));
            }
        }
        let eq = cursor.expect_p(Punct::Eq)?;
        self.builder.leaf(&mut inner, &eq);
        let value = self.parse_caption(cursor)?;
        if value.kind != SyntaxKind::MessageValue {
            return Err(Fail::new(
                "E1214",
                "named message requires an inline descriptor suffix".to_string(),
                value.span,
            ));
        }
        self.builder.push_inner(&mut inner, value);
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Message, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "message", span);
        Ok(())
    }

    fn parse_contract_or_event(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name()?;
        let is_contract = head.text(cursor.text) == "contract";
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_schema_fields(cursor, &mut inner)?;
        if is_contract {
            self.parse_attributes(cursor, &mut inner, HeaderKind::Contract)?;
        } else {
            self.parse_no_attributes(cursor)?;
        }
        cursor.end()?;
        let kind = if is_contract {
            SyntaxKind::Contract
        } else {
            SyntaxKind::Event
        };
        let node = SyntaxNode::enclosing(kind, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        let what = if is_contract { "contract" } else { "event" };
        self.swallow_children(kids, children, what, span);
        Ok(())
    }

    fn parse_role(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("role")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_attributes(cursor, &mut inner, HeaderKind::Role)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Role, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "role", span);
        Ok(())
    }

    fn parse_derive(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("derive")?;
        self.builder.leaf(&mut inner, &head);
        self.parse_path(cursor, &mut inner)?;
        let is_function = cursor.at_p(Punct::LParen);
        if is_function {
            self.parse_params(cursor, &mut inner)?;
        }
        let colon = cursor.expect_p(Punct::Colon)?;
        self.builder.leaf(&mut inner, &colon);
        let derive_type = self.parse_type(cursor)?;
        self.builder.push_inner(&mut inner, derive_type);
        let eq = cursor.expect_p(Punct::Eq)?;
        self.builder.leaf(&mut inner, &eq);
        let stop: Stop = &|w| w == "label";
        let value = self.parse_expr(cursor, stop, true, true)?;
        self.builder.push_inner(&mut inner, value);
        if is_function {
            if !prelude.is_empty() {
                // Exported derived functions are allowed; nothing to check.
            }
            self.parse_no_attributes(cursor)?;
        } else {
            if !prelude.is_empty() {
                return Err(Fail::new(
                    "E1212",
                    "derived fields travel with their owning model; only derived functions are exported".to_string(),
                    prelude[0].span,
                ));
            }
            if cursor.at_name("label") {
                let label_word = cursor.next().expect("peeked label");
                self.builder.leaf(&mut inner, &label_word);
                let label_eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut inner, &label_eq);
                let label = self.parse_label(cursor, LabelShape::Field)?;
                self.builder.push_inner(&mut inner, label);
            }
        }
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Derive, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "derive", span);
        Ok(())
    }

    fn parse_fixture(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("fixture")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        let eq = cursor.expect_p(Punct::Eq)?;
        self.builder.leaf(&mut inner, &eq);
        self.parse_path(cursor, &mut inner)?;
        let recipe = self.parse_object(cursor)?;
        self.builder.push_inner(&mut inner, recipe);
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Fixture, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "fixture", span);
        Ok(())
    }

    fn parse_policy_rule(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        if !prelude.is_empty() {
            return Err(Fail::new(
                "E1212",
                "this declaration cannot be exported".to_string(),
                prelude[0].span,
            ));
        }
        let mut inner = Vec::new();
        let head = cursor.expect_name()?;
        let word = head.text(cursor.text).to_string();
        self.builder.leaf(&mut inner, &head);
        self.parse_path(cursor, &mut inner)?;
        let (header, kind) = match word.as_str() {
            "policy" => (HeaderKind::Policy, SyntaxKind::Policy),
            "lock" => (HeaderKind::Lock, SyntaxKind::Lock),
            "unique" => (HeaderKind::Unique, SyntaxKind::Unique),
            _ => (HeaderKind::Retain, SyntaxKind::Retain),
        };
        self.parse_attributes(cursor, &mut inner, header)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(kind, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, word.as_str(), span);
        Ok(())
    }

    fn parse_invariant(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        if !prelude.is_empty() {
            return Err(Fail::new(
                "E1212",
                "invariants cannot be exported".to_string(),
                prelude[0].span,
            ));
        }
        let mut inner = Vec::new();
        let head = cursor.expect_name_is("invariant")?;
        self.builder.leaf(&mut inner, &head);
        self.parse_path(cursor, &mut inner)?;
        let colon = cursor.expect_p(Punct::Colon)?;
        self.builder.leaf(&mut inner, &colon);
        let predicate = self.parse_expr(cursor, &never, true, true)?;
        self.builder.push_inner(&mut inner, predicate);
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Invariant, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "invariant", span);
        Ok(())
    }

    fn parse_model(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let name = cursor.expect_name()?;
        let name_span = name.span;
        self.builder.leaf(&mut inner, &name);
        if cursor.at_name("in") {
            let into = cursor.next().expect("peeked in");
            self.builder.leaf(&mut inner, &into);
            let (parent, parts) = self.parse_path_node(cursor)?;
            if parts == ["team"] {
                return Err(Fail::new(
                    "E1200",
                    "omit redundant in team ownership".to_string(),
                    name_span,
                ));
            }
            self.builder.push_inner(&mut inner, parent);
        }
        if cursor.at_name("at") {
            let at = cursor.next().expect("peeked at");
            self.builder.leaf(&mut inner, &at);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut inner, &eq);
            self.parse_path(cursor, &mut inner)?;
        }
        if !cursor.at_p(Punct::LBrace) {
            return Err(Fail::new(
                "E1200",
                "expected a model field schema".to_string(),
                cursor.span_here(),
            ));
        }
        self.parse_schema_fields(cursor, &mut inner)?;
        self.parse_attributes(cursor, &mut inner, HeaderKind::Model)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Model, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "model", span);
        Ok(())
    }

    fn parse_capability(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("capability")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_attributes(cursor, &mut inner, HeaderKind::Capability)?;
        cursor.end()?;
        if children.is_empty() {
            return Err(Fail::new(
                "E1204",
                "capability requires operations or events".to_string(),
                head.span,
            ));
        }
        for child in children {
            if child.tokens.is_empty() {
                self.push_dangling(&mut inner, child);
                continue;
            }
            let (pieces, seps) = match split_pieces(&child.tokens, self.file) {
                Ok(split) => split,
                Err(fail) => {
                    self.diags.push(fail.diag());
                    self.error_for_line(&mut inner, child);
                    continue;
                }
            };
            if pieces.len() > 1 {
                if !child.children.is_empty() {
                    self.diags.push(
                        Fail::new(
                            "E1205",
                            "semicolon sequences cannot own an indented suite".to_string(),
                            child.tokens[0].span,
                        )
                        .diag(),
                    );
                    self.error_for_line(&mut inner, child);
                    continue;
                }
                if let Err(fail) = check_semi_heads(self.text, &pieces) {
                    self.diags.push(fail.diag());
                    self.error_for_line(&mut inner, child);
                    continue;
                }
            }
            self.push_description(&mut inner, child);
            for (index, piece) in pieces.iter().enumerate() {
                if piece_has_error(piece) {
                    self.error_for_tokens(&mut inner, piece);
                } else {
                    let eof = piece_eof(piece, self.file, Span::new(self.file, 0, 0));
                    let mut member_cursor = self.cursor(piece, eof);
                    let result = self.attempt(&mut inner, |parser, scratch| {
                        parser.parse_capability_member(&mut member_cursor, scratch)
                    });
                    if let Err(fail) = result {
                        self.diags.push(fail.diag());
                        self.error_for_tokens(&mut inner, piece);
                    }
                    let span = piece.first().map(|t| t.span).unwrap_or(eof);
                    self.swallow_children(&mut inner, &child.children, "capability member", span);
                }
                if index < seps.len() {
                    self.builder.leaf(&mut inner, &seps[index]);
                }
            }
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Capability, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    fn parse_capability_member(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let is_event = cursor.at_name("event")
            && cursor.peek2().is_some_and(|t| t.kind == TokenKind::Name)
            && cursor.peek3().is_some_and(|t| t.is_punct(Punct::LBrace));
        let mut inner = Vec::new();
        if is_event {
            let head = cursor.next().expect("peeked event");
            self.builder.leaf(&mut inner, &head);
            let name = cursor.expect_name()?;
            self.builder.leaf(&mut inner, &name);
            self.parse_schema_fields(cursor, &mut inner)?;
            cursor.end()?;
            let node = SyntaxNode::enclosing(SyntaxKind::Event, inner);
            self.builder.push_inner(kids, node);
            return Ok(());
        }
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_params(cursor, &mut inner)?;
        let arrow = cursor.expect_p(Punct::Arrow)?;
        self.builder.leaf(&mut inner, &arrow);
        let result = self.parse_type(cursor)?;
        self.builder.push_inner(&mut inner, result);
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::CapabilityOp, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse `corpus NAME` with its six required attributes. Corpora are
    /// unexported Given leaves.
    fn parse_corpus(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        if !prelude.is_empty() {
            return Err(Fail::new(
                "E1212",
                "corpora cannot be exported".to_string(),
                prelude[0].span,
            ));
        }
        let mut inner = Vec::new();
        let head = cursor.expect_name_is("corpus")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_attributes(cursor, &mut inner, HeaderKind::Corpus)?;
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::Corpus, inner);
        self.builder.push_inner(kids, node);
        let span = cursor.eof;
        self.swallow_children(kids, children, "corpus", span);
        Ok(())
    }

    fn parse_judgment(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("judgment")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        self.parse_attributes(cursor, &mut inner, HeaderKind::Judgment)?;
        cursor.end()?;
        if children.is_empty() {
            return Err(Fail::new(
                "E1204",
                "judgment requires at least one question".to_string(),
                head.span,
            ));
        }
        for child in children {
            if child.tokens.is_empty() {
                self.push_dangling(&mut inner, child);
                continue;
            }
            let (pieces, seps) = match split_pieces(&child.tokens, self.file) {
                Ok(split) => split,
                Err(fail) => {
                    self.diags.push(fail.diag());
                    self.error_for_line(&mut inner, child);
                    continue;
                }
            };
            if pieces.len() > 1 {
                if !child.children.is_empty() {
                    self.diags.push(
                        Fail::new(
                            "E1205",
                            "semicolon sequences cannot own an indented suite".to_string(),
                            child.tokens[0].span,
                        )
                        .diag(),
                    );
                    self.error_for_line(&mut inner, child);
                    continue;
                }
                if let Err(fail) = check_semi_heads(self.text, &pieces) {
                    self.diags.push(fail.diag());
                    self.error_for_line(&mut inner, child);
                    continue;
                }
            }
            self.push_description(&mut inner, child);
            for (index, piece) in pieces.iter().enumerate() {
                if piece_has_error(piece) {
                    self.error_for_tokens(&mut inner, piece);
                } else {
                    let eof = piece_eof(piece, self.file, Span::new(self.file, 0, 0));
                    let mut item_cursor = self.cursor(piece, eof);
                    let result = self.attempt(&mut inner, |parser, scratch| {
                        parser.parse_judgment_item(&mut item_cursor, scratch)
                    });
                    if let Err(fail) = result {
                        self.diags.push(fail.diag());
                        self.error_for_tokens(&mut inner, piece);
                    }
                    let span = piece.first().map(|t| t.span).unwrap_or(eof);
                    self.swallow_children(&mut inner, &child.children, "judgment item", span);
                }
                if index < seps.len() {
                    self.builder.leaf(&mut inner, &seps[index]);
                }
            }
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Judgment, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse one judgment question: `NAME noul|choice|score ...`.
    fn parse_judgment_item(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        let name = cursor.expect_name()?;
        self.builder.leaf(&mut inner, &name);
        let kind_token = cursor.expect_name()?;
        let kind_word = kind_token.text(cursor.text).to_string();
        self.builder.leaf(&mut inner, &kind_token);
        match kind_word.as_str() {
            "noul" => {
                let caption = self.parse_caption(cursor)?;
                self.builder.push_inner(&mut inner, caption);
                if cursor.at_name("yes") {
                    let yes = cursor.next().expect("peeked yes");
                    self.builder.leaf(&mut inner, &yes);
                    let eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut inner, &eq);
                    let yes_caption = self.parse_caption(cursor)?;
                    self.builder.push_inner(&mut inner, yes_caption);
                    if !cursor.at_name("no") {
                        return Err(Fail::new(
                            "E1204",
                            "noul requires both yes and no criteria".to_string(),
                            cursor.eof,
                        ));
                    }
                    let no = cursor.next().expect("peeked no");
                    self.builder.leaf(&mut inner, &no);
                    let eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut inner, &eq);
                    let no_caption = self.parse_caption(cursor)?;
                    self.builder.push_inner(&mut inner, no_caption);
                }
            }
            "choice" => {
                let caption = self.parse_caption(cursor)?;
                self.builder.push_inner(&mut inner, caption);
                if cursor.at_name("options") {
                    let options = cursor.next().expect("peeked options");
                    self.builder.leaf(&mut inner, &options);
                    let eq = cursor.expect_p(Punct::Eq)?;
                    self.builder.leaf(&mut inner, &eq);
                    let runtime = cursor.expect_name()?;
                    if runtime.text(cursor.text) != "runtime" {
                        return Err(Fail::new(
                            "E1200",
                            "choice options marker must be options=runtime".to_string(),
                            runtime.span,
                        ));
                    }
                    self.builder.leaf(&mut inner, &runtime);
                    if cursor.at_p(Punct::LBrace) {
                        self.parse_judgment_options(cursor, &mut inner, true)?;
                    }
                } else if cursor.at_p(Punct::LBrace) {
                    self.parse_judgment_options(cursor, &mut inner, true)?;
                } else {
                    return Err(Fail::new(
                        "E1204",
                        "choice requires static options or options=runtime".to_string(),
                        cursor.eof,
                    ));
                }
            }
            "score" => {
                let caption = self.parse_caption(cursor)?;
                self.builder.push_inner(&mut inner, caption);
                if !cursor.at_p(Punct::LBracket) {
                    return Err(Fail::new(
                        "E1204",
                        "score requires a level list".to_string(),
                        cursor.eof,
                    ));
                }
                self.parse_judgment_options(cursor, &mut inner, false)?;
            }
            _ => {
                return Err(Fail::new(
                    "E1200",
                    format!("judgment item requires noul, choice or score, not `{kind_word}`"),
                    kind_token.span,
                ));
            }
        }
        cursor.end()?;
        let node = SyntaxNode::enclosing(SyntaxKind::JudgmentItem, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse a nonempty `{NAME=caption, ...}` (braces) or `[NAME=caption,
    /// ...]` (brackets) option map with unique names.
    fn parse_judgment_options(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        braces: bool,
    ) -> Result<(), Fail> {
        let open = if braces {
            cursor.expect_p(Punct::LBrace)?
        } else {
            cursor.expect_p(Punct::LBracket)?
        };
        self.builder.leaf(kids, &open);
        let mut seen: Vec<String> = Vec::new();
        while !(if braces {
            cursor.at_p(Punct::RBrace)
        } else {
            cursor.at_p(Punct::RBracket)
        }) {
            if cursor.done() {
                let closer = if braces { "`}`" } else { "`]`" };
                return cursor.err(
                    "E1200",
                    format!("expected {closer} to close the option map"),
                );
            }
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate judgment option `{word}`"),
                    key.span,
                ));
            }
            seen.push(word);
            let mut option = Vec::new();
            self.builder.leaf(&mut option, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut option, &eq);
            let caption = self.parse_caption(cursor)?;
            self.builder.push_inner(&mut option, caption);
            let option = SyntaxNode::enclosing(SyntaxKind::JudgmentOption, option);
            self.builder.push_inner(kids, option);
            if !cursor.at_p(Punct::Comma) {
                break;
            }
            let comma = cursor.next().expect("peeked comma");
            self.builder.leaf(kids, &comma);
        }
        let close = if braces {
            cursor.expect_p(Punct::RBrace)?
        } else {
            cursor.expect_p(Punct::RBracket)?
        };
        self.builder.leaf(kids, &close);
        if seen.is_empty() {
            return Err(Fail::new(
                "E1204",
                "judgment options must contain at least one entry".to_string(),
                open.span,
            ));
        }
        Ok(())
    }
}

// When: scenarios, CRUD, execution ------------------------------------------

/// Statement shapes the execution layer distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StmtKind {
    Require,
    If,
    Other,
}

impl<'a> Parser<'a> {
    fn parse_when_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let children = if pieces.len() == 1 {
                    line.children.as_slice()
                } else {
                    &[][..]
                };
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_when_piece(&mut cursor, scratch, children)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(out, piece);
                    self.error_for_children(out, children);
                }
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    fn parse_when_piece(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<(), Fail> {
        let mut prelude = Vec::new();
        if cursor.at_name("export") {
            prelude.push(cursor.next().expect("peeked export"));
        }
        match cursor.word() {
            Some("scenario") => self.parse_scenario(cursor, kids, children, prelude),
            Some("crud") if prelude.is_empty() => self.parse_crud(cursor, kids, children),
            Some("crud") => Err(Fail::new(
                "E1212",
                "CRUD declarations cannot be exported".to_string(),
                prelude[0].span,
            )),
            _ => cursor.err("E1200", "expected scenario or crud declaration"),
        }
    }

    fn parse_scenario(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        prelude: Vec<Token>,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        for token in &prelude {
            self.builder.leaf(&mut inner, token);
        }
        let head = cursor.expect_name_is("scenario")?;
        self.builder.leaf(&mut inner, &head);
        let name = cursor.expect_name()?;
        let name_span = name.span;
        self.builder.leaf(&mut inner, &name);
        let has_params = cursor.at_p(Punct::LParen);
        if has_params {
            self.parse_params(cursor, &mut inner)?;
        }
        let allowed = ["by", "on", "read", "scope", "label"];
        let mut seen: Vec<String> = Vec::new();
        let mut has_result = false;
        let mut label_span: Option<Span> = None;
        while !cursor.done() {
            if cursor.at_p(Punct::Arrow) {
                let arrow = cursor.next().expect("peeked arrow");
                if has_result {
                    return Err(Fail::new(
                        "E1202",
                        "duplicate result type".to_string(),
                        arrow.span,
                    ));
                }
                has_result = true;
                self.builder.leaf(&mut inner, &arrow);
                let result = self.parse_type(cursor)?;
                self.builder.push_inner(&mut inner, result);
                continue;
            }
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            if !allowed.contains(&word.as_str()) {
                return Err(Fail::new(
                    "E1203",
                    format!("unsupported scenario attribute `{word}`"),
                    key.span,
                ));
            }
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate scenario attribute `{word}`"),
                    key.span,
                ));
            }
            seen.push(word.clone());
            let mut attr = Vec::new();
            self.builder.leaf(&mut attr, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut attr, &eq);
            match word.as_str() {
                "label" => {
                    label_span = Some(key.span);
                    let value = self.parse_label(cursor, LabelShape::Scalar)?;
                    self.builder.push_inner(&mut attr, value);
                }
                "read" => {
                    let value_token = cursor.next().ok_or_else(|| {
                        Fail::new("E1200", "expected `true`".to_string(), cursor.eof)
                    })?;
                    if value_token.kind != TokenKind::Name
                        || value_token.text(cursor.text) != "true"
                    {
                        return Err(Fail::new(
                            "E1200",
                            "expected `true`".to_string(),
                            value_token.span,
                        ));
                    }
                    let mut literal = Vec::new();
                    self.builder.leaf(&mut literal, &value_token);
                    let literal = SyntaxNode::enclosing(SyntaxKind::Literal, literal);
                    self.builder.push_inner(&mut attr, literal);
                }
                "scope" => {
                    let value_token = cursor.next().ok_or_else(|| {
                        Fail::new("E1200", "expected `authority`".to_string(), cursor.eof)
                    })?;
                    if value_token.kind != TokenKind::Name
                        || value_token.text(cursor.text) != "authority"
                    {
                        return Err(Fail::new(
                            "E1200",
                            "expected `authority`".to_string(),
                            value_token.span,
                        ));
                    }
                    let mut value = Vec::new();
                    self.builder.leaf(&mut value, &value_token);
                    let value = SyntaxNode::enclosing(SyntaxKind::NameRef, value);
                    self.builder.push_inner(&mut attr, value);
                }
                "on" => {
                    let is_periodic = cursor.at_name("every")
                        && cursor.peek2().is_some_and(|t| t.is_punct(Punct::LParen));
                    if is_periodic {
                        let stop: Stop = &|w| allowed.contains(&w);
                        let value = self.parse_expr(cursor, stop, true, true)?;
                        if !self.is_periodic_source(&value) {
                            return Err(Fail::new(
                                "E1200",
                                "handler source must be a path or every(duration literal)"
                                    .to_string(),
                                value.span,
                            ));
                        }
                        self.builder.push_inner(&mut attr, value);
                    } else {
                        let (path, _) = self.parse_path_node(cursor)?;
                        self.builder.push_inner(&mut attr, path);
                    }
                }
                _ => {
                    let stop: Stop = &|w| allowed.contains(&w);
                    let value = self.parse_expr(cursor, stop, true, true)?;
                    self.builder.push_inner(&mut attr, value);
                }
            }
            let attr = SyntaxNode::enclosing(SyntaxKind::Attribute, attr);
            self.builder.push_inner(&mut inner, attr);
        }
        let handler = seen.contains(&"on".to_string());
        if handler && !prelude.is_empty() {
            return Err(Fail::new(
                "E1212",
                "trusted handlers cannot be exported".to_string(),
                prelude[0].span,
            ));
        }
        if handler && let Some(span) = label_span {
            return Err(Fail::new(
                "E1200",
                "trusted handlers do not declare operation labels".to_string(),
                span,
            ));
        }
        if seen.contains(&"by".to_string()) == handler {
            return Err(Fail::new(
                "E1204",
                "scenario requires exactly one of by or on".to_string(),
                head.span,
            ));
        }
        if handler
            && (has_params
                || has_result
                || seen.contains(&"read".to_string())
                || seen.contains(&"scope".to_string()))
        {
            return Err(Fail::new(
                "E1200",
                "trusted handlers declare no client parameters, result or read attributes"
                    .to_string(),
                head.span,
            ));
        }
        if !handler && !has_params {
            return Err(Fail::new(
                "E1204",
                "a user scenario requires a typed parameter list".to_string(),
                name_span,
            ));
        }
        // Read/scope dependency checks are semantic work (GRAMMAR When
        // section), not syntax: `read=true` and `scope=authority` parse
        // wherever the header vocabulary allows them.
        self.parse_execution(&mut inner, children, false, handler, head.span);
        let node = SyntaxNode::enclosing(SyntaxKind::Scenario, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Whether a parsed `on=` value is `every(DURATION)` exactly.
    fn is_periodic_source(&self, node: &SyntaxNode) -> bool {
        if node.kind != SyntaxKind::Call {
            return false;
        }
        let mut callee = &node.children[0];
        while callee.kind == SyntaxKind::Group {
            callee = &callee.children[1];
        }
        if callee.kind != SyntaxKind::NameRef {
            return false;
        }
        if self.first_token_text(callee) != Some("every") {
            return false;
        }
        let args: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .collect();
        if args.len() != 1 || args[0].children.len() != 1 {
            return false;
        }
        let value = &args[0].children[0];
        value.kind == SyntaxKind::Literal
            && self
                .first_token(value)
                .is_some_and(|t| t.kind == TokenKind::Duration)
    }

    fn parse_crud(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        let head = cursor.expect_name_is("crud")?;
        self.builder.leaf(&mut inner, &head);
        self.parse_path(cursor, &mut inner)?;
        self.parse_attributes(cursor, &mut inner, HeaderKind::Crud)?;
        cursor.end()?;
        for child in children {
            if child.tokens.is_empty() {
                self.push_dangling(&mut inner, child);
                continue;
            }
            let result = self.attempt(&mut inner, |parser, scratch| {
                parser.parse_examples_line(child, scratch, true, false)
            });
            if let Err(fail) = result {
                self.diags.push(fail.diag());
                self.error_for_line(&mut inner, child);
            }
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Crud, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse leading guards, one `do` body, then examples (or a mapper's
    /// guards plus `do`). Each line recovers independently. `trusted`
    /// marks a trusted handler, where sequence-form examples are
    /// rejected (GRAMMAR: sequences are for user scenarios only).
    fn parse_execution(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        mapper: bool,
        trusted: bool,
        head_span: Span,
    ) {
        let mut body_seen = false;
        let mut examples_seen = false;
        for child in children {
            if child.tokens.is_empty() {
                self.push_dangling(out, child);
                continue;
            }
            let head_is = |word: &str| child.tokens[0].is_name(self.text, word);
            if head_is("require") && !body_seen {
                let (pieces, seps) = match split_pieces(&child.tokens, self.file) {
                    Ok(split) => split,
                    Err(fail) => {
                        self.diags.push(fail.diag());
                        self.error_for_line(out, child);
                        continue;
                    }
                };
                if pieces.len() > 1 {
                    if !child.children.is_empty() {
                        self.diags.push(
                            Fail::new(
                                "E1205",
                                "semicolon sequences cannot own an indented suite".to_string(),
                                child.tokens[0].span,
                            )
                            .diag(),
                        );
                        self.error_for_line(out, child);
                        continue;
                    }
                    if let Err(fail) = check_semi_heads(self.text, &pieces) {
                        self.diags.push(fail.diag());
                        self.error_for_line(out, child);
                        continue;
                    }
                }
                self.push_description(out, child);
                for (index, piece) in pieces.iter().enumerate() {
                    if piece_has_error(piece) {
                        self.error_for_tokens(out, piece);
                    } else {
                        let eof = piece_eof(piece, self.file, Span::new(self.file, 0, 0));
                        let mut cursor = self.cursor(piece, eof);
                        let kids_empty: &[LogicalLine] = &[];
                        let suite = if pieces.len() == 1 {
                            child.children.as_slice()
                        } else {
                            kids_empty
                        };
                        let result = self.attempt(out, |parser, scratch| {
                            parser.parse_statement(&mut cursor, scratch, suite, mapper)
                        });
                        match result {
                            Ok(StmtKind::Require) => {}
                            Ok(_) => {
                                self.diags.push(
                                    Fail::new(
                                        "E1216",
                                        "only leading require guards are permitted before do"
                                            .to_string(),
                                        piece[0].span,
                                    )
                                    .diag(),
                                );
                                // The parsed statement is already committed;
                                // wrap nothing further (single diagnostic).
                            }
                            Err(fail) => {
                                self.diags.push(fail.diag());
                                self.error_for_tokens(out, piece);
                                self.error_for_children(out, suite);
                            }
                        }
                    }
                    if index < seps.len() {
                        self.builder.leaf(out, &seps[index]);
                    }
                }
            } else if head_is("do") {
                if body_seen || examples_seen {
                    self.diags.push(
                        Fail::new(
                            "E1216",
                            "exactly one do body must precede examples".to_string(),
                            child.tokens[0].span,
                        )
                        .diag(),
                    );
                    self.error_for_line(out, child);
                    continue;
                }
                body_seen = true;
                self.parse_do(out, child, mapper);
            } else if head_is("examples") && body_seen && !mapper {
                examples_seen = true;
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_examples_line(child, scratch, false, trusted)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_line(out, child);
                }
            } else {
                self.diags.push(
                    Fail::new(
                        "E1216",
                        "expected leading require, one do body, then examples".to_string(),
                        child.tokens[0].span,
                    )
                    .diag(),
                );
                self.error_for_line(out, child);
            }
        }
        if !body_seen {
            self.diags.push(
                Fail::new(
                    "E1204",
                    "execution declaration requires one do body".to_string(),
                    head_span,
                )
                .diag(),
            );
        }
    }

    /// Parse one `do` line (block or inline form) into a [`SyntaxKind::DoBlock`].
    fn parse_do(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine, mapper: bool) {
        self.push_description(out, line);
        let eof = piece_eof(&line.tokens, self.file, Span::new(self.file, 0, 0));
        let mut cursor = self.cursor(&line.tokens, eof);
        let head = cursor.next().expect("do head");
        let mut kids = Vec::new();
        self.builder.leaf(&mut kids, &head);
        if cursor.done() {
            if line.children.is_empty() {
                self.diags.push(
                    Fail::new(
                        "E1204",
                        "block do requires statements".to_string(),
                        head.span,
                    )
                    .diag(),
                );
            } else {
                self.parse_statements(&mut kids, &line.children, mapper);
            }
        } else {
            // Document order first: the header's trailing tokens precede
            // the suite's lines, so they are parsed before the unexpected
            // suite is wrapped (reversing this panics the builder).
            let rest = &line.tokens[cursor.pos..];
            match split_pieces(rest, self.file) {
                Ok((pieces, seps)) => {
                    if let Err(fail) = check_semi_heads(self.text, &pieces) {
                        self.diags.push(fail.diag());
                        self.error_for_tokens(&mut kids, rest);
                    } else {
                        let empty: &[LogicalLine] = &[];
                        for (index, piece) in pieces.iter().enumerate() {
                            if piece_has_error(piece) {
                                self.error_for_tokens(&mut kids, piece);
                            } else {
                                let piece_eof = piece_eof(piece, self.file, eof);
                                let mut piece_cursor = self.cursor(piece, piece_eof);
                                let result = self.attempt(&mut kids, |parser, scratch| {
                                    parser.parse_statement(
                                        &mut piece_cursor,
                                        scratch,
                                        empty,
                                        mapper,
                                    )
                                });
                                if let Err(fail) = result {
                                    self.diags.push(fail.diag());
                                    self.error_for_tokens(&mut kids, piece);
                                }
                            }
                            if index < seps.len() {
                                self.builder.leaf(&mut kids, &seps[index]);
                            }
                        }
                    }
                }
                Err(fail) => {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(&mut kids, rest);
                }
            }
            if !line.children.is_empty() {
                self.diags.push(
                    Fail::new(
                        "E1200",
                        "inline do cannot own an indented suite".to_string(),
                        head.span,
                    )
                    .diag(),
                );
                self.error_for_children(&mut kids, &line.children);
            }
        }
        let node = SyntaxNode::enclosing(SyntaxKind::DoBlock, kids);
        self.builder.push_inner(out, node);
    }

    /// Parse an effect suite with `if`/`else` pairing across siblings.
    fn parse_statements(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        lines: &'a [LogicalLine],
        mapper: bool,
    ) {
        if self.suite_depth >= MAX_SUITE_DEPTH {
            self.cap_suite(out, lines, "statement", "E1216");
            return;
        }
        self.suite_depth += 1;
        self.parse_statements_inner(out, lines, mapper);
        self.suite_depth -= 1;
    }

    /// Unbudgeted `parse_statements` body; callers use the guarded wrapper.
    fn parse_statements_inner(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        lines: &'a [LogicalLine],
        mapper: bool,
    ) {
        let mut index = 0usize;
        while index < lines.len() {
            let line = &lines[index];
            if line.tokens.is_empty() {
                self.push_dangling(out, line);
                index += 1;
                continue;
            }
            let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
                Ok(split) => split,
                Err(fail) => {
                    self.diags.push(fail.diag());
                    self.error_for_line(out, line);
                    index += 1;
                    continue;
                }
            };
            if pieces.len() > 1 {
                if !line.children.is_empty() {
                    self.diags.push(
                        Fail::new(
                            "E1205",
                            "semicolon sequences cannot own an indented suite".to_string(),
                            line.tokens[0].span,
                        )
                        .diag(),
                    );
                    self.error_for_line(out, line);
                    index += 1;
                    continue;
                }
                if let Err(fail) = check_semi_heads(self.text, &pieces) {
                    self.diags.push(fail.diag());
                    self.error_for_line(out, line);
                    index += 1;
                    continue;
                }
            }
            self.push_description(out, line);
            for (piece_index, piece) in pieces.iter().enumerate() {
                if piece_has_error(piece) {
                    self.error_for_tokens(out, piece);
                } else {
                    let eof = piece_eof(piece, self.file, Span::new(self.file, 0, 0));
                    let mut cursor = self.cursor(piece, eof);
                    let empty: &[LogicalLine] = &[];
                    let suite = if pieces.len() == 1 {
                        line.children.as_slice()
                    } else {
                        empty
                    };
                    // Stage into a local vec so a following `else` can join
                    // its `if` before anything commits to `out`.
                    let mut staging = Vec::new();
                    let result = self.attempt(&mut staging, |parser, scratch| {
                        parser.parse_statement(&mut cursor, scratch, suite, mapper)
                    });
                    match result {
                        Ok(kind) => {
                            let next_is_else = kind == StmtKind::If
                                && piece_index == pieces.len() - 1
                                && index + 1 < lines.len()
                                && !lines[index + 1].tokens.is_empty()
                                && lines[index + 1].tokens[0].is_name(self.text, "else");
                            if next_is_else {
                                index += 1;
                                self.parse_else(&mut staging, &lines[index], mapper);
                            }
                            out.extend(staging);
                        }
                        Err(fail) => {
                            self.diags.push(fail.diag());
                            self.error_for_tokens(out, piece);
                            self.error_for_children(out, suite);
                        }
                    }
                }
                if piece_index < seps.len() {
                    self.builder.leaf(out, &seps[piece_index]);
                }
            }
            index += 1;
        }
    }

    /// Parse an `else` line into the staged `if` node's children.
    fn parse_else(&mut self, staging: &mut [SyntaxNode], line: &'a LogicalLine, mapper: bool) {
        // The description (already E1126-reported by layout) stays in
        // document order inside the If node ahead of `else`.
        let if_node = staging.last_mut().expect("staged if node");
        debug_assert_eq!(if_node.kind, SyntaxKind::If);
        // Temporarily take the If children vec so leaves append in order.
        let mut if_children = std::mem::take(&mut if_node.children);
        if let Some(attached) = &line.description {
            let node = SyntaxNode::description(attached.tokens.clone(), attached.data.clone());
            self.builder.push_leaf(&mut if_children, node);
        }
        let eof = piece_eof(&line.tokens, self.file, Span::new(self.file, 0, 0));
        let mut cursor = self.cursor(&line.tokens, eof);
        let head = cursor.next().expect("else head");
        self.builder.leaf(&mut if_children, &head);
        if cursor.end().is_err() {
            self.diags.push(
                Fail::new(
                    "E1201",
                    "unexpected token after else".to_string(),
                    cursor.span_here(),
                )
                .diag(),
            );
            let mut rest = Vec::new();
            while let Some(token) = cursor.next() {
                rest.push(token);
            }
            self.push_tokens_with_descs(&mut if_children, &rest);
        }
        if line.children.is_empty() {
            self.diags.push(
                Fail::new(
                    "E1204",
                    "else requires an indented body".to_string(),
                    head.span,
                )
                .diag(),
            );
        } else {
            self.parse_statements(&mut if_children, &line.children, mapper);
        }
        let end = if_children
            .last()
            .map(|n| n.span.end)
            .unwrap_or(head.span.end);
        if_node.span.end = end;
        if_node.children = if_children;
    }

    /// Parse one effect statement; reports its [`StmtKind`].
    fn parse_statement(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        mapper: bool,
    ) -> Result<StmtKind, Fail> {
        let head = cursor.expect_name()?;
        let word = head.text(cursor.text).to_string();
        if mapper && !matches!(word.as_str(), "let" | "require" | "if" | "set") {
            return Err(Fail::new(
                "E1216",
                "migration mapper permits only let, require, if/else and set row".to_string(),
                head.span,
            ));
        }
        match word.as_str() {
            "if" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let condition = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut inner, condition);
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "if requires an indented body".to_string(),
                        head.span,
                    ));
                }
                self.parse_statements(&mut inner, children, mapper);
                let node = SyntaxNode::enclosing(SyntaxKind::If, inner);
                self.builder.push_inner(kids, node);
                Ok(StmtKind::If)
            }
            "for" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut inner, &name);
                let into = cursor.expect_name_is("in")?;
                self.builder.leaf(&mut inner, &into);
                let stop: Stop = &|w| w == "limit";
                let query = self.parse_expr(cursor, stop, true, true)?;
                self.builder.push_inner(&mut inner, query);
                let limit_word = cursor.expect_name_is("limit")?;
                self.builder.leaf(&mut inner, &limit_word);
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut inner, &eq);
                let limit = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut inner, limit);
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "for requires an indented body".to_string(),
                        head.span,
                    ));
                }
                self.parse_statements(&mut inner, children, mapper);
                let node = SyntaxNode::enclosing(SyntaxKind::For, inner);
                self.builder.push_inner(kids, node);
                Ok(StmtKind::Other)
            }
            _ => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let kind = match word.as_str() {
                    "let" => {
                        let name = cursor.expect_name()?;
                        self.builder.leaf(&mut inner, &name);
                        let eq = cursor.expect_p(Punct::Eq)?;
                        self.builder.leaf(&mut inner, &eq);
                        let value = self.parse_expr(cursor, &never, true, true)?;
                        self.builder.push_inner(&mut inner, value);
                        cursor.end()?;
                        (SyntaxKind::Let, StmtKind::Other)
                    }
                    "require" => {
                        let stop: Stop = &|w| w == "message";
                        let predicate = self.parse_expr(cursor, stop, true, true)?;
                        self.builder.push_inner(&mut inner, predicate);
                        self.parse_attributes(cursor, &mut inner, HeaderKind::GuardRequire)?;
                        cursor.end()?;
                        (SyntaxKind::Require, StmtKind::Require)
                    }
                    "create" | "set" | "emit" => {
                        let (target, parts) = self.parse_path_node(cursor)?;
                        if mapper && parts != ["row"] {
                            return Err(Fail::new(
                                "E1216",
                                "migration assignment target must be row".to_string(),
                                head.span,
                            ));
                        }
                        self.builder.push_inner(&mut inner, target);
                        let fields = self.parse_object(cursor)?;
                        self.builder.push_inner(&mut inner, fields);
                        let kind = match word.as_str() {
                            "create" => {
                                let as_word = cursor.expect_name_is("as")?;
                                self.builder.leaf(&mut inner, &as_word);
                                let binding = cursor.expect_name()?;
                                self.builder.leaf(&mut inner, &binding);
                                SyntaxKind::Create
                            }
                            "set" => SyntaxKind::Set,
                            _ => SyntaxKind::Emit,
                        };
                        cursor.end()?;
                        (kind, StmtKind::Other)
                    }
                    "call" | "send" => {
                        let is_send = word == "send";
                        let stop: Stop = &|w| w == "{";
                        let target = self.parse_expr(cursor, stop, false, false)?;
                        self.builder.push_inner(&mut inner, target);
                        let arguments = self.parse_object(cursor)?;
                        self.builder.push_inner(&mut inner, arguments);
                        if is_send && cursor.at_name("when") {
                            let when = cursor.next().expect("peeked when");
                            self.builder.leaf(&mut inner, &when);
                            let eq = cursor.expect_p(Punct::Eq)?;
                            self.builder.leaf(&mut inner, &eq);
                            let when_stop: Stop = &|w| w == "as";
                            let condition = self.parse_expr(cursor, when_stop, false, true)?;
                            self.builder.push_inner(&mut inner, condition);
                        }
                        let mut binding = None;
                        if cursor.at_name("as") {
                            let as_word = cursor.next().expect("peeked as");
                            self.builder.leaf(&mut inner, &as_word);
                            let name = cursor.expect_name()?;
                            self.builder.leaf(&mut inner, &name);
                            binding = Some(());
                        }
                        if is_send && binding.is_none() {
                            return Err(Fail::new(
                                "E1204",
                                "send requires a delivery binding".to_string(),
                                head.span,
                            ));
                        }
                        cursor.end()?;
                        (
                            if is_send {
                                SyntaxKind::Send
                            } else {
                                SyntaxKind::Call
                            },
                            StmtKind::Other,
                        )
                    }
                    "schedule" => {
                        let key_stop: Stop = &|w| w == "at" || w == "event";
                        let key = self.parse_expr(cursor, key_stop, true, true)?;
                        self.builder.push_inner(&mut inner, key);
                        let at = cursor.expect_name_is("at")?;
                        self.builder.leaf(&mut inner, &at);
                        let at_eq = cursor.expect_p(Punct::Eq)?;
                        self.builder.leaf(&mut inner, &at_eq);
                        let instant_stop: Stop = &|w| w == "event";
                        let instant = self.parse_expr(cursor, instant_stop, true, true)?;
                        self.builder.push_inner(&mut inner, instant);
                        let event = cursor.expect_name_is("event")?;
                        self.builder.leaf(&mut inner, &event);
                        let event_eq = cursor.expect_p(Punct::Eq)?;
                        self.builder.leaf(&mut inner, &event_eq);
                        self.parse_path(cursor, &mut inner)?;
                        let fields = self.parse_object(cursor)?;
                        self.builder.push_inner(&mut inner, fields);
                        cursor.end()?;
                        (SyntaxKind::Schedule, StmtKind::Other)
                    }
                    "delete" => {
                        let (target, _) = self.parse_path_node(cursor)?;
                        self.builder.push_inner(&mut inner, target);
                        cursor.end()?;
                        (SyntaxKind::Delete, StmtKind::Other)
                    }
                    "cancel" | "return" => {
                        let value = self.parse_expr(cursor, &never, true, true)?;
                        self.builder.push_inner(&mut inner, value);
                        cursor.end()?;
                        (
                            if word == "cancel" {
                                SyntaxKind::Cancel
                            } else {
                                SyntaxKind::Return
                            },
                            StmtKind::Other,
                        )
                    }
                    _ => {
                        return Err(Fail::new(
                            "E1216",
                            format!("unsupported execution statement `{word}`"),
                            head.span,
                        ));
                    }
                };
                let node = SyntaxNode::enclosing(kind.0, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, word.as_str(), span);
                Ok(kind.1)
            }
        }
    }
}

// Examples: tables and sequences ---------------------------------------------

impl<'a> Parser<'a> {
    /// Parse one `examples` line with its table rows or sequence steps.
    fn parse_examples_line(
        &mut self,
        line: &'a LogicalLine,
        kids: &mut Vec<SyntaxNode>,
        crud: bool,
        trusted: bool,
    ) -> Result<(), Fail> {
        // Neither headers nor rows admit semicolons.
        if split_pieces(&line.tokens, self.file)?.0.len() > 1 {
            return Err(Fail::new(
                "E1205",
                "examples headers do not admit semicolons".to_string(),
                line.tokens[0].span,
            ));
        }
        let mut inner = Vec::new();
        let eof = self.line_eof(line);
        let mut cursor = self.cursor(&line.tokens, eof);
        let head = cursor.expect_name_is("examples")?;
        self.builder.leaf(&mut inner, &head);
        if crud {
            let operation = cursor.expect_name()?;
            if !matches!(operation.text(cursor.text), "create" | "update" | "delete") {
                return Err(Fail::new(
                    "E1210",
                    "CRUD examples require create, update or delete".to_string(),
                    operation.span,
                ));
            }
            self.builder.leaf(&mut inner, &operation);
        }
        let mut bindings: Vec<String> = Vec::new();
        while !cursor.done() {
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            if bindings.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    "duplicate example binding".to_string(),
                    key.span,
                ));
            }
            bindings.push(word);
            let mut binding = Vec::new();
            self.builder.leaf(&mut binding, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut binding, &eq);
            let end = binding_value_end(cursor.toks, cursor.pos);
            let value_eof = Span::new(
                self.file,
                cursor.toks[end.saturating_sub(1)].span.end,
                cursor.toks[end.saturating_sub(1)].span.end,
            );
            let mut value_cursor =
                Cursor::new(&cursor.toks[cursor.pos..end], cursor.text, value_eof);
            let value = self.parse_expr(&mut value_cursor, &never, true, true)?;
            value_cursor.end()?;
            cursor.pos = end;
            self.builder.push_inner(&mut binding, value);
            let binding = SyntaxNode::enclosing(SyntaxKind::Attribute, binding);
            self.builder.push_inner(&mut inner, binding);
        }
        // A sole bare `do` child selects the sequence form.
        let is_sequence = line.children.len() == 1 && is_bare_do(self.text, &line.children[0]);
        if is_sequence {
            if crud {
                return Err(Fail::new(
                    "E1210",
                    "example sequences are available on user scenarios, not CRUD".to_string(),
                    head.span,
                ));
            }
            if trusted {
                return Err(Fail::new(
                    "E1210",
                    "example sequences are available on user scenarios, not trusted handlers"
                        .to_string(),
                    head.span,
                ));
            }
            if bindings.iter().any(|b| b != "seed") {
                return Err(Fail::new(
                    "E1210",
                    "sequence examples accept only seed on the header".to_string(),
                    head.span,
                ));
            }
            self.parse_example_sequence(&mut inner, &line.children[0])?;
        } else {
            if line
                .children
                .iter()
                .any(|child| !child.tokens.is_empty() && child.tokens[0].is_name(self.text, "do"))
            {
                return Err(Fail::new(
                    "E1210",
                    "sequence examples hold a sole `do` block".to_string(),
                    head.span,
                ));
            }
            self.parse_example_table(&mut inner, &line.children)?;
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Examples, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse table-form rows: one header plus arity-checked rows.
    fn parse_example_table(
        &mut self,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<(), Fail> {
        let rows: Vec<&LogicalLine> = children
            .iter()
            .filter(|child| {
                if child.tokens.is_empty() {
                    self.push_dangling(kids, child);
                    false
                } else {
                    true
                }
            })
            .collect();
        if rows.len() < 2 {
            let span = children
                .first()
                .map(|child| {
                    child
                        .tokens
                        .first()
                        .map(|t| t.span)
                        .unwrap_or(Span::new(self.file, 0, 0))
                })
                .unwrap_or(Span::new(self.file, 0, 0));
            return Err(Fail::new(
                "E1210",
                "examples require one header and at least one row".to_string(),
                span,
            ));
        }
        let mut header_arity: Option<(usize, usize)> = None;
        for (index, row) in rows.iter().enumerate() {
            self.push_description(kids, row);
            if split_pieces(&row.tokens, self.file)?.0.len() > 1 {
                return Err(Fail::new(
                    "E1205",
                    "example rows do not admit semicolons".to_string(),
                    row.tokens[0].span,
                ));
            }
            if !row.children.is_empty() {
                return Err(Fail::new(
                    "E1210",
                    "example rows admit no child suite".to_string(),
                    row.tokens[0].span,
                ));
            }
            let eof = piece_eof(&row.tokens, self.file, Span::new(self.file, 0, 0));
            let mut cursor = self.cursor(&row.tokens, eof);
            let mut row_kids = Vec::new();
            let inputs = self.parse_expression_list(&mut cursor, &mut row_kids)?;
            let arrow = cursor.expect_p(Punct::Arrow)?;
            self.builder.leaf(&mut row_kids, &arrow);
            let mut out_kids = Vec::new();
            let outputs = self.parse_expression_list(&mut cursor, &mut out_kids)?;
            cursor.end()?;
            // A sole `error(code)` replaces the whole expected row.
            let has_error_call = outputs.iter().any(|node| self.is_expected_error(node));
            if has_error_call {
                let sole_single = outputs.len() == 1 && Self::error_arg_count(&outputs[0]) == 1;
                if !sole_single {
                    return Err(Fail::new(
                        "E1210",
                        "error(code) must replace the entire expected row".to_string(),
                        row.tokens[0].span,
                    ));
                }
                let expected =
                    SyntaxNode::enclosing(SyntaxKind::ExpectedError, std::mem::take(&mut out_kids));
                self.builder.push_inner(&mut row_kids, expected);
            } else {
                row_kids.extend(out_kids);
            }
            let row_node = SyntaxNode::enclosing(SyntaxKind::ExampleRow, row_kids);
            if index == 0 {
                header_arity = Some((inputs.len(), outputs.len()));
            } else if let Some((header_inputs, header_outputs)) = header_arity {
                if inputs.len() != header_inputs {
                    return Err(Fail::new(
                        "E1210",
                        "example input row does not match header arity".to_string(),
                        row.tokens[0].span,
                    ));
                }
                if !has_error_call && outputs.len() != header_outputs {
                    return Err(Fail::new(
                        "E1210",
                        "example expected row does not match header arity".to_string(),
                        row.tokens[0].span,
                    ));
                }
            }
            self.builder.push_inner(kids, row_node);
        }
        Ok(())
    }

    /// Whether a parsed expression is an `error(...)` expectation call.
    fn is_expected_error(&self, node: &SyntaxNode) -> bool {
        if node.kind != SyntaxKind::Call {
            return false;
        }
        let callee = &node.children[0];
        callee.kind == SyntaxKind::NameRef && self.first_token_text(callee) == Some("error")
    }

    /// Positional-or-named argument count of an `error(...)` call.
    fn error_arg_count(node: &SyntaxNode) -> usize {
        node.children
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .count()
    }

    /// Parse sequence-form steps under the sole `do` child.
    fn parse_example_sequence(
        &mut self,
        kids: &mut Vec<SyntaxNode>,
        do_line: &'a LogicalLine,
    ) -> Result<(), Fail> {
        self.push_description(kids, do_line);
        if do_line.tokens.len() != 1 {
            return Err(Fail::new(
                "E1210",
                "sequence `do` takes no inline effects".to_string(),
                do_line.tokens[0].span,
            ));
        }
        let mut do_kids = Vec::new();
        self.builder.leaf(&mut do_kids, &do_line.tokens[0]);
        if do_line.children.is_empty() {
            return Err(Fail::new(
                "E1210",
                "example sequence requires at least one step".to_string(),
                do_line.tokens[0].span,
            ));
        }
        let mut calls = 0usize;
        let mut assertions = 0usize;
        for step in &do_line.children {
            if step.tokens.is_empty() {
                self.push_dangling(&mut do_kids, step);
                continue;
            }
            self.push_description(&mut do_kids, step);
            if split_pieces(&step.tokens, self.file)?.0.len() > 1 {
                return Err(Fail::new(
                    "E1205",
                    "example steps do not admit semicolons".to_string(),
                    step.tokens[0].span,
                ));
            }
            if !step.children.is_empty() {
                return Err(Fail::new(
                    "E1210",
                    "example steps admit no child suite".to_string(),
                    step.tokens[0].span,
                ));
            }
            if piece_has_error(&step.tokens) {
                self.error_for_tokens(&mut do_kids, &step.tokens);
                continue;
            }
            let eof = piece_eof(&step.tokens, self.file, Span::new(self.file, 0, 0));
            let mut cursor = self.cursor(&step.tokens, eof);
            if cursor.at_name("let") {
                let mut step_kids = Vec::new();
                let head = cursor.next().expect("peeked let");
                self.builder.leaf(&mut step_kids, &head);
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut step_kids, &name);
                let eq = cursor.expect_p(Punct::Eq)?;
                self.builder.leaf(&mut step_kids, &eq);
                let value = self.parse_expr(&mut cursor, &never, true, true)?;
                self.builder.push_inner(&mut step_kids, value);
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::Let, step_kids);
                self.builder.push_inner(&mut do_kids, node);
            } else if cursor.at_name("call") {
                let (node, has_error) = self.parse_example_call(&mut cursor)?;
                if has_error {
                    assertions += 1;
                }
                calls += 1;
                self.builder.push_inner(&mut do_kids, node);
            } else {
                let mut step_kids = Vec::new();
                let left = self.parse_expression_list(&mut cursor, &mut step_kids)?;
                let arrow = cursor.expect_p(Punct::Arrow)?;
                self.builder.leaf(&mut step_kids, &arrow);
                let right = self.parse_expression_list(&mut cursor, &mut step_kids)?;
                cursor.end()?;
                if left.len() != right.len() {
                    return Err(Fail::new(
                        "E1210",
                        "sequence assertions require matching nonzero arity".to_string(),
                        step.tokens[0].span,
                    ));
                }
                assertions += 1;
                let node = SyntaxNode::enclosing(SyntaxKind::ExampleAssert, step_kids);
                self.builder.push_inner(&mut do_kids, node);
            }
        }
        if calls == 0 {
            return Err(Fail::new(
                "E1210",
                "example sequence requires at least one call".to_string(),
                do_line.tokens[0].span,
            ));
        }
        if assertions == 0 {
            return Err(Fail::new(
                "E1210",
                "example sequence requires at least one assertion or expected error".to_string(),
                do_line.tokens[0].span,
            ));
        }
        let node = SyntaxNode::enclosing(SyntaxKind::DoBlock, do_kids);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse one sequence `call`, returning the node plus whether it
    /// carries an expected error.
    fn parse_example_call(&mut self, cursor: &mut Cursor<'a>) -> Result<(SyntaxNode, bool), Fail> {
        let mut kids = Vec::new();
        let head = cursor.expect_name_is("call")?;
        self.builder.leaf(&mut kids, &head);
        let target_stop: Stop = &|w| w == "{";
        let target = self.parse_expr(cursor, target_stop, false, false)?;
        self.builder.push_inner(&mut kids, target);
        let arguments = self.parse_object(cursor)?;
        self.builder.push_inner(&mut kids, arguments);
        let by = cursor.expect_name_is("by")?;
        self.builder.leaf(&mut kids, &by);
        let eq = cursor.expect_p(Punct::Eq)?;
        self.builder.leaf(&mut kids, &eq);
        let (caller, _) = self.parse_path_node(cursor)?;
        self.builder.push_inner(&mut kids, caller);
        if cursor.at_name("request") {
            let request = cursor.next().expect("peeked request");
            self.builder.leaf(&mut kids, &request);
            let request_eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut kids, &request_eq);
            let overrides = self.parse_object(cursor)?;
            self.builder.push_inner(&mut kids, overrides);
        }
        let mut bound = false;
        if cursor.at_name("as") {
            let as_word = cursor.next().expect("peeked as");
            self.builder.leaf(&mut kids, &as_word);
            let binding = cursor.expect_name()?;
            self.builder.leaf(&mut kids, &binding);
            bound = true;
        }
        let mut has_error = false;
        if cursor.at_p(Punct::Arrow) {
            let arrow = cursor.next().expect("peeked arrow");
            self.builder.leaf(&mut kids, &arrow);
            let expected = self.parse_expr(cursor, &never, true, true)?;
            if !self.is_expected_error(&expected) || Self::error_arg_count(&expected) != 1 {
                return Err(Fail::new(
                    "E1210",
                    "expected error(code) after `->`".to_string(),
                    expected.span,
                ));
            }
            let expected = SyntaxNode::enclosing(SyntaxKind::ExpectedError, vec![expected]);
            self.builder.push_inner(&mut kids, expected);
            has_error = true;
        }
        if bound && has_error {
            return Err(Fail::new(
                "E1210",
                "`as` requires a declared result and is forbidden with an expected error"
                    .to_string(),
                head.span,
            ));
        }
        cursor.end()?;
        Ok((
            SyntaxNode::enclosing(SyntaxKind::ExampleCall, kids),
            has_error,
        ))
    }
}

/// Whether a line is exactly the bare sequence introducer `do`.
fn is_bare_do(text: &str, line: &LogicalLine) -> bool {
    line.tokens.len() == 1 && line.tokens[0].is_name(text, "do")
}

/// Scan a binding value's extent: tokens until the next depth-zero
/// `NAME =` boundary or the end of the header.
fn binding_value_end(toks: &[Token], from: usize) -> usize {
    let mut depth = 0u32;
    let mut index = from;
    while index < toks.len() {
        let token = &toks[index];
        if let TokenKind::Punct(punct) = token.kind {
            if punct.is_opener() {
                depth += 1;
            } else if punct.is_closer() {
                depth = depth.saturating_sub(1);
            }
        } else if depth == 0
            && token.kind == TokenKind::Name
            && toks
                .get(index + 1)
                .is_some_and(|next| next.is_punct(Punct::Eq))
        {
            break;
        }
        index += 1;
    }
    index
}

// Presentation ----------------------------------------------------------------

impl<'a> Parser<'a> {
    fn parse_ui_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine, top: bool) {
        if self.suite_depth >= MAX_SUITE_DEPTH {
            self.cap_suite(out, std::slice::from_ref(line), "UI", "E1200");
            return;
        }
        self.suite_depth += 1;
        self.parse_ui_line_inner(out, line, top);
        self.suite_depth -= 1;
    }

    /// Unbudgeted `parse_ui_line` body; callers use the guarded wrapper.
    fn parse_ui_line_inner(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine, top: bool) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.parse_ui_pieces(out, line, &pieces, &seps, top, false);
    }

    /// Parse `tabs` children, where only `tab` suites are allowed.
    fn parse_ui_tab_children(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        if self.suite_depth >= MAX_SUITE_DEPTH {
            self.cap_suite(out, std::slice::from_ref(line), "UI", "E1200");
            return;
        }
        self.suite_depth += 1;
        self.parse_ui_tab_children_inner(out, line);
        self.suite_depth -= 1;
    }

    /// Unbudgeted `parse_ui_tab_children` body; callers use the guarded wrapper.
    fn parse_ui_tab_children_inner(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                // `tab` heads are compound: multi-piece tab lines fail here.
                self.recover(out, line, fail);
                return;
            }
        }
        self.parse_ui_pieces(out, line, &pieces, &seps, false, true);
    }

    #[allow(clippy::too_many_arguments)]
    fn parse_ui_pieces(
        &mut self,
        out: &mut Vec<SyntaxNode>,
        line: &'a LogicalLine,
        pieces: &[&'a [Token]],
        seps: &[Token],
        top: bool,
        tabs_only: bool,
    ) {
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let children = if pieces.len() == 1 {
                    line.children.as_slice()
                } else {
                    &[][..]
                };
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_ui_piece(&mut cursor, scratch, children, top, tabs_only)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(out, piece);
                    self.error_for_children(out, children);
                }
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    fn parse_ui_piece(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        top: bool,
        tabs_only: bool,
    ) -> Result<(), Fail> {
        let head = cursor.expect_name()?;
        let word = head.text(cursor.text).to_string();
        if top && word != "page" {
            return Err(Fail::new(
                "E1200",
                "Then accepts pages; navigation derives from them".to_string(),
                head.span,
            ));
        }
        if !top && word == "page" {
            return Err(Fail::new(
                "E1200",
                "page declarations belong directly in Then".to_string(),
                head.span,
            ));
        }
        if tabs_only && word != "tab" {
            return Err(Fail::new(
                "E1200",
                "tabs accepts tab suites".to_string(),
                head.span,
            ));
        }
        if !tabs_only && word == "tab" {
            return Err(Fail::new(
                "E1200",
                "tab belongs directly inside tabs".to_string(),
                head.span,
            ));
        }
        match word.as_str() {
            "page" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let route = self.parse_route(cursor, HeaderKind::Page)?;
                self.builder.push_inner(&mut inner, route);
                self.parse_attributes(cursor, &mut inner, HeaderKind::Page)?;
                cursor.end()?;
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Page, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "tabs" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let mut selector = false;
                if !cursor.done() {
                    let value = self.parse_expr(cursor, &never, true, true)?;
                    self.builder.push_inner(&mut inner, value);
                    selector = true;
                }
                cursor.end()?;
                if children.is_empty() && !selector {
                    return Err(Fail::new(
                        "E1204",
                        "unbound tabs requires tab suites".to_string(),
                        head.span,
                    ));
                }
                for child in children {
                    if child.tokens.is_empty() {
                        self.push_dangling(&mut inner, child);
                        continue;
                    }
                    self.parse_ui_tab_children(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Tabs, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "tab" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let caption = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut inner, caption);
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "tab requires presentation children".to_string(),
                        head.span,
                    ));
                }
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Tab, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "list" | "table" | "board" | "gallery" => {
                let header = match word.as_str() {
                    "list" => HeaderKind::List,
                    "table" => HeaderKind::Table,
                    "board" => HeaderKind::Board,
                    _ => HeaderKind::Gallery,
                };
                self.parse_collection(head, cursor, kids, children, header)
            }
            "calendar" => {
                // Written-shape dispatch: both endpoints select the agenda
                // collection; a selector without endpoints is the catalog's
                // field-placement date control. A partial endpoint header
                // takes the agenda path and fails its required attribute.
                let has_start = header_has_attr(cursor.text, cursor.toks, "start");
                let has_end = header_has_attr(cursor.text, cursor.toks, "end");
                if has_start || has_end {
                    self.parse_collection(head, cursor, kids, children, HeaderKind::Calendar)
                } else {
                    self.parse_catalog_item(head, cursor, kids, children)
                }
            }
            "form" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let stop: Stop = &|w| attr_kind(HeaderKind::Form, w).is_some();
                let operation = self.parse_expr(cursor, stop, true, true)?;
                self.builder.push_inner(&mut inner, operation);
                self.parse_attributes(cursor, &mut inner, HeaderKind::Form)?;
                cursor.end()?;
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Form, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "edit" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                self.parse_attributes(cursor, &mut inner, HeaderKind::Edit)?;
                cursor.end()?;
                // The leaf control stays valid; the optional presentation
                // suite shares the owning update schema.
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Edit, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "slot" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let name = cursor.expect_name()?;
                self.builder.leaf(&mut inner, &name);
                self.parse_no_attributes(cursor)?;
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "slot requires presentation children".to_string(),
                        head.span,
                    ));
                }
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::Slot, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "preferences" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                self.parse_no_attributes(cursor)?;
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "preferences panel requires presentation children".to_string(),
                        head.span,
                    ));
                }
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let node = SyntaxNode::enclosing(SyntaxKind::PreferencePanel, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "delete" | "history" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::UiLeaf, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, word.as_str(), span);
                Ok(())
            }
            "action" | "actions" | "text" | "content" | "metrics" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let values = self.parse_expression_list(cursor, &mut inner)?;
                if word == "action" && values.len() != 1 {
                    return Err(Fail::new(
                        "E1200",
                        "action requires one operation".to_string(),
                        head.span,
                    ));
                }
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::UiLeaf, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, word.as_str(), span);
                Ok(())
            }
            "title" | "copy" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let value = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut inner, value);
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::UiLeaf, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, word.as_str(), span);
                Ok(())
            }
            "card" | "details" => {
                let header = if word == "card" {
                    HeaderKind::Card
                } else {
                    HeaderKind::Details
                };
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                // The approved catalog profile permits a card with no
                // heading: nothing follows, or an attribute does (no valid
                // heading starts with `NAME =`).
                let heading_omitted = word == "card"
                    && (cursor.done() || (cursor.at_any_name() && cursor.peek_is_eq()));
                if !heading_omitted {
                    let stop: Stop = &|w| attr_kind(header, w).is_some();
                    let heading = self.parse_expr(cursor, stop, true, true)?;
                    self.builder.push_inner(&mut inner, heading);
                }
                self.parse_attributes(cursor, &mut inner, header)?;
                if word == "details"
                    && self.has_attribute(&inner, "display")
                    && self.has_attribute(&inner, "open")
                {
                    return Err(Fail::new(
                        "E1200",
                        "drawer details cannot declare open; open applies to Collapse".to_string(),
                        head.span,
                    ));
                }
                cursor.end()?;
                if children.is_empty() {
                    return Err(Fail::new(
                        "E1204",
                        "presentation group requires children".to_string(),
                        head.span,
                    ));
                }
                for child in children {
                    self.parse_ui_child(&mut inner, child);
                }
                let kind = if word == "card" {
                    SyntaxKind::Card
                } else {
                    SyntaxKind::Details
                };
                let node = SyntaxNode::enclosing(kind, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "require" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let predicate = self.parse_expr(cursor, &never, true, true)?;
                self.builder.push_inner(&mut inner, predicate);
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::UiLeaf, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, "require", span);
                Ok(())
            }
            _ => self.parse_catalog_item(head, cursor, kids, children),
        }
    }

    /// Parse one `list`/`table`/`board`/`calendar`/`gallery` collection.
    fn parse_collection(
        &mut self,
        head: Token,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
        header: HeaderKind,
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        self.builder.leaf(&mut inner, &head);
        let stop: Stop = &|w| attr_kind(header, w).is_some();
        let query = self.parse_expr(cursor, stop, true, true)?;
        self.builder.push_inner(&mut inner, query);
        self.parse_attributes(cursor, &mut inner, header)?;
        cursor.end()?;
        for child in children {
            self.parse_ui_child(&mut inner, child);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Collection, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse one catalog component item: any contextual UI word with the
    /// generic header/body profiles (optional observations, generic
    /// `NAME=expr` options, optional suite). The producer-owned catalog
    /// lives in analysis, which validates word/option/parent-shape
    /// membership; the parser only establishes shape.
    fn parse_catalog_item(
        &mut self,
        head: Token,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<(), Fail> {
        let mut inner = Vec::new();
        self.builder.leaf(&mut inner, &head);
        // Positional observations, unless an attribute follows (no valid
        // observation starts with `NAME =`). As in collection headers,
        // attribute recognition wins over a query clause with the same
        // `NAME=` spelling, so `order=`/`archived=` end the observations.
        let catalog_stop: Stop = &|w| matches!(w, "order" | "archived");
        if !cursor.done() && !(cursor.at_any_name() && cursor.peek_is_eq()) {
            loop {
                let value = self.parse_expr(cursor, catalog_stop, true, true)?;
                self.builder.push_inner(&mut inner, value);
                if !cursor.at_p(Punct::Comma) {
                    break;
                }
                let comma = cursor.next().expect("peeked comma");
                self.builder.leaf(&mut inner, &comma);
            }
        }
        let mut seen: Vec<String> = Vec::new();
        while !cursor.done() {
            let key = cursor.expect_name()?;
            let word = key.text(cursor.text).to_string();
            if seen.contains(&word) {
                return Err(Fail::new(
                    "E1202",
                    format!("duplicate attribute `{word}`"),
                    key.span,
                ));
            }
            seen.push(word);
            let mut attr = Vec::new();
            self.builder.leaf(&mut attr, &key);
            let eq = cursor.expect_p(Punct::Eq)?;
            self.builder.leaf(&mut attr, &eq);
            let value = self.parse_expr(cursor, catalog_stop, true, true)?;
            self.builder.push_inner(&mut attr, value);
            let attr = SyntaxNode::enclosing(SyntaxKind::Attribute, attr);
            self.builder.push_inner(&mut inner, attr);
        }
        cursor.end()?;
        for child in children {
            self.parse_ui_child(&mut inner, child);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::CatalogItem, inner);
        self.builder.push_inner(kids, node);
        Ok(())
    }

    /// Parse one nested UI line (never top-level).
    fn parse_ui_child(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        if line.tokens.is_empty() {
            self.push_dangling(out, line);
            return;
        }
        self.parse_ui_line(out, line, false);
    }

    /// Whether parsed header children already hold an attribute.
    fn has_attribute(&self, kids: &[SyntaxNode], name: &str) -> bool {
        kids.iter().any(|node| {
            node.kind == SyntaxKind::Attribute && self.first_token_text(node) == Some(name)
        })
    }
}

// Maintenance: migrations ----------------------------------------------------

impl<'a> Parser<'a> {
    fn parse_migration(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        self.push_description(out, line);
        let mut kids = Vec::new();
        let eof = self.line_eof(line);
        let mut cursor = self.cursor(&line.tokens, eof);
        let header = self.attempt(&mut kids, |parser, scratch| {
            let head = cursor.expect_name_is("migration")?;
            parser.builder.leaf(scratch, &head);
            let owner = cursor.expect_name()?;
            parser.builder.leaf(scratch, &owner);
            parser.parse_attributes(&mut cursor, scratch, HeaderKind::Migration)?;
            cursor.end()?;
            Ok(())
        });
        if let Err(fail) = header {
            self.diags.push(fail.diag());
            self.error_for_tokens(&mut kids, &line.tokens);
        }
        for child in &line.children {
            if child.tokens.is_empty() {
                self.push_dangling(&mut kids, child);
                continue;
            }
            self.parse_migration_line(&mut kids, child);
        }
        let node = SyntaxNode::enclosing(SyntaxKind::Migration, kids);
        self.builder.push_inner(out, node);
    }

    fn parse_migration_line(&mut self, out: &mut Vec<SyntaxNode>, line: &'a LogicalLine) {
        let (pieces, seps) = match split_pieces(&line.tokens, self.file) {
            Ok(split) => split,
            Err(fail) => {
                self.recover(out, line, fail);
                return;
            }
        };
        if pieces.len() > 1 {
            if !line.children.is_empty() {
                self.recover(
                    out,
                    line,
                    Fail::new(
                        "E1205",
                        "semicolon sequences cannot own an indented suite".to_string(),
                        line.tokens[0].span,
                    ),
                );
                return;
            }
            if let Err(fail) = check_semi_heads(self.text, &pieces) {
                self.recover(out, line, fail);
                return;
            }
        }
        self.push_description(out, line);
        for (index, piece) in pieces.iter().enumerate() {
            if piece_has_error(piece) {
                self.error_for_tokens(out, piece);
            } else {
                let eof = piece_eof(piece, self.file, self.line_eof(line));
                let mut cursor = self.cursor(piece, eof);
                let children = if pieces.len() == 1 {
                    line.children.as_slice()
                } else {
                    &[][..]
                };
                let result = self.attempt(out, |parser, scratch| {
                    parser.parse_migration_directive(&mut cursor, scratch, children)
                });
                if let Err(fail) = result {
                    self.diags.push(fail.diag());
                    self.error_for_tokens(out, piece);
                    self.error_for_children(out, children);
                }
            }
            if index < seps.len() {
                self.builder.leaf(out, &seps[index]);
            }
        }
    }

    fn parse_migration_directive(
        &mut self,
        cursor: &mut Cursor<'a>,
        kids: &mut Vec<SyntaxNode>,
        children: &'a [LogicalLine],
    ) -> Result<(), Fail> {
        let head = cursor.expect_name()?;
        let word = head.text(cursor.text).to_string();
        match word.as_str() {
            "backfill" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let (model, parts) = self.parse_path_node(cursor)?;
                if parts.len() != 1 {
                    return Err(Fail::new(
                        "E1200",
                        "backfill names one desired model".to_string(),
                        head.span,
                    ));
                }
                self.builder.push_inner(&mut inner, model);
                cursor.end()?;
                self.parse_execution(&mut inner, children, true, false, head.span);
                let node = SyntaxNode::enclosing(SyntaxKind::Backfill, inner);
                self.builder.push_inner(kids, node);
                Ok(())
            }
            "rename" | "drop" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let peek2_text = cursor.peek2().map(|t| t.text(cursor.text).to_string());
                if cursor.at_name("owner") && !matches!(peek2_text.as_deref(), Some("." | "to")) {
                    let owner = cursor.next().expect("peeked owner");
                    self.builder.leaf(&mut inner, &owner);
                    cursor.end()?;
                    let kind = if word == "rename" {
                        SyntaxKind::Rename
                    } else {
                        SyntaxKind::Drop
                    };
                    let node = SyntaxNode::enclosing(kind, inner);
                    self.builder.push_inner(kids, node);
                    let span = cursor.eof;
                    self.swallow_children(kids, children, word.as_str(), span);
                    return Ok(());
                }
                let (before, parts) = self.parse_path_node(cursor)?;
                if parts.first().map(String::as_str) != Some("before") {
                    return Err(Fail::new(
                        "E1200",
                        "migration source must be in before namespace".to_string(),
                        head.span,
                    ));
                }
                if parts.len() != 2 && parts.len() != 3 {
                    return Err(Fail::new(
                        "E1200",
                        "migration source must name before.Model or before.Model.field".to_string(),
                        head.span,
                    ));
                }
                self.builder.push_inner(&mut inner, before);
                if word == "rename" {
                    let to = cursor.expect_name_is("to")?;
                    self.builder.leaf(&mut inner, &to);
                    let (target, target_parts) = self.parse_path_node(cursor)?;
                    if target_parts.len() != parts.len() - 1 {
                        return Err(Fail::new(
                            "E1200",
                            "rename must map a model to a model or a field to a field".to_string(),
                            head.span,
                        ));
                    }
                    self.builder.push_inner(&mut inner, target);
                }
                cursor.end()?;
                let kind = if word == "rename" {
                    SyntaxKind::Rename
                } else {
                    SyntaxKind::Drop
                };
                let node = SyntaxNode::enclosing(kind, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, word.as_str(), span);
                Ok(())
            }
            "invalidate" => {
                let mut inner = Vec::new();
                self.builder.leaf(&mut inner, &head);
                let (source, parts) = self.parse_path_node(cursor)?;
                if parts.len() != 2 || parts.first().map(String::as_str) != Some("before") {
                    return Err(Fail::new(
                        "E1200",
                        "invalidate requires before.handler".to_string(),
                        head.span,
                    ));
                }
                self.builder.push_inner(&mut inner, source);
                cursor.end()?;
                let node = SyntaxNode::enclosing(SyntaxKind::Invalidate, inner);
                self.builder.push_inner(kids, node);
                let span = cursor.eof;
                self.swallow_children(kids, children, "invalidate", span);
                Ok(())
            }
            _ => Err(Fail::new(
                "E1200",
                "unsupported migration directive".to_string(),
                head.span,
            )),
        }
    }
}
