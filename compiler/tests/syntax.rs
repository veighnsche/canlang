//! Integration tests for slice 1 (SYNTAX): lexer, layout, lossless CST,
//! recoverable parser, `E1xxx` diagnostics and the golden `.can` corpus.

use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceId, Span};
use canlang_compiler::syntax::{
    LayoutResult, Punct, SyntaxKind, SyntaxNode, Token, TokenKind, decode_json_string, layout, lex,
    lex_bytes, lex_fragment, parse_source,
};
use std::path::PathBuf;

fn file() -> SourceId {
    SourceId(0)
}

fn parse_text(text: &str) -> (SyntaxNode, Vec<Diagnostic>) {
    parse_source(file(), text)
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

/// Assert a clean parse with full byte coverage; return the tree.
fn assert_clean(text: &str) -> SyntaxNode {
    let (tree, diags) = parse_text(text);
    assert!(
        diags.is_empty(),
        "expected clean parse, got {diags:?}\n{text}"
    );
    assert!(tree.verify_coverage(text.len() as u32).is_ok());
    tree
}

/// Assert the exact diagnostic code sequence (already sorted by offset).
fn assert_codes(text: &str, expected: &[&str]) -> (SyntaxNode, Vec<Diagnostic>) {
    let (tree, diags) = parse_text(text);
    assert_eq!(codes(&diags), expected, "codes for {text:?}\n{diags:?}");
    assert!(tree.verify_coverage(text.len() as u32).is_ok());
    (tree, diags)
}

fn has_kind(node: &SyntaxNode, kind: SyntaxKind) -> bool {
    node.descendants().any(|n| n.kind == kind)
}

fn count_kind(node: &SyntaxNode, kind: SyntaxKind) -> usize {
    node.descendants().filter(|n| n.kind == kind).count()
}

fn collect_can(dir: &str, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read corpus dir {dir}: {e}"))
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_can(path.to_str().unwrap(), out);
        } else if path.extension().is_some_and(|e| e == "can") {
            out.push(path);
        }
    }
}

/// Known draft-owner syntax defects, pinned exactly: (path suffix, codes).
///
/// Keep this table empty while all shipped files parse clean. Declared
/// cohort syntax is accepted; complete application/runtime qualification
/// remains separate from parsing.
const KNOWN_CORPUS_DEFECTS: &[(&str, &[&str])] = &[];

/// Golden corpus: every shipped `.can` file parses clean with full
/// coverage, except [`KNOWN_CORPUS_DEFECTS`] which must match exactly.
/// Prints a per-file table (`--nocapture` to view).
#[test]
fn golden_corpus_parses_clean() {
    let mut files = Vec::new();
    collect_can("../examples", &mut files);
    // `../draft` recurses, so `../draft/shared/*.can` is covered too. No
    // file count is pinned: the corpus grows across rebases.
    collect_can("../draft", &mut files);
    files.sort();
    files.dedup();
    assert!(!files.is_empty(), "corpus must not be empty");
    assert!(
        files.iter().any(|p| p.ends_with("TeamTasks.can")),
        "examples/TeamTasks.can missing from {files:?}"
    );
    assert!(
        files.iter().any(|p| p.ends_with("ExpenseFlow.can")),
        "examples/ExpenseFlow.can missing from {files:?}"
    );
    let mut rows = vec![format!("{:>52} {:>7}  {}", "file", "bytes", "result")];
    let mut failures = 0usize;
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let (tree, diags) = parse_source(SourceId(0), &text);
        let covered = tree.verify_coverage(text.len() as u32).is_ok();
        let rel = path.to_str().unwrap().to_string();
        let known = KNOWN_CORPUS_DEFECTS
            .iter()
            .find(|(suffix, _)| rel.ends_with(suffix));
        match (known, diags.is_empty() && covered) {
            (None, true) => rows.push(format!("{rel:>52} {:>7}  ok", text.len())),
            (Some((_, expected)), _) if codes(&diags).as_slice() == *expected && covered => {
                rows.push(format!(
                    "{rel:>52} {:>7}  known-defect codes={:?}",
                    text.len(),
                    codes(&diags)
                ));
            }
            (Some((suffix, _)), _) => {
                failures += 1;
                rows.push(format!(
                    "{rel:>52} {:>7}  DEFECT-CHANGED codes={:?} covered={covered} (update {suffix} entry or fix drafts)",
                    text.len(),
                    codes(&diags)
                ));
            }
            (None, false) => {
                failures += 1;
                rows.push(format!(
                    "{rel:>52} {:>7}  FAIL codes={:?} covered={covered}",
                    text.len(),
                    codes(&diags)
                ));
            }
        }
    }
    let table = rows.join("\n");
    println!("{table}");
    assert_eq!(failures, 0, "corpus failures:\n{table}");
}

// --- Lexer --------------------------------------------------------------

/// First-line tokens plus diagnostics for a one-line fragment.
fn lex_first(text: &str) -> (Vec<Token>, Vec<Diagnostic>) {
    let lexed = lex(file(), text);
    (lexed.lines[0].tokens.clone(), lexed.diagnostics)
}

fn kinds(tokens: &[Token]) -> Vec<TokenKind> {
    tokens.iter().map(|t| t.kind).collect()
}

#[test]
fn longest_match_punctuation() {
    let (tokens, diags) = lex_first("a == b != c <= d >= e ?? f ?. g -> h");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        kinds(&tokens),
        vec![
            TokenKind::Name,
            TokenKind::Punct(Punct::EqEq),
            TokenKind::Name,
            TokenKind::Punct(Punct::NotEq),
            TokenKind::Name,
            TokenKind::Punct(Punct::LtEq),
            TokenKind::Name,
            TokenKind::Punct(Punct::GtEq),
            TokenKind::Name,
            TokenKind::Punct(Punct::QuestionQuestion),
            TokenKind::Name,
            TokenKind::Punct(Punct::QuestionDot),
            TokenKind::Name,
            TokenKind::Punct(Punct::Arrow),
            TokenKind::Name,
        ]
    );
    assert_eq!(tokens[1].text("a == b"), "==");
    assert_eq!(tokens[1].span.start, 2);
    assert_eq!(tokens[1].span.end, 4);
}

#[test]
fn single_char_punctuation() {
    let (tokens, diags) = lex_first("= ! | + - * / % < > ? ( ) [ ] { } , . : ;");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        kinds(&tokens),
        vec![
            TokenKind::Punct(Punct::Eq),
            TokenKind::Punct(Punct::Bang),
            TokenKind::Punct(Punct::Pipe),
            TokenKind::Punct(Punct::Plus),
            TokenKind::Punct(Punct::Minus),
            TokenKind::Punct(Punct::Star),
            TokenKind::Punct(Punct::Slash),
            TokenKind::Punct(Punct::Percent),
            TokenKind::Punct(Punct::Lt),
            TokenKind::Punct(Punct::Gt),
            TokenKind::Punct(Punct::Question),
            TokenKind::Punct(Punct::LParen),
            TokenKind::Punct(Punct::RParen),
            TokenKind::Punct(Punct::LBracket),
            TokenKind::Punct(Punct::RBracket),
            TokenKind::Punct(Punct::LBrace),
            TokenKind::Punct(Punct::RBrace),
            TokenKind::Punct(Punct::Comma),
            TokenKind::Punct(Punct::Dot),
            TokenKind::Punct(Punct::Colon),
            TokenKind::Punct(Punct::Semicolon),
        ]
    );
}

#[test]
fn numeric_kinds() {
    let (tokens, diags) = lex_first("1 1.5 5m 90d 1h 30s 100ms 8B 20MiB 2KiB 3GiB");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        kinds(&tokens),
        vec![
            TokenKind::Integer,
            TokenKind::Decimal,
            TokenKind::Duration,
            TokenKind::Duration,
            TokenKind::Duration,
            TokenKind::Duration,
            TokenKind::Duration,
            TokenKind::Bytes,
            TokenKind::Bytes,
            TokenKind::Bytes,
            TokenKind::Bytes,
        ]
    );
}

