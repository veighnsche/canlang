//! Idempotent canonical formatting for CanLang sources.
//!
//! [`format_source`] parses its input with the lossless CST parser and, only
//! when parsing reports no errors, re-emits it with canonical layout. The
//! formatter is deliberately conservative: it normalizes whitespace and
//! indentation but never reorders, adds, removes or rewrites tokens, so the
//! formatted output always re-parses to an equal CST modulo trivia.
//!
//! # Canonical rules
//!
//! * One-space indentation derived from suite structure. Logical lines keep
//!   their indentation (a valid file already uses exactly one space per
//!   level); continuation lines inside joined `(`/`[`/`{` regions — the only
//!   legally sloppy indentation — are reset to `parent + depth`, or
//!   `parent + depth - 1` for lines led by a closing delimiter. Inline `#`
//!   descriptions inside joined regions move with their field so the
//!   same-column attachment rule keeps holding.
//! * Intra-line spacing follows the compact house style used by GRAMMAR.md
//!   examples and the corpus: symbolic operators (`=`, `==`, `!=`, `<`,
//!   `<=`, `>`, `>=`, `+`, `-`, `*`, `/`, `%`, `??`, `|`), member dots,
//!   colons, `?`/`!` suffixes and commas bind tightly with no surrounding
//!   spaces. Loose separators keep single spaces: `->`, `;`, the definition
//!   `=` of `message`/`derive` heads, the `:` of `invariant` heads, spaces
//!   after schema commas and inside schema braces, and a space before a
//!   group paren/bracket after expression keywords (`and`, `or`, `not`,
//!   `where`, ...) or after any line-initial head word in statement
//!   position (`require (ok)`, `list (Todo)`, `gallery (Items)` and the
//!   open catalog-UI vocabulary such as `countdown (x)`). Calls and
//!   suffixes keep `name(` / `name[` tight; operation signatures and
//!   example rows always carry a depth-0 `->`, so they stay call-shaped
//!   even in statement position (`cancel(x) -> T`, `count(m) -> 1`).
//!   Judgment score level lists are option maps and keep a space before
//!   `[`, matching choice maps before `{` (`score "Cap" [low="L"]`).
//! * Routes on `page` header lines are emitted contiguously (spaces inside a
//!   route are a parse error), as is the `@{...}` message-suffix marker.
//! * `#` description lines, `##` comment lines, strings, numbers, durations
//!   and byte quantities are byte-preserved apart from trailing-whitespace
//!   removal and (for inline `#` lines inside joined regions) re-indentation.
//!   Declaration, member and example-row order is always preserved, as are
//!   semicolon leaves and the inline-vs-suite shape of `do` bodies.
//! * No trailing whitespace; LF line endings; exactly one trailing newline
//!   (an empty input stays empty).
//!
//! # Line endings and errors
//!
//! CRLF input is accepted and normalized to LF; that normalization counts as
//! a change (`changed == true`). A tab in indentation or code is a *parse*
//! error (`E1003`), never something the formatter repairs: unparseable input
//! yields [`FormatError`] with the `E1xxx` parse diagnostics instead of
//! output. Formatting therefore never fails silently.
//!
//! # Idempotence
//!
//! Every spacing and indentation decision is a pure function of the token
//! stream, so formatting is a fixed point: `format(format(x)) == format(x)`
//! byte-identically. See `compiler/tests/format.rs` for the corpus-wide
//! idempotence table and adversarial fixtures.

use crate::diagnostic::{Diagnostic, Severity};
use crate::source::SourceId;
use crate::syntax::lexer::{PhysLine, Punct, Token, TokenKind, lex};
use crate::syntax::parse_source;
use std::collections::{HashMap, HashSet};

/// Successfully formatted source: canonical text plus a change flag.
#[derive(Debug, Clone)]
pub struct Formatted {
    /// Canonical source text (LF endings, exactly one trailing newline
    /// unless the input is empty).
    pub text: String,
    /// Whether `text` differs from the input byte-for-byte. CRLF input,
    /// missing final newlines and trailing whitespace all count as changed.
    pub changed: bool,
}

