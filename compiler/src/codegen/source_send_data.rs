//! Original source-bound effect argument DATA. These proofs install no saved
//! result or general record reader; separate live SEND/EMIT frames own execution.
use super::ir::{
    IrBinOp, IrCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType, TypedExpr,
};
use crate::analysis::{ResolvedType, Scalar, SymbolId};
use crate::source::Span;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub(super) fn plain_value(ir: &IrProgram, ty: &ResolvedType, depth: usize) -> bool {
    if depth >= 16 {
        return false;
    }
    match ty {
        ResolvedType::Null => true,
        ResolvedType::Scalar(scalar) => !matches!(
            scalar,
            Scalar::File | Scalar::Secret | Scalar::Member | Scalar::Json | Scalar::Bytes
        ),
        ResolvedType::Enum { cases, .. } if !cases.is_empty() => true,
        ResolvedType::Nullable(inner) => plain_value(ir, inner, depth + 1),
        ResolvedType::Array {
            element,
            ordered: true,
            ..
        } => plain_value(ir, element, depth + 1),
        ResolvedType::Object(fields) => {
            fields.len() <= 200 && fields.iter().all(|(_, ty)| plain_value(ir, ty, depth + 1))
        }
        ResolvedType::Record { symbol, .. } => {
            ir.items.get(symbol.0 as usize).is_some_and(|item| {
                let IrItemKind::Contract { fields, .. } = &item.kind else {
                    return false;
                };
                !fields.is_empty()
                    && fields.len() <= 200
                    && fields.iter().all(|id| {
                        matches!(ir.items.get(id.0 as usize).map(|field|&field.kind),
                Some(IrItemKind::Field{ty:IrType::Known(ty),..})if plain_value(ir,ty,depth+1))
                    })
            })
        }
        _ => false,
    }
}
// SEND consumes data. A guard-only owner can carry its ordinary admitted
// Values inputs and pure locals, but cannot turn a stored field/control
// observation, File, reference or provider receipt into an egress value.
pub(super) fn send_value(
    ir: &IrProgram,
    value: &TypedExpr,
    values: &BTreeSet<String>,
    depth: usize,
) -> bool {
    if depth >= 32 {
        return false;
    }
    if let IrExpr::Member { base, field } = &value.expr
        && field == "id"
        && value.ty == ResolvedType::Scalar(Scalar::Text)
        && base.ty == ResolvedType::OperationContext
        && let IrExpr::Member {
            base: context,
            field: operation,
        } = &base.expr
        && operation == "operation"
        && context.ty == ResolvedType::Unknown
        && matches!(&context.expr,IrExpr::Name(name)if name=="c")
    {
        return true;
    }
    let child = |value: &TypedExpr| send_value(ir, value, values, depth + 1);
    // Effect argument objects retain their owning checked operation schema;
    // their aggregate IR carrier can be Unknown while every slot is typed.
    if let IrExpr::Object(fields) = &value.expr {
        return (matches!(value.ty, ResolvedType::Unknown | ResolvedType::Object(_))
            || plain_value(ir, &value.ty, 0))
            && fields.len() <= 200
            && fields.iter().all(|(_, value)| child(value));
    }
    // Message descriptors are sealed by the whole-owner semantic join.
    // Only their evaluated operands can consume DATA or invocation Values.
    match &value.expr {
        IrExpr::Message(message) => return message.params.iter().all(|param| child(&param.value)),
        IrExpr::MessageCall {
            descriptor,
            args,
            params,
        } => {
            return descriptor.params.is_empty()
                && args.iter().all(child)
                && params
                    .iter()
                    .filter_map(|param| param.default.as_ref())
                    .all(|value| send_value(ir, value, &BTreeSet::new(), depth + 1));
        }
        _ => {}
    }
    if !plain_value(ir, &value.ty, 0) {
        return false;
    }
    match &value.expr {
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => true,
        IrExpr::Name(name) => values.contains(name),
        IrExpr::Member { base, .. } => plain_value(ir, &base.ty, 0) && child(base),
        IrExpr::Call {
            target: IrCallTarget::Builtin { awaited: false, .. },
            args,
        }
        | IrExpr::BoundCall {
            target: IrCallTarget::Builtin { awaited: false, .. },
            args,
            ..
        } => args.iter().all(child),
        IrExpr::Binary { left, right, .. } => child(left) && child(right),
        IrExpr::Unary { operand, .. } => child(operand),
        IrExpr::Array(entries) => entries.iter().all(child),
        IrExpr::Format { args, .. } => args.iter().all(child),
        IrExpr::Object(fields) => fields.iter().all(|(_, value)| child(value)),
        _ => false,
    }
}
#[derive(Clone)]
struct Root {
    parameter: String,
    model: SymbolId,
    query: Option<String>,
}
#[derive(Clone, Default)]
struct Environment {
    values: BTreeSet<String>,
    roots: BTreeMap<String, Root>,
    arrays: BTreeMap<String, SymbolId>,
    /// Lexically visible let values for loop-invariance chasing: a bare
    /// alias used in a SEND resolves through this map to its defining
    /// expression plus LET-time roots. Only aliases whose value never
    /// mentions their own name are recorded, so self-shadowing degrades to
    /// the outer binding; rebinding a captured root drops dependents.
    aliases: HashMap<String, LetAlias>,
}
impl Environment {
    fn admitted(ir: &IrProgram, params: &[SymbolId]) -> Option<(Self, BTreeMap<String, SymbolId>)> {
        let mut env = Environment::default();
        let mut models = BTreeMap::new();
        for id in params {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                ty: IrType::Known(ty),
                ..
            } = &param.kind
            else {
                return None;
            };
            if let ResolvedType::Record {
                symbol,
                stored: true,
            } = ty
                && matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Model { .. }
                )
            {
                env.roots.insert(
                    param.name.clone(),
                    Root {
                        parameter: param.name.clone(),
                        model: *symbol,
                        query: None,
                    },
                );
                models.insert(param.name.clone(), *symbol);
            } else if let ResolvedType::Array {
                element,
                ordered: true,
                nonempty: false,
            } = ty
                && let ResolvedType::Record {
                    symbol,
                    stored: true,
                } = element.as_ref()
                && matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Model { .. }
                )
                && matches!(param.kind, IrItemKind::Param { default: None, .. })
            {
                env.arrays.insert(param.name.clone(), *symbol);
                models.insert(param.name.clone(), *symbol);
            } else if plain_value(ir, ty, 0) {
                env.values.insert(param.name.clone());
            }
        }
        Some((env, models))
    }
}
#[derive(Default)]
struct Reads {
    arrays: BTreeSet<String>,
    fields: BTreeMap<String, BTreeMap<String, String>>,
    value_fields: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
    identities: BTreeMap<String, BTreeSet<String>>,
    parents: BTreeMap<String, (SymbolId, BTreeMap<String, String>)>,
    identity_paths: BTreeMap<String, BTreeMap<Vec<(String, u32, bool)>, String>>,
    data_paths: BTreeMap<String, BTreeMap<(Vec<(String, u32, bool)>, String), String>>,
    query_fields: BTreeMap<String, BTreeMap<String, String>>,
    queries: BTreeMap<String, serde_json::Value>,
    query_spans: BTreeSet<(u32, u32, u32)>,
    steps: usize,
    stack: HashSet<SymbolId>,
    aggregates: bool,
    contract_derives: bool,
    derived: BTreeMap<String, BTreeMap<String, String>>,
}
pub(super) fn data_type(ir: &IrProgram, ty: &ResolvedType) -> Option<String> {
    match ty {
        ResolvedType::Scalar(scalar)
            if !matches!(
                scalar,
                Scalar::File
                    | Scalar::Secret
                    | Scalar::Member
                    | Scalar::Json
                    | Scalar::Bytes
                    | Scalar::Url
                    | Scalar::Locale
            ) =>
        {
            Some(scalar.as_str().into())
        }
        ResolvedType::Enum {
            owner: Some(id),
            cases,
        } if !cases.is_empty() => {
            let owner = ir.items.get(id.0 as usize)?;
            Some(
                if matches!(owner.kind,IrItemKind::Field{owner,..}if ir.items.get(owner.0 as usize).is_some_and(|item|matches!(item.kind,IrItemKind::Model{..})))
                {
                    format!("enum({})", cases.join(","))
                } else {
                    owner.canonical.clone()
                },
            )
        }
        ResolvedType::Enum { owner: None, cases } if !cases.is_empty() => {
            Some(format!("enum({})", cases.join(",")))
        }
        ResolvedType::Record { symbol, .. }
            if plain_value(ir, ty, 0)
                && matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Contract { .. }
                ) =>
        {
            Some(ir.items[symbol.0 as usize].canonical.clone())
        }
        ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } if plain_value(ir, ty, 0)
            && matches!(element.as_ref(),ResolvedType::Record{symbol,..} if matches!(ir.items.get(symbol.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..}))) =>
        {
            Some(format!("{}[]", data_type(ir, element)?))
        }
        ResolvedType::Nullable(inner) => Some(format!("{}?", data_type(ir, inner)?)),
        _ => None,
    }
}
fn declared_field<'a>(
    ir: &'a IrProgram,
    model: SymbolId,
    name: &str,
) -> Option<(&'a IrItem, &'a ResolvedType)> {
    let IrItemKind::Model { fields, .. } = &ir.items.get(model.0 as usize)?.kind else {
        return None;
    };
    let field = fields
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|item| item.name == name)?;
    let IrItemKind::Field {
        owner,
        ty: IrType::Known(ty),
        ..
    } = &field.kind
    else {
        return None;
    };
    (*owner == model).then_some((field, ty))
}
fn required_identity_path(
    ir: &IrProgram,
    value: &TypedExpr,
    env: &Environment,
    depth: usize,
) -> Option<(Root, Vec<(String, SymbolId, bool)>)> {
    if depth >= 8 {
        return None;
    }
    if let IrExpr::Name(name) = &value.expr {
        let root = env.roots.get(name)?.clone();
        return (root.query.is_none()
            && value.ty
                == ResolvedType::Record {
                    symbol: root.model,
                    stored: true,
                })
        .then_some((root, Vec::new()));
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let (root, mut path) = required_identity_path(ir, base, env, depth + 1)?;
    let owner = path
        .last()
        .map(|(_, model, _)| *model)
        .unwrap_or(root.model);
    let ResolvedType::Record {
        symbol: target,
        stored: true,
    } = &value.ty
    else {
        return None;
    };
    let mut narrowed = false;
    if field == "parent" {
        if !matches!(ir.items.get(owner.0 as usize)?.kind,IrItemKind::Model{owner:super::ir::IrOwner::ChildOf(parent),..}if parent==*target)
        {
            return None;
        }
    } else {
        let (_, declared) = declared_field(ir, owner, field)?;
        if declared != &value.ty {
            // The enclosing collector seals this exact typed occurrence against
            // freshly lowered original source, including its flow narrowing.
            if !matches!(declared,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty) {
                return None;
            }
            narrowed = true;
        }
    }
    path.push((field.clone(), *target, narrowed));
    Some((root, path))
}
fn field_descriptors(fields: &BTreeMap<String, String>) -> Vec<serde_json::Value> {
    fields
        .iter()
        .map(|(name, ty)| serde_json::json!({"name":name,"type":ty}))
        .collect()
}
fn path_descriptor(ir: &IrProgram, path: &[(String, u32, bool)]) -> Vec<serde_json::Value> {
    path.iter()
        .map(|(field, model, narrowed)| {
            let mut edge =
                serde_json::json!({"field":field,"model":ir.items[*model as usize].canonical});
            if *narrowed {
                edge["nullable"] = serde_json::json!(true);
            }
            edge
        })
        .collect()
}
/// Reuse the original required stored-reference path census for scalar loans.
pub(super) fn scalar_field_receiver(
    ir: &IrProgram,
    value: &TypedExpr,
    roots: &BTreeMap<String, SymbolId>,
) -> Option<(String, SymbolId, Vec<(String, SymbolId, bool)>)> {
    let env = Environment {
        values: BTreeSet::new(),
        arrays: BTreeMap::new(),
        aliases: HashMap::new(),
        roots: roots
            .iter()
            .map(|(name, model)| {
                (
                    name.clone(),
                    Root {
                        parameter: name.clone(),
                        model: *model,
                        query: None,
                    },
                )
            })
            .collect(),
    };
    let (root, path) = required_identity_path(ir, value, &env, 0)?;
    Some((root.parameter, root.model, path))
}
/// Only already-observed scalar leaves can make a compound LET a later pure
/// lexical value. This recognizes provenance; JavaScript evaluates it in place.
pub(super) fn observed_scalar_value(
    ir: &IrProgram,
    value: &TypedExpr,
    loans: &HashMap<Span, serde_json::Value>,
    values: &BTreeSet<String>,
) -> bool {
    fn scalar(ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(value) => !matches!(
                value,
                Scalar::File | Scalar::Secret | Scalar::Member | Scalar::Json | Scalar::Bytes
            ),
            ResolvedType::Enum { cases, .. } => !cases.is_empty(),
            ResolvedType::Nullable(inner) => scalar(inner),
            _ => false,
        }
    }
    fn walk(
        ir: &IrProgram,
        value: &TypedExpr,
        loans: &HashMap<Span, serde_json::Value>,
        values: &BTreeSet<String>,
        depth: usize,
    ) -> bool {
        if depth > 32 {
            return false;
        }
        if send_value(ir, value, values, 0) || loans.contains_key(&value.span) {
            return true;
        }
        let child = |value: &TypedExpr| walk(ir, value, loans, values, depth + 1);
        match &value.expr {
            IrExpr::Member { base, field } => {
                field == "now"
                    && value.ty == ResolvedType::Scalar(Scalar::Datetime)
                    && base.ty == ResolvedType::Unknown
                    && matches!(&base.expr,IrExpr::Name(name)if name=="c")
            }
            IrExpr::Binary { left, right, .. } => child(left) && child(right),
            IrExpr::Unary { operand, .. } => child(operand),
            IrExpr::Call {
                target: IrCallTarget::Builtin { awaited: false, .. },
                args,
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::Builtin { awaited: false, .. },
                args,
                ..
            } => args.iter().all(child),
            _ => false,
        }
    }
    scalar(&value.ty) && walk(ir, value, loans, values, 0)
}
impl Reads {
    fn parameter(
        &self,
        ir: &IrProgram,
        name: &str,
        model: SymbolId,
        fields: &BTreeMap<String, String>,
    ) -> serde_json::Value {
        let mut value = serde_json::json!({"name":name,"model":ir.items[model.0 as usize].canonical,
            "fields":field_descriptors(fields)});
        if let Some(fields) = self.value_fields.get(name) {
            value["valueFields"] = serde_json::json!(fields.values().collect::<Vec<_>>());
        }
        if let Some(identity) = self.identities.get(name) {
            value["identity"] = serde_json::json!(identity);
        }
        if self.arrays.contains(name) {
            value["array"] = serde_json::json!(true);
        }
        if let Some(paths) = self.identity_paths.get(name) {
            value["identityPaths"]=serde_json::json!(paths.iter().map(|(path,leaf)|serde_json::json!({"path":path_descriptor(ir,path),"leaf":leaf})).collect::<Vec<_>>());
        }
        if let Some(paths) = self.data_paths.get(name) {
            value["dataPaths"]=serde_json::json!(paths.iter().map(|((path,field),ty)|serde_json::json!({"path":path_descriptor(ir,path),"field":field,"type":ty})).collect::<Vec<_>>());
        }
        if let Some((model, fields)) = self.parents.get(name) {
            value["parent"] = serde_json::json!({"model":ir.items[model.0 as usize].canonical,"fields":field_descriptors(fields)});
        }
        if let Some(derived) = self.derived.get(name) {
            value["derived"] = serde_json::json!(field_descriptors(derived));
        }
        value
    }

