//! Syntax: lexer, layout, lossless CST and recoverable parser.
//!
//! Entry point: [`parse`] (or [`parse_source`] for bare text). Every byte
//! of the input is covered by exactly one CST leaf; descriptions attach
//! as preceding siblings of their owner; invalid declarations become
//! [`SyntaxKind::Error`](cst::SyntaxKind::Error) subtrees with one
//! diagnostic each and parsing continues.
//!
//! This module implements the complete normative GRAMMAR.md, including the
//! recorded prototype gaps (`delivery(path)` and `invocation(paths)`
//! types, sequence-form examples, preference ordering, CSV form import
//! attributes, page `refresh`, structured derived-field labels, CRUD
//! `expose`), plus `corpus`/`judgment` declarations, `gallery`
//! collections, `slot` items, `preferences` panels, `edit` suites and
//! generic catalog component items (word/option membership is analysis).
//!
//! ## Diagnostic catalog (E1xxx)
//!
//! Lexer: `E1001` bare carriage return, `E1002` invalid UTF-8 (bytes entry
//! only), `E1003` tab in indentation/code, `E1004` backslash continuation,
//! `E1005` invalid numeric literal or unit, `E1006` invalid string,
//! `E1007` unexpected character, `E1008` source or code fragment exceeds
//! the `u32` source-offset range (public lexer/parser API admission).
//!
//! Layout: `E1101` mismatched closing delimiter, `E1102` unclosed
//! delimiter, `E1103` bad indentation or excessive nesting, `E1120` description column
//! mismatch, `E1121` prose/reference mixing, `E1122` invalid `#=`
//! reference, `E1123` misplaced description suffix, `E1124` invalid
//! description suffix, `E1125` dangling description, `E1126` description on
//! an ineligible item.
//!
//! Parser: `E1200` invalid syntax shape, `E1201` trailing tokens after a
//! complete statement, `E1202` duplicate attribute/modifier/slot/binding,
//! `E1203` unknown attribute or slot, `E1204` missing required
//! attribute/suite/section/body, `E1205` invalid semicolon sequence,
//! `E1206` invalid query-clause order or repetition, `E1207` chained
//! comparison, `E1208` mixed `??` with `and`/`or`, `E1209` invalid route,
//! `E1210` invalid examples shape or arity, `E1211` invalid file/section
//! structure, `E1212` invalid `export`, `E1213` invalid type syntax,
//! `E1214` invalid label, message-descriptor or input-annotation shape, `E1215` invalid
//! expression or excessive nesting, `E1216` invalid statement or effect.
//!
//! Deliberate oracle deviations (normative GRAMMAR.md wins): duplicate
//! message names in one section parse (namespace collisions "require the
//! checker"); `read=true` without a result type and `scope=authority`
//! without `read=true` parse ("read return requirements ... remain
//! semantic work"). Documented semantic deferrals (parsed without
//! co-occurrence checks, left to later phases): page `refresh` without
//! `poll`, and `review` without `import=csv`.

mod construct_help;
pub mod cst;
pub mod layout;
pub mod lexer;
pub mod parser;

pub use cst::{CoverageError, NodeDetail, SyntaxKind, SyntaxNode};
pub use layout::{
    AttachedDescription, DescriptionData, DescriptionSuffix, DescriptionVariant, LayoutResult,
    LogicalLine, column_of, decode_description_set, layout,
};
pub use lexer::{
    Lexed, PhysLine, Punct, Token, TokenKind, decode_json_string, lex, lex_bytes, lex_fragment,
};
pub use parser::parse_program;

use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span, admit_source_len};

/// Parse one source from the database into a lossless CST plus diagnostics.
///
/// The tree always covers the full input (see
/// [`SyntaxNode::verify_coverage`]); diagnostics are sorted deterministically
/// by `(file, start, code)`.
pub fn parse(db: &SourceDb, id: SourceId) -> (SyntaxNode, Vec<Diagnostic>) {
    match db.get(id) {
        Some(source) => parse_source(id, &source.text),
        None => (
            SyntaxNode::interior(SyntaxKind::File, Span::new(id, 0, 0), Vec::new()),
            vec![Diagnostic::error(
                "E1200",
                "unknown source id".to_string(),
                Span::new(id, 0, 0),
            )],
        ),
    }
}

/// Parse bare source text for `file` into a lossless CST plus diagnostics.
pub fn parse_source(file: SourceId, text: &str) -> (SyntaxNode, Vec<Diagnostic>) {
    if let Err(error) = admit_source_len(text.len() as u64) {
        return (
            SyntaxNode::interior(SyntaxKind::File, Span::new(file, 0, 0), Vec::new()),
            vec![Diagnostic::error(
                "E1008",
                error.to_string(),
                Span::new(file, 0, 0),
            )],
        );
    }
    let lexed = lex(file, text);
    let laid_out = layout(file, text, lexed.lines);
    let (tree, parse_diags) = parse_program(file, text, &laid_out);
    debug_assert!(
        tree.verify_coverage(text.len() as u32).is_ok(),
        "CST must cover every source byte exactly once"
    );
    let mut diagnostics = lexed.diagnostics;
    diagnostics.extend(laid_out.diagnostics);
    diagnostics.extend(parse_diags);
    construct_help::qualify(text, &laid_out.roots, &tree, &mut diagnostics);
    diagnostics.sort_by(|a, b| {
        (a.primary.file, a.primary.start, a.code).cmp(&(b.primary.file, b.primary.start, b.code))
    });
    (tree, diagnostics)
}
