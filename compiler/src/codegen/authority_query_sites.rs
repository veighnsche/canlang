//! Checked source sites for owner reads inside an authority-scoped report.
//!
//! The report's existing State decision owns authorization and the final
//! revision fence. This bridge only identifies the model queries that its
//! original body and transitively called derives can execute. An unmarked
//! query never gains owner read access.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::analysis::effects::ScenarioData;
use crate::analysis::resolve::{ModelOwner, SymbolId, SymbolKind};
use crate::analysis::types::{CheckedQuery, CheckedQueryClauseKind, SelectedCallTarget};
use crate::analysis::{NodeKey, ResolvedType};
use crate::source::{Span, sha256_hex};
use crate::syntax::SyntaxKind;

use super::ir::{IrExpr, IrItemKind, IrQuery, IrQueryDomain};
use super::scenario_decisions::FreshSourceContext;

#[derive(Clone)]
pub(super) struct AuthorityQuerySite {
    pub id: String,
    pub node: NodeKey,
    pub model: String,
    pub parent_site: Option<Span>,
    pub predicate_site: Option<Span>,
    pub order: Vec<(String, bool)>,
    pub first_site: Option<Span>,
    pub fact: Option<CheckedQuery>,
    pub wire: Value,
}

pub(super) struct PreparedAuthorityQuerySites {
    pub plan: Value,
    pub sites: HashMap<Span, AuthorityQuerySite>,
    pub firsts: HashMap<Span, Span>,
    reachable: Vec<NodeKey>,
}

fn span(node: NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}

fn interval(node: NodeKey) -> Value {
    json!({"start":node.start,"end":node.end})
}

fn span_interval(span: Span) -> Value {
    json!({"start":span.start,"end":span.end})
}

fn contains(outer: NodeKey, inner: NodeKey) -> bool {
    outer.file == inner.file && outer.start <= inner.start && inner.end <= outer.end
}

fn source<'a>(context: &'a FreshSourceContext<'_>, node: NodeKey) -> Option<(Value, &'a str)> {
    let module = context.original().modules.iter()
        .filter(|module| module.file == node.file
            && module.span.start <= node.start && node.end <= module.span.end)
        .min_by_key(|module| module.span.end - module.span.start)?;
    let file = context.db().get(node.file)?;
    if node.start >= node.end || node.end as usize > file.text.len()
        || file.sha256 != sha256_hex(file.text.as_bytes())
    {
        return None;
    }
    Some((json!({"path":file.path,"sha256":file.sha256,"module":module.name}),
        file.text.get(node.start as usize..node.end as usize)?))
}

fn query_model(context: &FreshSourceContext<'_>, ty: &ResolvedType) -> Option<(SymbolId, String, Option<String>, String)> {
    let ResolvedType::Array { element, .. } = ty else { return None; };
    let ResolvedType::Record { symbol, stored: true } = element.as_ref() else { return None; };
    super::source_loops::model_corresponds(context,*symbol)?;
    let model = context.original().symbols.get(symbol.0 as usize)?;
    let SymbolKind::Model { owner, .. } = &model.kind else { return None; };
    let parent = match owner {
        ModelOwner::ChildOf(parent) => Some(context.original().symbols.get(parent.0 as usize)?.canonical.clone()),
        _ => None,
    };
    Some((*symbol, model.canonical.clone(), parent, model.name.clone()))
}

fn parent_site(domain: NodeKey, domain_text: &str, child_name: &str) -> Option<Span> {
    let trimmed = domain_text.trim();
    let offset = domain_text.find(trimmed)?;
    let prefix = trimmed.strip_suffix(child_name)?.strip_suffix('.')?;
    if prefix.is_empty() { return None; }
    let start = domain.start + offset as u32;
    Some(Span::new(domain.file, start, start + prefix.len() as u32))
}

fn clause_one(fact: &CheckedQuery, kind: CheckedQueryClauseKind) -> Option<Option<NodeKey>> {
    let mut selected = None;
    for clause in &fact.clauses {
        if std::mem::discriminant(&clause.kind) == std::mem::discriminant(&kind) {
            let [expression] = clause.expressions.as_slice() else { return None; };
            if selected.replace(*expression).is_some() { return None; }
        }
    }
    Some(selected)
}

