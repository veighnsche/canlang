extern crate canlang_compiler;
#[path="pinned/compiler/src/source.rs"] mod source;
mod diagnostic { pub use canlang_compiler::diagnostic::push_json_str; }
mod codegen {
 pub mod js { use crate::source::Span;
 #[derive(Debug,Clone)] pub struct JsLine {pub line:u32,pub span:Span,pub name:Option<String>}
 }
 #[path="/private/tmp/canlang-pass8-consumer/pinned/compiler/src/codegen/sourcemap.rs"] pub mod sourcemap;
}
use source::{SourceDb,Span,LineIndex};
use codegen::{js::JsLine,sourcemap};
fn main(){
 let text="é😀x\r\né😀y\r\n"; let mut db=SourceDb::new(); let id=db.add("coordinate.can".into(),text.into());
 let offsets=[0,2,6,7,8,9,15,16,17,18];
 let lines=offsets.iter().enumerate().map(|(i,&start)|JsLine{line:i as u32+1,span:Span::new(id,start,start),name:None}).collect::<Vec<_>>();
 let map=sourcemap::build("witness.mjs",&db,&lines);println!("{}",sourcemap::to_json(&map));
 for start in offsets {eprintln!("offset={start},byte={:?},lsp={:?}",LineIndex::new(text).line_col(text,start),LineIndex::new(text).to_lsp(text,start,true));}
}
