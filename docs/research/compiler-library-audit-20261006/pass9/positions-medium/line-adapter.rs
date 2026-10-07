extern crate line_index;
use std::path::{Path,PathBuf};
#[derive(Debug, Clone)]
pub struct LineIndex { inner: line_index::LineIndex }
impl LineIndex {
 pub fn new(text: &str) -> Self { Self { inner: line_index::LineIndex::new(text) } }
 fn position(&self,text:&str,offset:u32)->(usize,line_index::LineCol) {
  let mut offset=offset.min(text.len() as u32) as usize;
  while !text.is_char_boundary(offset) {offset-=1;}
  (offset,self.inner.line_col((offset as u32).into()))
 }
 pub fn line_col(&self,text:&str,offset:u32)->(usize,usize) {
  let raw=offset.min(text.len() as u32) as usize;
  let (boundary,p)=self.position(text,offset);
  let mut col=p.col as usize+raw-boundary;
  if raw>0 && text.as_bytes().get(raw-1)==Some(&b'\r') && text.as_bytes().get(raw)==Some(&b'\n') {col=col.saturating_sub(1);}
  (p.line as usize+1,col+1)
 }
 pub fn to_lsp(&self,text:&str,offset:u32,utf16:bool)->(u32,u32) {
  let (offset,mut p)=self.position(text,offset);
  if offset>0 && text.as_bytes().get(offset-1)==Some(&b'\r') && text.as_bytes().get(offset)==Some(&b'\n') {p.col=p.col.saturating_sub(1);}
  if utf16 {let wide=self.inner.to_wide(line_index::WideEncoding::Utf16,p).unwrap();(wide.line,wide.col)} else {(p.line,p.col)}
 }
}
pub fn offset_at_position(text:&str,line:u32,character:u32)->Option<u32> {
 let index=LineIndex::new(text);
 let range=index.inner.line(line)?;
 let start=u32::from(range.start()) as usize;
 let end=u32::from(range.end()) as usize;
 let raw=&text[start..end];
 let content=if let Some(without_lf)=raw.strip_suffix('\n') {without_lf.strip_suffix('\r').unwrap_or(without_lf)} else {raw};
 let p=index.inner.to_utf8(line_index::WideEncoding::Utf16,line_index::WideLineCol {line,col:character.min(content.encode_utf16().count() as u32)})?;
 let mut col=(p.col as usize).min(content.len());
 while !content.is_char_boundary(col) {col-=1;}
 Some((start+col) as u32)
}
pub fn portable_source_id(path: &str, root: &Path) -> String {
    let candidate = Path::new(path);
    let joined: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if let Ok(canonical_path) = std::fs::canonicalize(&joined) {
        if let Ok(rel) = canonical_path.strip_prefix(&canonical_root) {
            return rel_to_portable(rel);
        }
        return format!("external:{}", canonical_path.to_string_lossy());
    }
    let normalized = lexical_normalize(&joined);
    if let Ok(rel) = normalized.strip_prefix(&canonical_root) {
        return rel_to_portable(rel);
    }
    let lexical_root = lexical_normalize(root);
    if let Ok(rel) = normalized.strip_prefix(&lexical_root) {
        return rel_to_portable(rel);
    }
    format!("external:{}", normalized.to_string_lossy())
}
fn lexical_normalize(path: &Path) -> PathBuf {
    use std::path::Component::{CurDir, ParentDir};
    let mut out = PathBuf::new();
    for component in path.components() {
        if component == CurDir {
            continue;
        }
        if component == ParentDir {
            if matches!(out.components().next_back(), Some(std::path::Component::ParentDir)) || !out.pop() {
                out.push("..");
            }
            continue;
        }
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}
fn rel_to_portable(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
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
println!("path 0: {}",portable_source_id("real.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 1: {}",portable_source_id("./real.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 2: {}",portable_source_id("link.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 3: {}",portable_source_id("/private/tmp/canlang-pass9-positions-medium/fs/root/real.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 4: {}",portable_source_id("a/../absent.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 5: {}",portable_source_id("../outside.can",Path::new("/private/tmp/canlang-pass9-positions-medium/fs/root")));
println!("path 6: {}",portable_source_id("../../x",Path::new("../missing")));
println!("path 7: {}",portable_source_id("../../x",Path::new("../../missing")));
println!("path 8: {}",portable_source_id("/private/tmp/canlang-pass9-positions-medium/missing/root/x",Path::new("/private/tmp/canlang-pass9-positions-medium/missing/root")));
}