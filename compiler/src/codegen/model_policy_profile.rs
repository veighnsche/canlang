//! Conservative stored-field dependencies for the first native local-rule scope.
use super::ir::IrCallTarget;
use super::ir::{
    IrBinOp, IrExpr, IrItemKind, IrModelRuleKind, IrModelRuleOrigin, IrOwner, IrProgram, IrQuery,
    IrQueryDomain, IrRuleFn, IrStmt, IrType, IrUnOp, TypedExpr,
};
use crate::analysis::{NodeKey, types::SelectedCallTarget};
use crate::analysis::{
    resolve::{CrudOp, ModuleId, SymbolId},
    types::{ResolvedType, Scalar},
};
use std::collections::{HashMap, HashSet};

/// A separate, bounded native candidate/staging profile. Classification neither
/// supplies a runtime context nor authorizes owner activation.
pub fn local_hook_supported(program: &IrProgram, scenario: SymbolId) -> bool {
    let Some(item) = program
        .items
        .get(scenario.0 as usize)
        .filter(|item| item.id == scenario)
    else {
        return false;
    };
    let IrItemKind::Scenario {
        hook: Some(hook),
        params,
        cohort,
        by,
        guards,
        effects,
        ..
    } = &item.kind
    else {
        return false;
    };
    if !matches!(hook.op, CrudOp::Create | CrudOp::Update)
        || !params.is_empty()
        || cohort.is_some()
        || !by.is_empty()
    {
        return false;
    }
    let mut profile = HookProfile {
        program,
        model: hook.model,
        op: hook.op,
        module: item.module,
        remaining: 4096,
        hook_body_derives: Vec::new(),
        staged_data: HashMap::new(),
    };
    if !profile.model_supported(hook.model) {
        return false;
    }
    let mut locals = HashMap::new();
    let mut aliases: HashMap<String, (SymbolId, EventAlias)> = HashMap::new();
    profile.statements(guards, &mut locals, &mut aliases, 0).is_some()
        && profile
            .statements(effects, &mut locals, &mut aliases, 0)
            .is_some()
}

struct HookProfile<'a> {
    program: &'a IrProgram,
    model: SymbolId,
    op: CrudOp,
    module: ModuleId,
    remaining: usize,
    /// Checked derive canonicals on the current record-helper body stack.
    /// A linkage-carrying helper whose body reaches itself (directly or
    /// through another linkage helper) refuses instead of recursing.
    hook_body_derives: Vec<String>,
    /// Explicitly supplied staged-create data fields by source alias.
    /// Mirrors the native emitter's staged local binding: reads of
    /// exactly these fields observe what the hook staged. Entries are
    /// scoped like aliases (branches and loop bodies discard theirs)
    /// and a staged update to the alias drops its entry.
    staged_data: HashMap<String, HashSet<String>>,
}

/// Row-binding class for hook locals. A snapshot alias
/// (`let r = event.after`) carries the full trigger row, so its leaf and
/// carried-reference fields read like the snapshot itself. A parent alias
/// (`let l = event.after.parent`) carries the engine's parent linkage
/// identity (`{model, id}`) for bare uses (containment linkage, query
/// parents, carried payload values, `.id`); declared leaf/carried fields
/// read through it via the transitive parent load, while row-valued
/// derives through the bare linkage still refuse. A staged
/// binding (`create … as s`) carries the bound `{id}` identity for the
/// same bare/`.id` uses; content reads through it still refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventAlias {
    Snapshot,
    ParentIdentity,
    /// CAN18-v1 direct snapshot stored-reference edge (file 14
    /// `Account.location` first shape): engine linkage identity
    /// (`{model, id}`) for the referenced row, with declared leaf reads
    /// through it via the transitive reference load. Distinct from
    /// `ParentIdentity` so the ancestor fence never serves references.
    ReferenceIdentity,
    Staged,
}