/// Formatting failed because the input is unparseable.
///
/// There is deliberately no output text: callers must surface `diagnostics`
/// (the `E1xxx` parse diagnostics) instead of writing anything.
#[derive(Debug, Clone)]
pub struct FormatError {
    /// Parse diagnostics explaining why no output was produced.
    pub diagnostics: Vec<Diagnostic>,
}

/// Format one source text canonically.
///
/// Parses `text` as `file` and re-emits it with canonical layout. Returns
/// [`FormatError`] (with the parse diagnostics, no output) when parsing
/// reports any error, so unparseable input never formats silently.
///
/// # Idempotence
///
/// The result is a fixed point: formatting [`Formatted::text`] again
/// returns byte-identical text with `changed == false`. This is the entry
/// point `can fmt` uses; callers can rely on the guarantee without
/// re-checking.
pub fn format_source(file: SourceId, text: &str) -> Result<Formatted, FormatError> {
    let (_tree, diagnostics) = parse_source(file, text);
    if diagnostics.iter().any(|d| d.severity == Severity::Error) {
        return Err(FormatError { diagnostics });
    }
    // Parsing succeeded, so lexing below reports nothing new; the physical
    // lines are the formatter's working view (one output line per line).
    let lexed = lex(file, text);
    debug_assert!(
        lexed.diagnostics.is_empty(),
        "successful parse implies clean lex"
    );
    let schema_braces = classify_braces(&lexed.lines);
    let option_brackets = classify_option_brackets(&lexed.lines);
    let mut emitter = Emitter {
        source: text,
        schema_braces,
        option_brackets,
        stack: Vec::new(),
        parent_indent: None,
    };
    let mut lines = Vec::with_capacity(lexed.lines.len());
    for (index, line) in lexed.lines.iter().enumerate() {
        lines.push(emitter.line(index, line));
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    let changed = out != text;
    Ok(Formatted { text: out, changed })
}

/// Expression words after which `(` or `[` always starts a grouped
/// expression or a fresh operand rather than a call or suffix, and therefore
/// keeps one space anywhere on the line: `or (a)`, `in [x]`. Spacing never
/// changes the token stream, so even a pathological callee named `select`
/// still parses identically; it only looks airier.
fn is_expr_keyword(word: &str) -> bool {
    matches!(
        word,
        "and" | "or" | "not" | "in" | "is" | "where" | "select"
    )
}

/// Whether any `->` sits at line-local depth 0.
fn has_loose_arrow(tokens: &[Token]) -> bool {
    let mut local: i32 = 0;
    for token in tokens {
        if local == 0 && token.is_punct(Punct::Arrow) {
            return true;
        }
        if let TokenKind::Punct(punct) = token.kind {
            if punct.is_opener() {
                local += 1;
            } else if punct.is_closer() {
                local -= 1;
            }
        }
    }
    false
}

/// Classify every `{...}` pair in the file: true when the braces delimit a
/// schema (a `:` appears at depth 0 inside), false for value objects, label
/// maps, `@{...}` suffixes, import lists and the rest (`=`-shaped or empty).
/// Route braces may classify either way; the route emitter overrides them.
fn classify_braces(lines: &[PhysLine]) -> HashMap<(usize, usize), bool> {
    struct Open {
        is_brace: bool,
        line: usize,
        token: usize,
        colon: bool,
    }
    let mut map = HashMap::new();
    let mut stack: Vec<Open> = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        for (token_index, token) in line.tokens.iter().enumerate() {
            match token.kind {
                TokenKind::Punct(punct) if punct.is_opener() => stack.push(Open {
                    is_brace: punct == Punct::LBrace,
                    line: line_index,
                    token: token_index,
                    colon: false,
                }),
                TokenKind::Punct(punct) if punct.is_closer() => {
                    if let Some(open) = stack.pop()
                        && open.is_brace
                    {
                        map.insert((open.line, open.token), open.colon);
                    }
                }
                TokenKind::Punct(Punct::Colon) => {
                    // Only a colon whose innermost opener is the brace marks
                    // it as a schema; colons nested deeper belong elsewhere.
                    if let Some(top) = stack.last_mut()
                        && top.is_brace
                    {
                        top.colon = true;
                    }
                }
                _ => {}
            }
        }
    }
    map
}

