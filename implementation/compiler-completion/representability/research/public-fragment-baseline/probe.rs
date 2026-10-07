use canlang_compiler::source::SourceId;
use canlang_compiler::syntax::lex_fragment;

fn main() {
    let case = std::env::args().nth(1).expect("case");
    let m = u32::MAX;
    let (fragment, base) = match case.as_str() {
        "normal" => ("a + b", 100),
        "empty-max" => ("", m),
        "name-fit" => ("a", m - 1),
        "name-overflow" => ("a", m),
        "multi-fit" => ("a + b", m - 5),
        "multi-overflow" => ("a + b", m - 4),
        "utf8-fit" => ("\"é\"", m - 4),
        "utf8-overflow" => ("\"é\"", m - 3),
        "tab-fit" => ("\t", m - 1),
        "hash-fit" => ("#", m - 1),
        _ => panic!("unknown case"),
    };
    println!("case={case} base={base} bytes={}", fragment.len());
    let mut diagnostics = Vec::new();
    let tokens = lex_fragment(SourceId(0), fragment, base, &mut diagnostics);
    for token in tokens {
        println!("token={:?} span={}..{} payload={:?}", token.kind, token.span.start, token.span.end, token.string_value);
    }
    for diagnostic in diagnostics {
        println!("diagnostic={} span={}..{} message={}", diagnostic.code, diagnostic.primary.start, diagnostic.primary.end, diagnostic.message);
    }
    println!("normal-return");
}