#[test]
fn invalid_numeric_units() {
    // (text, expected literal span); each yields one E1005 + Error token.
    for (text, start, end) in [
        ("5minutes", 0, 8),
        ("90days", 0, 6),
        ("5m2x", 0, 4),
        ("2.5GB", 0, 5),
        ("12parsecs", 0, 9),
    ] {
        let (tokens, diags) = lex_first(text);
        assert_eq!(codes(&diags), vec!["E1005"], "{text:?}: {diags:?}");
        assert_eq!(tokens.len(), 1, "{text:?}: {tokens:?}");
        assert_eq!(tokens[0].kind, TokenKind::Error);
        assert_eq!(diags[0].primary.start, start, "{text:?}");
        assert_eq!(diags[0].primary.end, end, "{text:?}");
    }
}

#[test]
fn standalone_string_decoder_checks_absolute_source_range() {
    assert_eq!(
        decode_json_string(r#""\q""#, u32::MAX, file()),
        Err((
            "string token extends beyond the u32 source-offset range".into(),
            Span::new(file(), u32::MAX, u32::MAX),
        )),
    );
    for raw in [
        r#""\q""#,
        r#""plain""#,
        "\"😀\"",
        r#""\uD800""#,
        r#""\uaabé""#,
        "\"a\tb\"",
    ] {
        let length = u32::try_from(raw.len()).unwrap();
        let base = u32::MAX - length;
        let expected = decode_json_string(raw, 0, file()).map_err(|(message, span)| {
            (
                message,
                Span::new(file(), base + span.start, base + span.end),
            )
        });
        assert_eq!(decode_json_string(raw, base, file()), expected, "{raw:?}");
        let rejected_base = base + 1;
        assert_eq!(
            decode_json_string(raw, rejected_base, file()),
            Err((
                "string token extends beyond the u32 source-offset range".into(),
                Span::new(file(), rejected_base, rejected_base),
            )),
            "{raw:?} must refuse before decoding",
        );
    }
    assert_eq!(
        decode_json_string(r#""""#, u32::MAX - 2, file()).unwrap(),
        "",
    );
    assert!(decode_json_string(r#""\q""#, u32::MAX, file()).is_err());
}

#[test]
fn json_strings_decode() {
    assert_eq!(decode_json_string("\"plain\"", 0, file()).unwrap(), "plain");
    assert_eq!(decode_json_string("\"\\u0041\"", 0, file()).unwrap(), "A");
    assert_eq!(
        decode_json_string("\"\\uD83D\\uDE00\"", 0, file()).unwrap(),
        "\u{1F600}"
    );
    assert_eq!(
        decode_json_string("\"a\\n\\t\\\\\\\"\\/\\b\\f\\r\"", 0, file()).unwrap(),
        "a\n\t\\\"/\u{8}\u{c}\r"
    );
    // Invalid escapes and lone surrogates fail with a span.
    for raw in ["\"\\q\"", "\"\\uD83D\"", "\"\\uDE00\"", "\"\\u12\""] {
        let Err((_, span)) = decode_json_string(raw, 10, file()) else {
            panic!("{raw:?} should not decode");
        };
        assert!(span.start >= 10, "{raw:?}: {span:?}");
    }
    // Lexed strings carry their decoded value.
    let (tokens, diags) = lex_first("\"hi\"");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(tokens[0].kind, TokenKind::String);
    assert_eq!(tokens[0].string_value.as_deref(), Some("hi"));
}

#[test]
fn strings_cannot_span_lines() {
    let (tokens, diags) = lex_first("\"abc");
    assert_eq!(codes(&diags), vec!["E1006"]);
    assert_eq!(tokens[0].kind, TokenKind::String);
    assert_eq!(tokens[0].string_value, None);
}

#[test]
fn desc_and_comment_markers() {
    let (tokens, diags) = lex_first("# hello");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(kinds(&tokens), vec![TokenKind::Desc]);
    let (tokens, diags) = lex_first("## note");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(kinds(&tokens), vec![TokenKind::Comment]);
    // An inline `#` is not a marker.
    let (tokens, diags) = lex_first("a # b");
    assert_eq!(codes(&diags), vec!["E1007"]);
    assert_eq!(
        kinds(&tokens),
        vec![TokenKind::Name, TokenKind::Error, TokenKind::Name]
    );
}

#[test]
fn at_suffix_and_route_slashes() {
    let (tokens, diags) = lex_first("@{en}");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        kinds(&tokens),
        vec![
            TokenKind::Punct(Punct::At),
            TokenKind::Punct(Punct::LBrace),
            TokenKind::Name,
            TokenKind::Punct(Punct::RBrace),
        ]
    );
    let (tokens, diags) = lex_first("/items/{id}");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        kinds(&tokens),
        vec![
            TokenKind::Punct(Punct::Slash),
            TokenKind::Name,
            TokenKind::Punct(Punct::Slash),
            TokenKind::Punct(Punct::LBrace),
            TokenKind::Name,
            TokenKind::Punct(Punct::RBrace),
        ]
    );
}

#[test]
fn lexer_error_codes_and_spans() {
    // Bare carriage return.
    let (_, diags) = lex_first("a\rb");
    assert_eq!(codes(&diags), vec!["E1001"]);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (1, 2));
    // Tab in code.
    let (_, diags) = lex_first("a\tb");
    assert_eq!(codes(&diags), vec!["E1003"]);
    assert_eq!((diags[0].primary.start, diags[0].primary.end), (1, 2));
    // Backslash continuation.
    let lexed = lex(file(), "ab\\\ncd");
    assert_eq!(codes(&lexed.diagnostics), vec!["E1004"]);
    assert_eq!(
        (
            lexed.diagnostics[0].primary.start,
            lexed.diagnostics[0].primary.end
        ),
        (2, 3)
    );
    assert_eq!(lexed.lines.len(), 2);
    // Unexpected character stays in the tree as an Error token.
    let (tokens, diags) = lex_first("$");
    assert_eq!(codes(&diags), vec!["E1007"]);
    assert_eq!(tokens[0].kind, TokenKind::Error);
    // Invalid UTF-8 is rejected by the bytes entry point.
    let err = lex_bytes(file(), b"app \xff\n").unwrap_err();
    assert_eq!(err.code, "E1002");
    assert_eq!((err.primary.start, err.primary.end), (4, 5));
}

#[test]
fn lex_fragment_offsets() {
    let mut diags = Vec::new();
    let tokens = lex_fragment(file(), "a + b", 100, &mut diags);
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(
        tokens
            .iter()
            .map(|t| (t.span.start, t.span.end))
            .collect::<Vec<_>>(),
        vec![(100, 101), (102, 103), (104, 105)]
    );
}

#[test]
fn public_lex_fragment_admits_fitting_byte_ranges() {
    use canlang_compiler::source::Span;

    let source = SourceId(37);
    for (fragment, base, expected) in [
        ("", 0, vec![]),
        ("", u32::MAX, vec![]),
        ("a", u32::MAX - 1, vec![(u32::MAX - 1, u32::MAX)]),
        (
            "a + b",
            u32::MAX - 5,
            vec![
                (u32::MAX - 5, u32::MAX - 4),
                (u32::MAX - 3, u32::MAX - 2),
                (u32::MAX - 1, u32::MAX),
            ],
        ),
        ("\"é\"", u32::MAX - 4, vec![(u32::MAX - 4, u32::MAX)]),
        ("a", 42, vec![(42, 43)]),
    ] {
        let mut diagnostics = Vec::new();
        let tokens =
            canlang_compiler::syntax::lex_fragment(source, fragment, base, &mut diagnostics);
        assert!(diagnostics.is_empty(), "{fragment:?}: {diagnostics:?}");
        assert_eq!(
            tokens.iter().map(|token| token.span).collect::<Vec<_>>(),
            expected
                .into_iter()
                .map(|(start, end)| Span::new(source, start, end))
                .collect::<Vec<_>>(),
            "{fragment:?} at {base}",
        );
    }
}

#[test]
fn public_lex_fragment_refuses_the_whole_range_before_lexing() {
    use canlang_compiler::diagnostic::{Related, Severity};
    use canlang_compiler::source::Span;

    let source = SourceId(37);
    for (fragment, base) in [
        ("a", u32::MAX),
        ("a + b", u32::MAX - 4),
        ("\"é\"", u32::MAX - 3),
        ("a $", u32::MAX - 2),
        ("\t#", u32::MAX - 1),
        ("  ", u32::MAX - 1),
    ] {
        let mut prior = Diagnostic::error(
            "E1007",
            "earlier caller diagnostic".to_string(),
            Span::new(SourceId(9), 3, 4),
        );
        prior.related.push(Related {
            span: Span::new(SourceId(8), 1, 2),
            message: "earlier related span".to_string(),
        });
        prior.tags.push("earlier-tag".to_string());
        let prior_snapshot = format!("{prior:?}");
        let mut diagnostics = vec![prior];
        let tokens =
            canlang_compiler::syntax::lex_fragment(source, fragment, base, &mut diagnostics);
        assert!(tokens.is_empty(), "{fragment:?} at {base}: {tokens:?}");
        assert_eq!(diagnostics.len(), 2, "{fragment:?}: {diagnostics:?}");
        assert_eq!(format!("{:?}", diagnostics[0]), prior_snapshot);
        let refusal = &diagnostics[1];
        assert_eq!(refusal.code, "E1008");
        assert_eq!(refusal.severity, Severity::Error);
        assert_eq!(
            refusal.message,
            "code fragment extends beyond the u32 source-offset range",
        );
        assert_eq!(refusal.primary, Span::new(source, base, base));
        assert!(refusal.related.is_empty());
        assert!(refusal.tags.is_empty());
    }
}

#[test]
fn public_lex_fragment_keeps_fitting_lexical_errors() {
    use canlang_compiler::source::Span;

    let source = SourceId(37);
    for fragment in ["\t", "#", "$", "\"", "5minutes"] {
        let base = u32::MAX - u32::try_from(fragment.len()).unwrap();
        let mut diagnostics = Vec::new();
        let tokens =
            canlang_compiler::syntax::lex_fragment(source, fragment, base, &mut diagnostics);
        let expected_code = match fragment {
            "\t" => "E1003",
            "\"" => "E1006",
            "5minutes" => "E1005",
            _ => "E1007",
        };
        assert_eq!(codes(&diagnostics), vec![expected_code]);
        assert_eq!(diagnostics[0].primary, Span::new(source, base, u32::MAX));
        if fragment == "\t" {
            assert!(tokens.is_empty());
            continue;
        }
        assert_eq!(tokens.len(), 1);
        assert_eq!(
            tokens[0].kind,
            if fragment == "\"" {
                TokenKind::String
            } else {
                TokenKind::Error
            },
        );
        assert_eq!(tokens[0].span, Span::new(source, base, u32::MAX));
    }
}

// --- Layout -------------------------------------------------------------

fn lay_out(text: &str) -> LayoutResult {
    let lexed = lex(file(), text);
    layout(file(), text, lexed.lines)
}

#[test]
fn brackets_join_physical_lines() {
    let laid = lay_out("a: [\n b,\n c\n]\n");
    assert!(laid.diagnostics.is_empty(), "{:?}", laid.diagnostics);
    assert_eq!(laid.roots.len(), 1);
    assert_eq!(
        kinds(&laid.roots[0].tokens),
        vec![
            TokenKind::Name,
            TokenKind::Punct(Punct::Colon),
            TokenKind::Punct(Punct::LBracket),
            TokenKind::Name,
            TokenKind::Punct(Punct::Comma),
            TokenKind::Name,
            TokenKind::Punct(Punct::RBracket),
        ]
    );
    assert_eq!(laid.roots[0].first_line, 1);
}

#[test]
fn unbalanced_delimiters() {
    let laid = lay_out("a: [\n b\n");
    assert_eq!(codes(&laid.diagnostics), vec!["E1102"]);
    let laid = lay_out("a: ]\n");
    assert_eq!(codes(&laid.diagnostics), vec!["E1101"]);
    let laid = lay_out("a: (b]\n");
    assert_eq!(codes(&laid.diagnostics), vec!["E1101"]);
}

#[test]
fn one_space_indent_nests() {
    let laid = lay_out("app T\n Given:\n  model M:\n");
    assert!(laid.diagnostics.is_empty(), "{:?}", laid.diagnostics);
    assert_eq!(laid.roots.len(), 1);
    assert_eq!(laid.roots[0].indent, 0);
    assert_eq!(laid.roots[0].children.len(), 1);
    assert_eq!(laid.roots[0].children[0].indent, 1);
    assert_eq!(laid.roots[0].children[0].children.len(), 1);
    assert_eq!(laid.roots[0].children[0].children[0].indent, 2);
}

#[test]
fn bad_indentation() {
    let laid = lay_out("app T\n  Given:\n");
    assert_eq!(codes(&laid.diagnostics), vec!["E1103"]);
    assert_eq!(diags_span(&laid.diagnostics[0]), (8, 13));
}

fn diags_span(diag: &Diagnostic) -> (u32, u32) {
    (diag.primary.start, diag.primary.end)
}

#[test]
fn blank_and_comment_lines_emit_nothing() {
    let laid = lay_out("app T\n\n## note\n\n Given:\n");
    assert!(laid.diagnostics.is_empty(), "{:?}", laid.diagnostics);
    assert_eq!(laid.roots.len(), 1);
    assert_eq!(laid.roots[0].children.len(), 1);
    assert_eq!(laid.comments.len(), 1);
    assert_eq!(laid.comments[0].kind, TokenKind::Comment);
}

#[test]
fn description_attaches_at_same_column() {
    let laid = lay_out("app T\n# About tasks.\nrole admin label=\"Admin\"\n");
    assert!(laid.diagnostics.is_empty(), "{:?}", laid.diagnostics);
    assert_eq!(laid.roots.len(), 2);
    assert!(laid.roots[0].description.is_none());
    let attached = laid.roots[1].description.as_ref().unwrap();
    assert_eq!(attached.tokens.len(), 1);
    assert_eq!(attached.tokens[0].kind, TokenKind::Desc);
}

#[test]
fn description_reference_and_suffix_attach() {
    let tree = assert_clean(
        "# About tasks. @{en=\"Tasks\"}\napp T\nGiven\nWhen\nThen\n#= docs.tasks\napp U\nGiven\nWhen\nThen\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::Description), 2);
}

#[test]
fn description_codes() {
    // Column mismatch: the second set line sits at column 2, owner at 1.
    assert_codes(
        "# line one.\n # line two.\napp T\nGiven\nWhen\nThen\n",
        &["E1120"],
    );
    // Prose/reference mixing in one set.
    assert_codes(
        "# prose.\n#= docs.x\napp T\nGiven\nWhen\nThen\n",
        &["E1121"],
    );
    // Invalid `#=` reference.
    assert_codes("#= 123\napp T\nGiven\nWhen\nThen\n", &["E1122"]);
    // A suffix on a `#=` line is extra tokens after the path.
    assert_codes(
        "#= docs.x @{en=\"x\"}\napp T\nGiven\nWhen\nThen\n",
        &["E1122"],
    );
    // Trailing description with no owner dangles.
    let (_, diags) = assert_codes("app T\nGiven\nWhen\nThen\n# trailing.\n", &["E1125"]);
    assert_eq!(diags_span(&diags[0]), (22, 33));
    // Section markers are ineligible owners.
    assert_codes("app T\n# on a marker.\nGiven\nWhen\nThen\n", &["E1126"]);
    // Descriptions cannot annotate `do` blocks either.
    assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  # on a block\n  do\n   return 1\nThen\n",
        &["E1126"],
    );
}

#[test]
fn misplaced_and_invalid_suffix() {
    // A suffix anywhere but the final prose line is misplaced.
    assert_codes(
        "# A @{nl=\"x\"}\n# B\napp Test\nGiven\nWhen\nThen\n",
        &["E1123"],
    );
    // A locale key without `=value` is an invalid suffix.
    assert_codes("# A @{nl}\napp Test\nGiven\nWhen\nThen\n", &["E1124"]);
}

// --- Parser: valid productions ------------------------------------------

#[test]
fn file_structure() {
    let tree = assert_clean(
        "package p label=\"P\"\n use std {Mail} from=deployment.mail\n Given\n  role admin label=\"Admin\"\n When\n Then\nmigration V2 from=\"v1\"\napp Office uses=[P]\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Package));
    assert!(has_kind(&tree, SyntaxKind::Import));
    assert!(has_kind(&tree, SyntaxKind::ImportMember));
    assert!(has_kind(&tree, SyntaxKind::Migration));
    assert_eq!(count_kind(&tree, SyntaxKind::App), 1);

    let tree = assert_clean(
        "app T source=\"en\" label=\"T\"\ncontext\n cache KV ttl=5m\n theme mode=dark\n locale default=\"en\"\nuse U {m}\nGiven\nWhen\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Context));
    assert!(has_kind(&tree, SyntaxKind::ContextDecl));
    assert!(has_kind(&tree, SyntaxKind::Import));
}

#[test]
fn given_declarations() {
    let tree = assert_clean(
        "app T\nGiven\n preferences { view:enum(all,finished)=all label=\"View\" }\n Todo { title:text trim max=200 label=\"Title\", done:bool=false } label=\"Task\"\n contract Origin { resolution:text } label=\"Origin\"\n event changed { value:int }\n role admin label=\"Admin\"\n derive Todo.slug:text = \"s\"\n derive total(x:int):int = x\n policy Todo read=members where=true\n invariant Todo: row.title != \"\"\n unique Todo fields=title\n lock Todo fields=title when=true\n retain Todo until=now+90d\n fixture task=Todo {title=\"Ship\"}\n export capability Mail version=1\n  send(to:text) -> bool\n message done = \"Done\"@{}\n message count(n:int) = \"{n} tasks\"@{}\nWhen\nThen\n",
    );
    for kind in [
        SyntaxKind::Preferences,
        SyntaxKind::Model,
        SyntaxKind::Contract,
        SyntaxKind::Event,
        SyntaxKind::Role,
        SyntaxKind::Derive,
        SyntaxKind::Policy,
        SyntaxKind::Invariant,
        SyntaxKind::Unique,
        SyntaxKind::Lock,
        SyntaxKind::Retain,
        SyntaxKind::Fixture,
        SyntaxKind::Capability,
        SyntaxKind::CapabilityOp,
        SyntaxKind::Message,
        SyntaxKind::Field,
        SyntaxKind::Parameter,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
}

#[test]
fn types_and_labels() {
    let tree = assert_clean(
        "app T\nGiven\n M { a:int label={text=\"A\"}, b:text?, c:int[], d:A|B, e:enum(x,y), f:action(go), g:delivery(Op), h:text[]!, i:A|B[]? } label=\"M\"\n message m = \"Hi\"@{nl=\"Hoi\"}\n message n = \"X\"@{}\nWhen\n crud M by=members fields=a label={create=add}\nThen\n page / title=\"T\"@{nl=\"T\"}\n",
    );
    for kind in [
        SyntaxKind::NamedType,
        SyntaxKind::NullableType,
        SyntaxKind::ArrayType,
        SyntaxKind::UnionType,
        SyntaxKind::EnumType,
        SyntaxKind::ActionType,
        SyntaxKind::DeliveryType,
        SyntaxKind::Label,
        SyntaxKind::CrudLabels,
        SyntaxKind::MessageValue,
        SyntaxKind::MessageVariant,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
    // Structured derived-field label with case values.
    let tree = assert_clean(
        "app T\nGiven\n M { done:bool=false label={text=\"Done\",values={true=\"Yes\",false=\"No\"}} }\nWhen\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::LabelCase));
}

#[test]
fn when_execution() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario close(id:int) by=members label=\"Close\"\n  require id > 0 message=\"Positive\"\n  do\n   let x = 1\n   create Todo {title=\"t\"} as todo\n   set todo {title=\"x\"}\n   delete todo\n   call close {id=1} as result\n   emit changed {value=1}\n   send Op.result {x} as delivery\n   schedule \"k\" at=now+5m event=Check {todo}\n   cancel \"k\"\n   require x > 0\n   if x > 0\n    let y = 2\n   else\n    let y = 3\n   for item in Todo limit=10\n    let z = 4\n   return todo\n  examples id=1 seed=[task]\n   as,id -> result\n   members,1 -> \"ok\"\n   members,0 -> error(conflict)\nThen\n",
    );
    for kind in [
        SyntaxKind::Scenario,
        SyntaxKind::Require,
        SyntaxKind::DoBlock,
        SyntaxKind::Let,
        SyntaxKind::Create,
        SyntaxKind::Set,
        SyntaxKind::Delete,
        SyntaxKind::Call,
        SyntaxKind::Emit,
        SyntaxKind::Send,
        SyntaxKind::Schedule,
        SyntaxKind::Cancel,
        SyntaxKind::If,
        SyntaxKind::For,
        SyntaxKind::Return,
        SyntaxKind::Examples,
        SyntaxKind::ExampleRow,
        SyntaxKind::ExpectedError,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
}

#[test]
fn crud_and_examples() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title,-done expose=create,update create=none label={create=add}\n  examples update record=task\n   as,changes.done -> record.done\n   members,true -> true\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Crud));
    assert!(has_kind(&tree, SyntaxKind::Selectors));
    assert!(has_kind(&tree, SyntaxKind::Descending));
}

#[test]
fn examples_sequence() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario go(id:int) by=members\n  do\n   return id\n  examples seed=[task]\n   do\n    call go {id=1} by=self as first\n    call go {id=2} by=self request={id=2} -> error(not_found)\n    first -> 1\nThen\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::ExampleCall), 2);
    assert!(has_kind(&tree, SyntaxKind::ExampleAssert));
    assert!(has_kind(&tree, SyntaxKind::ExpectedError));
}