impl HookProfile<'_> {
    fn step(&mut self, depth: usize) -> Option<()> {
        if depth > 64 || self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        Some(())
    }

    fn leaf(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool | Scalar::User | Scalar::Datetime | Scalar::Date | Scalar::Duration | Scalar::Email | Scalar::Timezone) => true,
            ResolvedType::Nullable(inner) => self.leaf(inner),
            ResolvedType::Enum { cases, owner: Some(owner) } => {
                !cases.is_empty() && self.program.items.get(owner.0 as usize).is_some_and(|item| {
                    item.id == *owner && item.module == self.module
                        && matches!(&item.kind, IrItemKind::Field { ty: IrType::Known(field_ty), .. } if field_ty == ty)
                })
            }
            _ => false,
        }
    }

    /// Reference-shaped carried values: stored-record references (single,
    /// nullable, or array) resolve to engine linkage identities at hook
    /// runtime. They carry through payloads, query parents and linkage, and
    /// compare by identity/structure — never through dereferenced fields.
    fn carried_ref(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Record { symbol, stored } => {
                *stored
                    && self
                        .program
                        .items
                        .get(symbol.0 as usize)
                        .is_some_and(|item| item.id == *symbol)
            }
            ResolvedType::Nullable(inner) => self.carried_ref(inner),
            ResolvedType::Array { element, .. } => self.carried_ref(element),
            _ => false,
        }
    }

    fn model_supported(&self, model: SymbolId) -> bool {
        self.program.items.get(model.0 as usize).is_some_and(|item| {
            item.id == model && item.module == self.module
                && matches!(&item.kind, IrItemKind::Model { fields, .. } if fields.iter().all(|id| {
                    self.program.items.get(id.0 as usize).is_some_and(|field| {
                        // Derived fields are computed, never cloned into the
                        // hook candidate snapshot, so they cannot veto the
                        // stored trigger row. A hook body that reads a derive
                        // still refuses in `field`, which only binds stored
                        // `Field` declarations.
                        if let IrItemKind::DeriveField { model: owner, .. } = &field.kind {
                            return field.id == *id
                                && *owner == model
                                && field.module == self.module;
                        }
                        field.id == *id && field.module == self.module
                            && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. } if *owner == model && self.supported_field_type(ty))
                    })
                }))
        })
    }

    /// Hook candidate field coverage: plain leaves plus file handles,
    /// stored-record references and contract values. The hook engine
    /// clones the candidate as plain data; these shapes carry as values
    /// and are never dereferenced by the profile. Other nominals stay out.
    fn supported_field_type(&self, ty: &ResolvedType) -> bool {
        if self.leaf(ty) {
            return true;
        }
        match ty {
            // Candidate cloning carries already checked scalar wire values.
            // This does not admit their arithmetic, comparison or member reads.
            ResolvedType::Scalar(Scalar::File | Scalar::Currency | Scalar::Decimal | Scalar::Money) => true,
            // Candidate snapshots carry the original opaque delivery identity.
            // This admits no envelope/result observation or non-null assignment;
            // declared nullable fields may still be cleared by the literal-null
            // path below, under the normal field and State mutation checks.
            ResolvedType::StdDelivery { capability, op } =>
                crate::analysis::catalog::std_operation(capability, op.name) == Some(*op),
            ResolvedType::Nullable(inner) => self.supported_field_type(inner),
            ResolvedType::Array { element, .. } => self.supported_field_type(element),
            ResolvedType::Record { symbol, stored: false } => self
                .program
                .items
                .get(symbol.0 as usize)
                .is_some_and(|item| {
                    item.id == *symbol && matches!(&item.kind, IrItemKind::Contract { .. })
                }),
            _ => self.carried_ref(ty),
        }
    }

    fn field(&self, model: SymbolId, name: &str, writable: bool) -> Option<&ResolvedType> {
        if matches!(
            name,
            "id" | "version"
                | "parent"
                | "created"
                | "updated"
                | "createdBy"
                | "updatedBy"
                | "archivedAt"
        ) {
            return None;
        }
        let IrItemKind::Model { fields, .. } = &self.program.items.get(model.0 as usize)?.kind
        else {
            return None;
        };
        let mut matches = fields.iter().filter_map(|id| {
            self.program
                .items
                .get(id.0 as usize)
                .filter(|item| item.id == *id && item.name == name && item.module == self.module)
        });
        let field = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        let IrItemKind::Field {
            owner,
            ty: IrType::Known(ty),
            server,
            modifiers,
            ..
        } = &field.kind
        else {
            return None;
        };
        // Writable arrays carry leaf sequences (collected `select`
        // projections); reference arrays stay out of hook inputs.
        // Contract values write as plain constructed data, exactly like
        // scenario inputs; they are never dereferenced by the profile.
        fn writable_leaf(profile: &HookProfile, ty: &ResolvedType) -> bool {
            // Nullable fields accept the same shapes as their inner type;
            // the null literal itself is admitted separately by
            // `nullable_reference_null`, and writes never widen nullability.
            let mut ty = ty;
            while let ResolvedType::Nullable(inner) = ty {
                ty = inner;
            }
            match ty {
                ResolvedType::Array { element, .. } => writable_leaf(profile, element),
                // Contract values write as plain constructed data whatever
                // persistence flag the field position carries; stored model
                // references stay out of hook inputs.
                ResolvedType::Record { symbol, .. } => profile
                    .program
                    .items
                    .get(symbol.0 as usize)
                    .is_some_and(|item| {
                        item.id == *symbol
                            && matches!(&item.kind, IrItemKind::Contract { .. })
                    }),
                ty => profile.leaf(ty),
            }
        }
        (*owner == model
            && (self.leaf(ty) || writable_leaf(self, ty))
            && (!writable || (server.is_none() && !modifiers.machine)))
            .then_some(ty)
    }

    fn after(expr: &TypedExpr) -> bool {
        matches!(&expr.expr, IrExpr::Member { base, field }
            if field == "after" && base.ty == ResolvedType::Unknown
                && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
    }

    fn context(expr: &TypedExpr) -> bool {
        let IrExpr::Member { base, field } = &expr.expr else {
            return false;
        };
        if matches!(&base.expr, IrExpr::Name(name) if name == "c")
            && base.ty == ResolvedType::Unknown
        {
            return match field.as_str() {
                "actor" => {
                    expr.ty == ResolvedType::Scalar(Scalar::User)
                        || expr.ty
                            == ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User)))
                }
                "now" => expr.ty == ResolvedType::Scalar(Scalar::Datetime),
                _ => false,
            };
        }
        let IrExpr::Member {
            base: root,
            field: context,
        } = &base.expr
        else {
            return false;
        };
        if !matches!(&root.expr, IrExpr::Name(name) if name == "c")
            || root.ty != ResolvedType::Unknown
        {
            return false;
        }
        match (context.as_str(), field.as_str()) {
            ("team", "id") => {
                base.ty == ResolvedType::Team && expr.ty == ResolvedType::Scalar(Scalar::Text)
            }
            ("team", "timezone") => {
                base.ty == ResolvedType::Team && expr.ty == ResolvedType::Scalar(Scalar::Timezone)
            }
            ("operation", "id" | "source") => {
                base.ty == ResolvedType::OperationContext
                    && expr.ty == ResolvedType::Scalar(Scalar::Text)
            }
            ("actorFacts", "email") => {
                base.ty == ResolvedType::Unknown && expr.ty == ResolvedType::Scalar(Scalar::Email)
            }
            ("actorFacts", "email_verified") => {
                base.ty == ResolvedType::Unknown && expr.ty == ResolvedType::Scalar(Scalar::Bool)
            }
            _ => false,
        }
    }

    fn after_root(expr: &TypedExpr) -> bool {
        matches!(&expr.expr, IrExpr::Member { base, field }
            if field == "after"
                && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
    }

    fn before_root(expr: &TypedExpr) -> bool {
        matches!(&expr.expr, IrExpr::Member { base, field }
            if field == "before"
                && matches!(&base.expr, IrExpr::Name(name) if name == "event"))
    }

    /// Resolve an event-rooted value to its owning model and alias class.
    /// `event.after` (and `event.before` on update) carry the full trigger
    /// snapshot; each `parent` step (and aliases bound to one) carries only
    /// the engine's `{model, id}` linkage identity. Anything else is not
    /// event-rooted.
    fn event_parent_class(
        &self,
        base: &TypedExpr,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
    ) -> Option<(SymbolId, EventAlias)> {
        let (child, _) = self.event_class(base, aliases)?;
        let child_item = self.program.items.get(child.0 as usize)?;
        if child_item.id != child {
            return None;
        }
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(parent),
            ..
        } = &child_item.kind
        else {
            return None;
        };
        let parent_item = self.program.items.get(parent.0 as usize)?;
        if parent_item.id != *parent || parent_item.module != self.module {
            return None;
        }
        Some((*parent, EventAlias::ParentIdentity))
    }
    fn event_reference_target(
        &self,
        base_model: SymbolId,
        field: &str,
    ) -> Option<SymbolId> {
        // Declared singular stored reference on the base model.
        // Cross-package targets allowed (e.g. success `Account`
        // → rent_catalog `Location`); the runtime edge check
        // (candidate `{id}` equality) enforces the genuine link.
        // Several items may share the name across model/CRUD
        // surfaces — take the stored-reference one.
        let mut target_opt: Option<SymbolId> = None;
        for item in self.program.items.iter() {
            if item.name != *field || item.module != self.module {
                continue;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(field_ty),
                ..
            } = &item.kind
            else {
                continue;
            };
            if *owner != base_model {
                continue;
            }
            match field_ty {
                ResolvedType::Record { symbol, stored: true } => {
                    target_opt = Some(*symbol);
                    break;
                }
                ResolvedType::Nullable(inner) => match &**inner {
                    ResolvedType::Record { symbol, stored: true } => {
                        target_opt = Some(*symbol);
                        break;
                    }
                    _ => continue,
                },
                _ => continue,
            }
        }
        target_opt
    }
    fn event_class(
        &self,
        expr: &TypedExpr,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
    ) -> Option<(SymbolId, EventAlias)> {
        if Self::after_root(expr) {
            return Some((self.model, EventAlias::Snapshot));
        }
        if Self::before_root(expr) {
            return (self.op == CrudOp::Update).then_some((self.model, EventAlias::Snapshot));
        }
        match &expr.expr {
            IrExpr::Name(name) => aliases.get(name).copied(),
            IrExpr::Member { base, field } if field == "parent" => {
                self.event_parent_class(base, aliases)
            }
            IrExpr::Member { base, field } => {
                // Direct snapshot stored-reference edges
                // (`event.after.<ref>`, `event.before.<ref>` on update, or
                // the same through a snapshot alias) plus one parent step
                // (`event.after.parent.<ref>` and the same through a parent
                // alias): the parent linkage identity resolves the owning
                // model, and the declared stored-reference edge resolves
                // the target the same way. Deeper chains
                // (`<ref>.<leaf>.<x>`, grandparent tails) stay unclassified
                // so deep traversals keep their refusal.
                let (base_model, base_class) = self.event_class(base, aliases)?;
                if !matches!(
                    base_class,
                    EventAlias::Snapshot | EventAlias::ParentIdentity
                ) {
                    return None;
                }
                let target = self.event_reference_target(base_model, field)?;
                let target_item = self.program.items.get(target.0 as usize)?;
                if target_item.id != target {
                    return None;
                }
                Some((target, EventAlias::ReferenceIdentity))
            }
            _ => None,
        }
    }

    /// Admitted array element shapes for hook reads: leaves and carried
    /// references, so change detection over `text[]`/`Location[]` lowers
    /// through the structural equality the emitter already uses in hooks.
    fn hook_array_element(&self, ty: &ResolvedType) -> bool {
        match ty {
            ResolvedType::Array { element, .. } => self.hook_array_element(element),
            ty => self.leaf(ty) || self.carried_ref(ty),
        }
    }

    /// Readable hook field of an event-pathed model: reserved identity plus
    /// leaf fields plus carried stored references. Parent-identity rows
    /// expose identity (`id`) directly; declared leaf/carried fields read
    /// through them via the transitive parent load (same declared-field
    /// correspondence as snapshots).
    fn hook_snapshot_field(&self, model: SymbolId, name: &str, ty: &ResolvedType) -> bool {
        if name == "id" {
            return *ty == ResolvedType::Scalar(Scalar::Text);
        }
        if name == "version" {
            return *ty == ResolvedType::Scalar(Scalar::Int);
        }
        if matches!(
            name,
            "parent"
                | "created"
                | "updated"
                | "createdBy"
                | "updatedBy"
                | "archivedAt"
        ) {
            return false;
        }
        // Several items may share one field name across model/CRUD
        // surfaces; admit when ANY declared field with this name on the
        // model matches the read type and allowed shape. The declaration
        // lives on the read model's owning module: same-module rows keep
        // their exact gate, while a stored-reference edge into another
        // package reads that package's declared leaf through the genuine
        // linkage (the runtime edge check enforces the link).
        let Some(read_module) = self
            .program
            .items
            .get(model.0 as usize)
            .filter(|item| item.id == model)
            .map(|item| item.module)
        else {
            return false;
        };
        for item in self.program.items.iter() {
            if item.name != name || item.module != read_module {
                continue;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(field_ty),
                modifiers,
                server: _,
                ..
            } = &item.kind
            else {
                continue;
            };
            if *owner != model || modifiers.machine || !Self::snapshot_read_compatible(field_ty, ty) {
                continue;
            }
            if self.leaf(ty)
                || self.carried_ref(ty)
                || matches!(ty, ResolvedType::Array { .. }) && self.hook_array_element(ty)
            {
                return true;
            }
        }
        false
    }

    /// A narrowed read of a nullable declared field carries the checker's
    /// non-null proof (e.g. after `!=null` in the same guard chain); it
    /// observes the same declared storage as the exact type. Reads must
    /// never widen nullability, so only exact or narrowed shapes admit.
    fn snapshot_read_compatible(field_ty: &ResolvedType, ty: &ResolvedType) -> bool {
        if field_ty == ty {
            return true;
        }
        matches!(field_ty, ResolvedType::Nullable(inner) if inner.as_ref() == ty)
    }

    /// Pure value builtins admitted in hooks with admitted arguments. Store
    /// reads (`count`, `first`, `any`, ...), capability calls and receipt
    /// joins stay out; `count` over an admitted contained query joins in
    /// the query layer below.
    fn pure_hook_builtin(id: &str) -> bool {
        matches!(id, "local_instant" | "local_date" | "max")
    }

    /// Equality family shared by `==`/`!=` operands in hooks, mirroring the
    /// emitted lowering: ordered scalars compare by value, stored references
    /// by identity, arrays structurally. Decimal and money keep their hook
    /// refusal; contracts and other nominals stay out.
    fn hook_eq_family(left: &ResolvedType, right: &ResolvedType) -> bool {
        fn stripped(ty: &ResolvedType) -> &ResolvedType {
            match ty {
                ResolvedType::Nullable(inner) => stripped(inner),
                ty => ty,
            }
        }
        match (stripped(left), stripped(right)) {
            // Email joins the exact-equality scalars: it is string-backed,
            // and snapshot leaf reads of it are already admitted, so an
            // `event.before`/`event.after` email comparison lowers through
            // the same shared binary lowering as every other equality here.
            (
                ResolvedType::Scalar(
                    Scalar::Int | Scalar::Date | Scalar::Datetime | Scalar::Duration | Scalar::Bool | Scalar::Text | Scalar::Email,
                ),
                ResolvedType::Scalar(_),
            ) => stripped(left) == stripped(right),
            (ResolvedType::Enum { .. }, ResolvedType::Enum { .. }) => true,
            (ResolvedType::Record { stored: true, .. }, ResolvedType::Record { stored: true, .. }) => true,
            (
                ResolvedType::Array { element: left, .. },
                ResolvedType::Array { element: right, .. },
            ) => HookProfile::hook_eq_family(left, right),
            _ => false,
        }
    }

    fn hook_leaf_expr(
        &self,
        expr: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
    ) -> Option<bool> {
        match &expr.expr {
            IrExpr::Int(_) if expr.ty == ResolvedType::Scalar(Scalar::Int) => Some(true),
            IrExpr::Bool(_) if expr.ty == ResolvedType::Scalar(Scalar::Bool) => Some(true),
            IrExpr::Datetime(_) if expr.ty == ResolvedType::Scalar(Scalar::Datetime) => Some(true),
            IrExpr::Null if expr.ty == ResolvedType::Null => Some(true),
            IrExpr::Text(value)
                if expr.ty == ResolvedType::Scalar(Scalar::Text)
                    || matches!(&expr.ty, ResolvedType::Enum { cases, .. } if self.leaf(&expr.ty) && cases.contains(value))
                    // Builtin-parameter enums (e.g. a named fold mode)
                    // have no declaring field; resolved case membership
                    // is the correspondence (same basis as the Name arm
                    // below; the emitter already quotes these as strings).
                    || matches!(&expr.ty, ResolvedType::Enum { owner: None, cases } if cases.contains(value)) =>
            {
                Some(true)
            }
            IrExpr::Name(name) if locals.get(name) == Some(&expr.ty) => Some(true),
            IrExpr::Name(name) if matches!(&expr.ty, ResolvedType::Enum { cases, .. } if self.leaf(&expr.ty) && cases.contains(name)) => {
                Some(true)
            }
            // Builtin-parameter enums (e.g. a named fold mode) have no
            // declaring field; resolved case membership is the
            // correspondence. The emitter already quotes these as strings,
            // as ordinary scenario bodies using the same builtins prove.
            IrExpr::Name(name) if matches!(&expr.ty, ResolvedType::Enum { owner: None, cases } if cases.contains(name)) => {
                Some(true)
            }
            IrExpr::Date(_) if expr.ty == ResolvedType::Scalar(Scalar::Date) => Some(true),
            IrExpr::DurationMs(_) if expr.ty == ResolvedType::Scalar(Scalar::Duration) => {
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn hook_identity_only_field(
        &self,
        base: &TypedExpr,
        model: SymbolId,
        field: &str,
        ty: &ResolvedType,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
    ) -> Option<()> {
        // Staged bindings carry `{id}` only and stay refused.
        // Parent linkage carries `{model, id}` for bare uses;
        // declared leaf/carried fields read through it via the
        // transitive parent load (same correspondence as
        // snapshots). Reference linkage (CAN18-v1 file-14 first
        // shape) carries the referenced `{model, id}` with the
        // same declared correspondence via the transitive
        // reference load — never through the ancestor fence.
        // Only the exact parent may expose issued revision metadata;
        // undeclared business fields never become `undefined`.
        if field == "version" {
            return self.parent_version_metadata(base, model, ty, aliases).then_some(());
        }
        if self
            .event_class(base, aliases)
            .is_some_and(|(_, class)| matches!(class,
                EventAlias::ParentIdentity | EventAlias::ReferenceIdentity))
            && self.hook_snapshot_field(model, field, ty)
        {
            return Some(());
        }
        // Staged data reads: the native emitter pairs the staged id
        // with this same supplied data, so exactly the explicitly
        // written fields (never `id`, never server-set fields) read
        // what the hook staged. Staged updates drop the entry above.
        if let IrExpr::Name(name) = &base.expr
            && aliases
                .get(name)
                .is_some_and(|(_, class)| *class == EventAlias::Staged)
            && self
                .staged_data
                .get(name)
                .is_some_and(|fields| fields.contains(field))
            && self.hook_snapshot_field(model, field, ty)
        {
            return Some(());
        }
        None
    }
    fn hook_member_expr(
        &mut self,
        expr: &TypedExpr,
        base: &TypedExpr,
        field: &str,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        locals: &HashMap<String, ResolvedType>,
    ) -> Option<()> {
        let (model, identity_only) = self.member_base(base, aliases, locals)?;
        if field == "id" {
            return (expr.ty == ResolvedType::Scalar(Scalar::Text)).then_some(());
        }
        if field == "version" && !identity_only {
            return (expr.ty == ResolvedType::Scalar(Scalar::Int)).then_some(());
        }
        if identity_only {
            return self.hook_identity_only_field(base, model, field, &expr.ty, aliases);
        }
        // Reserved identity/version are readonly views of the
        // event-pathed row. Mutation inputs still use field(..., true),
        // which refuses every metadata name.
        self.hook_snapshot_field(model, field, &expr.ty).then_some(())
    }
    fn hook_collection_expr(
        &mut self,
        expr: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        match &expr.expr {
            IrExpr::Array(items)
                if matches!(&expr.ty, ResolvedType::Array { .. }) =>
            {
                for item in items {
                    self.expr(item, locals, aliases, depth + 1)?;
                }
                Some(true)
            }
            IrExpr::Object(entries) => {
                for (_, value) in entries {
                    self.expr(value, locals, aliases, depth + 1)?;
                }
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn hook_binary_allowed(
        ty: &ResolvedType,
        op: &IrBinOp,
        left: &ResolvedType,
        right: &ResolvedType,
        null_test: bool,
    ) -> bool {
        let bool_ty = ResolvedType::Scalar(Scalar::Bool);
        let int_ty = ResolvedType::Scalar(Scalar::Int);
        match op {
            IrBinOp::Eq | IrBinOp::Ne => {
                *ty == bool_ty
                    && (null_test || Self::hook_eq_family(left, right))
            }
            IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge => {
                *ty == bool_ty && Self::hook_ordered(left, right)
            }
            IrBinOp::And | IrBinOp::Or => {
                *ty == bool_ty && *left == bool_ty && *right == bool_ty
            }
            IrBinOp::Add | IrBinOp::Sub => {
                Self::hook_additive(ty, left, right, *op)
            }
            IrBinOp::Mul => {
                *ty == int_ty && *left == int_ty && *right == int_ty
            }
            IrBinOp::Coalesce => {
                *right == *ty
                    && (*left == *ty
                        || left.nullable_inner() == Some(ty))
            }
            _ => false,
        }
    }
    fn hook_binary_expr(
        &mut self,
        expr: &TypedExpr,
        op: &IrBinOp,
        left: &TypedExpr,
        right: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        let null_test = (left.ty == ResolvedType::Null
            && right.ty.nullable_inner().is_some())
            || (right.ty == ResolvedType::Null && left.ty.nullable_inner().is_some());
        if !Self::hook_binary_allowed(&expr.ty, op, &left.ty, &right.ty, null_test) {
            return None;
        }
        self.expr(left, locals, aliases, depth + 1)?;
        self.expr(right, locals, aliases, depth + 1)
    }
    fn expr(
        &mut self,
        expr: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        self.step(depth)?;
        if Self::context(expr) {
            return Some(());
        }
        // Bare event-rooted values (snapshots, parent linkage, aliases)
        // carry into linkage, query parents, payloads and pure calls.
        if self.event_class(expr, aliases).is_some() {
            return Some(());
        }
        if self.hook_leaf_expr(expr, locals)? {
            return Some(());
        }
        if self.hook_collection_expr(expr, locals, aliases, depth)? {
            return Some(());
        }
        match &expr.expr {
            IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                self.hook_call(target, args, locals, aliases, depth + 1)
            }
            IrExpr::Query(query) => self.hook_query(query, locals, aliases, depth + 1),
            IrExpr::Member { base, field } => {
                self.hook_member_expr(expr, base, field, aliases, locals)?;
                Some(())
            }
            IrExpr::Binary { op, left, right } => {
                self.hook_binary_expr(expr, op, left, right, locals, aliases, depth)?;
                Some(())
            }
            IrExpr::Unary { op, operand }
                if (matches!(op, IrUnOp::Not) && expr.ty == ResolvedType::Scalar(Scalar::Bool))
                    || (matches!(op, IrUnOp::Neg)
                        && expr.ty == ResolvedType::Scalar(Scalar::Int)) =>
            {
                if operand.ty != expr.ty {
                    return None;
                }
                self.expr(operand, locals, aliases, depth + 1)
            }
            _ => None,
        }
    }

    /// Only the exact trigger parent carries issued revision metadata. A
    /// declared data field named version is a different source/type boundary.
    fn parent_version_metadata(&self, base: &TypedExpr, model: SymbolId, ty: &ResolvedType,
        aliases: &HashMap<String, (SymbolId, EventAlias)>) -> bool {
        *ty == ResolvedType::Scalar(Scalar::Int)
            && self.hook_direct_parent() == Some(model)
            && self.event_class(base, aliases) == Some((model, EventAlias::ParentIdentity))
            && !self.program.items.iter().any(|item| item.name == "version"
                && matches!(&item.kind, IrItemKind::Field { owner, .. } if *owner == model))
    }

    /// Classify a member-access base inside hooks: bound rows (with their
    /// identity-only flag) or full query rows bound as locals. The `bool`
    /// is true exactly for identity-only rows (parent linkage, reference
    /// linkage, staged bindings).
    fn member_base(
        &self,
        base: &TypedExpr,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        locals: &HashMap<String, ResolvedType>,
    ) -> Option<(SymbolId, bool)> {
        if let Some((model, class)) = self.event_class(base, aliases) {
            return Some((
                model,
                matches!(
                    class,
                    EventAlias::ParentIdentity | EventAlias::ReferenceIdentity | EventAlias::Staged
                ),
            ));
        }
        if let IrExpr::Name(name) = &base.expr {
            if let Some(ty) = locals.get(name) {
                let mut ty = ty;
                while let ResolvedType::Nullable(inner) = ty {
                    ty = inner;
                }
                if let ResolvedType::Record { symbol, stored: true } = ty {
                    return Some((*symbol, false));
                }
            }
        }
        None
    }

    /// Ordered comparison pairs admitted in hooks, mirroring the emitted
    /// scalar comparators (all pure, carrier-free). Decimal and money keep
    /// their existing refusals.
    fn hook_ordered(left: &ResolvedType, right: &ResolvedType) -> bool {
        fn stripped(ty: &ResolvedType) -> &ResolvedType {
            match ty {
                ResolvedType::Nullable(inner) => stripped(inner),
                ty => ty,
            }
        }
        matches!(
            (stripped(left), stripped(right)),
            (
                ResolvedType::Scalar(
                    Scalar::Int | Scalar::Duration | Scalar::Text | Scalar::Date | Scalar::Datetime,
                ),
                ResolvedType::Scalar(_),
            )
        ) && stripped(left) == stripped(right)
    }

    /// Additive shapes admitted in hooks: exact `int64` integer arithmetic
    /// plus the emitted duration helpers (`now + 1ms`, duration sums, and
    /// `datetime - datetime` spans). Money and decimal stay out.
    fn hook_additive(result: &ResolvedType, left: &ResolvedType, right: &ResolvedType, op: IrBinOp) -> bool {
        let int_ty = ResolvedType::Scalar(Scalar::Int);
        let datetime_ty = ResolvedType::Scalar(Scalar::Datetime);
        let duration_ty = ResolvedType::Scalar(Scalar::Duration);
        if *result == int_ty && *left == int_ty && *right == int_ty {
            return true;
        }
        match op {
            IrBinOp::Add | IrBinOp::Sub => {
                (*result == datetime_ty && *left == datetime_ty && *right == duration_ty)
                    || (*result == duration_ty && *left == duration_ty && *right == duration_ty)
                    || (op == IrBinOp::Sub
                        && *result == duration_ty
                        && *left == datetime_ty
                        && *right == datetime_ty)
            }
            _ => false,
        }
    }

    /// Pure call targets admitted in hooks with admitted arguments: checked
    /// derives (pure functions of their arguments, invoked with the native
    /// ambient context) and the recorded pure temporal/aggregate builtins.
    /// Parent-identity arguments refuse — a `{model, id}` linkage is not
    /// the row a derive reads — except into a stored-record parameter of a
    /// checked derive whose body reads only admitted parent fields (see
    /// `hook_derive_call`): the emitted hook variant loads those fields
    /// through `c.transitive` at the inheriting site. Store reads keep
    /// their query-layer join.
    fn hook_call(
        &mut self,
        target: &IrCallTarget,
        args: &[TypedExpr],
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        match target {
            IrCallTarget::DeriveFn(canonical) => {
                return self.hook_derive_call(canonical, args, locals, aliases, depth);
            }
            IrCallTarget::Builtin { id, .. } if Self::pure_hook_builtin(id) => {}
            IrCallTarget::Builtin { id, .. } if id == "count" => {
                // `count` over an admitted contained query lowers through
                // the generic supplied-array builtin on the lowered rows.
                // Anything else countable stays on its existing path.
                if args.len() != 1 || !matches!(&args[0].expr, IrExpr::Query(_)) {
                    return None;
                }
            }
            _ => return None,
        }
        for arg in args {
            self.expr(arg, locals, aliases, depth + 1)?;
            if self.event_class(arg, aliases).is_some_and(|(_, class)| {
                matches!(
                    class,
                    EventAlias::ParentIdentity | EventAlias::ReferenceIdentity | EventAlias::Staged
                )
            }) {
                return None;
            }
        }
        Some(())
    }

    /// Trigger's direct containment parent: the only linkage model a
    /// record-typed helper parameter may carry. Deeper ancestry keeps its
    /// existing refusal (loud `E6008`, never a silent wrong row).
    fn hook_direct_parent(&self) -> Option<SymbolId> {
        let trigger = self.program.items.get(self.model.0 as usize)?;
        if trigger.id != self.model {
            return None;
        }
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(parent),
            ..
        } = &trigger.kind
        else {
            return None;
        };
        let parent_item = self.program.items.get(parent.0 as usize)?;
        if parent_item.id != *parent || parent_item.module != self.module {
            return None;
        }
        Some(*parent)
    }

    /// Record-typed helper admission for hook calls. Without a linkage
    /// argument the existing scalar rule holds (staged/linkage values stay
    /// out). With one, every linkage argument must fill either the
    /// trigger's direct-parent model (parent linkage) or a declared stored
    /// reference target of the trigger (reference linkage, CAN18-v1
    /// file-14 first shape) in a stored-record parameter, and the callee
    /// body must admit over that linkage (helpers inherit the consuming
    /// site; no Boolean-result privilege — the loader returns rows).
    fn hook_derive_call(
        &mut self,
        canonical: &str,
        args: &[TypedExpr],
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        for arg in args {
            self.expr(arg, locals, aliases, depth + 1)?;
        }
        if !args.iter().any(|arg| {
            self.event_class(arg, aliases).is_some_and(|(_, class)| {
                matches!(
                    class,
                    EventAlias::ParentIdentity | EventAlias::ReferenceIdentity | EventAlias::Staged
                )
            })
        }) {
            return Some(());
        }
        let mut callees = self.program.items.iter().filter(|item| {
            item.canonical == *canonical && matches!(&item.kind, IrItemKind::DeriveFn { .. })
        });
        let callee = callees.next()?;
        if callees.next().is_some() {
            return None;
        }
        if self.hook_body_derives.iter().any(|seen| seen == canonical) {
            return None;
        }
        let IrItemKind::DeriveFn {
            params,
            expr: Some(body),
            ..
        } = &callee.kind
        else {
            return None;
        };
        if params.len() != args.len() {
            return None;
        }
        let direct_parent = self.hook_direct_parent()?;
        if Self::hook_body_has_closure(body) {
            return None;
        }
        let body = body.clone();
        let mut inner_locals = HashMap::new();
        let mut inner_aliases = HashMap::new();
        for (param_id, arg) in params.iter().zip(args.iter()) {
            let param = self.program.items.get(param_id.0 as usize)?;
            if param.id != *param_id {
                return None;
            }
            let IrItemKind::Param {
                ty: IrType::Known(ty),
                ..
            } = &param.kind
            else {
                return None;
            };
            match self.event_class(arg, aliases) {
                Some((model, EventAlias::ParentIdentity)) => {
                    let ResolvedType::Record { symbol, stored: true } = ty else {
                        return None;
                    };
                    if *symbol != model || model != direct_parent {
                        return None;
                    }
                    inner_aliases.insert(param.name.clone(), (model, EventAlias::ParentIdentity));
                }
                Some((model, EventAlias::ReferenceIdentity)) => {
                    let ResolvedType::Record { symbol, stored: true } = ty else {
                        return None;
                    };
                    if *symbol != model {
                        return None;
                    }
                    // Declared-edge correspondence is already enforced at
                    // the call site (`event_class` only classifies genuine
                    // stored-reference edges of this trigger); the runtime
                    // candidate `{id}` equality enforces the live link.
                    // Mixed parent+reference linkages in one call stay
                    // refused below via the emitter's kind check — the
                    // profile admits each linkage kind here so single-kind
                    // helpers lower.
                    inner_aliases.insert(param.name.clone(), (model, EventAlias::ReferenceIdentity));
                }
                Some((_, EventAlias::Staged)) => return None,
                _ => {
                    inner_locals.insert(param.name.clone(), ty.clone());
                }
            }
        }
        self.hook_body_derives.push(canonical.to_string());
        let admitted = self.expr(&body, &inner_locals, &inner_aliases, depth + 1);
        self.hook_body_derives.pop();
        admitted
    }

    /// Closures (lambdas, queries) inside a record-helper body refuse: the
    /// hook-variant emission lowers linkage reads inline, which has no
    /// async carrier inside a nested closure. Loud refusal, never silent.
    fn hook_body_has_closure(expr: &TypedExpr) -> bool {
        match &expr.expr {
            IrExpr::Call { args, .. }
            | IrExpr::BoundCall { args, .. }
            | IrExpr::MessageCall { args, .. }
            | IrExpr::Format { args, .. } => args.iter().any(Self::hook_body_has_closure),
            IrExpr::Member { base, .. }
            | IrExpr::Unary { operand: base, .. }
            | IrExpr::DeliveryRead { record: base, .. } => Self::hook_body_has_closure(base),
            IrExpr::Binary { left, right, .. } => {
                Self::hook_body_has_closure(left) || Self::hook_body_has_closure(right)
            }
            IrExpr::Array(items) => items.iter().any(Self::hook_body_has_closure),
            IrExpr::Object(entries) => entries.iter().any(|(_, value)| Self::hook_body_has_closure(value)),
            IrExpr::JudgmentSpecification { options, .. } => options
                .as_ref()
                .is_some_and(|option| Self::hook_body_has_closure(option)),
            IrExpr::HasRole { person, .. } => person
                .as_ref()
                .is_some_and(|subject| Self::hook_body_has_closure(subject)),
            IrExpr::Query(_) | IrExpr::Lambda { .. } => true,
            _ => false,
        }
    }

    /// Model descriptor by canonical identity within this hook's module.
    fn hook_model_by_canonical(&self, canonical: &str) -> Option<SymbolId> {
        let mut targets = self.program.items.iter().filter(|item| {
            item.canonical == *canonical
                && item.module == self.module
                && matches!(&item.kind, IrItemKind::Model { .. })
        });
        let target = targets.next()?;
        if targets.next().is_some() {
            return None;
        }
        Some(target.id)
    }

    /// Contained queries admitted in hooks: model domains whose parent
    /// resolves through `event.after`/`event.before` (or an alias) to the
    /// domain's declared containment parent. They lower through the
    /// accepted query engine with the trigger's author/clock, so
    /// before/after snapshots stay intact and reads observe committed
    /// rows. Global scans, value domains, ordering, async predicates and
    /// contract collections stay out with their existing refusals.
    fn join_hook_query_target(
        &mut self,
        query: &IrQuery,
        domain: &str,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
    ) -> Option<SymbolId> {
        let target = self.hook_model_by_canonical(domain)?;
        let target_item = self.program.items.get(target.0 as usize)?;
        if target_item.id != target {
            return None;
        }
        let IrItemKind::Model {
            owner: IrOwner::ChildOf(declared_parent),
            ..
        } = &target_item.kind
        else {
            return None;
        };
        let parent = query.parent.as_deref()?;
        let (parent_model, _) = self.event_class(parent, aliases)?;
        if parent_model != *declared_parent {
            return None;
        }
        Some(target)
    }
    fn visit_hook_query_parts(
        &mut self,
        query: &IrQuery,
        target: SymbolId,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        if let Some(pred) = &query.where_pred {
            if pred.ty != ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            let mut inner = locals.clone();
            inner.insert(
                query.where_param.clone(),
                ResolvedType::Record {
                    symbol: target,
                    stored: true,
                },
            );
            self.expr(pred, &inner, aliases, depth + 1)?;
        }
        if let Some(limit) = &query.limit {
            if limit.ty != ResolvedType::Scalar(Scalar::Int) {
                return None;
            }
            self.expr(limit, locals, aliases, depth + 1)?;
        }
        if let Some(archived) = &query.archived {
            self.expr(archived, locals, aliases, depth + 1)?;
        }
        if let Some(body) = &query.select {
            let param = query.select_param.clone()?;
            let mut inner = locals.clone();
            inner.insert(
                param,
                ResolvedType::Record {
                    symbol: target,
                    stored: true,
                },
            );
            self.expr(body, &inner, aliases, depth + 1)?;
        }
        Some(())
    }
    fn hook_query(
        &mut self,
        query: &IrQuery,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        self.step(depth)?;
        let IrQueryDomain::Model(domain) = &query.domain else {
            return None;
        };
        if !query.order.is_empty()
            || query.where_async
            || query.contract_collection_call.is_some()
            || query.value_order.is_some()
        {
            return None;
        }
        let target = self.join_hook_query_target(query, domain, aliases)?;
        self.visit_hook_query_parts(query, target, locals, aliases, depth)
    }

    /// Hook input compatibility: exact types, null into nullable, and
    /// array values whose literal flags (`ordered`, `nonempty`) imply the
    /// field's requirements. Checked assignment already validated the
    /// value; the plan only confirms the shape it lowers.
    fn hook_input_compatible(field: &ResolvedType, value: &ResolvedType) -> bool {
        if field == value {
            return true;
        }
        if *value == ResolvedType::Null {
            return field.nullable_inner().is_some();
        }
        if let ResolvedType::Nullable(inner) = field {
            return Self::hook_input_compatible(inner, value);
        }
        // Contract identities compare by symbol: field and value positions
        // carry different persistence flags for the same contract.
        if let (
            ResolvedType::Record {
                symbol: expected, ..
            },
            ResolvedType::Record { symbol: actual, .. },
        ) = (field, value)
        {
            return expected == actual;
        }
        match (field, value) {
            (
                ResolvedType::Array {
                    element: expected,
                    ordered: ordered_field,
                    nonempty: nonempty_field,
                },
                ResolvedType::Array {
                    element: actual,
                    ordered: ordered_value,
                    nonempty: nonempty_value,
                },
            ) => {
                Self::hook_input_compatible(expected, actual)
                    && (!nonempty_field || *nonempty_value)
                    && (!ordered_field || *ordered_value)
            }
            _ => false,
        }
    }

    /// Null literals for declared nullable fields stage no stored model
    /// reference, so hook inputs admit them even when the field itself is
    /// not hook-writable (stored references stay out of hook inputs).
    /// Owning State resolves the omission/default. Only the null literal
    /// qualifies: server-owned, machine, undeclared, or non-nullable
    /// fields refuse, exactly like any non-null staged reference.
    fn nullable_reference_null(
        &self,
        model: SymbolId,
        name: &str,
        value: &TypedExpr,
    ) -> bool {
        if !matches!(&value.expr, IrExpr::Null) || value.ty != ResolvedType::Null {
            return false;
        }
        let Some(target) = self
            .program
            .items
            .get(model.0 as usize)
            .filter(|item| item.id == model)
        else {
            return false;
        };
        let IrItemKind::Model { fields, .. } = &target.kind else {
            return false;
        };
        // Same declared membership as `field`: only this model's own field
        // items qualify, resolved through owning identity, never position.
        fields.iter().any(|id| {
            let Some(field) = self
                .program
                .items
                .get(id.0 as usize)
                .filter(|item| item.id == *id)
            else {
                return false;
            };
            if field.name != name || field.module != self.module {
                return false;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(ty),
                server,
                modifiers,
                ..
            } = &field.kind
            else {
                return false;
            };
            *owner == model
                && server.is_none()
                && !modifiers.machine
                && ty.nullable_inner().is_some()
        })
    }

    /// Snapshot rows project to linkage for stored-record create inputs: the
    /// snapshot always carries the trigger identity, and the engine stages
    /// record inputs as `{model, id}` (the parent slot already lowers this
    /// way). Admits only when the declared field is the same stored model;
    /// anything else falls through to the leaf/contract rules below.
    #[allow(clippy::too_many_arguments)]
    fn snapshot_record_input(
        &mut self,
        model: SymbolId,
        name: &str,
        value: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        // Non-event values fall through to the leaf/contract rules below;
        // only snapshot rows take the linkage projection.
        if !matches!(
            self.event_class(value, aliases),
            Some((_, EventAlias::Snapshot))
        ) {
            return Some(false);
        }
        let want = value.ty.nullable_inner().unwrap_or(&value.ty);
        let ResolvedType::Record { symbol, stored: true } = want else {
            return Some(false);
        };
        let mut declared = false;
        for item in self.program.items.iter() {
            if item.name != name || item.module != self.module {
                continue;
            }
            let IrItemKind::Field {
                owner,
                ty: IrType::Known(field_ty),
                ..
            } = &item.kind
            else {
                continue;
            };
            if *owner != model {
                continue;
            }
            let have = field_ty.nullable_inner().unwrap_or(field_ty);
            if *have
                == (ResolvedType::Record {
                    symbol: *symbol,
                    stored: true,
                })
            {
                declared = true;
                break;
            }
        }
        if !declared {
            return Some(false);
        }
        self.expr(value, locals, aliases, depth + 1)?;
        Some(true)
    }

    fn input(
        &mut self,
        model: SymbolId,
        input: &TypedExpr,
        locals: &HashMap<String, ResolvedType>,
        aliases: &HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let mut names = HashSet::new();
        for (name, value) in entries {
            if !names.insert(name) {
                return None;
            }
            if name == "parent" {
                // Containment linkage carries the event-rooted parent
                // identity; the staged-create lowering splits it off the
                // data object into `{model, id}`. The value must resolve to
                // the created model's declared parent.
                let (parent, _) = self.event_class(value, aliases)?;
                let target = self.program.items.get(model.0 as usize)?;
                if target.id != model {
                    return None;
                }
                let IrItemKind::Model {
                    owner: IrOwner::ChildOf(declared),
                    ..
                } = &target.kind
                else {
                    return None;
                };
                if parent != *declared {
                    return None;
                }
                self.expr(value, locals, aliases, depth + 1)?;
                continue;
            }
            if self.nullable_reference_null(model, name, value) {
                continue;
            }
            if self.snapshot_record_input(model, name, value, locals, aliases, depth)? {
                continue;
            }
            let ty = self.field(model, name, true)?;
            if !Self::hook_input_compatible(ty, &value.ty) {
                return None;
            }
            self.expr(value, locals, aliases, depth + 1)?;
        }
        // Only supplied fields are inspected. Owning State resolves omissions,
        // including server actor/now fields and declared creation defaults.
        Some(())
    }

    fn visit_let_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        let IrStmt::Let { name, value, .. } = statement else {
            return Some(false);
        };
        self.expr(value, locals, aliases, depth + 1)?;
        if !self.leaf(&value.ty) && !Self::context(value) {
            // Event-rooted rows bind as aliases: snapshots carry
            // the full trigger row, parent steps only linkage
            // identity. Anything else non-leaf stays out.
            let (model, class) = self.event_class(value, aliases)?;
            aliases.insert(name.clone(), (model, class));
        }
        locals.insert(name.clone(), value.ty.clone());
        Some(true)
    }
    fn visit_set_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        let IrStmt::Set {
            record, changes, ..
        } = statement
        else {
            return Some(false);
        };
        if Self::after(record)
            && (record.ty == ResolvedType::Unknown
                || record.ty
                    == (ResolvedType::Record {
                        symbol: self.model,
                        stored: true,
                    }))
        {
            // decode_record_path preserves this contextual target
            // as Unknown. The exact synthetic event.after path
            // above and this checked hook's trigger establish its
            // model; every supplied writable field is validated
            // against that model.
            self.input(self.model, changes, locals, aliases, depth + 1)?;
        } else if let IrExpr::Member { base: _, field } = &record.expr
            && field == "parent"
            && let Some((parent_model, EventAlias::ParentIdentity)) =
                self.event_class(record, aliases)
            && parent_model != self.model
        {
            // Staged parent update: the engine addresses the stored
            // parent row by model plus linkage id (lower_hook_set
            // stages exactly this shape for non-after targets);
            // changes validate against the parent's declared fields.
            self.input(parent_model, changes, locals, aliases, depth + 1)?;
        } else if let IrExpr::Name(name) = &record.expr {
            // Staged update of a bound full row (contained
            // query items) or staged binding: addressed by
            // model plus record id. Same-model staging stays
            // checker-barred (E4052); event aliases never
            // qualify as set targets. A staged update leaves no
            // local state behind, so the alias no longer offers
            // its created data to reads.
            if aliases.get(name).is_some_and(|(_, class)| {
                *class != EventAlias::Staged
            }) {
                return None;
            }
            self.staged_data.remove(name);
            let mut row_ty = locals.get(name)?;
            while let ResolvedType::Nullable(inner) = row_ty {
                row_ty = inner;
            }
            let ResolvedType::Record { symbol, stored: true } = row_ty
            else {
                return None;
            };
            self.input(*symbol, changes, locals, aliases, depth + 1)?;
        } else {
            return None;
        }
        Some(true)
    }
    fn visit_for_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        let IrStmt::For {
            item, domain, limit, body, ..
        } = statement
        else {
            return Some(false);
        };
        // Contained iteration only: the domain must be an
        // admitted contained query, and the item binds its full
        // rows for the body. The item shadows any event alias
        // under its name for the body's scope.
        self.expr(domain, locals, aliases, depth + 1)?;
        let IrExpr::Query(query) = &domain.expr else {
            return None;
        };
        let IrQueryDomain::Model(canonical) = &query.domain else {
            return None;
        };
        let target = self.hook_model_by_canonical(canonical)?;
        if let Some(bound) = limit {
            if bound.ty != ResolvedType::Scalar(Scalar::Int) {
                return None;
            }
            self.expr(bound, locals, aliases, depth + 1)?;
        }
        let mut inner_locals = locals.clone();
        inner_locals.insert(
            item.clone(),
            ResolvedType::Record {
                symbol: target,
                stored: true,
            },
        );
        let mut inner_aliases = aliases.clone();
        inner_aliases.remove(item);
        // Loop-body writes discard like the cloned aliases.
        let saved_staged = self.staged_data.clone();
        self.statements(body, &mut inner_locals, &mut inner_aliases, depth + 1)?;
        self.staged_data = saved_staged;
        Some(true)
    }
    fn visit_create_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        let IrStmt::Create {
            model,
            input,
            binding,
            ..
        } = statement
        else {
            return Some(false);
        };
        let mut targets = self.program.items.iter().filter(|item| {
            item.canonical == *model && matches!(item.kind, IrItemKind::Model { .. })
        });
        let target = targets.next()?;
        if targets.next().is_some()
            || target.id == self.model
            || !self.model_supported(target.id)
        {
            return None;
        }
        self.input(target.id, input, locals, aliases, depth + 1)?;
        if let Some(name) = binding {
            // The bound `{id}` identity serves bare and `.id`
            // uses (emit payloads, cancellation keys); other fields
            // read exactly when the native emitter pairs the staged
            // id with this same supplied data (see hook_member_expr).
            // `id` is never a data field (the staged identity owns
            // it) and `parent` travels as linkage, never data, on
            // both sides — so neither is admittable here.
            aliases.insert(name.clone(), (target.id, EventAlias::Staged));
            if let IrExpr::Object(entries) = &input.expr {
                self.staged_data.insert(
                    name.clone(),
                    entries
                        .iter()
                        .map(|(key, _)| key.clone())
                        .filter(|key| key != "id" && key != "parent")
                        .collect(),
                );
            }
            locals.insert(
                name.clone(),
                ResolvedType::Record {
                    symbol: target.id,
                    stored: true,
                },
            );
        }
        Some(true)
    }
    fn visit_if_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        let IrStmt::If {
            cond,
            then_branch,
            else_branch,
            ..
        } = statement
        else {
            return Some(false);
        };
        if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        self.expr(cond, locals, aliases, depth + 1)?;
        // Branch writes discard like the cloned aliases: a staged
        // alias created on one arm must not offer its data after it.
        let saved_staged = self.staged_data.clone();
        self.statements(
            then_branch,
            &mut locals.clone(),
            &mut aliases.clone(),
            depth + 1,
        )?;
        self.staged_data = saved_staged.clone();
        self.statements(
            else_branch,
            &mut locals.clone(),
            &mut aliases.clone(),
            depth + 1,
        )?;
        self.staged_data = saved_staged;
        Some(true)
    }
    fn visit_scheduled_statement(
        &mut self,
        statement: &IrStmt,
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<bool> {
        match statement {
            IrStmt::Schedule {
                key, at, payload, ..
            } => {
                if key.ty != ResolvedType::Scalar(Scalar::Text) {
                    return None;
                }
                self.expr(key, locals, aliases, depth + 1)?;
                self.expr(at, locals, aliases, depth + 1)?;
                if !matches!(&payload.expr, IrExpr::Object(_)) {
                    return None;
                }
                self.expr(payload, locals, aliases, depth + 1)?;
                Some(true)
            }
            IrStmt::Cancel { key, .. } => {
                if key.ty != ResolvedType::Scalar(Scalar::Text) {
                    return None;
                }
                self.expr(key, locals, aliases, depth + 1)?;
                Some(true)
            }
            IrStmt::Emit { payload, .. } => {
                // The emit lowering joins separately; the plan admits the
                // payload shape so sibling now/derive/query gaps clear on
                // native runners. Ordered guards, atomic staging and null
                // paths are verified at the lowering tests below.
                if !matches!(&payload.expr, IrExpr::Object(_)) {
                    return None;
                }
                self.expr(payload, locals, aliases, depth + 1)?;
                Some(true)
            }
            _ => Some(false),
        }
    }
    fn statements(
        &mut self,
        statements: &[IrStmt],
        locals: &mut HashMap<String, ResolvedType>,
        aliases: &mut HashMap<String, (SymbolId, EventAlias)>,
        depth: usize,
    ) -> Option<()> {
        for statement in statements {
            self.step(depth)?;
            if let IrStmt::Require { cond, .. } = statement {
                if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                    return None;
                }
                self.expr(cond, locals, aliases, depth + 1)?;
                continue;
            }
            if self.visit_let_statement(statement, locals, aliases, depth)? {
                continue;
            }
            if self.visit_set_statement(statement, locals, aliases, depth)? {
                continue;
            }
            if self.visit_for_statement(statement, locals, aliases, depth)? {
                continue;
            }
            if self.visit_create_statement(statement, locals, aliases, depth)? {
                continue;
            }
            if self.visit_if_statement(statement, locals, aliases, depth)? {
                continue;
            }
            if self.visit_scheduled_statement(statement, locals, aliases, depth)? {
                continue;
            }
            return None;
        }
        Some(())
    }
}

