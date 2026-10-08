//! Lexer: UTF-8 validation, physical lines, tokens and trivia prep.
//!
//! Covers GRAMMAR.md "Tokens and layout": LF/CRLF endings, JSON strings,
//! NAME/INTEGER/DECIMAL/DURATION/BYTES, longest-match punctuation, `#`/`##`
//! physical-line markers (outside strings) and route-slot `/` (lexed as
//! division here; the parser reinterprets it only in route slots).
//!
//! The lexer emits no whitespace tokens. Every [`Token`] carries an exact
//! [`Span`](crate::source::Span); gaps between token spans are trivia
//! (spaces, newlines, blank lines) reattached losslessly by the parser's
//! CST builder. `##` comment lines and `#` description lines are single
//! tokens spanning marker to end of line; layout decides their role.
//!
//! Diagnostics use codes E1001–E1008 (see `syntax::mod` catalog).

use crate::diagnostic::Diagnostic;
use crate::source::{SourceId, Span, admit_source_len};

/// Punctuation token. Multi-character operators lex longest-match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Punct {
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Comma,
    Dot,
    Colon,
    Semicolon,
    Eq,
    Bang,
    Pipe,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Lt,
    Gt,
    Question,
    EqEq,
    NotEq,
    LtEq,
    GtEq,
    QuestionQuestion,
    QuestionDot,
    Arrow,
    At,
}

impl Punct {
    /// Source spelling of this punctuation token.
    pub fn spell(self) -> &'static str {
        match self {
            Punct::LParen => "(",
            Punct::RParen => ")",
            Punct::LBracket => "[",
            Punct::RBracket => "]",
            Punct::LBrace => "{",
            Punct::RBrace => "}",
            Punct::Comma => ",",
            Punct::Dot => ".",
            Punct::Colon => ":",
            Punct::Semicolon => ";",
            Punct::Eq => "=",
            Punct::Bang => "!",
            Punct::Pipe => "|",
            Punct::Plus => "+",
            Punct::Minus => "-",
            Punct::Star => "*",
            Punct::Slash => "/",
            Punct::Percent => "%",
            Punct::Lt => "<",
            Punct::Gt => ">",
            Punct::Question => "?",
            Punct::EqEq => "==",
            Punct::NotEq => "!=",
            Punct::LtEq => "<=",
            Punct::GtEq => ">=",
            Punct::QuestionQuestion => "??",
            Punct::QuestionDot => "?.",
            Punct::Arrow => "->",
            Punct::At => "@",
        }
    }

    /// Opening delimiters that join physical lines at layout time.
    pub fn is_opener(self) -> bool {
        matches!(self, Punct::LParen | Punct::LBracket | Punct::LBrace)
    }

    /// Closing delimiters matched against [`Punct::is_opener`].
    pub fn is_closer(self) -> bool {
        matches!(self, Punct::RParen | Punct::RBracket | Punct::RBrace)
    }

    /// Closer expected for an opening delimiter.
    pub fn matching_closer(self) -> Option<Punct> {
        match self {
            Punct::LParen => Some(Punct::RParen),
            Punct::LBracket => Some(Punct::RBracket),
            Punct::LBrace => Some(Punct::RBrace),
            _ => None,
        }
    }
}

/// Token kind. Payloads live on [`Token`] or are sliced from source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Name,
    Integer,
    Decimal,
    Duration,
    Bytes,
    String,
    Punct(Punct),
    /// A `#...` physical line: marker through end of line (no newline).
    Desc,
    /// A `##...` physical line: marker through end of line (no newline).
    Comment,
    /// A character that cannot start any token (e.g. `&`, inline `#`).
    /// Emitted so the CST still covers the byte; the lexer diagnostic
    /// already reports it.
    Error,
}

/// One lexical token with its exact source span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub span: Span,
    /// Decoded value for [`TokenKind::String`] when valid; `None` for
    /// invalid strings (diagnostic already emitted) and other tokens.
    pub string_value: Option<String>,
}

impl Token {
    fn new(kind: TokenKind, file: SourceId, start: u32, end: u32) -> Self {
        Self {
            kind,
            span: Span::new(file, start, end),
            string_value: None,
        }
    }

