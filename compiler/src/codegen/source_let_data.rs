//! Immediate DATA observations at original linear scalar LET declarations.
use super::ir::*;
use crate::analysis::{ResolvedType,SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap,HashMap};

pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    if !effects.iter().any(|statement|matches!(statement,IrStmt::Let{value:TypedExpr{expr:IrExpr::Member{..},..},..})){return Some(HashMap::new());}
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
    let mut stage=0;let mut loans=HashMap::new();
    for(index,statement)in effects.iter().enumerate(){match statement{
        IrStmt::Let{name,value,span}=>{
            if used_by_send(&effects[index+1..],name)
                &&let IrExpr::Member{base,field}=&value.expr
                &&let IrExpr::Name(parameter)=&base.expr
                &&let Some(model)=roots.get(parameter)
                &&base.ty==(ResolvedType::Record{symbol:*model,stored:true})
                &&let IrItemKind::Model{fields,..}=&ir.items[model.0 as usize].kind
                &&let Some(declaration)=fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find(|item|item.name==*field)
                &&let IrItemKind::Field{owner:field_owner,ty:IrType::Known(ty),..}=&declaration.kind
                &&field_owner==model
                &&(ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty))
                &&let Some(field_type)=super::source_send_data::data_type(ir,ty)
                &&let Some(value_type)=super::source_send_data::data_type(ir,&value.ty)
                &&let Some(original)=context.fresh().items.get(declaration.id.0 as usize)
                &&declaration.id==original.id&&declaration.canonical==original.canonical&&declaration.name==original.name
                &&declaration.module==original.module&&declaration.span==original.span
                &&matches!(&original.kind,IrItemKind::Field{owner,ty:IrType::Known(original_ty),..}if owner==model&&original_ty==ty){
                loans.insert(*span,serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":name,
                    "parameter":parameter,"model":ir.items[model.0 as usize].canonical,"field":{"name":field,"type":field_type},"valueType":value_type}));
            }
            roots.remove(name);
        },
        IrStmt::Create{binding,..}=>{if let Some(binding)=binding{roots.remove(binding);}stage+=1;},
        IrStmt::Set{..}|IrStmt::Transition{..}|IrStmt::Delete{..}=>stage+=1,
        IrStmt::Require{..}|IrStmt::Send{..}=>{},
        _=>break,
    }}
    Some(loans)
}
