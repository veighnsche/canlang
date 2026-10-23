//! Original linear CREATE sites consumed by separate nongrant source lifecycles.
use super::ir::*;
use crate::analysis::{ResolvedType,SymbolId};
use std::collections::HashMap;

pub(super) fn collect(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,source:&serde_json::Value)->Option<Vec<serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    if !effects.iter().any(|statement|matches!(statement,IrStmt::Create{binding:Some(_),when:None,..})){return Some(Vec::new());}
    context.same_scenario(ir, owner)?;
    let mut parents:HashMap<String,SymbolId>=params.iter().filter_map(|id|{let param=ir.items.get(id.0 as usize)?;
        let IrItemKind::Param{ty:IrType::Known(ResolvedType::Record{symbol,stored:true}),..}=&param.kind else{return None;};
        matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}).then(||(param.name.clone(),*symbol))}).collect();
    let mut stage=0;let mut creates=Vec::new();
    for statement in effects{match statement{
        IrStmt::Create{model,input,when:None,binding,span}=>{
            if let Some(binding)=binding{
                if stage<200 && let Some(target)=ir.items.iter().find(|item|item.canonical==*model)
                    && let IrItemKind::Model{owner:IrOwner::ChildOf(parent),..}=&target.kind
                    && let IrExpr::Object(fields)=&input.expr
                    && let Some((_,value))=fields.iter().find(|(field,_)|field=="parent")
                    && let IrExpr::Name(parameter)=&value.expr
                    && parents.get(parameter)==Some(parent)
                    && value.ty==(ResolvedType::Record{symbol:*parent,stored:true}){
                    let id=crate::source::sha256_hex(format!("source-created-row/v1:{}:{}:{}:{}:{}",source["path"],source["sha256"],owner.canonical,span.start,span.end).as_bytes());
                    creates.push(serde_json::json!({"id":id,"node":{"start":span.start,"end":span.end},"stage":stage,"binding":binding,
                        "model":model,"parentParameter":parameter,"parentModel":ir.items[parent.0 as usize].canonical}));
                }
                parents.remove(binding);
            }
            stage+=1;
        },
        IrStmt::Set{..}|IrStmt::Transition{..}|IrStmt::Delete{..}=>stage+=1,
        IrStmt::Let{name,..}=>{parents.remove(name);},
        IrStmt::Require{..}|IrStmt::Send{..}=>{},
        _=>break,
    }}
    Some(creates)
}