    /// Source text of this token.
    pub fn text<'a>(&self, source: &'a str) -> &'a str {
        &source[self.span.start as usize..self.span.end as usize]
    }

    /// Whether this is a `NAME` token with the given spelling.
    pub fn is_name(&self, source: &str, word: &str) -> bool {
        self.kind == TokenKind::Name && self.text(source) == word
    }

    /// Whether this is the given punctuation token.
    pub fn is_punct(&self, punct: Punct) -> bool {
        self.kind == TokenKind::Punct(punct)
    }
}

/// One physical source line after lexing.
#[derive(Debug, Clone)]
pub struct PhysLine {
    /// 1-based physical line number.
    pub number: usize,
    /// Byte offset of the first character of the line.
    pub start: u32,
    /// Byte offset one past the line content (excludes `\r\n`/`\n`).
    pub end: u32,
    /// Leading spaces before the first non-space character.
    pub indent: usize,
    /// Tokens on this line; empty for blank lines.
    pub tokens: Vec<Token>,
}

impl PhysLine {
    /// Whether the line carries no tokens (blank or whitespace-only).
    pub fn is_blank(&self) -> bool {
        self.tokens.is_empty()
    }
}

/// Outcome of [`lex`]: physical lines plus recoverable diagnostics.
#[derive(Debug)]
pub struct Lexed {
    pub lines: Vec<PhysLine>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Lex raw bytes, rejecting malformed UTF-8 with E1002.
pub fn lex_bytes(file: SourceId, bytes: &[u8]) -> Result<Lexed, Diagnostic> {
    admit_source_len(bytes.len() as u64)
        .map_err(|error| Diagnostic::error("E1008", error.to_string(), Span::new(file, 0, 0)))?;
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(lex(file, text)),
        Err(error) => {
            let at = error.valid_up_to() as u32;
            Err(Diagnostic::error(
                "E1002",
                "source is not valid UTF-8".to_string(),
                Span::new(file, at, at + 1),
            ))
        }
    }
}

/// Lex validated source text into physical lines.
///
/// Within the source-offset range, every byte lands in exactly one token
/// span or in trivia gaps. Oversized text returns no lines and one E1008.
pub fn lex(file: SourceId, text: &str) -> Lexed {
    if let Err(error) = admit_source_len(text.len() as u64) {
        return Lexed {
            lines: Vec::new(),
            diagnostics: vec![Diagnostic::error(
                "E1008",
                error.to_string(),
                Span::new(file, 0, 0),
            )],
        };
    }
    let mut diagnostics = Vec::new();
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut line_start = 0usize;
    let mut number = 1usize;

    // Split on `\n`, keeping absolute offsets. A `\r` immediately before
    // `\n` is part of the line break; any other `\r` is E1001.
    let mut i = 0usize;
    while i <= bytes.len() {
        let is_end = i == bytes.len();
        let is_newline = !is_end && bytes[i] == b'\n';
        if !is_end && !is_newline {
            if bytes[i] == b'\r' {
                let followed_by_lf = i + 1 < bytes.len() && bytes[i + 1] == b'\n';
                if !followed_by_lf {
                    diagnostics.push(Diagnostic::error(
                        "E1001",
                        "bare carriage return is not a line ending".to_string(),
                        Span::new(file, i as u32, i as u32 + 1),
                    ));
                }
            }
            i += 1;
            continue;
        }
        // Line content is [line_start, i); strip one trailing `\r` (CRLF).
        let mut content_end = i;
        if content_end > line_start && bytes[content_end - 1] == b'\r' {
            content_end -= 1;
            // A `\r` directly before the CRLF `\r` (i.e. `\r\r\n`) leaves
            // the first `\r` inside the content; it was already reported
            // as bare CR by the scan above.
        }
        // Skip the synthetic empty line after a trailing newline (or the
        // single empty span of an empty file).
        if !(is_end && line_start == bytes.len()) {
            let content = &text[line_start..content_end];
            lines.push(lex_line(
                file,
                content,
                line_start as u32,
                content_end as u32,
                number,
                &mut diagnostics,
            ));
            number += 1;
        }
        line_start = i + 1;
        i += 1;
    }

    Lexed { lines, diagnostics }
}

