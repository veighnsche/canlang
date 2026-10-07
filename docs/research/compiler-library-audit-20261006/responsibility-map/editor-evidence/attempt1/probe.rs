//! Audit-only observer of public Server scheduling and actual diagnostics history.
use canlang_compiler::lsp::server::{Server,LanguageAnalysis,RealAnalysis,TextPos,LspRange,CompletionItem,DocLocation,TextEdit,CodeAction};
use canlang_compiler::lsp::transport as t;
use canlang_compiler::source::{SourceDb,SourceId};
use canlang_compiler::diagnostic::Diagnostic;
use serde_json::{json,Value};
use std::sync::{Arc,Mutex};
struct Observed { real:RealAnalysis, stats:Arc<Mutex<Vec<Value>>> }
impl LanguageAnalysis for Observed {
 fn diagnostics(&self,db:&SourceDb,id:SourceId)->Vec<Diagnostic>{
  let now=std::time::Instant::now();let d=self.real.diagnostics(db,id);
  self.stats.lock().unwrap().push(json!({"retained_sources":db.len(),"retained_text_bytes":db.iter().map(|(_,s)|s.text.len()).sum::<usize>(),"current_id":id.0,"current_text_sha256":db.get(id).unwrap().sha256,"current_path":db.get(id).unwrap().path,"codes":d.iter().map(|d|d.code).collect::<Vec<_>>(),"diagnostic_microseconds":now.elapsed().as_micros()}));d
 }
 fn hover(&self,db:&SourceDb,id:SourceId,p:TextPos)->Option<String>{self.real.hover(db,id,p)}
 fn completions(&self,db:&SourceDb,id:SourceId,p:TextPos)->Vec<CompletionItem>{self.real.completions(db,id,p)}
 fn definition(&self,db:&SourceDb,id:SourceId,u:&str,p:TextPos)->Vec<DocLocation>{self.real.definition(db,id,u,p)}
 fn references(&self,db:&SourceDb,id:SourceId,u:&str,p:TextPos)->Vec<DocLocation>{self.real.references(db,id,u,p)}
 fn rename(&self,db:&SourceDb,id:SourceId,p:TextPos,n:&str)->Vec<TextEdit>{self.real.rename(db,id,p,n)}
 fn semantic_tokens(&self,db:&SourceDb,id:SourceId)->Vec<u32>{self.real.semantic_tokens(db,id)}
 fn code_actions(&self,db:&SourceDb,id:SourceId,u:&str,r:LspRange)->Vec<CodeAction>{self.real.code_actions(db,id,u,r)}
}
fn send(s:&mut Server<Observed>,v:Value)->Vec<Value>{s.handle_json(&t::parse(&v.to_string()).unwrap()).iter().map(|b|serde_json::from_str(b).unwrap()).collect()}
fn note(m:&str,p:Value)->Value{json!({"jsonrpc":"2.0","method":m,"params":p})}
fn open(u:&str,v:i32,text:&str)->Value{note("textDocument/didOpen",json!({"textDocument":{"uri":u,"languageId":"can","version":v,"text":text}}))}
fn close(u:&str)->Value{note("textDocument/didClose",json!({"textDocument":{"uri":u}}))}
fn change(u:&str,v:i32,text:&str)->Value{note("textDocument/didChange",json!({"textDocument":{"uri":u,"version":v},"contentChanges":[{"text":text}]}))}
fn main(){
 let mode=std::env::args().nth(1).unwrap();let stats=Arc::new(Mutex::new(Vec::new()));let mut s=Server::new(Observed{real:RealAnalysis::new(None),stats:stats.clone()});
 send(&mut s,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}));
 let a="app T\nGiven\n Item {title:text}\nWhen\nThen\n";let b="app T\nGiven\n Item {title:text,amount:int}\nWhen\nThen\n";let u="untitled:epoch";
 if mode=="batch"{
  send(&mut s,open(u,1,a));send(&mut s,close(u));send(&mut s,open(u,1,b));let pending=s.pending_count();let notes=s.pump();
  send(&mut s,change(u,2,a));send(&mut s,json!({"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}));let after_shutdown=s.pump();
  println!("{}",json!({"same_version_reopen_pending":pending,"same_version_reopen_publications":notes.iter().map(|b|serde_json::from_str::<Value>(b).unwrap()).collect::<Vec<_>>(),"after_shutdown_publications":after_shutdown.iter().map(|b|serde_json::from_str::<Value>(b).unwrap()).collect::<Vec<_>>(),"stats":*stats.lock().unwrap(),"scope":"public delayed pump; production pumps after each frame, so no actual async stale result proven"}));
 }else{
  let mut stages=Vec::new();let filler="x".repeat(8192);
  for v in 1..=96 {let text=format!("{a}## {v} {filler}\n");if v==1 {send(&mut s,open(u,v,&text));}else{send(&mut s,change(u,v,&text));}s.pump();if [1,16,32,64,96].contains(&v){stages.push(json!({"kind":"distinct","version":v,"sample":stats.lock().unwrap().last().unwrap()}));}}
  let last=format!("{a}## 96 {filler}\n");
  for v in 97..=128{send(&mut s,change(u,v,&last));s.pump();}stages.push(json!({"kind":"identical-text","sample":stats.lock().unwrap().last().unwrap()}));
  send(&mut s,close(u));let closed_notes=s.pump();send(&mut s,open(u,1,&last));s.pump();stages.push(json!({"kind":"same-text-after-close","sample":stats.lock().unwrap().last().unwrap()}));
  let samples=stats.lock().unwrap().clone();
  println!("{}",json!({"stages":stages,"analysis_calls":samples.len(),"pending_after_pumps":s.pending_count(),"closed_pump_notifications":closed_notes.len(),"samples":samples,"scope":"RealAnalysis delegated unchanged; stats inspect public callback SourceDb; timing is observational single-host, not isolated lint cost or workload benefit"}));
 }
}
