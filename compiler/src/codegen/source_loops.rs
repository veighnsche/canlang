//! Private finite source-only loops. Selection is control; SEND fields retain
//! their separate DATA producer and Work owns every actual delivery.
use super::ir::*;
use crate::analysis::{ResolvedType,Scalar,SymbolId};
use crate::source::Span;
use std::collections::{BTreeSet,HashMap};

fn predicate(ir:&IrProgram,value:&TypedExpr,alias:&str,model:SymbolId,depth:usize)->bool{
    if depth>32{return false;}
    let child=|value:&TypedExpr|predicate(ir,value,alias,model,depth+1);
    match &value.expr{
        IrExpr::Text(_)|IrExpr::Int(_)|IrExpr::Bool(_)|IrExpr::Null|IrExpr::Decimal(_)=>true,
        IrExpr::Array(values)=>values.len()<=200&&values.iter().all(child),
        IrExpr::Binary{left,right,..}=>child(left)&&child(right),
        IrExpr::Unary{operand,..}=>child(operand),
        IrExpr::Member{base,field}if matches!(&base.expr,IrExpr::Name(name)if name==alias)
            &&base.ty==(ResolvedType::Record{symbol:model,stored:true})=>{
            let Some(IrItem{kind:IrItemKind::Model{fields,..},..})=ir.items.get(model.0 as usize)else{return false;};
            fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field
                &&matches!(&item.kind,IrItemKind::Field{owner,ty:IrType::Known(ty),..}
                    if *owner==model&&ty==&value.ty&&matches!(ty,ResolvedType::Scalar(_)|ResolvedType::Enum{..})))
        },
        _=>false,
    }
}
fn model_corresponds(ir:&IrProgram,fresh:&IrProgram,id:SymbolId)->Option<()> {
    let (a,b)=(ir.items.get(id.0 as usize)?,fresh.items.get(id.0 as usize)?);
    let (IrItemKind::Model{owner:ao,fields:af,..},IrItemKind::Model{owner:bo,fields:bf,..})=(&a.kind,&b.kind)else{return None;};
    if a.id!=b.id||a.name!=b.name||a.canonical!=b.canonical||a.span!=b.span||a.module!=b.module||ao!=bo||af!=bf{return None;}
    let (am,bm)=(ir.modules.get(a.module.0 as usize)?,fresh.modules.get(b.module.0 as usize)?);
    if am.id!=bm.id||am.name!=bm.name||am.kind!=bm.kind||am.file!=bm.file||am.span!=bm.span{return None;}
    for id in af{
        let (a,b)=(ir.items.get(id.0 as usize)?,fresh.items.get(id.0 as usize)?);
        if a.id!=b.id||a.name!=b.name||a.canonical!=b.canonical||a.span!=b.span||a.module!=b.module{return None;}
        match (&a.kind,&b.kind){
            (IrItemKind::Field{owner:a,ty:IrType::Known(at),..},IrItemKind::Field{owner:b,ty:IrType::Known(bt),..})if a==b&&at==bt=>{},
            (IrItemKind::DeriveField{model:a,ty:IrType::Known(at),..},IrItemKind::DeriveField{model:b,ty:IrType::Known(bt),..})if a==b&&at==bt=>{},
            _=>return None,
        }
    }
    Some(())
}
fn body_counts(ir:&IrProgram,fresh:&IrProgram,body:&[IrStmt],item:&str,model:SymbolId,values:&BTreeSet<String>)->Option<(usize,usize)>{
    let mut writes=0;let mut sends=0;let mut deliveries=HashMap::new();
    for statement in body{match statement{
        IrStmt::Set{record,changes,when:None,..}if matches!(&record.expr,IrExpr::Name(name)if name==item)
            &&record.ty==(ResolvedType::Record{symbol:model,stored:true})
            &&super::source_send_data::send_value(ir,changes,values,0)=>{writes+=1;},
        IrStmt::Send{operation,deployment_binding:Some(_),binding,when:None,..}=>{
            sends+=1;if let Some(name)=binding{if deliveries.insert(name,operation).is_some(){return None;}}
        },
        IrStmt::Create{model:created,input,when:None,..}=>{
            let target=ir.items.iter().find(|candidate|candidate.canonical==*created)?;
            if !matches!(target.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==model){return None;}
            model_corresponds(ir,fresh,target.id)?;
            let IrExpr::Object(fields)=&input.expr else{return None;};
            if fields.iter().filter(|(field,_)|field=="parent").count()!=1{return None;}
            for (field,value) in fields{
                if field=="parent"{
                    if !matches!(&value.expr,IrExpr::Name(name)if name==item)||value.ty!=(ResolvedType::Record{symbol:model,stored:true}){return None;}
                }else if !super::source_send_data::send_value(ir,value,values,0){
                    let (IrExpr::Name(name),ResolvedType::StdDelivery{capability,op})=(&value.expr,&value.ty)else{return None;};
                    if deliveries.get(name).map(|op|op.as_str())!=Some(format!("{capability}.{}",op.name).as_str()){return None;}
                }
            }
            writes+=1;
        },
        _=>return None,
    }}
    (writes>0&&writes<=4&&sends>0&&sends<=2).then_some((writes,sends))
}
pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<serde_json::Value>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=&requires.values().find(|source|source["owner"]==owner.canonical)?["source"];
    super::scenario_decisions::same_scenario_semantics(context.original(),ir,context.fresh(),owner)?;
    let roots:HashMap<_,_>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};Some((param.name.clone(),*symbol))}).collect();
    let values:BTreeSet<_>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};super::source_send_data::plain_value(ir,ty,0).then(||param.name.clone())}).collect();
    fn walk(ir:&IrProgram,fresh:&IrProgram,owner:&IrItem,body:&[IrStmt],roots:&mut HashMap<String,SymbolId>,values:&mut BTreeSet<String>,source:&serde_json::Value,out:&mut Vec<serde_json::Value>)->Option<()>{
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=super::source_send_data::send_value(ir,value,values,0);roots.remove(name);values.remove(name);if pure{values.insert(name.clone());}},
            IrStmt::For{item,domain,limit:Some(limit),body,span}=>{
                let IrExpr::Int(maximum)=limit.expr else{return None;};if !(1..=200).contains(&maximum)||out.len()>=200{return None;}
                let IrExpr::Query(query)=&domain.expr else{return None;};let IrQueryDomain::Model(model)=&query.domain else{return None;};
                let parent=query.parent.as_deref()?;let IrExpr::Name(parameter)=&parent.expr else{return None;};let parent_model=*roots.get(parameter)?;if item==parameter{return None;}
                let model=ir.items.iter().find(|candidate|candidate.canonical==*model)?;
                if !matches!(model.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==parent_model)
                    ||parent.ty!=(ResolvedType::Record{symbol:parent_model,stored:true})
                    ||!matches!(&domain.ty,ResolvedType::Array{element,ordered:true,..}if element.as_ref()==&ResolvedType::Record{symbol:model.id,stored:true})
                    ||query.select.is_some()||query.select_param.is_some()||!query.order.is_empty()||query.value_order.is_some()
                    ||query.limit.is_some()||query.archived.is_some()||query.where_async
                    ||query.where_pred.as_deref().is_some_and(|value|value.ty!=ResolvedType::Scalar(Scalar::Bool)||!predicate(ir,value,&query.where_param,model.id,0))
                {return None;}
                model_corresponds(ir,fresh,parent_model)?;model_corresponds(ir,fresh,model.id)?;
                let (writes,sends)=body_counts(ir,fresh,body,item,model.id,values)?;
                let id=crate::source::sha256_hex(format!("source-body-loop/v1:{}:{}:{}:{}:{}",source["path"],source["sha256"],owner.canonical,span.start,span.end).as_bytes());
                out.push(serde_json::json!({"id":id,"node":{"start":span.start,"end":span.end},"domain":{"start":domain.span.start,"end":domain.span.end},
                    "maximum":maximum,"parameter":parameter,"parentModel":ir.items[parent_model.0 as usize].canonical,"model":model.canonical,
                    "item":item,"filtered":query.where_pred.is_some(),"writes":writes,"sends":sends}));
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,fresh,owner,then_branch,&mut roots.clone(),&mut values.clone(),source,out)?;walk(ir,fresh,owner,else_branch,&mut roots.clone(),&mut values.clone(),source,out)?;},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,fresh,owner,&arm.body,&mut roots.clone(),&mut values.clone(),source,out)?;},
            _=>{},
        }}Some(())
    }
    let mut loops=Vec::new();walk(ir,context.fresh(),owner,effects,&mut roots.clone(),&mut values.clone(),source,&mut loops)?;
    if loops.is_empty()||loops.iter().filter_map(|loop_|loop_["maximum"].as_u64()).sum::<u64>()>200||loops.iter().filter_map(|loop_|Some(loop_["maximum"].as_u64()?*loop_["sends"].as_u64()?)).sum::<u64>()>200{return None;}
    Some(serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},"owner":owner.canonical,"loops":loops}))
}
