use canlang_compiler::analysis::check_program;
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::{layout, lex, parse_source, LogicalLine, SyntaxKind};

fn lines<'a>(roots: &'a [LogicalLine], out: &mut Vec<&'a LogicalLine>) {
    for root in roots { out.push(root); lines(&root.children, out); }
}

fn check(source: &str) -> Vec<canlang_compiler::diagnostic::Diagnostic> {
    let (tree, diagnostics) = parse_source(SourceId(0), source);
    assert!(tree.verify_coverage(source.len() as u32).is_ok());
    assert_eq!(tree.leaves().map(|leaf| leaf.text(source)).collect::<String>(), source);
    diagnostics
}

fn survivor(source: &str, expected_derives: usize) {
    let (tree, _) = parse_source(SourceId(0), source);
    assert_eq!(tree.descendants().filter(|n| n.kind == SyntaxKind::Derive).count(), expected_derives);
    let mut db = SourceDb::new();
    let file = db.add("independent.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    for (code, anchor, symbol) in [("E3002", "1 + true", "T.a"), ("E2001", "nope", "T.b")] {
        let start = source.find(anchor).unwrap() as u32;
        assert!(diagnostics.iter().any(|d| d.code == code && d.primary.start == start && d.primary.end == start + anchor.len() as u32), "{code}: {diagnostics:?}");
        assert!(program.symbols.iter().any(|s| s.canonical == symbol));
    }
}

fn unclosed(source: &str, anchors: &[usize]) {
    let diagnostics = check(source);
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1102").map(|d| (d.primary.start as usize, d.primary.end as usize)).collect::<Vec<_>>(), anchors.iter().map(|a| (*a, a + 1)).collect::<Vec<_>>(), "{diagnostics:?}");
}

#[test]
fn mixed_closed_unclosed_and_several_failed_depths() {
    let source = "app T\nGiven\n M {value:int[]=[1)\n  nested(\n   [2,3]\n ## retained })]\n derive broken(): int = count([\n  4\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen\n";
    unclosed(source, &[source.find("nested(").unwrap() + 6, source.find("count([").unwrap() + 6]);
    survivor(source, 2);
    let diagnostics = check(source);
    let mismatch = source.find("1)").unwrap() + 1;
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1101").map(|d| (d.primary.start as usize, d.primary.end as usize)).collect::<Vec<_>>(), [(mismatch, mismatch + 1)]);
}

#[test]
fn deeper_description_is_inline_then_same_column_description_attaches() {
    let source = "app T\nGiven\n M {\n  # Deeper unfinished field ([{}]).\n  value:int\n ## Same column comment does not reset.\n # Independent A.\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen\n";
    unclosed(source, &[source.find('{').unwrap()]);
    survivor(source, 2);
    let laid = layout(SourceId(0), source, lex(SourceId(0), source).lines);
    let mut all = vec![]; lines(&laid.roots, &mut all);
    let failed = all.iter().find(|l| l.tokens.iter().any(|t| t.text(source) == "M")).unwrap();
    assert!(failed.tokens.iter().any(|t| t.text(source).starts_with("# Deeper")));
    let good = all.iter().find(|l| l.tokens.iter().any(|t| t.text(source) == "a")).unwrap();
    assert_eq!(good.description.as_ref().unwrap().tokens[0].text(source), "# Independent A.");
    assert_eq!(laid.comments.len(), 1);
}

#[test]
fn nested_balanced_subjoin_retains_dedents_and_punctuation_strings() {
    let source = "app T\nGiven\n M {value:int\n N {\n# Field punctuation ([{}]).\n point:Point=Point {x=1,y=2},\n samples:int[]=[\n1,\n2\n],\n text:text=\"([{}])\\n# ## )\"\n}\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen\n";
    unclosed(source, &[source.find('{').unwrap()]);
    survivor(source, 2);
    let laid = layout(SourceId(0), source, lex(SourceId(0), source).lines);
    let mut all = vec![]; lines(&laid.roots, &mut all);
    let nested = all.iter().find(|l| l.tokens.iter().any(|t| t.text(source) == "N")).unwrap();
    assert!(nested.children.is_empty());
    assert!(nested.tokens.iter().any(|t| t.text(source).starts_with("# Field")));
    assert!(nested.tokens.iter().any(|t| t.text(source) == "2"));
}

