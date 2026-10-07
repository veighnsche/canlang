//! SEM-R07: fixed-input static-call witnesses follow declaration indexing.
//! Expected messages/closing occurrences are handwritten, not another graph walker.
use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

const UPSTREAM: &str = "app T\nGiven\nWhen\n scenario u() by=members\n  do\n   call a {}\n scenario a() by=members\n  do\n   call b {}\n scenario b() by=members\n  do\n   call a {}\nThen\n";
const OVERLAP: &str = "app T\nGiven\nWhen\n scenario a() by=members\n  do\n   call b {}\n   call c {}\n scenario b() by=members\n  do\n   call a {}\n scenario c() by=members\n  do\n   call a {}\nThen\n";

fn analyze(source: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let file = db.add("cycle.can".into(), source.into());
    let (_, diagnostics) = check_program(&db, &[file], None);
    assert!(
        !diagnostics.iter().any(|d| d.code.starts_with("E1")),
        "{diagnostics:?}"
    );
    diagnostics
}

fn assert_calls(source: &str, expected: &[(&str, &str, usize)]) {
    let diagnostics = analyze(source);
    let actual: Vec<_> = diagnostics
        .iter()
        .map(|d| (d.code, d.message.as_str(), d.primary.start, d.primary.end))
        .collect();
    let expected: Vec<_> = expected
        .iter()
        .map(|(message, target, occurrence)| {
            let needle = format!("call {target} {{}}");
            let start = source.match_indices(&needle).nth(occurrence - 1).unwrap().0 + 5;
            (
                "E3005",
                *message,
                start as u32,
                (start + target.len()) as u32,
            )
        })
        .collect();
    assert_eq!(actual, expected);
}

#[test]
fn upstream_and_overlapping_cycles_have_exact_witnesses() {
    assert_calls(UPSTREAM, &[("call cycle: a -> b -> a", "a", 2)]);
    assert_calls(
        OVERLAP,
        &[
            ("call cycle: a -> b -> a", "a", 1),
            ("call cycle: a -> c -> a", "a", 2),
        ],
    );
}

#[test]
fn declaration_permutations_deliberately_follow_index_order() {
    let source = "app T\nGiven\nWhen\n scenario b() by=members\n  do\n   call a {}\n scenario a() by=members\n  do\n   call b {}\nThen\n";
    assert_calls(source, &[("call cycle: b -> a -> b", "b", 1)]);
    // Reordering outgoing branches keeps their individual closing edges.
    let source = OVERLAP.replacen("call b {}\n   call c {}", "call c {}\n   call b {}", 1);
    assert_calls(
        &source,
        &[
            ("call cycle: a -> b -> a", "a", 1),
            ("call cycle: a -> c -> a", "a", 2),
        ],
    );
}

#[test]
fn independent_self_and_duplicate_closing_edges_keep_vertex_set_dedup() {
    let source = "app T\nGiven\nWhen\n scenario a() by=members\n  do\n   call b {}\n   call b {}\n scenario b() by=members\n  do\n   call a {}\n   call a {}\n scenario c() by=members\n  do\n   call d {}\n scenario d() by=members\n  do\n   call c {}\n scenario self() by=members\n  do\n   call self {}\n   call self {}\nThen\n";
    assert_calls(
        source,
        &[
            ("call cycle: a -> b -> a", "a", 1),
            ("call cycle: c -> d -> c", "c", 1),
            ("call cycle: self -> self", "self", 1),
        ],
    );
}

#[test]
fn diamond_keeps_distinct_path_vertex_sets_inside_one_scc() {
    let source = "app T\nGiven\nWhen\n scenario a() by=members\n  do\n   call b {}\n   call c {}\n scenario b() by=members\n  do\n   call d {}\n scenario c() by=members\n  do\n   call d {}\n scenario d() by=members\n  do\n   call a {}\nThen\n";
    assert_calls(
        source,
        &[
            ("call cycle: b -> d -> a -> b", "b", 1),
            ("call cycle: a -> c -> d -> a", "a", 1),
        ],
    );
}

#[test]
fn check_file_permutations_follow_index_order_even_for_duplicate_paths() {
    let a = "package A\n use B {b}\n Given\n When\n  export scenario a() by=members\n   do\n    call b {}\n Then\n";
    let b = "package B\n use A {a}\n Given\n When\n  export scenario b() by=members\n   do\n    call a {}\n Then\n";
    for path in ["distinct", "same.can"] {
        let mut db = SourceDb::new();
        let fa = db.add(
            if path == "distinct" { "z.can" } else { path }.into(),
            a.into(),
        );
        let fb = db.add(
            if path == "distinct" { "a.can" } else { path }.into(),
            b.into(),
        );
        for (files, expected, closing_file, source, target) in [
            ([fa, fb], "call cycle: a -> b -> a", fb, b, "a"),
            ([fb, fa], "call cycle: b -> a -> b", fa, a, "b"),
        ] {
            let (_, diagnostics) = check_program(&db, &files, None);
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            let d = &diagnostics[0];
            let start = source.find(&format!("call {target} {{}}")).unwrap() + 5;
            assert_eq!(
                (
                    d.code,
                    d.message.as_str(),
                    d.primary.file,
                    d.primary.start,
                    d.primary.end
                ),
                (
                    "E3005",
                    expected,
                    closing_file,
                    start as u32,
                    (start + 1) as u32
                )
            );
        }
    }
}

