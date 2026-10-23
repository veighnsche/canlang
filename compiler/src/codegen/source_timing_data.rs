//! Once-evaluated original civil-time constructors through the existing DATA loan.
use super::ir::*;
use crate::analysis::{ResolvedType,Scalar,SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap,HashMap};
fn field<'a>(ir:&'a IrProgram,model:SymbolId,name:&str)->Option<&'a ResolvedType>{
 let IrItemKind::Model{fields,..}=&ir.items.get(model.0 as usize)?.kind else{return None;};
 fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find_map(|item|
  if item.name==name{match &item.kind{IrItemKind::Field{owner,ty:IrType::Known(ty),..}if *owner==model=>Some(ty),_=>None}}else{None})
}
pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
 requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
 let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
 let source=&requires.values().find(|source|source["owner"]==owner.canonical)?["source"];
 context.same_scenario(ir,owner)?;
 let roots:BTreeMap<String,SymbolId>=params.iter().filter_map(|id|{let item=ir.items.get(id.0 as usize)?;
  let IrItemKind::Param{owner:parent,ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),default:None,..}=&item.kind else{return None;};
  (*parent==owner.id).then(||(item.name.clone(),*symbol))}).collect();
 fn clock(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,value:&TypedExpr,
  roots:&BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,span:Span,name:&str,stage:usize)->Option<serde_json::Value>{
  let args=match &value.expr{
   IrExpr::Call{target:IrCallTarget::Builtin{id,awaited:false},args}if id=="local_instant"=>args,
   IrExpr::BoundCall{target:IrCallTarget::Builtin{id,awaited:false},args,slots}if id=="local_instant"&&slots.as_slice()==[Some(0),Some(1),Some(2),Some(3)]=>args,
   _=>return None,
  };
  let [date,time,zone,fold]=args.as_slice()else{return None;};
  let (IrExpr::Member{base,field:date_name},IrExpr::Text(time),IrExpr::Member{base:zone_base,field:zone_name},IrExpr::Text(fold))=(&date.expr,&time.expr,&zone.expr,&fold.expr)else{return None;};
  if date.ty!=ResolvedType::Scalar(Scalar::Date)||zone.ty!=ResolvedType::Scalar(Scalar::Timezone)||value.ty!=ResolvedType::Scalar(Scalar::Datetime)
    ||!matches!(fold.as_str(),"earlier"|"later"){return None;}
  let(parameter,model,date_path)=super::source_send_data::required_source_path(ir,base,roots)?;
  let(zone_parameter,zone_root,path)=super::source_send_data::required_source_path(ir,zone_base,roots)?;
  if !date_path.is_empty()||zone_parameter!=parameter||zone_root!=model{return None;}
  let date_type=field(ir,model,date_name)?;
  if *date_type!=date.ty&&!matches!(date_type,ResolvedType::Nullable(inner)if inner.as_ref()==&date.ty){return None;}
  let zone_model=path.last().map(|(_,model,_)|*model).unwrap_or(model);
  if field(ir,zone_model,zone_name)!=Some(&zone.ty){return None;}
  for target in std::iter::once(model).chain(path.iter().map(|(_,model,_)|*model)){super::source_loops::model_corresponds(context,target)?;}
  let path=path.iter().map(|(field,model,narrowed)|{let mut edge=serde_json::json!({"field":field,"model":ir.items[model.0 as usize].canonical});if *narrowed{edge["nullable"]=serde_json::json!(true);}edge}).collect::<Vec<_>>();
  Some(serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},"owner":owner.canonical,
   "node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,"parameter":parameter,"model":ir.items[model.0 as usize].canonical,
   "field":{"name":date_name,"type":super::source_send_data::data_type(ir,date_type)?},"valueType":"datetime",
   "clock":{"kind":"local_instant","time":time,"fold":fold,"zone":{"path":path,"field":{"name":zone_name,"type":"timezone"}}}}))
 }
 fn walk(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,body:&[IrStmt],roots:&mut BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,mut stage:usize,out:&mut HashMap<Span,serde_json::Value>)->Option<usize>{
  for statement in body{match statement{
   IrStmt::Let{name,value,span}=>{if let Some(clock)=clock(ir,owner,context,value,roots,source,module,*span,name,stage){out.insert(*span,clock);}roots.remove(name);},
   IrStmt::Set{..}|IrStmt::Create{..}|IrStmt::Delete{..}|IrStmt::Transition{..}=>stage=stage.checked_add(1)?,
   IrStmt::If{then_branch,else_branch,..}=>{let left=walk(ir,owner,context,then_branch,&mut roots.clone(),source,module,stage,out);let right=walk(ir,owner,context,else_branch,&mut roots.clone(),source,module,stage,out);if left!=right{return None;}stage=left?;},
   IrStmt::Require{..}|IrStmt::Cancel{..}|IrStmt::Schedule{..}|IrStmt::Emit{..}|IrStmt::Send{..}=>{},
   _=>return None,
  }if stage>=200{return None;}}Some(stage)
 }
 let mut out=HashMap::new();walk(ir,owner,context,effects,&mut roots.clone(),source,module,0,&mut out);Some(out)
}