fn checked_order(context: &FreshSourceContext<'_>, fact: &CheckedQuery, alias: &str) -> Option<Vec<(String, bool)>> {
    let mut order = Vec::new();
    for clause in &fact.clauses {
        if !matches!(clause.kind, CheckedQueryClauseKind::Order) { continue; }
        for expression in &clause.expressions {
            let (_, source) = source(context, *expression)?;
            let text = source.trim();
            let (descending, field) = match text.strip_prefix('-') {
                Some(text) => (true, text), None => (false, text),
            };
            let field = field.strip_prefix(alias)?.strip_prefix('.')?;
            if field.is_empty() || !field.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                return None;
            }
            order.push((field.to_owned(), descending));
        }
    }
    Some(order)
}

fn first_call(context: &FreshSourceContext<'_>, query: NodeKey, model: SymbolId) -> Option<Option<NodeKey>> {
    let mut first = None;
    for (node, selected) in &context.original().types.selected_calls {
        if !matches!(&selected.target, SelectedCallTarget::Builtin { id, .. } if id == "first")
            || selected.arguments.as_slice() != [query]
        { continue; }
        let collection = context.original().types.checked_collection_calls.get(node)?;
        if collection.builtin != "first" || collection.query != query || collection.model != model {
            return None;
        }
        if first.replace(*node).is_some() { return None; }
    }
    Some(first)
}

fn relevant_scopes(context: &FreshSourceContext<'_>, scenario: &ScenarioData) -> Option<Vec<(NodeKey, Vec<String>)>> {
    let mut scopes = Vec::new();
    if let Some(by) = scenario.by { scopes.push((by, Vec::new())); }
    scopes.extend(scenario.guards.iter().chain(&scenario.effects).map(|effect| (effect.node, Vec::new())));
    let mut seen = HashSet::new();
    let mut cursor = 0;
    while cursor < scopes.len() {
        let (scope, chain) = scopes[cursor].clone();
        let mut calls = context.original().types.selected_calls.iter()
            .filter(|(node, selected)| contains(scope, **node)
                && matches!(selected.target, SelectedCallTarget::DeriveFn(_)))
            .collect::<Vec<_>>();
        calls.sort_by_key(|(node, _)| (node.file.0, node.start, node.end));
        for (_, selected) in calls {
            let SelectedCallTarget::DeriveFn(id) = selected.target else { continue; };
            if !seen.insert(id) { continue; }
            let derive = context.original().effects.derives.get(&id)?;
            let expr = derive.expr?;
            let mut nested = chain.clone();
            nested.push(context.original().symbols.get(id.0 as usize)?.canonical.clone());
            scopes.push((expr, nested));
        }
        for (_,tree) in context.trees(){
            for member in tree.descendants().filter(|node|node.kind==SyntaxKind::Member&&contains(scope,NodeKey::of(node))){
                let Some(base)=member.children.iter().find(|node|crate::analysis::resolve::is_expression(node.kind))else{continue;};
                let Some(ResolvedType::Record{symbol:model,stored:true})=context.original().types.node_types.get(&NodeKey::of(base))else{continue;};
                let field=member.children.iter().rev().find(|node|node.kind==SyntaxKind::Name)?;
                let (_,name)=source(context,NodeKey::of(field))?;
                let Some(declaration)=context.original().symbols.iter().find(|item|item.name==name&&matches!(item.kind,SymbolKind::DeriveField{model:owner,..}if owner==*model))else{continue;};
                if !seen.insert(declaration.id){continue;}
                let derive=context.original().effects.derives.get(&declaration.id)?;
                let mut nested=chain.clone();nested.push(declaration.canonical.clone());
                scopes.push((derive.expr?,nested));
            }
        }
        cursor += 1;
        if scopes.len() > 256 { return None; }
    }
    Some(scopes)
}