/// Return first-observed owning stored fields, or refuse the entire predicate.
/// This classification does not authorize or activate native execution.
pub fn local_rule_fields(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    let item = program.items.get(model.0 as usize)?;
    if item.id != model
        || !matches!(item.kind, IrItemKind::Model { .. })
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    let mut fields = Vec::new();
    visit(program, model, predicate, &mut fields, false)?;
    Some(fields)
}

/// Nongrant classification for required owning paths. Native activation still
/// requires the complete source/fresh declaration and predicate correspondence.
/// Nullable references, collections, aliases and computed receivers stay out.
pub(crate) fn required_model_rule_path(
    program: &IrProgram,
    model: SymbolId,
    value: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    fn path(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        depth: usize,
    ) -> Option<()> {
        if depth > 16 {
            return None;
        }
        if matches!(value.expr, IrExpr::Name(_)) {
            return policy_row(value, model);
        }
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        if !contains_span(value.span, base.span) {
            return None;
        }
        path(program, model, base, fields, depth + 1)?;
        match &base.ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } => {
                let target = policy_model(program, *symbol)?;
                if field == "parent" {
                    let IrItemKind::Model {
                        owner: IrOwner::ChildOf(parent),
                        ..
                    } = target.kind
                    else {
                        return None;
                    };
                    policy_model(program, parent)?;
                    return (value.ty
                        == ResolvedType::Record {
                            symbol: parent,
                            stored: true,
                        })
                    .then_some(());
                }
                if !matches!(
                    &value.ty,
                    ResolvedType::Record { stored: true, .. }
                        | ResolvedType::Scalar(Scalar::Money | Scalar::Currency)
                        | ResolvedType::Enum { .. }
                ) || matches!(&value.ty, ResolvedType::Enum { .. })
                    && !local_type(program, *symbol, &value.ty)
                {
                    return None;
                }
                let id = policy_field(program, *symbol, field, &value.ty)?;
                if let ResolvedType::Record { symbol, .. } = value.ty {
                    policy_model(program, symbol)?;
                }
                if !fields.contains(&id) {
                    fields.push(id);
                }
                Some(())
            }
            ResolvedType::Scalar(Scalar::Money) => match (field.as_str(), &value.ty) {
                ("minor", ResolvedType::Scalar(Scalar::Int))
                | ("currency", ResolvedType::Scalar(Scalar::Currency)) => Some(()),
                _ => None,
            },
            _ => None,
        }
    }
    let mut fields = Vec::new();
    path(program, model, value, &mut fields, 0)?;
    Some(fields)
}