/// Lex one physical line's content (no line break included).
fn lex_line(
    file: SourceId,
    content: &str,
    start: u32,
    end: u32,
    number: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> PhysLine {
    let bytes = content.as_bytes();
    let mut indent = 0usize;
    let mut i = 0usize;
    // Leading indentation: spaces only. A tab here is E1003.
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        if bytes[i] == b'\t' {
            diagnostics.push(Diagnostic::error(
                "E1003",
                "tab in indentation; use spaces".to_string(),
                Span::new(file, start + i as u32, start + i as u32 + 1),
            ));
        } else {
            indent += 1;
        }
        i += 1;
    }
    let body = &content[i..];
    let body_start = start + i as u32;

    // Blank (or whitespace-only) line: no tokens; gaps cover the bytes.
    if body.is_empty() {
        return PhysLine {
            number,
            start,
            end,
            indent,
            tokens: Vec::new(),
        };
    }

    // `##` before `#`: full-line comment or description prose. Tabs below
    // the marker are prose, never indentation/code.
    if body.starts_with("##") {
        return PhysLine {
            number,
            start,
            end,
            indent,
            tokens: vec![Token::new(TokenKind::Comment, file, body_start, end)],
        };
    }
    if body.starts_with('#') {
        return PhysLine {
            number,
            start,
            end,
            indent,
            tokens: vec![Token::new(TokenKind::Desc, file, body_start, end)],
        };
    }

    // Code line: tokenize.
    let tokens = lex_code_tokens(file, content, i, start, diagnostics);

    PhysLine {
        number,
        start,
        end,
        indent,
        tokens,
    }
}

