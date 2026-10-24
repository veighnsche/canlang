//! Immediate DATA observations at original scalar LET and constructor field sites.
use super::ir::*;
use crate::analysis::{ResolvedType,SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap,BTreeSet,HashMap};

pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str,loops:Option<&serde_json::Value>)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    fn relevant(body:&[IrStmt])->bool{body.iter().any(|statement|match statement{
        IrStmt::Let{..}|IrStmt::Create{..}|IrStmt::Set{..}|IrStmt::Schedule{..}=>true,
        IrStmt::If{then_branch,else_branch,..}=>relevant(then_branch)||relevant(else_branch),IrStmt::For{body,..}=>relevant(body),_=>false})}
    if !relevant(effects){return Some(HashMap::new());}
    context.same_scenario(ir, owner)?;
    let mut roots:BTreeMap<String,SymbolId>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),*symbol))}).collect();
    fn uses(value:&TypedExpr,name:&str,depth:usize)->bool{
        if depth>=64{return false;}
        match &value.expr{
            IrExpr::Name(value)=>value==name,
            IrExpr::Member{base,..}=>uses(base,name,depth+1),
            IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}|IrExpr::Array(args)=>args.iter().any(|value|uses(value,name,depth+1)),
            IrExpr::Object(fields)=>fields.iter().any(|(_,value)|uses(value,name,depth+1)),
            IrExpr::Binary{left,right,..}=>uses(left,name,depth+1)||uses(right,name,depth+1),
            IrExpr::Unary{operand,..}=>uses(operand,name,depth+1),
            _=>false,
        }
    }
    fn used_by_send(statements:&[IrStmt],name:&str)->bool{
        for statement in statements{match statement{
            IrStmt::Send{args,..}if uses(args,name,0)=>return true,
            IrStmt::Let{name:shadow,..}if shadow==name=>return false,
            IrStmt::If{..}|IrStmt::For{..}|IrStmt::Match{..}=>return false,
            _=>{},
        }}false
    }
    fn scalar_loan(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,roots:&BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,value:&TypedExpr,span:Span,stage:usize,name:&str)->Option<serde_json::Value>{
        fn receiver(ir:&IrProgram,value:&TypedExpr,roots:&BTreeMap<String,SymbolId>,depth:usize)->Option<(String,SymbolId,Vec<SymbolId>)>{
            if depth>=16{return None;}
            match &value.expr{
                IrExpr::Name(name)=>{let model=*roots.get(name)?;(value.ty==ResolvedType::Record{symbol:model,stored:true}).then(||(name.clone(),model,Vec::new()))},
                IrExpr::Member{base,field}if field=="parent"=>{
                    let(parameter,root,mut parents)=receiver(ir,base,roots,depth+1)?;
                    let owner=parents.last().copied().unwrap_or(root);
                    let IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}=&ir.items.get(owner.0 as usize)?.kind else{return None;};
                    if value.ty!=(ResolvedType::Record{symbol:*parent,stored:true}){return None;}
                    parents.push(*parent);Some((parameter,root,parents))
                },_=>None,
            }
        }
        let IrExpr::Member{base,..}=&value.expr else{return None;};
        let(parameter,root,path)=receiver(ir,base,roots,0)
            .map(|(parameter,root,parents)|(parameter,root,parents.into_iter().map(|model|("parent".into(),model,false)).collect::<Vec<_>>()))
            .or_else(||super::source_send_data::scalar_field_receiver(ir,base,roots))?;
        let model=&path.last().map(|(_,model,_)|*model).unwrap_or(root);
        let transport=|ty:&ResolvedType|super::source_send_data::data_type(ir,ty).or_else(||match ty{
            ResolvedType::Record{symbol,stored:true}if matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..})=>Some(ir.items[symbol.0 as usize].canonical.clone()),_=>None});
        if let IrExpr::Member{base,field}=&value.expr
                &&base.ty==(ResolvedType::Record{symbol:*model,stored:true})
                &&let IrItemKind::Model{fields,..}=&ir.items[model.0 as usize].kind
                &&let Some(declaration)=fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find(|item|item.name==*field)
                &&let IrItemKind::Field{owner:field_owner,ty:IrType::Known(ty),..}=&declaration.kind
                &&field_owner==model
                &&(ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))
                &&let Some(field_type)=transport(ty)
                &&let Some(value_type)=transport(&value.ty)
                &&let Some(original)=context.fresh().items.get(declaration.id.0 as usize)
                &&declaration.id==original.id&&declaration.canonical==original.canonical&&declaration.name==original.name
                &&declaration.module==original.module&&declaration.span==original.span
                &&matches!(&original.kind,IrItemKind::Field{owner,ty:IrType::Known(original_ty),..}if owner==model&&original_ty==ty){
            let mut site=serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,
                "parameter":parameter,"model":ir.items[root.0 as usize].canonical,"field":{"name":field,"type":field_type},"valueType":value_type});
            if !path.is_empty(){
                if path.iter().all(|(field,_,narrowed)|field=="parent"&&!*narrowed){
                    site["parents"]=serde_json::json!(path.iter().map(|(_,id,_)|ir.items[id.0 as usize].canonical.clone()).collect::<Vec<_>>());
                }else{site["path"]=serde_json::json!(path.iter().map(|(field,id,narrowed)|{
                    let mut edge=serde_json::json!({"field":field,"model":ir.items[id.0 as usize].canonical});
                    if *narrowed{edge["nullable"]=serde_json::json!(true);}edge
                }).collect::<Vec<_>>());}
            }
            return Some(site);
        }None
    }
    let mut stage=0;let mut loans=HashMap::new();
    for(index,statement)in effects.iter().enumerate(){match statement{
        IrStmt::Let{name,value,span}=>{
            if used_by_send(&effects[index+1..],name)
                &&let Some(loan)=scalar_loan(ir,owner,context,&roots,&source,module,value,*span,stage,name){loans.insert(*span,loan);}
            roots.remove(name);
        },
        IrStmt::Create{binding,..}=>{if let Some(binding)=binding{roots.remove(binding);}stage+=1;},
        IrStmt::Set{..}|IrStmt::Transition{..}|IrStmt::Delete{..}=>stage+=1,
        IrStmt::Require{..}|IrStmt::Send{..}=>{},
        _=>break,
    }}
    // Constructor field DATA is observed exactly where the original field
    // expression executes. Unknown branch/loop write counts never guess a
    // stage, and File/derived fields cannot enter the field loan.
    fn constructors(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,body:&[IrStmt],roots:&mut BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,mut stage:usize,loans:&mut HashMap<Span,serde_json::Value>)->Option<usize>{
        for statement in body{match statement{
            IrStmt::Create{input,binding,..}=>{
                if let IrExpr::Object(fields)=&input.expr{for(name,value)in fields{
                    if matches!(value.ty.nullable_inner().unwrap_or(&value.ty),ResolvedType::Scalar(_)|ResolvedType::Enum{..}|ResolvedType::Record{stored:true,..})
                        &&let Some(loan)=scalar_loan(ir,owner,context,roots,source,module,value,value.span,stage,name){loans.insert(value.span,loan);}
                }}
                if let Some(name)=binding{roots.remove(name);}stage=stage.checked_add(1)?;
            },
            IrStmt::If{then_branch,else_branch,..}=>{
                let left=constructors(ir,owner,context,then_branch,&mut roots.clone(),source,module,stage,loans);
                let right=constructors(ir,owner,context,else_branch,&mut roots.clone(),source,module,stage,loans);
                if left!=right{return None;}stage=left?;
            },
            IrStmt::Let{name,..}=>{roots.remove(name);},
            IrStmt::Set{..}|IrStmt::Transition{..}|IrStmt::Delete{..}=>stage=stage.checked_add(1)?,
            IrStmt::Require{..}|IrStmt::Send{..}=>{},
            _=>return None,
        }if stage>=200{return None;}}
        Some(stage)
    }
    let mut constructor_roots=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),*symbol))}).collect();
    constructors(ir,owner,context,effects,&mut constructor_roots,&source,module,0,&mut loans);
    // Each scalar field is observed where its original getter executes.
    // Native JavaScript retains lazy operands and earlier Values failures.
    fn scalar(ty:&ResolvedType)->bool{match ty{
        ResolvedType::Scalar(value)=>!matches!(value,crate::analysis::Scalar::File|crate::analysis::Scalar::Secret|crate::analysis::Scalar::Member|crate::analysis::Scalar::Json|crate::analysis::Scalar::Bytes),
        ResolvedType::Enum{cases,..}=>!cases.is_empty(),ResolvedType::Nullable(inner)=>scalar(inner),_=>false,
    }}
    fn leaves(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,value:&TypedExpr,
        roots:&BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,stages:&BTreeSet<usize>,name:&str,
        loans:&mut HashMap<Span,serde_json::Value>,depth:usize)->Option<()> {
        if depth>32{return None;}
        if matches!(value.expr,IrExpr::Member{..})&&scalar(&value.ty)
            &&let Some(mut loan)=scalar_loan(ir,owner,context,roots,source,module,value,value.span,*stages.first()?,name){
            if stages.len()>1{
                let fields=loan.as_object_mut()?;fields.remove("stage");
                fields.insert("stages".into(),serde_json::json!(stages));
            }
            loans.insert(value.span,loan);return Some(());
        }
        let mut child=|value:&TypedExpr|leaves(ir,owner,context,value,roots,source,module,stages,name,loans,depth+1);
        match &value.expr{
            IrExpr::Member{base,..}=>child(base),IrExpr::Binary{left,right,..}=>{child(left)?;child(right)},
            IrExpr::Unary{operand,..}=>child(operand),
            IrExpr::Object(fields)=>{for(_,value)in fields{child(value)?;}Some(())},
            IrExpr::Call{target:IrCallTarget::Builtin{id,awaited:false},args}
            |IrExpr::BoundCall{target:IrCallTarget::Builtin{id,awaited:false},args,..}
                if context.catalog().and_then(|catalog|catalog.effects(id))==Some(crate::analysis::catalog::Effects::Pure)=>{
                for value in args{child(value)?;}Some(())
            },
            IrExpr::Int(_)|IrExpr::Decimal(_)|IrExpr::Text(_)|IrExpr::Bool(_)|IrExpr::Null|IrExpr::Money{..}
                |IrExpr::DurationMs(_)|IrExpr::Date(_)|IrExpr::Datetime(_)|IrExpr::Name(_)=>Some(()),
            _=>None,
        }
    }
    fn expressions(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,
        body:&[IrStmt],roots:&mut BTreeMap<String,SymbolId>,values:&mut BTreeSet<String>,source:&serde_json::Value,
        module:&str,mut stages:BTreeSet<usize>,loans:&mut HashMap<Span,serde_json::Value>,loops:Option<&serde_json::Value>)->Option<BTreeSet<usize>> {
        fn advance(stages:&BTreeSet<usize>)->Option<BTreeSet<usize>>{
            stages.iter().map(|stage|stage.checked_add(1).filter(|stage|*stage<200)).collect()
        }
        if stages.is_empty()||stages.len()>200||stages.last().copied()? >=200{return None;}
        for statement in body { match statement {
            IrStmt::Let{name,value,span}=>{
                if !loans.contains_key(span)&&scalar(&value.ty){
                    let mut nested=HashMap::new();
                    if leaves(ir,owner,context,value,roots,source,module,&stages,name,&mut nested,0).is_some(){loans.extend(nested);}
                }
                let pure=loans.contains_key(span)||super::source_send_data::send_value(ir,value,values,0)
                    ||super::source_send_data::observed_scalar_value(ir,value,loans,values);
                roots.remove(name);values.remove(name);if pure{values.insert(name.clone());}
            },
            IrStmt::If{then_branch,else_branch,..}=>{
                let left=expressions(ir,owner,context,then_branch,&mut roots.clone(),&mut values.clone(),source,module,stages.clone(),loans,loops);
                let right=expressions(ir,owner,context,else_branch,&mut roots.clone(),&mut values.clone(),source,module,stages.clone(),loans,loops);
                // Both authored branches contribute their exact reachable write counts.
                // Preserve lazy execution; this is a finite admission set, not a range.
                stages=left?.union(&right?).copied().collect();
            },
            IrStmt::Schedule{at,payload,span,..}=>{
                let mut nested=HashMap::new();
                if leaves(ir,owner,context,at,roots,source,module,&stages,"at",&mut nested,0).is_some()
                    &&leaves(ir,owner,context,payload,roots,source,module,&stages,"payload",&mut nested,0).is_some(){loans.extend(nested);}
                let _=span;
            },
            IrStmt::For{item,domain,body,span,..}=>{
                if stages.len()!=1{return None;}
                let entry=loops?.get("loops")?.as_array()?.iter().find(|entry|entry["node"]["start"]==span.start
                    &&entry["node"]["end"]==span.end&&entry.get("work").is_some())?;
                let ResolvedType::Array{element,..}=&domain.ty else{return None;};
                let ResolvedType::Record{symbol,stored:true}=element.as_ref()else{return None;};
                if entry["item"]!=*item||entry["model"]!=ir.items[symbol.0 as usize].canonical{return None;}
                let mut nested_roots=roots.clone();nested_roots.insert(item.clone(),*symbol);
                let mut nested_values=values.clone();nested_values.remove(item);
                let mut nested=HashMap::new();
                expressions(ir,owner,context,body,&mut nested_roots,&mut nested_values,source,module,BTreeSet::from([0]),&mut nested,loops)?;
                if nested.values().any(|loan|loan.get("stages").is_some()){return None;}
                for(key,mut loan)in nested.drain(){loan["loop"]=entry["id"].clone();loans.insert(key,loan);}
                // A dynamic number of child writes cannot establish a later
                // static stage. Original loop tail execution remains separate.
                return None;
            },
            IrStmt::Create{input,binding,..}=>{
                let mut nested=HashMap::new();
                if leaves(ir,owner,context,input,roots,source,module,&stages,"create",&mut nested,0).is_some(){loans.extend(nested);}
                if let Some(name)=binding{roots.remove(name);values.remove(name);}stages=advance(&stages)?;
            },
            IrStmt::Set{changes,..}=>{
                // Nested Object leaves use the same pure expression walker as LET.
                // Observe each original getter before this SET advances the write stage.
                let mut nested=HashMap::new();
                if leaves(ir,owner,context,changes,roots,source,module,&stages,"set",&mut nested,0).is_some(){loans.extend(nested);}
                stages=advance(&stages)?;
            },
            IrStmt::Transition{..}|IrStmt::Delete{..}=>stages=advance(&stages)?,
            IrStmt::Require{..}|IrStmt::Send{..}|IrStmt::Cancel{..}=>{},
            _=>return None,
        }if stages.len()>200{return None;}}
        Some(stages)
    }
    let mut expression_roots=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),*symbol))}).collect();
    let mut values=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
        super::source_send_data::plain_value(ir,ty,0).then(||param.name.clone())}).collect();
    expressions(ir,owner,context,effects,&mut expression_roots,&mut values,&source,module,BTreeSet::from([0]),&mut loans,loops);
    Some(loans)
}