/// Every `[...]` pair holding a bare `=` at depth 0: judgment score level
/// lists (`[low="L",high="H"]`). Array literals, selectors and index
/// expressions never contain a depth-0 `=` (`==` is a separate token and
/// does not count), so only option maps match.
fn classify_option_brackets(lines: &[PhysLine]) -> HashSet<(usize, usize)> {
    struct Open {
        is_bracket: bool,
        line: usize,
        token: usize,
        eq: bool,
    }
    let mut set = HashSet::new();
    let mut stack: Vec<Open> = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        for (token_index, token) in line.tokens.iter().enumerate() {
            match token.kind {
                TokenKind::Punct(punct) if punct.is_opener() => stack.push(Open {
                    is_bracket: punct == Punct::LBracket,
                    line: line_index,
                    token: token_index,
                    eq: false,
                }),
                TokenKind::Punct(punct) if punct.is_closer() => {
                    if let Some(open) = stack.pop()
                        && open.is_bracket
                        && open.eq
                    {
                        set.insert((open.line, open.token));
                    }
                }
                TokenKind::Punct(Punct::Eq) => {
                    // Only an `=` whose innermost opener is the bracket
                    // marks it as an option map; `=` nested deeper (named
                    // arguments, value objects) belongs elsewhere.
                    if let Some(top) = stack.last_mut()
                        && top.is_bracket
                    {
                        top.eq = true;
                    }
                }
                _ => {}
            }
        }
    }
    set
}

/// One open delimiter on the emitter's global stack.
struct Frame {
    is_brace: bool,
    /// For braces, the [`classify_braces`] verdict.
    schema: bool,
}

/// Per-head-line context for gap decisions.
struct LineContext<'a> {
    tokens: &'a [Token],
    /// First word of a head line, skipping a leading `export`.
    head_word: Option<&'a str>,
    /// End token index (exclusive) of a `page` route span, if any.
    route_end: Option<usize>,
    /// Token index of a loose definition `=` on a `derive` head line.
    derive_eq: Option<usize>,
    /// Whether a `->` sits at line-local depth 0 (operation signature,
    /// example row or result annotation).
    loose_arrow: bool,
}

struct Emitter<'a> {
    source: &'a str,
    schema_braces: HashMap<(usize, usize), bool>,
    /// `[` openers of judgment score level lists (see
    /// [`classify_option_brackets`]), keyed by `(line, token)`.
    option_brackets: HashSet<(usize, usize)>,
    /// Open delimiters across the whole file; length is the bracket depth.
    stack: Vec<Frame>,
    /// Indent of the head line of the enclosing joined region, if any.
    parent_indent: Option<usize>,
}

impl<'a> Emitter<'a> {
    /// Emit one physical line. Blank lines become empty, `#`/`##` lines are
    /// preserved (inline `#` lines are re-indented with their field), and
    /// code lines are re-emitted token by token.
    fn line(&mut self, line_index: usize, line: &PhysLine) -> String {
        if line.tokens.is_empty() {
            return String::new();
        }
        let head = &line.tokens[0];
        match head.kind {
            TokenKind::Comment => self.preserved(line.indent, head),
            TokenKind::Desc => {
                let indent = if self.stack.is_empty() {
                    line.indent
                } else {
                    self.parent_indent.unwrap_or(0) + self.stack.len()
                };
                self.preserved(indent, head)
            }
            _ => self.code_line(line_index, line),
        }
    }

    /// A `#`/`##` line at `indent`: marker-to-end text with trailing
    /// whitespace stripped. Prose, `#=` references and `@{...}` suffixes
    /// are otherwise byte-preserved.
    fn preserved(&self, indent: usize, token: &Token) -> String {
        format!(
            "{}{}",
            " ".repeat(indent),
            token.text(self.source).trim_end_matches([' ', '\t'])
        )
    }