#[test]
fn presentation() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /tasks title=\"Tasks\"\n  card \"Add\" layout=stack\n   form Todo.create fields=title display=inline\n  card \"List\"\n   list Todo as task order=-created search=title filter=done empty=\"None\"\n    edit fields=title\n    delete\n    details \"D\" open=flag\n     text row.title\n   tabs preferences.view\n   tabs\n    tab \"A\"\n     text \"x\"\n",
    );
    for kind in [
        SyntaxKind::Page,
        SyntaxKind::Route,
        SyntaxKind::RouteStatic,
        SyntaxKind::Card,
        SyntaxKind::Form,
        SyntaxKind::Collection,
        SyntaxKind::Edit,
        SyntaxKind::Details,
        SyntaxKind::UiLeaf,
        SyntaxKind::Tabs,
        SyntaxKind::Tab,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
    // Record and scalar route segments, poll/refresh, preference ordering.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /items/{Todo.id} title=\"Item\" data=getTodo poll=30s refresh=close\n page /s/{name:text} title=\"S\" order=1 nav=none group=\"G\"\n  list Todo order={by=preferences.view,default=[-created],cases={all=[title]}} display=split\n",
    );
    assert!(has_kind(&tree, SyntaxKind::RouteRecord));
    assert!(has_kind(&tree, SyntaxKind::RouteScalar));
    assert!(has_kind(&tree, SyntaxKind::PreferenceOrder));
    assert!(has_kind(&tree, SyntaxKind::OrderList));
    assert!(has_kind(&tree, SyntaxKind::OrderCases));
    assert!(has_kind(&tree, SyntaxKind::OrderCase));
}

