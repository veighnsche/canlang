#![allow(dead_code)]
#[path = "../../../compiler/src/json.rs"] mod json;
#[path = "../../../compiler/src/source.rs"] mod source;
#[path = "../../../compiler/src/diagnostic.rs"] mod diagnostic;
#[path = "../../../compiler/src/lsp/transport.rs"] mod transport;
use json::Json;
fn main() {
    let payload = Json::Obj(vec![("z".into(), Json::Num("1e0".into())), ("z".into(), Json::Num("-0".into()))]);
    assert_eq!(transport::response_ok(&Json::Num("-0".into()), payload.clone()), r#"{"jsonrpc":"2.0","id":-0,"result":{"z":1e0,"z":-0}}"#);
    assert_eq!(transport::notification("é😀\u{8}\u{c}\n\\\"", payload), "{\"jsonrpc\":\"2.0\",\"method\":\"é😀\\u0008\\u000c\\n\\\\\\\"\",\"params\":{\"z\":1e0,\"z\":-0}}");
    assert_eq!(transport::response_err(None, i64::MIN, "é😀\u{8}\u{c}"), "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-9223372036854775808,\"message\":\"é😀\\u0008\\u000c\"}}");
    assert_eq!(transport::response_ok(&Json::Bool(true), Json::Num("hand-built".into())), r#"{"jsonrpc":"2.0","id":true,"result":hand-built}"#);
    assert_eq!(transport::response_err(Some(&Json::Arr(vec![])), 0, ""), r#"{"jsonrpc":"2.0","id":[],"error":{"code":0,"message":""}}"#);
    let text = "é😀\r\nZ"; let index = source::LineIndex::new(text);
    assert_eq!(index.to_lsp(text, 2, true), (0, 1));
    assert_eq!(index.to_lsp(text, 4, true), (0, 1));
    assert_eq!(index.to_lsp(text, 6, true), (0, 3));
    assert_eq!(index.to_lsp(text, 7, true), (0, 3));
    assert_eq!(index.to_lsp(text, 8, true), (1, 0));
    assert_eq!(index.to_lsp(text, 99, true), (1, 1));
    let body = transport::notification("é😀", Json::Null); let mut bytes = vec![];
    transport::write_message(&mut bytes, body.as_bytes()).unwrap();
    assert_eq!(bytes, format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes());
    println!("PASS: exact helper bytes, ordered duplicate fields, raw lexemes, hand-built invalid JSON/unadmitted IDs, errors, Unicode/control escapes, UTF16/CRLF clamps, and UTF8 frame byte count");
}
