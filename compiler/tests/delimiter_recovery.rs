//! EOF-unclosed joining must keep independent declarations visible without
//! assigning layout meaning to balanced delimiter continuation indentation.
use canlang_compiler::analysis::check_program;
use canlang_compiler::source::{SourceDb, SourceId};
use canlang_compiler::syntax::{SyntaxKind, layout, lex, parse_source};

fn parsed(
    source: &str,
) -> (
    canlang_compiler::syntax::SyntaxNode,
    Vec<canlang_compiler::diagnostic::Diagnostic>,
) {
    let (tree, diagnostics) = parse_source(SourceId(0), source);
    assert!(
        tree.verify_coverage(source.len() as u32).is_ok(),
        "{source}"
    );
    let reconstructed: String = tree.leaves().map(|leaf| leaf.text(source)).collect();
    assert_eq!(reconstructed, source);
    (tree, diagnostics)
}

fn assert_anchor(
    diagnostics: &[canlang_compiler::diagnostic::Diagnostic],
    source: &str,
    code: &str,
    anchor: &str,
) {
    let start = source.find(anchor).unwrap() as u32;
    let end = start + anchor.len() as u32;
    assert!(
        diagnostics
            .iter()
            .any(|d| d.code == code && d.primary.start == start && d.primary.end == end),
        "{code} at {anchor:?}: {diagnostics:?}"
    );
}

#[test]
fn eof_unclosed_declarations_keep_independent_type_and_name_findings() {
    for (bad, opener) in [
        (" M {value:int", "{"),
        (" derive broken(): int = count(", "count("),
        (" M {value:int[]=[1", "=["),
        (" M {value:text=\"abc}", "{"),
    ] {
        // CRLF and implicit-final-newline are separate ingress controls.
        for (newline, final_newline) in [("\n", true), ("\r\n", true), ("\n", false)] {
            let text = format!("app T\nGiven\n{bad}\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\nThen{}", if final_newline { "\n" } else { "" }).replace('\n', newline);
            let (tree, parse_diagnostics) = parsed(&text);
            assert_eq!(
                tree.descendants()
                    .filter(|n| n.kind == SyntaxKind::Derive)
                    .count(),
                2,
                "{text}"
            );
            let start = text.find(opener).unwrap() + opener.len() - 1;
            let unclosed: Vec<_> = parse_diagnostics
                .iter()
                .filter(|d| d.code == "E1102")
                .collect();
            assert_eq!(unclosed.len(), 1, "{text}: {parse_diagnostics:?}");
            assert_eq!(
                (unclosed[0].primary.start, unclosed[0].primary.end),
                (start as u32, start as u32 + 1)
            );
            if bad.contains('"') {
                assert_anchor(&parse_diagnostics, &text, "E1006", "\"abc}");
            }
            let mut db = SourceDb::new();
            let file = db.add("recover.can".into(), text.clone());
            let (program, diagnostics) = check_program(&db, &[file], None);
            assert_anchor(&diagnostics, &text, "E3002", "1 + true");
            assert_anchor(&diagnostics, &text, "E2001", "nope");
            for canonical in ["T.a", "T.b"] {
                assert!(
                    program.symbols.iter().any(|s| s.canonical == canonical),
                    "{canonical}: {text}"
                );
            }
        }
    }
}

#[test]
fn eof_unclosed_schema_keeps_later_module_and_nested_machine_workflow() {
    let source = "app Broken\nGiven\n M {value:int\nWhen\nThen\napp T\nGiven\n Job { status:enum(idle,ready)=idle machine }\n derive a(): int = 1 + true\n derive b(): int = nope\nWhen\n scenario advance(job:Job) -> Job by=public\n  do\n   if true\n    transition job.status idle -> ready\n   return job\nThen\n";
    let (tree, parse_diagnostics) = parsed(source);
    assert_eq!(
        tree.descendants()
            .filter(|n| n.kind == SyntaxKind::App)
            .count(),
        2
    );
    for kind in [
        SyntaxKind::Scenario,
        SyntaxKind::If,
        SyntaxKind::Transition,
        SyntaxKind::Return,
    ] {
        assert!(tree.descendants().any(|n| n.kind == kind), "{kind:?}");
    }
    assert_anchor(&parse_diagnostics, source, "E1102", "{");
    let mut db = SourceDb::new();
    let file = db.add("modules.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    assert_eq!(
        program
            .modules
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        ["Broken", "T"]
    );
    assert_anchor(&diagnostics, source, "E3002", "1 + true");
    assert_anchor(&diagnostics, source, "E2001", "nope");
    assert!(
        !diagnostics
            .iter()
            .any(|d| d.primary.start >= source.find(" scenario").unwrap() as u32),
        "{diagnostics:?}"
    );
}

