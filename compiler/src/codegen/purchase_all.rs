//! The post-write universal purchase completion decision. This profile owns
//! only the exact ALL occurrence; replay, SEND and writes retain their normal
//! source/effect receipts. The runtime observes complete staged child domains.
use serde_json::{Value, json};
use crate::analysis::{ ResolvedType, Scalar, SymbolKind};
use crate::source::Span;
use super::ir::{IrExpr, IrItem, IrItemKind, IrStmt};
use super::source_context::FreshSourceContext;
use super::scenario_receipts::transport_source;
use super::term_decisions as t;

pub(super) fn checked(cx: &FreshSourceContext<'_>, owner: &IrItem, entry: &str) -> Option<Value> {
    if !matches!(owner.canonical.as_str(), "purchase.receive" | "CanPurchase.receive") { return None; }
    let namespace = owner.canonical.strip_suffix(".receive")?;
    let canonical = |name: &str| format!("{namespace}.{name}");
    let program = cx.original();
    let source = super::scenario_calls::checked_source(cx.ir(), owner, cx.db())?;
    let original = program.effects.scenarios.get(&owner.id)?;
    let fresh = cx.fresh().items.get(owner.id.0 as usize)?;
    if format!("{:?}", owner.kind) != format!("{:?}", fresh.kind) { return None; }
    let IrItemKind::Scenario { effects, read: false, trusted: false, event_source: None,
        cohort: None, hook: None, params, .. } = &owner.kind else { return None; };
    if original.effects.len() != 8 || effects.len() != 8 || params.len() != 6 { return None; }
    let expected = [("line", "Line"), ("source", "text"), ("accepted", "int"),
        ("rejected", "int"), ("received_on", "date"), ("evidence", "text")];
    // There are six authored inputs; keep their exact declaration order.
    if params.len() != expected.len() { return None; }
    for (id, (name, ty)) in params.iter().zip(expected) {
        let parameter = cx.ir().items.get(id.0 as usize)?;
        let IrItemKind::Param { default: None, ty: super::ir::IrType::Known(actual), .. } = &parameter.kind else { return None; };
        let actual_name = match actual { ResolvedType::Record { symbol, stored: true } => cx.ir().items.get(symbol.0 as usize)?.canonical.as_str(),
            ResolvedType::Scalar(scalar) => scalar.as_str(), _ => return None };
        if parameter.name != name || (if name == "line" { actual_name != canonical(ty) } else { actual_name != ty }) { return None; }
    }
    let node = original.effects.get(6)?.cond?;
    if t::text(cx.db(), node)? != "all(line.parent.Line as item,item.accepted==item.ordered)" { return None; }
    let call = program.types.checked_collection_calls.get(&node)?;
    let line = t::symbol(program, &canonical("Line"))?;
    let order = t::symbol(program, &canonical("Order"))?;
    let receipt = t::symbol(program, &canonical("Receipt"))?;
    let amendment = t::symbol(program, &canonical("Amendment"))?;
    if call.builtin != "all" || call.model != line || call.overload != 0 { return None; }
    for (child, parent) in [(line, order), (receipt, line), (amendment, line)] {
        if !matches!(program.symbols.get(child.0 as usize)?.kind,
            SymbolKind::Model { owner: crate::analysis::resolve::ModelOwner::ChildOf(actual), .. } if actual == parent)
            || format!("{:?}", cx.ir().items.get(child.0 as usize)?.kind) != format!("{:?}", cx.fresh().items.get(child.0 as usize)?.kind)
        { return None; }
    }
    for (canonical, text) in [("Line.accepted", "sum(row.Receipt as receipt select receipt.accepted)"),
        ("Line.ordered", "row.quantity+sum(row.Amendment as amendment select amendment.quantity)")] {
        let id = t::symbol(program, &format!("{namespace}.{canonical}"))?;
        let data = program.effects.derives.get(&id)?;
        if t::text(cx.db(), data.expr?)? != text || program.types.symbol_types.get(&id) != Some(&ResolvedType::Scalar(Scalar::Int))
            || format!("{:?}", cx.ir().items.get(id.0 as usize)?.kind) != format!("{:?}", cx.fresh().items.get(id.0 as usize)?.kind)
        { return None; }
    }
    for canonical in ["Line.quantity", "Receipt.accepted", "Amendment.quantity"] {
        let id = t::symbol(program, &format!("{namespace}.{canonical}"))?;
        if program.types.symbol_types.get(&id) != Some(&ResolvedType::Scalar(Scalar::Int)) { return None; }
    }
    let text = |index: usize| t::text(cx.db(), original.effects.get(index)?.node);
    if text(0)? != "let previous=first(Receipt as receipt where receipt.source==source order=receipt.id)"
        || text(3)? != "create Receipt {parent=line,source,accepted,rejected,received=received_on,evidence} as receipt"
        || text(5)? != "set line.parent {state=part_received}" || text(7)? != "return receipt"
    { return None; }
    let replay = &original.effects[1];
    if t::text(cx.db(), replay.cond?)? != "previous!=null"
        || replay.then_effects.len() != 2 || !replay.else_effects.is_empty()
        || t::text(cx.db(), replay.then_effects[0].node)? != "require previous.parent==line and previous.accepted==accepted and previous.rejected==rejected and previous.received==received_on and previous.evidence==evidence"
        || t::text(cx.db(), replay.then_effects[1].node)? != "return previous"
        || text(2)? != "require line.parent.parent.state==approved and line.parent.state in [ordered,part_received] and accepted<=line.ordered-line.accepted"
    { return None; }
    let IrStmt::If { cond: posted, then_branch, else_branch, .. } = &effects[4] else { return None; };
    if t::text(cx.db(), original.effects[4].cond?)? != "accepted>0"
        || then_branch.len() != 2 || else_branch.len() != 1
        || !matches!(&then_branch[0], IrStmt::Send { when: None, binding: Some(name), .. } if name == "delivery")
        || !matches!(&then_branch[1], IrStmt::Set { .. }) || !matches!(&else_branch[0], IrStmt::Set { .. })
        || posted.ty != ResolvedType::Scalar(Scalar::Bool)
        || t::text(cx.db(), original.effects[4].then_effects.get(1)?.node)? != "set receipt {delivery=delivery.id,attempts=1}"
        || t::text(cx.db(), original.effects[4].else_effects.first()?.node)? != "set receipt {posting=confirmed}"
    { return None; }
    let IrStmt::If { cond, then_branch, else_branch, span } = &effects[6] else { return None; };
    if !else_branch.is_empty() || then_branch.len() != 1 || cond.span != Span::new(node.file,node.start,node.end)
        || t::text(cx.db(), original.effects[6].then_effects.first()?.node)? != "set line.parent {state=received}"
        || !matches!(&cond.expr, IrExpr::Call { .. } | IrExpr::BoundCall { .. })
    { return None; }
    Some(json!({"version":1,"owner":owner.canonical,"source":transport_source(&source.source,entry)?,
        "node":{"start":node.start,"end":node.end},"statement":{"start":span.start,"end":span.end},
        "stage":3,"parameter":"line","order":canonical("Order"),"line":canonical("Line"),
        "receipt":canonical("Receipt"),"amendment":canonical("Amendment")}))
}

pub(super) fn at(plan: &Value, span: Span) -> bool {
    plan["node"]["start"].as_u64() == Some(span.start as u64)
        && plan["node"]["end"].as_u64() == Some(span.end as u64)
}