/// The bounded invariant extension composes identity/currency/owning-enum
/// comparisons and Money minor bounds through the existing lazy bool tree.
/// It adds no general Record arithmetic, nullable traversal, calls or collections.
pub(crate) fn required_model_rule_fields(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<SymbolId>> {
    if local_rule_fields(program, model, predicate).is_some() {
        return None;
    }
    fn visit(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 || value.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        if let Some(local) = local_rule_fields(program, model, value) {
            for id in local {
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
            return Some(());
        }
        let IrExpr::Binary { op, left, right } = &value.expr else {
            return None;
        };
        policy_binary(value, *op)?;
        if matches!(op, IrBinOp::And | IrBinOp::Or) {
            visit(program, model, left, fields, depth + 1)?;
            return visit(program, model, right, fields, depth + 1);
        }
        if left.ty != right.ty {
            return None;
        }
        let path_pair = matches!(op, IrBinOp::Eq | IrBinOp::Ne)
            && matches!(
                &left.ty,
                ResolvedType::Record { stored: true, .. }
                    | ResolvedType::Scalar(Scalar::Currency)
                    | ResolvedType::Enum { .. }
            );
        let minor_bound = matches!(op, IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge)
            && left.ty == ResolvedType::Scalar(Scalar::Int);
        if !path_pair && !minor_bound {
            return None;
        }
        collect_comparison_paths(program, model, left, right, minor_bound, fields)
    }
    fn collect_comparison_paths(
        program: &IrProgram,
        model: SymbolId,
        left: &Box<TypedExpr>,
        right: &Box<TypedExpr>,
        minor_bound: bool,
        fields: &mut Vec<SymbolId>,
    ) -> Option<()> {
        let mut paths = 0;
        for operand in [left, right] {
            // The other operand must still establish an exact owning stored
            // path. A case literal alone cannot certify a dependency or rule.
            if let ResolvedType::Enum { cases, .. } = &operand.ty {
                if matches!(&operand.expr, IrExpr::Name(case) | IrExpr::Text(case) if cases.contains(case))
                {
                    continue;
                }
            }
            if minor_bound && matches!(operand.expr, IrExpr::Int(_)) {
                continue;
            }
            let path = required_model_rule_path(program, model, operand)?;
            if path.is_empty() {
                return None;
            }
            paths += 1;
            for id in path {
                if !fields.contains(&id) {
                    fields.push(id);
                }
            }
        }
        (paths > 0).then_some(())
    }
    let mut fields = Vec::new();
    visit(program, model, predicate, &mut fields, 0)?;
    Some(fields)
}

/// Existing dependency bindings consume declaration-derived reverse edges.
/// Each edge is (owning Model, actual stored field or implicit parent, target).
pub(crate) type RequiredModelRuleDependency = (SymbolId, Vec<(SymbolId, String, SymbolId)>);

pub(crate) fn required_model_rule_dependencies(
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
) -> Option<Vec<RequiredModelRuleDependency>> {
    fn edges(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        depth: usize,
    ) -> Option<Vec<(SymbolId, String, SymbolId)>> {
        if depth > 16 {
            return None;
        }
        if matches!(value.expr, IrExpr::Name(_)) {
            policy_row(value, model)?;
            return Some(Vec::new());
        }
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        let ResolvedType::Record {
            symbol: source,
            stored: true,
        } = base.ty
        else {
            return None;
        };
        let ResolvedType::Record {
            symbol: target,
            stored: true,
        } = value.ty
        else {
            return None;
        };
        required_model_rule_path(program, model, value)?;
        let mut path = edges(program, model, base, depth + 1)?;
        path.push((source, field.clone(), target));
        Some(path)
    }
    fn visit(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        dependencies: &mut Vec<RequiredModelRuleDependency>,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 || dependencies.len() > 200 {
            return None;
        }
        match &value.expr {
            IrExpr::Member { base, .. } => {
                visit(program, model, base, dependencies, depth + 1)?;
                if let ResolvedType::Record {
                    symbol,
                    stored: true,
                } = base.ty
                {
                    let path = edges(program, model, base, 0)?;
                    if !path.is_empty()
                        && !dependencies
                            .iter()
                            .any(|(target, original)| *target == symbol && *original == path)
                    {
                        dependencies.push((symbol, path));
                    }
                }
            }
            IrExpr::Binary { left, right, .. } => {
                visit(program, model, left, dependencies, depth + 1)?;
                visit(program, model, right, dependencies, depth + 1)?;
            }
            IrExpr::Unary { operand, .. } => {
                visit(program, model, operand, dependencies, depth + 1)?
            }
            _ => {}
        }
        Some(())
    }
    required_model_rule_fields(program, model, predicate)?;
    let mut dependencies = Vec::new();
    visit(program, model, predicate, &mut dependencies, 0)?;
    Some(dependencies)
}

/// The two original current-Revision rules, classified without publishing a
/// policy descriptor. In particular, Template's referenced Revision requires
/// an original/fresh source join and an owning reverse affected-row selector;
/// it must never enter `local_rule_fields` with an empty dependency certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentRevisionRuleProfile {
    pub origin: IrModelRuleOrigin,
    pub kind: CurrentRevisionRuleKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentRevisionRuleKind {
    Template {
        duration: SymbolId,
        current: SymbolId,
        revision: SymbolId,
        published: SymbolId,
    },
    Revision {
        duration: SymbolId,
        published: SymbolId,
        digest: SymbolId,
    },
}

/// Additional lock targets only for the source-sealed original Revision rule.
/// This helper alone never authorizes a descriptor or a structural value type.
pub(crate) fn current_revision_lock_target(
    program: &IrProgram,
    profile: &CurrentRevisionRuleProfile,
    field: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> bool {
    let CurrentRevisionRuleKind::Revision { digest, .. } = profile.kind else {
        return false;
    };
    if policy_field(program, profile.origin.model, name, ty) != Some(field) {
        return false;
    }
    match (name, ty) {
        ("digest", ResolvedType::Nullable(inner)) => {
            field == digest && inner.as_ref() == &ResolvedType::Scalar(Scalar::Text)
        }
        ("definition", _) => {
            crate::analysis::types::checked_standard_nominal_name(ty) == Some("WorkflowDefinition")
        }
        ("validation", ResolvedType::Nullable(inner)) => {
            matches!(inner.as_ref(), ResolvedType::StdDelivery { capability: "std.ImagesV1", op }
            if crate::analysis::catalog::std_operation("std.ImagesV1", "validate") == Some(*op))
        }
        _ => false,
    }
}

/// Preserve the actual typed lazy tree and owning identities of the original
/// Template/Revision invariants. This is a nongrant classifier over checked IR,
/// not a source seal, executable policy binding, or native activation claim.
fn check_rule_origin<'a>(
    program: &'a IrProgram,
    rule: &'a IrRuleFn,
) -> Option<(&'a super::ir::IrItem, &'a IrModelRuleOrigin)> {
    let origin = rule.origin.as_ref()?;
    let model = policy_model(program, origin.model)?;
    let IrItemKind::Model { invariants, .. } = &model.kind else {
        return None;
    };
    if origin.kind != IrModelRuleKind::Invariant
        || origin.module != model.module
        || origin.registry_id != rule.id
        || origin.span != rule.span
        || origin.node.file != rule.span.file
        || origin.node.start != rule.span.start
        || origin.node.end != rule.span.end
        || origin.node.kind != crate::syntax::SyntaxKind::Invariant as u8
        || !invariants.contains(&rule.id)
        || rule.span.file != model.span.file
        || !contains_span(rule.span, rule.pred.span)
        || program
            .invariants
            .iter()
            .filter(|candidate| {
                candidate.id == rule.id
                    && candidate
                        .origin
                        .as_ref()
                        .is_some_and(|value| value.model == model.id)
            })
            .count()
            != 1
        || !program
            .invariants
            .iter()
            .any(|candidate| std::ptr::eq(candidate, rule))
    {
        return None;
    }
    Some((model, origin))
}

fn join_template_presence<'r>(
    program: &IrProgram,
    model: &super::ir::IrItem,
    relation: &'r TypedExpr,
) -> Option<(&'r TypedExpr, SymbolId, SymbolId, &'r TypedExpr, &'r TypedExpr)> {
    let (absent, present) = policy_binary(relation, IrBinOp::Or)?;
    let (presence, null) = policy_binary(absent, IrBinOp::Eq)?;
    if !matches!(null.expr, IrExpr::Null) || null.ty != ResolvedType::Null {
        return None;
    }
    let IrExpr::Member { field, .. } = &presence.expr else {
        return None;
    };
    if field != "current" {
        return None;
    }
    let ResolvedType::Nullable(inner) = &presence.ty else {
        return None;
    };
    let ResolvedType::Record {
        symbol: revision,
        stored: true,
    } = inner.as_ref()
    else {
        return None;
    };
    let revision_model = policy_model(program, *revision)?;
    if revision_model.name != "Revision"
        || revision_model.module != model.module
        || !matches!(revision_model.kind, IrItemKind::Model { owner: IrOwner::ChildOf(parent), .. } if parent == model.id)
    {
        return None;
    }
    let current = policy_field(program, model.id, "current", &presence.ty)?;
    policy_row_member(presence, model.id, "current", &presence.ty)?;
    let (same_parent, published_read) = policy_binary(present, IrBinOp::And)?;
    Some((presence, *revision, current, same_parent, published_read))
}

/// Only these two getters occur in the exact current-present OR arm above.
/// The checker may retain the declared nullable reference or narrow that same
/// reference to its required inner type. Neither form admits another receiver.
fn join_template_current_read(
    model: SymbolId,
    presence: &TypedExpr,
    selected: &TypedExpr,
) -> Option<()> {
    if selected.ty != presence.ty
        && !matches!(&presence.ty, ResolvedType::Nullable(inner) if inner.as_ref() == &selected.ty)
    { return None; }
    policy_row_member(selected, model, "current", &selected.ty)
}

fn join_template_parent(
    program: &IrProgram,
    model: &super::ir::IrItem,
    presence: &TypedExpr,
    same_parent: &TypedExpr,
) -> Option<()> {
    let (parent, owning_row) = policy_binary(same_parent, IrBinOp::Eq)?;
    policy_row(owning_row, model.id)?;
    let IrExpr::Member {
        base: selected,
        field,
    } = &parent.expr
    else {
        return None;
    };
    if field != "parent" || parent.ty != owning_row.ty {
        return None;
    }
    join_template_current_read(model.id, presence, selected)
}

fn join_template_published(
    program: &IrProgram,
    model: &super::ir::IrItem,
    revision: SymbolId,
    presence: &TypedExpr,
    published_read: &TypedExpr,
) -> Option<SymbolId> {
    let published = policy_field(
        program,
        revision,
        "published",
        &ResolvedType::Scalar(Scalar::Bool),
    )?;
    let IrExpr::Member {
        base: selected,
        field,
    } = &published_read.expr
    else {
        return None;
    };
    if field != "published" || published_read.ty != ResolvedType::Scalar(Scalar::Bool) {
        return None;
    }
    join_template_current_read(model.id, presence, selected)?;
    Some(published)
}

fn template_revision_kind(
    program: &IrProgram,
    model: &super::ir::IrItem,
    relation: &TypedExpr,
    duration: SymbolId,
) -> Option<CurrentRevisionRuleKind> {
    let (presence, revision, current, same_parent, published_read) =
        join_template_presence(program, model, relation)?;
    join_template_parent(program, model, presence, same_parent)?;
    let published = join_template_published(program, model, revision, presence, published_read)?;
    Some(CurrentRevisionRuleKind::Template {
        duration,
        current,
        revision,
        published,
    })
}

fn join_revision_unpublished<'r>(
    program: &IrProgram,
    model: &super::ir::IrItem,
    relation: &'r TypedExpr,
) -> Option<(&'r TypedExpr, SymbolId)> {
    let (unpublished, nonnull_digest) = policy_binary(relation, IrBinOp::Or)?;
    let IrExpr::Unary {
        op: IrUnOp::Not,
        operand,
    } = &unpublished.expr
    else {
        return None;
    };
    if unpublished.ty != ResolvedType::Scalar(Scalar::Bool)
        || !contains_span(unpublished.span, operand.span)
    {
        return None;
    }
    let bool_ty = ResolvedType::Scalar(Scalar::Bool);
    let published = policy_field(program, model.id, "published", &bool_ty)?;
    policy_row_member(operand, model.id, "published", &bool_ty)?;
    Some((nonnull_digest, published))
}