    /// Emit one physical code line: canonical indent plus tokens joined by
    /// canonical gaps. Updates the global delimiter stack and joined-region
    /// parent indent.
    fn code_line(&mut self, line_index: usize, line: &PhysLine) -> String {
        let tokens = &line.tokens;
        let depth_before = self.stack.len();
        let head_line = depth_before == 0;
        let closer_led = matches!(
            tokens[0].kind,
            TokenKind::Punct(Punct::RParen | Punct::RBracket | Punct::RBrace)
        );
        let indent = if head_line {
            // Valid input already indents every logical line canonically.
            line.indent
        } else {
            self.parent_indent.unwrap_or(0) + depth_before - usize::from(closer_led)
        };
        let head_word = self.head_word(head_line, tokens);
        let context = LineContext {
            tokens,
            head_word,
            route_end: self.route_end(head_word, tokens),
            derive_eq: self.derive_loose_eq(head_word, tokens),
            loose_arrow: has_loose_arrow(tokens),
        };
        let mut out = " ".repeat(indent);
        // Line-local bracket depth (before applying each token). Head lines
        // start at global depth 0 so this doubles as global depth there.
        let mut local: i32 = 0;
        let mut previous_depth: i32 = 0;
        for (index, token) in tokens.iter().enumerate() {
            if index > 0 {
                out.push_str(self.gap(&context, line_index, index, local, previous_depth));
            }
            out.push_str(token.text(self.source));
            previous_depth = local;
            if let TokenKind::Punct(punct) = token.kind {
                if punct.is_opener() {
                    local += 1;
                    let schema = punct == Punct::LBrace
                        && self
                            .schema_braces
                            .get(&(line_index, index))
                            .copied()
                            .unwrap_or(false);
                    self.stack.push(Frame {
                        is_brace: punct == Punct::LBrace,
                        schema,
                    });
                } else if punct.is_closer() {
                    local -= 1;
                    self.stack.pop();
                }
            }
        }
        if self.stack.is_empty() {
            self.parent_indent = None;
        } else if head_line {
            self.parent_indent = Some(indent);
        }
        out
    }

