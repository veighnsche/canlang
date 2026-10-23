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
#[derive(Default)]
struct Reads {
    fields:BTreeMap<String,BTreeMap<String,String>>,
    identities:BTreeMap<String,BTreeSet<String>>,
    query_fields:BTreeMap<String,BTreeMap<String,String>>,
    queries:BTreeMap<String,serde_json::Value>,
    query_spans:BTreeSet<(u32,u32,u32)>,
    steps:usize, stack:HashSet<SymbolId>,
    aggregates:bool,
    derived:BTreeMap<String,BTreeMap<String,String>>,
}
fn data_type(ir:&IrProgram,ty:&ResolvedType)->Option<String>{match ty{
    ResolvedType::Scalar(scalar)if !matches!(scalar,Scalar::File|Scalar::Secret|Scalar::Member|Scalar::Json|Scalar::Bytes|Scalar::Url|Scalar::Locale)=>Some(scalar.as_str().into()),
    ResolvedType::Enum{owner:Some(id),cases}if !cases.is_empty()=>{
        let owner=ir.items.get(id.0 as usize)?;Some(if matches!(owner.kind,IrItemKind::Field{owner,..}if ir.items.get(owner.0 as usize).is_some_and(|item|matches!(item.kind,IrItemKind::Model{..}))){format!("enum({})",cases.join(","))}else{owner.canonical.clone()})
    },
    ResolvedType::Enum{owner:None,cases}if !cases.is_empty()=>Some(format!("enum({})",cases.join(","))),
    ResolvedType::Nullable(inner)=>Some(format!("{}?",data_type(ir,inner)?)),_=>None}}
fn declared_field<'a>(ir:&'a IrProgram,model:SymbolId,name:&str)->Option<(&'a IrItem,&'a ResolvedType)>{
    let IrItemKind::Model{fields,..}=&ir.items.get(model.0 as usize)?.kind else{return None;};
    let field=fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).find(|item|item.name==name)?;
    let IrItemKind::Field{owner,ty:IrType::Known(ty),..}=&field.kind else{return None;};
    (*owner==model).then_some((field,ty))
}
impl Reads {
    fn read(&mut self,ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,
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
                let IrExpr::Name(parameter)=&base.expr else{return None;};let root=env.roots.get(parameter)?;
                if !matches!(base.ty,ResolvedType::Record{symbol,stored:true}if symbol==root.model){return None;}
                if root.query.is_none()&&matches!(field.as_str(),"id"|"version"){
                    let expected=ResolvedType::Scalar(if field=="id"{Scalar::Text}else{Scalar::Int});
                    if value.ty!=expected{return None;}
                    self.identities.entry(root.parameter.clone()).or_default().insert(field.clone());
                    self.fields.entry(root.parameter.clone()).or_default();return Some(());
                }
                if self.aggregates&&root.query.is_none()
                    &&let Some(item)=ir.items.iter().find(|item|item.name==*field&&matches!(item.kind,IrItemKind::DeriveField{model,..}if model==root.model)){
                    let IrItemKind::DeriveField{ty:IrType::Known(ty),expr:Some(body),..}=&item.kind else{return None;};
                    if ty!=&value.ty||!matches!(ty,ResolvedType::Scalar(Scalar::Money|Scalar::Bool))||!self.stack.insert(item.id){return None;}
                    self.derived.entry(root.parameter.clone()).or_default().insert(field.clone(),data_type(ir,ty)?);
                    self.fields.entry(root.parameter.clone()).or_default();
                    let mut local=env.clone();local.values.remove("row");local.roots.insert("row".into(),root.clone());
                    self.read(ir,context,body,&local,depth+1)?;self.stack.remove(&item.id);return Some(());
                }
                let(_,ty)=declared_field(ir,root.model,field)?;
                if ty!=&value.ty&&!matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty){return None;}
                let ty=data_type(ir,ty)?;
                if let Some(query)=&root.query{self.query_fields.entry(query.clone()).or_default().insert(field.clone(),ty);}
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
    fn aggregate(&mut self,ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,id:&str,
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
            "fields":fields.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect::<Vec<_>>(),"order":[]}));
        Some(())
    }
    fn helper(&mut self,ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,name:&str,
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
    fn query(&mut self,ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,query:&super::ir::IrQuery,
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
            "fields":fields.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect::<Vec<_>>(),"order":order}));
        Some(())
    }
}

