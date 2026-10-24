//! Original source-bound effect argument DATA. These proofs install no saved
//! result or general record reader; separate live SEND/EMIT frames own execution.
use super::ir::{IrProgram,IrItem,IrItemKind,IrExpr,IrType,IrStmt,TypedExpr,IrCallTarget,IrBinOp};
use crate::analysis::{ResolvedType,Scalar,SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap,BTreeSet,HashMap,HashSet};

pub(super) fn plain_value(ir:&IrProgram,ty:&ResolvedType,depth:usize)->bool{
    if depth>=16{return false;}
    match ty{
        ResolvedType::Null=>true,
        ResolvedType::Scalar(scalar)=>!matches!(scalar,Scalar::File|Scalar::Secret|Scalar::Member|Scalar::Json|Scalar::Bytes),
        ResolvedType::Enum {cases,..} if !cases.is_empty()=>true,
        ResolvedType::Nullable(inner)=>plain_value(ir,inner,depth+1),
        ResolvedType::Array{element,ordered:true,..}=>plain_value(ir,element,depth+1),
        ResolvedType::Object(fields)=>fields.len()<=200&&fields.iter().all(|(_,ty)|plain_value(ir,ty,depth+1)),
        ResolvedType::Record{symbol,..}=>ir.items.get(symbol.0 as usize).is_some_and(|item|{
            let IrItemKind::Contract{fields,..}=&item.kind else{return false;};
            !fields.is_empty()&&fields.len()<=200&&fields.iter().all(|id|matches!(ir.items.get(id.0 as usize).map(|field|&field.kind),
                Some(IrItemKind::Field{ty:IrType::Known(ty),..})if plain_value(ir,ty,depth+1)))
        }),
        _=>false,
    }
}
// SEND consumes data. A guard-only owner can carry its ordinary admitted
// Values inputs and pure locals, but cannot turn a stored field/control
// observation, File, reference or provider receipt into an egress value.
pub(super) fn send_value(ir:&IrProgram,value:&TypedExpr,values:&BTreeSet<String>,depth:usize)->bool{
    if depth>=32{return false;}
    if let IrExpr::Member{base,field}=&value.expr
        &&field=="id"&&value.ty==ResolvedType::Scalar(Scalar::Text)&&base.ty==ResolvedType::OperationContext
        &&let IrExpr::Member{base:context,field:operation}=&base.expr
        &&operation=="operation"&&context.ty==ResolvedType::Unknown&&matches!(&context.expr,IrExpr::Name(name)if name=="c"){
        return true;
    }
    let child=|value:&TypedExpr|send_value(ir,value,values,depth+1);
    // Effect argument objects retain their owning checked operation schema;
    // their aggregate IR carrier can be Unknown while every slot is typed.
    if let IrExpr::Object(fields)=&value.expr{
        return (matches!(value.ty,ResolvedType::Unknown|ResolvedType::Object(_))
            || plain_value(ir,&value.ty,0))
            && fields.len()<=200&&fields.iter().all(|(_,value)|child(value));
    }
    if !plain_value(ir,&value.ty,0){return false;}
    match &value.expr{
        IrExpr::Int(_)|IrExpr::Decimal(_)|IrExpr::Text(_)|IrExpr::Bool(_)|IrExpr::Null
        |IrExpr::Money{..}|IrExpr::DurationMs(_)|IrExpr::Date(_)|IrExpr::Datetime(_)=>true,
        IrExpr::Name(name)=>values.contains(name),
        IrExpr::Member{base,..}=>plain_value(ir,&base.ty,0)&&child(base),
        IrExpr::Call{target:IrCallTarget::Builtin{awaited:false,..},args}
        |IrExpr::BoundCall{target:IrCallTarget::Builtin{awaited:false,..},args,..}=>args.iter().all(child),
        IrExpr::Binary{left,right,..}=>child(left)&&child(right),
        IrExpr::Unary{operand,..}=>child(operand),
        IrExpr::Array(entries)=>entries.iter().all(child),
        IrExpr::Object(fields)=>fields.iter().all(|(_,value)|child(value)),
        _=>false,
    }
}
#[derive(Clone)]
struct Root { parameter:String, model:SymbolId, query:Option<String> }
#[derive(Clone,Default)]
struct Environment { values:BTreeSet<String>, roots:BTreeMap<String,Root> }
impl Environment {
    fn admitted(ir:&IrProgram,params:&[SymbolId])->Option<(Self,BTreeMap<String,SymbolId>)>{
        let mut env=Environment::default();let mut models=BTreeMap::new();
        for id in params{
            let param=ir.items.get(id.0 as usize)?;let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
            if let ResolvedType::Record{symbol,stored:true}=ty
                && matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}){
                env.roots.insert(param.name.clone(),Root{parameter:param.name.clone(),model:*symbol,query:None});models.insert(param.name.clone(),*symbol);
            }else if plain_value(ir,ty,0){env.values.insert(param.name.clone());}
        }
        Some((env,models))
    }
}
#[derive(Default)]
struct Reads {
    fields:BTreeMap<String,BTreeMap<String,String>>,
    identities:BTreeMap<String,BTreeSet<String>>,
    parents:BTreeMap<String,(SymbolId,BTreeMap<String,String>)>,
    identity_paths:BTreeMap<String,BTreeMap<Vec<(String,u32,bool)>,String>>,
    data_paths:BTreeMap<String,BTreeMap<(Vec<(String,u32,bool)>,String),String>>,
    query_fields:BTreeMap<String,BTreeMap<String,String>>,
    queries:BTreeMap<String,serde_json::Value>,
    query_spans:BTreeSet<(u32,u32,u32)>,
    steps:usize, stack:HashSet<SymbolId>,
    aggregates:bool,
    contract_derives:bool,
    derived:BTreeMap<String,BTreeMap<String,String>>,
}
pub(super) fn data_type(ir:&IrProgram,ty:&ResolvedType)->Option<String>{match ty{
    ResolvedType::Scalar(scalar)if !matches!(scalar,Scalar::File|Scalar::Secret|Scalar::Member|Scalar::Json|Scalar::Bytes|Scalar::Url|Scalar::Locale)=>Some(scalar.as_str().into()),
    ResolvedType::Enum{owner:Some(id),cases}if !cases.is_empty()=>{
        let owner=ir.items.get(id.0 as usize)?;Some(if matches!(owner.kind,IrItemKind::Field{owner,..}if ir.items.get(owner.0 as usize).is_some_and(|item|matches!(item.kind,IrItemKind::Model{..}))){format!("enum({})",cases.join(","))}else{owner.canonical.clone()})
    },
    ResolvedType::Enum{owner:None,cases}if !cases.is_empty()=>Some(format!("enum({})",cases.join(","))),
    ResolvedType::Record{symbol,..} if plain_value(ir,ty,0)
        &&matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Contract{..})=>Some(ir.items[symbol.0 as usize].canonical.clone()),
    ResolvedType::Array{element,ordered:true,nonempty:false} if plain_value(ir,ty,0)
        &&matches!(element.as_ref(),ResolvedType::Record{symbol,..} if matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..})))=>Some(format!("{}[]",data_type(ir,element)?)),
    ResolvedType::Nullable(inner)=>Some(format!("{}?",data_type(ir,inner)?)),_=>None}}
