//! Integration tests for the lane-01 formatter: corpus idempotence,
//! adversarial exact-output fixtures, error passthrough and CST stability.

use canlang_compiler::format::{Formatted, format_source};
use canlang_compiler::source::SourceId;
use canlang_compiler::syntax::{SyntaxKind, SyntaxNode, parse_source};

/// Format `text`, panicking with diagnostics on failure. Asserts the result
/// is a fixed point (`format(format(x)) == format(x)`) and that the output
/// re-parses to an equal CST modulo trivia.
fn format_fixed_point(text: &str) -> Formatted {
    let first = format_source(SourceId(0), text)
        .unwrap_or_else(|error| panic!("expected Ok, got: {diags:?}", diags = error.diagnostics));
    let second = format_source(SourceId(1), &first.text)
        .unwrap_or_else(|error| panic!("formatted output must re-parse: {error:?}"));
    assert_eq!(second.text, first.text, "formatter must be idempotent");
    assert!(!second.changed, "second format pass must report unchanged");
    assert_cst_stable(text, &first.text);
    first
}

/// Assert the CSTs of `before`/`after` agree modulo trivia: same non-trivia
/// leaf sequence of `(kind, text)`, with two documented normalizations the
/// formatter performs inside `#`/`##` spans — CRLF becomes LF, and trailing
/// spaces/tabs on each spanned line are stripped. Everything else compares
/// byte-exactly, so any reordered, added, dropped or rewritten token fails.
fn assert_cst_stable(before: &str, after: &str) {
    let (before_tree, before_diags) = parse_source(SourceId(0), before);
    let (after_tree, after_diags) = parse_source(SourceId(1), after);
    assert!(before_diags.is_empty(), "{before_diags:?}");
    assert!(after_diags.is_empty(), "{after_diags:?}");
    assert_eq!(
        cst_signature(&before_tree, before),
        cst_signature(&after_tree, after),
        "formatted output must re-parse to an equal CST modulo trivia"
    );
}

fn cst_signature(tree: &SyntaxNode, source: &str) -> Vec<(SyntaxKind, String)> {
    tree.leaves()
        .filter(|leaf| leaf.kind != SyntaxKind::Trivia)
        .map(|leaf| {
            let mut text = leaf.text(source).replace("\r\n", "\n");
            if matches!(leaf.kind, SyntaxKind::Description | SyntaxKind::Comment) {
                // Description spans can cover several physical lines (with
                // blank/`##` lines between prose lines); normalize each.
                text = text
                    .split('\n')
                    .map(|line| line.trim_end_matches([' ', '\t']))
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            (leaf.kind, text)
        })
        .collect()
}

fn corpus_files() -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for directory in ["../examples", "../draft", "../draft/shared"] {
        let entries =
            std::fs::read_dir(directory).unwrap_or_else(|_| panic!("missing {directory}"));
        for entry in entries {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|extension| extension == "can") {
                files.push(path);
            }
        }
    }
    files.sort();
    assert!(!files.is_empty(), "corpus must not be empty");
    files
}

/// Corpus files that do not parse under the current grammar: file name to
/// the exact expected diagnostic codes (sorted). The formatter must refuse
/// these with `FormatError` rather than emit output; the files themselves
/// are sibling-owned (the `each=` trusted-scenario attribute they use is
/// not in GRAMMAR.md and the parser rejects it with E1203 — either the
/// grammar/parser or the two drafts must change, both outside this lane).
fn expected_corpus_errors(file_name: &str) -> Option<Vec<&'static str>> {
    match file_name {
        "CanShift.can" | "CanVolunteer.can" => Some(vec!["E1203", "E1203"]),
        _ => None,
    }
}