pub(super) fn source_only_data_sends(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str,loops:Option<&serde_json::Value>)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    super::scenario_decisions::same_scenario_semantics(context.original(),ir,context.fresh(),owner)?;
    let mut env=Environment::default();let mut models=BTreeMap::new();
    for id in params{
        let param=ir.items.get(id.0 as usize)?;let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
        if let ResolvedType::Record{symbol,stored:true}=ty
            && matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}){
            env.roots.insert(param.name.clone(),Root{parameter:param.name.clone(),model:*symbol,query:None});models.insert(param.name.clone(),*symbol);
        }else if plain_value(ir,ty,0){env.values.insert(param.name.clone());}
    }
    fn walk(ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,owner:&IrItem,body:&[IrStmt],env:&mut Environment,
        models:&BTreeMap<String,SymbolId>,loop_roots:&BTreeMap<String,String>,loops:Option<&serde_json::Value>,source:&serde_json::Value,module:&str,output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=send_value(ir,value,&env.values,0);env.values.remove(name);env.roots.remove(name);if pure{env.values.insert(name.clone());}},
            IrStmt::Send{operation,deployment_binding:Some(binding),args,when:None,span,..}=>{
                let mut reads=Reads::default();
                if reads.read(ir,context,args,env,0).is_none()||reads.fields.is_empty()||reads.fields.len()>200||reads.identities.keys().any(|name|loop_roots.contains_key(name))||reads.queries.values().any(|query|query["parameter"].as_str().is_some_and(|name|loop_roots.contains_key(name))){continue;}
                let mut parameters=Vec::new();
                for(name,fields)in &reads.fields{
                    let Some(model)=models.get(name)else{continue;};
                    let mut value=serde_json::json!({"name":name,"model":ir.items[model.0 as usize].canonical,
                        "fields":fields.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect::<Vec<_>>()});
                    if let Some(id)=loop_roots.get(name){value["loop"]=serde_json::json!(id);}
                    if let Some(identity)=reads.identities.get(name){value["identity"]=serde_json::json!(identity);}
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
                walk(ir,context,owner,body,&mut nested,&models,&roots,loops,source,module,output);
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,context,owner,then_branch,&mut env.clone(),models,loop_roots,loops,source,module,output);walk(ir,context,owner,else_branch,&mut env.clone(),models,loop_roots,loops,source,module,output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,context,owner,&arm.body,&mut env.clone(),models,loop_roots,loops,source,module,output);},
            _=>{},
        }}
    }
    let mut output=HashMap::new();walk(ir,context,owner,effects,&mut env,&models,&BTreeMap::new(),loops,&source,module,&mut output);Some(output)
}