#[test]
fn expressions_and_queries() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario q() by=members\n  require (1 + 2 * 3 == 7) and not done or x == null\n  require -count(Todo as t where t.done order=-created select t) >= 0\n  require user.name?.first == \"a\" and (x ?? y) != null\n  do\n   return {a=1, b=[true, 1.5, 5m, 8B, \"s\"]}\nThen\n",
    );
    for kind in [
        SyntaxKind::Binary,
        SyntaxKind::Unary,
        SyntaxKind::Group,
        SyntaxKind::Member,
        SyntaxKind::Literal,
        SyntaxKind::Array,
        SyntaxKind::Object,
        SyntaxKind::ObjectEntry,
        SyntaxKind::Query,
        SyntaxKind::QueryClause,
        SyntaxKind::Argument,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
    // Typed construction and archive scoping.
    let built = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario c() by=members\n  require Todo {title=\"t\"} != null\n  require count(Todo archived=include) > 0\n  do\n   return 1\nThen\n",
    );
    assert!(has_kind(&built, SyntaxKind::Construct));
}

#[test]
fn migration_directives() {
    let tree = assert_clean(
        "migration V2 from=\"v1\"\n rename before.Todo to Todo\n drop before.Old\n invalidate before.handler\n rename owner\n drop owner\n backfill Todo\n  require row.title != \"\"\n  do\n   set row {title=\"x\"}\n",
    );
    for kind in [
        SyntaxKind::Rename,
        SyntaxKind::Drop,
        SyntaxKind::Invalidate,
        SyntaxKind::Backfill,
    ] {
        assert!(has_kind(&tree, kind), "missing {kind:?}");
    }
    // A header-only migration acknowledges a constraint-only transition.
    assert_clean("migration V3 from=\"v2\"\n");
}