#[test]
fn corpus_formats_cleanly_and_is_idempotent() {
    let files = corpus_files();
    assert_eq!(
        files.len(),
        55,
        "corpus size changed; update the count and expected outcomes"
    );
    let mut failures = Vec::new();
    let mut table = Vec::new();
    let mut expected_seen = 0usize;
    for path in &files {
        let text = std::fs::read_to_string(path).unwrap();
        let name = path
            .file_name()
            .expect("corpus file must have a name")
            .to_string_lossy()
            .into_owned();
        let expected = expected_corpus_errors(&name);
        match format_source(SourceId(0), &text) {
            Err(error) => {
                let mut codes: Vec<&str> = error.diagnostics.iter().map(|d| d.code).collect();
                codes.sort_unstable();
                match expected {
                    Some(want) if codes == want => {
                        expected_seen += 1;
                        table.push(format!(
                            "{:>9}  {} (expected {})",
                            "ERROR",
                            path.display(),
                            want.join(",")
                        ));
                    }
                    Some(want) => failures.push(format!(
                        "{}: expected [{}], got [{codes:?}]",
                        path.display(),
                        want.join(",")
                    )),
                    None => {
                        let file = path.display();
                        let count = error.diagnostics.len();
                        failures.push(format!("{file}: {count} diagnostic(s)"));
                        for diagnostic in &error.diagnostics {
                            let code = diagnostic.code;
                            let message = &diagnostic.message;
                            failures.push(format!("  {code} {message}"));
                        }
                        table.push(format!("{:>9}  {}", "ERROR", path.display()));
                    }
                }
            }
            Ok(first) => {
                if expected.is_some() {
                    failures.push(format!(
                        "{}: expected a parse error, but it formatted",
                        path.display()
                    ));
                    continue;
                }
                let label = if first.changed {
                    "changed"
                } else {
                    "unchanged"
                };
                table.push(format!("{label:>9}  {}", path.display()));
                match format_source(SourceId(1), &first.text) {
                    Err(error) => failures.push(format!(
                        "{}: formatted output does not re-parse ({:?})",
                        path.display(),
                        error.diagnostics.iter().map(|d| d.code).collect::<Vec<_>>()
                    )),
                    Ok(second) => {
                        if second.text != first.text {
                            failures.push(format!("{}: not idempotent", path.display()));
                        }
                        let (before_tree, _) = parse_source(SourceId(0), &text);
                        let (after_tree, _) = parse_source(SourceId(1), &first.text);
                        if cst_signature(&before_tree, &text)
                            != cst_signature(&after_tree, &first.text)
                        {
                            failures.push(format!("{}: CST drifted modulo trivia", path.display()));
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        expected_seen, 2,
        "both known-unparseable corpus files must still be present"
    );
    table.sort();
    println!("corpus format table ({} files):", table.len());
    for row in &table {
        println!("{row}");
    }
    assert!(
        failures.is_empty(),
        "corpus failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn intra_line_spacing_is_canonical() {
    let formatted = format_fixed_point(
        "app  A\nGiven\n Todo {title:text,  done:bool=false}\n policy  Todo  read = members\nWhen\n crud Todo by = members fields = title , done\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n Todo { title:text, done:bool=false }\n policy Todo read=members\nWhen\n crud Todo by=members fields=title,done\nThen\n"
    );
    assert!(formatted.changed);
}

#[test]
fn operators_bind_tightly_and_groups_keep_space() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  require  m.x  ==  1  or  ( m.x  !=  2  and  not ( m.x  >  3 ) )\n  do\n   let r = m.x  +  1  *  2  -  3  /  4  %  5\n   let q = f( 1 , 2 )\n   let g =  or ( 1 )\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  require m.x==1 or (m.x!=2 and not (m.x>3))\n  do\n   let r=m.x+1*2-3/4%5\n   let q=f(1,2)\n   let g=or (1)\nThen\n"
    );
}

#[test]
fn enum_match_arms_preserve_scopes_comments_and_branch_spacing() {
    let source = r#"app  MatchFormatting
Given
 State { phase:enum(active,idle),  step:enum(one,two), ticks:int=0 }
When
 scenario  advance(state:State)  by = members
  require  state.ticks >= 0
  do
   ## The subject stays grouped, and each case keeps its own body.
   match  ( state.phase )
    case  active
     let next = state.ticks + 1
     require  ( next > state.ticks )
     ## Nested cases belong to this active arm.
     match  state.step
      case  one
       if  state.ticks == 0
        set state { ticks = next }
       else
        require  next > 0
      case  two
       require  next > 0 ; set state { ticks = next }
     require  state.ticks >= 0
    ## The idle arm does not inherit the active arm's local.
    case  idle
     let next = 0
     set state { ticks = next }
Then
"#;
    let expected = r#"app MatchFormatting
Given
 State { phase:enum(active,idle), step:enum(one,two), ticks:int=0 }
When
 scenario advance(state:State) by=members
  require state.ticks>=0
  do
   ## The subject stays grouped, and each case keeps its own body.
   match (state.phase)
    case active
     let next=state.ticks+1
     require (next>state.ticks)
     ## Nested cases belong to this active arm.
     match state.step
      case one
       if state.ticks==0
        set state {ticks=next}
       else
        require next>0
      case two
       require next>0; set state {ticks=next}
     require state.ticks>=0
    ## The idle arm does not inherit the active arm's local.
    case idle
     let next=0
     set state {ticks=next}
Then
"#;
    let formatted = format_fixed_point(source);
    assert_eq!(formatted.text, expected);
    assert!(formatted.changed);
}

#[test]
fn calls_suffixes_and_nested_commas_stay_tight() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { kind:enum(a,b), tags:text[], run:action(go,stop)? }\nWhen\n scenario s(m:M) by=members\n  require ( m.kind==a )\n  do\n   let r = require ( m )\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { kind:enum(a,b), tags:text[], run:action(go,stop)? }\nWhen\n scenario s(m:M) by=members\n  require (m.kind==a)\n  do\n   let r=require(m)\nThen\n"
    );
}

#[test]
fn definition_heads_stay_loose() {
    let formatted = format_fixed_point(
        "app A\nGiven\n derive  total():int=1+2\n message  m=\"v\"@{nl=\"x\"}\n invariant  T:row.a==1\nWhen\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n derive total():int = 1+2\n message m = \"v\"@{nl=\"x\"}\n invariant T: row.a==1\nWhen\nThen\n"
    );
}

#[test]
fn arrows_and_example_rows_keep_order() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { x:int }\nWhen\n crud M by=members fields=x\n  examples update record=r\n   b,a->a,b\n   2,1->1,2\n   1,2->2,1\n   9,9->-1,-2\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int }\nWhen\n crud M by=members fields=x\n  examples update record=r\n   b,a -> a,b\n   2,1 -> 1,2\n   1,2 -> 2,1\n   9,9 -> -1,-2\nThen\n"
    );
}