    fn read(
        &mut self,
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        value: &TypedExpr,
        env: &Environment,
        depth: usize,
    ) -> Option<()> {
        self.steps += 1;
        if depth > 32 || self.steps > 4096 {
            return None;
        }
        if send_value(ir, value, &env.values, 0) {
            return Some(());
        }
        match &value.expr {
            IrExpr::Object(entries) if entries.len() <= 200 => {
                for (_, value) in entries {
                    self.read(ir, context, value, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::Name(name) if !env.values.contains(name) => {
                // A lexically visible let alias resolves to its defining
                // expression: the alias itself carries no stored read, and
                // pure values need no frame entry. The alias survived every
                // rebinding of its LET-time roots (rebinding drops
                // dependents), so the current bindings still mean what they
                // meant. Chasing terminates via the depth guard (fail-closed)
                // because only non-self-referential aliases are recorded.
                // Intervening SETs do not invalidate the chase: this frame
                // is a field-provenance census (paths, models, types), never
                // evaluated values, and field identities are unaffected by
                // row mutation — the same flow-insensitive trust singles
                // extend to every read. A rebinding, which would change
                // meaning, always fails closed above.
                let aliased = env.aliases.get(name)?.value.clone();
                self.read(ir, context, &aliased, env, depth + 1)
            }
            IrExpr::Member { .. } if is_operation_clock(value) => {
                // Operation-clock reads carry no stored row; they mirror the
                // scalar-observation walk exactly and contribute no frame
                // entry of their own.
                Some(())
            }
            IrExpr::Binary { left, right, .. }
                if matches!(
                    value.ty,
                    ResolvedType::Scalar(_) | ResolvedType::Enum { .. }
                ) =>
            {
                // Boolean (and scalar) combinations over genuine reads
                // observe their operands: both sides must resolve exactly as
                // a top-level read would. Anything else stays refused.
                self.read(ir, context, left, env, depth + 1)?;
                self.read(ir, context, right, env, depth + 1)
            }
            IrExpr::Unary { operand, .. }
                if matches!(
                    value.ty,
                    ResolvedType::Scalar(_) | ResolvedType::Enum { .. }
                ) =>
            {
                // A unary combination over a genuine read observes its
                // operand, exactly like the binary combinations above: `not`
                // and `-` preserve the read set they negate.
                self.read(ir, context, operand, env, depth + 1)
            }
            IrExpr::Array(entries) if entries.len() <= 200 => {
                for value in entries {
                    self.read(ir, context, value, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::Member { base, field } => {
                if let Some(nominal) =
                    crate::analysis::types::checked_standard_nominal_name(&base.ty)
                    && matches!(
                        nominal,
                        "TextRequest"
                            | "TextMessage"
                            | "WorkflowInput"
                            | "WorkflowDefinition"
                            | "ImageRequest"
                    )
                    && let ResolvedType::StdNominal { fields, .. } = &base.ty
                    && fields
                        .iter()
                        .any(|(name, ty)| name == field && ty == &value.ty)
                    && crate::analysis::scenario_disclosure::primitive_type(&value.ty)
                    && let Some(type_id) = data_type(ir, &value.ty)
                    && let IrExpr::Member {
                        base: receiver,
                        field: owning_field,
                    } = &base.expr
                    && let IrExpr::Name(parameter) = &receiver.expr
                    && let Some(root) = env.roots.get(parameter)
                    && root.query.is_none()
                    && receiver.ty
                        == (ResolvedType::Record {
                            symbol: root.model,
                            stored: true,
                        })
                    && declared_field(ir, root.model, owning_field)?.1 == &base.ty
                    && base.span.file == value.span.file
                {
                    super::source_loops::model_corresponds(context, root.model)?;
                    self.fields.entry(root.parameter.clone()).or_default();
                    let captured = self
                        .value_fields
                        .entry(root.parameter.clone())
                        .or_default()
                        .entry(owning_field.clone())
                        .or_insert_with(
                            || serde_json::json!({"name":owning_field,"type":nominal,"members":[]}),
                        );
                    if captured["type"] != nominal {
                        return None;
                    }
                    let members = captured["members"].as_array_mut()?;
                    let member = serde_json::json!({"name":field,"type":type_id,
                        "node":{"start":value.span.start,"end":value.span.end},
                        "receiver":{"start":base.span.start,"end":base.span.end}});
                    if !members.contains(&member) {
                        members.push(member);
                    }
                    return Some(());
                }
                if self.aggregates
                    && field == "now"
                    && base.ty == ResolvedType::Unknown
                    && matches!(&base.expr,IrExpr::Name(name)if name=="c")
                    && value.ty == ResolvedType::Scalar(Scalar::Datetime)
                {
                    return Some(());
                }
                if field == "id"
                    && value.ty == ResolvedType::Scalar(Scalar::Text)
                    && let Some((root, path)) = required_identity_path(ir, base, env, 0)
                    && !path.is_empty()
                {
                    self.fields.entry(root.parameter.clone()).or_default();
                    self.identity_paths
                        .entry(root.parameter)
                        .or_default()
                        .insert(
                            path.into_iter()
                                .map(|(field, model, narrowed)| (field, model.0, narrowed))
                                .collect(),
                            "id".into(),
                        );
                    return Some(());
                }
                if !matches!(field.as_str(), "id" | "version")
                    && let Some((root, path)) = required_identity_path(ir, base, env, 0)
                    && let Some((_, model, _)) = path.last()
                {
                    let (_, declared) = declared_field(ir, *model, field)?;
                    if declared != &value.ty
                        && !matches!(declared,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty)
                    {
                        return None;
                    }
                    let leaf = if let ResolvedType::Nullable(inner) = declared {
                        inner.as_ref()
                    } else {
                        declared
                    };
                    if matches!(leaf, ResolvedType::Scalar(_) | ResolvedType::Enum { .. }) {
                        let ty = data_type(ir, declared)?;
                        self.fields.entry(root.parameter.clone()).or_default();
                        self.data_paths.entry(root.parameter).or_default().insert(
                            (
                                path.into_iter()
                                    .map(|(field, model, narrowed)| (field, model.0, narrowed))
                                    .collect(),
                                field.clone(),
                            ),
                            ty,
                        );
                        return Some(());
                    }
                }
                let (root, parent) = if let IrExpr::Name(parameter) = &base.expr {
                    (env.roots.get(parameter)?.clone(), false)
                } else {
                    let IrExpr::Member {
                        base: child,
                        field: parent,
                    } = &base.expr
                    else {
                        return None;
                    };
                    let IrExpr::Name(parameter) = &child.expr else {
                        return None;
                    };
                    let original = env.roots.get(parameter)?;
                    let IrItemKind::Model {
                        owner: super::ir::IrOwner::ChildOf(model),
                        ..
                    } = &ir.items.get(original.model.0 as usize)?.kind
                    else {
                        return None;
                    };
                    if parent != "parent"
                        || original.query.is_some()
                        || child.ty
                            != (ResolvedType::Record {
                                symbol: original.model,
                                stored: true,
                            })
                    {
                        return None;
                    }
                    (
                        Root {
                            parameter: original.parameter.clone(),
                            model: *model,
                            query: None,
                        },
                        true,
                    )
                };
                if !matches!(base.ty,ResolvedType::Record{symbol,stored:true}if symbol==root.model)
                {
                    return None;
                }
                if !parent && root.query.is_none() && matches!(field.as_str(), "id" | "version") {
                    let expected = ResolvedType::Scalar(if field == "id" {
                        Scalar::Text
                    } else {
                        Scalar::Int
                    });
                    if value.ty != expected {
                        return None;
                    }
                    self.identities
                        .entry(root.parameter.clone())
                        .or_default()
                        .insert(field.clone());
                    self.fields.entry(root.parameter.clone()).or_default();
                    return Some(());
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
                let (_, ty) = declared_field(ir, root.model, field)?;
                if ty != &value.ty
                    && !matches!(ty,ResolvedType::Nullable(inner)if inner.as_ref()==&value.ty)
                {
                    return None;
                }
                let ty = data_type(ir, ty)?;
                if parent {
                    if !matches!(
                        &value.ty,
                        ResolvedType::Scalar(_)
                            | ResolvedType::Enum { .. }
                            | ResolvedType::Nullable(_)
                    ) {
                        return None;
                    }
                    self.fields.entry(root.parameter.clone()).or_default();
                    let stored = self
                        .parents
                        .entry(root.parameter.clone())
                        .or_insert_with(|| (root.model, BTreeMap::new()));
                    if stored.0 != root.model {
                        return None;
                    }
                    stored.1.insert(field.clone(), ty);
                } else if let Some(query) = &root.query {
                    self.query_fields
                        .entry(query.clone())
                        .or_default()
                        .insert(field.clone(), ty);
                } else {
                    self.fields
                        .entry(root.parameter.clone())
                        .or_default()
                        .insert(field.clone(), ty);
                }
                Some(())
            }
            IrExpr::Binary { op, left, right } if *op == IrBinOp::Coalesce => {
                self.read(ir, context, left, env, depth + 1)?;
                self.read(ir, context, right, env, depth + 1)
            }
            IrExpr::Binary {
                op: IrBinOp::Add,
                left,
                right,
            } if matches!(value.ty, ResolvedType::Array { .. }) => {
                self.read(ir, context, left, env, depth + 1)?;
                self.read(ir, context, right, env, depth + 1)
            }
            IrExpr::Binary { left, right, .. } if self.aggregates => {
                self.read(ir, context, left, env, depth + 1)?;
                self.read(ir, context, right, env, depth + 1)
            }
            IrExpr::Unary { operand, .. } if self.aggregates => {
                self.read(ir, context, operand, env, depth + 1)
            }
            IrExpr::Call {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
            } if self.aggregates && matches!(id.as_str(), "any" | "sum") => {
                self.aggregate(ir, context, id, args, None, env, depth)
            }
            IrExpr::BoundCall {
                target: IrCallTarget::Builtin { id, awaited: false },
                args,
                slots,
            } if self.aggregates && matches!(id.as_str(), "any" | "sum") => {
                self.aggregate(ir, context, id, args, Some(slots), env, depth)
            }
            IrExpr::Call {
                target: IrCallTarget::Builtin { awaited: false, .. },
                args,
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::Builtin { awaited: false, .. },
                args,
                ..
            } => {
                for arg in args {
                    self.read(ir, context, arg, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(name),
                args,
            } => self.helper(ir, context, name, args, None, env, depth),
            IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(name),
                args,
                slots,
            } => self.helper(ir, context, name, args, Some(slots), env, depth),
            IrExpr::Format { args, .. } => {
                for value in args {
                    self.read(ir, context, value, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::Message(message) => {
                for param in &message.params {
                    self.read(ir, context, &param.value, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::MessageCall {
                descriptor,
                args,
                params,
            } => {
                // Defaults execute in their defining message scope. Until a
                // default has its own formal-to-argument DATA join, only
                // closed pure values may enter here; caller root spellings
                // must never impersonate defining parameters.
                if !descriptor.params.is_empty()
                    || params
                        .iter()
                        .filter_map(|param| param.default.as_ref())
                        .any(|value| !send_value(ir, value, &BTreeSet::new(), depth + 1))
                {
                    return None;
                }
                for value in args {
                    self.read(ir, context, value, env, depth + 1)?;
                }
                Some(())
            }
            IrExpr::Query(query) => self.query(ir, context, query, value, env, depth),
            _ => None,
        }
    }
    // This census grants no aggregate value. The original generated Values
    // expression runs over independently projected complete child domains.
    fn aggregate(
        &mut self,
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        id: &str,
        args: &[TypedExpr],
        slots: Option<&Vec<Option<usize>>>,
        env: &Environment,
        depth: usize,
    ) -> Option<()> {
        if args.len() != 2 {
            return None;
        }
        let indexes = if let Some(slots) = slots {
            let [Some(a), Some(b)] = slots.as_slice() else {
                return None;
            };
            [*a, *b]
        } else {
            [0, 1]
        };
        if indexes[0] == indexes[1] {
            return None;
        }
        let collection = args.get(indexes[0])?;
        let operand = args.get(indexes[1])?;
        let IrExpr::Query(query) = &collection.expr else {
            return None;
        };
        let super::ir::IrQueryDomain::Model(name) = &query.domain else {
            return None;
        };
        let model = ir.items.iter().find(|item| item.canonical == *name)?;
        let IrItemKind::Model {
            owner: super::ir::IrOwner::ChildOf(parent_model),
            ..
        } = &model.kind
        else {
            return None;
        };
        let parent = query.parent.as_deref()?;
        let IrExpr::Name(parameter) = &parent.expr else {
            return None;
        };
        let root = env.roots.get(parameter)?;
        if root.query.is_some()
            || root.model != *parent_model
            || parent.ty
                != (ResolvedType::Record {
                    symbol: root.model,
                    stored: true,
                })
            || query.limit.is_some()
            || query.archived.is_some()
            || !query.order.is_empty()
            || query.value_order.is_some()
            || self.queries.len() >= 200
        {
            return None;
        }
        let key = (
            collection.span.file.0,
            collection.span.start,
            collection.span.end,
        );
        if !self.query_spans.insert(key) {
            return None;
        }
        let source = context.db().get(collection.span.file)?;
        let module = ir
            .modules
            .iter()
            .filter(|module| {
                module.file == collection.span.file
                    && module.span.start <= collection.span.start
                    && collection.span.end <= module.span.end
            })
            .min_by_key(|module| module.span.end - module.span.start)?;
        let query_id = crate::source::sha256_hex(
            format!(
                "source-emit-aggregate/v1:{}:{}:{}:{}",
                source.path, source.sha256, collection.span.start, collection.span.end
            )
            .as_bytes(),
        );
        self.query_fields.insert(query_id.clone(), BTreeMap::new());
        let mut local = env.clone();
        let row = Root {
            parameter: root.parameter.clone(),
            model: model.id,
            query: Some(query_id.clone()),
        };
        if let Some(predicate) = &query.where_pred {
            if predicate.ty != ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            local.values.remove(&query.where_param);
            local.roots.insert(query.where_param.clone(), row.clone());
            self.read(ir, context, predicate, &local, depth + 1)?;
        }
        if id == "sum" {
            let projection = query.select.as_deref()?;
            let alias = query.select_param.as_ref()?;
            if projection.ty != ResolvedType::Scalar(Scalar::Money)
                || operand.ty != ResolvedType::Scalar(Scalar::Currency)
            {
                return None;
            }
            local.values.remove(alias);
            local.roots.insert(alias.clone(), row);
            self.read(ir, context, projection, &local, depth + 1)?;
            self.read(ir, context, operand, env, depth + 1)?;
        } else {
            if query.select.is_some() || query.where_pred.is_some() {
                return None;
            }
            let IrExpr::Lambda { param, body } = &operand.expr else {
                return None;
            };
            if body.ty != ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            local.values.remove(param);
            local.roots.insert(param.clone(), row);
            self.read(ir, context, body, &local, depth + 1)?;
        }
        let fields = self.query_fields.get(&query_id)?;
        if fields.is_empty() || fields.len() > 200 {
            return None;
        }
        self.fields.entry(root.parameter.clone()).or_default();
        self.queries.insert(query_id.clone(),serde_json::json!({"id":query_id,"source":{"path":source.path,"sha256":source.sha256,"module":module.name},
            "node":{"file":collection.span.file.0,"start":collection.span.start,"end":collection.span.end},"parameter":root.parameter,
            "model":model.canonical,"parentModel":ir.items[root.model.0 as usize].canonical,
            "fields":field_descriptors(fields),"order":[]}));
        Some(())
    }
    fn helper(
        &mut self,
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        name: &str,
        args: &[TypedExpr],
        slots: Option<&Vec<Option<usize>>>,
        env: &Environment,
        depth: usize,
    ) -> Option<()> {
        let helper = ir.items.iter().find(|item| item.canonical == name)?;
        let IrItemKind::DeriveFn {
            params,
            expr: Some(body),
            ..
        } = &helper.kind
        else {
            return None;
        };
        if self.stack.len() >= 16 || !self.stack.insert(helper.id) || args.len() > params.len() {
            return None;
        }
        let mut callee = Environment::default();
        let mut used = BTreeSet::new();
        for (index, id) in params.iter().enumerate() {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                owner,
                ty: IrType::Known(ty),
                default,
                ..
            } = &param.kind
            else {
                return None;
            };
            if *owner != helper.id {
                return None;
            }
            let slot = slots
                .map(|slots| slots.get(index).copied().flatten())
                .unwrap_or(Some(index));
            let arg = if let Some(slot) = slot {
                if !used.insert(slot) {
                    return None;
                }
                args.get(slot)?
            } else {
                let Some(super::ir::IrDefault::Literal(value)) = default else {
                    return None;
                };
                value
            };
            if let ResolvedType::Record {
                symbol,
                stored: true,
            } = ty
                && matches!(
                    ir.items.get(symbol.0 as usize)?.kind,
                    IrItemKind::Model { .. }
                )
            {
                let IrExpr::Name(name) = &arg.expr else {
                    return None;
                };
                let root = env.roots.get(name)?;
                if root.model != *symbol || root.query.is_some() || arg.ty != *ty {
                    return None;
                }
                callee.roots.insert(param.name.clone(), root.clone());
            } else {
                if !plain_value(ir, ty, 0) {
                    return None;
                }
                self.read(ir, context, arg, env, depth + 1)?;
                callee.values.insert(param.name.clone());
            }
        }
        if used.len() != args.len() {
            return None;
        }
        self.read(ir, context, body, &callee, depth + 1)?;
        self.stack.remove(&helper.id);
        Some(())
    }
    fn query(
        &mut self,
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        query: &super::ir::IrQuery,
        value: &TypedExpr,
        env: &Environment,
        depth: usize,
    ) -> Option<()> {
        if let super::ir::IrQueryDomain::Value { base, .. } = &query.domain {
            if self.aggregates {
                return None;
            }
            let IrExpr::Name(name) = &base.expr else {
                return None;
            };
            let model = *env.arrays.get(name)?;
            let record = ResolvedType::Record {
                symbol: model,
                stored: true,
            };
            let array = |element| ResolvedType::Array {
                element: Box::new(element),
                ordered: true,
                nonempty: false,
            };
            let source = query.source.as_deref()?;
            super::scenario_decisions::checked_query(context.program(), query)?;
            let [alias, select] = source.clauses.as_slice() else {
                return None;
            };
            let crate::analysis::types::CheckedQueryClauseKind::As { name: alias } = &alias.kind
            else {
                return None;
            };
            let projection = query.select.as_deref()?;
            let IrExpr::Member {
                base: receiver,
                field,
            } = &projection.expr
            else {
                return None;
            };
            if base.ty != array(record.clone())
                || value.ty != array(ResolvedType::Scalar(Scalar::Text))
                || projection.ty != ResolvedType::Scalar(Scalar::Text)
                || receiver.ty != record
                || field != "id"
                || !matches!(&receiver.expr,IrExpr::Name(name)if name==alias)
                || query.select_param.as_ref() != Some(alias)
                || select.kind != crate::analysis::types::CheckedQueryClauseKind::Select
                || query.parent.is_some()
                || query.where_pred.is_some()
                || query.where_async
                || !query.order.is_empty()
                || query.value_order.is_some()
                || query.limit.is_some()
                || query.archived.is_some()
                || query.collection_call.is_some()
                || query.contract_collection_call.is_some()
            {
                return None;
            }
            self.arrays.insert(name.clone());
            self.fields.entry(name.clone()).or_default();
            self.identities
                .entry(name.clone())
                .or_default()
                .insert("id".into());
            return Some(());
        }
        let super::ir::IrQueryDomain::Model(name) = &query.domain else {
            return None;
        };
        let model = ir.items.iter().find(|item| item.canonical == *name)?;
        let IrItemKind::Model {
            owner: super::ir::IrOwner::ChildOf(parent_model),
            ..
        } = &model.kind
        else {
            return None;
        };
        let parent = query.parent.as_deref()?;
        let IrExpr::Name(parameter) = &parent.expr else {
            return None;
        };
        let root = env.roots.get(parameter)?;
        let ResolvedType::Array { element, .. } = &value.ty else {
            return None;
        };
        let ResolvedType::Record {
            symbol: contract,
            stored: false,
        } = element.as_ref()
        else {
            return None;
        };
        if root.query.is_some()
            || root.model != *parent_model
            || parent.ty
                != (ResolvedType::Record {
                    symbol: root.model,
                    stored: true,
                })
            || !matches!(
                ir.items.get(contract.0 as usize)?.kind,
                IrItemKind::Contract { .. }
            )
            || query.where_pred.is_some()
            || query.limit.is_some()
            || query.archived.is_some()
            || query.order.len() > 1
            || query.value_order.is_some()
            || self.queries.len() >= 200
        {
            return None;
        }
        let projection = query.select.as_deref()?;
        if projection.ty != **element || !matches!(projection.expr, IrExpr::Object(_)) {
            return None;
        }
        let alias = query.select_param.as_ref()?;
        let key = (value.span.file.0, value.span.start, value.span.end);
        if !self.query_spans.insert(key) {
            return None;
        }
        let source = context.db().get(value.span.file)?;
        let module = ir
            .modules
            .iter()
            .filter(|module| {
                module.file == value.span.file
                    && module.span.start <= value.span.start
                    && value.span.end <= module.span.end
            })
            .min_by_key(|module| module.span.end - module.span.start)?;
        let id = crate::source::sha256_hex(
            format!(
                "source-send-query/v1:{}:{}:{}:{}",
                source.path, source.sha256, value.span.start, value.span.end
            )
            .as_bytes(),
        );
        let mut local = env.clone();
        local.roots.insert(
            alias.clone(),
            Root {
                parameter: root.parameter.clone(),
                model: model.id,
                query: Some(id.clone()),
            },
        );
        local.values.remove(alias);
        self.query_fields.insert(id.clone(), BTreeMap::new());
        self.read(ir, context, projection, &local, depth + 1)?;
        let mut order = Vec::new();
        for term in &query.order {
            let (_, ty) = declared_field(ir, model.id, &term.field)?;
            let ty = data_type(ir, ty)?;
            self.query_fields
                .get_mut(&id)?
                .insert(term.field.clone(), ty);
            order.push(serde_json::json!({"field":term.field,"direction":if term.descending{"desc"}else{"asc"}}));
        }
        let fields = self.query_fields.get(&id)?;
        if fields.is_empty() || fields.len() > 200 {
            return None;
        }
        self.fields.entry(root.parameter.clone()).or_default();
        self.queries.insert(id.clone(),serde_json::json!({"id":id,"source":{"path":source.path,"sha256":source.sha256,"module":module.name},
            "node":{"file":value.span.file.0,"start":value.span.start,"end":value.span.end},
            "parameter":root.parameter,"model":model.canonical,"parentModel":ir.items[root.model.0 as usize].canonical,
            "fields":field_descriptors(fields),"order":order}));
        Some(())
    }
}

/// How a not-env-pure SEND arg leaf is proven for a partitioned native-loop
/// owner. Loop-variant leaves (loop items, lets derived from them) need the
/// aggregate proof below; loop-invariant leaves (admitted params, lets of
/// invariant expressions) are already proven by the successful `Reads`
/// analysis exactly as in single owners, whose emission consumes them
/// unchanged. Created-root and complex leaves fail the proof, matching
/// today's refusal; they never silently pass.
///
/// A lexically visible let binding captured for loop-invariance chasing:
/// the defining expression plus the root identities it resolved against at
/// LET time. Any rebinding of a captured root drops the alias (transitively
/// to a fixpoint), so a later use can never re-resolve through a stale
/// binding; the chase then fails closed instead of authorizing against
/// newly rebound state.
#[derive(Clone, Debug)]
struct LetAlias {
    value: TypedExpr,
    roots: Vec<(String, SymbolId)>,
}

/// Collect the root identities an alias value depends on, transitively
/// through same-scope aliases. Pure values contribute nothing; anything
/// unresolvable fails the recording so the alias never exists for chasing.
fn alias_roots(
    value: &TypedExpr,
    env: &Environment,
    models: &BTreeMap<String, SymbolId>,
    seen: &mut Vec<String>,
    out: &mut Vec<(String, SymbolId)>,
    depth: usize,
) -> bool {
    if depth > 32 {
        return false;
    }
    match &value.expr {
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => true,
        IrExpr::Name(name) if env.values.contains(name) => true,
        IrExpr::Name(name) if seen.iter().any(|seen| seen == name) => false,
        IrExpr::Name(name) => match env.aliases.get(name) {
            Some(aliased) => {
                seen.push(name.clone());
                let ok = alias_roots(&aliased.value, env, models, seen, out, depth + 1);
                seen.pop();
                ok
            }
            None => match models.get(name) {
                Some(model) => {
                    if !out.iter().any(|(known, _)| known == name) {
                        out.push((name.clone(), *model));
                    }
                    true
                }
                None => false,
            },
        },
        IrExpr::Member { base, .. } | IrExpr::DeliveryRead { record: base, .. } => {
            if is_operation_clock(value) {
                return true;
            }
            alias_roots(base, env, models, seen, out, depth + 1)
        }
        IrExpr::Object(fields) => fields
            .iter()
            .all(|(_, field)| alias_roots(field, env, models, seen, out, depth + 1)),
        IrExpr::Message(message) => message
            .params
            .iter()
            .all(|param| alias_roots(&param.value, env, models, seen, out, depth + 1)),
        IrExpr::MessageCall { args, params, .. } => {
            args.iter()
                .all(|arg| alias_roots(arg, env, models, seen, out, depth + 1))
                && params
                    .iter()
                    .filter_map(|param| param.default.as_ref())
                    .all(|default| alias_roots(default, env, models, seen, out, depth + 1))
        }
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } | IrExpr::Array(args) => args
            .iter()
            .all(|arg| alias_roots(arg, env, models, seen, out, depth + 1)),
        IrExpr::Binary { left, right, .. } => {
            alias_roots(left, env, models, seen, out, depth + 1)
                && alias_roots(right, env, models, seen, out, depth + 1)
        }
        IrExpr::Unary { operand, .. } => alias_roots(operand, env, models, seen, out, depth + 1),
        IrExpr::Format { args, .. } => args
            .iter()
            .all(|arg| alias_roots(arg, env, models, seen, out, depth + 1)),
        _ => false,
    }
}

/// The operation clock `c.now`: carries no stored row, so it contributes no
/// root identity and needs no frame entry. Mirrors the scalar-observation
/// walk and the `Reads` arm exactly.
fn is_operation_clock(value: &TypedExpr) -> bool {
    matches!(&value.expr, IrExpr::Member { base, field }
        if field == "now"
            && value.ty == ResolvedType::Scalar(Scalar::Datetime)
            && base.ty == ResolvedType::Unknown
            && matches!(&base.expr, IrExpr::Name(name) if name == "c"))
}

/// Drop `name` and every alias whose LET-time roots mention a dropped name,
/// to a fixpoint. Called at every rebinding site (let, loop item, create)
/// so stale captures can never be chased after their roots change meaning.
fn drop_dependent_aliases(env: &mut Environment, name: &str) {
    let mut dropped = vec![name.to_string()];
    env.aliases.remove(name);
    loop {
        let mut more = Vec::new();
        for (alias, captured) in &env.aliases {
            if captured
                .roots
                .iter()
                .any(|(root, _)| dropped.contains(root))
            {
                more.push(alias.clone());
            }
        }
        if more.is_empty() {
            break;
        }
        for alias in &more {
            env.aliases.remove(alias);
        }
        dropped.extend(more);
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LeafProof {
    Pure,
    Invariant,
    Variant,
    Created,
    Complex,
}

impl LeafProof {
    fn combine(self, other: LeafProof) -> LeafProof {
        use LeafProof::*;
        match (self, other) {
            (Complex, _) | (_, Complex) => Complex,
            (Created, _) | (_, Created) => Created,
            (Variant, _) | (_, Variant) => Variant,
            (Invariant, _) | (_, Invariant) => Invariant,
            (Pure, Pure) => Pure,
        }
    }
}

/// True when the expression mentions the name anywhere (cycle/shadow guard
/// for let-alias chasing; fail-safe: an alias whose value mentions its own
/// name is not recorded, so classification degrades to the outer binding).
fn expr_mentions_name(value: &TypedExpr, name: &str, depth: usize) -> bool {
    if depth >= 32 {
        return true;
    }
    let child = |value: &TypedExpr| expr_mentions_name(value, name, depth + 1);
    match &value.expr {
        IrExpr::Name(candidate) => candidate == name,
        IrExpr::Member { base, .. } => child(base),
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } | IrExpr::Array(args) => {
            args.iter().any(child)
        }
        IrExpr::Message(message) => message.params.iter().any(|param| child(&param.value)),
        IrExpr::MessageCall {
            descriptor,
            args,
            params,
        } => {
            args.iter().any(child)
                || params.iter().any(|param| {
                    param.default.as_ref().is_some_and(child)
                        || descriptor.params.iter().any(|_| false)
                })
        }
        IrExpr::Object(fields) => fields.iter().any(|(_, value)| child(value)),
        IrExpr::Binary { left, right, .. } => child(left) || child(right),
        IrExpr::Unary { operand, .. } => child(operand),
        IrExpr::Format { args, .. } => args.iter().any(child),
        IrExpr::DeliveryRead { record, .. } => child(record),
        _ => false,
    }
}

/// Outermost not-env-pure data leaves per arg field: the analysis records the
/// whole traversal at its outer span, so prefixes are not required separately
/// (a bare root Name alone is never an observed read). Anything beyond plain
/// data composition (non-builtin calls, queries, closures) fails closed
/// exactly as today: only previously-refused SENDs reach this proof.
fn unproven_leaves<'e>(
    value: &'e TypedExpr,
    values: &BTreeSet<String>,
    out: &mut Vec<&'e TypedExpr>,
) -> bool {
    match &value.expr {
        IrExpr::Object(fields) => {
            let mut ok = true;
            for (_, field) in fields {
                ok = unproven_leaves(field, values, out) && ok;
            }
            ok
        }
        IrExpr::Message(message) => {
            let mut ok = true;
            for param in &message.params {
                ok = unproven_leaves(&param.value, values, out) && ok;
            }
            ok
        }
        IrExpr::MessageCall {
            descriptor,
            args,
            params,
        } => {
            if !descriptor.params.is_empty() {
                return false;
            }
            let mut ok = true;
            for arg in args {
                ok = unproven_leaves(arg, values, out) && ok;
            }
            let empty = BTreeSet::new();
            for param in params {
                if let Some(default) = param.default.as_ref() {
                    ok = unproven_leaves(default, &empty, out) && ok;
                }
            }
            ok
        }
        IrExpr::Call {
            target: IrCallTarget::Builtin { awaited: false, .. },
            args,
        }
        | IrExpr::BoundCall {
            target: IrCallTarget::Builtin { awaited: false, .. },
            args,
            ..
        } => {
            let mut ok = true;
            for arg in args {
                ok = unproven_leaves(arg, values, out) && ok;
            }
            ok
        }
        IrExpr::Binary { left, right, .. } => {
            unproven_leaves(left, values, out) & unproven_leaves(right, values, out)
        }
        IrExpr::Unary { operand, .. } => unproven_leaves(operand, values, out),
        IrExpr::Array(entries) => {
            let mut ok = true;
            for entry in entries {
                ok = unproven_leaves(entry, values, out) && ok;
            }
            ok
        }
        IrExpr::Format { args, .. } => {
            let mut ok = true;
            for arg in args {
                ok = unproven_leaves(arg, values, out) && ok;
            }
            ok
        }
        IrExpr::Name(name) if values.contains(name) => true,
        IrExpr::Name(_) | IrExpr::Member { .. } | IrExpr::DeliveryRead { .. } => {
            out.push(value);
            true
        }
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => true,
        _ => false,
    }
}

/// Classify one unproven leaf: chase let aliases (cycle-guarded) to their
/// values and member chains to their root. Pure and invariant leaves need no
/// aggregate proof; variant (loop-rooted) leaves do; created and complex
/// leaves fail. A composite value is invariant only when every leaf is pure
/// or invariant; any variant/complex/created leaf dominates.
fn leaf_class(
    value: &TypedExpr,
    env: &Environment,
    loop_roots: &BTreeMap<String, String>,
    created_roots: &BTreeMap<String, serde_json::Value>,
    models: &BTreeMap<String, SymbolId>,
    seen: &mut Vec<String>,
    depth: usize,
) -> LeafProof {
    use LeafProof::*;
    if depth >= 32 {
        return Complex;
    }
    let child = |value: &TypedExpr, seen: &mut Vec<String>| {
        leaf_class(
            value,
            env,
            loop_roots,
            created_roots,
            models,
            seen,
            depth + 1,
        )
    };
    match &value.expr {
        IrExpr::Name(name) if env.values.contains(name) => Pure,
        IrExpr::Name(name) if seen.iter().any(|seen| seen == name) => Complex,
        IrExpr::Name(name) => match env.aliases.get(name) {
            // The alias survived every rebinding of its LET-time roots
            // (rebinding drops dependents), so chasing re-resolves through
            // the current bindings, which still mean what they meant.
            Some(aliased) => {
                seen.push(name.clone());
                let class = child(&aliased.value, seen);
                seen.pop();
                class
            }
            None => {
                if loop_roots.contains_key(name) {
                    Variant
                } else if created_roots.contains_key(name) {
                    Created
                } else if models.contains_key(name) || env.roots.contains_key(name) {
                    Invariant
                } else {
                    Complex
                }
            }
        },
        IrExpr::Member { base, .. } if is_operation_clock(value) => Pure,
        IrExpr::Member { base, .. } => child(base, seen),
        IrExpr::DeliveryRead { record, .. } => child(record, seen),
        IrExpr::Object(fields) => fields
            .iter()
            .map(|(_, field)| child(field, seen))
            .fold(Pure, LeafProof::combine),
        IrExpr::Message(message) => message
            .params
            .iter()
            .map(|param| child(&param.value, seen))
            .fold(Pure, LeafProof::combine),
        IrExpr::MessageCall { args, params, .. } => {
            let mut class = Pure;
            for arg in args {
                class = class.combine(child(arg, seen));
                if class == Complex {
                    break;
                }
            }
            for param in params {
                if let Some(default) = param.default.as_ref() {
                    class = class.combine(child(default, seen));
                    if class == Complex {
                        break;
                    }
                }
            }
            class
        }
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } | IrExpr::Array(args) => args
            .iter()
            .map(|arg| child(arg, seen))
            .fold(Pure, LeafProof::combine),
        IrExpr::Binary { left, right, .. } => child(left, seen).combine(child(right, seen)),
        IrExpr::Unary { operand, .. } => child(operand, seen),
        IrExpr::Format { args, .. } => args
            .iter()
            .map(|arg| child(arg, seen))
            .fold(Pure, LeafProof::combine),
        IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => Pure,
        _ => Complex,
    }
}

/// Exact original SEND observer for partitioned native-loop owners: every
/// loop-variant SEND arg read must be receipt-observed with a Data role at
/// its exact source span. Singles keep today's env-purity gate untouched, so
/// existing negative loop-root tests are preserved; a merely existing
/// aggregate never suffices without per-arg proof. Loop-item and
/// pre-mutation LET reads are covered exactly where the aggregate observes
/// the identical whole selection they execute on.
///
/// All variant reads must resolve to ONE original return: each read matches
/// its own exact (id, model, field) row with a DATA role inside that same
/// return. Per-read triple-plus-role in a single return (never a union
/// across unrelated returns) proves the SEND consumed exactly the observed
/// original data; a CONTROL-only read therefore cannot ride on another
/// read's DATA row. The covering return's full source (path, sha256,
/// module) plus exact file-bound span equality proves source ownership (the
/// SEND statement sits textually inside the loop it executes in), and only
/// capture-stage aggregate observations are consulted, never transported
/// copies. Loop-invariant leaves (admitted params, invariant lets) are
/// proven by the already successful `Reads` analysis and need no aggregate
/// row.
fn aggregate_observed_send_args(
    aggregate: &super::scenario_receipts::NativeScenarioReceipt,
    proof_spans: &[Span],
    module: &str,
    source: &serde_json::Value,
) -> bool {
    use super::scenario_receipts::{NativeDependency, ReceiptRole};
    let mut reads: Vec<&NativeDependency> = Vec::new();
    for span in proof_spans {
        let mut found = false;
        for (site, site_reads) in aggregate.dependencies.iter() {
            if site.span == *span && site.calls.is_empty() && !site.default_selection {
                reads.extend(site_reads.iter());
                found = true;
            }
        }
        if !found {
            return false;
        }
    }
    if reads.is_empty() {
        return false;
    }
    let source_path = source.get("path").and_then(serde_json::Value::as_str);
    let source_sha = source.get("sha256").and_then(serde_json::Value::as_str);
    aggregate.plan.returns.iter().any(|returned| {
        returned.source.module == module
            && source_path.is_some_and(|path| path == returned.source.path)
            && source_sha.is_some_and(|sha| sha == returned.source.sha256)
            && reads.iter().all(|read| {
                returned.dependencies.iter().any(|row| {
                    row.id == read.id
                        && row.model == read.model
                        && row.field == read.field
                        && row.role == ReceiptRole::Data
                })
            })
    })
}

pub(super) fn source_only_data_sends(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    let_data: &HashMap<Span, serde_json::Value>,
    module: &str,
    loops: Option<&serde_json::Value>,
    native_source: Option<&serde_json::Value>,
    aggregate: Option<&super::scenario_receipts::NativeScenarioReceipt>,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        hook: None,
        read: false,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let native_loops = native_source.is_some();
    let source = native_source.cloned().or_else(|| {
        requires
            .values()
            .find(|source| source["owner"] == owner.canonical)
            .map(|source| source["source"].clone())
    })?;
    context.same_scenario(ir, owner)?;
    let creates = super::source_created_rows::collect(ir, owner, context, &source)?;
    let (mut env, mut models) = Environment::admitted(ir, params)?;
    fn walk(
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        owner: &IrItem,
        body: &[IrStmt],
        env: &mut Environment,
        models: &mut BTreeMap<String, SymbolId>,
        created_roots: &mut BTreeMap<String, serde_json::Value>,
        creates: &[serde_json::Value],
        loop_roots: &BTreeMap<String, String>,
        loops: Option<&serde_json::Value>,
        let_data: &HashMap<Span, serde_json::Value>,
        source: &serde_json::Value,
        module: &str,
        output: &mut HashMap<Span, serde_json::Value>,
        native_loops: bool,
        aggregate: Option<&super::scenario_receipts::NativeScenarioReceipt>,
        missing: &mut bool,
    ) {
        for statement in body {
            match statement {
                IrStmt::Let { name, value, span } => {
                    let pure = send_value(ir, value, &env.values, 0)
                        || let_data.contains_key(span)
                        || observed_scalar_value(ir, value, let_data, &env.values);
                    env.values.remove(name);
                    env.roots.remove(name);
                    env.arrays.remove(name);
                    drop_dependent_aliases(env, name);
                    models.remove(name);
                    created_roots.remove(name);
                    if pure {
                        env.values.insert(name.clone());
                    }
                    if !expr_mentions_name(value, name, 0) {
                        let mut roots = Vec::new();
                        let mut seen = Vec::new();
                        if alias_roots(value, env, models, &mut seen, &mut roots, 0) {
                            env.aliases.insert(
                                name.clone(),
                                LetAlias {
                                    value: value.clone(),
                                    roots,
                                },
                            );
                        }
                    }
                }
                IrStmt::Create {
                    binding: Some(name),
                    model,
                    span,
                    ..
                } => {
                    env.values.remove(name);
                    env.roots.remove(name);
                    env.arrays.remove(name);
                    // A created row shadows every outer binding, exactly
                    // like a loop item: drop any stale outer let alias so
                    // the created binding wins classification. Dependents of
                    // the shadowed name drop too.
                    drop_dependent_aliases(env, name);
                    models.remove(name);
                    created_roots.remove(name);
                    if let Some(profile) = creates.iter().find(|profile| {
                        profile["node"]["start"] == span.start && profile["node"]["end"] == span.end
                    }) && let Some(target) =
                        ir.items.iter().find(|item| item.canonical == *model)
                    {
                        env.roots.insert(
                            name.clone(),
                            Root {
                                parameter: name.clone(),
                                model: target.id,
                                query: None,
                            },
                        );
                        models.insert(name.clone(), target.id);
                        created_roots.insert(name.clone(), profile.clone());
                    }
                }
                IrStmt::Send {
                    operation,
                    deployment_binding: Some(binding),
                    args,
                    when: None,
                    span,
                    ..
                } => {
                    if native_loops && loop_roots.is_empty() {
                        continue;
                    }
                    let mut reads = Reads {
                        contract_derives: true,
                        ..Reads::default()
                    };
                    // Hard analysis/budget failures refuse before any receipt
                    // fallback and never emit partial output: an unreadable
                    // SEND or an over-bound read set cannot be rescued by the
                    // aggregate. Singles keep today's silent skip; native
                    // loop owners refuse exactly as an unproved SEND would.
                    let read_ok = reads.read(ir, context, args, env, 0).is_some();
                    if !read_ok || reads.fields.len() > 200 {
                        if native_loops {
                            *missing = true;
                        }
                        continue;
                    }
                    if reads.data_paths.keys().any(|name| {
                        loop_roots.contains_key(name) || created_roots.contains_key(name)
                    }) || reads.identity_paths.keys().any(|name| {
                        loop_roots.contains_key(name) || created_roots.contains_key(name)
                    }) || reads.identities.keys().any(|name| {
                        loop_roots.contains_key(name) || created_roots.contains_key(name)
                    }) || reads.queries.values().any(|query| {
                        query["parameter"].as_str().is_some_and(|name| {
                            loop_roots.contains_key(name) || created_roots.contains_key(name)
                        })
                    }) {
                        // Partitioned native-loop owners prove loop-variant arg
                        // leaves through their private whole-owner aggregate
                        // instead of env purity; loop-invariant leaves
                        // (admitted params, invariant lets) are already proven
                        // by the successful Reads analysis above, exactly as
                        // consumed by single-owner emission. Created and
                        // complex leaves fail the proof, matching today's
                        // refusal. Singles keep today's gate, so existing
                        // negative loop-root tests are preserved.
                        if native_loops && !send_value(ir, args, &env.values, 0) {
                            let mut leaves = Vec::new();
                            let mut proof_spans = Vec::new();
                            let mut proven = unproven_leaves(args, &env.values, &mut leaves);
                            if proven {
                                let mut seen = Vec::new();
                                for leaf in &leaves {
                                    let class = leaf_class(
                                        leaf,
                                        env,
                                        loop_roots,
                                        created_roots,
                                        models,
                                        &mut seen,
                                        0,
                                    );
                                    match class {
                                        LeafProof::Pure | LeafProof::Invariant => {}
                                        LeafProof::Variant => proof_spans.push(leaf.span),
                                        LeafProof::Created | LeafProof::Complex => {
                                            proven = false;
                                            break;
                                        }
                                    }
                                }
                            }
                            // A loop-parameterized query with no variant arg
                            // leaf to prove fails exactly as today (the arg
                            // proof previously covered those spans and found
                            // no aggregate row).
                            if proven
                                && proof_spans.is_empty()
                                && reads.queries.values().any(|query| {
                                    query["parameter"].as_str().is_some_and(|name| {
                                        loop_roots.contains_key(name)
                                            || created_roots.contains_key(name)
                                    })
                                })
                            {
                                proven = false;
                            }
                            // No variant leaf means nothing per-row to prove:
                            // the Reads analysis already covers every leaf.
                            let receipt_observed = proven
                                && (proof_spans.is_empty()
                                    || match aggregate {
                                        Some(native) => aggregate_observed_send_args(
                                            native,
                                            &proof_spans,
                                            module,
                                            source,
                                        ),
                                        None => false,
                                    });
                            if !receipt_observed {
                                *missing = true;
                                continue;
                            }
                            // Receipt-observed: emit the exact descriptor
                            // below (loop markers intact) instead of skipping.
                        } else {
                            continue;
                        }
                    }
                    if reads.fields.is_empty() {
                        continue;
                    }
                    let mut parameters = Vec::new();
                    for (name, fields) in &reads.fields {
                        let Some(model) = models.get(name) else {
                            continue;
                        };
                        let mut value = reads.parameter(ir, name, *model, fields);
                        if let Some(fields) = value
                            .get_mut("valueFields")
                            .and_then(serde_json::Value::as_array_mut)
                        {
                            for field in fields {
                                field["id"] = serde_json::json!(crate::source::sha256_hex(
                                    format!(
                                        "source-data-value/v1:{}:{}:{}:{}:{}:{}:{}",
                                        source["path"],
                                        source["sha256"],
                                        owner.canonical,
                                        span.start,
                                        span.end,
                                        name,
                                        field["name"]
                                    )
                                    .as_bytes()
                                ));
                            }
                        }
                        if let Some(id) = loop_roots.get(name) {
                            value["loop"] = serde_json::json!(id);
                        }
                        if let Some(created) = created_roots.get(name) {
                            value["created"] = created.clone();
                        }
                        parameters.push(value);
                    }
                    let mut value = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"operation":operation,"binding":binding,"parameters":parameters});
                    if !reads.queries.is_empty() {
                        value["queries"] =
                            serde_json::json!(reads.queries.values().collect::<Vec<_>>());
                    }
                    output.insert(*span, value);
                }
                IrStmt::For {
                    item,
                    domain,
                    body,
                    span,
                    ..
                } => {
                    let Some(entry) = loops
                        .and_then(|source| source["loops"].as_array())
                        .and_then(|entries| {
                            entries.iter().find(|entry| {
                                entry["node"]["start"] == span.start
                                    && entry["node"]["end"] == span.end
                            })
                        })
                    else {
                        continue;
                    };
                    let ResolvedType::Array { element, .. } = &domain.ty else {
                        continue;
                    };
                    let ResolvedType::Record {
                        symbol,
                        stored: true,
                    } = element.as_ref()
                    else {
                        continue;
                    };
                    let mut nested = env.clone();
                    nested.values.remove(item);
                    nested.arrays.remove(item);
                    // The loop item shadows every outer binding: a stale
                    // outer let alias with the same name must not classify
                    // per-iteration reads as invariant (aliases are consulted
                    // before loop roots, so only the current lexical binding
                    // may win). Dependents of the shadowed name drop too.
                    drop_dependent_aliases(&mut nested, item);
                    nested.roots.insert(
                        item.clone(),
                        Root {
                            parameter: item.clone(),
                            model: *symbol,
                            query: None,
                        },
                    );
                    let mut models = models.clone();
                    models.insert(item.clone(), *symbol);
                    let mut roots = loop_roots.clone();
                    roots.insert(item.clone(), entry["id"].as_str().unwrap().to_owned());
                    let mut created = created_roots.clone();
                    created.remove(item);
                    walk(
                        ir,
                        context,
                        owner,
                        body,
                        &mut nested,
                        &mut models,
                        &mut created,
                        creates,
                        &roots,
                        loops,
                        let_data,
                        source,
                        module,
                        output,
                        native_loops,
                        aggregate,
                        missing,
                    );
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    walk(
                        ir,
                        context,
                        owner,
                        then_branch,
                        &mut env.clone(),
                        &mut models.clone(),
                        &mut created_roots.clone(),
                        creates,
                        loop_roots,
                        loops,
                        let_data,
                        source,
                        module,
                        output,
                        native_loops,
                        aggregate,
                        missing,
                    );
                    walk(
                        ir,
                        context,
                        owner,
                        else_branch,
                        &mut env.clone(),
                        &mut models.clone(),
                        &mut created_roots.clone(),
                        creates,
                        loop_roots,
                        loops,
                        let_data,
                        source,
                        module,
                        output,
                        native_loops,
                        aggregate,
                        missing,
                    );
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        walk(
                            ir,
                            context,
                            owner,
                            &arm.body,
                            &mut env.clone(),
                            &mut models.clone(),
                            &mut created_roots.clone(),
                            creates,
                            loop_roots,
                            loops,
                            let_data,
                            source,
                            module,
                            output,
                            native_loops,
                            aggregate,
                            missing,
                        );
                    }
                }
                _ => {}
            }
        }
    }
    let mut output = HashMap::new();
    let mut missing = false;
    walk(
        ir,
        context,
        owner,
        effects,
        &mut env,
        &mut models,
        &mut BTreeMap::new(),
        &creates,
        &BTreeMap::new(),
        loops,
        let_data,
        &source,
        module,
        &mut output,
        native_loops,
        aggregate,
        &mut missing,
    );
    (!missing).then_some(output)
}

pub(super) fn source_only_data_emits(
    ir: &IrProgram,
    owner: &IrItem,
    context: &super::source_context::FreshSourceContext<'_>,
    requires: &HashMap<Span, serde_json::Value>,
    module: &str,
) -> Option<HashMap<Span, serde_json::Value>> {
    let IrItemKind::Scenario {
        params,
        effects,
        hook: None,
        read: false,
        trusted: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let source = requires
        .values()
        .find(|source| source["owner"] == owner.canonical)?["source"]
        .clone();
    fn has_emit(body: &[IrStmt]) -> bool {
        body.iter().any(|statement| match statement {
            IrStmt::Emit { .. } => true,
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => has_emit(then_branch) || has_emit(else_branch),
            IrStmt::Match { arms, .. } => arms.iter().any(|arm| has_emit(&arm.body)),
            _ => false,
        })
    }
    if !has_emit(effects) {
        return Some(HashMap::new());
    }
    context.same_scenario(ir, owner)?;
    let creates = super::source_created_rows::collect(ir, owner, context, &source)?;
    let (mut env, models) = Environment::admitted(ir, params)?;
    fn walk(
        ir: &IrProgram,
        context: &super::source_context::FreshSourceContext<'_>,
        owner: &IrItem,
        body: &[IrStmt],
        env: &mut Environment,
        models: &BTreeMap<String, SymbolId>,
        created: &mut BTreeMap<String, serde_json::Value>,
        creates: &[serde_json::Value],
        source: &serde_json::Value,
        module: &str,
        output: &mut HashMap<Span, serde_json::Value>,
    ) {
        for statement in body {
            match statement {
                IrStmt::Let { name, value, .. } => {
                    let pure = send_value(ir, value, &env.values, 0);
                    env.values.remove(name);
                    env.roots.remove(name);
                    created.remove(name);
                    if pure {
                        env.values.insert(name.clone());
                    }
                }
                IrStmt::Create {
                    binding: Some(name),
                    span,
                    ..
                } => {
                    created.remove(name);
                    env.values.remove(name);
                    env.roots.remove(name);
                    if let Some(profile) = creates.iter().find(|profile| {
                        profile["node"]["start"] == span.start && profile["node"]["end"] == span.end
                    }) {
                        created.insert(name.clone(), profile.clone());
                    }
                }
                IrStmt::Emit {
                    event,
                    payload: args,
                    span,
                } => {
                    if context.same_event_schema(event).is_none() {
                        continue;
                    }
                    let Some(declaration) = ir
                        .items
                        .iter()
                        .find(|item| item.canonical == *event && item.module == owner.module)
                    else {
                        continue;
                    };
                    let IrItemKind::Event { fields } = &declaration.kind else {
                        continue;
                    };
                    let IrExpr::Object(entries) = &args.expr else {
                        continue;
                    };
                    if fields.len()!=entries.len()||!entries.iter().all(|(name,value)|fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|field|field.name==*name&&matches!(&field.kind,
                    IrItemKind::Field{ty:IrType::Known(ty),..}if ty==&value.ty||matches!(ty,ResolvedType::Nullable(inner) if inner.as_ref()==&value.ty)
                        ||matches!(ty,ResolvedType::Nullable(_))&&value.ty==ResolvedType::Null&&matches!(value.expr,IrExpr::Null)||matches!((ty,&value.ty),
                        (ResolvedType::Record{symbol:a,..},ResolvedType::Record{symbol:b,stored:false})if a==b&&matches!(ir.items.get(a.0 as usize).map(|item|&item.kind),Some(IrItemKind::Contract{..})))))){continue;}
                    let mut reads = Reads {
                        aggregates: true,
                        ..Reads::default()
                    };
                    let mut references = Vec::new();
                    let mut valid = true;
                    for (field, value) in entries {
                        if let (
                            IrExpr::Name(name),
                            ResolvedType::Record {
                                symbol,
                                stored: true,
                            },
                        ) = (&value.expr, &value.ty)
                            && let Some(root) = env.roots.get(name)
                            && root.model == *symbol
                            && root.query.is_none()
                            && matches!(ir.items[symbol.0 as usize].kind, IrItemKind::Model { .. })
                        {
                            references.push(serde_json::json!({"field":field,"parameter":root.parameter,"model":ir.items[symbol.0 as usize].canonical}));
                        } else if let (
                            IrExpr::Name(name),
                            ResolvedType::Record {
                                symbol,
                                stored: true,
                            },
                        ) = (&value.expr, &value.ty)
                            && let Some(profile) = created.get(name)
                            && profile["model"] == ir.items[symbol.0 as usize].canonical
                        {
                            references.push(serde_json::json!({"field":field,"parameter":name,"model":profile["model"],"created":profile}));
                        } else if let Some((root, path)) = required_identity_path(ir, value, env, 0)
                            && !path.is_empty()
                        {
                            let target = path.last().expect("nonempty original path").1;
                            let path = path
                                .into_iter()
                                .map(|(field, model, narrowed)| (field, model.0, narrowed))
                                .collect::<Vec<_>>();
                            let wire = path_descriptor(ir, &path);
                            reads.fields.entry(root.parameter.clone()).or_default();
                            reads
                                .identity_paths
                                .entry(root.parameter.clone())
                                .or_default()
                                .insert(path, "id".into());
                            references.push(serde_json::json!({"field":field,"parameter":root.parameter,"model":ir.items[target.0 as usize].canonical,"path":wire}));
                        } else if reads.read(ir, context, value, env, 0).is_none() {
                            valid = false;
                            break;
                        }
                    }
                    if !valid || reads.fields.is_empty() || reads.fields.len() > 200 {
                        continue;
                    }
                    let mut parameters = Vec::new();
                    for (name, fields) in &reads.fields {
                        let Some(model) = models.get(name) else {
                            continue;
                        };
                        let value = reads.parameter(ir, name, *model, fields);
                        parameters.push(value);
                    }
                    let mut value = serde_json::json!({"source":{"module":module,"path":source["path"],"sha256":source["sha256"]},
                    "owner":owner.canonical,"node":{"start":span.start,"end":span.end},"event":event,"parameters":parameters});
                    if !references.is_empty() {
                        value["references"] = serde_json::json!(references);
                    }
                    if !reads.queries.is_empty() {
                        value["queries"] =
                            serde_json::json!(reads.queries.values().collect::<Vec<_>>());
                    }
                    output.insert(*span, value);
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    walk(
                        ir,
                        context,
                        owner,
                        then_branch,
                        &mut env.clone(),
                        models,
                        &mut created.clone(),
                        creates,
                        source,
                        module,
                        output,
                    );
                    walk(
                        ir,
                        context,
                        owner,
                        else_branch,
                        &mut env.clone(),
                        models,
                        &mut created.clone(),
                        creates,
                        source,
                        module,
                        output,
                    );
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        walk(
                            ir,
                            context,
                            owner,
                            &arm.body,
                            &mut env.clone(),
                            models,
                            &mut created.clone(),
                            creates,
                            source,
                            module,
                            output,
                        );
                    }
                }
                _ => {}
            }
        }
    }
    let mut output = HashMap::new();
    walk(
        ir,
        context,
        owner,
        effects,
        &mut env,
        &models,
        &mut BTreeMap::new(),
        &creates,
        &source,
        module,
        &mut output,
    );
    Some(output)
}