pub(super) fn prepare_with_context(context: &FreshSourceContext<'_>) -> Option<PreparedAuthorityQuerySites> {
    let owner = context.ir().items.iter().find(|item| item.canonical == "rent_reservations.resource_report")?;
    let IrItemKind::Scenario { read: true, scope_authority: true, .. } = &owner.kind else { return None; };
    let fresh = context.fresh().items.get(owner.id.0 as usize)?;
    if fresh.canonical != owner.canonical || format!("{:?}", fresh.kind) != format!("{:?}", owner.kind) {
        return None;
    }
    let scenario = context.original().effects.scenarios.get(&owner.id)?;
    if !scenario.read || !scenario.scope_authority || scenario.on.is_some() || scenario.cohort.is_some() {
        return None;
    }
    let prepared=prepare_owner_with_context(context,owner)?;
    if prepared.plan["source"]["module"]!="rent_reservations"||prepared.firsts.len()!=2||!prepared.sites.values().any(|site|site.model=="employee.Employee"){return None;}
    Some(prepared)
}

/// Shared census of original source model reads, including the stored derived
/// fields that actually execute from this owner. This inventory grants no reads.
pub(super) fn prepare_owner_with_context(context:&FreshSourceContext<'_>,owner:&super::ir::IrItem)->Option<PreparedAuthorityQuerySites>{
    context.same_scenario(context.ir(),owner)?;
    let scenario=context.original().effects.scenarios.get(&owner.id)?;
    let scopes = relevant_scopes(context, scenario)?;
    // The source query fact alone does not seal the emitted predicate body.
    // Every transitive helper that can execute a marked read must still be
    // the fresh lowering of its immutable checked source.
    for canonical in scopes.iter().flat_map(|(_, chain)| chain).collect::<HashSet<_>>() {
        let helper = context.ir().items.iter().find(|item| &item.canonical == canonical)?;
        let fresh_helper = context.fresh().items.get(helper.id.0 as usize)?;
        if helper.canonical != fresh_helper.canonical
            || format!("{:?}", helper.kind) != format!("{:?}", fresh_helper.kind)
        {
            return None;
        }
    }
    let (origin, _) = source(context, scenario.node)?;
    let mut candidates = HashMap::<Span, AuthorityQuerySite>::new();
    for fact in context.original().types.checked_queries.values() {
        let Some((chain_scope, chain)) = scopes.iter().find(|(scope, _)| contains(*scope, fact.node)) else { continue; };
        let Some((model_id, model, parent_model, child_name)) = query_model(context, &fact.domain_type) else { continue; };
        let (query_source, _) = source(context, fact.node)?;
        let (_, domain_text) = source(context, fact.domain)?;
        // Array-valued locals retain their stored record element type but
        // lower as in-memory Value queries. Only an authored model domain
        // names the collection itself (`parent.Child` or a root model).
        let domain_text = domain_text.trim();
        let model_domain = if parent_model.is_some() {
            domain_text.ends_with(&format!(".{child_name}"))
        } else {
            domain_text == child_name || domain_text == model
        };
        if !model_domain { continue; }
        let parent = parent_model.as_ref().and_then(|_| parent_site(fact.domain, domain_text, &child_name));
        if parent_model.is_some() && parent.is_none() { return None; }
        let aliases = fact.clauses.iter().filter_map(|clause| match &clause.kind {
            CheckedQueryClauseKind::As { name } => Some((clause.node, name.as_str())), _ => None,
        }).collect::<Vec<_>>();
        if aliases.len() > 1 { return None; }
        let alias = aliases.first().map_or("row", |(_, name)| *name);
        let predicate = clause_one(fact, CheckedQueryClauseKind::Where)?;
        let order = checked_order(context, fact, alias)?;
        let first = first_call(context, fact.node, model_id)?;
        let key = span(fact.node);
        let id = sha256_hex(format!("authority-query/v1:{}:{}:{}:{}", query_source["sha256"].as_str()?, fact.node.start, fact.node.end, model).as_bytes());
        let wire_order = order.iter().map(|(field, descending)| json!({"field":field,"direction":if *descending {"desc"} else {"asc"}})).collect::<Vec<_>>();
        let wire = json!({"id":id,"source":query_source,"node":interval(fact.node),"model":model,
            "parentModel":parent_model,"parentSite":parent.map(span_interval),
            "predicateSite":predicate.map(interval),"predicateKind":if predicate.is_some() {"callback"} else {"none"},
            "order":wire_order,"archived":"exclude","firstSite":first.map(interval),"deriveChain":chain});
        let site = AuthorityQuerySite { id, node: fact.node, model, parent_site: parent,
            predicate_site: predicate.map(span), order, first_site:first.map(span), fact:Some(fact.clone()), wire };
        if candidates.insert(key, site).is_some() { return None; }
        let _ = chain_scope;
    }
    // An unadorned `resource.Child` expression still invokes records(). It
    // has no Query CST node, so bind the exact child-model member and its
    // checked array type separately rather than leaving an owner scan bare.
    for (node, ty) in &context.original().types.node_types {
        if node.kind != SyntaxKind::Member as u8 || scopes.iter().all(|(scope, _)| !contains(*scope, *node))
            || context.original().types.checked_queries.values().any(|query| query.domain == *node)
        { continue; }
        let Some((_, model, parent_model, child_name)) = query_model(context, ty) else { continue; };
        let Some(parent_model) = parent_model else { continue; };
        let (query_source, domain_text) = source(context, *node)?;
        if !domain_text.trim().ends_with(&format!(".{child_name}")) { continue; }
        let Some(parent) = parent_site(*node, domain_text, &child_name) else { return None; };
        let chain = scopes.iter().find(|(scope, _)| contains(*scope, *node))?.1.clone();
        let id = sha256_hex(format!("authority-query/v1:{}:{}:{}:{}", query_source["sha256"].as_str()?, node.start, node.end, model).as_bytes());
        let wire = json!({"id":id,"source":query_source,"node":interval(*node),"model":model,
            "parentModel":parent_model,"parentSite":span_interval(parent),
            "predicateSite":null,"predicateKind":"none","order":[],"archived":"exclude","firstSite":null,"deriveChain":chain});
        candidates.entry(span(*node)).or_insert(AuthorityQuerySite { id, node:*node, model,
            parent_site:Some(parent), predicate_site:None, order:Vec::new(), first_site:None,
            fact:None, wire });
    }
    let mut sites = candidates.into_iter().collect::<Vec<_>>();
    sites.sort_by_key(|(span, _)| (span.file.0, span.start, span.end));
    let mut firsts = HashMap::new();
    for (query_span, site) in &sites {
        if let Some(first) = site.first_site {
            if firsts.insert(first, *query_span).is_some() { return None; }
        }
    }
    let plan = json!({"version":1,"operation":owner.canonical,"source":origin,
        "sites":sites.iter().map(|(_,site)|site.wire.clone()).collect::<Vec<_>>()});
    Some(PreparedAuthorityQuerySites { plan, sites:sites.into_iter().collect(), firsts,
        reachable:scopes.into_iter().map(|(node, _)| node).collect() })
}