#[test]
fn operation_parens_and_message_calls_stay_tight() {
    let formatted = format_fixed_point(
        "app A\nGiven\n capability C version=1\n  cancel(reason:text) -> Outcome\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  do\n   send C.cancel {body=format(\"Hi\"@{nl=\"Hoi\"}(name=m.x))} as r\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n capability C version=1\n  cancel(reason:text) -> Outcome\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  do\n   send C.cancel {body=format(\"Hi\"@{nl=\"Hoi\"}(name=m.x))} as r\nThen\n"
    );
    assert!(!formatted.changed);
}

#[test]
fn semicolons_and_do_shapes_are_preserved() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  require m.x>0;require m.x<10\n  do set m {x=1};set m {x=2}\n scenario t(m:M) by=members\n  do\n   set m {x=1}\n   set m {x=2}\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  require m.x>0; require m.x<10\n  do set m {x=1}; set m {x=2}\n scenario t(m:M) by=members\n  do\n   set m {x=1}\n   set m {x=2}\nThen\n"
    );
}

#[test]
fn sloppy_continuation_indent_is_repaired() {
    let formatted = format_fixed_point(
        "app A\nGiven\n Big {\n        one:text,\n  two:text,\n       # Field three.\n       three:text\n }\nWhen\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n Big {\n  one:text,\n  two:text,\n  # Field three.\n  three:text\n }\nWhen\nThen\n"
    );
}