#[test]
fn semicolon_leaves() {
    // Same-category leaves share one logical line.
    assert_clean(
        "app T\nGiven\n role a label=\"A\"; role b label=\"B\"\n message x = \"X\"@{}; message y = \"Y\"@{}\nWhen\nThen\n",
    );
    assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario s() by=members\n  do\n   let a = 1; let b = 2\nThen\n",
    );
}

// --- Parser: errors, recovery, CST ----------------------------------------

#[test]
fn parser_error_codes_and_spans() {
    // (source, code, span start, span end); each keeps full byte coverage
    // and wraps the bad declaration in an `Error` node.
    let cases: &[(&str, &str, u32, u32)] = &[
        ("app T\nGiven\n policy\nWhen\nThen\n", "E1200", 19, 19),
        (
            "app T\nGiven\n Todo { title }\nWhen\nThen\n",
            "E1200",
            26,
            27,
        ),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n frobnicate Todo\nThen\n",
            "E1200",
            39,
            49,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   for x in Todo\n    return 1\nThen\n",
            "E1200",
            63,
            63,
        ),
        (
            "app T\nGiven\n Todo { title:text max=1 max=2 }\nWhen\nThen\n",
            "E1202",
            37,
            40,
        ),
        (
            "app T\nGiven\n M { a:int label={text=\"a\",text=\"b\"} }\nWhen\nThen\n",
            "E1202",
            39,
            43,
        ),
        (
            "app T\nGiven\n Todo { title:text foo=1 }\nWhen\nThen\n",
            "E1203",
            31,
            34,
        ),
        (
            "app T\nGiven\n role admin label=\"A\" extra\nWhen\nThen\n",
            "E1203",
            34,
            39,
        ),
        ("app T extra\nGiven\nWhen\nThen\n", "E1203", 6, 11),
        (
            "app T\nGiven\n message m = \"Hi\"@{} extra\nWhen\nThen\n",
            "E1201",
            33,
            38,
        ),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members\nThen\n",
            "E1204",
            59,
            59,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   if x\n   return 1\nThen\n",
            "E1204",
            50,
            52,
        ),
        (
            "app T\nGiven\n role a label=\"A\";; role b label=\"B\"\nWhen\nThen\n",
            "E1205",
            30,
            31,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  require count(Todo order=x where y) > 0\n  do\n   return 1\nThen\n",
            "E1206",
            71,
            76,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 < 2 < 3\n  do\n   return 1\nThen\n",
            "E1207",
            58,
            59,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  require a ?? b or c\n  do\n   return 1\nThen\n",
            "E1208",
            54,
            56,
        ),
        (
            "app T\nGiven\nWhen\nThen\n page /x/{id} title=\"T\"\n",
            "E1209",
            31,
            35,
        ),
        (
            "app T\nGiven\nWhen\nThen\n page /x//y title=\"T\"\n",
            "E1209",
            31,
            32,
        ),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n  examples update record=task\n   as,changes.done -> record.done\n   members -> true\nThen\n",
            "E1210",
            140,
            147,
        ),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n  examples update record=task\n   as -> record.done\nThen\n",
            "E1210",
            106,
            108,
        ),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n crud Todo by=members fields=title\n  examples update record=task\n   do\n    call update {x} by=self\nThen\n",
            "E1210",
            75,
            83,
        ),
        ("hello\napp T\nGiven\nWhen\nThen\n", "E1211", 0, 5),
        (
            "app T\nGiven\n Todo { title:text }\nWhen\n export crud Todo by=members fields=title\nThen\n",
            "E1212",
            39,
            45,
        ),
        (
            "app T\nGiven\n export policy Todo read=members\nWhen\nThen\n",
            "E1212",
            13,
            19,
        ),
        (
            "app T\nGiven\n M { a:int[][] }\nWhen\nThen\n",
            "E1213",
            24,
            25,
        ),
        (
            "app T\nGiven\n M { a:enum() }\nWhen\nThen\n",
            "E1213",
            24,
            25,
        ),
        (
            "app T\nGiven\n M { a:int label=123 }\nWhen\nThen\n",
            "E1214",
            29,
            32,
        ),
        (
            "app T\nGiven\n message m = \"Hi\"\nWhen\nThen\n",
            "E1214",
            24,
            29,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  require 1 +\n  do\n   return 1\nThen\n",
            "E1215",
            55,
            55,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   frobnicate x\nThen\n",
            "E1216",
            50,
            60,
        ),
        (
            "app T\nGiven\nWhen\n scenario s() by=members\n  require n > 5 m\n  do\n   return 1\nThen\n",
            "E1005",
            58,
            59,
        ),
    ];
    for (text, code, start, end) in cases {
        let (tree, diags) = assert_codes(text, &[code]);
        assert_eq!(diags_span(&diags[0]), (*start, *end), "{text:?}");
        assert!(has_kind(&tree, SyntaxKind::Error), "{text:?}");
        assert_eq!(tree.kind, SyntaxKind::File);
    }
}

#[test]
fn lexer_errors_preserve_bytes_as_bad_tokens() {
    // The lexer reports the unexpected character once; the parser wraps
    // the line without a second diagnostic, keeping the byte covered.
    let (tree, diags) = assert_codes(
        "app T\nGiven\n role a label=\"A\" $\nWhen\nThen\n",
        &["E1007"],
    );
    assert_eq!(diags_span(&diags[0]), (30, 31));
    assert!(has_kind(&tree, SyntaxKind::BadToken));
    assert!(has_kind(&tree, SyntaxKind::Error));
}

#[test]
fn suite_structure_failures_keep_partial_nodes() {
    // A missing `do` body: the scenario head parsed, so the partial
    // `Scenario` (without `DoBlock`) carries the E1204, with no `Error`
    // wrap and no cascade.
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  require x > 0\nThen\n",
        &["E1204"],
    );
    assert_eq!(diags_span(&diags[0]), (18, 26));
    assert!(has_kind(&tree, SyntaxKind::Scenario));
    assert!(!has_kind(&tree, SyntaxKind::DoBlock));
    assert!(!has_kind(&tree, SyntaxKind::Error));
    // A stray token after a section marker: the marker still structures
    // the sections, so no `Error` wrap either.
    let (tree, diags) = assert_codes("app T\nGiven foo\nWhen\nThen\n", &["E1201"]);
    assert_eq!(diags_span(&diags[0]), (12, 15));
    assert_eq!(count_kind(&tree, SyntaxKind::Section), 3);
    assert!(!has_kind(&tree, SyntaxKind::Error));
}

#[test]
fn invalid_app_header_layout_wraps_identity_and_preserves_body() {
    let text = "app T\n unexpected\nGiven\n derive a(): int = 1\nWhen\nThen\n";
    let (tree, diags) = assert_codes(text, &["E1200"]);
    assert_eq!(diags_span(&diags[0]), (0, 3));
    let app = tree
        .children
        .iter()
        .find(|n| n.kind == SyntaxKind::App)
        .unwrap();
    assert!(app.children.iter().all(|n| n.kind != SyntaxKind::Name));
    let header = app
        .children
        .iter()
        .find(|n| n.kind == SyntaxKind::Error)
        .unwrap();
    assert!(has_kind(header, SyntaxKind::Name));
    assert!(has_kind(app, SyntaxKind::Derive));
}

#[test]
fn multiple_errors_recover_per_declaration() {
    // Three bad declarations: one diagnostic each, no cascade, and the
    // valid sibling still parses.
    let (tree, diags) = assert_codes(
        "app T\nGiven\n policy\n Todo { title }\n role admin label=\"Admin\"\nWhen\n frobnicate X\nThen\n",
        &["E1200", "E1200", "E1200"],
    );
    assert_eq!(count_kind(&tree, SyntaxKind::Error), 3);
    assert!(has_kind(&tree, SyntaxKind::Role));
    // Diagnostics arrive sorted by offset.
    let starts: Vec<u32> = diags.iter().map(|d| d.primary.start).collect();
    let mut sorted = starts.clone();
    sorted.sort();
    assert_eq!(starts, sorted);
    // Bare section markers with no owner fail once per line.
    assert_codes("Given\nWhen\nThen\n", &["E1211", "E1211", "E1211"]);
}