impl PreparedAuthorityQuerySites {
    pub(super) fn reaches(&self, span: Span) -> bool {
        self.reachable.iter().any(|scope| scope.file == span.file
            && scope.start <= span.start && span.end <= scope.end)
    }

    pub(super) fn matched_site(&self, span: Span, query: &IrQuery, model: &str) -> Option<&AuthorityQuerySite> {
        let site = self.sites.get(&span)?;
        if site.model != model || query.limit.is_some() || query.archived.is_some() || query.value_order.is_some()
            || query.parent.as_ref().map(|parent| parent.span) != site.parent_site
            || query.where_pred.as_ref().map(|predicate| predicate.span) != site.predicate_site
            || query.order.iter().map(|order| (order.field.clone(), order.descending)).collect::<Vec<_>>() != site.order
            || query.source.as_deref() != site.fact.as_ref()
            || !matches!(&query.domain, IrQueryDomain::Model(actual) if actual == model)
        { return None; }
        Some(site)
    }

    pub(super) fn matched_first(&self, span: Span, domain: &super::ir::TypedExpr) -> bool {
        let Some(query_span) = self.firsts.get(&span) else { return false; };
        let IrExpr::Query(query) = &domain.expr else { return false; };
        let IrQueryDomain::Model(model) = &query.domain else { return false; };
        self.matched_site(*query_span, query, model).is_some()
            && domain.span == *query_span
    }
}