#[test]
fn descriptions_comments_and_i18n_survive() {
    let formatted = format_fixed_point(
        "# Prose here. @{nl=\"Proostekst.\"}\napp A\n## top comment   \nGiven\n #= greeting\n message greeting = \"Hi\"@{nl=\"Hoi\"}\n # Multi\n # line prose.\n M { x:int label=\"X\" @{nl=\"X\"}}\nWhen\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "# Prose here. @{nl=\"Proostekst.\"}\napp A\n## top comment\nGiven\n #= greeting\n message greeting = \"Hi\"@{nl=\"Hoi\"}\n # Multi\n # line prose.\n M { x:int label=\"X\"@{nl=\"X\"} }\nWhen\nThen\n",
    );
}

#[test]
fn query_tails_routes_and_suffixes_format() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { x:int }\nWhen\n scenario s() by=members\n  do\n   let r=M  as  m  where  m.x==1  select  m.x\nThen\n page  /c/{Customer.id}  title=\"t\"\n page / title=\"u\"\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int }\nWhen\n scenario s() by=members\n  do\n   let r=M as m where m.x==1 select m.x\nThen\n page /c/{Customer.id} title=\"t\"\n page / title=\"u\"\n",
    );
}

#[test]
fn control_flow_suites_keep_their_newlines() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  do\n   if m.x>0\n    set m {x=1}\n   else\n    set m {x=2}\n   for n in M limit=10\n    set n {x=3}\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int }\nWhen\n scenario s(m:M) by=members\n  do\n   if m.x>0\n    set m {x=1}\n   else\n    set m {x=2}\n   for n in M limit=10\n    set n {x=3}\nThen\n"
    );
    assert!(!formatted.changed);
}

#[test]
fn crlf_becomes_lf_and_counts_as_changed() {
    let formatted = format_fixed_point("app A\r\nGiven\r\nWhen\r\nThen\r\n");
    assert_eq!(formatted.text, "app A\nGiven\nWhen\nThen\n");
    assert!(formatted.changed);
}

#[test]
fn missing_final_newline_is_added() {
    let formatted = format_fixed_point("app A\nGiven\nWhen\nThen");
    assert_eq!(formatted.text, "app A\nGiven\nWhen\nThen\n");
    assert!(formatted.changed);
}

#[test]
fn empty_input_stays_empty() {
    let formatted = format_fixed_point("");
    assert_eq!(formatted.text, "");
    assert!(!formatted.changed);
}

#[test]
fn already_formatted_files_report_unchanged() {
    let formatted = format_fixed_point("app A\nGiven\n M { x:int }\nWhen\nThen\n");
    assert!(!formatted.changed);
}

#[test]
fn invalid_sources_yield_diagnostics_and_no_output() {
    let each = "app A\nGiven\n M { x:int }\n event E {}\nWhen\n scenario s on=E each=M as m\n  do\n   set m { x=1 }\nThen\n";
    let formatted = format_fixed_point(each);
    assert!(formatted.text.contains("scenario s on=E each=M as m"));
    let cases = [
        (
            "tab indent",
            "app A\nGiven\n\tM {x:int}\nWhen\nThen\n",
            Some("E1003"),
        ),
        (
            "bad indent",
            "app A\nGiven\n  M {x:int}\nWhen\nThen\n",
            Some("E1103"),
        ),
        (
            "unclosed",
            "app A\nGiven\n M {x:int\nWhen\nThen\n",
            Some("E1102"),
        ),
        (
            "unknown attribute",
            "app A\nGiven\n M { x:int }\nWhen\n crud M by=members fields=x bogus=1\nThen\n",
            Some("E1203"),
        ),
        (
            "spaced route",
            "app A\nGiven\nWhen\nThen\n page /a/{B . id} title=\"t\"\n",
            Some("E1209"),
        ),
        ("dangling description", "# Lone.\n", Some("E1125")),
        (
            "inline hash",
            "app A\nGiven\n M {x:int} # trailing\nWhen\nThen\n",
            Some("E1007"),
        ),
        ("missing sections", "app A\nGiven\n", None),
        ("junk", "app A\nGiven\n ))) \nWhen\nThen\n", None),
        (
            "duplicate each attribute",
            "app A\nGiven\nWhen\n scenario s on=E each=M as m each=M\n  do\n   set m {x=1}\nThen\n",
            Some("E1202"),
        ),
    ];
    for (name, text, code) in cases {
        match format_source(SourceId(0), text) {
            Ok(formatted) => panic!("{name}: expected error, got {formatted:?}"),
            Err(error) => {
                assert!(
                    !error.diagnostics.is_empty(),
                    "{name}: must carry diagnostics"
                );
                for diagnostic in &error.diagnostics {
                    let code = diagnostic.code;
                    assert!(code.starts_with("E1"), "{name}: expected E1xxx, got {code}");
                }
                if let Some(code) = code {
                    assert!(
                        error.diagnostics.iter().any(|d| d.code == code),
                        "{name}: expected {code} in {:?}",
                        error.diagnostics.iter().map(|d| d.code).collect::<Vec<_>>()
                    );
                }
            }
        }
    }
}