#[test]
fn cst_invariants() {
    let text = "app T\nGiven\n role admin label=\"Admin\"\nWhen\nThen\n";
    let (tree, diags) = parse_text(text);
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(tree.kind, SyntaxKind::File);
    assert_eq!((tree.span.start, tree.span.end), (0, text.len() as u32));
    // Every byte is covered exactly once, in document order.
    let leaves: Vec<(u32, u32)> = tree
        .descendants()
        .filter(|n| n.kind.is_leaf())
        .map(|n| (n.span.start, n.span.end))
        .collect();
    let mut cursor = 0u32;
    for (start, end) in &leaves {
        assert_eq!(*start, cursor, "gap or overlap at {start}");
        cursor = *end;
    }
    assert_eq!(cursor, text.len() as u32);
    // The dump names node kinds and shows source text.
    let dump = tree.dump(text);
    assert!(dump.contains("Role"));
    assert!(dump.contains("admin"));
    // Unknown source ids fail gracefully.
    let db = canlang_compiler::source::SourceDb::new();
    let (tree, diags) = canlang_compiler::syntax::parse(&db, SourceId(999));
    assert_eq!(codes(&diags), vec!["E1200"]);
    assert_eq!(tree.kind, SyntaxKind::File);
}

#[test]
fn malformed_unicode_escapes_are_diagnostics() {
    // Fix 1: `\u` escapes near multibyte UTF-8 must be E1006, never a
    // `byte index .. is not a char boundary` panic.
    for raw in [
        "\"\\uaabé\"",        // `\u` digits split by a multibyte char
        "\"\\u12é\"",         // multibyte char inside the digit run
        "\"\\u1é23\"",        // multibyte char mid-run
        "\"é\\u12\"",         // truncated `\u` after multibyte content
        "\"\\u12\"",          // truncated `\u`
        "\"\\u\"",            // bare `\u`
        "\"\\uD83D\"",        // lone high surrogate
        "\"\\uDE00\"",        // lone low surrogate
        "\"\\uD83D\\u0041\"", // high surrogate plus non-surrogate
        "\"\\uD83Dx\"",       // high surrogate plus literal
        "\"\\uD83D\\uDE\"",   // truncated low surrogate
        "\"\\uD83Dé\"",       // multibyte char where the low surrogate starts
    ] {
        let Err((_, span)) = decode_json_string(raw, 10, file()) else {
            panic!("{raw:?} should not decode");
        };
        assert!(span.start >= 10, "{raw:?}: {span:?}");
    }
    // Well-formed escapes (incl. surrogate pairs) still decode.
    assert_eq!(decode_json_string("\"\\uaabb\"", 0, file()).unwrap(), "ꪻ");
    assert_eq!(
        decode_json_string("\"\\uD83D\\uDE00\"", 0, file()).unwrap(),
        "\u{1F600}"
    );
    // End to end through the parser: the exact reported repro shape.
    assert_codes(
        "app T\nGiven\n message m = \"\\uaabé\"@{}\nWhen\nThen\n",
        &["E1006"],
    );
    assert_codes(
        "app T\nGiven\n message m = \"\\u12\"@{}\nWhen\nThen\n",
        &["E1006"],
    );
}

#[test]
fn desc_inside_delimiter_runs_decodes_without_panic() {
    // Fix 2: a `#` line joined inside `else (...)` trailing tokens must
    // decode as a Description, not panic in `token_leaf`.
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   if x\n    return 1\n   else (\n    # stray note\n    y)\n    return 2\nThen\n",
        &["E1201"],
    );
    assert_eq!(diags_span(&diags[0]), (76, 77));
    assert!(has_kind(&tree, SyntaxKind::Description));
    assert!(has_kind(&tree, SyntaxKind::If));
    // Same for `#` lines joined after a section marker.
    let (tree, diags) = assert_codes(
        "app T\nGiven (\n # stray note\n )\n Todo { title:text }\nWhen\nThen\n",
        &["E1201"],
    );
    assert_eq!(diags_span(&diags[0]), (12, 13));
    assert!(has_kind(&tree, SyntaxKind::Description));
    assert_eq!(count_kind(&tree, SyntaxKind::Section), 3);
}

#[test]
fn app_uses_attribute_selects_composed() {
    // Fix 3: only the `uses=` attribute selects the composed-app
    // production — a stray `uses` token (app name, caption) stays
    // implicit, and sections parse without spurious E1211s.
    assert_clean("app uses\nGiven\nWhen\nThen\n");
    assert_clean("app T label=uses\nGiven\nWhen\nThen\n");
    // The attribute itself still selects composed: sections after it are
    // top-level heads, each rejected once.
    assert_codes(
        "app T uses=[A]\nGiven\nWhen\nThen\n",
        &["E1211", "E1211", "E1211"],
    );
    // And a genuine composed app with imports parses clean.
    assert_clean("app T uses=[A]\nuse A {Thing}\n");
}

#[test]
fn failed_attempts_emit_no_duplicate_diagnostics() {
    // Fix 4: inline description decodes inside a failing attempt must not
    // double when recovery re-decodes the same groups.
    let text = "app T\nGiven\n Todo {\n  #= a.b\n  # stray prose\n  title\n }\nWhen\nThen\n";
    let (tree, diags) = assert_codes(text, &["E1121", "E1200"]);
    assert!(has_kind(&tree, SyntaxKind::Error));
    let mut seen = std::collections::HashSet::new();
    for diag in &diags {
        let key = (diag.code, diags_span(diag));
        assert!(seen.insert(key), "duplicate diagnostic {key:?}");
    }
}

#[test]
fn trusted_handlers_reject_sequence_examples() {
    // Fix 5: sequence-form examples are for user scenarios only.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario go on=App.events\n  do\n   return 1\n  examples seed=[task]\n   do\n    call go {id=1} by=self as first\n    call go {id=2} by=self request={id=2} -> error(not_found)\n    first -> 1\nThen\n",
        &["E1210"],
    );
    // Table-form examples on a trusted handler stay legal.
    assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\n scenario go on=App.events\n  do\n   return 1\n  examples\n   a -> b\n   1 -> 2\nThen\n",
    );
}

#[test]
fn nesting_budgets_diagnose_instead_of_crashing() {
    // Fix 6: deep-but-legal expression nesting parses; past the budget
    // the parser returns E1215 instead of overflowing the stack.
    let head = "app T\nGiven\nWhen\n scenario s() by=members\n  require ";
    let tail = " == 1\n  do\n   return 1\nThen\n";
    let legal = format!("{head}{}{tail}", "(".repeat(20) + "1" + &")".repeat(20));
    assert_clean(&legal);
    let over = format!("{head}{}{tail}", "(".repeat(500) + "1" + &")".repeat(500));
    let (tree, diags) = parse_text(&over);
    assert_eq!(codes(&diags), vec!["E1215"], "{diags:?}");
    assert!(tree.verify_coverage(over.len() as u32).is_ok());
    // Deep-but-legal statement nesting parses; past the suite budget
    // the parser reports E1216 (and layout caps the tree at E1103) and
    // parsing still completes with full coverage.
    fn nested_ifs(depth: usize) -> String {
        let mut text = String::from("app T\nGiven\nWhen\n scenario s() by=members\n  do\n");
        for i in 0..depth {
            text.push_str(&format!("{}if x\n", " ".repeat(3 + i)));
        }
        text.push_str(&format!("{}return 1\n", " ".repeat(3 + depth)));
        text.push_str("Then\n");
        text
    }
    assert_clean(&nested_ifs(12));
    let over = nested_ifs(300);
    let (tree, diags) = parse_text(&over);
    assert!(
        codes(&diags).contains(&"E1216"),
        "expected E1216 in {:?}",
        codes(&diags)
    );
    assert!(
        codes(&diags).contains(&"E1103"),
        "expected E1103 in {:?}",
        codes(&diags)
    );
    assert!(tree.verify_coverage(over.len() as u32).is_ok());
    // Deep UI nesting past the suite budget reports E1200, no crash.
    let mut ui =
        String::from("app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n");
    for i in 0..40 {
        ui.push_str(&format!("{}card \"c\"\n", " ".repeat(2 + i)));
    }
    ui.push_str(&format!("{}text \"x\"\n", " ".repeat(2 + 40)));
    let (tree, diags) = parse_text(&ui);
    assert!(
        codes(&diags).contains(&"E1200"),
        "expected E1200 in {:?}",
        codes(&diags)
    );
    assert!(tree.verify_coverage(ui.len() as u32).is_ok());
    // Deep non-statement nesting exercises the layout cap plus the
    // iterative error wrap: E1103, no crash, full coverage.
    let mut given = String::from("app T\nGiven\n Todo { title:text }\n");
    for i in 0..200 {
        given.push_str(&format!("{}x\n", " ".repeat(2 + i)));
    }
    given.push_str("When\nThen\n");
    let (tree, diags) = parse_text(&given);
    assert!(
        codes(&diags).contains(&"E1103"),
        "expected E1103 in {:?}",
        codes(&diags)
    );
    assert!(tree.verify_coverage(given.len() as u32).is_ok());
    // Long flat chains are built (and walked) iteratively, not recursively.
    let chain = format!("1{}", "+1".repeat(3000));
    assert_clean(&format!("{head}{chain}{tail}"));
    let members = format!("T{}", ".a".repeat(3000));
    assert_clean(&format!(
        "{head}{members} {{title=\"t\"}} != null\n  do\n   return 1\nThen\n"
    ));
}