fn declared_field<'a>(ir:&'a IrProgram,model:SymbolId,name:&str)->Option<(&'a IrItem,&'a ResolvedType)>{
    let IrItemKind::Model{fields,..}=&ir.items.get(model.0 as usize)?.kind else{return None;};
    let field=fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find(|item|item.name==name)?;
    let IrItemKind::Field{owner,ty:IrType::Known(ty),..}=&field.kind else{return None;};
    (*owner==model).then_some((field,ty))
}
fn required_identity_path(ir:&IrProgram,value:&TypedExpr,env:&Environment,depth:usize)->Option<(Root,Vec<(String,SymbolId,bool)>)>{
    if depth>=8{return None;}
    if let IrExpr::Name(name)=&value.expr{
        let root=env.roots.get(name)?.clone();
        return (root.query.is_none()&&value.ty==ResolvedType::Record{symbol:root.model,stored:true}).then_some((root,Vec::new()));
    }
    let IrExpr::Member{base,field}=&value.expr else{return None;};
    let (root,mut path)=required_identity_path(ir,base,env,depth+1)?;
    let owner=path.last().map(|(_,model,_)|*model).unwrap_or(root.model);
    let ResolvedType::Record{symbol:target,stored:true}=&value.ty else{return None;};
    let mut narrowed=false;
    if field=="parent"{
        if !matches!(ir.items.get(owner.0 as usize)?.kind,IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(parent),..}if parent==*target){return None;}
    }else{
        let(_,declared)=declared_field(ir,owner,field)?;
        if declared!=&value.ty{
            // The enclosing collector seals this exact typed occurrence against
            // freshly lowered original source, including its flow narrowing.
            if !matches!(declared,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty){return None;}
            narrowed=true;
        }
    }
    path.push((field.clone(),*target,narrowed));Some((root,path))
}
fn field_descriptors(fields:&BTreeMap<String,String>)->Vec<serde_json::Value>{
    fields.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect()
}
fn path_descriptor(ir:&IrProgram,path:&[(String,u32,bool)])->Vec<serde_json::Value>{
    path.iter().map(|(field,model,narrowed)|{
        let mut edge=serde_json::json!({"field":field,"model":ir.items[*model as usize].canonical});
        if *narrowed{edge["nullable"]=serde_json::json!(true);}
        edge
    }).collect()
}
/// Reuse the original required stored-reference path census for scalar loans.
pub(super) fn scalar_field_receiver(ir:&IrProgram,value:&TypedExpr,roots:&BTreeMap<String,SymbolId>)
    ->Option<(String,SymbolId,Vec<(String,SymbolId,bool)>)> {
    let env=Environment{values:BTreeSet::new(),roots:roots.iter().map(|(name,model)|
        (name.clone(),Root{parameter:name.clone(),model:*model,query:None})).collect()};
    let(root,path)=required_identity_path(ir,value,&env,0)?;
    Some((root.parameter,root.model,path))
}
/// Only already-observed scalar leaves can make a compound LET a later pure
/// lexical value. This recognizes provenance; JavaScript evaluates it in place.
pub(super) fn observed_scalar_value(ir:&IrProgram,value:&TypedExpr,loans:&HashMap<Span,serde_json::Value>,values:&BTreeSet<String>)->bool {
    fn scalar(ty:&ResolvedType)->bool{match ty{
        ResolvedType::Scalar(value)=>!matches!(value,Scalar::File|Scalar::Secret|Scalar::Member|Scalar::Json|Scalar::Bytes),
        ResolvedType::Enum{cases,..}=>!cases.is_empty(),ResolvedType::Nullable(inner)=>scalar(inner),_=>false,
    }}
    fn walk(ir:&IrProgram,value:&TypedExpr,loans:&HashMap<Span,serde_json::Value>,values:&BTreeSet<String>,depth:usize)->bool{
        if depth>32{return false;}
        if send_value(ir,value,values,0)||loans.contains_key(&value.span){return true;}
        let child=|value:&TypedExpr|walk(ir,value,loans,values,depth+1);
        match &value.expr{
            IrExpr::Member{base,field}=>field=="now"&&value.ty==ResolvedType::Scalar(Scalar::Datetime)
                &&base.ty==ResolvedType::Unknown&&matches!(&base.expr,IrExpr::Name(name)if name=="c"),
            IrExpr::Binary{left,right,..}=>child(left)&&child(right),IrExpr::Unary{operand,..}=>child(operand),
            IrExpr::Call{target:IrCallTarget::Builtin{awaited:false,..},args}
            |IrExpr::BoundCall{target:IrCallTarget::Builtin{awaited:false,..},args,..}=>args.iter().all(child),
            _=>false,
        }
    }
    scalar(&value.ty)&&walk(ir,value,loans,values,0)
}
impl Reads {
    fn parameter(&self,ir:&IrProgram,name:&str,model:SymbolId,fields:&BTreeMap<String,String>)->serde_json::Value{
        let mut value=serde_json::json!({"name":name,"model":ir.items[model.0 as usize].canonical,
            "fields":field_descriptors(fields)});
        if let Some(identity)=self.identities.get(name){value["identity"]=serde_json::json!(identity);}
        if let Some(paths)=self.identity_paths.get(name){value["identityPaths"]=serde_json::json!(paths.iter().map(|(path,leaf)|serde_json::json!({"path":path_descriptor(ir,path),"leaf":leaf})).collect::<Vec<_>>());}
        if let Some(paths)=self.data_paths.get(name){value["dataPaths"]=serde_json::json!(paths.iter().map(|((path,field),ty)|serde_json::json!({"path":path_descriptor(ir,path),"field":field,"type":ty})).collect::<Vec<_>>());}
        if let Some((model,fields))=self.parents.get(name){value["parent"]=serde_json::json!({"model":ir.items[model.0 as usize].canonical,"fields":field_descriptors(fields)});}
        if let Some(derived)=self.derived.get(name){value["derived"]=serde_json::json!(field_descriptors(derived));}
        value
    }

