use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--token") {
        let raw = args.get(2).expect("token argument");
        match canlang_compiler::syntax::lexer::decode_json_string(raw, 0, canlang_compiler::source::SourceId(0)) {
            Ok(value) => println!("{{\"valid\":true,\"codepoints\":{:?}}}", value.chars().map(|c| c as u32).collect::<Vec<_>>()),
            Err((_message, span)) => println!("{{\"valid\":false,\"start\":{},\"end\":{}}}", span.start, span.end),
        }
        return;
    }
    for text in ["", "abc", "é😀", "a\r\nb\n"] {
        println!("hash_bytes={:?} sha256={}", text.as_bytes(), sha256_hex(text.as_bytes()));
    }
    for size in [55usize, 56, 63, 64, 65] {
        println!("hash_repeat_a={size} sha256={}", sha256_hex(&vec![b'a'; size]));
    }
    let mut db = SourceDb::new();
    let id = db.add("unicode.can".into(), "é😀x\r\n".into());
    let mut diagnostics = DiagnosticResult::new("pass0", "1.0", 1);
    diagnostics.push(Diagnostic::error("E3001", "controls \u{0008}\u{000c} and 😀".into(), Span::new(id, 6, 7)));
    diagnostics.add_sources(&db);
    diagnostics.finish();
    println!("diagnostic={}", diagnostics.to_json());
    let mut map_db = SourceDb::new();
    let map_id = map_db.add("unicode.can".into(), "é😀x".into());
    let map = canlang_compiler::codegen::sourcemap::build("unicode.mjs", &map_db,
        &[canlang_compiler::codegen::js::JsLine {line:1,span:Span::new(map_id,6,7),name:None}]);
    println!("map={}", canlang_compiler::codegen::sourcemap::to_json(&map));
}
