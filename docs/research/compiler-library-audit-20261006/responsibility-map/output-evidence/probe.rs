//! Audit-only observer; expectations are independently stated in run.py/report.
use canlang_compiler::{analysis, format::format_source, syntax::{parse_source,SyntaxNode,SyntaxKind,NodeDetail}};
use canlang_compiler::source::{SourceDb,SourceId,Span,LineIndex,sha256_hex};
use canlang_compiler::lint::driver::{LintConfig,RuleSet,collect_fixes,apply_fixes};
use canlang_compiler::diagnostic::{Diagnostic,DiagnosticResult,Severity};
use canlang_compiler::ide::{queries::offset_at_position,fixes::{from_lint_fix,apply_fix as ide_apply}};
use serde_json::{json,Value};
fn projection(n:&SyntaxNode,s:&str)->Option<Value> {
    if n.kind==SyntaxKind::Trivia {return None}
    let leaf=if n.children.is_empty() {
        let mut text=n.text(s).to_string();
        if matches!(n.kind,SyntaxKind::Description|SyntaxKind::Comment) {
            text=text.replace("\r\n","\n").split('\n').map(|l|l.trim_end_matches([' ','\t']).trim_start_matches(' ')).collect::<Vec<_>>().join("\n");
        }
        let decoded=match &n.detail {NodeDetail::Token(t)=>t.string_value.clone(),_=>None};
        json!({"text":text,"decoded":decoded})
    } else {Value::Null};
    Some(json!({"kind":format!("{:?}",n.kind),"leaf":leaf,"children":n.children.iter().filter_map(|c|projection(c,s)).collect::<Vec<_>>()}))
}
fn main(){
 let args:Vec<_>=std::env::args().collect();
 if args[1]=="coordinates" {
  let s="é😀x\r\né😀y";let idx=LineIndex::new(s);
  println!("{}",json!({"text":s,"forward":(0..=s.len()+2).map(|b|json!({"byte":b,"human":idx.line_col(s,b as u32),"utf16":idx.to_lsp(s,b as u32,true),"byte_lsp":idx.to_lsp(s,b as u32,false)})).collect::<Vec<_>>(),"inverse":(0..=3).flat_map(|l|(0..=7).map(move|c|json!({"line":l,"character":c,"byte":offset_at_position(s,l,c)}))).collect::<Vec<_>>()}));return
 }
 if args[1]=="diagnostics" {
  let mut a=Diagnostic::error("E3001","same".into(),Span::new(SourceId(0),0,1));a.tags=vec!["a".into()];
  let mut b=a.clone();b.tags=vec!["b".into()];
  let render=|ds:Vec<Diagnostic>|{let mut r=DiagnosticResult::new("audit","1.0",1);for d in ds{r.push(d)}r.finish();r.to_json()};
  println!("{}",json!({"ab":render(vec![a.clone(),b.clone()]),"ba":render(vec![b,a])}));return
 }
 let s=std::fs::read_to_string(&args[2]).unwrap();let (tree,ds)=parse_source(SourceId(0),&s);
 if args[1]=="format" {
  let mut out=json!({"parse_codes":ds.iter().map(|d|d.code).collect::<Vec<_>>(),"coverage":tree.verify_coverage(s.len() as u32).is_ok()});
  match format_source(SourceId(0),&s) {
   Err(e)=>out["refusal"]=json!(e.diagnostics.iter().map(|d|d.code).collect::<Vec<_>>()),
   Ok(f)=>{let (after,ads)=parse_source(SourceId(0),&f.text);let second=format_source(SourceId(0),&f.text).unwrap();let p=projection(&tree,&s);let q=projection(&after,&f.text);
    out["result"]=json!({"changed":f.changed,"text":f.text,"after_codes":ads.iter().map(|d|d.code).collect::<Vec<_>>(),"structure_equal":p==q,"before_projection_sha256":sha256_hex(p.as_ref().unwrap().to_string().as_bytes()),"after_projection_sha256":sha256_hex(q.as_ref().unwrap().to_string().as_bytes()),"idempotent":second.text==f.text&&!second.changed,"after_coverage":after.verify_coverage(f.text.len() as u32).is_ok()});
    if p!=q {out["unequal_projections"]=json!([p,q]);}
   }
  }println!("{out}");return
 }
 let mut db=SourceDb::new();let id=db.add("probe.can".into(),s.clone());let (p,ds)=analysis::check_program(&db,&[id],None);
 let cfg=LintConfig{enabled:RuleSet::all(),fix:true,deprecated:None};let fixes=collect_fixes(&p,&db,&cfg);let sha=sha256_hex(s.as_bytes());
 let applied=apply_fixes(&s,&sha,&fixes);let mut out=json!({"analysis_codes":ds.iter().map(|d|d.code).collect::<Vec<_>>(),"fixes":fixes.iter().map(|f|json!({"rule":f.rule,"range":[f.span.start,f.span.end],"replacement":f.replacement,"removed":&s[f.span.start as usize..f.span.end as usize],"expected_sha256":f.expected_sha256})).collect::<Vec<_>>()});
 if let Ok(fixed)=applied {
  let mut ndb=SourceDb::new();let nid=ndb.add("probe.can".into(),fixed.clone());let (np,nds)=analysis::check_program(&ndb,&[nid],None);
  let again=collect_fixes(&np,&ndb,&cfg);out["result"]=json!({"text":fixed,"analysis_codes":nds.iter().map(|d|d.code).collect::<Vec<_>>(),"remaining_fixes":again.len(),"batch_idempotent":apply_fixes(&fixed,&sha256_hex(fixed.as_bytes()),&again).unwrap()==fixed});
 }
 if let Some(f)=fixes.first(){let mut stale=s.clone();stale.push_str("## concurrent edit\n");let ide=from_lint_fix(f);
  out["stale"]=json!({"driver":format!("{:?}",apply_fixes(&stale,&sha256_hex(stale.as_bytes()),&fixes)),"ide":format!("{:?}",ide_apply(&stale,&ide)),"ide_fresh_matches_single":ide_apply(&s,&ide).unwrap()==canlang_compiler::lint::driver::apply_fix(&s,&sha,f).unwrap()});
  let mut bad=f.clone();bad.span=Span::new(id,0,s.len() as u32+1);out["invalid_range_rejected"]=json!(apply_fixes(&s,&sha,&[bad]).is_err());
  out["overlap_rejected"]=json!(apply_fixes(&s,&sha,&[f.clone(),f.clone()]).is_err());
 }
 println!("{out}");
}