    fn read(&mut self,ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,
        value:&TypedExpr,env:&Environment,depth:usize)->Option<()> {
        self.steps+=1;if depth>32||self.steps>4096{return None;}
        if send_value(ir,value,&env.values,0){return Some(());}
        match &value.expr{
            IrExpr::Object(entries)if entries.len()<=200=>{
                for(_,value)in entries{self.read(ir,context,value,env,depth+1)?;}Some(())},
            IrExpr::Array(entries)if entries.len()<=200=>{
                for value in entries{self.read(ir,context,value,env,depth+1)?;}Some(())},
            IrExpr::Member{base,field}=>{
                if self.aggregates&&field=="now"&&base.ty==ResolvedType::Unknown&&matches!(&base.expr,IrExpr::Name(name)if name=="c")
                    && value.ty==ResolvedType::Scalar(Scalar::Datetime){return Some(());}
                if field=="id"&&value.ty==ResolvedType::Scalar(Scalar::Text)
                    &&let Some((root,path))=required_identity_path(ir,base,env,0)
                    &&!path.is_empty(){
                    self.fields.entry(root.parameter.clone()).or_default();
                    self.identity_paths.entry(root.parameter).or_default().insert(path.into_iter().map(|(field,model,narrowed)|(field,model.0,narrowed)).collect(),"id".into());return Some(());
                }
                if !matches!(field.as_str(),"id"|"version")
                    &&let Some((root,path))=required_identity_path(ir,base,env,0)
                    &&let Some((_,model,_))=path.last(){
                    let(_,declared)=declared_field(ir,*model,field)?;
                    if declared!=&value.ty&&!matches!(declared,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty){return None;}
                    let leaf=if let ResolvedType::Nullable(inner)=declared{inner.as_ref()}else{declared};
                    if matches!(leaf,ResolvedType::Scalar(_)|ResolvedType::Enum{..}){
                        let ty=data_type(ir,declared)?;
                        self.fields.entry(root.parameter.clone()).or_default();
                        self.data_paths.entry(root.parameter).or_default().insert((path.into_iter().map(|(field,model,narrowed)|(field,model.0,narrowed)).collect(),field.clone()),ty);return Some(());
                    }
                }
                let (root,parent)=if let IrExpr::Name(parameter)=&base.expr{(env.roots.get(parameter)?.clone(),false)}else{
                    let IrExpr::Member{base:child,field:parent}=&base.expr else{return None;};
                    let IrExpr::Name(parameter)=&child.expr else{return None;};let original=env.roots.get(parameter)?;
                    let IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(model),..}=&ir.items.get(original.model.0 as usize)?.kind else{return None;};
                    if parent!="parent"||original.query.is_some()||child.ty!=(ResolvedType::Record{symbol:original.model,stored:true}){return None;}
                    (Root{parameter:original.parameter.clone(),model:*model,query:None},true)
                };
                if !matches!(base.ty,ResolvedType::Record{symbol,stored:true}if symbol==root.model){return None;}
                if !parent&&root.query.is_none()&&matches!(field.as_str(),"id"|"version"){
                    let expected=ResolvedType::Scalar(if field=="id"{Scalar::Text}else{Scalar::Int});
                    if value.ty!=expected{return None;}
                    self.identities.entry(root.parameter.clone()).or_default().insert(field.clone());
                    self.fields.entry(root.parameter.clone()).or_default();return Some(());
                }
                if !parent&&(self.aggregates||self.contract_derives)&&root.query.is_none()
                    &&let Some(item)=ir.items.iter().find(|item|item.name==*field&&matches!(item.kind,IrItemKind::DeriveField{model,..}if model==root.model)){
                    let IrItemKind::DeriveField{ty:IrType::Known(ty),expr:Some(body),..}=&item.kind else{return None;};
                    if ty!=&value.ty||!(self.aggregates&&matches!(ty,ResolvedType::Scalar(Scalar::Money|Scalar::Bool))
                        ||self.contract_derives&&matches!(ty,ResolvedType::Record{symbol,..} if matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..})))&&plain_value(ir,ty,0))
                        ||!self.stack.insert(item.id){return None;}
                    self.derived.entry(root.parameter.clone()).or_default().insert(field.clone(),data_type(ir,ty)?);
                    self.fields.entry(root.parameter.clone()).or_default();
                    let mut local=env.clone();local.values.remove("row");local.roots.insert("row".into(),root.clone());
                    self.read(ir,context,body,&local,depth+1)?;self.stack.remove(&item.id);return Some(());
                }
                let(_,ty)=declared_field(ir,root.model,field)?;
                if ty!=&value.ty&&!matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty){return None;}
                let ty=data_type(ir,ty)?;
                if parent{
                    if !matches!(&value.ty,ResolvedType::Scalar(_)|ResolvedType::Enum{..}|ResolvedType::Nullable(_)){return None;}
                    self.fields.entry(root.parameter.clone()).or_default();
                    let stored=self.parents.entry(root.parameter.clone()).or_insert_with(||(root.model,BTreeMap::new()));
                    if stored.0!=root.model{return None;}stored.1.insert(field.clone(),ty);
                }else if let Some(query)=&root.query{self.query_fields.entry(query.clone()).or_default().insert(field.clone(),ty);}
                else{self.fields.entry(root.parameter.clone()).or_default().insert(field.clone(),ty);}
                Some(())
            },
            IrExpr::Binary{op,left,right}if *op==IrBinOp::Coalesce=>{
                self.read(ir,context,left,env,depth+1)?;self.read(ir,context,right,env,depth+1)
            },
            IrExpr::Binary{op:IrBinOp::Add,left,right}if matches!(value.ty,ResolvedType::Array{..})=>{
                self.read(ir,context,left,env,depth+1)?;self.read(ir,context,right,env,depth+1)
            },
            IrExpr::Binary{left,right,..}if self.aggregates=>{
                self.read(ir,context,left,env,depth+1)?;self.read(ir,context,right,env,depth+1)
            },
            IrExpr::Unary{operand,..}if self.aggregates=>self.read(ir,context,operand,env,depth+1),
            IrExpr::Call{target:IrCallTarget::Builtin{id,awaited:false},args}
                if self.aggregates&&matches!(id.as_str(),"any"|"sum")=>self.aggregate(ir,context,id,args,None,env,depth),
            IrExpr::BoundCall{target:IrCallTarget::Builtin{id,awaited:false},args,slots}
                if self.aggregates&&matches!(id.as_str(),"any"|"sum")=>self.aggregate(ir,context,id,args,Some(slots),env,depth),
            IrExpr::Call{target:IrCallTarget::Builtin{awaited:false,..},args}
            |IrExpr::BoundCall{target:IrCallTarget::Builtin{awaited:false,..},args,..}=>{
                for arg in args{self.read(ir,context,arg,env,depth+1)?;}Some(())
            },
            IrExpr::Call{target:IrCallTarget::DeriveFn(name),args}=>self.helper(ir,context,name,args,None,env,depth),
            IrExpr::BoundCall{target:IrCallTarget::DeriveFn(name),args,slots}=>self.helper(ir,context,name,args,Some(slots),env,depth),
            IrExpr::Query(query)=>self.query(ir,context,query,value,env,depth),
            _=>None,
        }
    }
    // This census grants no aggregate value. The original generated Values
    // expression runs over independently projected complete child domains.
    fn aggregate(&mut self,ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,id:&str,
        args:&[TypedExpr],slots:Option<&Vec<Option<usize>>>,env:&Environment,depth:usize)->Option<()> {
        if args.len()!=2{return None;}
        let indexes=if let Some(slots)=slots{let [Some(a),Some(b)]=slots.as_slice()else{return None;};[*a,*b]}else{[0,1]};
        if indexes[0]==indexes[1]{return None;}
        let collection=args.get(indexes[0])?;let operand=args.get(indexes[1])?;
        let IrExpr::Query(query)=&collection.expr else{return None;};
        let super::ir::IrQueryDomain::Model(name)=&query.domain else{return None;};
        let model=ir.items.iter().find(|item|item.canonical==*name)?;
        let IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(parent_model),..}=&model.kind else{return None;};
        let parent=query.parent.as_deref()?;let IrExpr::Name(parameter)=&parent.expr else{return None;};
        let root=env.roots.get(parameter)?;
        if root.query.is_some()||root.model!=*parent_model||parent.ty!=(ResolvedType::Record{symbol:root.model,stored:true})
            ||query.limit.is_some()||query.archived.is_some()||!query.order.is_empty()||query.value_order.is_some()
            ||self.queries.len()>=200{return None;}
        let key=(collection.span.file.0,collection.span.start,collection.span.end);
        if !self.query_spans.insert(key){return None;}
        let source=context.db().get(collection.span.file)?;
        let module=ir.modules.iter().filter(|module|module.file==collection.span.file&&module.span.start<=collection.span.start&&collection.span.end<=module.span.end)
            .min_by_key(|module|module.span.end-module.span.start)?;
        let query_id=crate::source::sha256_hex(format!("source-emit-aggregate/v1:{}:{}:{}:{}",source.path,source.sha256,collection.span.start,collection.span.end).as_bytes());
        self.query_fields.insert(query_id.clone(),BTreeMap::new());
        let mut local=env.clone();
        let row=Root{parameter:root.parameter.clone(),model:model.id,query:Some(query_id.clone())};
        if let Some(predicate)=&query.where_pred{
            if predicate.ty!=ResolvedType::Scalar(Scalar::Bool){return None;}
            local.values.remove(&query.where_param);local.roots.insert(query.where_param.clone(),row.clone());
            self.read(ir,context,predicate,&local,depth+1)?;
        }
        if id=="sum"{
            let projection=query.select.as_deref()?;let alias=query.select_param.as_ref()?;
            if projection.ty!=ResolvedType::Scalar(Scalar::Money)||operand.ty!=ResolvedType::Scalar(Scalar::Currency){return None;}
            local.values.remove(alias);local.roots.insert(alias.clone(),row);
            self.read(ir,context,projection,&local,depth+1)?;self.read(ir,context,operand,env,depth+1)?;
        }else{
            if query.select.is_some()||query.where_pred.is_some(){return None;}
            let IrExpr::Lambda{param,body}=&operand.expr else{return None;};
            if body.ty!=ResolvedType::Scalar(Scalar::Bool){return None;}
            local.values.remove(param);local.roots.insert(param.clone(),row);
            self.read(ir,context,body,&local,depth+1)?;
        }
        let fields=self.query_fields.get(&query_id)?;if fields.is_empty()||fields.len()>200{return None;}
        self.fields.entry(root.parameter.clone()).or_default();
        self.queries.insert(query_id.clone(),serde_json::json!({"id":query_id,"source":{"path":source.path,"sha256":source.sha256,"module":module.name},
            "node":{"file":collection.span.file.0,"start":collection.span.start,"end":collection.span.end},"parameter":root.parameter,
            "model":model.canonical,"parentModel":ir.items[root.model.0 as usize].canonical,
            "fields":field_descriptors(fields),"order":[]}));
        Some(())
    }
    fn helper(&mut self,ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,name:&str,
        args:&[TypedExpr],slots:Option<&Vec<Option<usize>>>,env:&Environment,depth:usize)->Option<()> {
        let helper=ir.items.iter().find(|item|item.canonical==name)?;
        let IrItemKind::DeriveFn{params,expr:Some(body),..}=&helper.kind else{return None;};
        if self.stack.len()>=16||!self.stack.insert(helper.id)||args.len()>params.len(){return None;}
        let mut callee=Environment::default();let mut used=BTreeSet::new();
        for(index,id)in params.iter().enumerate(){
            let param=ir.items.get(id.0 as usize)?;
            let IrItemKind::Param{owner,ty:IrType::Known(ty),default,..}=&param.kind else{return None;};
            if *owner!=helper.id{return None;}
            let slot=slots.map(|slots|slots.get(index).copied().flatten()).unwrap_or(Some(index));
            let arg=if let Some(slot)=slot{
                if !used.insert(slot){return None;}args.get(slot)?
            }else{
                let Some(super::ir::IrDefault::Literal(value))=default else{return None;};value
            };
            if let ResolvedType::Record{symbol,stored:true}=ty
                && matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}){
                let IrExpr::Name(name)=&arg.expr else{return None;};let root=env.roots.get(name)?;
                if root.model!=*symbol||root.query.is_some()||arg.ty!=*ty{return None;}
                callee.roots.insert(param.name.clone(),root.clone());
            }else{
                if !plain_value(ir,ty,0){return None;}
                self.read(ir,context,arg,env,depth+1)?;
                callee.values.insert(param.name.clone());
            }
        }
        if used.len()!=args.len(){return None;}
        self.read(ir,context,body,&callee,depth+1)?;self.stack.remove(&helper.id);Some(())
    }
    fn query(&mut self,ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,query:&super::ir::IrQuery,
        value:&TypedExpr,env:&Environment,depth:usize)->Option<()> {
        let super::ir::IrQueryDomain::Model(name)=&query.domain else{return None;};
        let model=ir.items.iter().find(|item|item.canonical==*name)?;
        let IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(parent_model),..}=&model.kind else{return None;};
        let parent=query.parent.as_deref()?;let IrExpr::Name(parameter)=&parent.expr else{return None;};
        let root=env.roots.get(parameter)?;
        let ResolvedType::Array{element,..}=&value.ty else{return None;};
        let ResolvedType::Record{symbol:contract,stored:false}=element.as_ref() else{return None;};
        if root.query.is_some()||root.model!=*parent_model||parent.ty!=(ResolvedType::Record{symbol:root.model,stored:true})
            ||!matches!(ir.items.get(contract.0 as usize)?.kind,IrItemKind::Contract{..})
            ||query.where_pred.is_some()||query.limit.is_some()||query.archived.is_some()
            ||query.order.len()>1||query.value_order.is_some()||self.queries.len()>=200
        {return None;}
        let projection=query.select.as_deref()?;
        if projection.ty!=**element||!matches!(projection.expr,IrExpr::Object(_)){return None;}
        let alias=query.select_param.as_ref()?;
        let key=(value.span.file.0,value.span.start,value.span.end);
        if !self.query_spans.insert(key){return None;}
        let source=context.db().get(value.span.file)?;
        let module=ir.modules.iter().filter(|module|module.file==value.span.file&&module.span.start<=value.span.start&&value.span.end<=module.span.end)
            .min_by_key(|module|module.span.end-module.span.start)?;
        let id=crate::source::sha256_hex(format!("source-send-query/v1:{}:{}:{}:{}",source.path,source.sha256,value.span.start,value.span.end).as_bytes());
        let mut local=env.clone();local.roots.insert(alias.clone(),Root{parameter:root.parameter.clone(),model:model.id,query:Some(id.clone())});
        local.values.remove(alias);
        self.query_fields.insert(id.clone(),BTreeMap::new());
        self.read(ir,context,projection,&local,depth+1)?;
        let mut order=Vec::new();
        for term in &query.order{
            let(_,ty)=declared_field(ir,model.id,&term.field)?;
            let ty=data_type(ir,ty)?;
            self.query_fields.get_mut(&id)?.insert(term.field.clone(),ty);
            order.push(serde_json::json!({"field":term.field,"direction":if term.descending{"desc"}else{"asc"}}));
        }
        let fields=self.query_fields.get(&id)?;
        if fields.is_empty()||fields.len()>200{return None;}
        self.fields.entry(root.parameter.clone()).or_default();
        self.queries.insert(id.clone(),serde_json::json!({"id":id,"source":{"path":source.path,"sha256":source.sha256,"module":module.name},
            "node":{"file":value.span.file.0,"start":value.span.start,"end":value.span.end},
            "parameter":root.parameter,"model":model.canonical,"parentModel":ir.items[root.model.0 as usize].canonical,
            "fields":field_descriptors(fields),"order":order}));
        Some(())
    }
}