    /// Effective head word of a head line: first name token, skipping a
    /// leading `export` so `export message`/`export derive` still match.
    fn head_word(&self, head_line: bool, tokens: &[Token]) -> Option<&'a str> {
        if !head_line {
            return None;
        }
        let mut position = 0;
        if tokens
            .first()
            .is_some_and(|token| token.is_name(self.source, "export"))
        {
            position = 1;
        }
        tokens
            .get(position)
            .filter(|token| token.kind == TokenKind::Name)
            .map(|token| token.text(self.source))
    }

    /// Route span end (exclusive) on a `page` head line whose route starts
    /// with `/`: the first depth-0 `NAME =` attribute boundary, else EOL.
    /// `None` for anything else — including a model that happens to be
    /// named `page`, which never has `/` second.
    fn route_end(&self, head_word: Option<&str>, tokens: &[Token]) -> Option<usize> {
        if head_word != Some("page") {
            return None;
        }
        if tokens.len() < 2 || !tokens[1].is_punct(Punct::Slash) {
            return None;
        }
        let mut local: i32 = 0;
        for (index, token) in tokens.iter().enumerate().skip(1) {
            if index >= 2
                && local == 0
                && token.kind == TokenKind::Name
                && tokens
                    .get(index + 1)
                    .is_some_and(|next| next.is_punct(Punct::Eq))
            {
                return Some(index);
            }
            if let TokenKind::Punct(punct) = token.kind {
                if punct.is_opener() {
                    local += 1;
                } else if punct.is_closer() {
                    local -= 1;
                }
            }
        }
        Some(tokens.len())
    }

    /// Loose definition `=` on a `derive` head line: the first depth-0 `=`
    /// when a depth-0 `:` (the signature colon) precedes it. Parameter
    /// defaults sit deeper and labels come later, so neither matches; a
    /// model that happens to be named `derive` has no depth-0 colon.
    fn derive_loose_eq(&self, head_word: Option<&str>, tokens: &[Token]) -> Option<usize> {
        if head_word != Some("derive") {
            return None;
        }
        let mut local: i32 = 0;
        let mut colon_seen = false;
        for (index, token) in tokens.iter().enumerate() {
            if local == 0 {
                if token.is_punct(Punct::Colon) {
                    colon_seen = true;
                }
                if token.is_punct(Punct::Eq) {
                    return colon_seen.then_some(index);
                }
            }
            if let TokenKind::Punct(punct) = token.kind {
                if punct.is_opener() {
                    local += 1;
                } else if punct.is_closer() {
                    local -= 1;
                }
            }
        }
        None
    }

    /// Whether the innermost enclosing delimiter is a schema `{...}`.
    /// Parens and brackets reset this: commas inside `enum(a,b)` stay tight
    /// even when the call sits in a schema.
    fn top_is_schema_brace(&self) -> bool {
        self.stack
            .last()
            .is_some_and(|frame| frame.is_brace && frame.schema)
    }

    /// Canonical gap before token `index` on physical line `line` (`""` or
    /// `" "`). The decision is a pure function of token kinds, head word,
    /// route span, brace/bracket classes and depths, which is what makes
    /// formatting idempotent.
    fn gap(
        &self,
        context: &LineContext<'a>,
        line: usize,
        index: usize,
        current_depth: i32,
        previous_depth: i32,
    ) -> &'static str {
        let tokens = context.tokens;
        let previous = &tokens[index - 1];
        let current = &tokens[index];
        // Routes are contiguous: space after `page`, tight inside, and the
        // normal rules resume at the first attribute.
        if let Some(end) = context.route_end {
            if index == 1 {
                return " ";
            }
            if index < end {
                return "";
            }
            if index == end {
                // First attribute after the route: the `/`-after rule for
                // division must not glue it to a route-final slash.
                return " ";
            }
        }
        // Loose separators force a space after them whatever follows
        // (`-> -50`, `; set ...`), ahead of the tight current-token rules.
        if previous.is_punct(Punct::Arrow) || previous.is_punct(Punct::Semicolon) {
            return " ";
        }
        // Current-token rules: gaps that never take a space (plus the
        // loose `=`, `(`, `[`, `{`, `}` handled below).
        if let TokenKind::Punct(punct) = current.kind {
            match punct {
                Punct::Arrow => return " ",
                Punct::RBrace => {
                    // The matching `{` is the stack top.
                    if self.top_is_schema_brace() {
                        return " ";
                    }
                    return "";
                }
                Punct::Eq => {
                    if self.is_loose_eq(context, index, current_depth) {
                        return " ";
                    }
                    // `! =` keeps its space: joining would lex as `!=`.
                    if previous.is_punct(Punct::Bang) {
                        return " ";
                    }
                    return "";
                }
                Punct::LParen | Punct::LBracket => {
                    // Judgment score level lists are option maps: a space
                    // before `[` (matching choice `{...}` maps), wherever
                    // the caption ends (a string or an `@{...}` suffix).
                    if punct == Punct::LBracket && self.option_brackets.contains(&(line, index)) {
                        return " ";
                    }
                    if previous.kind == TokenKind::Name {
                        // A depth-0 `->` marks an operation signature, an
                        // example row or a result annotation, where a name
                        // paren is always call-shaped: `cancel(x) -> T`.
                        if !context.loose_arrow {
                            let word = previous.text(self.source);
                            if is_expr_keyword(word) {
                                return " ";
                            }
                            // Statement position (first token on the line,
                            // or just after `;`) holds a head word, never
                            // a call: bare calls are invalid statements,
                            // Given/When heads never take a paren, and
                            // example rows always carry `->` (see above).
                            // This covers the fixed heads (`require (ok)`,
                            // `list (Todo)`, `gallery (Items)`) and the
                            // open catalog-UI vocabulary (`countdown (x)`)
                            // alike. The same words mid-line are calls,
                            // types or suffixes and stay tight:
                            // `action(...)`, `text[]`, `x=require(y)`.
                            if index == 1 || tokens[index - 2].is_punct(Punct::Semicolon) {
                                return " ";
                            }
                        }
                        return "";
                    }
                    // Calls chain tightly off values, literals and closers:
                    // `f()(x)`, `"Hi"@{..}(name=n)`, `enum(A)[]`.
                    if matches!(
                        previous.kind,
                        TokenKind::Punct(Punct::RParen | Punct::RBracket | Punct::RBrace)
                            | TokenKind::String
                            | TokenKind::Integer
                            | TokenKind::Decimal
                            | TokenKind::Duration
                            | TokenKind::Bytes
                    ) {
                        return "";
                    }
                    // After `,`/operators/`(`/`[` the previous-token rules
                    // below decide; anything else takes a space.
                }
                Punct::LBrace => {
                    if matches!(
                        previous.kind,
                        TokenKind::Punct(
                            Punct::At
                                | Punct::LParen
                                | Punct::LBracket
                                | Punct::LBrace
                                | Punct::Comma
                                | Punct::Eq
                                | Punct::EqEq
                                | Punct::NotEq
                                | Punct::LtEq
                                | Punct::GtEq
                                | Punct::Lt
                                | Punct::Gt
                                | Punct::Plus
                                | Punct::Minus
                                | Punct::Star
                                | Punct::Slash
                                | Punct::Percent
                                | Punct::QuestionQuestion
                                | Punct::Pipe
                        )
                    ) {
                        return "";
                    }
                    // `Todo {`, `) {`, `} {`: previous-token rules (`;`,
                    // `->`) or the default space decide.
                }
                // Everything else binds tightly on its left: closers,
                // member dots, type colons, suffixes, separators and the
                // compact operators.
                Punct::RParen
                | Punct::RBracket
                | Punct::Comma
                | Punct::Dot
                | Punct::Colon
                | Punct::Semicolon
                | Punct::Bang
                | Punct::Pipe
                | Punct::Plus
                | Punct::Minus
                | Punct::Star
                | Punct::Slash
                | Punct::Percent
                | Punct::Lt
                | Punct::Gt
                | Punct::Question
                | Punct::EqEq
                | Punct::NotEq
                | Punct::LtEq
                | Punct::GtEq
                | Punct::QuestionQuestion
                | Punct::QuestionDot
                | Punct::At => return "",
            }
        }
        // Previous-token rules, then the default single space.
        if let TokenKind::Punct(punct) = previous.kind {
            match punct {
                Punct::Arrow | Punct::Semicolon => return " ",
                Punct::Eq => {
                    if context.derive_eq == Some(index - 1)
                        || context.head_word == Some("message")
                            && previous_depth == 0
                            && current.kind == TokenKind::String
                    {
                        return " ";
                    }
                    return "";
                }
                Punct::Colon => {
                    // `invariant Target: body` breathes after the colon;
                    // type colons (`name:type`, routes, derives) stay tight.
                    if context.head_word == Some("invariant") && previous_depth == 0 {
                        return " ";
                    }
                    return "";
                }
                Punct::Comma => {
                    if self.top_is_schema_brace() {
                        return " ";
                    }
                    return "";
                }
                Punct::LBrace => {
                    // The brace just opened, so it is the stack top.
                    if self.top_is_schema_brace() {
                        return " ";
                    }
                    return "";
                }
                // Tight on the right: openers, member dots, the message
                // marker and the compact operators.
                Punct::LParen
                | Punct::LBracket
                | Punct::Dot
                | Punct::QuestionDot
                | Punct::At
                | Punct::Pipe
                | Punct::Plus
                | Punct::Minus
                | Punct::Star
                | Punct::Slash
                | Punct::Percent
                | Punct::Lt
                | Punct::Gt
                | Punct::EqEq
                | Punct::NotEq
                | Punct::LtEq
                | Punct::GtEq
                | Punct::QuestionQuestion => return "",
                Punct::RParen | Punct::RBracket | Punct::RBrace | Punct::Question | Punct::Bang => {
                }
            }
        }
        " "
    }

    /// Whether the `=` at `index` is a loose definition separator: the
    /// precomputed `derive` one, or a depth-0 `=` on a `message` head line
    /// whose value starts with a string (`message NAME [params] = STRING`).
    fn is_loose_eq(&self, context: &LineContext<'a>, index: usize, depth: i32) -> bool {
        if context.derive_eq == Some(index) {
            return true;
        }
        context.head_word == Some("message")
            && depth == 0
            && context
                .tokens
                .get(index + 1)
                .is_some_and(|next| next.kind == TokenKind::String)
    }
}