#[test]
fn invalid_shapes_rejected() {
    // Fix 10: `!` misuse (scalar and nullable suffixes).
    assert_codes(
        "app T\nGiven\n Todo { title:text! }\nWhen\nThen\n",
        &["E1213"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text?! }\nWhen\nThen\n",
        &["E1213"],
    );
    // Migration shape errors.
    assert_codes("migration V2 from=\"v1\"\n drop before\n", &["E1200"]);
    assert_codes("migration V2 from=\"v1\"\n invalidate Todo\n", &["E1200"]);
    assert_codes(
        "migration V2 from=\"v1\"\n rename before.Todo to Todo extra\n",
        &["E1201"],
    );
    // Preference-order violations: missing member, duplicate, unknown.
    let page =
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  list Todo order=";
    assert_codes(&format!("{page}{{by=preferences.view}}\n"), &["E1204"]);
    assert_codes(
        &format!("{page}{{by=a,by=b,default=[c],cases={{d=[e]}}}}\n"),
        &["E1202"],
    );
    assert_codes(
        &format!("{page}{{bogus=1,by=a,default=[b],cases={{c=[d]}}}}\n"),
        &["E1203"],
    );
    // CRLF end to end through the parser.
    assert_clean("app T\r\nGiven\r\n Todo { title:text }\r\nWhen\r\nThen\r\n");
    // Empty file: an empty `File` node, no diagnostics, trivial coverage.
    let (tree, diags) = parse_text("");
    assert!(diags.is_empty(), "{diags:?}");
    assert_eq!(tree.kind, SyntaxKind::File);
    assert!(tree.verify_coverage(0).is_ok());
}

#[test]
fn oracle_deviations_parse_per_grammar() {
    // Duplicate message names: namespace collisions "require the checker".
    let tree =
        assert_clean("app T\nGiven\n message a = \"A\"@{}; message a = \"B\"@{}\nWhen\nThen\n");
    assert_eq!(count_kind(&tree, SyntaxKind::Message), 2);
    // `read=true` without a result and `scope=authority` without `read`
    // "remain semantic work", so both parse.
    assert_clean(
        "app T\nGiven\nWhen\n scenario s() by=members read=true\n  do\n   return 1\nThen\n",
    );
    assert_clean(
        "app T\nGiven\nWhen\n scenario s() by=members scope=authority\n  do\n   return 1\nThen\n",
    );
}

#[test]
fn do_colon_recovery() {
    // Bare `do:` is one precise shape error.
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do:\nThen\n",
        &["E1200"],
    );
    assert!(has_kind(&tree, SyntaxKind::DoBlock));
    assert!(has_kind(&tree, SyntaxKind::Error));
    assert_eq!(diags[0].message, "expected identifier");
    // An indented body under `do:` must not panic the builder: the
    // header's trailing tokens precede the wrapped suite, yielding one
    // diagnostic per defect.
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do:\n   return 1\nThen\n",
        &["E1200", "E1200"],
    );
    assert_eq!(diags[0].message, "inline do cannot own an indented suite");
    assert_eq!(diags[1].message, "expected identifier");
    assert!(has_kind(&tree, SyntaxKind::DoBlock));
    // Multiple statements under `do:`: same two diagnostics, full coverage.
    assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do:\n   let a = 1\n   let b = 2\n   return a\nThen\n",
        &["E1200", "E1200"],
    );
    // A nested if/else suite under `do:` wraps iteratively, no panic.
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do:\n   if x\n    return 1\n   else\n    return 2\nThen\n",
        &["E1200", "E1200"],
    );
    assert!(has_kind(&tree, SyntaxKind::DoBlock));
    assert!(has_kind(&tree, SyntaxKind::Error));
    assert_eq!(diags.len(), 2);
    // The mapper shares the `do` path: same recovery, no panic.
    assert_codes(
        "migration V2 from=\"v1\"\n backfill Todo\n  do:\n   set row {title=\"x\"}\n",
        &["E1200", "E1200"],
    );
    // A valid inline body with an unexpected suite parses the body and
    // wraps only the suite (this ordering panicked before the fix too).
    let (tree, diags) = assert_codes(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do return 1\n   return 2\nThen\n",
        &["E1200"],
    );
    assert_eq!(diags[0].message, "inline do cannot own an indented suite");
    assert!(has_kind(&tree, SyntaxKind::DoBlock));
    assert!(has_kind(&tree, SyntaxKind::Return));
}

#[test]
fn mapper_rejects_examples_line() {
    // Mappers take no `examples` line: the E1216 message is mapper-specific.
    let (_, diags) = assert_codes(
        "migration V2 from=\"v1\"\n backfill Todo\n  do\n   set row {title=\"x\"}\n  examples\n",
        &["E1216"],
    );
    assert_eq!(
        diags[0].message,
        "expected leading require guards plus do (mappers take no examples)"
    );
}

