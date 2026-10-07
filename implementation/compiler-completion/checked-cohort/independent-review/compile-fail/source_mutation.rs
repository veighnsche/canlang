use canlang_compiler::source::{SourceDb,SourceId}; fn main() { let mut db=SourceDb::new(); db.add("x".into(), "x".into()); db.get(SourceId(0)).unwrap().text.clear(); }
