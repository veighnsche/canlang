//! Private finite source-only loops. Selection is control; SEND fields retain
//! their separate DATA producer and Work owns every actual delivery.
use super::ir::*;
use crate::analysis::{ResolvedType,Scalar,SymbolId};
use crate::source::Span;
use std::collections::{BTreeSet,HashMap,HashSet};

fn control_type(ty:&ResolvedType)->bool{match ty{
    ResolvedType::Scalar(scalar)=>!matches!(scalar,Scalar::File|Scalar::Secret|Scalar::Json|Scalar::Bytes|Scalar::Member),
    ResolvedType::Enum{..}=>true,ResolvedType::Nullable(inner)=>control_type(inner),_=>false,
}}
fn predicate(ir:&IrProgram,value:&TypedExpr,roots:&HashMap<String,SymbolId>,values:&BTreeSet<String>,stack:&mut HashSet<SymbolId>,depth:usize)->bool{
    if depth>32{return false;}
    match &value.expr{
        IrExpr::Text(_)|IrExpr::Int(_)|IrExpr::Bool(_)|IrExpr::Null|IrExpr::Decimal(_)|IrExpr::DurationMs(_)|IrExpr::Date(_)|IrExpr::Datetime(_)=>true,
        IrExpr::Name(name)=>values.contains(name)&&control_type(&value.ty),
        IrExpr::Array(entries)=>entries.len()<=200&&entries.iter().all(|entry|predicate(ir,entry,roots,values,stack,depth+1)),
        IrExpr::Binary{left,right,..}=>predicate(ir,left,roots,values,stack,depth+1)&&predicate(ir,right,roots,values,stack,depth+1),
        IrExpr::Unary{operand,..}=>predicate(ir,operand,roots,values,stack,depth+1),
        IrExpr::Member{base,field}=>{
            if field=="now"&&value.ty==ResolvedType::Scalar(Scalar::Datetime)&&base.ty==ResolvedType::Unknown
                &&matches!(&base.expr,IrExpr::Name(name)if name=="c"){return true;}
            if let IrExpr::Name(name)=&base.expr&&let Some(model)=roots.get(name){
                if base.ty!=(ResolvedType::Record{symbol:*model,stored:true}){return false;}
                let Some(IrItem{kind:IrItemKind::Model{fields,..},..})=ir.items.get(model.0 as usize)else{return false;};
                return fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|item.name==*field
                    &&matches!(&item.kind,IrItemKind::Field{owner,ty:IrType::Known(ty),..}
                        if owner==model&&control_type(ty)&&(ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))));
            }
            control_type(&base.ty)&&control_type(&value.ty)&&predicate(ir,base,roots,values,stack,depth+1)
        },
        IrExpr::Call{target:IrCallTarget::DeriveFn(name),args}|IrExpr::BoundCall{target:IrCallTarget::DeriveFn(name),args,..}=>{
            let Some(helper)=ir.items.iter().find(|item|item.canonical==*name)else{return false;};
            let IrItemKind::DeriveFn{params,expr:Some(body),..}=&helper.kind else{return false;};
            if stack.len()>=16||!stack.insert(helper.id){return false;}
            let slots=match &value.expr{IrExpr::BoundCall{slots,..}=>Some(slots),_=>None};
            let mut callee=HashMap::new();let mut pure=BTreeSet::new();let mut used=BTreeSet::new();
            let valid=params.iter().enumerate().all(|(index,id)|{
                let Some(param)=ir.items.get(id.0 as usize)else{return false;};
                let IrItemKind::Param{owner,ty:IrType::Known(ty),default,..}=&param.kind else{return false;};
                if *owner!=helper.id{return false;}
                let slot=slots.map(|slots|slots.get(index).copied().flatten()).unwrap_or(Some(index));
                let arg=if let Some(slot)=slot{if !used.insert(slot){return false;}let Some(arg)=args.get(slot)else{return false;};arg}
                    else{let Some(IrDefault::Literal(value))=default else{return false;};value};
                if let ResolvedType::Record{symbol,stored:true}=ty{
                    let IrExpr::Name(name)=&arg.expr else{return false;};if roots.get(name)!=Some(symbol)||arg.ty!=*ty{return false;}
                    callee.insert(param.name.clone(),*symbol);true
                }else if control_type(ty)&&predicate(ir,arg,roots,values,stack,depth+1){pure.insert(param.name.clone());true}else{false}
            })&&used.len()==args.len()&&predicate(ir,body,&callee,&pure,stack,depth+1);
            stack.remove(&helper.id);valid
        },
        _=>false,
    }
}
fn model_corresponds(context:&super::scenario_decisions::FreshSourceContext<'_>,id:SymbolId)->Option<()> {
    let (ir,fresh)=(context.ir(),context.fresh());
    let optional=|a:&Option<TypedExpr>,b:&Option<TypedExpr>|match(a,b){(None,None)=>Some(()),(Some(a),Some(b))=>context.same_expression(a,b),_=>None};
    let (a,b)=(ir.items.get(id.0 as usize)?,fresh.items.get(id.0 as usize)?);
    let (IrItemKind::Model{owner:ao,fields:af,..},IrItemKind::Model{owner:bo,fields:bf,..})=(&a.kind,&b.kind)else{return None;};
    if a.id!=b.id||a.name!=b.name||a.canonical!=b.canonical||a.span!=b.span||a.module!=b.module||ao!=bo||af!=bf{return None;}
    let (am,bm)=(ir.modules.get(a.module.0 as usize)?,fresh.modules.get(b.module.0 as usize)?);
    if am.id!=bm.id||am.name!=bm.name||am.kind!=bm.kind||am.file!=bm.file||am.span!=bm.span{return None;}
    for id in af{
        let (a,b)=(ir.items.get(id.0 as usize)?,fresh.items.get(id.0 as usize)?);
        if a.id!=b.id||a.name!=b.name||a.canonical!=b.canonical||a.span!=b.span||a.module!=b.module{return None;}
        match (&a.kind,&b.kind){
            (IrItemKind::Field{owner:a,ty:IrType::Known(at),required_array:aa,default:ad,server:as_,modifiers:am,..},
             IrItemKind::Field{owner:b,ty:IrType::Known(bt),required_array:ba,default:bd,server:bs,modifiers:bm,..})if a==b&&at==bt&&aa==ba=>{
                match(ad,bd){
                    (None,None)=>{},
                    (Some(IrDefault::Literal(a)),Some(IrDefault::Literal(b)))=>context.same_expression(a,b)?,
                    (Some(IrDefault::Computed{expr:a,has_parent:ap}),Some(IrDefault::Computed{expr:b,has_parent:bp}))if ap==bp=>context.same_expression(a,b)?,
                    _=>return None,
                }
                match(as_,bs){(None,None)|(Some(IrServer::Actor),Some(IrServer::Actor))|(Some(IrServer::Now),Some(IrServer::Now))=>{},
                    (Some(IrServer::Computed(a)),Some(IrServer::Computed(b)))=>context.same_expression(a,b)?,_=>return None,}
                if am.trim!=bm.trim||am.unique!=bm.unique||am.machine!=bm.machine{return None;}
                optional(&am.min,&bm.min)?;optional(&am.max,&bm.max)?;
            },
            (IrItemKind::DeriveField{model:a,ty:IrType::Known(at),..},IrItemKind::DeriveField{model:b,ty:IrType::Known(bt),..})if a==b&&at==bt=>{},
            _=>return None,
        }
    }
    Some(())
}
fn body_counts(ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,body:&[IrStmt],item:&str,model:SymbolId,parameter:&str,parent_model:SymbolId,values:&BTreeSet<String>)->Option<(usize,usize)>{
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
            if !matches!(target.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==model||parent==parent_model){return None;}
            model_corresponds(context,target.id)?;
            let IrExpr::Object(fields)=&input.expr else{return None;};
            if fields.iter().filter(|(field,_)|field=="parent").count()!=1{return None;}
            for (field,value) in fields{
                if field=="parent"{
                    let expected=if matches!(target.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==model){(item,model)}else{(parameter,parent_model)};
                    if !matches!(&value.expr,IrExpr::Name(name)if name==expected.0)||value.ty!=(ResolvedType::Record{symbol:expected.1,stored:true}){return None;}
                }else if matches!(&value.expr,IrExpr::Name(name)if name==item)&&value.ty==(ResolvedType::Record{symbol:model,stored:true}){
                    // The actual selected view remains an opaque reference; ordinary
                    // CREATE reference authorization still owns the target grant.
                }else if !super::source_send_data::send_value(ir,value,values,0){
                    let (IrExpr::Name(name),ResolvedType::StdDelivery{capability,op})=(&value.expr,&value.ty)else{return None;};
                    if deliveries.get(name).map(|op|op.as_str())!=Some(format!("{capability}.{}",op.name).as_str()){return None;}
                }
            }
            writes+=1;
        },
        _=>return None,
    }}
    (writes>0&&writes<=4&&sends<=2).then_some((writes,sends))
}
pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<serde_json::Value>{
    let source=&requires.values().find(|source|source["owner"]==owner.canonical)?["source"];
    collect_from_source(ir,owner,context,source,module)
}