fn revision_rule_kind(
    program: &IrProgram,
    model: &super::ir::IrItem,
    relation: &TypedExpr,
    duration: SymbolId,
) -> Option<CurrentRevisionRuleKind> {
    let IrItemKind::Model {
        owner: IrOwner::ChildOf(template),
        ..
    } = &model.kind
    else {
        return None;
    };
    let parent = policy_model(program, *template)?;
    if parent.name != "Template" || parent.module != model.module {
        return None;
    }
    let (nonnull_digest, published) = join_revision_unpublished(program, model, relation)?;
    let (digest_read, null) = policy_binary(nonnull_digest, IrBinOp::Ne)?;
    if !matches!(null.expr, IrExpr::Null) || null.ty != ResolvedType::Null {
        return None;
    }
    let text_ty = ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text)));
    let digest = policy_field(program, model.id, "digest", &text_ty)?;
    policy_row_member(digest_read, model.id, "digest", &text_ty)?;
    Some(CurrentRevisionRuleKind::Revision {
        duration,
        published,
        digest,
    })
}

pub fn current_revision_rule_profile(
    program: &IrProgram,
    rule: &IrRuleFn,
) -> Option<CurrentRevisionRuleProfile> {
    let (model, origin) = check_rule_origin(program, rule)?;
    let (bounds, relation) = policy_binary(&rule.pred, IrBinOp::And)?;
    let duration = original_duration_bounds(program, model.id, bounds)?;
    let kind = match model.name.as_str() {
        "Template" => template_revision_kind(program, model, relation, duration)?,
        "Revision" => revision_rule_kind(program, model, relation, duration)?,
        _ => return None,
    };
    Some(CurrentRevisionRuleProfile {
        origin: origin.clone(),
        kind,
    })
}

/// Exact additional original Chat invariants. This is consumed only after the
/// complete owning source/model/field/rule tables match a fresh checked build.
/// Nullable arithmetic and borrowed catalog enums do not enter the raw local
/// predicate classifier through this helper.
fn turn_role_invariant(
    program: &IrProgram,
    model: &super::ir::IrItem,
    rule: &IrRuleFn,
) -> Option<Vec<SymbolId>> {
    let (read, allowed) = policy_binary(&rule.pred, IrBinOp::In)?;
    if !chat_role_type(&read.ty) {
        return None;
    }
    let role = policy_field(program, model.id, "role", &read.ty)?;
    policy_row_member(read, model.id, "role", &read.ty)?;
    let IrExpr::Array(items) = &allowed.expr else {
        return None;
    };
    if !matches!(&allowed.ty, ResolvedType::Array { element, ordered: true, nonempty: true }
        if element.as_ref() == &read.ty)
        || items.len() != 2
    {
        return None;
    }
    for (item, name) in items.iter().zip(["user", "assistant"]) {
        if item.ty != read.ty
            || !contains_span(allowed.span, item.span)
            || !matches!(&item.expr, IrExpr::Text(value) if value == name)
        {
            return None;
        }
    }
    if items[0].span.end > items[1].span.start {
        return None;
    }
    Some(vec![role])
}

fn run_reservation_invariant(
    program: &IrProgram,
    model: &super::ir::IrItem,
    rule: &IrRuleFn,
) -> Option<Vec<SymbolId>> {
    let (absent, within_reservation) = policy_binary(&rule.pred, IrBinOp::Or)?;
    let (nullable_read, null) = policy_binary(absent, IrBinOp::Eq)?;
    let nullable_int = ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Int)));
    let int = ResolvedType::Scalar(Scalar::Int);
    let used = policy_field(program, model.id, "used", &nullable_int)?;
    let reserved = policy_field(program, model.id, "reserved", &int)?;
    policy_row_member(nullable_read, model.id, "used", &nullable_int)?;
    if null.ty != ResolvedType::Null || !matches!(null.expr, IrExpr::Null) {
        return None;
    }
    let (present_read, limit) = policy_binary(within_reservation, IrBinOp::Le)?;
    // The checker narrows this exact second occurrence only in the
    // false arm of the original owning used==null expression.
    policy_row_member(present_read, model.id, "used", &int)?;
    policy_row_member(limit, model.id, "reserved", &int)?;
    Some(vec![used, reserved])
}

pub(crate) fn checked_chat_invariant_fields(
    program: &IrProgram,
    rule: &IrRuleFn,
) -> Option<Vec<SymbolId>> {
    let (model, _) = check_rule_origin(program, rule)?;
    match model.name.as_str() {
        "Turn" => turn_role_invariant(program, model, rule),
        "Run" => run_reservation_invariant(program, model, rule),
        _ => None,
    }
}

fn chat_role_type(ty: &ResolvedType) -> bool {
    crate::analysis::catalog::nominal_schema("TextMessage")
        .and_then(|schema| schema.fields.iter().find(|(name, _)| *name == "role"))
        .and_then(|(_, declared)| crate::analysis::types::std_schema_type(declared))
        .as_ref()
        == Some(ty)
}

fn contains_span(parent: crate::source::Span, child: crate::source::Span) -> bool {
    parent.file == child.file && parent.start <= child.start && child.end <= parent.end
}

fn policy_model(program: &IrProgram, id: SymbolId) -> Option<&super::ir::IrItem> {
    let model = program.items.get(id.0 as usize)?;
    let module = program.modules.get(model.module.0 as usize)?;
    (model.id == id
        && module.id == model.module
        && model.span.file == module.file
        && contains_span(module.span, model.span)
        && model.canonical == format!("{}.{}", module.name, model.name)
        && matches!(model.kind, IrItemKind::Model { .. }))
    .then_some(model)
}

fn policy_field(
    program: &IrProgram,
    model: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> Option<SymbolId> {
    policy_field_with_flags(program, model, name, ty, false, false)
}

fn policy_field_with_flags(
    program: &IrProgram,
    model: SymbolId,
    name: &str,
    ty: &ResolvedType,
    allow_required_array: bool,
    allow_server: bool,
) -> Option<SymbolId> {
    let owner = policy_model(program, model)?;
    let IrItemKind::Model { fields, .. } = &owner.kind else {
        return None;
    };
    let mut matching = fields.iter().filter_map(|id| {
        program
            .items
            .get(id.0 as usize)
            .filter(|field| field.id == *id && field.name == name)
    });
    let field = matching.next()?;
    let module = program.modules.get(owner.module.0 as usize)?;
    if matching.next().is_some()
        || field.module != owner.module
        || field.span.file != module.file
        || !contains_span(module.span, field.span)
        || field.canonical != format!("{}.{}", owner.canonical, name)
        || !matches!(&field.kind, IrItemKind::Field { owner: own, ty: IrType::Known(actual), required_array,
            server, modifiers, .. } if *own == model && actual == ty && !modifiers.machine
                && (server.is_none() || allow_server)
                && (!*required_array || allow_required_array && matches!(actual, ResolvedType::Array { .. })))
    {
        return None;
    }
    Some(field.id)
}

fn policy_row(expr: &TypedExpr, model: SymbolId) -> Option<()> {
    (matches!(&expr.expr, IrExpr::Name(name) if name == "row")
        && expr.ty
            == (ResolvedType::Record {
                symbol: model,
                stored: true,
            }))
    .then_some(())
}

fn policy_row_member(
    expr: &TypedExpr,
    model: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> Option<()> {
    let IrExpr::Member { base, field } = &expr.expr else {
        return None;
    };
    if field != name || &expr.ty != ty || !contains_span(expr.span, base.span) {
        return None;
    }
    policy_row(base, model)
}

fn policy_binary(expr: &TypedExpr, expected: IrBinOp) -> Option<(&TypedExpr, &TypedExpr)> {
    let IrExpr::Binary { op, left, right } = &expr.expr else {
        return None;
    };
    (*op == expected
        && expr.ty == ResolvedType::Scalar(Scalar::Bool)
        && contains_span(expr.span, left.span)
        && contains_span(expr.span, right.span)
        && left.span.end <= right.span.start)
        .then_some((left, right))
}

fn original_duration_bounds(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
) -> Option<SymbolId> {
    let (lower, upper) = policy_binary(expr, IrBinOp::And)?;
    let ty = ResolvedType::Scalar(Scalar::Duration);
    let field = policy_field(program, model, "duration", &ty)?;
    for (expression, op, millis) in [(lower, IrBinOp::Ge, 1_000), (upper, IrBinOp::Le, 900_000)] {
        let (read, literal) = policy_binary(expression, op)?;
        policy_row_member(read, model, "duration", &ty)?;
        if literal.ty != ty || !matches!(literal.expr, IrExpr::DurationMs(value) if value == millis)
        {
            return None;
        }
    }
    Some(field)
}

fn local_type(program: &IrProgram, model: SymbolId, ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool) => true,
        ResolvedType::Enum { cases, owner: Some(owner) } => {
            !cases.is_empty() && program.items.get(owner.0 as usize).is_some_and(|field| {
                field.id == *owner && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(field_type), .. } if *owner == model && field_type == ty)
            })
        }
        ResolvedType::Array { element, .. } => local_type(program, model, element),
        _ => false,
    }
}

/// The first native stored-field profile also bounds protected lock targets.
pub(crate) fn local_stored_field_type(
    program: &IrProgram,
    model: SymbolId,
    ty: &ResolvedType,
) -> bool {
    // A lock compares the singular owning stored value. Duration does not
    // enter the generic rule arithmetic/container profile through this path.
    if matches!(ty, ResolvedType::Scalar(Scalar::User | Scalar::Duration)) {
        return true;
    }
    matches!(
        ty,
        ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool) | ResolvedType::Enum { .. }
    ) && local_type(program, model, ty)
}

