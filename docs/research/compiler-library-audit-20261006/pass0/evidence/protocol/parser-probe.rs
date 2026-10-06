// Exact defining modules; renderer stub is unreachable in these parsing/framing-only probes.
mod diagnostic { pub fn push_json_str(_: &mut String, _: &str) { panic!("renderer outside probe scope") } }
#[path="/Users/vince/Projects/canlang/compiler/src/json.rs"] mod json;
#[path="/Users/vince/Projects/canlang/compiler/src/lsp/transport.rs"] mod transport;
fn main() {
 for s in ["-0","1e0","1.0","9223372036854775807","9223372036854775808","01",r#"{"id":1,"id":2}"#,r#""\uD83D\uDE00""#,r#""\uD83D""#] {
  let parsed=json::parse(s); println!("parse {s:?}: {parsed:?}; integer={:?}",parsed.as_ref().ok().and_then(json::Json::as_i64));
  if let Ok(v)=parsed { if s.starts_with('{') { println!("first id: {:?}",v.get("id")); } }
 }
 for n in [63,64,65,66] {
  for leaf in ["0",""] {
   let s=format!("{}{}{}","[".repeat(n),leaf,"]".repeat(n));
   println!("depth {n}, leaf {leaf:?}: {:?}",json::parse(&s).map(|_|"accepted"));
  }
 }
 for (name,s) in [("bare_lf",b"Content-Length: 2\n\n{}".as_slice()),("duplicate_length",b"Content-Length: 3\r\nContent-Length: 2\r\n\r\n{}"),("unsupported_charset",b"Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=latin1\r\n\r\n{}"),("plus_length",b"Content-Length: +2\r\n\r\n{}"),("oversize",b"Content-Length: 67108865\r\n\r\n"),("truncated",b"Content-Length: 3\r\n\r\n{}"),("clean_eof",b"")] {
  println!("frame {name}: {:?}",transport::read_message(&mut std::io::Cursor::new(s)));
 }
}