#[test]
fn acyclic_scenario_derive_crud_and_capability_calls_are_leaves() {
    let source = "app T\nGiven\n M {x:int}\n policy M read=members\n derive leaf():int = 1\n contract Ack {ok:bool}\n capability Mail version=1\n  notify(who:text) -> Ack\nWhen\n crud M by=members fields=x\n scenario upstream() by=members\n  do\n   call sink {}\n scenario sink() by=members\n  do\n   let number = leaf()\n   call M.create {x=number} as made\n   call Mail.notify {who=\"x\"} as ack\nThen\n";
    assert_calls(source, &[]);
}

#[test]
fn rejected_trusted_handler_call_does_not_install_a_cycle_edge() {
    let source = "app T\nGiven\n M {x:int}\n policy M read=members\nWhen\n crud M by=members fields=x\n scenario h on=M.create\n  do\n   call a {}\n scenario a() by=members\n  do\n   call h {}\nThen\n";
    let diagnostics = analyze(source);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    let d = &diagnostics[0];
    let start = source.find("call h {}").unwrap() + 5;
    assert_eq!(
        (d.code, d.message.as_str(), d.primary.start, d.primary.end),
        (
            "E3009",
            "cannot call trusted handler 'h'; handlers run on their trigger",
            start as u32,
            (start + 1) as u32
        )
    );
}

#[test]
fn standalone_derive_cycles_do_not_become_static_call_cycles() {
    let source = "app T\nGiven\n derive u():int = a()\n derive a():int = b()\n derive b():int = a()\nWhen\n scenario s() by=members\n  do\n   let value = u()\nThen\n";
    let diagnostics = analyze(source);
    assert_eq!(diagnostics.len(), 2, "{diagnostics:?}");
    assert!(diagnostics.iter().all(|d| d.code == "E2018"));
    let names: Vec<_> = diagnostics
        .iter()
        .map(|d| &source[d.primary.start as usize..d.primary.end as usize])
        .collect();
    // E2018 retains its existing non-tight declaration-name spans.
    assert_eq!(names, [" a", " b"]);
}

#[test]
fn containment_composition_and_fixture_seed_order_keep_their_own_policies() {
    let composition = "app U uses=[A]\napp A uses=[B,B]\napp B uses=[A,A]\n";
    let diagnostics = analyze(composition);
    assert_eq!(
        diagnostics
            .iter()
            .map(|d| (
                d.code,
                &composition[d.primary.start as usize..d.primary.end as usize]
            ))
            .collect::<Vec<_>>(),
        [("E2007", "A"), ("E2007", "B")]
    );
    let ownership = "app T\nGiven\n U in A {x:int}\n A in B {x:int}\n B in A {x:int}\n policy U read=members\n policy A read=members\n policy B read=members\nWhen\nThen\n";
    let diagnostics = analyze(ownership);
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.code == "E2008")
            .map(|d| &ownership[d.primary.start as usize..d.primary.end as usize])
            .collect::<Vec<_>>(),
        ["U", "A", "B"]
    );
    let fixture = "app T\nGiven\n M {m:M?}\n policy M read=members\n fixture u=M {m=a}\n fixture a=M {m=b}\n fixture b=M {m=a}\nWhen\nThen\n";
    let diagnostics = analyze(fixture);
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.code == "E2017")
            .map(|d| &fixture[d.primary.start as usize..d.primary.end as usize])
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    let source = "app T\nGiven\n M {x:int}\n Pair {first:M,second:M,again:M}\n policy M read=members\n policy Pair read=members\n fixture b=M {x=2}\n fixture a=M {x=1}\n fixture pair=Pair {first=b,second=a,again=b}\nWhen\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("seed.can".into(), source.into());
    let (program, diagnostics) = check_program(&db, &[file], None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let pair = program
        .examples
        .fixtures
        .iter()
        .find(|r| program.symbols[r.symbol.0 as usize].name == "pair")
        .unwrap();
    assert_eq!(
        pair.seeds
            .iter()
            .map(|id| program.symbols[id.0 as usize].name.as_str())
            .collect::<Vec<_>>(),
        ["b", "a"]
    );
}

#[test]
fn fresh_process_child() {
    if std::env::var_os("CAN_CYCLE_WITNESS_CHILD").is_some() {
        upstream_and_overlapping_cycles_have_exact_witnesses();
        independent_self_and_duplicate_closing_edges_keep_vertex_set_dedup();
        diamond_keeps_distinct_path_vertex_sets_inside_one_scc();
    }
}

#[test]
fn identical_input_is_exact_across_fresh_processes() {
    for _ in 0..24 {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "fresh_process_child", "--nocapture"])
            .env("CAN_CYCLE_WITNESS_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