pub(super) fn source_only_data_emits(ir:&IrProgram,owner:&IrItem,context:&super::scenario_decisions::FreshSourceContext<'_>,
    requires:&HashMap<Span,serde_json::Value>,module:&str)->Option<HashMap<Span,serde_json::Value>>{
    let IrItemKind::Scenario{params,effects,hook:None,read:false,trusted:false,..}=&owner.kind else{return None;};
    let source=requires.values().find(|source|source["owner"]==owner.canonical)?["source"].clone();
    fn has_emit(body:&[IrStmt])->bool{body.iter().any(|statement|match statement{IrStmt::Emit{..}=>true,
        IrStmt::If{then_branch,else_branch,..}=>has_emit(then_branch)||has_emit(else_branch),IrStmt::Match{arms,..}=>arms.iter().any(|arm|has_emit(&arm.body)),_=>false})}
    if !has_emit(effects){return Some(HashMap::new());}
    super::scenario_decisions::same_scenario_semantics(context.original(),ir,context.fresh(),owner)?;
    let mut env=Environment::default();let mut models=BTreeMap::new();
    for id in params{
        let param=ir.items.get(id.0 as usize)?;let IrItemKind::Param{ty:IrType::Known(ty),..}=&param.kind else{return None;};
        if let ResolvedType::Record{symbol,stored:true}=ty
            && matches!(ir.items.get(symbol.0 as usize)?.kind,IrItemKind::Model{..}){
            env.roots.insert(param.name.clone(),Root{parameter:param.name.clone(),model:*symbol,query:None});models.insert(param.name.clone(),*symbol);
        }else if plain_value(ir,ty,0){env.values.insert(param.name.clone());}
    }
    fn walk(ir:&IrProgram,context:&super::scenario_decisions::FreshSourceContext<'_>,owner:&IrItem,body:&[IrStmt],env:&mut Environment,
        models:&BTreeMap<String,SymbolId>,source:&serde_json::Value,module:&str,output:&mut HashMap<Span,serde_json::Value>){
        for statement in body{match statement{
            IrStmt::Let{name,value,..}=>{let pure=send_value(ir,value,&env.values,0);env.values.remove(name);env.roots.remove(name);if pure{env.values.insert(name.clone());}},
            IrStmt::Emit{event,payload:args,span}=>{
                if context.same_event_schema(event).is_none(){continue;}
                let Some(declaration)=ir.items.iter().find(|item|item.canonical==*event&&item.module==owner.module)else{continue;};
                let IrItemKind::Event{fields}=&declaration.kind else{continue;};
                let IrExpr::Object(entries)=&args.expr else{continue;};
                if fields.len()!=entries.len()||!entries.iter().all(|(name,value)|fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|field|field.name==*name&&matches!(&field.kind,
                    IrItemKind::Field{ty:IrType::Known(ty),..}if ty==&value.ty||matches!((ty,&value.ty),
                        (ResolvedType::Record{symbol:a,..},ResolvedType::Record{symbol:b,stored:false})if a==b&&matches!(ir.items.get(a.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..})))))){continue;}
                let mut reads=Reads{aggregates:true,..Reads::default()};let mut references=Vec::new();let mut valid=true;
                for(field,value)in entries{
                    if let (IrExpr::Name(name),ResolvedType::Record{symbol,stored:true})=(&value.expr,&value.ty)
                        && let Some(root)=env.roots.get(name)
                        && root.model==*symbol&&root.query.is_none()&&matches!(ir.items[symbol.0 as usize].kind,IrItemKind::Model{..}){
                        references.push(serde_json::json!({"field":field,"parameter":root.parameter,"model":ir.items[symbol.0 as usize].canonical}));
                    }else if reads.read(ir,context,value,env,0).is_none(){valid=false;break;}
                }
                if !valid||reads.fields.is_empty()||reads.fields.len()>200{continue;}
                let mut parameters=Vec::new();
                for(name,fields)in &reads.fields{
                    let Some(model)=models.get(name)else{continue;};
                    let mut value=serde_json::json!({"name":name,"model":ir.items[model.0 as usize].canonical,
                        "fields":fields.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect::<Vec<_>>()});
                    if let Some(identity)=reads.identities.get(name){value["identity"]=serde_json::json!(identity);}
                    if let Some(derived)=reads.derived.get(name){
                        value["derived"]=serde_json::json!(derived.iter().map(|(name,ty)|serde_json::json!({"name":name,"type":ty})).collect::<Vec<_>>());
                    }
                    parameters.push(value);
                }
                let mut value=serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"event":event,"parameters":parameters});
                if !references.is_empty(){value["references"]=serde_json::json!(references);}
                if !reads.queries.is_empty(){value["queries"]=serde_json::json!(reads.queries.values().collect::<Vec<_>>());}
                output.insert(*span,value);
            },
            IrStmt::If{then_branch,else_branch,..}=>{walk(ir,context,owner,then_branch,&mut env.clone(),models,source,module,output);walk(ir,context,owner,else_branch,&mut env.clone(),models,source,module,output);},
            IrStmt::Match{arms,..}=>for arm in arms{walk(ir,context,owner,&arm.body,&mut env.clone(),models,source,module,output);},
            _=>{},
        }}
    }
    let mut output=HashMap::new();walk(ir,context,owner,effects,&mut env,&models,&source,module,&mut output);Some(output)
}