#[test]
fn balanced_continuations_ignore_same_and_dedented_columns() {
    for (source, kind, count) in [
        (
            "app T\nGiven\n M {\nvalue:int,\n text:text=\"([{}])\"\n}\nWhen\nThen\n",
            SyntaxKind::Field,
            2,
        ),
        (
            "app T\nGiven\n derive a(): int = count(\n[\n1,\n2\n]\n)\nWhen\nThen\n",
            SyntaxKind::Derive,
            1,
        ),
        (
            "app T\nGiven\n M {\n  # Field.\n  value:int\n }\nWhen\nThen\n",
            SyntaxKind::Description,
            1,
        ),
        (
            "app T\nGiven\n M { point:Point=Point {x=1,y=2}, samples:int[]=[\n1,\n2\n] }\nWhen\nThen\n",
            SyntaxKind::Field,
            2,
        ),
    ] {
        let (tree, diagnostics) = parsed(source);
        assert!(diagnostics.is_empty(), "{source}: {diagnostics:?}");
        assert_eq!(
            tree.descendants().filter(|n| n.kind == kind).count(),
            count,
            "{source}"
        );
    }
}

#[test]
fn replay_keeps_balanced_subjoin_and_description_comment_ownership() {
    let source = "app T\nGiven\n M {value:int\n ## retained once\n\n # Independent list.\n derive values(): int[] = [\n1,\n2\n]\n derive broken(): int = count(\n  3\n ## second comment\n derive a(): int = 1 + true\nWhen\nThen\n";
    let (tree, diagnostics) = parsed(source);
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1102").count(), 2);
    let derives: Vec<_> = tree
        .descendants()
        .filter(|n| n.kind == SyntaxKind::Derive)
        .collect();
    assert_eq!(derives.len(), 2);
    let values = derives
        .iter()
        .find(|n| n.text(source).contains("derive values"))
        .unwrap();
    let lexed = lex(SourceId(0), source);
    let laid = layout(SourceId(0), source, lexed.lines);
    let values_line = laid.roots[1]
        .children
        .iter()
        .find(|line| {
            line.tokens
                .iter()
                .any(|token| token.text(source) == "values")
        })
        .unwrap();
    assert_eq!(
        values_line.description.as_ref().unwrap().tokens[0].text(source),
        "# Independent list."
    );
    assert_eq!(
        tree.descendants()
            .filter(|n| n.kind == SyntaxKind::Description)
            .count(),
        1
    );
    assert!(values.text(source).contains("1,\n2\n]"));
    let comments = tree
        .leaves()
        .filter(|n| n.text(source).starts_with("##"))
        .count();
    assert_eq!(comments, 2);
    let mut db = SourceDb::new();
    let file = db.add("subjoin.can".into(), source.into());
    assert_anchor(
        &check_program(&db, &[file], None).1,
        source,
        "E3002",
        "1 + true",
    );
}

#[test]
fn deeper_unfinished_continuations_remain_in_the_failed_join() {
    let source = "app T\nGiven\n derive broken(): int = count(\n  1,\n  2\n";
    let lexed = lex(SourceId(0), source);
    let laid = layout(SourceId(0), source, lexed.lines);
    assert_eq!(laid.roots.len(), 2);
    assert_eq!(laid.roots[1].children.len(), 1);
    let broken = &laid.roots[1].children[0];
    assert!(broken.children.is_empty());
    assert_eq!(
        broken
            .tokens
            .iter()
            .filter(|t| matches!(t.kind, canlang_compiler::syntax::TokenKind::Integer))
            .count(),
        2
    );
    let (_, diagnostics) = parsed(source);
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1102").count(), 1);
}

#[test]
fn mismatched_closer_before_eof_replay_is_reported_once() {
    let source = "app T\nGiven\n M {value:int[]=[1)\n derive a(): int = 1 + true\nWhen\nThen\n";
    let (_, diagnostics) = parsed(source);
    assert_anchor(&diagnostics, source, "E1101", ")");
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1101").count(), 1);
    assert_eq!(diagnostics.iter().filter(|d| d.code == "E1102").count(), 1);
    let mut db = SourceDb::new();
    let file = db.add("mismatch.can".into(), source.into());
    assert_anchor(
        &check_program(&db, &[file], None).1,
        source,
        "E3002",
        "1 + true",
    );
}