pub(super) fn source_only_data_sends(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,let_data:&HashMap<Span,serde_json::Value>,module:&str,loops:Option<&serde_json::Value>)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    context.same_scenario(ir, owner)?;
    let creates=super::source_created_rows::collect(ir,owner,context,&source)?;
    let (mut env,mut models)=Environment::admitted(ir,params)?;
    fn walk(ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,owner:&IrItem,body:&[IrStmt],env:&mut Environment,
        models:&mut BTreeMap<String,SymbolId>,created_roots:&mut BTreeMap<String,serde_json::Value>,creates:&[serde_json::Value],loop_roots:&BTreeMap<String,String>,loops:Option<&serde_json::Value>,let_data:&HashMap<Span,serde_json::Value>,source:&serde_json::Value,module:&str,output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,value,span}=>{let pure=send_value(ir,value,&env.values,0)||let_data.contains_key(span)||observed_scalar_value(ir,value,let_data,&env.values);env.values.remove(name);env.roots.remove(name);models.remove(name);created_roots.remove(name);if pure{env.values.insert(name.clone());}},
            IrStmt::Create{binding:Some(name),model,span,..}=>{
                env.values.remove(name);env.roots.remove(name);models.remove(name);created_roots.remove(name);
                if let Some(profile)=creates.iter().find(|profile|profile["node"]["start"]==span.start&&profile["node"]["end"]==span.end)
                    &&let Some(target)=ir.items.iter().find(|item|item.canonical==*model){
                    env.roots.insert(name.clone(),Root{parameter:name.clone(),model:target.id,query:None});models.insert(name.clone(),target.id);created_roots.insert(name.clone(),profile.clone());
                }
            },
            IrStmt::Send{operation,deployment_binding:Some(binding),args,when:None,span,..}=>{
                let mut reads=Reads{contract_derives:true,..Reads::default()};
                if reads.read(ir,context,args,env,0).is_none()||reads.fields.is_empty()||reads.fields.len()>200||reads.data_paths.keys().any(|name|loop_roots.contains_key(name)||created_roots.contains_key(name))||reads.identity_paths.keys().any(|name|loop_roots.contains_key(name)||created_roots.contains_key(name))||reads.identities.keys().any(|name|loop_roots.contains_key(name)||created_roots.contains_key(name))||reads.queries.values().any(|query|query["parameter"].as_str().is_some_and(|name|loop_roots.contains_key(name)||created_roots.contains_key(name))){continue;}
                let mut parameters=Vec::new();
                for(name,fields)in &reads.fields{
                    let Some(model)=models.get(name)else{continue;};
                    let mut value=reads.parameter(ir,name,*model,fields);
                    if let Some(id)=loop_roots.get(name){value["loop"]=serde_json::json!(id);}
                    if let Some(created)=created_roots.get(name){value["created"]=created.clone();}
                    parameters.push(value);
                }
                let mut value=serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"operation":operation,"binding":binding,"parameters":parameters});
                if !reads.queries.is_empty(){value["queries"]=serde_json::json!(reads.queries.values().collect::<Vec<_>>());}
                output.insert(*span,value);
            },
            IrStmt::For{item,domain,body,span,..}=>{
                let Some(entry)=loops.and_then(|source|source["loops"].as_array()).and_then(|entries|entries.iter().find(|entry|entry["node"]["start"]==span.start&&entry["node"]["end"]==span.end))else{continue;};
                let ResolvedType::Array{element,..}=&domain.ty else{continue;};let ResolvedType::Record{symbol,stored:true}=element.as_ref()else{continue;};
                let mut nested=env.clone();nested.values.remove(item);nested.roots.insert(item.clone(),Root{parameter:item.clone(),model:*symbol,query:None});
                let mut models=models.clone();models.insert(item.clone(),*symbol);
                let mut roots=loop_roots.clone();roots.insert(item.clone(),entry["id"].as_str().unwrap().to_owned());
                let mut created=created_roots.clone();created.remove(item);
                walk(ir,context,owner,body,&mut nested,&mut models,&mut created,creates,&roots,loops,let_data,source,module,output);
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,context,owner,then_branch,&mut env.clone(),&mut models.clone(),&mut created_roots.clone(),creates,loop_roots,loops,let_data,source,module,output);walk(ir,context,owner,else_branch,&mut env.clone(),&mut models.clone(),&mut created_roots.clone(),creates,loop_roots,loops,let_data,source,module,output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,context,owner,&arm.body,&mut env.clone(),&mut models.clone(),&mut created_roots.clone(),creates,loop_roots,loops,let_data,source,module,output);},
            _=>{},
        }}
    }
    let mut output=HashMap::new();walk(ir,context,owner,effects,&mut env,&mut models,&mut BTreeMap::new(),&creates,&BTreeMap::new(),loops,let_data,&source,module,&mut output);Some(output)
}

