//! Audit-only observer of public Server scheduling and actual diagnostics history.
use canlang_compiler::lsp::server::{Server,LanguageAnalysis,RealAnalysis,TextPos,LspRange,CompletionItem,DocLocation,TextEdit,CodeAction};
use canlang_compiler::lsp::transport as t;
use canlang_compiler::source::{SourceDb,SourceId};
use canlang_compiler::diagnostic::Diagnostic;
use serde_json::{json,Value};
use std::sync::{Arc,Mutex};
struct Observed { real:RealAnalysis, stats:Arc<Mutex<Vec<Value>>>, held:Mutex<Option<canlang_compiler::analysis::CheckedProgram>> }
impl LanguageAnalysis for Observed {
 fn diagnostics(&self,db:&SourceDb,id:SourceId)->Vec<Diagnostic>{
  let now=std::time::Instant::now();let d=self.real.diagnostics(db,id);
  let prior=self.held.lock().unwrap().as_ref().map(|p|canlang_compiler::codegen::ir::build(p,db,None).1.into_iter().map(|d|d.code).collect::<Vec<_>>()).unwrap_or_default();
  *self.held.lock().unwrap()=Some(canlang_compiler::analysis::check_program(db,&[id],None).0);
  self.stats.lock().unwrap().push(json!({"prior_checked_owner_codes":prior,"all_sources":db.iter().map(|(id,s)|json!({"id":id.0,"path":s.path,"sha256":s.sha256})).collect::<Vec<_>>(),"retained_sources":db.len(),"retained_text_bytes":db.iter().map(|(_,s)|s.text.len()).sum::<usize>(),"current_id":id.0,"current_text_sha256":db.get(id).unwrap().sha256,"current_path":db.get(id).unwrap().path,"codes":d.iter().map(|d|d.code).collect::<Vec<_>>(),"diagnostic_microseconds":now.elapsed().as_micros()}));d
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
 let mode=std::env::args().nth(1).unwrap();let stats=Arc::new(Mutex::new(Vec::new()));let mut s=Server::new(Observed{real:RealAnalysis::new(None),stats:stats.clone(),held:Mutex::new(None)});
 let initialized=send(&mut s,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}));
 assert!(initialized[0]["result"]["capabilities"].is_object(),"initialize must succeed before lifecycle witnesses");
 let a="app T\nGiven\n Item {title:text}\nWhen\nThen\n";let b="app T\nGiven\n Item {title:text,amount:int}\nWhen\nThen\n";let u="untitled:epoch";
 if mode=="multi"{
  let uris=["file:///tmp/a.can","file:///tmp/b.can","untitled:live"];
  let filler="x".repeat(8192);let mut live=std::collections::BTreeMap::new();let mut copied=0;let mut prototype_us=0;
  for (i,u) in uris.iter().enumerate(){let text=format!("app Doc{i}\nGiven\n Item {{title:text}}\nWhen\nThen\n## {filler}\n");live.insert(*u,text.clone());send(&mut s,open(u,1,&text));}
  for v in 2..=33 {let u=uris[(v as usize)%3];let text=format!("app Doc{}\nGiven\n Item {{title:text}}\nWhen\nThen\n## edit {v} {filler}\n",(v as usize)%3);live.insert(u,text.clone());send(&mut s,change(u,v,&text));
    let start=std::time::Instant::now();let mut candidate=SourceDb::new();for (uri,text) in &live {copied+=text.len();candidate.add(uri.to_string(),text.clone());}prototype_us+=start.elapsed().as_micros();assert_eq!(candidate.len(),3);
    if v%8==0{s.pump();}
  }
  let remaining=s.pending_count();let final_notes=s.pump();send(&mut s,close(uris[1]));live.remove(uris[1]);s.pump();send(&mut s,open(uris[1],1,&format!("{b}## {filler}\n")));s.pump();
  println!("{}",json!({"samples":*stats.lock().unwrap(),"remaining_before_final_pump":remaining,"final_publications":final_notes.len(),"pending_after_pump":s.pending_count(),"candidate_rebuilds":32,"candidate_copied_bytes":copied,"candidate_rebuild_microseconds_total":prototype_us,"scope":"3 roughly8KiB documents,32 distinct changes; candidate SourceDb-only all-live rebuild cost is observational and excludes queue/server work, not production latency guarantee"}));
 }else if mode=="closure"{
  let other="untitled:other";
  send(&mut s,open(u,1,a));send(&mut s,open(other,1,b));
  for v in 2..=18 {send(&mut s,change(u,v,&format!("{a}## edit {v}\n")));}
  let queued=s.pending_count();let notes=s.pump();
  send(&mut s,close(u));send(&mut s,open(u,1,a));send(&mut s,close(other));let reopened=s.pump();
  let mut db=SourceDb::new();let old=db.add("held.can".into(),a.into());
  let (checked,_)=canlang_compiler::analysis::check_program(&db,&[old],None);
  for v in 1..=24 {db.add("held.can".into(),format!("{a}## public edit {v}\n"));}
  assert_eq!(db.get(old).unwrap().text,a);assert_eq!(checked.checked_files(),&[old]);
  let (_,same)=canlang_compiler::codegen::ir::build(&checked,&db,None);
  let mut replacement=SourceDb::new();replacement.add("held.can".into(),a.into());
  let (_,foreign)=canlang_compiler::codegen::ir::build(&checked,&replacement,None);
  assert!(same.iter().all(|d|d.code!="E6011"));assert_eq!(foreign.iter().map(|d|d.code).collect::<Vec<_>>(),vec!["E6011"]);
  let mut history=SourceDb::new();let obsolete=history.add("lint.can".into(),"app T\nGiven\n #\n Item {title:text}\nWhen\nThen\n".into());
  let selected=history.add("lint.can".into(),a.into());let (program,_)=canlang_compiler::analysis::check_program(&history,&[selected],None);
  let findings=canlang_compiler::lint::driver::lint_program(&program,&history,&canlang_compiler::lint::driver::LintConfig::default());
  println!("{}",json!({"queued_before_pump":queued,"publications":notes.len(),"reopen_publications":reopened.len(),"pending_after_pump":s.pending_count(),"samples":*stats.lock().unwrap(),"held_id":old.0,"held_text_unchanged":db.get(old).unwrap().text==a,"held_checked_ids":checked.checked_files().iter().map(|id|id.0).collect::<Vec<_>>(),"public_retained_sources":db.len(),"same_owner_codes":same.iter().map(|d|d.code).collect::<Vec<_>>(),"fresh_owner_codes":foreign.iter().map(|d|d.code).collect::<Vec<_>>(),"unchecked_history_id":obsolete.0,"selected_id":selected.0,"lint_files":findings.iter().map(|d|d.primary.file.0).collect::<Vec<_>>()}));
 }else if mode=="batch"{
  send(&mut s,open(u,1,a));send(&mut s,close(u));send(&mut s,open(u,1,b));let pending=s.pending_count();let notes=s.pump();
  send(&mut s,change(u,2,a));send(&mut s,json!({"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}));let after_shutdown=s.pump();
  println!("{}",json!({"same_version_reopen_pending":pending,"same_version_reopen_publications":notes.iter().map(|b|serde_json::from_str::<Value>(b).unwrap()).collect::<Vec<_>>(),"after_shutdown_publications":after_shutdown.iter().map(|b|serde_json::from_str::<Value>(b).unwrap()).collect::<Vec<_>>(),"stats":*stats.lock().unwrap(),"scope":"public delayed pump; production pumps after each frame, so no actual async stale result proven"}));
 }else{
  let mut stages=Vec::new();let filler="x".repeat(1024);
  for v in 1..=48 {let text=format!("{a}## {v} {filler}\n");if v==1 {send(&mut s,open(u,v,&text));}else{send(&mut s,change(u,v,&text));}s.pump();if [1,8,16,32,48].contains(&v){stages.push(json!({"kind":"distinct","version":v,"sample":stats.lock().unwrap().last().unwrap()}));}}
  let last=format!("{a}## 48 {filler}\n");
  for v in 49..=64{send(&mut s,change(u,v,&last));s.pump();}stages.push(json!({"kind":"identical-text","sample":stats.lock().unwrap().last().unwrap()}));
  send(&mut s,close(u));let closed_notes=s.pump();send(&mut s,open(u,1,&last));s.pump();stages.push(json!({"kind":"same-text-after-close","sample":stats.lock().unwrap().last().unwrap()}));
  let samples=stats.lock().unwrap().clone();
  println!("{}",json!({"stages":stages,"analysis_calls":samples.len(),"pending_after_pumps":s.pending_count(),"closed_pump_notifications":closed_notes.len(),"samples":samples,"scope":"RealAnalysis delegated unchanged; stats inspect public callback SourceDb; timing is observational single-host, not isolated lint cost or workload benefit"}));
 }
}