#[test]
fn corpus_given_leaf() {
    let tree = assert_clean(
        "app T\nGiven\n corpus Handbook model=Revision scope=parent.parent title=title content=body,attachments where=live(row) from=deployment.knowledge\nWhen\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Corpus));
    // Attributes may occur in any order.
    assert_clean(
        "app T\nGiven\n corpus H from=F where=W content=C title=T scope=S model=M\nWhen\nThen\n",
    );
    // Corpora are description-eligible.
    assert_clean(
        "app T\nGiven\n # Searchable docs.\n corpus H model=M scope=S title=T content=C where=W from=F\nWhen\nThen\n",
    );
    // Corpora are Given leaves, so semicolon sequences are legal.
    let tree = assert_clean(
        "app T\nGiven\n corpus A model=M scope=S title=T content=C where=W from=F; corpus B model=M scope=S title=T content=C where=W from=F\nWhen\nThen\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::Corpus), 2);
    // All six attributes are required.
    assert_codes(
        "app T\nGiven\n corpus H model=M scope=S title=T content=C where=W\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n corpus H model=M scope=S title=T content=C where=W from=F bogus=1\nWhen\nThen\n",
        &["E1203"],
    );
    assert_codes(
        "app T\nGiven\n corpus H model=M model=N scope=S title=T content=C where=W from=F\nWhen\nThen\n",
        &["E1202"],
    );
    // Corpora are unexported.
    let (_, diags) = assert_codes(
        "app T\nGiven\n export corpus H model=M scope=S title=T content=C where=W from=F\nWhen\nThen\n",
        &["E1212"],
    );
    assert_eq!(diags[0].message, "corpora cannot be exported");
    // A leaf cannot own a suite.
    assert_codes(
        "app T\nGiven\n corpus H model=M scope=S title=T content=C where=W from=F\n  role a\nWhen\nThen\n",
        &["E1200"],
    );
}

#[test]
fn judgment_compound() {
    let tree = assert_clean(
        "app T\nGiven\n export judgment ChangeReview version=1\n  evidence noul \"Q\" yes=\"Y\" no=\"N\"\n  bare noul \"Q\"\n  pick choice \"Q\" options=runtime {none=\"N\"}\n  route choice \"Q\" {a=\"A\",b=\"B\"}\n  ready score \"Q\" [low=\"L\",high=\"H\"]\nWhen\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Judgment));
    assert_eq!(count_kind(&tree, SyntaxKind::JudgmentItem), 5);
    assert!(has_kind(&tree, SyntaxKind::JudgmentOption));
    // `options=runtime` without a fixed map, and path captions.
    assert_clean(
        "app T\nGiven\n judgment J version=1\n  p choice label_pick options=runtime\n  q score label_q [a=label_a]\nWhen\nThen\n",
    );
    // Judgments are description-eligible and exportable (above).
    assert_clean(
        "app T\nGiven\n # Pick winners.\n judgment J version=1\n  a noul \"Q\"\nWhen\nThen\n",
    );
    // Header and suite requirements.
    assert_codes(
        "app T\nGiven\n judgment J\n  a noul \"Q\"\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\nWhen\nThen\n",
        &["E1204"],
    );
    // Judgment headers are compound: never semicolon leaves.
    assert_codes(
        "app T\nGiven\n judgment J version=1; role a\nWhen\nThen\n",
        &["E1205"],
    );
    assert_codes(
        "app T\nGiven\n role a; judgment J version=1\nWhen\nThen\n",
        &["E1205"],
    );
    // Item shapes.
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a survey \"Q\"\nWhen\nThen\n",
        &["E1200"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a noul \"Q\" yes=\"Y\"\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a noul \"Q\" no=\"N\"\nWhen\nThen\n",
        &["E1201"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a choice \"Q\"\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a choice \"Q\" options=static\nWhen\nThen\n",
        &["E1200"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a choice \"Q\" {}\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a score \"Q\" []\nWhen\nThen\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a score \"Q\" [x=\"X\",x=\"Y\"]\nWhen\nThen\n",
        &["E1202"],
    );
    assert_codes(
        "app T\nGiven\n judgment J version=1\n  a choice \"Q\" {x}\nWhen\nThen\n",
        &["E1200"],
    );
    // One bad item recovers; the sibling still parses.
    let (tree, diags) = assert_codes(
        "app T\nGiven\n judgment J version=1\n  a survey \"Q\"\n  b noul \"Q\"\nWhen\nThen\n",
        &["E1200"],
    );
    assert_eq!(diags.len(), 1);
    assert_eq!(count_kind(&tree, SyntaxKind::JudgmentItem), 1);
}

#[test]
fn invocation_type_and_constructor() {
    let tree = assert_clean(
        "app T\nGiven\n M { a:invocation(Task.update,complete), b:invocation(Target,)? }\nWhen\nThen\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::InvocationType), 2);
    // A bare `invocation` path component is not the type form.
    let tree = assert_clean("app T\nGiven\n M { a:invocation }\nWhen\nThen\n");
    assert!(has_kind(&tree, SyntaxKind::NamedType));
    assert!(!has_kind(&tree, SyntaxKind::InvocationType));
    // The path list is syntactically nonempty.
    assert_codes(
        "app T\nGiven\n M { a:invocation() }\nWhen\nThen\n",
        &["E1213"],
    );
    // The ordinary expression constructor uses the existing call shape.
    let tree = assert_clean(
        "app T\nGiven\nWhen\n scenario s() by=members\n  do\n   return invocation(Task.update,{record=task,changes={priority=high}})\nThen\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Call));
}

#[test]
fn gallery_collection() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  gallery Todo image=photo columns=title order=-created search=title filter=done empty=\"None\" defaults={done=false}\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Collection));
    // `image=` is required and singular.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  gallery Todo columns=title\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  gallery Todo image=a,b\n",
        &["E1200"],
    );
    // No `display=` on this row.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  gallery Todo image=photo display=split\n",
        &["E1203"],
    );
}

#[test]
fn slot_and_preferences_panel() {
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  modal \"M\" id=dlg\n   slot content\n    text \"x\"\n   slot trigger\n    text \"y\"\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::Slot), 2);
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  slot content\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  slot\n   text \"x\"\n",
        &["E1200"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  slot content foo=bar\n   text \"x\"\n",
        &["E1203"],
    );
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  preferences\n   input year\n",
    );
    assert!(has_kind(&tree, SyntaxKind::PreferencePanel));
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  preferences\n",
        &["E1204"],
    );
    // The Given schema shape is not a panel.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  preferences {x:int}\n",
        &["E1201"],
    );
}

#[test]
fn edit_group_and_bare_card() {
    // The leaf control stays valid; the suite is optional.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  edit fields=title\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Edit));
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  edit fields=title\n   input title\n   button submit=true\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Edit));
    assert!(has_kind(&tree, SyntaxKind::CatalogItem));
    // A card may omit its heading, with or without attributes.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  card\n   text \"x\"\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Card));
    assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  card layout=stack\n   text \"x\"\n",
    );
    // Unknown card attributes still fail against the closed row.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  card tone=primary\n   text \"x\"\n",
        &["E1203"],
    );
    // A group still requires children; details still requires a heading.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  card\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  details\n   text \"x\"\n",
        &["E1215"],
    );
}

#[test]
fn catalog_items_shape() {
    // Known catalog words parse to shape nodes (membership is analysis).
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  badge row.kind\n  modal \"M\" id=dlg\n   slot content\n    text \"x\"\n  button submit=true\n  button action=complete\n  input title\n  stat account.available,account.earned\n  timeline row.Activity order=-occurred\n  breadcrumbs\n",
    );
    assert!(count_kind(&tree, SyntaxKind::CatalogItem) >= 8);
    assert!(!has_kind(&tree, SyntaxKind::Error));
    // Unknown words parse identically: the parser asserts shape, never
    // catalog membership (membership checking is PR5 work, not E2xxx).
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  frobnicate_widget row.x gizmo=1\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::CatalogItem), 1);
    // Leaf catalog items accept semicolon sequences.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  badge a; badge b\n",
    );
    assert_eq!(count_kind(&tree, SyntaxKind::CatalogItem), 2);
    // Overlapping core words keep their dedicated nodes.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  card \"C\"\n   text \"x\"\n  list Todo columns=title\n  table Todo columns=title\n  tabs preferences.view\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Card));
    assert!(has_kind(&tree, SyntaxKind::Collection));
    assert!(has_kind(&tree, SyntaxKind::Tabs));
    assert!(!has_kind(&tree, SyntaxKind::CatalogItem));
    // Duplicate generic options are still one precise error.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  badge row.x tone=a tone=b\n",
        &["E1202"],
    );
    // Calendar dispatch: both endpoints select the agenda collection.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  calendar Job start=from end=until filter=location\n",
    );
    assert!(has_kind(&tree, SyntaxKind::Collection));
    assert!(!has_kind(&tree, SyntaxKind::CatalogItem));
    // A selector without endpoints is the catalog date control.
    let tree = assert_clean(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  calendar business_date\n",
    );
    assert!(has_kind(&tree, SyntaxKind::CatalogItem));
    assert!(!has_kind(&tree, SyntaxKind::Collection));
    // A partial endpoint header is invalid, never inferred.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  calendar Job start=from\n",
        &["E1204"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  calendar Job end=until\n",
        &["E1204"],
    );
    // Catalog placement rules still hold: Then takes pages, tabs take tabs.
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n badge row.x\n",
        &["E1200"],
    );
    assert_codes(
        "app T\nGiven\n Todo { title:text }\nWhen\nThen\n page /t title=\"T\"\n  tabs\n   badge row.x\n",
        &["E1200"],
    );
}

/// C01 recovery witness: invalid source strings keep lexer diagnostics
/// at authored byte positions and never acquire a decoded CST payload.
#[test]
fn c01_invalid_string_payloads_keep_source_diagnostics() {
    for (raw, invalid_byte) in [
        (r#""\q""#, 2),
        (r#""\uD83D""#, 2),
        (r#""\uDE00""#, 2),
        (r#""\u12""#, 2),
        ("\"a\tb\"", 2),
        ("\"a\u{8}b\"", 2),
    ] {
        let prefix = "app T\nGiven\n M { value:text=";
        let src = format!("{prefix}{raw} }}\nWhen\nThen\n");
        let (tree, diags) = assert_codes(&src, &["E1006"]);
        assert_eq!(
            diags[0].primary.start,
            (prefix.len() + invalid_byte) as u32,
            "{raw:?}"
        );
        assert_eq!(
            diags[0].primary.end,
            (prefix.len() + invalid_byte + 1) as u32,
            "{raw:?}"
        );
        let strings: Vec<_> = tree
            .descendants()
            .filter(|n| n.kind == SyntaxKind::String)
            .collect();
        assert_eq!(strings.len(), 1, "{raw:?}");
        assert_eq!(strings[0].token().unwrap().string_value, None, "{raw:?}");
    }
}