pub(super) fn source_only_data_emits(ir:&IrProgram,owner:&IrItem,context:&super::source_context::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    fn has_emit(body:&[IrStmt])->bool{body.iter().any(|statement|match statement{IrStmt::Emit{..}=>true,
        IrStmt::If{then_branch,else_branch,..}=>has_emit(then_branch)||has_emit(else_branch),IrStmt::Match{arms,..}=>arms.iter().any(|arm|has_emit(&arm.body)),_=>false})}
    if !has_emit(effects){return Some(HashMap::new());}
    context.same_scenario(ir, owner)?;
    let creates=super::source_created_rows::collect(ir,owner,context,&source)?;
    let (mut env,models)=Environment::admitted(ir,params)?;
    fn walk(ir:&IrProgram,context:&super::source_context::FreshSourceContext<'_>,owner:&IrItem,body:&[IrStmt],env:&mut Environment,
        models:&BTreeMap<String,SymbolId>,created:&mut BTreeMap<String,serde_json::Value>,creates:&[serde_json::Value],source:&serde_json::Value,module:&str,output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=send_value(ir,value,&env.values,0);env.values.remove(name);env.roots.remove(name);created.remove(name);if pure{env.values.insert(name.clone());}},
            IrStmt::Create{binding:Some(name),span,..}=>{
                created.remove(name);env.values.remove(name);env.roots.remove(name);
                if let Some(profile)=creates.iter().find(|profile|profile["node"]["start"]==span.start&&profile["node"]["end"]==span.end){created.insert(name.clone(),profile.clone());}
            },
            IrStmt::Emit{event,payload:args,span}=>{
                if context.same_event_schema(event).is_none(){continue;}
                let Some(declaration)=ir.items.iter().find(|item|item.canonical==*event&&item.module==owner.module)else{continue;};
                let IrItemKind::Event{fields}=&declaration.kind else{continue;};
                let IrExpr::Object(entries)=&args.expr else{continue;};
                if fields.len()!=entries.len()||!entries.iter().all(|(name,value)|fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|field|field.name==*name&&matches!(&field.kind,
                    IrItemKind::Field{ty:IrType::Known(ty),..}if ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner) if inner.as_ref()==&value.ty)
                        ||matches!(ty,ResolvedType::Nullable(_))&&value.ty==ResolvedType::Null&&matches!(value.expr,IrExpr::Null)||matches!((ty,&value.ty),
                        (ResolvedType::Record{symbol:a,..},ResolvedType::Record{symbol:b,stored:false})if a==b&&matches!(ir.items.get(a.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..})))))){continue;}
                let mut reads=Reads{aggregates:true,..Reads::default()};let mut references=Vec::new();let mut valid=true;
                for(field,value)in entries{
                    if let (IrExpr::Name(name),ResolvedType::Record{symbol,stored:true})=(&value.expr,&value.ty)
                        && let Some(root)=env.roots.get(name)
                        && root.model==*symbol&&root.query.is_none()&&matches!(ir.items[symbol.0 as usize].kind,IrItemKind::Model{..}){
                        references.push(serde_json::json!({"field":field,"parameter":root.parameter,"model":ir.items[symbol.0 as usize].canonical}));
                    }else if let (IrExpr::Name(name),ResolvedType::Record{symbol,stored:true})=(&value.expr,&value.ty)
                        && let Some(profile)=created.get(name)
                        && profile["model"]==ir.items[symbol.0 as usize].canonical {
                        references.push(serde_json::json!({"field":field,"parameter":name,"model":profile["model"],"created":profile}));
                    }else if let Some((root,path))=required_identity_path(ir,value,env,0)
                        && !path.is_empty(){
                        let target=path.last().expect("nonempty original path").1;
                        let path=path.into_iter().map(|(field,model,narrowed)|(field,model.0,narrowed)).collect::<Vec<_>>();
                        let wire=path_descriptor(ir,&path);
                        reads.fields.entry(root.parameter.clone()).or_default();reads.identity_paths.entry(root.parameter.clone()).or_default().insert(path,"id".into());
                        references.push(serde_json::json!({"field":field,"parameter":root.parameter,"model":ir.items[target.0 as usize].canonical,"path":wire}));
                    }else if reads.read(ir,context,value,env,0).is_none(){valid=false;break;}
                }
                if !valid||reads.fields.is_empty()||reads.fields.len()>200{continue;}
                let mut parameters=Vec::new();
                for(name,fields)in &reads.fields{
                    let Some(model)=models.get(name)else{continue;};
                    let value=reads.parameter(ir,name,*model,fields);
                    parameters.push(value);
                }
                let mut value=serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"event":event,"parameters":parameters});
                if !references.is_empty(){value["references"]=serde_json::json!(references);}
                if !reads.queries.is_empty(){value["queries"]=serde_json::json!(reads.queries.values().collect::<Vec<_>>());}
                output.insert(*span,value);
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,context,owner,then_branch,&mut env.clone(),models,&mut created.clone(),creates,source,module,output);walk(ir,context,owner,else_branch,&mut env.clone(),models,&mut created.clone(),creates,source,module,output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,context,owner,&arm.body,&mut env.clone(),models,&mut created.clone(),creates,source,module,output);},
            _=>{},
        }}
    }
    let mut output=HashMap::new();walk(ir,context,owner,effects,&mut env,&models,&mut BTreeMap::new(),&creates,&source,module,&mut output);Some(output)
}