/// Tokenize code content starting at content-relative `from`.
///
/// Shared by physical lines and description-fragment validation; `#`
/// inside the range is always an error here (prose markers are handled
/// by the caller).
fn lex_code_tokens(
    file: SourceId,
    content: &str,
    from: usize,
    start: u32,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<Token> {
    let bytes = content.as_bytes();
    let mut tokens = Vec::new();
    let mut j = from;
    while j < bytes.len() {
        let c = bytes[j];
        let abs = start + j as u32;
        match c {
            b' ' => {
                j += 1;
            }
            b'\t' => {
                diagnostics.push(Diagnostic::error(
                    "E1003",
                    "tab in code; use spaces (tabs are prose only inside `#`/`##` lines and rejected inside strings)".to_string(),
                    Span::new(file, abs, abs + 1),
                ));
                j += 1;
            }
            b'\r' => {
                // Already reported as E1001 by the line-split prescan;
                // keep the byte covered without a second diagnostic.
                tokens.push(Token::new(TokenKind::Error, file, abs, abs + 1));
                j += 1;
            }
            b'"' => {
                j = lex_string(file, content, start, j, &mut tokens, diagnostics);
            }
            b'\\' => {
                // A backslash immediately before the newline is a rejected
                // line continuation; elsewhere it cannot start any token.
                if j + 1 == bytes.len() {
                    diagnostics.push(Diagnostic::error(
                        "E1004",
                        "backslash line continuation is not supported".to_string(),
                        Span::new(file, abs, abs + 1),
                    ));
                } else {
                    diagnostics.push(Diagnostic::error(
                        "E1007",
                        format!(
                            "unexpected character {}",
                            describe_char(content[j..].chars().next().unwrap_or('\\'))
                        ),
                        Span::new(file, abs, abs + 1),
                    ));
                }
                tokens.push(Token::new(TokenKind::Error, file, abs, abs + 1));
                j += 1;
            }
            b'#' => {
                // Inline hash comments are invalid; `#` only opens a
                // physical description line outside strings.
                diagnostics.push(Diagnostic::error(
                    "E1007",
                    "unexpected `#`; inline hash comments are invalid and `#` prose must start the physical line".to_string(),
                    Span::new(file, abs, abs + 1),
                ));
                tokens.push(Token::new(TokenKind::Error, file, abs, abs + 1));
                j += 1;
            }
            b'0'..=b'9' => {
                j = lex_number(file, content, start, j, &mut tokens, diagnostics);
            }
            b'A'..=b'Z' | b'a'..=b'z' | b'_' => {
                let mut k = j + 1;
                while k < bytes.len() && (bytes[k].is_ascii_alphanumeric() || bytes[k] == b'_') {
                    k += 1;
                }
                tokens.push(Token::new(TokenKind::Name, file, abs, start + k as u32));
                j = k;
            }
            _ => {
                j = lex_punct_or_error(file, content, start, j, &mut tokens, diagnostics);
            }
        }
    }

    tokens
}

/// Lex a code fragment with absolute offsets, for description `#=`/`@{...}`
/// validation. The fragment is tokenized as code on one line: `#` inside
/// is an error, tabs are errors, and diagnostics carry absolute spans.
///
/// Before tokenization, the fragment's UTF-8 byte length must fit in `u32`
/// and `base + length` must not exceed `u32::MAX`. An empty fragment at
/// `u32::MAX` and a fragment ending exactly there are admitted. Otherwise
/// this returns no tokens and appends one `E1008` error at the zero-width
/// span `(file, base, base)`, preserving any earlier caller diagnostics.
pub fn lex_fragment(
    file: SourceId,
    fragment: &str,
    base: u32,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<Token> {
    if u32::try_from(fragment.len())
        .ok()
        .and_then(|length| base.checked_add(length))
        .is_none()
    {
        diagnostics.push(Diagnostic::error(
            "E1008",
            "code fragment extends beyond the u32 source-offset range".to_string(),
            Span::new(file, base, base),
        ));
        return Vec::new();
    }
    lex_code_tokens(file, fragment, 0, base, diagnostics)
}

/// Lex a JSON string starting at the opening quote (content-relative `at`).
/// Returns the content-relative offset one past the token.
fn lex_string(
    file: SourceId,
    content: &str,
    start: u32,
    at: usize,
    tokens: &mut Vec<Token>,
    diagnostics: &mut Vec<Diagnostic>,
) -> usize {
    let bytes = content.as_bytes();
    let abs = start + at as u32;
    let mut j = at + 1;
    let mut escaped = false;
    let mut closed = false;
    while j < bytes.len() {
        let c = bytes[j];
        if escaped {
            escaped = false;
            j += 1;
            continue;
        }
        match c {
            b'\\' => {
                escaped = true;
                j += 1;
            }
            b'"' => {
                closed = true;
                j += 1;
                break;
            }
            _ => {
                j += 1;
            }
        }
    }
    let token_end = start + j as u32;
    let raw = &content[at..j.min(content.len())];
    if !closed {
        diagnostics.push(Diagnostic::error(
            "E1006",
            "unterminated string; strings cannot span physical lines".to_string(),
            Span::new(file, abs, token_end.max(abs + 1)),
        ));
        tokens.push(Token::new(TokenKind::String, file, abs, token_end));
        return j;
    }
    match decode_json_string(raw, abs, file) {
        Ok(value) => {
            let mut token = Token::new(TokenKind::String, file, abs, token_end);
            token.string_value = Some(value);
            tokens.push(token);
        }
        Err((message, err_span)) => {
            diagnostics.push(Diagnostic::error("E1006", message, err_span));
            tokens.push(Token::new(TokenKind::String, file, abs, token_end));
        }
    }
    j
}

/// Lex a numeric literal starting at a digit. Returns the offset past it.
fn lex_number(
    file: SourceId,
    content: &str,
    start: u32,
    at: usize,
    tokens: &mut Vec<Token>,
    diagnostics: &mut Vec<Diagnostic>,
) -> usize {
    let bytes = content.as_bytes();
    let abs = start + at as u32;
    let mut j = at;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    // Decimal fraction only when a digit follows the dot.
    let mut is_decimal = false;
    if j + 1 < bytes.len() && bytes[j] == b'.' && bytes[j + 1].is_ascii_digit() {
        is_decimal = true;
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
    }
    // Maximal letter suffix run.
    let suffix_start = j;
    while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
        j += 1;
    }
    let suffix = &content[suffix_start..j];
    // An identifier character immediately after the run keeps the whole
    // spelling invalid (e.g. `5m2x`): extend to the identifier end.
    let mut k = j;
    while k < bytes.len() && (bytes[k].is_ascii_alphanumeric() || bytes[k] == b'_') {
        k += 1;
    }
    let end = start + k as u32;
    if k != j {
        diagnostics.push(Diagnostic::error(
            "E1005",
            format!(
                "invalid numeric literal `{}`; a unit suffix must be adjacent with no identifier tail",
                &content[at..k]
            ),
            Span::new(file, abs, end),
        ));
        tokens.push(Token::new(TokenKind::Error, file, abs, end));
        return k;
    }
    if suffix.is_empty() {
        tokens.push(Token::new(
            if is_decimal {
                TokenKind::Decimal
            } else {
                TokenKind::Integer
            },
            file,
            abs,
            end,
        ));
        return j;
    }
    if is_decimal {
        diagnostics.push(Diagnostic::error(
            "E1005",
            format!(
                "invalid numeric literal `{}`; units attach to integers, not decimals",
                &content[at..j]
            ),
            Span::new(file, abs, end),
        ));
        tokens.push(Token::new(TokenKind::Error, file, abs, end));
        return j;
    }
    let kind = match suffix {
        "ms" | "s" | "m" | "h" | "d" => Some(TokenKind::Duration),
        "B" | "KiB" | "MiB" | "GiB" => Some(TokenKind::Bytes),
        _ => None,
    };
    match kind {
        Some(kind) => {
            tokens.push(Token::new(kind, file, abs, end));
        }
        None => {
            diagnostics.push(Diagnostic::error(
                "E1005",
                format!(
                    "invalid numeric literal `{}`; unknown unit `{suffix}` (durations: ms/s/m/h/d, bytes: B/KiB/MiB/GiB)",
                    &content[at..j]
                ),
                Span::new(file, abs, end),
            ));
            tokens.push(Token::new(TokenKind::Error, file, abs, end));
        }
    }
    j
}

/// Lex punctuation longest-match or an unexpected character.
fn lex_punct_or_error(
    file: SourceId,
    content: &str,
    start: u32,
    at: usize,
    tokens: &mut Vec<Token>,
    diagnostics: &mut Vec<Diagnostic>,
) -> usize {
    let rest = &content[at..];
    let abs = start + at as u32;
    // Longest match first.
    for (spell, punct) in [
        ("==", Punct::EqEq),
        ("!=", Punct::NotEq),
        ("<=", Punct::LtEq),
        (">=", Punct::GtEq),
        ("??", Punct::QuestionQuestion),
        ("?.", Punct::QuestionDot),
        ("->", Punct::Arrow),
    ] {
        if rest.starts_with(spell) {
            tokens.push(Token::new(
                TokenKind::Punct(punct),
                file,
                abs,
                abs + spell.len() as u32,
            ));
            return at + spell.len();
        }
    }
    let single = match rest.as_bytes()[0] {
        b'(' => Some(Punct::LParen),
        b')' => Some(Punct::RParen),
        b'[' => Some(Punct::LBracket),
        b']' => Some(Punct::RBracket),
        b'{' => Some(Punct::LBrace),
        b'}' => Some(Punct::RBrace),
        b',' => Some(Punct::Comma),
        b'.' => Some(Punct::Dot),
        b':' => Some(Punct::Colon),
        b';' => Some(Punct::Semicolon),
        b'=' => Some(Punct::Eq),
        b'!' => Some(Punct::Bang),
        b'|' => Some(Punct::Pipe),
        b'+' => Some(Punct::Plus),
        b'-' => Some(Punct::Minus),
        b'*' => Some(Punct::Star),
        b'/' => Some(Punct::Slash),
        b'%' => Some(Punct::Percent),
        b'<' => Some(Punct::Lt),
        b'>' => Some(Punct::Gt),
        b'?' => Some(Punct::Question),
        b'@' => Some(Punct::At),
        _ => None,
    };
    match single {
        Some(punct) => {
            tokens.push(Token::new(TokenKind::Punct(punct), file, abs, abs + 1));
            at + 1
        }
        None => {
            let ch = rest.chars().next().unwrap_or('\u{FFFD}');
            let len = ch.len_utf8() as u32;
            diagnostics.push(Diagnostic::error(
                "E1007",
                format!("unexpected character {}", describe_char(ch)),
                Span::new(file, abs, abs + len),
            ));
            tokens.push(Token::new(TokenKind::Error, file, abs, abs + len));
            at + ch.len_utf8()
        }
    }
}

fn describe_char(ch: char) -> String {
    match ch {
        c if c.is_control() => format!("U+{:04X}", c as u32),
        c => format!("{c:?}"),
    }
}

/// Decode a raw JSON string token (including quotes) to its value.
///
/// Rejects unescaped control characters (including tabs), unknown escapes
/// and malformed `\u` escapes including lone surrogates.
/// The token's UTF-8 byte length and absolute endpoint must fit in `u32`.
/// An exact endpoint at `u32::MAX` is valid; an unrepresentable token
/// returns a range error at `(file, abs, abs)` before decoding.
pub fn decode_json_string(raw: &str, abs: u32, file: SourceId) -> Result<String, (String, Span)> {
    if u32::try_from(raw.len())
        .ok()
        .and_then(|length| abs.checked_add(length))
        .is_none()
    {
        return Err((
            "string token extends beyond the u32 source-offset range".to_string(),
            Span::new(file, abs, abs),
        ));
    }
    let bytes = raw.as_bytes();
    debug_assert!(bytes.first() == Some(&b'"') && bytes.last() == Some(&b'"'));
    let mut out = String::new();
    let mut i = 1usize;
    let end = raw.len() - 1;
    let fail = |message: String, at: usize| {
        (
            message,
            Span::new(file, abs + at as u32, abs + at as u32 + 1),
        )
    };
    while i < end {
        let c = bytes[i];
        match c {
            b'"' => {
                // Unreachable: the lexer stops at the closing quote.
                return Err(fail("unescaped quote in string".to_string(), i));
            }
            b'\\' => {
                i += 1;
                if i >= end {
                    return Err(fail("unfinished escape at end of string".to_string(), i));
                }
                match bytes[i] {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        // Byte slicing here must never assume char
                        // boundaries: multibyte UTF-8 after `\u` (e.g.
                        // `"\uaabé"`) would panic. `get` turns every
                        // misshapen escape into an E1006 diagnostic.
                        let digits = match raw.get(i + 1..i + 5) {
                            Some(digits) => digits,
                            None => {
                                return Err(fail(
                                    "malformed \\u escape; expected four hex digits".to_string(),
                                    i,
                                ));
                            }
                        };
                        let code = u32::from_str_radix(digits, 16).map_err(|_| {
                            fail(
                                "malformed \\u escape; expected four hex digits".to_string(),
                                i + 1,
                            )
                        })?;
                        i += 4;
                        if (0xD800..0xDC00).contains(&code) {
                            // High surrogate: require a low surrogate.
                            let low_digits = raw
                                .get(i + 1..)
                                .filter(|rest| rest.starts_with("\\u"))
                                .and_then(|_| raw.get(i + 3..i + 7));
                            if let Some(low_digits) = low_digits
                                && let Ok(low) = u32::from_str_radix(low_digits, 16)
                                && (0xDC00..0xE000).contains(&low)
                            {
                                let scalar = 0x1_0000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                match char::from_u32(scalar) {
                                    Some(ch) => out.push(ch),
                                    None => {
                                        return Err(fail(
                                            "invalid Unicode scalar value".to_string(),
                                            i,
                                        ));
                                    }
                                }
                                i += 7;
                                continue;
                            }
                            return Err(fail(
                                "lone surrogate in \\u escape".to_string(),
                                i.saturating_sub(4),
                            ));
                        }
                        if (0xDC00..0xE000).contains(&code) {
                            return Err(fail(
                                "lone surrogate in \\u escape".to_string(),
                                i.saturating_sub(4),
                            ));
                        }
                        match char::from_u32(code) {
                            Some(ch) => out.push(ch),
                            None => {
                                return Err(fail(
                                    "invalid Unicode scalar value".to_string(),
                                    i.saturating_sub(4),
                                ));
                            }
                        }
                    }
                    other => {
                        return Err(fail(
                            format!("unknown string escape `\\{}`", other as char),
                            i,
                        ));
                    }
                }
                i += 1;
            }
            0x00..=0x1F => {
                if c == b'\t' {
                    return Err(fail("unescaped tab in string; use `\\t`".to_string(), i));
                }
                return Err(fail("unescaped control character in string".to_string(), i));
            }
            _ => {
                // Copy one full UTF-8 scalar (content is valid UTF-8).
                let ch = raw[i..].chars().next().expect("valid UTF-8 slice");
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexed(text: &str) -> Lexed {
        lex(SourceId(0), text)
    }

    #[test]
    fn longest_match_punctuation() {
        let lines = lexed("a==b!=c<=d>=e??f?.g->h\n").lines;
        let kinds: Vec<TokenKind> = lines[0].tokens.iter().map(|t| t.kind).collect();
        use Punct as P;
        use TokenKind as K;
        assert_eq!(
            kinds,
            vec![
                K::Name,
                K::Punct(P::EqEq),
                K::Name,
                K::Punct(P::NotEq),
                K::Name,
                K::Punct(P::LtEq),
                K::Name,
                K::Punct(P::GtEq),
                K::Name,
                K::Punct(P::QuestionQuestion),
                K::Name,
                K::Punct(P::QuestionDot),
                K::Name,
                K::Punct(P::Arrow),
                K::Name,
            ]
        );
    }

    #[test]
    fn numeric_units_and_adjacency() {
        let ok = lexed("5ms 20MiB 1h 0.5 42\n");
        assert!(ok.diagnostics.is_empty());
        let kinds: Vec<TokenKind> = ok.lines[0].tokens.iter().map(|t| t.kind).collect();
        assert_eq!(
            kinds,
            vec![
                TokenKind::Duration,
                TokenKind::Bytes,
                TokenKind::Duration,
                TokenKind::Decimal,
                TokenKind::Integer,
            ]
        );
        for bad in ["5minutes", "1.5h", "5x", "20MiBB", "5m2"] {
            let got = lexed(&format!("x={bad}\n"));
            assert_eq!(got.diagnostics.len(), 1, "{bad}");
            assert_eq!(got.diagnostics[0].code, "E1005");
        }
    }

    #[test]
    fn strings_decode_json_escapes() {
        let got = lexed("x=\"a\\n\\u00E9\\uD83D\\uDE00\"\n");
        assert!(got.diagnostics.is_empty());
        assert_eq!(
            got.lines[0].tokens[2].string_value.as_deref(),
            Some("a\né😀")
        );
        for bad in [
            "\"unterminated",
            "\"bad\\q\"",
            "\"tab\there\"",
            "\"lone\\uD83D\"",
        ] {
            let got = lexed(&format!("x={bad}\n"));
            assert_eq!(got.diagnostics.len(), 1, "{bad}");
            assert_eq!(got.diagnostics[0].code, "E1006");
        }
    }

    #[test]
    fn crlf_ok_bare_cr_rejected() {
        let got = lexed("app A\r\nGiven\r\n");
        assert!(got.diagnostics.is_empty());
        assert_eq!(got.lines.len(), 2);
        let got = lexed("app A\rGiven\n");
        assert_eq!(got.diagnostics.len(), 1);
        assert_eq!(got.diagnostics[0].code, "E1001");
    }

    #[test]
    fn tabs_prose_ok_code_rejected() {
        let got = lexed("# prose\twith tab\n## comment\twith tab\n");
        assert!(got.diagnostics.is_empty());
        let got = lexed("\tThing {value:int}\n");
        assert_eq!(got.diagnostics[0].code, "E1003");
        let got = lexed(" Thing\t{value:int}\n");
        assert_eq!(got.diagnostics[0].code, "E1003");
    }

    #[test]
    fn inline_hash_and_backslash_continuation_rejected() {
        let got = lexed(" Thing {value:int} # trailing\n");
        assert_eq!(got.diagnostics[0].code, "E1007");
        let got = lexed(" Thing {value:int} \\\n");
        assert_eq!(got.diagnostics[0].code, "E1004");
    }
}