/// Required nominal lock targets use their owning declarations only after the
/// caller seals the complete source/fresh Model, Contract and Field tables.
/// This classifier supplies neither a wire comparator nor native activation.
pub(crate) fn checked_required_record_lock_target(
    program: &IrProgram,
    model: SymbolId,
    field: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> bool {
    if policy_field(program, model, name, ty) != Some(field) {
        return false;
    }
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = ty.nullable_inner().unwrap_or(ty)
    else {
        return false;
    };
    let Some(target) = program.items.get(symbol.0 as usize) else {
        return false;
    };
    let Some(module) = program.modules.get(target.module.0 as usize) else {
        return false;
    };
    target.id == *symbol
        && module.id == target.module
        && target.span.file == module.file
        && contains_span(module.span, target.span)
        && target.canonical == format!("{}.{}", module.name, target.name)
        && matches!(
            target.kind,
            IrItemKind::Model { .. } | IrItemKind::Contract { .. }
        )
}

/// Source-sealed stored lock values use State's existing schema-aware comparator.
/// Model and File leaves compare canonical reference identity. Classification
/// grants neither ordinary expression equality nor observation/byte authority.
pub(crate) fn checked_stored_lock_target(
    program: &IrProgram,
    model: SymbolId,
    field: SymbolId,
    name: &str,
    ty: &ResolvedType,
) -> bool {
    let base = ty.nullable_inner().unwrap_or(ty);
    if matches!(base, ResolvedType::StdDelivery { .. }) {
        // Lock only the canonical persisted opaque delivery wire. This path
        // neither observes its status nor creates a delivery association.
        // The caller seals the owning field/capability against fresh source.
        return policy_field_with_flags(program, model, name, ty, false, true) == Some(field);
    }
    if matches!(base, ResolvedType::Scalar(Scalar::File)) {
        return policy_field_with_flags(program, model, name, ty, false, true) == Some(field);
    }
    if matches!(base, ResolvedType::Scalar(scalar) if *scalar != Scalar::File)
        && (super::js::checked_value_profile(ty).is_some()
            || matches!(base, ResolvedType::Scalar(Scalar::Timezone)))
    {
        // A server-populated scalar is still the exact persisted owning field;
        // this never evaluates its default/server expression or changes writes.
        return policy_field_with_flags(program, model, name, ty, false, true) == Some(field);
    }
    // A field may reuse another declaration's enum. The complete source join
    // seals that nominal owner; compare this exact owning field's stored value.
    if matches!(base, ResolvedType::Enum { cases, .. } if !cases.is_empty()) {
        return policy_field_with_flags(program, model, name, ty, false, true) == Some(field);
    }
    if let ResolvedType::Array { element, .. } = base
        && let ResolvedType::Record { symbol, stored: true } = element.as_ref()
        && policy_model(program, *symbol).is_some()
    {
        // State's existing typed reference-array comparator owns identity;
        // the complete source join seals the field and its target model.
        return policy_field_with_flags(program, model, name, ty, true, true) == Some(field);
    }
    // Canonical stored values use State's schema-aware lock comparator.
    // Files remain opaque identity leaves; this grants no byte read, ordinary
    // expression equality, scalar result or disclosure/observation capability.
    fn lock_value(program: &IrProgram, ty: &ResolvedType, depth: usize) -> bool {
        if depth > 16 { return false; }
        match ty {
            ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => lock_value(program, inner, depth + 1),
            ResolvedType::Scalar(scalar) => *scalar == Scalar::File ||
                super::js::checked_value_profile(ty).is_some() || *scalar == Scalar::Timezone,
            ResolvedType::Enum { cases, .. } => !cases.is_empty(),
            ResolvedType::StdNominal { fields, .. } =>
                crate::analysis::types::checked_standard_nominal_name(ty).is_some()
                    && fields.iter().all(|(_, value)| lock_value(program, value, depth + 1)),
            ResolvedType::Record { symbol, stored: true } => program.items.get(symbol.0 as usize).is_some_and(|item| {
                item.id == *symbol && match &item.kind {
                    IrItemKind::Contract { fields, .. } => fields.iter().all(|id| program.items.get(id.0 as usize).is_some_and(|field| {
                        field.id == *id && matches!(&field.kind, IrItemKind::Field { owner, ty: IrType::Known(value), .. }
                            if *owner == *symbol && lock_value(program, value, depth + 1))
                    })),
                    _ => false,
                }
            }),
            _ => false,
        }
    }
    let element = match base { ResolvedType::Array { element, .. } => element.as_ref(), value => value };
    if (matches!(base, ResolvedType::Array { .. } | ResolvedType::StdNominal { .. }) || matches!(element, ResolvedType::Record { symbol, stored: true }
        if program.items.get(symbol.0 as usize).is_some_and(|item| matches!(item.kind, IrItemKind::Contract { .. }))))
        && lock_value(program, ty, 0)
    {
        return policy_field_with_flags(program, model, name, ty, true, true) == Some(field);
    }
    checked_required_record_lock_target(program, model, field, name, ty)
}

/// Direct owning Date operands use the checked declaration/occurrence types.
/// The existing emitter retains nullable comparison and lazy guard semantics.
fn date_operand(
    program: &IrProgram,
    model: SymbolId,
    value: &TypedExpr,
    fields: &mut Vec<SymbolId>,
) -> Option<()> {
    let date = ResolvedType::Scalar(Scalar::Date);
    if matches!(value.expr, IrExpr::Date(_)) && value.ty == date {
        return Some(());
    }
    let IrExpr::Member { field, .. } = &value.expr else {
        return None;
    };
    policy_row_member(value, model, field, &value.ty)?;
    let nullable = ResolvedType::Nullable(Box::new(date.clone()));
    let id = if value.ty == date {
        policy_field(program, model, field, &date)
            .or_else(|| policy_field(program, model, field, &nullable))?
    } else if value.ty == nullable {
        policy_field(program, model, field, &nullable)?
    } else {
        return None;
    };
    if !fields.contains(&id) {
        fields.push(id);
    }
    Some(())
}

fn visit_null_comparison(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
    duration_operand: bool,
) -> Option<bool> {
    // Presence of an owning nullable audit field needs no dereference or
    // additional owner dependency. Keep this distinct from scalar equality,
    // nullable arithmetic and navigation through a user/reference value.
    let IrExpr::Binary {
        op: IrBinOp::Eq | IrBinOp::Ne,
        left,
        right,
    } = &expr.expr else {
        return Some(false);
    };
    if !(matches!(left.expr, IrExpr::Null) || matches!(right.expr, IrExpr::Null)) {
        return Some(false);
    }
    if duration_operand || expr.ty != ResolvedType::Scalar(Scalar::Bool) {
        return None;
    }
    let (read, null) = if matches!(left.expr, IrExpr::Null) {
        (right, left)
    } else {
        (left, right)
    };
    if null.ty != ResolvedType::Null
        || !matches!(&read.ty, ResolvedType::Nullable(inner)
            if matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::User | Scalar::Datetime | Scalar::Date)))
    {
        return None;
    }
    let IrExpr::Member { field, .. } = &read.expr else {
        return None;
    };
    let id = policy_field(program, model, field, &read.ty)?;
    policy_row_member(read, model, field, &read.ty)?;
    if !fields.contains(&id) {
        fields.push(id);
    }
    Some(true)
}
fn visit_date_comparison(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
) -> Option<bool> {
    let IrExpr::Binary { op, left, right } = &expr.expr else {
        return Some(false);
    };
    let date = |ty: &ResolvedType| {
        matches!(ty, ResolvedType::Scalar(Scalar::Date))
            || matches!(ty, ResolvedType::Nullable(inner) if inner.as_ref() == &ResolvedType::Scalar(Scalar::Date))
    };
    if !date(&left.ty) && !date(&right.ty) {
        return Some(false);
    }
    if expr.ty != ResolvedType::Scalar(Scalar::Bool)
        || !matches!(
            op,
            IrBinOp::Eq
                | IrBinOp::Ne
                | IrBinOp::Lt
                | IrBinOp::Le
                | IrBinOp::Gt
                | IrBinOp::Ge
        )
    {
        return None;
    }
    date_operand(program, model, left, fields)?;
    date_operand(program, model, right, fields)?;
    Some(true)
}
fn resolve_row_field(
    program: &IrProgram,
    model: SymbolId,
    base: &TypedExpr,
    field: &str,
    ty: &ResolvedType,
    duration_operand: bool,
) -> Option<SymbolId> {
    if !matches!(&base.expr, IrExpr::Name(name) if name == "row")
        || base.ty
            != (ResolvedType::Record {
                symbol: model,
                stored: true,
            })
    {
        return None;
    }
    let IrItemKind::Model {
        fields: declared, ..
    } = &program.items.get(model.0 as usize)?.kind
    else {
        return None;
    };
    let mut matching = declared.iter().filter_map(|id| {
        program
            .items
            .get(id.0 as usize)
            .filter(|item| item.id == *id && item.name == *field)
    });
    let item = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    let IrItemKind::Field {
        owner,
        ty: IrType::Known(known),
        ..
    } = &item.kind
    else {
        return None;
    };
    if *owner != model
        || *known != *ty
        || !(matches!(
            known,
            ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)
                | ResolvedType::Enum { .. }
        ) || duration_operand && known == &ResolvedType::Scalar(Scalar::Duration))
    {
        return None;
    }
    Some(item.id)
}
fn visit_row_member(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
    duration_operand: bool,
) -> Option<bool> {
    let IrExpr::Member { base, field } = &expr.expr else {
        return Some(false);
    };
    let id = resolve_row_field(program, model, base, field, &expr.ty, duration_operand)?;
    if !fields.contains(&id) {
        fields.push(id);
    }
    Some(true)
}
fn visit_duration_binary(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
) -> Option<bool> {
    let IrExpr::Binary { op, left, right } = &expr.expr else {
        return Some(false);
    };
    if left.ty != ResolvedType::Scalar(Scalar::Duration)
        && right.ty != ResolvedType::Scalar(Scalar::Duration)
    {
        return Some(false);
    }
    if expr.ty != ResolvedType::Scalar(Scalar::Bool)
        || !matches!(op, IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge)
        || !matches!(
            (&left.expr, &right.expr),
            (IrExpr::Member { .. }, IrExpr::DurationMs(_))
                | (IrExpr::DurationMs(_), IrExpr::Member { .. })
        )
    {
        return None;
    }
    visit(program, model, left, fields, true)?;
    visit(program, model, right, fields, true).map(|_| true)
}
fn visit_plain_expr(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
    duration_operand: bool,
) -> Option<bool> {
    match &expr.expr {
        IrExpr::DurationMs(_) if duration_operand => Some(true),
        IrExpr::Int(_) if expr.ty == ResolvedType::Scalar(Scalar::Int) => Some(true),
        IrExpr::Bool(_) if expr.ty == ResolvedType::Scalar(Scalar::Bool) => Some(true),
        IrExpr::Text(value) => match &expr.ty {
            ResolvedType::Scalar(Scalar::Text) => Some(true),
            ResolvedType::Enum { cases, .. } if cases.contains(value) => Some(true),
            _ => None,
        },
        IrExpr::Name(value) => match &expr.ty {
            ResolvedType::Enum { cases, .. } if cases.contains(value) => Some(true),
            _ => None,
        },
        IrExpr::Binary { left, right, .. } => {
            visit(program, model, left, fields, false)?;
            visit(program, model, right, fields, false).map(|_| true)
        }
        IrExpr::Unary { operand, .. } => visit(program, model, operand, fields, false).map(|_| true),
        IrExpr::Array(items) => {
            for item in items {
                visit(program, model, item, fields, false)?;
            }
            Some(true)
        }
        _ => Some(false),
    }
}
fn visit(
    program: &IrProgram,
    model: SymbolId,
    expr: &TypedExpr,
    fields: &mut Vec<SymbolId>,
    duration_operand: bool,
) -> Option<()> {
    // Presence of an owning nullable audit field needs no dereference or
    if visit_null_comparison(program, model, expr, fields, duration_operand)? {
        return Some(());
    }
    if visit_date_comparison(program, model, expr, fields)? {
        return Some(());
    }
    if duration_operand {
        if expr.ty != ResolvedType::Scalar(Scalar::Duration)
            || !matches!(expr.expr, IrExpr::Member { .. } | IrExpr::DurationMs(_))
        {
            return None;
        }
    } else if !local_type(program, model, &expr.ty) {
        return None;
    }
    if visit_row_member(program, model, expr, fields, duration_operand)? {
        return Some(());
    }
    if visit_duration_binary(program, model, expr, fields)? {
        return Some(());
    }
    if visit_plain_expr(program, model, expr, fields, duration_operand)? {
        return Some(());
    }
    None
}

fn argument(db: &crate::source::SourceDb, key: NodeKey, value: &TypedExpr) -> Option<()> {
    let (tree, diagnostics) = crate::syntax::parse_source(key.file, &db.get(key.file)?.text);
    if !diagnostics.is_empty() {
        return None;
    }
    let mut node = tree.descendants().find(|node| NodeKey::of(node) == key)?;
    for _ in 0..65 {
        if node.kind != crate::syntax::SyntaxKind::Group {
            return (node.span == value.span).then_some(());
        }
        node = node.children.iter().find(|child| {
            child.token().is_none()
                && !matches!(
                    child.kind,
                    crate::syntax::SyntaxKind::Trivia | crate::syntax::SyntaxKind::Comment
                )
        })?;
    }
    None
}
fn checked_rule_call<'a>(
    checked: &crate::analysis::CheckedProgram,
    value: &'a TypedExpr,
    id: &str,
    arity: usize,
    db: &crate::source::SourceDb,
    catalog: Option<&crate::analysis::catalog::Catalog>,
) -> Option<Vec<&'a TypedExpr>> {
    let (target, args, slots) = match &value.expr {
        IrExpr::Call { target, args } => {
            (target, args, (0..args.len()).map(Some).collect::<Vec<_>>())
        }
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args, slots.clone()),
        _ => return None,
    };
    if !matches!(target, IrCallTarget::Builtin { id: actual, awaited: false } if actual == id) {
        return None;
    }
    let key = NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: crate::syntax::SyntaxKind::Call as u8,
    };
    let selected = checked.types.selected_calls.get(&key)?;
    if !matches!(&selected.target, SelectedCallTarget::Builtin { id: actual, overload: 0 } if actual == id)
        || selected.arguments.len() != arity
        || args.len() != arity
        || selected.slots != slots
        || slots.len() != arity
        || checked.types.node_types.get(&key) != Some(&value.ty)
    {
        return None;
    }
    let catalog = catalog?;
    if catalog.lookup(id)?.effects != Some(crate::analysis::catalog::Effects::Pure)
        || catalog.overloads(id)?.first()?.params.len() != arity
    {
        return None;
    }
    for (key, arg) in selected.arguments.iter().zip(args) {
        argument(db, *key, arg)?;
    }
    let mut used = HashSet::new();
    slots
        .iter()
        .map(|slot| {
            let index = (*slot)?;
            if !used.insert(index) {
                return None;
            }
            args.get(index)
        })
        .collect()
}

/// Source-sealed Model query rules retain their original callbacks. The model
/// census is also the complete invalidation domain: a root filter may fail on
/// an unrelated candidate before deciding whether it matches the owning row.
#[derive(Debug, Clone)]
pub(crate) struct CheckedQueryRuleProfile {
    pub fields: Vec<SymbolId>,
    pub query_models: Vec<SymbolId>,
    pub dependencies: Vec<SymbolId>,
}

