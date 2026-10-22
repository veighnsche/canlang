//! The exact Event attendee Notice is an outbound audit sink. Its localized
//! subject/body remain forbidden in ordinary business model fields.
use serde_json::{Value,json};
use crate::analysis::{ResolvedType,Scalar};
use super::ir::{IrItem,IrItemKind,IrStmt,IrExpr};
use super::scenario_decisions::FreshSourceContext;
use super::scenario_receipts::transport_source;
use super::term_decisions as t;

pub(super) fn checked(cx:&FreshSourceContext<'_>,owner:&IrItem,entry:&str)->Option<Value> {
    if owner.canonical!="events.attendee_notice" {return None;}
    let original=cx.original().effects.scenarios.get(&owner.id)?;
    let IrItemKind::Scenario {trusted:true,read:false,result:None,event_source:Some(super::ir::IrEventSource::Declared(event)),params,by,effects,guards,..}=&owner.kind else{return None;};
    if event!="events.AttendeeNotice" || !params.is_empty() || !by.is_empty()
        || guards.len()!=1 || effects.len()!=4 || original.guards.len()!=1 || original.effects.len()!=4
        || format!("{:?}",owner.kind)!=format!("{:?}",cx.fresh().items.get(owner.id.0 as usize)?.kind)
        || t::text(cx.db(),original.guards[0].cond?)?!="event.registration.parent.revision==event.revision"
        || t::text(cx.db(),original.effects[0].node)?!="let subject=format(notice_title(event.kind),locale=null)"
        || t::text(cx.db(),original.effects[1].node)?!="let body=format(notice_details(event.registration.parent.name,event.registration.parent.location.name,event.registration.parent.from,event.registration.parent.until,event.registration.parent.timezone,event.body,event.registration.ticket,event.revision,app_url(\"/events\")),locale=null)"
        || t::text(cx.db(),original.effects[2].when?)?!="event.registration.parent.revision==event.revision and (event.kind!=confirmation or (event.registration.state==confirmed and not event.registration.parent.cancelled))"
        || t::text(cx.db(),original.effects[3].node)?!="create Notice {parent=event.registration,kind=event.kind,revision=event.revision,subject,body,delivery} as notice"
    {return None;}
    let IrStmt::Send {operation,binding:Some(binding),..}=&effects[2] else{return None;};
    let IrStmt::Create {model,binding:Some(created),span,..}=&effects[3] else{return None;};
    if operation!="std.EmailV1.send" || binding!="delivery" || model!="events.Notice" || created!="notice" {return None;}
    for name in ["events.AttendeeNotice","events.Notice","events.notice_title","events.notice_details"] {
        let id=t::symbol(cx.original(),name)?;
        if format!("{:?}",cx.ir().items.get(id.0 as usize)?)!=format!("{:?}",cx.fresh().items.get(id.0 as usize)?) {return None;}
    }
    let event_id=t::symbol(cx.original(),event)?;
    let IrItemKind::Event {fields}= &cx.ir().items.get(event_id.0 as usize)?.kind else{return None;};
    if fields.len()!=4 {return None;}
    let mut event_fields=Vec::new();
    for (id,name) in fields.iter().zip(["registration","kind","revision","body"]) {
        let item=cx.ir().items.get(id.0 as usize)?;
        let IrItemKind::Field {owner:declared,ty:super::ir::IrType::Known(ty),..}=&item.kind else{return None;};
        if *declared!=event_id || item.name!=name || format!("{item:?}")!=format!("{:?}",cx.fresh().items.get(id.0 as usize)?) {return None;}
        let type_id:String=match (name,ty) {
            ("registration",ResolvedType::Record {symbol,stored:true}) if cx.ir().items.get(symbol.0 as usize)?.canonical=="events.Registration"=>"events.Registration".into(),
            ("kind",ResolvedType::Enum {owner:Some(symbol),cases}) if cases==&["confirmation","change","cancellation"] && cx.ir().items.get(symbol.0 as usize)?.canonical=="events.Notice.kind"=>"events.Notice.kind".into(),
            ("revision",ResolvedType::Scalar(Scalar::Int))=>"int".into(),
            ("body",ResolvedType::Scalar(Scalar::Text))=>"text".into(),_=>return None,
        };
        event_fields.push(json!({"name":name,"type":type_id}));
    }
    let mut formats=Vec::new();
    for (statement,field) in effects.iter().take(2).zip(["subject","body"]) {
        let IrStmt::Let{value,..}=statement else{return None;};
        let IrExpr::Format{args,descriptor_index,locale_index,schemas}=&value.expr else{return None;};
        let descriptor=match &args.get(*descriptor_index)?.expr {IrExpr::Message(descriptor)|IrExpr::MessageCall{descriptor,..}=>descriptor,_=>return None};
        if !matches!(args.get(*locale_index)?.expr,IrExpr::Null) || schemas.len()!=1 {return None;}
        let variants:serde_json::Map<String,Value>=descriptor.variants.iter().map(|(key,value)|(key.clone(),json!(value))).collect();
        let signature=&schemas[0];
        formats.push(json!({"field":field,"node":{"start":value.span.start,"end":value.span.end},
            "source":descriptor.source,"sourceLang":descriptor.source_lang,"variants":variants,
            "parameters":signature.param_types.iter().map(|(name,canonical,presentation)|json!({"name":name,"type":canonical,"presentation":presentation})).collect::<Vec<_>>()}));
    }
    let source=super::scenario_calls::checked_source(cx.ir(),owner,cx.db())?;
    Some(json!({"version":1,"owner":owner.canonical,"source":transport_source(&source.source,entry)?,
        "event":event,"fields":event_fields,"model":model,"stage":0,
        "create":{"start":span.start,"end":span.end},"auditFields":["subject","body"],"formats":formats}))
}