#[test]
fn crlf_unterminated_string_and_eof_comment_reconstruct_exactly() {
    let source = "app T\r\nGiven\r\n M {value:text=\"abc}\r\n derive a(): int = 1 + true\r\n derive b(): int = nope\r\nWhen\r\nThen\r\n ## Unicode prose: αβ })]\r\n";
    unclosed(source, &[source.find('{').unwrap()]);
    survivor(source, 2);
    let diagnostics = check(source);
    let anchor = source.find("\"abc}").unwrap() as u32;
    assert!(diagnostics.iter().any(|d| d.code == "E1006" && d.primary.start == anchor && d.primary.end == anchor + 5));
    let laid = layout(SourceId(0), source, lex(SourceId(0), source).lines);
    assert_eq!(laid.comments.len(), 1);
    assert_eq!(laid.comments[0].text(source), "## Unicode prose: αβ })]");
}

#[test]
fn unicode_whitespace_is_code_error_boundary_and_remains_covered() {
    for whitespace in ['\u{a0}', '\u{2003}', '\u{2028}'] {
        let source = format!("app T\nGiven\n M {{value:int\n {whitespace}\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen\n");
        unclosed(&source, &[source.find('{').unwrap()]);
        survivor(&source, 2);
        let lexed = lex(SourceId(0), &source);
        let at = source.find(whitespace).unwrap() as u32;
        assert!(lexed.diagnostics.iter().any(|d| d.primary.start == at && d.primary.end == at + whitespace.len_utf8() as u32));
        assert!(!lexed.lines[3].tokens.is_empty());
    }
}

#[test]
fn multiple_failed_nested_scenario_statement_boundaries() {
    let source = "app T\nGiven\n M {value:int\n Job { status:enum(idle,ready)=idle machine }\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\n scenario advance(job:Job) -> Job by=public\n  do\n   if true\n    let failed = count(\n     [1,2]\n    transition job.status idle -> ready\n   return job\nThen\n";
    unclosed(source, &[source.find('{').unwrap(), source.find("count(").unwrap() + 5]);
    survivor(source, 2);
    let (tree, _) = parse_source(SourceId(0), source);
    for kind in [SyntaxKind::Scenario, SyntaxKind::If, SyntaxKind::Transition, SyntaxKind::Return] { assert!(tree.descendants().any(|n| n.kind == kind), "{kind:?}"); }
}

#[test]
fn bounded_deep_stack_and_many_deeper_physical_lines_are_lossless() {
    // Layout only: expression-parser recursion is outside this delta. Under
    // 150 KiB: exercise membership on many lines with a large active stack.
    for depth in [128, 1024, 4096] {
        let mut source = format!("app T\nGiven\n M {}\n", "(".repeat(depth));
        for _ in 0..4096 { source.push_str("  1\n"); }
        source.push_str(" derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen\n");
        let lexed = lex(SourceId(0), &source);
        let laid = layout(SourceId(0), &source, lexed.lines);
        assert_eq!(laid.diagnostics.iter().filter(|d| d.code == "E1102").count(), 1);
        let mut all = vec![]; lines(&laid.roots, &mut all);
        let failed = all.iter().find(|l| l.tokens.iter().any(|t| t.text(&source) == "M")).unwrap();
        assert_eq!(failed.tokens.len(), 1 + depth + 4096);
        assert!(failed.children.is_empty());
        assert_eq!(all.iter().filter(|l| l.tokens.iter().any(|t| t.text(&source) == "derive")).count(), 2);
        let start = source.find('(').unwrap() + depth - 1;
        assert!(laid.diagnostics.iter().any(|d| d.code == "E1102" && d.primary.start == start as u32 && d.primary.end == start as u32 + 1));
    }
}