pub(crate) fn checked_query_rule_fields(
    checked: &crate::analysis::CheckedProgram,
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
    db: &crate::source::SourceDb,
    catalog: Option<&crate::analysis::catalog::Catalog>,
) -> Option<CheckedQueryRuleProfile> {
    if checked_local_rule_fields(checked, program, model, predicate, db, catalog).is_some()
        || required_model_rule_fields(program, model, predicate).is_some() {
        return None;
    }
    // The caller seals this entire policy closure against freshly lowered source,
    // including every derived body. This walker admits a finite pure expression
    // grammar and records all stored reads, including transitive derived reads.
    struct Rule<'a> {
        checked: &'a crate::analysis::CheckedProgram,
        program: &'a IrProgram,
        db: &'a crate::source::SourceDb,
        catalog: Option<&'a crate::analysis::catalog::Catalog>,
        profile: CheckedQueryRuleProfile,
        owner: SymbolId,
        bindings: Vec<(String, ResolvedType)>,
        derives: HashSet<SymbolId>,
        remaining: usize,
    }
    impl Rule<'_> {
        fn dependency(&mut self, model: SymbolId) {
            if !self.profile.dependencies.contains(&model) {
                self.profile.dependencies.push(model);
            }
        }
        fn leaf(ty: &ResolvedType) -> bool {
            match ty {
                ResolvedType::Scalar(_) | ResolvedType::Enum { .. }
                | ResolvedType::Record { stored: true, .. } | ResolvedType::Null => true,
                ResolvedType::Nullable(inner) => Self::leaf(inner),
                ResolvedType::Array { element, .. } => Self::leaf(element),
                ResolvedType::Object(fields) => fields.len()<=200 && fields.iter().all(|(_,ty)|Self::leaf(ty)),
                _ => false,
            }
        }
        fn contract(&self, symbol: SymbolId) -> Option<&super::ir::IrItem> {
            let item = self.program.items.get(symbol.0 as usize)?;
            let module = self.program.modules.get(item.module.0 as usize)?;
            (item.id == symbol && module.id == item.module
                && item.span.file == module.file && contains_span(module.span, item.span)
                && item.canonical == format!("{}.{}", module.name, item.name)
                && matches!(item.kind, IrItemKind::Contract { .. })).then_some(item)
        }
        /// Resolve a Contract value member entirely within its sealed owning
        /// declaration; it never creates stored row dependencies or identities.
        fn contract_member(&self, contract: &super::ir::IrItem, field: &str, ty: &ResolvedType) -> Option<()> {
            let IrItemKind::Contract { fields, .. } = &contract.kind else { return None; };
            let mut matching = fields.iter().filter_map(|id| self.program.items.get(id.0 as usize)
                .filter(|item| item.id == *id && item.name == field));
            let item = matching.next()?;
            if matching.next().is_some() || item.module != contract.module
                || item.span.file != contract.span.file
                || item.canonical != format!("{}.{}", contract.canonical, field)
                || !matches!(&item.kind, IrItemKind::Field { owner, ty: IrType::Known(actual), server: None, modifiers, .. }
                    if *owner == contract.id && !modifiers.machine
                        && (actual == ty || actual.nullable_inner() == Some(ty))) { return None; }
            Some(())
        }
        /// A bare model name has no authored query clause/alias carrier. Its
        /// checked node type and non-lexical resolved source retain the exact model.
        fn bare_model_symbol(&self, value: &TypedExpr, canonical: &str) -> Option<SymbolId> {
            let ResolvedType::Array { element, ordered: true, nonempty: false } = &value.ty else { return None; };
            let ResolvedType::Record { symbol, stored: true } = element.as_ref() else { return None; };
            let model = policy_model(self.program, *symbol)?;
            let key = NodeKey { file: value.span.file, start: value.span.start, end: value.span.end,
                kind: crate::syntax::SyntaxKind::NameRef as u8 };
            (model.canonical == canonical
                && self.checked.types.node_types.get(&key) == Some(&value.ty)
                && self.checked.types.bound_names.contains(&key)
                && !self.checked.types.lexical_value_references.contains(&key)
                && !self.checked.types.contextual_references.contains_key(&key)).then_some(*symbol)
        }
        /// Only a checked count call can supply this clause-free global root.
        /// The existing owner query path still owns completeness and authority.
        fn bare_model_count(&mut self, value: &TypedExpr, depth: usize) -> Option<()> {
            if depth > 64 || self.remaining == 0 { return None; }
            let IrExpr::Query(query) = &value.expr else { return None; };
            let super::ir::IrQueryDomain::Model(canonical) = &query.domain else { return None; };
            if query.source.is_some() || query.parent.is_some() || query.where_pred.is_some()
                || query.where_async || !query.order.is_empty() || query.value_order.is_some()
                || query.limit.is_some() || query.archived.is_some() || query.select.is_some()
                || query.select_param.is_some() || query.collection_call.is_some()
                || query.contract_collection_call.is_some() { return None; }
            let model = self.bare_model_symbol(value, canonical)?;
            self.remaining -= 1;
            if !self.profile.query_models.contains(&model) { self.profile.query_models.push(model); }
            self.dependency(model);
            Some(())
        }
        /// Check the selected pure builtin, exact authored arguments and slot
        /// order separately from the expression grammar that consumes them.
        fn call_arguments<'b>(&self, value: &TypedExpr, id: &str, args: &'b [TypedExpr]) -> Option<Vec<&'b TypedExpr>> {
            let key = NodeKey { file: value.span.file, start: value.span.start, end: value.span.end, kind: crate::syntax::SyntaxKind::Call as u8 };
            let selected = self.checked.types.selected_calls.get(&key)?;
            let SelectedCallTarget::Builtin { id: actual, overload } = &selected.target else { return None; };
            let slots = match &value.expr { IrExpr::BoundCall { slots, .. } => slots.clone(), _ => (0..args.len()).map(Some).collect() };
            let catalog = self.catalog?;
            if actual != id || selected.arguments.len() != args.len() || selected.slots != slots
                || catalog.lookup(id)?.effects != Some(crate::analysis::catalog::Effects::Pure)
                || catalog.overloads(id)?.get(*overload as usize)?.params.len() != args.len()
                || self.checked.types.node_types.get(&key) != Some(&value.ty) { return None; }
            for (key, arg) in selected.arguments.iter().zip(args) { argument(self.db, *key, arg)?; }
            let mut used = HashSet::new();
            slots.iter().map(|slot| { let index = (*slot)?; used.insert(index).then(|| args.get(index)).flatten() }).collect()
        }
        fn leaf_expr(value: &TypedExpr) -> bool {
            matches!(
                &value.expr,
                IrExpr::Int(_)
                    | IrExpr::Decimal(_)
                    | IrExpr::Text(_)
                    | IrExpr::Bool(_)
                    | IrExpr::Null
                    | IrExpr::Money { .. }
                    | IrExpr::DurationMs(_)
                    | IrExpr::Date(_)
                    | IrExpr::Datetime(_)
            )
        }
        fn visit_array(&mut self, value: &TypedExpr, depth: usize) -> Option<bool> {
            let IrExpr::Array(values) = &value.expr else {
                return Some(false);
            };
            let ResolvedType::Array { element, .. } = &value.ty else {
                return None;
            };
            let key = NodeKey { file: value.span.file, start: value.span.start, end: value.span.end,
                kind: crate::syntax::SyntaxKind::Array as u8 };
            if self.checked.types.node_types.get(&key) != Some(&value.ty) {
                return None;
            }
            for item in values {
                if &item.ty != element.as_ref() {
                    return None;
                }
                self.expr(item, depth + 1)?;
            }
            Some(true)
        }
        fn visit_now_member(&mut self, value: &TypedExpr) -> Option<bool> {
            let IrExpr::Member { base, field } = &value.expr else {
                return Some(false);
            };
            if field != "now"
                || !matches!(&base.expr, IrExpr::Name(name) if name == "c")
                || base.ty != ResolvedType::Unknown
                || base.span != value.span
                || value.ty != ResolvedType::Scalar(Scalar::Datetime)
            {
                return Some(false);
            }
            let key = NodeKey { file: value.span.file, start: value.span.start, end: value.span.end,
                kind: crate::syntax::SyntaxKind::NameRef as u8 };
            (self.checked.types.node_types.get(&key) == Some(&value.ty)
                && matches!(self.checked.types.contextual_references.get(&key),
                    Some(crate::analysis::resolve::ContextVar::Now))).then_some(true)
        }
        fn visit_name(&mut self, value: &TypedExpr) -> Option<bool> {
            let IrExpr::Name(name) = &value.expr else {
                return Some(false);
            };
            if matches!(&value.ty, ResolvedType::Enum { cases, .. } if cases.contains(name)) {
                return Some(true);
            }
            let ty = &self.bindings.iter().rev().find(|(bound, _)| bound == name)?.1;
            (value.ty == *ty).then_some(true)
        }
        fn visit_special_member(
            &mut self,
            symbol: &SymbolId,
            field: &str,
            value: &TypedExpr,
            source: &super::ir::IrItem,
        ) -> Option<bool> {
            policy_model(self.program, *symbol)?;
            if *symbol != self.owner || self.profile.query_models.contains(symbol) {
                self.dependency(*symbol);
            }
            if field == "id" {
                return (value.ty == ResolvedType::Scalar(Scalar::Text)).then_some(true);
            }
            if field == "parent" {
                let IrItemKind::Model { owner: IrOwner::ChildOf(parent), .. } = source.kind else {
                    return None;
                };
                policy_model(self.program, parent)?;
                return (value.ty == ResolvedType::Record { symbol: parent, stored: true })
                    .then_some(true);
            }
            Some(false)
        }
        fn visit_field_member(
            &mut self,
            symbol: &SymbolId,
            field: &str,
            value: &TypedExpr,
            depth: usize,
        ) -> Option<bool> {
            let mut matching = self.program.items.iter().filter(|item| item.name == *field &&
                matches!(&item.kind, IrItemKind::Field { owner, .. } if owner == symbol)
                || item.name == *field && matches!(&item.kind, IrItemKind::DeriveField { model, .. } if model == symbol));
            let item = matching.next()?;
            if matching.next().is_some() {
                return None;
            }
            match &item.kind {
                IrItemKind::Field { ty: IrType::Known(ty), .. } => {
                    if ty != &value.ty && ty.nullable_inner() != Some(&value.ty) {
                        return None;
                    }
                    policy_field_with_flags(self.program, *symbol, field, ty, true, true)?;
                    if !self.profile.fields.contains(&item.id) {
                        self.profile.fields.push(item.id);
                    }
                    Some(true)
                }
                IrItemKind::DeriveField { ty: IrType::Known(ty), expr: Some(body), .. }
                    if ty == &value.ty && body.ty == *ty && self.derives.insert(item.id) =>
                {
                    let previous = std::mem::replace(&mut self.bindings, vec![("row".into(), ResolvedType::Record { symbol: *symbol, stored: true })]);
                    let result = self.expr(body, depth + 1);
                    self.bindings = previous;
                    self.derives.remove(&item.id);
                    result.map(|_| true)
                }
                _ => None,
            }
        }
        fn visit_record_member(
            &mut self,
            symbol: &SymbolId,
            field: &str,
            value: &TypedExpr,
            depth: usize,
        ) -> Option<bool> {
            if let Some(contract) = self.contract(*symbol) {
                // Value members belong to the source-sealed Contract,
                // not a stored row dependency or a model identity.
                self.contract_member(contract, field, &value.ty)?;
                return Some(true);
            }
            let source = policy_model(self.program, *symbol)?;
            if self.visit_special_member(symbol, field, value, source)? {
                return Some(true);
            }
            self.visit_field_member(symbol, field, value, depth)
        }
        fn visit_member(
            &mut self,
            base: &TypedExpr,
            field: &str,
            value: &TypedExpr,
            depth: usize,
        ) -> Option<bool> {
            if self.visit_now_member(value)? {
                return Some(true);
            }
            if !contains_span(value.span, base.span) {
                return None;
            }
            self.expr(base, depth + 1)?;
            let ty = base.ty.nullable_inner().unwrap_or(&base.ty);
            match ty {
                ResolvedType::Record { symbol, stored: true } => {
                    self.visit_record_member(symbol, field, value, depth)
                }
                ResolvedType::Scalar(Scalar::Money) => match (field, &value.ty) {
                    ("currency", ResolvedType::Scalar(Scalar::Currency)) | ("minor", ResolvedType::Scalar(Scalar::Int)) => Some(true),
                    _ => None,
                },
                _ => None,
            }
        }
        fn value_domain_mismatch(query: &IrQuery, value: &TypedExpr, base: &TypedExpr) -> bool {
            let Some(source) = query.source.as_deref() else {
                return true;
            };
            query.parent.is_some()
                || query.where_pred.is_some()
                || query.where_async
                || !query.order.is_empty()
                || query.value_order.is_some()
                || query.limit.is_some()
                || query.archived.is_some()
                || query.select.is_some() != query.select_param.is_some()
                || query.contract_collection_call.is_some()
                || source.domain_type != base.ty
                || source.result != value.ty
                || query.select.is_none() && base.ty != value.ty
        }
        fn visit_value_domain_query(
            &mut self,
            query: &IrQuery,
            value: &TypedExpr,
            depth: usize,
        ) -> Option<()> {
            let super::ir::IrQueryDomain::Value { base, alias } = &query.domain else {
                return None;
            };
            let source = query.source.as_deref()?;
            let ResolvedType::Array { element, .. } = &base.ty else {
                return None;
            };
            match element.as_ref() {
                ResolvedType::Scalar(Scalar::Int) => {},
                ResolvedType::Record { symbol, stored: true } => {
                    if self.contract(*symbol).is_none() {
                        policy_model(self.program, *symbol)?;
                    }
                }
                _ => return None,
            }
            if self.checked.types.checked_queries.get(&source.node) != Some(source)
                || Self::value_domain_mismatch(query, value, base)
                || !matches!(source.clauses.first().map(|clause|&clause.kind),
                    Some(crate::analysis::types::CheckedQueryClauseKind::As {name}) if name == alias)
                || match (&query.select,&query.select_param,source.clauses.as_slice()) {
                    (None,None,[_]) => false,
                    (Some(body),Some(param),[_,selection]) => param != alias
                        || selection.kind != crate::analysis::types::CheckedQueryClauseKind::Select
                        || selection.expressions.len()!=1
                        || !contains_span(crate::source::Span::new(selection.node.file,selection.node.start,selection.node.end),body.span)
                        || self.checked.types.node_types.get(&selection.expressions[0]) != Some(&body.ty),
                    _ => true,
                }
            {
                return None;
            }
            if let Some(call) = &query.collection_call {
                if self.checked.types.checked_collection_calls.get(&call.node) != Some(call.as_ref())
                    || call.query != source.node
                    || !matches!(element.as_ref(), ResolvedType::Record { symbol, stored: true } if *symbol == call.model)
                {
                    return None;
                }
            }
            self.expr(base, depth + 1)?;
            if let (Some(body),Some(param)) = (&query.select,&query.select_param) {
                self.bindings.push((param.clone(),element.as_ref().clone()));
                self.expr(body,depth+1)?;
                self.bindings.pop()?;
            }
            Some(())
        }
        fn join_model_candidate(
            &mut self,
            query: &IrQuery,
            canonical: &str,
        ) -> Option<SymbolId> {
            let mut matches = self.program.items.iter().filter(|item| item.canonical == *canonical && matches!(item.kind, IrItemKind::Model { .. }));
            let candidate = matches.next()?;
            if matches.next().is_some() {
                return None;
            }
            policy_model(self.program, candidate.id)?;
            if let Some(parent) = &query.parent {
                self.expr(parent, 1)?;
                let ResolvedType::Record { symbol, stored: true } = parent.ty else {
                    return None;
                };
                if !matches!(candidate.kind, IrItemKind::Model { owner: IrOwner::ChildOf(actual), .. } if actual == symbol) {
                    return None;
                }
            }
            Some(candidate.id)
        }
        fn record_model_query_parts(
            &mut self,
            query: &IrQuery,
            candidate: SymbolId,
            depth: usize,
        ) -> Option<()> {
            if !self.profile.query_models.contains(&candidate) {
                self.profile.query_models.push(candidate);
            }
            self.dependency(candidate);
            if let Some(filter) = &query.where_pred {
                self.bindings.push((query.where_param.clone(), ResolvedType::Record { symbol: candidate, stored: true }));
                self.expr(filter, depth + 1)?;
                self.bindings.pop()?;
            }
            match (&query.select, &query.select_param) {
                (Some(body), Some(param)) => {
                    self.bindings.push((param.clone(), ResolvedType::Record { symbol: candidate, stored: true }));
                    self.expr(body, depth + 1)?;
                    self.bindings.pop()?;
                }
                (None, None) => {},
                _ => return None,
            }
            Some(())
        }
        fn visit_model_domain_query(
            &mut self,
            query: &IrQuery,
            value: &TypedExpr,
            depth: usize,
        ) -> Option<()> {
            if !query.order.is_empty() || query.value_order.is_some() || query.limit.is_some()
                || query.archived.is_some() || query.contract_collection_call.is_some()
            {
                return None;
            }
            let super::ir::IrQueryDomain::Model(canonical) = &query.domain else {
                return None;
            };
            let candidate = self.join_model_candidate(query, canonical)?;
            if let Some(source) = &query.source {
                if self.checked.types.checked_queries.get(&source.node) != Some(source.as_ref()) || source.result != value.ty {
                    return None;
                }
            } else if query.parent.is_none() || query.where_pred.is_some() || query.select.is_some() || query.collection_call.is_some() {
                return None;
            }
            if let Some(call) = &query.collection_call {
                if !self.checked.types.checked_collection_calls.values().any(|fact| fact == call.as_ref()) {
                    return None;
                }
            }
            self.record_model_query_parts(query, candidate, depth)
        }
        fn visit_query(&mut self, query: &IrQuery, value: &TypedExpr, depth: usize) -> Option<bool> {
            if matches!(&query.domain, super::ir::IrQueryDomain::Value { .. }) {
                self.visit_value_domain_query(query, value, depth)?;
                Some(true)
            } else {
                self.visit_model_domain_query(query, value, depth)?;
                Some(true)
            }
        }
        fn resolve_any_domain(&self, query: &IrQuery) -> Option<ResolvedType> {
            match &query.domain {
                super::ir::IrQueryDomain::Model(canonical) => Some(ResolvedType::Record {
                    symbol: self.program.items.iter().find(|item| item.canonical == *canonical)?.id,
                    stored: true,
                }),
                super::ir::IrQueryDomain::Value { base, .. } => {
                    let ResolvedType::Array { element, .. } = &base.ty else {
                        return None;
                    };
                    Some(element.as_ref().clone())
                }
            }
        }
        fn visit_any_all_call(
            &mut self,
            formal: &[&TypedExpr],
            args: &[TypedExpr],
            value: &TypedExpr,
            depth: usize,
        ) -> Option<()> {
            if formal.len() != 2 {
                return None;
            }
            self.expr(formal[0], depth + 1)?;
            let IrExpr::Lambda { param, body } = &formal[1].expr else {
                return None;
            };
            let IrExpr::Query(query) = &formal[0].expr else {
                return None;
            };
            super::scenario_decisions::checked_collection_lambda(self.checked, args, formal[1], value.span, self.db)?;
            let candidate = self.resolve_any_domain(query)?;
            self.bindings.push((param.clone(), candidate));
            self.expr(body, depth + 1)?;
            self.bindings.pop()?;
            Some(())
        }
        /// Pure derive-function calls in native rules lower to the emitted
        /// module-scope derive (`await name(c, ...)`), so the rule profile
        /// admits the call by profiling the callee body with the declared
        /// parameter types bound — the same binding context checking used.
        /// Transitive fields, queries and changed-model dependencies record
        /// exactly as if written inline, so rule re-evaluation stays
        /// subscribed. Unresolvable, ambiguous, bodyless, arity-mismatched
        /// or recursive calls keep the refusal; bound (partial) calls stay
        /// out.
        fn visit_derive_fn_call(
            &mut self,
            value: &TypedExpr,
            canonical: &str,
            args: &[TypedExpr],
            depth: usize,
        ) -> Option<()> {
            let mut callees = self.program.items.iter().filter(|item| {
                item.canonical == canonical && matches!(&item.kind, IrItemKind::DeriveFn { .. })
            });
            let callee = callees.next()?;
            if callees.next().is_some() {
                return None;
            }
            let IrItemKind::DeriveFn {
                params,
                result: IrType::Known(result),
                expr: Some(body),
            } = &callee.kind
            else {
                return None;
            };
            if result != &value.ty || params.len() != args.len() {
                return None;
            }
            let mut bound = Vec::with_capacity(params.len());
            for param_id in params {
                let param = self.program.items.get(param_id.0 as usize)?;
                if param.id != *param_id {
                    return None;
                }
                let IrItemKind::Param {
                    ty: IrType::Known(ty),
                    ..
                } = &param.kind
                else {
                    return None;
                };
                bound.push((param.name.clone(), ty.clone()));
            }
            for arg in args {
                self.expr(arg, depth + 1)?;
            }
            if !self.derives.insert(callee.id) {
                return None;
            }
            let previous_len = self.bindings.len();
            self.bindings.extend(bound);
            let body = body.clone();
            let admitted = self.expr(&body, depth + 1);
            self.bindings.truncate(previous_len);
            self.derives.remove(&callee.id);
            admitted
        }
        fn visit_call(
            &mut self,
            value: &TypedExpr,
            target: &IrCallTarget,
            args: &[TypedExpr],
            depth: usize,
        ) -> Option<bool> {
            if let IrCallTarget::DeriveFn(canonical) = target {
                if !matches!(&value.expr, IrExpr::Call { .. }) {
                    return Some(false);
                }
                self.visit_derive_fn_call(value, canonical, args, depth)?;
                return Some(true);
            }
            let IrCallTarget::Builtin { id, awaited: false } = target else {
                return Some(false);
            };
            if !matches!(id.as_str(), "any" | "all" | "group" | "min" | "max" | "sum" | "count" | "money" | "trim" | "starts_with" | "local_instant" | "add_days" | "date" | "overlaps") {
                return None;
            }
            let formal = self.call_arguments(value, id, args)?;
            if id == "count" && matches!(formal.as_slice(), [domain]
                if matches!(&domain.expr, IrExpr::Query(query) if query.source.is_none() && query.parent.is_none()))
            {
                return self.bare_model_count(formal[0], depth + 1).map(|_| true);
            }
            if id == "any" || id == "all" || id == "group" {
                self.visit_any_all_call(&formal, args, value, depth)?;
            } else {
                for arg in formal {
                    self.expr(arg, depth + 1)?;
                }
            }
            Some(true)
        }
        fn visit_unary_binary(&mut self, value: &TypedExpr, depth: usize) -> Option<bool> {
            match &value.expr {
                IrExpr::Unary { op: IrUnOp::Not | IrUnOp::Neg, operand } => {
                    self.expr(operand, depth + 1).map(|_| true)
                }
                IrExpr::Binary { left, right, .. } => {
                    // Operators have their original checked types in the fresh
                    // source join; neither an opaque value nor a call can enter.
                    self.expr(left, depth + 1)?;
                    self.expr(right, depth + 1).map(|_| true)
                }
                _ => Some(false),
            }
        }
        fn expr(&mut self, value: &TypedExpr, depth: usize) -> Option<()> {
            if depth > 64 || self.remaining == 0 || !Self::leaf(&value.ty) {
                return None;
            }
            self.remaining -= 1;
            match &value.expr {
                IrExpr::Int(_)
                | IrExpr::Decimal(_)
                | IrExpr::Text(_)
                | IrExpr::Bool(_)
                | IrExpr::Null
                | IrExpr::Money { .. }
                | IrExpr::DurationMs(_)
                | IrExpr::Date(_)
                | IrExpr::Datetime(_) => {}
                IrExpr::Array(_) => {
                    self.visit_array(value, depth)?;
                }
                IrExpr::Name(_) => {
                    self.visit_name(value)?;
                }
                IrExpr::Member { base, field } => {
                    self.visit_member(base, field, value, depth)?;
                }
                IrExpr::Unary { .. } | IrExpr::Binary { .. } => {
                    self.visit_unary_binary(value, depth)?;
                }
                IrExpr::Query(query) => {
                    self.visit_query(query, value, depth)?;
                }
                IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                    if !self.visit_call(value, target, args, depth)? {
                        return None;
                    }
                }
                _ => return None,
            }
            Some(())
        }
    }
    policy_model(program, model)?;
    if predicate.ty != ResolvedType::Scalar(Scalar::Bool) { return None; }
    let mut rule = Rule { checked, program, db, catalog, owner: model,
        profile: CheckedQueryRuleProfile { fields: Vec::new(), query_models: Vec::new(), dependencies: Vec::new() },
        bindings: vec![("row".into(), ResolvedType::Record { symbol: model, stored: true })], derives: HashSet::new(), remaining: 4096 };
    rule.expr(predicate, 0)?;
    Some(rule.profile)
}