// The three tests below are verbatim from the track-D shelf (un-ignored
// once the PR4 grammar catch-up merged).

#[test]
fn judgment_items_format() {
    let formatted = format_fixed_point(
        "app A\nGiven\n export judgment  Review  version=1\n  factual  noul  \"Supported?\"  yes = \"Yes\"  no = \"No\"\n  readiness  score  \"Ready?\"[low = \"Low\" , high = \"High\"]\n  pick  choice  \"Pick?\"{a = \"A\" , b = \"B\"}\n  smart  choice  \"Smart?\"  options = runtime{none = \"None\"}\nWhen\nThen\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n export judgment Review version=1\n  factual noul \"Supported?\" yes=\"Yes\" no=\"No\"\n  readiness score \"Ready?\" [low=\"Low\",high=\"High\"]\n  pick choice \"Pick?\" {a=\"A\",b=\"B\"}\n  smart choice \"Smart?\" options=runtime {none=\"None\"}\nWhen\nThen\n"
    );
    assert!(formatted.changed);
}

#[test]
fn corpus_gallery_catalog_slot_and_edit_format() {
    let formatted = format_fixed_point(
        "app A\nGiven\n corpus  Handbook  model = Revision  scope = site  title = title  content = body , attachments  where = live(row)  from = deployment.knowledge\nWhen\nThen\n page  /handbook  title = \"Handbook\"@{nl=\"Handboek\"}\n  ## Section comment.   \n  # Gallery prose.\n  gallery  Revision  as  revision  where  live(revision)  image = cover\n   title  row.title\n   text  row.body\n  countdown(row.updated+7d)-now\n  badge  \"New\" ; countdown (row.updated)-now\n  modal  \"Notice\"  open = show\n   slot  content\n    text  row.body\n  edit  fields = title , body\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n corpus Handbook model=Revision scope=site title=title content=body,attachments where=live(row) from=deployment.knowledge\nWhen\nThen\n page /handbook title=\"Handbook\"@{nl=\"Handboek\"}\n  ## Section comment.\n  # Gallery prose.\n  gallery Revision as revision where live(revision) image=cover\n   title row.title\n   text row.body\n  countdown (row.updated+7d)-now\n  badge \"New\"; countdown (row.updated)-now\n  modal \"Notice\" open=show\n   slot content\n    text row.body\n  edit fields=title,body\n"
    );
    assert!(formatted.changed);
}

#[test]
fn invocation_and_group_heads_format() {
    let formatted = format_fixed_point(
        "app A\nGiven\n M {x:int , call : invocation( A.update , B )?}\nWhen\n scenario s(m:M) by=members\n  do\n   let v = invocation( A.update , { record = m } )\nThen\n page /m title=\"M\"\n  gallery(items) image=cover\n",
    );
    assert_eq!(
        formatted.text,
        "app A\nGiven\n M { x:int, call:invocation(A.update,B)? }\nWhen\n scenario s(m:M) by=members\n  do\n   let v=invocation(A.update,{record=m})\nThen\n page /m title=\"M\"\n  gallery (items) image=cover\n"
    );
    assert!(formatted.changed);
}
