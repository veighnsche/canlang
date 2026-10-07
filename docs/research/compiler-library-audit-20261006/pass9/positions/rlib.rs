extern crate canlang_compiler;use canlang_compiler::{source::LineIndex,ide::queries::offset_at_position,docs::portable_source_id};use std::path::Path;
fn main(){
{let t="";let i=LineIndex::new(t);println!("forward 0: {:?} {:?} {:?}",i.line_col(t,0),i.to_lsp(t,0,true),i.to_lsp(t,0,false));}
{let t="é😀x";let i=LineIndex::new(t);println!("forward 1: {:?} {:?} {:?}",i.line_col(t,6),i.to_lsp(t,6,true),i.to_lsp(t,6,false));}
{let t="é😀x";let i=LineIndex::new(t);println!("forward 2: {:?} {:?} {:?}",i.line_col(t,4),i.to_lsp(t,4,true),i.to_lsp(t,4,false));}
{let t="é😀x";let i=LineIndex::new(t);println!("forward 3: {:?} {:?} {:?}",i.line_col(t,99),i.to_lsp(t,99,true),i.to_lsp(t,99,false));}
{let t="ab\r\nc";let i=LineIndex::new(t);println!("forward 4: {:?} {:?} {:?}",i.line_col(t,2),i.to_lsp(t,2,true),i.to_lsp(t,2,false));}
{let t="ab\r\nc";let i=LineIndex::new(t);println!("forward 5: {:?} {:?} {:?}",i.line_col(t,3),i.to_lsp(t,3,true),i.to_lsp(t,3,false));}
{let t="ab\r\nc";let i=LineIndex::new(t);println!("forward 6: {:?} {:?} {:?}",i.line_col(t,4),i.to_lsp(t,4,true),i.to_lsp(t,4,false));}
{let t="a\rb";let i=LineIndex::new(t);println!("forward 7: {:?} {:?} {:?}",i.line_col(t,2),i.to_lsp(t,2,true),i.to_lsp(t,2,false));}
{let t="a\r";let i=LineIndex::new(t);println!("forward 8: {:?} {:?} {:?}",i.line_col(t,2),i.to_lsp(t,2,true),i.to_lsp(t,2,false));}
{let t="a\n";let i=LineIndex::new(t);println!("forward 9: {:?} {:?} {:?}",i.line_col(t,2),i.to_lsp(t,2,true),i.to_lsp(t,2,false));}
println!("reverse 0: {:?}",offset_at_position("é😀x",0,2));
println!("reverse 1: {:?}",offset_at_position("é😀x",0,3));
println!("reverse 2: {:?}",offset_at_position("é😀x",0,99));
println!("reverse 3: {:?}",offset_at_position("ab\r\nc",0,99));
println!("reverse 4: {:?}",offset_at_position("a\r",0,2));
println!("reverse 5: {:?}",offset_at_position("a\r",0,99));
println!("reverse 6: {:?}",offset_at_position("a\n",1,0));
println!("reverse 7: {:?}",offset_at_position("a\n",2,0));
println!("path 0: {}",portable_source_id("real.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 1: {}",portable_source_id("./real.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 2: {}",portable_source_id("link.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 3: {}",portable_source_id("/private/tmp/canlang-pass9-positions/fs/root/real.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 4: {}",portable_source_id("a/../absent.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 5: {}",portable_source_id("../outside.can",Path::new("/private/tmp/canlang-pass9-positions/fs/root")));
println!("path 6: {}",portable_source_id("../../x",Path::new("../missing")));
println!("path 7: {}",portable_source_id("../../x",Path::new("../../missing")));
println!("path 8: {}",portable_source_id("/private/tmp/canlang-pass9-positions/missing/root/x",Path::new("/private/tmp/canlang-pass9-positions/missing/root")));
}