/// Additional no-query leaves after the caller seals the complete original
/// source/fresh policy closure. Raw local_rule_fields remains unchanged.
pub(crate) fn checked_local_rule_fields(
    checked: &crate::analysis::CheckedProgram,
    program: &IrProgram,
    model: SymbolId,
    predicate: &TypedExpr,
    db: &crate::source::SourceDb,
    catalog: Option<&crate::analysis::catalog::Catalog>,
) -> Option<Vec<SymbolId>> {
    fn field(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
    ) -> Option<()> {
        let IrExpr::Member { field, .. } = &value.expr else {
            return None;
        };
        policy_row_member(value, model, field, &value.ty)?;
        let id = policy_field_with_flags(
            program,
            model,
            field,
            &value.ty,
            matches!(value.ty, ResolvedType::Array { .. }),
            false,
        )?;
        if !fields.contains(&id) {
            fields.push(id);
        }
        Some(())
    }
    fn operand(
        checked: &crate::analysis::CheckedProgram,
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        db: &crate::source::SourceDb,
        catalog: Option<&crate::analysis::catalog::Catalog>,
    ) -> Option<()> {
        if let Some(args) = checked_rule_call(checked, value, "count", 1, db, catalog) {
            if value.ty != ResolvedType::Scalar(Scalar::Int)
                || !matches!(args[0].ty, ResolvedType::Array { .. })
            {
                return None;
            }
            return field(program, model, args[0], fields);
        }
        if let Some(args) = checked_rule_call(checked, value, "trim", 1, db, catalog) {
            if value.ty != ResolvedType::Scalar(Scalar::Text)
                || args[0].ty != ResolvedType::Scalar(Scalar::Text)
            {
                return None;
            }
            if let IrExpr::Binary { op: IrBinOp::Coalesce, left, right } = &args[0].expr {
                if left.ty != ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Text)))
                    || right.ty != ResolvedType::Scalar(Scalar::Text)
                    || !matches!(right.expr, IrExpr::Text(_))
                {
                    return None;
                }
                return field(program, model, left, fields);
            }
            return field(program, model, args[0], fields);
        }
        // Existing scalar semantics may form the other comparison operand;
        // calls cannot enter arithmetic recursively through this fallback.
        visit(program, model, value, fields, false)
    }
    fn boolean_local_fields(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
    ) -> Option<bool> {
        let local = local_rule_fields(program, model, value).or_else(|| {
            let fields = required_model_rule_fields(program, model, value)?;
            required_model_rule_dependencies(program, model, value)?
                .is_empty()
                .then_some(fields)
        });
        let Some(local) = local else {
            return Some(false);
        };
        for id in local {
            if !fields.contains(&id) {
                fields.push(id);
            }
        }
        Some(true)
    }
    fn boolean_starts_with(
        checked: &crate::analysis::CheckedProgram,
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        db: &crate::source::SourceDb,
        catalog: Option<&crate::analysis::catalog::Catalog>,
    ) -> Option<bool> {
        let Some(args) = checked_rule_call(checked, value, "starts_with", 2, db, catalog) else {
            return Some(false);
        };
        if !matches!(args[0].ty, ResolvedType::Scalar(Scalar::Text | Scalar::Url))
            || args[1].ty != ResolvedType::Scalar(Scalar::Text)
            || !matches!(args[1].expr, IrExpr::Text(_))
        {
            return None;
        }
        field(program, model, args[0], fields)?;
        Some(true)
    }
    fn boolean_null_comparison(
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
    ) -> Option<bool> {
        let IrExpr::Binary { op, left, right } = &value.expr else {
            return Some(false);
        };
        if !matches!(op, IrBinOp::Eq | IrBinOp::Ne)
            || !(matches!(left.expr, IrExpr::Null) || matches!(right.expr, IrExpr::Null))
        {
            return Some(false);
        }
        let (read, null) = if matches!(left.expr, IrExpr::Null) {
            (right, left)
        } else {
            (left, right)
        };
        let ty = read.ty.nullable_inner().unwrap_or(&read.ty);
        match ty {
            ResolvedType::Record { symbol, stored: true } => { policy_model(program, *symbol)?; }
            // Presence is a local owning-row fact. Decoding the exact declared
            // delivery wire grants no delivery status or result observation.
            ResolvedType::StdDelivery { .. } | ResolvedType::Scalar(Scalar::Text)
                if read.ty.nullable_inner().is_some() => {}
            _ => return None,
        }
        if null.ty != ResolvedType::Null {
            return None;
        }
        let IrExpr::Member { field, .. } = &read.expr else {
            return None;
        };
        policy_row_member(read, model, field, &read.ty)?;
        let declared = ResolvedType::Nullable(Box::new(ty.clone()));
        let id = policy_field(program, model, field, &declared)?;
        if !fields.contains(&id) {
            fields.push(id);
        }
        Some(true)
    }
    fn boolean(
        checked: &crate::analysis::CheckedProgram,
        program: &IrProgram,
        model: SymbolId,
        value: &TypedExpr,
        fields: &mut Vec<SymbolId>,
        db: &crate::source::SourceDb,
        catalog: Option<&crate::analysis::catalog::Catalog>,
        depth: usize,
    ) -> Option<()> {
        if depth > 64 || value.ty != ResolvedType::Scalar(Scalar::Bool) {
            return None;
        }
        if boolean_local_fields(program, model, value, fields)? {
            return Some(());
        }
        if boolean_starts_with(checked, program, model, value, fields, db, catalog)? {
            return Some(());
        }
        if let IrExpr::Unary {
            op: IrUnOp::Not,
            operand,
        } = &value.expr
        {
            return boolean(
                checked,
                program,
                model,
                operand,
                fields,
                db,
                catalog,
                depth + 1,
            );
        }
        let IrExpr::Binary { op, left, right } = &value.expr else {
            return None;
        };
        policy_binary(value, *op)?;
        if matches!(op, IrBinOp::And | IrBinOp::Or) {
            boolean(
                checked,
                program,
                model,
                left,
                fields,
                db,
                catalog,
                depth + 1,
            )?;
            return boolean(
                checked,
                program,
                model,
                right,
                fields,
                db,
                catalog,
                depth + 1,
            );
        }
        if boolean_null_comparison(program, model, value, fields)? {
            return Some(());
        }
        if left.ty != right.ty
            || !(matches!(op, IrBinOp::Eq | IrBinOp::Ne)
                && matches!(
                    left.ty,
                    ResolvedType::Scalar(Scalar::Int | Scalar::Text | Scalar::Bool)
                )
                || matches!(op, IrBinOp::Lt | IrBinOp::Le | IrBinOp::Gt | IrBinOp::Ge)
                    && left.ty == ResolvedType::Scalar(Scalar::Int))
        {
            return None;
        }
        operand(checked, program, model, left, fields, db, catalog)?;
        operand(checked, program, model, right, fields, db, catalog)
    }
    policy_model(program, model)?;
    let mut fields = Vec::new();
    boolean(
        checked,
        program,
        model,
        predicate,
        &mut fields,
        db,
        catalog,
        0,
    )?;
    Some(fields)
}