pub(super) fn collect_native(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,source:&serde_json::Value,module:&str)->Option<serde_json::Value> {
    let IrItemKind::Scenario{result:None,effects,hook:None,read:false,trusted:false,event_source:None,cohort:None,..}=&owner.kind else{return None;};
    let IrStmt::For{body,span,..}=effects.last()? else{return None;};
    if !matches!(body.as_slice(),[IrStmt::Create{..}]){return None;}
    let plan=collect_from_source(ir,owner,context,source,module)?;let loops=plan["loops"].as_array()?;
    (loops.len()==1&&loops[0]["node"]["start"]==span.start&&loops[0]["node"]["end"]==span.end&&loops[0]["sends"]==0).then_some(plan)
}

fn collect_from_source(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,source:&serde_json::Value,module:&str)->Option<serde_json::Value>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    context.same_scenario(ir, owner)?;
    let roots:HashMap<_,_>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};Some((param.name.clone(),*symbol))}).collect();
    let values:BTreeSet<_>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};super::source_send_data::plain_value(ir,ty,0).then(||param.name.clone())}).collect();
    fn walk(ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,owner:&IrItem,body:&[IrStmt],roots:&mut HashMap<String,SymbolId>,values:&mut BTreeSet<String>,source:&serde_json::Value,out:&mut Vec<serde_json::Value>)->Option<()>{
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=super::source_send_data::send_value(ir,value,values,0);roots.remove(name);values.remove(name);if pure{values.insert(name.clone());}},
            IrStmt::For{item,domain,limit:Some(limit),body,span}=>{
                let IrExpr::Int(maximum)=limit.expr else{return None;};if !(1..=1000).contains(&maximum)||out.len()>=200{return None;}
                let IrExpr::Query(query)=&domain.expr else{return None;};let IrQueryDomain::Model(model)=&query.domain else{return None;};
                let parent=query.parent.as_deref()?;let IrExpr::Name(parameter)=&parent.expr else{return None;};let parent_model=*roots.get(parameter)?;if item==parameter{return None;}
                let model=ir.items.iter().find(|candidate|candidate.canonical==*model)?;
                if !matches!(model.kind,IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}if parent==parent_model)
                    ||parent.ty!=(ResolvedType::Record{symbol:parent_model,stored:true})
                    ||!matches!(&domain.ty,ResolvedType::Array{element,ordered:true,..}if element.as_ref()==&ResolvedType::Record{symbol:model.id,stored:true})
                    ||query.select.is_some()||query.select_param.is_some()||!query.order.is_empty()||query.value_order.is_some()
                    ||query.limit.is_some()||query.archived.is_some()
                    ||query.where_pred.as_deref().is_some_and(|value|value.ty!=ResolvedType::Scalar(Scalar::Bool)||!predicate(ir,value,&HashMap::from([(query.where_param.clone(),model.id)]),values,&mut HashSet::new(),0))
                {return None;}
                model_corresponds(context,parent_model)?;model_corresponds(context,model.id)?;
                let (writes,sends)=body_counts(ir,context,body,item,model.id,parameter,parent_model,values)?;
                let id=crate::source::sha256_hex(format!("source-body-loop/v1:{}:{}:{}:{}:{}",source["path"],source["sha256"],owner.canonical,span.start,span.end).as_bytes());
                out.push(serde_json::json!({"id":id,"node":{"start":span.start,"end":span.end},"domain":{"start":domain.span.start,"end":domain.span.end},
                    "maximum":maximum,"parameter":parameter,"parentModel":ir.items[parent_model.0 as usize].canonical,"model":model.canonical,
                    "item":item,"filtered":query.where_pred.is_some(),"writes":writes,"sends":sends}));
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,context,owner,then_branch,&mut roots.clone(),&mut values.clone(),source,out)?;walk(ir,context,owner,else_branch,&mut roots.clone(),&mut values.clone(),source,out)?;},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,context,owner,&arm.body,&mut roots.clone(),&mut values.clone(),source,out)?;},
            _=>{},
        }}Some(())
    }
    let mut loops=Vec::new();walk(ir,context,owner,effects,&mut roots.clone(),&mut values.clone(),source,&mut loops)?;
    if loops.is_empty()||loops.iter().filter_map(|loop_|loop_["maximum"].as_u64()).sum::<u64>()>1000||loops.iter().filter_map(|loop_|Some(loop_["maximum"].as_u64()?*loop_["sends"].as_u64()?)).sum::<u64>()>200{return None;}
    Some(serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},"owner":owner.canonical,"loops":loops}))
}
