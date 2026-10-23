//! Immediate DATA observations at original scalar LET and constructor field sites.
use super::ir::*;
use crate::analysis::{ResolvedType,SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap,HashMap};

pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    fn relevant(body:&[IrStmt])->bool{body.iter().any(|statement|match statement{
        IrStmt::Let{value:TypedExpr{expr:IrExpr::Member{..},..},..}|IrStmt::Create{..}=>true,
        IrStmt::If{then_branch,else_branch,..}=>relevant(then_branch)||relevant(else_branch),_=>false})}
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
        let(parameter,root,parents)=receiver(ir,base,roots,0)?;
        let model=&parents.last().copied().unwrap_or(root);
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
            if !parents.is_empty(){site["parents"]=serde_json::json!(parents.iter().map(|id|ir.items[id.0 as usize].canonical.clone()).collect::<Vec<_>>());}
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
    Some(loans)
}
