//! Type checking over resolved names (lane-01 analysis, PR4).
//!
//! [`check_types`] walks every typed position with the [`ResolveTables`]
//! scopes: expression types, member lookup (`E2013`), call shapes against
//! the producer catalog and user signatures, the DESIGN §3 operator
//! matrix, initializer/default/return typing, label/message/fixture
//! validation and lifetime rules. Nodes the resolver left in
//! [`ResolveTables::unresolved_names`] that this pass types (unique
//! expected-enum cases, enumerator spellings) are recorded in
//! [`TypeTable::resolved_cases`]; [`super::resolve::emit_unresolved`]
//! emits `E2001` for the rest.
//!
//! Two phases: phase 1 resolves every declared type (field/parameter/
//! result/route annotations) into [`Typer::decl`]; phase 2 walks bodies,
//! threading `let` types, query alias/row types and a small narrowing
//! environment for `and`-continuations, `if` branches and `require`
//! continuations. Only nodes the resolver walked (present in
//! [`ResolveTables::expr_scope`]) are typed; anything else is a
//! `has_error` subtree (already `E1xxx`, stay silent) or a PR5 position
//! (example cells/rows, un-walked UI selectors, migrations).
//!
//! Strict vs light positions: declarations, guards, query clauses,
//! expression calls/constructs, fixture recipes and UI value positions
//! are strict (every `E3xxx`/`E2013` applies). Effect-statement value
//! objects (`create`/`set`/`emit`/`call`/`send`/`schedule`), example
//! headers and deployment context expressions are light: values are
//! typed (so enum cases claim and names resolve) but entry/argument
//! validation belongs to PR5 effects/examples — only `E6001`
//! (unavailable builtin, a position-independent fact) still fires there.
//!
//! `E3xxx` allocation (no DIAGNOSTICS.md exists; this pass owns the
//! range, see `can explain`): `E3001` type-mismatch, `E3002`
//! invalid-operator, `E3003` unsafe-access, `E3004` invalid-coalesce,
//! `E3005` invalid-call, `E3006` invalid-query, `E3007` expected-bool,
//! `E3008` invalid-type, `E3009` invalid-action, `E3010`
//! invalid-delivery, `E3011` invalid-default, `E3012` bad-modifier,
//! `E3013` invalid-label-values, `E3014` invalid-message, `E3015`
//! bad-fixture, `E3016` invalid-label-message, `E3017`
//! invalid-lifetime, `E3018` invalid-is, `E3019`
//! opaque-capability-receipt. `E6001` (planned-builtin call)
//! is emitted here; `E6002`–`E6004` come from the catalog loader.

use std::collections::{HashMap, HashSet};

use crate::diagnostic::{Diagnostic, Related};
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{Punct, SyntaxKind, SyntaxNode, TokenKind};

use super::catalog::{
    Availability, Catalog, Effects, SigOverload, SigType, StdNominal, StdOperation,
    T13B_DELIVERY_OBSERVABLES, nominal_schema, std_capability,
};
use super::resolve::{
    ActorKind, Binding, ContextVar, CrudOp, FixtureTarget, ModelOwner, ModuleId, ResolveTables,
    ScopedName, SymbolId, SymbolKind, TypeRef, UnresolvedMember, has_error, is_expression,
};
use super::{
    NodeKey, attribute_parts, attribute_value, file_text, is_name, is_punct, kids, name_text,
    op_text, path_segments,
};

/// Scalar leaf of a resolved type: every builtin scalar type name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scalar {
    Bool,
    Int,
    Decimal,
    Text,
    Email,
    Url,
    Locale,
    Date,
    Datetime,
    Duration,
    Timezone,
    Currency,
    Money,
    User,
    Member,
    File,
    Secret,
    Json,
    Bytes,
}

impl Scalar {
    /// Source spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Scalar::Bool => "bool",
            Scalar::Int => "int",
            Scalar::Decimal => "decimal",
            Scalar::Text => "text",
            Scalar::Email => "email",
            Scalar::Url => "url",
            Scalar::Locale => "locale",
            Scalar::Date => "date",
            Scalar::Datetime => "datetime",
            Scalar::Duration => "duration",
            Scalar::Timezone => "timezone",
            Scalar::Currency => "currency",
            Scalar::Money => "money",
            Scalar::User => "user",
            Scalar::Member => "member",
            Scalar::File => "file",
            Scalar::Secret => "secret",
            Scalar::Json => "json",
            Scalar::Bytes => "bytes",
        }
    }

    /// Whether this scalar is in the DESIGN §3 ordered-scalar (`O`) list.
    pub fn is_ordered(self) -> bool {
        matches!(
            self,
            Scalar::Int
                | Scalar::Decimal
                | Scalar::Duration
                | Scalar::Money
                | Scalar::Date
                | Scalar::Datetime
                | Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency
                | Scalar::Bytes
        )
    }

    /// Whether this scalar is in the string-like (`S`) class.
    pub fn is_string_like(self) -> bool {
        matches!(
            self,
            Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency
        )
    }

    /// Whether this scalar is in the group-key (`K`) class.
    pub fn is_group_key(self) -> bool {
        matches!(
            self,
            Scalar::Text
                | Scalar::Bool
                | Scalar::Int
                | Scalar::Decimal
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency
                | Scalar::Date
                | Scalar::Datetime
                | Scalar::Duration
                | Scalar::Money
                | Scalar::User
                | Scalar::Member
        )
    }

    /// Whether this scalar is in the `Display` class.
    pub fn is_display(self) -> bool {
        matches!(
            self,
            Scalar::Text
                | Scalar::Email
                | Scalar::Url
                | Scalar::Locale
                | Scalar::Timezone
                | Scalar::Currency
                | Scalar::Bool
                | Scalar::Int
                | Scalar::Date
        )
    }

    /// Whether a text literal can inhabit this leaf after validation
    /// (DESIGN §3: every string-like except `text` itself).
    pub fn is_validated_leaf(self) -> bool {
        matches!(
            self,
            Scalar::Email | Scalar::Url | Scalar::Locale | Scalar::Timezone | Scalar::Currency
        )
    }
}

/// Resolved type of one typed position.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedType {
    /// Poisoned by an already-reported error; suppresses cascades.
    Error,
    /// Uninhabited-but-legal unknown: the empty-array element and
    /// unbound-generic results. Unifies with anything, silently.
    Unknown,
    /// The `null` literal: inhabits every nullable position.
    Null,
    /// Scalar leaf.
    Scalar(Scalar),
    /// The `Team` record (`id`, `timezone`).
    Team,
    /// The `operation` record (`id`, `source`).
    OperationContext,
    /// Anonymous enum: `cases` plus the owning field/parameter symbol
    /// when the enum comes from a declaration (`None` for catalog
    /// `enum(a,b)` results).
    Enum {
        cases: Vec<String>,
        owner: Option<SymbolId>,
    },
    /// Record of a model/contract/event/preferences symbol. `stored`
    /// distinguishes stored rows (queries, parameters, fixtures — the
    /// reserved `id`/`version`/… metadata exists) from detached
    /// `Model {…}` construct values (no metadata).
    Record { symbol: SymbolId, stored: bool },
    /// Message descriptor value (a bare message reference).
    Message(SymbolId),
    /// `action(op,…)` value over canonical user mutations.
    /// `bound` names the inputs pre-bound at construction (`Some`
    /// from the `action()` constructor, `None` for values whose
    /// construction site is unknown, e.g. action-typed parameters).
    /// `external` carries bound-import targets as canonical
    /// `provider.name` strings (they have no local symbol).
    Action {
        targets: Vec<SymbolId>,
        bound: Option<Vec<String>>,
        external: Vec<String>,
    },
    /// `invocation(op,…)` complete-call value (DESIGN §2.2) over
    /// canonical user mutations. Always carries complete arguments;
    /// distinct from [`ResolvedType::Action`].
    Invocation { targets: Vec<SymbolId> },
    /// `delivery(op)` value over one bound operation.
    Delivery { op: SymbolId },
    /// `delivery(std.Cap.op)` value over one consumed T13 `std`
    /// operation (T14c): a typed external send receipt carrying its
    /// operation identity, so cross-target associations fail instead
    /// of passing silently through [`ResolvedType::Opaque`].
    /// `capability` is the qualified contract name (`std.EmailV1`);
    /// `op` is the consumed operation schema (inputs plus the
    /// declared result name). Unknown/unconsumed receipt positions
    /// stay [`ResolvedType::Opaque`], never this.
    StdDelivery {
        capability: &'static str,
        op: &'static StdOperation,
    },
    /// `[T]` array or `C<T>` query/collection domain. `ordered` holds
    /// for every array value (authored order, `created,id`, or group
    /// encounter order). `nonempty` holds only for
    /// statically written nonempty array literals.
    Array {
        element: Box<ResolvedType>,
        ordered: bool,
        nonempty: bool,
    },
    /// `T?`.
    Nullable(Box<ResolvedType>),
    /// `A|B` tagged union over record symbols.
    Union(Vec<SymbolId>),
    /// Closed object value (object literal, `group` row).
    Object(Vec<(String, ResolvedType)>),
    /// Operation reference (scenario, capability op or CRUD op): a
    /// value only PR5 positions interpret; PR4 never errors on it.
    Operation(SymbolId),
    /// PR5-deferred value (trusted event payloads, external imports,
    /// generated CRUD results, send/call results the checker cannot
    /// schema): propagates silently through every operator/member.
    /// The payload names the deferral for debugging; it never renders
    /// to users.
    Opaque(&'static str),
}

impl ResolvedType {
    /// Whether this type is [`ResolvedType::Error`].
    pub fn is_error(&self) -> bool {
        matches!(self, ResolvedType::Error)
    }

    /// Strip one nullable layer, if present.
    pub fn nullable_inner(&self) -> Option<&ResolvedType> {
        match self {
            ResolvedType::Nullable(inner) => Some(inner),
            _ => None,
        }
    }

    /// Whether this type is statically proven non-null: anything but
    /// `Nullable`, `Null`, `Error` (already diagnosed) and the
    /// unknowable `Opaque`/`Unknown`.
    pub fn is_proven_nonnull(&self) -> bool {
        !matches!(
            self,
            ResolvedType::Nullable(_)
                | ResolvedType::Null
                | ResolvedType::Error
                | ResolvedType::Opaque(_)
                | ResolvedType::Unknown
        )
    }

    /// Short noun for diagnostics (`text?`, `array of int`, `Todo`).
    /// Same-module records render short; others canonical.
    pub fn display(&self, tables: &ResolveTables, module: ModuleId) -> String {
        match self {
            ResolvedType::Error => "{error}".to_string(),
            ResolvedType::Unknown => "{unknown}".to_string(),
            ResolvedType::Null => "null".to_string(),
            ResolvedType::Scalar(s) => s.as_str().to_string(),
            ResolvedType::Team => "Team".to_string(),
            ResolvedType::OperationContext => "OperationContext".to_string(),
            ResolvedType::Enum { cases, .. } => format!("enum({})", cases.join(",")),
            ResolvedType::Record { symbol, .. } => record_name(tables, module, *symbol),
            ResolvedType::Message(id) => {
                format!("message {}", record_name(tables, module, *id))
            }
            ResolvedType::Action {
                targets, external, ..
            } => {
                let mut ops: Vec<String> = targets
                    .iter()
                    .map(|t| record_name(tables, module, *t))
                    .collect();
                ops.extend(external.iter().cloned());
                format!("action({})", ops.join(","))
            }
            ResolvedType::Invocation { targets } => {
                let ops: Vec<String> = targets
                    .iter()
                    .map(|t| record_name(tables, module, *t))
                    .collect();
                format!("invocation({})", ops.join(","))
            }
            ResolvedType::Delivery { op } => {
                format!("delivery({})", record_name(tables, module, *op))
            }
            ResolvedType::StdDelivery { capability, op } => {
                format!("delivery({capability}.{})", op.name)
            }
            ResolvedType::Array { element, .. } => {
                format!("array of {}", element.display(tables, module))
            }
            ResolvedType::Nullable(inner) => {
                format!("{}?", inner.display(tables, module))
            }
            ResolvedType::Union(arms) => arms
                .iter()
                .map(|a| record_name(tables, module, *a))
                .collect::<Vec<_>>()
                .join("|"),
            ResolvedType::Object(fields) => {
                let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
                format!("object{{{}}}", keys.join(","))
            }
            ResolvedType::Operation(id) => record_name(tables, module, *id),
            ResolvedType::Opaque(_) => "{opaque}".to_string(),
        }
    }
}

/// Short (same-module) or canonical record/symbol name for diagnostics.
fn record_name(tables: &ResolveTables, module: ModuleId, id: SymbolId) -> String {
    let symbol = &tables.symbols[id.0 as usize];
    if symbol.module == module {
        symbol.name.clone()
    } else {
        symbol.canonical.clone()
    }
}

/// Checked expression-call owner.
#[derive(Debug, Clone)]
pub enum SelectedCallTarget {
    /// The winning overload in the cohort-owned producer catalog.
    Builtin {
        id: String,
        overload: usize,
    },
    DeriveFn(SymbolId),
    Message(SymbolId),
    Role(SymbolId),
}

/// One checked call binding. Slots are in declaration order; supplied
/// indexes refer to `arguments` in source order. `None` is an omitted
/// declaration default, never a catalog default or an explicit null.
#[derive(Debug, Clone)]
pub struct SelectedCall {
    pub target: SelectedCallTarget,
    pub arguments: Vec<NodeKey>,
    pub slots: Vec<Option<usize>>,
}

/// Only declared T13b delivery observations alias progress to their latest result.
pub(crate) fn delivery_progress_alias(ty: &ResolvedType) -> bool {
    let ty = ty.nullable_inner().unwrap_or(ty);
    let ResolvedType::StdDelivery { capability, op } = ty else {
        return false;
    };
    T13B_DELIVERY_OBSERVABLES
        .iter()
        .any(|observable| observable.target == format!("{capability}.{}", op.name))
}

pub(crate) fn std_delivery_result_type(op: &StdOperation) -> ResolvedType {
    match std_schema_type(op.result) {
        Some(ty) => ResolvedType::Nullable(Box::new(ty)),
        None => match nominal_schema(op.result) {
            Some(schema) => ResolvedType::Nullable(Box::new(std_nominal_object(schema))),
            None => ResolvedType::Opaque("std delivery result"),
        },
    }
}

/// Checked nonexecutable choice assistance owned by one operation input.
#[derive(Debug, Clone)]
pub struct CheckedInputChoice {
    pub read_operation: SymbolId,
    pub arguments: Vec<CheckedChoiceArgument>,
    pub value: CheckedChoiceValue,
    pub labels: Vec<String>,
}

/// One owning read input supplied from an owning assisted-operation input.
#[derive(Debug, Clone)]
pub struct CheckedChoiceArgument {
    pub parameter: SymbolId,
    pub input: SymbolId,
    pub path: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum CheckedChoiceValue {
    Record,
    Field(String),
}

/// Types and selected bindings per symbol and typed CST node.
#[derive(Debug, Clone, Default)]
pub struct TypeTable {
    /// Exact earlier-parameter identity claimed by an authored bare default.
    pub param_default_copy_sources: HashMap<SymbolId, SymbolId>,
    /// Exact typed cohort-child reads, consumed without spelling rebinding.
    pub cohort_child_references: HashMap<NodeKey, SymbolId>,
    /// Exact checked bare-role value references, preserving lexical collisions.
    pub role_references: HashMap<NodeKey, SymbolId>,
    /// Optional checked assistance; final input typing/defaults/grants are unchanged.
    pub input_choices: HashMap<SymbolId, CheckedInputChoice>,
    /// Checked external and capability/operation declaration heads for sends.
    pub target_bindings: HashMap<NodeKey, Binding>,
    /// Checked owning progress handler identities, consumed without source rebinding.
    pub delivery_progress_handlers: HashMap<NodeKey, String>,
    /// Selected call authority consumed by IR without rebinding arguments.
    pub selected_calls: HashMap<NodeKey, SelectedCall>,
    /// Subject-domain labels checked for individual finite-enum match arms.
    pub enum_match_cases: HashMap<NodeKey, String>,
    /// Match statements with complete, unique checked subject-domain coverage.
    pub exhaustive_matches: HashSet<NodeKey>,
    /// Name references with a lexical value binding. Retained for IR so
    /// enum-valued locals are not reconstructed as case spellings.
    pub bound_names: HashSet<NodeKey>,
    /// Resolved type of each typed CST node (absent = untyped position).
    pub node_types: HashMap<NodeKey, ResolvedType>,
    /// Canonical delivery observation selectors checked against their source owner.
    pub delivery_selectors: HashMap<NodeKey, String>,
    /// Additional unbound names found by the types pass (pass 2 `E2001`).
    pub unresolved_names: Vec<NodeKey>,
    /// Unbound names the types pass claimed as unique-expected-enum
    /// cases (or covered with a precise `E3xxx`): pass 2 `E2001` skips
    /// these.
    pub resolved_cases: HashSet<NodeKey>,
    /// Member failures from type-owned positions (pass 2 `E2013`).
    pub unresolved_members: Vec<UnresolvedMember>,
    /// Declared type of every Field/Param/DeriveField symbol (PR5
    /// emission input: typed schemas; absent = undeclared/untypable).
    pub symbol_types: HashMap<SymbolId, ResolvedType>,
    /// Declared result of every Scenario/CapabilityOp symbol
    /// (`None` = void). PR5 emission input: operation signatures.
    pub symbol_results: HashMap<SymbolId, Option<ResolvedType>>,
}

/// Check types over `trees` with `tables`.
pub fn check_types(
    db: &SourceDb,
    trees: &[(SourceId, SyntaxNode)],
    catalog: Option<&Catalog>,
    tables: &ResolveTables,
    diags: &mut Vec<Diagnostic>,
) -> TypeTable {
    let mut typer = Typer::new(db, catalog, tables, diags);
    // Read flags first: phase-1 declared types (`action(...)` /
    // `invocation(...)` targets) already need the set.
    typer.collect_read_scenarios(trees);
    // Source languages first: message/descriptor variant checks
    // (`E3016` source-repeat) compare against the owning module tag.
    typer.collect_module_sources(trees);
    typer.phase1(trees);
    typer.phase2(trees);
    typer.check_input_choice_cycles();
    typer.check_cycles();
    typer.types.symbol_types = std::mem::take(&mut typer.decl);
    typer.types.symbol_results = std::mem::take(&mut typer.results);
    typer.types.bound_names = tables
        .node_binding
        .iter()
        .filter(|(_, binding)| {
            !matches!(
                binding,
                Binding::Builtin { .. } | Binding::Predicate | Binding::Error
            )
        })
        .map(|(key, _)| *key)
        .collect();
    typer.types.target_bindings = tables
        .node_binding
        .iter()
        .filter(|(_, binding)| match binding {
            Binding::External { .. } => true,
            Binding::Symbol(id) => matches!(
                tables.symbols[id.0 as usize].kind,
                SymbolKind::Capability { .. }
                    | SymbolKind::CapabilityOp { .. }
                    | SymbolKind::Scenario { .. }
            ),
            _ => false,
        })
        .map(|(key, binding)| (*key, binding.clone()))
        .collect();
    typer.types
}

/// T14 resolution of a deployment-bound `Cap.op` target against the
/// consumed T13 owner schemas (T13a common plus T13b rich relations;
/// T14b lifted the T14a scope gate to the full
/// [`std_capability`](super::catalog::std_capability) table).
enum StdTarget {
    /// A consumed T13 operation (`display` is the author spelling,
    /// e.g. `Mail.send`; `capability` is the qualified contract
    /// name, e.g. `std.EmailV1`, the receipt-identity half T14c
    /// stores on [`ResolvedType::StdDelivery`]).
    Known {
        op: &'static StdOperation,
        display: String,
        capability: &'static str,
    },
    /// A T13-known capability with an operation outside its owner
    /// schema: a wrong association, verified wrong (never opaque).
    WrongOp { capability: String, op: String },
    /// No consumed T13 schema covers this target: the scoped-out
    /// Handbook interface, unknown members/providers and
    /// unresolvable spellings keep their opaque treatment.
    NoSchema,
}

/// Whether a consumed T13 input is array-typed (nullable arrays
/// included).
fn std_input_is_array(declared: &str) -> bool {
    declared
        .strip_suffix('?')
        .unwrap_or(declared)
        .ends_with("[]")
}

/// Whether a consumed T13 input must be present in a `send` (T14):
/// every input except array-typed ones. B9: arrays (notably
/// `attachments`) omit to empty per DESIGN §8 `attachments:file[]=[]`
/// ("empty attachments preserve the ordinary mail call"), the
/// unanimous corpus omission (40/40 sends, 13/13 recipes) and T09
/// ordinary-array semantics; the producer's required wire key is the
/// normalized shape, not the source binding. Nullable scalars
/// (notably `consent`) stay required-with-explicit-null per the
/// producer contract (`consent: string | null`, required key) and
/// local-send parity (`check_op_bindings`).
fn std_send_requires_input(declared: &str) -> bool {
    !std_input_is_array(declared)
}

/// Whether a consumed T13 input must be present in a recipe
/// `request=`: mirrors local recipes (`check_fixture_request`),
/// where nullable inputs omit alongside arrays.
fn std_recipe_requires_input(declared: &str) -> bool {
    !std_input_is_array(declared) && !declared.ends_with('?')
}

/// Map a consumed T13 schema type name to its checkable type.
/// `None` is nominal-only (e.g. `ErrorReport`): presence-checked,
/// shape unchecked — the consumed schema carries the name without
/// fields, so the value shape is walked for effects, never guessed.
pub(crate) fn std_schema_type(declared: &str) -> Option<ResolvedType> {
    if let Some(inner) = declared.strip_suffix('?') {
        return std_schema_type(inner).map(|ty| ResolvedType::Nullable(Box::new(ty)));
    }
    if let Some(element) = declared.strip_suffix("[]") {
        return std_schema_type(element).map(|ty| ResolvedType::Array {
            element: Box::new(ty),
            ordered: true,
            nonempty: false,
        });
    }
    if let Some(cases) = declared
        .strip_prefix("enum(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let cases = cases.split(',').map(str::to_string).collect::<Vec<_>>();
        if cases.is_empty() || cases.iter().any(|c| c.is_empty()) {
            return None;
        }
        return Some(ResolvedType::Enum { cases, owner: None });
    }
    scalar_named(declared).map(ResolvedType::Scalar)
}

/// Closed field object for one transcribed T13c nominal (T14d): each
/// field maps through [`std_nominal_leaf_type`] in producer order.
fn std_nominal_object(schema: &StdNominal) -> ResolvedType {
    ResolvedType::Object(
        schema
            .fields
            .iter()
            .map(|(name, kind)| (name.to_string(), std_nominal_leaf_type(kind)))
            .collect(),
    )
}

/// Map one T13c nominal leaf kind to its checkable type (T14d).
/// Scalar/enum/array spellings reuse [`std_schema_type`]
/// (transcribed refinements such as `amount: money` arrive
/// already refined); transcribed nominal refs nest their closed
/// object (the frozen tables are acyclic: requests nest messages,
/// runs nest outputs, nothing nests back); lane-2 named refs
/// (`CanDuration`, `DatetimeValue`), nested non-nominals
/// (`WorkflowField`) and anything else stay opaque — transcribed,
/// never reinterpreted, never guessed.
fn std_nominal_leaf_type(declared: &str) -> ResolvedType {
    if let Some(ty) = std_schema_type(declared) {
        return ty;
    }
    if let Some(inner) = declared.strip_suffix('?') {
        return ResolvedType::Nullable(Box::new(std_nominal_leaf_type(inner)));
    }
    if let Some(element) = declared.strip_suffix("[]") {
        return ResolvedType::Array {
            element: Box::new(std_nominal_leaf_type(element)),
            ordered: true,
            nonempty: false,
        };
    }
    if let Some(schema) = nominal_schema(declared) {
        return std_nominal_object(schema);
    }
    ResolvedType::Opaque("std nominal leaf")
}

impl<'a> Typer<'a> {
    /// Phase 2: walk declaration bodies and statements, filling the
    /// local-type maps and checking every typed position. Nodes
    /// containing a syntax error are skipped (already diagnosed).
    fn phase2(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for child in kids(tree) {
                match child.kind {
                    SyntaxKind::App | SyntaxKind::Package => {
                        let Some(module) = module_of_node(self.tables, &text, child) else {
                            continue;
                        };
                        self.phase2_context(*file, &text, module, child);
                        self.phase2_module(*file, &text, module, child);
                    }
                    // Migrations are deployment operations, out of
                    // PR4 scope (reported).
                    _ => {}
                }
            }
        }
    }

    /// Walk one module's sections, dispatching declarations by kind.
    fn phase2_module(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        self.phase2_owner_attrs(file, text, module, node);
        for section in kids(node) {
            if section.kind != SyntaxKind::Section {
                continue;
            }
            for item in kids(section) {
                if has_error(item) {
                    continue;
                }
                match item.kind {
                    SyntaxKind::Model | SyntaxKind::Contract | SyntaxKind::Event => {
                        self.phase2_record(file, text, module, item);
                    }
                    // Duplicate preferences schemas are resolve's
                    // (`E2002`); empty ones are the parser's.
                    SyntaxKind::Preferences => {
                        self.phase2_preferences(file, text, module, item);
                    }
                    SyntaxKind::Role => self.phase2_role(file, text, module, item),
                    SyntaxKind::Derive => self.phase2_derive(file, text, module, item),
                    SyntaxKind::Message => self.phase2_message(file, text, module, item),
                    SyntaxKind::Policy
                    | SyntaxKind::Invariant
                    | SyntaxKind::Unique
                    | SyntaxKind::Lock
                    | SyntaxKind::Retain => self.phase2_rule(file, text, module, item),
                    SyntaxKind::Fixture => self.phase2_fixture(file, text, module, item),
                    SyntaxKind::Capability => self.phase2_capability(file, text, module, item),
                    SyntaxKind::Scenario => self.phase2_scenario(file, text, module, item),
                    SyntaxKind::Crud => self.phase2_crud(file, text, module, item),
                    SyntaxKind::Page => self.phase2_page(file, text, module, item),
                    _ => {}
                }
            }
        }
    }

    // --- Phase 2: declaration lookup -----------------------------------

    /// First `Name` child outside the introducer heads (mirrors the
    /// resolver's declaration naming).
    fn decl_head<'t>(text: &'t str, node: &SyntaxNode, heads: &[&str]) -> Option<&'t str> {
        kids(node).iter().find_map(|n| {
            let word = name_text(n, text)?;
            (!heads.contains(&word)).then_some(word)
        })
    }

    /// Production symbol declared by `node`, via the module scope.
    fn decl_symbol(
        &self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        heads: &[&str],
    ) -> Option<SymbolId> {
        let name = Self::decl_head(text, node, heads)?;
        match self.tables.module_scopes[module.0 as usize].prod.get(name) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(*id),
            _ => None,
        }
    }

    /// Test-namespace symbol declared by `node` (fixtures).
    fn test_symbol(
        &self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        heads: &[&str],
    ) -> Option<SymbolId> {
        let name = Self::decl_head(text, node, heads)?;
        match self.tables.module_scopes[module.0 as usize].test.get(name) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(*id),
            _ => None,
        }
    }

    /// Field symbol of `owner` named by a `Field` node.
    fn field_symbol(&self, owner: SymbolId, text: &str, field: &SyntaxNode) -> Option<SymbolId> {
        let name = kids(field).iter().find_map(|n| name_text(n, text))?;
        let fields = match &self.tables.symbols[owner.0 as usize].kind {
            SymbolKind::Model { fields, .. }
            | SymbolKind::Contract { fields }
            | SymbolKind::Event { fields }
            | SymbolKind::Preferences { fields } => fields.clone(),
            _ => return None,
        };
        fields
            .into_iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
    }

    /// Fresh strict context for a body position.
    fn body_cx<'b, 'n>(
        module: ModuleId,
        file: SourceId,
        text: &'b str,
        narrow: &'n NarrowEnv,
    ) -> Ctx<'b, 'n> {
        Ctx {
            module,
            file,
            text,
            narrow,
            strict: true,
            server_default: false,
        }
    }

    // --- Phase 2: records and fields -----------------------------------

    /// Check a model/contract/event declaration: its fields plus its
    /// trailing label.
    fn phase2_record(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let heads: &[&str] = match node.kind {
            SyntaxKind::Model => &["export"],
            SyntaxKind::Contract => &["export", "contract"],
            _ => &["export", "event"],
        };
        let Some(id) = self.decl_symbol(module, text, node, heads) else {
            return;
        };
        for field in kids(node) {
            if field.kind == SyntaxKind::Field && !has_error(field) {
                self.phase2_field(file, text, module, id, field, false);
            }
        }
        if let Some(label) = attribute_value(node, "label", text) {
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            self.check_scalar_caption(&cx, label, "label");
        }
    }

    /// Check a preferences declaration: field types are restricted
    /// (DESIGN §9) and initializers/uniqueness have extra rules.
    fn phase2_preferences(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) {
        let Some(id) = self.prefs.get(&module).copied() else {
            return;
        };
        for field in kids(node) {
            if field.kind == SyntaxKind::Field && !has_error(field) {
                self.phase2_field(file, text, module, id, field, true);
            }
        }
        if let Some(label) = attribute_value(node, "label", text) {
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            self.check_scalar_caption(&cx, label, "label");
        }
    }

    /// Check one `Field` node: initializer value, modifiers and label.
    /// `in_prefs` selects the preferences restrictions (DESIGN §9).
    fn phase2_field(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        owner: SymbolId,
        field: &SyntaxNode,
        in_prefs: bool,
    ) {
        let Some(id) = self.field_symbol(owner, text, field) else {
            return;
        };
        let expected = self.decl_type(id);
        let (has_default, has_server, required) = self
            .shapes
            .get(&id)
            .copied()
            .unwrap_or((false, false, false));
        let name = self.tables.symbols[id.0 as usize].name.clone();
        if in_prefs {
            self.check_prefs_field_type(text, module, field, &name, &expected);
            if has_server {
                self.diags.push(Diagnostic::error(
                    "E3011",
                    format!("preferences field '{name}' cannot have a server initializer"),
                    tight_span(text, field),
                ));
            }
        }
        // `!` shape validation lives in phase 1 (which reports the
        // resolved type); repeating it here double-reported one fault.
        // A required-array-input field cannot also have a default or
        // server initializer (DESIGN §2).
        if required && (has_default || has_server) {
            self.diags.push(Diagnostic::error(
                "E3011",
                format!("field '{name}': a required array input cannot have an initializer"),
                tight_span(text, field),
            ));
        }
        // `secret` fields always require server initialization.
        let unwrapped = match &expected {
            ResolvedType::Nullable(inner) => inner.as_ref().clone(),
            other => other.clone(),
        };
        if matches!(unwrapped, ResolvedType::Scalar(Scalar::Secret)) && !has_server {
            self.diags.push(Diagnostic::error(
                "E3011",
                format!("field '{name}': secret fields need a server initializer"),
                tight_span(text, field),
            ));
        }
        // Delivery fields must be nullable (attempts only come from
        // `send` results; DESIGN §8.1).
        if matches!(
            expected,
            ResolvedType::Delivery { .. } | ResolvedType::StdDelivery { .. }
        ) {
            self.diags.push(Diagnostic::error(
                "E3008",
                format!("field '{name}': delivery fields must be nullable"),
                tight_span(text, field),
            ));
        }
        let narrow = NarrowEnv::default();
        let init = field_parts(field, text);
        if let Some(default) = init.default {
            if expr_uses_name(default, text, "actor") {
                self.default_uses_actor.insert(id);
            }
            let cx = Self::body_cx(module, file, text, &narrow);
            let actual = self.expr(&cx, default, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3011",
                    format!(
                        "default for '{name}': expected {}, found {}",
                        self.show(module, &expected),
                        self.show(module, &actual)
                    ),
                    tight_span(text, default),
                ));
            }
            if in_prefs {
                self.check_prefs_default_const(text, module, field, &name, default);
            }
        }
        if let Some(server) = init.server {
            if expr_uses_name(server, text, "actor") {
                self.default_uses_actor.insert(id);
            }
            let cx = Ctx {
                module,
                file,
                text,
                narrow: &narrow,
                strict: true,
                server_default: true,
            };
            let actual = self.expr(&cx, server, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3011",
                    format!(
                        "server initializer for '{name}': expected {}, found {}",
                        self.show(module, &expected),
                        self.show(module, &actual)
                    ),
                    tight_span(text, server),
                ));
            }
        }
        if in_prefs && matches!(expected, ResolvedType::Nullable(_)) {
            // Nullable preferences fields default null; nothing more.
        } else if in_prefs && !has_default && !matches!(expected, ResolvedType::Nullable(_)) {
            self.diags.push(Diagnostic::error(
                "E3011",
                format!("preferences field '{name}' needs a constant default"),
                tight_span(text, field),
            ));
        }
        let cx = Self::body_cx(module, file, text, &narrow);
        // One occurrence of each modifier (when the parser lets a
        // duplicate through, the checker still rejects it).
        let mut seen_modifiers: Vec<&str> = Vec::new();
        for modifier in &init.modifiers {
            let which = match modifier {
                FieldModifier::Trim(_) => "trim",
                FieldModifier::Unique(_) => "unique",
                FieldModifier::Machine(_) => "machine",
                FieldModifier::Min(_) => "min",
                FieldModifier::Max(_) => "max",
            };
            if seen_modifiers.contains(&which) {
                self.diags.push(Diagnostic::error(
                    "E3012",
                    format!("field '{name}': duplicate {which} modifier"),
                    tight_span(text, field),
                ));
            } else {
                seen_modifiers.push(which);
            }
            if in_prefs && matches!(modifier, FieldModifier::Unique(_)) {
                self.diags.push(Diagnostic::error(
                    "E3012",
                    format!("preferences field '{name}' cannot be unique"),
                    tight_span(text, field),
                ));
            }
            self.check_field_modifier(&cx, field, &name, &expected, *modifier);
        }
        self.check_min_max_order(&cx, field, &name, &init.modifiers);
        if let Some(label) = init.label {
            self.check_field_label(&cx, field, &name, &expected, label);
        }
        self.check_description_slot(&cx, field);
    }

    // --- Phase 2: statements -------------------------------------------

    /// Walk one `require` guard: boolean predicate plus an optional
    /// literal-or-message diagnostic.
    fn walk_guard(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        if let Some(pred) = parts.iter().find(|n| is_expression(n.kind)).copied() {
            let ty = self.expr(cx, pred, None);
            self.expect_bool(cx, tight_span(cx.text, pred), &ty, "`require`");
        }
        if let Some(msg) = attribute_value(node, "message", cx.text) {
            self.check_text_or_message(cx, msg, "`message=`");
        }
    }

    /// Walk a `do` block's statements in order, threading `require`
    /// facts into later statements with write/call invalidation.
    fn walk_do_block(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let stmts: Vec<&SyntaxNode> = kids(node)
            .into_iter()
            .filter(|stmt| stmt.kind != SyntaxKind::Name)
            .collect();
        self.walk_seq(cx, &stmts);
    }

    /// Walk one statement sequence in order (T03 §§4-5,8): each
    /// statement checks against the incoming facts; a successful
    /// `require` adds its true-facts for later statements, and every
    /// statement drops the facts it invalidates. Facts established
    /// here never leak to the caller (branches/joins/loops keep the
    /// intersection discipline at their own level).
    fn walk_seq(&mut self, cx: &Ctx<'_, '_>, stmts: &[&SyntaxNode]) {
        let mut env = cx.narrow.clone();
        for stmt in stmts {
            {
                let stmt_cx = Ctx {
                    module: cx.module,
                    file: cx.file,
                    text: cx.text,
                    narrow: &env,
                    strict: cx.strict,
                    server_default: cx.server_default,
                };
                self.walk_statement(&stmt_cx, stmt);
            }
            if stmt.kind == SyntaxKind::Require
                && let Some(cond) = kids(stmt).iter().find(|n| is_expression(n.kind))
            {
                let snapshot = env.clone();
                let narrow_cx = Ctx {
                    module: cx.module,
                    file: cx.file,
                    text: cx.text,
                    narrow: &snapshot,
                    strict: cx.strict,
                    server_default: cx.server_default,
                };
                self.collect_narrow(&narrow_cx, cond, false, &mut env);
            }
            self.invalidate_after(cx.text, stmt, &mut env);
        }
    }

    /// Drop the facts one statement invalidates (T03 §8): `set`
    /// drops member-path facts under the target's root declaration
    /// (the write may alias any path beneath it); `create`/`delete`
    /// and mutation-capable `call`/`send`/effect statements drop all
    /// member-path facts; `if`/`for` drop what any nested path drops.
    /// Root facts (a binding is non-null) always persist: bindings
    /// are immutable (T03 §7) — no statement nulls a name.
    fn invalidate_after(&self, text: &str, stmt: &SyntaxNode, env: &mut NarrowEnv) {
        let mut scan = ScanInvalid::default();
        self.scan_invalid(text, stmt, &mut scan);
        if scan.drop_all_paths {
            env.retain(|key, _| key.path.is_empty());
        }
        if !scan.drop_roots.is_empty() {
            env.retain(|key, _| key.path.is_empty() || !scan.drop_roots.contains(&key.decl));
        }
    }

    /// Collect the invalidation causes of one statement subtree.
    /// Statement-level `Call` nodes invoke operations (expression
    /// calls are builtins/derived only, hence pure); `let`/`require`
    /// initializers and conditions are pure expressions.
    fn scan_invalid(&self, text: &str, stmt: &SyntaxNode, out: &mut ScanInvalid) {
        match stmt.kind {
            SyntaxKind::Set | SyntaxKind::Transition => {
                if let Some(decl) = self.set_target_decl(text, stmt)
                    && !out.drop_roots.contains(&decl)
                {
                    out.drop_roots.push(decl);
                }
            }
            SyntaxKind::Create
            | SyntaxKind::Delete
            | SyntaxKind::Call
            | SyntaxKind::Send
            | SyntaxKind::Emit
            | SyntaxKind::Schedule
            | SyntaxKind::Cancel => {
                out.drop_all_paths = true;
            }
            SyntaxKind::If
            | SyntaxKind::For
            | SyntaxKind::Match
            | SyntaxKind::MatchArm
            | SyntaxKind::DoBlock => {
                for child in kids(stmt) {
                    if matches!(
                        child.kind,
                        SyntaxKind::Let
                            | SyntaxKind::Create
                            | SyntaxKind::Set
                            | SyntaxKind::Transition
                            | SyntaxKind::Delete
                            | SyntaxKind::Call
                            | SyntaxKind::Emit
                            | SyntaxKind::Send
                            | SyntaxKind::Schedule
                            | SyntaxKind::Cancel
                            | SyntaxKind::Return
                            | SyntaxKind::Require
                            | SyntaxKind::If
                            | SyntaxKind::For
                            | SyntaxKind::Match
                            | SyntaxKind::MatchArm
                            | SyntaxKind::DoBlock
                    ) {
                        self.scan_invalid(text, child, out);
                    }
                }
            }
            _ => {}
        }
    }

    /// Resolved declaration behind a `set` target's head name
    /// (T30: from resolution, never from the `event` spelling — an
    /// ordinary parameter/let named `event` invalidates its own
    /// declaration, while only the handler context `event`
    /// invalidates `CtxEvent`).
    fn set_target_decl(&self, text: &str, stmt: &SyntaxNode) -> Option<DeclKey> {
        let target = kids(stmt)
            .iter()
            .find(|n| n.kind == SyntaxKind::Path)
            .copied()?;
        let segments = path_segments(target, text);
        let head = (*segments.first()?).to_string();
        let scope = self.tables.expr_scope.get(&NodeKey::of(target)).copied()?;
        self.tables
            .resolve_name(scope, &head, self.catalog)
            .map(|binding| decl_key_of_binding(&binding, &head))
    }

    /// Type one object entry value: the explicit expression, or the
    /// shorthand name's binding type. Returns the type and the span to
    /// blame (the value, or the key for shorthand).
    fn entry_value(
        &mut self,
        cx: &Ctx<'_, '_>,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
        expected: Option<ResolvedType>,
    ) -> (ResolvedType, Span) {
        match value {
            Some(value) => (self.expr(cx, value, expected), tight_span(cx.text, value)),
            None => {
                let binding = self
                    .tables
                    .node_binding
                    .get(&NodeKey::of(key_node))
                    .cloned();
                // A shorthand reads its binding, so continuation facts
                // on that declaration apply (T03 §6).
                if let Some(binding) = binding.as_ref()
                    && let Some(narrowed) = self.narrowed_binding(cx, binding)
                {
                    return (narrowed, tight_span(cx.text, key_node));
                }
                let ty =
                    binding.map_or(ResolvedType::Error, |b| self.type_binding(cx, key_node, &b));
                (ty, tight_span(cx.text, key_node))
            }
        }
    }

    /// Type every value of an `Object` for its side effects (enum
    /// claims, name resolution), ignoring entry meanings.
    fn walk_object_values(&mut self, cx: &Ctx<'_, '_>, object: &SyntaxNode) {
        for (_, key_node, value) in object_entries(object, cx.text) {
            self.entry_value(cx, key_node, value, None);
        }
    }

    /// Walk one effect statement, recording its binding types.
    fn walk_statement(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        if has_error(node) {
            return;
        }
        // `read=true` bodies allow only pure statements (DESIGN §5).
        if self.current_read
            && matches!(
                node.kind,
                SyntaxKind::Create
                    | SyntaxKind::Set
                    | SyntaxKind::Transition
                    | SyntaxKind::Delete
                    | SyntaxKind::Emit
                    | SyntaxKind::Send
                    | SyntaxKind::Schedule
                    | SyntaxKind::Cancel
            )
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "read operations allow only pure statements".to_string(),
                tight_span(cx.text, node),
            ));
        }
        match node.kind {
            SyntaxKind::Let => self.stmt_let(cx, node),
            SyntaxKind::Create => self.stmt_create(cx, node),
            SyntaxKind::Set => self.stmt_set(cx, node),
            SyntaxKind::Transition => self.stmt_transition(cx, node),
            SyntaxKind::Delete => self.stmt_delete(cx, node),
            SyntaxKind::Call => self.stmt_call(cx, node),
            SyntaxKind::Emit => self.stmt_emit(cx, node),
            SyntaxKind::Send => self.stmt_send(cx, node),
            SyntaxKind::Schedule => self.stmt_schedule(cx, node),
            SyntaxKind::Cancel => self.stmt_cancel(cx, node),
            SyntaxKind::Return => self.stmt_return(cx, node),
            SyntaxKind::Require => self.walk_guard(cx, node),
            SyntaxKind::If => self.stmt_if(cx, node),
            SyntaxKind::Match => self.stmt_match(cx, node),
            SyntaxKind::For => self.stmt_for(cx, node),
            _ => {}
        }
    }

    /// `let name = expr`: infer and record the value type.
    fn stmt_let(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let value = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(value) = value else {
            return;
        };
        let ty = self.expr(cx, value, None);
        self.lets.insert(NodeKey::of(node), ty);
    }

    /// `create Model {...} as name`: model target, field values with
    /// required-input and reserved-name rules.
    fn stmt_create(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        // The `as NAME` binding is parser-required.
        let parts = kids(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let model = path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
        let Some(model) = model else {
            // Resolver already reported the bad path.
            if let Some(object) = object {
                self.walk_object_values(cx, object);
            }
            return;
        };
        if !matches!(
            self.tables.symbols[model.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "create target must be a model, found {}",
                    record_name(self.tables, cx.module, model)
                ),
                tight_span(cx.text, path.unwrap_or(node)),
            ));
            if let Some(object) = object {
                self.walk_object_values(cx, object);
            }
            return;
        }
        self.creates.insert(
            NodeKey::of(node),
            ResolvedType::Record {
                symbol: model,
                stored: true,
            },
        );
        let Some(object) = object else {
            return;
        };
        self.check_create_values(cx, node, model, object);
    }

    /// Check `create` values: no reserved/server-supplied fields,
    /// known fields with compatible values, every required input. A
    /// contained model additionally takes its protected `parent`
    /// binding (DESIGN §2).
    fn check_create_values(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        object: &SyntaxNode,
    ) {
        let parent_model = match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                owner: ModelOwner::ChildOf(parent),
                ..
            } => Some(*parent),
            _ => None,
        };
        let mut seen: Vec<String> = Vec::new();
        for (key, key_node, value) in object_entries(object, cx.text) {
            if is_reserved_name(key) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("'{key}' is reserved and cannot be created"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            }
            if key == "parent" {
                self.check_create_parent(cx, node, model, parent_model, key_node, value);
                seen.push(key.to_string());
                continue;
            }
            let Some(field) = self.model_field_named(model, key) else {
                self.member_fail(
                    node,
                    tight_span(cx.text, key_node),
                    format!("model {}", record_name(self.tables, cx.module, model)),
                    key.to_string(),
                );
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            if self.machines.contains(&field) {
                self.diags.push(Diagnostic::error("E3001", format!("machine field '{key}' starts at its declared default and cannot be supplied to create"), tight_span(cx.text, key_node)));
            }
            if self.field_is_server(field) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("server-owned field '{key}' cannot be supplied"),
                    tight_span(cx.text, key_node),
                ));
            }
            seen.push(key.to_string());
            let expected = self.decl_type(field);
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
        for field in self.model_fields(model) {
            if seen
                .iter()
                .any(|k| self.tables.symbols[field.0 as usize].name == *k)
            {
                continue;
            }
            if self.field_is_required_input(field) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "missing required field '{}'",
                        self.tables.symbols[field.0 as usize].name
                    ),
                    tight_span(cx.text, object),
                ));
            }
        }
        if parent_model.is_some() && !seen.iter().any(|k| k == "parent") {
            self.diags.push(Diagnostic::error(
                "E3001",
                "missing required field 'parent'".to_string(),
                tight_span(cx.text, object),
            ));
        }
        // A default's context requirements hold at every creation path:
        // with a provably null actor (trusted handlers), actor-dependent
        // initializers cannot satisfy non-null fields (DESIGN §2).
        if self.scope_actor_is_null(object) {
            for field in self.model_fields(model) {
                let name = self.tables.symbols[field.0 as usize].name.clone();
                if seen.contains(&name) || !self.default_uses_actor.contains(&field) {
                    continue;
                }
                if !matches!(self.decl_type(field), ResolvedType::Nullable(_)) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "creation here cannot satisfy '{name}'; its initializer needs an authenticated actor"
                        ),
                        tight_span(cx.text, object),
                    ));
                }
            }
        }
    }

    /// Check a `create` `parent=` binding: only contained models take
    /// one, and it must be the containing record.
    #[allow(clippy::too_many_arguments)]
    fn check_create_parent(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        model: SymbolId,
        parent_model: Option<SymbolId>,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) {
        let Some(parent) = parent_model else {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "'{}' is not contained; only child models take parent=",
                    record_name(self.tables, cx.module, model)
                ),
                tight_span(cx.text, key_node),
            ));
            self.entry_value(cx, key_node, value, None);
            return;
        };
        let expected = ResolvedType::Record {
            symbol: parent,
            stored: true,
        };
        let (actual, value_span) = self.entry_value(cx, key_node, value, Some(expected.clone()));
        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "'parent': expected {}, found {}",
                    self.show(cx.module, &expected),
                    self.show(cx.module, &actual)
                ),
                value_span,
            ));
        }
    }

    /// Whether the scope of `node` proves a null actor (a trusted
    /// handler body).
    fn scope_actor_is_null(&self, node: &SyntaxNode) -> bool {
        let mut scope = self.tables.expr_scope.get(&NodeKey::of(node)).copied();
        while let Some(id) = scope {
            let scope_ref = &self.tables.scopes[id.0 as usize];
            if let Some(Binding::Context(ContextVar::Actor(kind))) = scope_ref.bindings.get("actor")
            {
                return matches!(kind, ActorKind::Null);
            }
            scope = scope_ref.parent;
        }
        false
    }

    /// `set target {...}`: stored-model-record target, partial values.
    fn stmt_transition(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let Some(target) = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied() else {
            return;
        };
        let Some((model, pending)) = self.mutation_target_model(cx, target, "transition") else {
            return;
        };
        let names: Vec<_> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Name)
            .copied()
            .collect();
        if names.len() != 4 {
            return;
        }
        let field_name = name_text(names[1], cx.text).unwrap_or("");
        let field = self.model_field_named(model, field_name);
        if pending || field.is_none_or(|id| !self.machines.contains(&id)) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "transition needs a machine field on a stored record; hooks cannot transition"
                    .to_string(),
                tight_span(cx.text, node),
            ));
            return;
        }
        let expected = self.decl_type(field.expect("checked field"));
        if let ResolvedType::Enum { cases, .. } = expected {
            for case in &names[2..] {
                let word = name_text(case, cx.text).unwrap_or("");
                if !cases.iter().any(|c| c == word) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("unknown machine state '{word}'"),
                        tight_span(cx.text, case),
                    ));
                }
            }
        }
    }

    fn stmt_set(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let target = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let model = target.and_then(|t| self.mutation_target_model(cx, t, "set"));
        if let Some(object) = object {
            match model {
                Some((model, pending)) => self.check_set_values(cx, node, model, object, pending),
                None => self.walk_object_values(cx, object),
            }
        }
    }

    /// Check `set` values: partial updates over known writable
    /// fields. Server-owned fields are creation-time (the server
    /// prepares them); only a hook adjusting its pending record
    /// (`pending`) may rewrite them.
    fn check_set_values(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        object: &SyntaxNode,
        pending: bool,
    ) {
        for (key, key_node, value) in object_entries(object, cx.text) {
            if is_reserved_name(key) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("'{key}' is reserved and cannot be set"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            }
            let Some(field) = self.model_field_named(model, key) else {
                self.member_fail(
                    node,
                    tight_span(cx.text, key_node),
                    format!("model {}", record_name(self.tables, cx.module, model)),
                    key.to_string(),
                );
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            if self.machines.contains(&field) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("machine field '{key}' must use transition"),
                    tight_span(cx.text, key_node),
                ));
            }
            if !pending && self.field_is_server(field) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("server-owned field '{key}' cannot be set"),
                    tight_span(cx.text, key_node),
                ));
            }
            let expected = self.decl_type(field);
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
    }

    /// `delete target`: the target must be a stored model record.
    fn stmt_delete(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        if let Some(target) = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied() {
            self.mutation_target_model(cx, target, "delete");
        }
    }

    /// Resolve a `set`/`delete` path target to its model plus
    /// whether it is a hook's pending record (`set event.after`).
    /// Returns `None` after diagnosing (or when already diagnosed).
    /// The handler-context branch is chosen by RESOLUTION (T30): an
    /// ordinary parameter/let merely named `event` takes the general
    /// path exactly as any other spelling would.
    fn mutation_target_model(
        &mut self,
        cx: &Ctx<'_, '_>,
        target: &SyntaxNode,
        what: &str,
    ) -> Option<(SymbolId, bool)> {
        if target.kind == SyntaxKind::Path {
            let segments = path_segments(target, cx.text);
            if self.path_head_is_context_event(target, &segments) {
                return self.event_mutation_target(cx, target, what, &segments);
            }
        }
        // Record the target type: effects reads it back for member-path
        // resolution (`E4001` ownership, `E4051` write evidence). The
        // call below types on the fly without recording.
        let ty = self.type_path_value(cx, target);
        let ty = self.record(target, ty);
        match ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } if matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Model { .. }
            ) =>
            {
                Some((symbol, false))
            }
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => None,
            other => {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "{what} target must be a stored model record, found {}",
                        self.show(cx.module, &other)
                    ),
                    tight_span(cx.text, target),
                ));
                None
            }
        }
    }

    /// Whether a path target's head resolves to the handler
    /// context `event` (T30 provenance: the `ContextVar::Event`
    /// binding, never the head spelling).
    fn path_head_is_context_event(&self, target: &SyntaxNode, segments: &[&str]) -> bool {
        let Some(head) = segments.first() else {
            return false;
        };
        let scope = self.tables.expr_scope.get(&NodeKey::of(target)).copied();
        matches!(
            scope.and_then(|s| self.tables.resolve_name(s, head, self.catalog)),
            Some(Binding::Context(ContextVar::Event))
        )
    }

    /// Resolve a handler-context `event`-headed `set`/`delete`
    /// target by resolved provenance (T30): `event.after` adjusts
    /// the pending create/update record; a path resolving to a
    /// stored model record (a verified declared reference such as
    /// `event.check`, or a live row reached through payload members)
    /// mutates that row exactly as a let-aliased path would; the
    /// snapshot itself (`event.before`), the whole payload, opaque
    /// members and value data are read-only (`E3009`).
    fn event_mutation_target(
        &mut self,
        cx: &Ctx<'_, '_>,
        target: &SyntaxNode,
        what: &str,
        segments: &[&str],
    ) -> Option<(SymbolId, bool)> {
        if segments.len() == 2 && segments[1] == "after" {
            return self.hook_record_target(cx, target, what);
        }
        // The snapshot itself is immutable (DESIGN §6) even though it
        // types as the hooked record; rows reachable THROUGH payload
        // members resolve on their own provenance below.
        if segments.len() == 2 && segments[1] == "before" {
            return self.event_target_readonly(cx, target, what, segments);
        }
        // Record the target type: effects reads it back for member-path
        // resolution (`E4001` ownership, `E4051` write evidence). The
        // call below types on the fly without recording.
        let ty = self.type_path_value(cx, target);
        let ty = self.record(target, ty);
        match ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } if matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Model { .. }
            ) =>
            {
                Some((symbol, false))
            }
            ResolvedType::Error => None,
            _ => self.event_target_readonly(cx, target, what, segments),
        }
    }

    /// `E3009` for a read-only event target: the payload, a snapshot,
    /// an opaque member, or value data. Only `event.after` adjusts
    /// the pending record.
    fn event_target_readonly(
        &mut self,
        cx: &Ctx<'_, '_>,
        target: &SyntaxNode,
        what: &str,
        segments: &[&str],
    ) -> Option<(SymbolId, bool)> {
        self.diags.push(Diagnostic::error(
            "E3009",
            format!(
                "{} target '{}' is read-only; only event.after adjusts the pending record",
                what,
                segments.join(".")
            ),
            tight_span(cx.text, target),
        ));
        None
    }

    /// Resolve an `event.after` mutation target: `set event.after`
    /// adjusts the pending create/update record (DESIGN §6); the
    /// pending record cannot be deleted, and a delete hook can
    /// reject but cannot adjust its target.
    fn hook_record_target(
        &mut self,
        cx: &Ctx<'_, '_>,
        target: &SyntaxNode,
        what: &str,
    ) -> Option<(SymbolId, bool)> {
        if what == "delete" {
            self.diags.push(Diagnostic::error(
                "E3009",
                "cannot delete the pending record; reject it with require".to_string(),
                tight_span(cx.text, target),
            ));
            return None;
        }
        match self.current_hook {
            Some((model, CrudOp::Create | CrudOp::Update)) => Some((model, true)),
            Some(_) => {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    "a delete hook can reject but cannot adjust its target".to_string(),
                    tight_span(cx.text, target),
                ));
                None
            }
            None => {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    "event.after is only writable in a create/update hook".to_string(),
                    tight_span(cx.text, target),
                ));
                None
            }
        }
    }

    /// Generated hook-payload side type (T30/C6, DESIGN §6): in a
    /// pre-commit hook, `event.after`/`event.before` carry the hooked
    /// model's record instead of `{opaque}`, so hook reads and
    /// `parent=event.after` check against the real record. On create
    /// `before` is null; on delete `after` is unknown (an archived
    /// record has it, a removed record nulls it), so it stays
    /// opaque. `None` outside hooks and for all other members.
    fn hook_payload_side(&self, name: &str) -> Option<ResolvedType> {
        let (model, op) = self.current_hook?;
        match name {
            "after" => match op {
                CrudOp::Create | CrudOp::Update => Some(ResolvedType::Record {
                    symbol: model,
                    stored: true,
                }),
                CrudOp::Delete => None,
            },
            "before" => match op {
                CrudOp::Create => Some(ResolvedType::Null),
                CrudOp::Update | CrudOp::Delete => Some(ResolvedType::Record {
                    symbol: model,
                    stored: true,
                }),
            },
            _ => None,
        }
    }

    /// `call target {...} [as name]`: operation or action target,
    /// bindings against the remaining inputs, result recording.
    fn stmt_call(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let target = parts.iter().find(|n| is_expression(n.kind)).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let Some(target) = target else {
            return;
        };
        let ty = self.expr(cx, target, None);
        match ty {
            ResolvedType::Operation(id) => self.call_operation(cx, node, target, id, object),
            // External members have no local schemas, so `call`
            // checks cover the local targets only (the provider
            // package is absent by definition).
            ResolvedType::Action { targets, bound, .. } => {
                self.call_action(cx, node, target, &targets, bound.as_deref(), object);
            }
            ResolvedType::Invocation { targets } => {
                self.call_invocation(cx, node, target, &targets, object);
            }
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
                self.calls
                    .insert(NodeKey::of(node), ResolvedType::Opaque("unresolved call"));
            }
            other => {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!(
                        "call target must be an operation, action or invocation, found {}",
                        self.show(cx.module, &other)
                    ),
                    tight_span(cx.text, target),
                ));
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
            }
        }
    }

    /// `call` against one operation: kind checks, bindings, result.
    fn call_operation(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        target: &SyntaxNode,
        id: SymbolId,
        object: Option<&SyntaxNode>,
    ) {
        // A hook cannot call back into its triggering CRUD operation.
        if let SymbolKind::CrudOp { model, op } = &self.tables.symbols[id.0 as usize].kind
            && self.current_hook == Some((*model, *op))
        {
            self.diags.push(Diagnostic::error(
                "E3005",
                "a hook cannot call back into its triggering operation".to_string(),
                tight_span(cx.text, target),
            ));
        }
        // Read operations cannot invoke mutations.
        if self.current_read && !self.callee_is_read(id) {
            self.diags.push(Diagnostic::error(
                "E3005",
                "read operations cannot invoke mutations".to_string(),
                tight_span(cx.text, target),
            ));
        }
        match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Scenario { trusted, .. } => {
                if *trusted {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!(
                            "cannot call trusted handler '{}'; handlers run on their trigger",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, target),
                    ));
                    if let Some(object) = object {
                        self.walk_object_values(cx, object);
                    }
                    return;
                }
                self.record_call_edge(tight_span(cx.text, target), id);
                let params = match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::Scenario { params, .. } => params.clone(),
                    _ => Vec::new(),
                };
                self.check_op_bindings(cx, node, id, &params, object, "E3009");
                let result = self.results.get(&id).cloned().unwrap_or(None);
                match result {
                    Some(ty) => {
                        self.calls.insert(NodeKey::of(node), ty);
                    }
                    None => {
                        if has_as_binding(node, cx.text) {
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!(
                                    "void operation '{}' has no result to bind",
                                    record_name(self.tables, cx.module, id)
                                ),
                                tight_span(cx.text, node),
                            ));
                        }
                        self.calls.insert(NodeKey::of(node), ResolvedType::Error);
                    }
                }
            }
            SymbolKind::CapabilityOp { params, .. } => {
                let params = params.clone();
                self.record_call_edge(tight_span(cx.text, target), id);
                self.check_op_bindings(cx, node, id, &params, object, "E3009");
                let result = self.results.get(&id).cloned().unwrap_or(None);
                self.calls.insert(
                    NodeKey::of(node),
                    result.unwrap_or(ResolvedType::Opaque("unresolved capability result")),
                );
            }
            SymbolKind::CrudOp { model, op } => {
                let (model, op) = (*model, *op);
                if !self.crud_op_enabled(model, op) {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!(
                            "'{}' is not enabled by its crud declaration",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, target),
                    ));
                    if let Some(object) = object {
                        self.walk_object_values(cx, object);
                    }
                    return;
                }
                self.record_call_edge(tight_span(cx.text, target), id);
                self.check_crud_bindings(cx, node, model, op, object);
                // Generated CRUD results are schemed in PR5.
                self.calls.insert(
                    NodeKey::of(node),
                    ResolvedType::Opaque("generated CRUD result"),
                );
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!(
                        "'{}' is not a callable operation",
                        record_name(self.tables, cx.module, id)
                    ),
                    tight_span(cx.text, target),
                ));
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
            }
        }
    }

    /// Whether a `call` target is invokable from a read body: only
    /// `read=true` scenarios.
    fn callee_is_read(&self, id: SymbolId) -> bool {
        matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::Scenario { .. }
        ) && self.read_scenarios.contains(&id)
    }

    /// Call schema of one action target: scenario/capability
    /// parameters, or the normalized CRUD inputs (creation fields
    /// plus the contained `parent`; update `record`/`changes`; delete
    /// `record`). Reserved and server-owned creation fields are not
    /// suppliable, so they are absent.
    fn action_inputs(&self, op: SymbolId) -> Vec<ActionInput> {
        match &self.tables.symbols[op.0 as usize].kind {
            SymbolKind::Scenario { params, .. } | SymbolKind::CapabilityOp { params, .. } => params
                .iter()
                .map(|p| ActionInput {
                    name: self.tables.symbols[p.0 as usize].name.clone(),
                    expected: Some(self.decl_type(*p)),
                    required: !self.param_has_default(*p),
                })
                .collect(),
            SymbolKind::CrudOp { model, op } => {
                let (model, op) = (*model, *op);
                match op {
                    CrudOp::Create => {
                        let mut inputs: Vec<ActionInput> = self
                            .model_fields(model)
                            .iter()
                            .filter(|f| {
                                let name = self.tables.symbols[f.0 as usize].name.as_str();
                                !is_reserved_name(name) && !self.field_is_server(**f)
                            })
                            .map(|f| ActionInput {
                                name: self.tables.symbols[f.0 as usize].name.clone(),
                                expected: Some(self.decl_type(*f)),
                                required: self.field_is_required_input(*f),
                            })
                            .collect();
                        if let SymbolKind::Model {
                            owner: ModelOwner::ChildOf(parent),
                            ..
                        } = &self.tables.symbols[model.0 as usize].kind
                        {
                            inputs.push(ActionInput {
                                name: "parent".to_string(),
                                expected: Some(ResolvedType::Record {
                                    symbol: *parent,
                                    stored: true,
                                }),
                                required: true,
                            });
                        }
                        inputs
                    }
                    CrudOp::Update => vec![
                        ActionInput {
                            name: "record".to_string(),
                            expected: Some(ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            }),
                            required: true,
                        },
                        ActionInput {
                            name: "changes".to_string(),
                            expected: None,
                            required: true,
                        },
                    ],
                    CrudOp::Delete => vec![ActionInput {
                        name: "record".to_string(),
                        expected: Some(ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        }),
                        required: true,
                    }],
                }
            }
            _ => Vec::new(),
        }
    }

    /// `call` against an action value: bindings must fit every
    /// target's inputs. Pre-bound inputs (DESIGN §2.1: every record
    /// parameter, bound at construction) are satisfied; other
    /// required inputs missing here are `E3009`. Values of unknown
    /// provenance (`bound` `None`, e.g. action-typed parameters) stay
    /// lenient on missing inputs.
    fn call_action(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        _target: &SyntaxNode,
        targets: &[SymbolId],
        bound: Option<&[String]>,
        object: Option<&SyntaxNode>,
    ) {
        // Action targets are user mutations; reads cannot invoke them.
        if self.current_read && !targets.is_empty() {
            self.diags.push(Diagnostic::error(
                "E3005",
                "read operations cannot invoke mutations".to_string(),
                tight_span(cx.text, node),
            ));
        }
        if targets.is_empty() {
            if let Some(object) = object {
                self.walk_object_values(cx, object);
            }
            self.calls
                .insert(NodeKey::of(node), ResolvedType::Opaque("empty action call"));
            return;
        }
        let schemas: Vec<Vec<ActionInput>> =
            targets.iter().map(|op| self.action_inputs(*op)).collect();
        let mut seen: Vec<String> = Vec::new();
        // Every binding key must fit every target's schema.
        if let Some(object) = object {
            for (key, key_node, value) in object_entries(object, cx.text) {
                seen.push(key.to_string());
                if !schemas
                    .iter()
                    .all(|schema| schema.iter().any(|input| input.name == key))
                {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!("'{key}' is not an input of every action target"),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                    continue;
                }
                self.check_action_value(cx, node, targets[0], &schemas[0], key, key_node, value);
            }
        }
        // Missing required inputs are errors only when the bound set is
        // known (constructor values); unknown provenance stays lenient.
        if let Some(bound) = bound {
            for (op, schema) in targets.iter().zip(schemas.iter()) {
                for input in schema {
                    if !input.required
                        || seen.iter().any(|k| k == &input.name)
                        || bound.iter().any(|k| k == &input.name)
                    {
                        continue;
                    }
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!(
                            "missing required input '{}' to '{}'",
                            input.name,
                            record_name(self.tables, cx.module, *op)
                        ),
                        tight_span(cx.text, object.unwrap_or(node)),
                    ));
                }
            }
        }
        self.calls.insert(
            NodeKey::of(node),
            ResolvedType::Opaque("action call result"),
        );
    }

    /// Check one supplied action-call value against the first target's
    /// schema entry: typed values match their expectation (`E3001`
    /// otherwise); `changes` checks as partial set-values.
    #[allow(clippy::too_many_arguments)]
    fn check_action_value(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: SymbolId,
        schema: &[ActionInput],
        key: &str,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) {
        let Some(input) = schema.iter().find(|input| input.name == key) else {
            self.entry_value(cx, key_node, value, None);
            return;
        };
        let SymbolKind::CrudOp { model, op } = &self.tables.symbols[op.0 as usize].kind else {
            let expected = input.expected.clone().expect("scenario input type");
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
            return;
        };
        let (model, op) = (*model, *op);
        match (&input.expected, key) {
            (Some(expected), _) => {
                let (actual, value_span) =
                    self.entry_value(cx, key_node, value, Some(expected.clone()));
                if !actual.is_error() && !self.types_compatible(&actual, expected) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "'{key}': expected {}, found {}",
                            self.show(cx.module, expected),
                            self.show(cx.module, &actual)
                        ),
                        value_span,
                    ));
                }
            }
            (None, "changes") if matches!(op, CrudOp::Update) => match value {
                Some(v) if v.kind == SyntaxKind::Object => {
                    self.check_set_values(cx, node, model, v, false);
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "'changes' must be an object of field updates".to_string(),
                        tight_span(cx.text, key_node),
                    ));
                }
            },
            (None, _) => {
                self.entry_value(cx, key_node, value, None);
            }
        }
    }

    /// `call` against an invocation value (DESIGN §2.2): the value
    /// carries complete arguments, so `call value {}` takes no
    /// replacement inputs; any supplied key is `E3009`. Like action
    /// calls, no call edge is recorded (see [`Typer::call_action`]).
    fn call_invocation(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        _target: &SyntaxNode,
        targets: &[SymbolId],
        object: Option<&SyntaxNode>,
    ) {
        // Invocation targets are user mutations; reads cannot invoke them.
        if self.current_read && !targets.is_empty() {
            self.diags.push(Diagnostic::error(
                "E3005",
                "read operations cannot invoke mutations".to_string(),
                tight_span(cx.text, node),
            ));
        }
        if let Some(object) = object {
            for (key, key_node, value) in object_entries(object, cx.text) {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!(
                        "invocation carries complete arguments; '{key}' supplies no replacement"
                    ),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
            }
        }
        // The singleton target's result when it is statically known.
        let result = match targets {
            [op] => match &self.tables.symbols[op.0 as usize].kind {
                SymbolKind::Scenario { .. } => {
                    match self.results.get(op).cloned().unwrap_or(None) {
                        Some(ty) => ty,
                        None => {
                            if has_as_binding(node, cx.text) {
                                self.diags.push(Diagnostic::error(
                                    "E3009",
                                    format!(
                                        "void operation '{}' has no result to bind",
                                        record_name(self.tables, cx.module, *op)
                                    ),
                                    tight_span(cx.text, node),
                                ));
                            }
                            ResolvedType::Error
                        }
                    }
                }
                SymbolKind::CrudOp { .. } => ResolvedType::Opaque("generated CRUD result"),
                _ => ResolvedType::Opaque("invocation call result"),
            },
            _ => ResolvedType::Opaque("invocation call result"),
        };
        self.calls.insert(NodeKey::of(node), result);
    }

    /// Check a bindings object against operation parameters: unknown
    /// and missing inputs are `code` (`E3009`/`E3010`), value
    /// mismatches are `E3001`.
    fn check_op_bindings(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: SymbolId,
        params: &[SymbolId],
        object: Option<&SyntaxNode>,
        code: &'static str,
    ) {
        let mut seen: Vec<String> = Vec::new();
        if let Some(object) = object {
            for (key, key_node, value) in object_entries(object, cx.text) {
                let Some(param) = params
                    .iter()
                    .find(|p| self.tables.symbols[p.0 as usize].name == key)
                else {
                    self.diags.push(Diagnostic::error(
                        code,
                        format!(
                            "'{}' has no input '{key}'",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                    continue;
                };
                seen.push(key.to_string());
                let expected = self.decl_type(*param);
                let (actual, value_span) =
                    self.entry_value(cx, key_node, value, Some(expected.clone()));
                if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "'{key}': expected {}, found {}",
                            self.show(cx.module, &expected),
                            self.show(cx.module, &actual)
                        ),
                        value_span,
                    ));
                }
            }
        }
        for param in params {
            let name = self.tables.symbols[param.0 as usize].name.clone();
            if seen.contains(&name) || self.param_has_default(*param) {
                continue;
            }
            self.diags.push(Diagnostic::error(
                code,
                format!(
                    "missing required input '{name}' to '{}'",
                    record_name(self.tables, cx.module, id)
                ),
                tight_span(cx.text, object.unwrap_or(node)),
            ));
        }
    }

    /// Check `call` bindings against a generated CRUD operation.
    fn check_crud_bindings(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        op: CrudOp,
        object: Option<&SyntaxNode>,
    ) {
        match op {
            CrudOp::Create => {
                // Creation inputs are the model fields.
                if let Some(object) = object {
                    self.check_create_values(cx, node, model, object);
                } else {
                    self.check_create_values_empty(cx, node, model);
                }
            }
            CrudOp::Update => {
                let Some(object) = object else {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "update needs {record, changes}".to_string(),
                        tight_span(cx.text, node),
                    ));
                    return;
                };
                let mut seen_record = false;
                let mut seen_changes = false;
                for (key, key_node, value) in object_entries(object, cx.text) {
                    match key {
                        "record" => {
                            seen_record = true;
                            let (actual, value_span) = self.entry_value(cx, key_node, value, None);
                            let want = ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            };
                            if !actual.is_error() && !self.types_compatible(&actual, &want) {
                                self.diags.push(Diagnostic::error(
                                    "E3001",
                                    format!(
                                        "'record': expected {}, found {}",
                                        self.show(cx.module, &want),
                                        self.show(cx.module, &actual)
                                    ),
                                    value_span,
                                ));
                            }
                        }
                        "changes" => {
                            seen_changes = true;
                            match value {
                                Some(v) if v.kind == SyntaxKind::Object => {
                                    self.check_set_values(cx, node, model, v, false);
                                }
                                _ => {
                                    self.diags.push(Diagnostic::error(
                                        "E3009",
                                        "'changes' must be an object of field updates".to_string(),
                                        tight_span(cx.text, key_node),
                                    ));
                                }
                            }
                        }
                        _ => {
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!("update takes only record/changes, found '{key}'"),
                                tight_span(cx.text, key_node),
                            ));
                            self.entry_value(cx, key_node, value, None);
                        }
                    }
                }
                if !seen_record {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "update needs a record input".to_string(),
                        tight_span(cx.text, object),
                    ));
                }
                if !seen_changes {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "update needs a changes input".to_string(),
                        tight_span(cx.text, object),
                    ));
                }
            }
            CrudOp::Delete => {
                let Some(object) = object else {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "delete needs {record}".to_string(),
                        tight_span(cx.text, node),
                    ));
                    return;
                };
                let mut seen_record = false;
                for (key, key_node, value) in object_entries(object, cx.text) {
                    if key != "record" {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            format!("delete takes only record, found '{key}'"),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                        continue;
                    }
                    seen_record = true;
                    let (actual, value_span) = self.entry_value(cx, key_node, value, None);
                    let want = ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    };
                    if !actual.is_error() && !self.types_compatible(&actual, &want) {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!(
                                "'record': expected {}, found {}",
                                self.show(cx.module, &want),
                                self.show(cx.module, &actual)
                            ),
                            value_span,
                        ));
                    }
                }
                if !seen_record {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "delete needs a record input".to_string(),
                        tight_span(cx.text, object),
                    ));
                }
            }
        }
    }

    /// Required-input check for a `create` call without a values
    /// object (all required fields missing).
    fn check_create_values_empty(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, model: SymbolId) {
        for field in self.model_fields(model) {
            if self.field_is_required_input(field) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "missing required field '{}'",
                        self.tables.symbols[field.0 as usize].name
                    ),
                    tight_span(cx.text, node),
                ));
            }
        }
    }

    /// Record a caller-to-callee edge for the call-cycle check.
    fn record_call_edge(&mut self, span: Span, callee: SymbolId) {
        if let Some(caller) = self.current_op {
            self.call_edges.push((caller, callee, span));
        }
    }

    /// `emit Event {...}`: event target with complete field values.
    fn stmt_emit(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let path = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let event = path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
        let Some(event) = event else {
            if let Some(object) = object {
                self.walk_object_values(cx, object);
            }
            return;
        };
        if !matches!(
            self.tables.symbols[event.0 as usize].kind,
            SymbolKind::Event { .. }
        ) {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "emit target must be an event, found {}",
                    record_name(self.tables, cx.module, event)
                ),
                tight_span(cx.text, path.unwrap_or(node)),
            ));
            if let Some(object) = object {
                self.walk_object_values(cx, object);
            }
            return;
        }
        if let Some(object) = object {
            self.check_event_values(cx, node, event, object);
        }
    }

    /// Check event values: known fields with compatible values, every
    /// field present (events carry complete data).
    fn check_event_values(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        event: SymbolId,
        object: &SyntaxNode,
    ) {
        let mut seen: Vec<String> = Vec::new();
        for (key, key_node, value) in object_entries(object, cx.text) {
            let Some(field) = self.event_field_named(event, key) else {
                self.member_fail(
                    node,
                    tight_span(cx.text, key_node),
                    format!("event {}", record_name(self.tables, cx.module, event)),
                    key.to_string(),
                );
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            seen.push(key.to_string());
            let expected = self.decl_type(field);
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
        for field in self.record_fields(event) {
            if seen
                .iter()
                .any(|k| self.tables.symbols[field.0 as usize].name == *k)
            {
                continue;
            }
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "missing event field '{}'",
                    self.tables.symbols[field.0 as usize].name
                ),
                tight_span(cx.text, object),
            ));
        }
    }

    /// `send Target {...} [when=...] as name`: delivery target with
    /// bindings, dispatch guard and receipt binding.
    fn stmt_send(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        // The `as NAME` delivery binding is parser-required.
        let parts = kids(node);
        let target = parts.iter().find(|n| is_expression(n.kind)).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let Some(target) = target else {
            return;
        };
        let ty = self.expr(cx, target, None);
        match ty {
            ResolvedType::Operation(id) => {
                if !self.send_target_ok(cx, target, id) {
                    if let Some(object) = object {
                        self.walk_object_values(cx, object);
                    }
                } else {
                    let params = match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::Scenario { params, .. }
                        | SymbolKind::CapabilityOp { params, .. } => params.clone(),
                        _ => Vec::new(),
                    };
                    self.check_op_bindings(cx, node, id, &params, object, "E3010");
                    self.sends
                        .insert(NodeKey::of(node), ResolvedType::Delivery { op: id });
                }
            }
            ResolvedType::Opaque(_) => {
                // T14: a `send` to a T13-known `std` operation checks
                // its bindings against the consumed owner schema; an
                // unknown op of a known capability is a wrong
                // association (`E3010`); anything without a consumed
                // schema stays `E3019`.
                match self.resolve_std_send_target(cx, target) {
                    StdTarget::Known {
                        op,
                        display,
                        capability,
                    } => {
                        self.check_std_send_bindings(cx, node, op, &display, object);
                        // T14c: the receipt carries its operation
                        // identity (cross-target associations fail;
                        // unknown positions stay opaque below).
                        self.sends.insert(
                            NodeKey::of(node),
                            ResolvedType::StdDelivery { capability, op },
                        );
                    }
                    StdTarget::WrongOp { capability, op } => {
                        self.diags.push(Diagnostic::error(
                            "E3010",
                            format!(
                                "'{capability}' has no sendable operation '{op}'; the delivery association names an operation outside the owner schema"
                            ),
                            tight_span(cx.text, target),
                        ));
                        if let Some(object) = object {
                            self.walk_object_values(cx, object);
                        }
                    }
                    StdTarget::NoSchema => {
                        // A deployment-bound (external) target has no
                        // signature to check the bindings against: the
                        // receipt is silently opaque without this
                        // diagnostic.
                        if let Some(name) = self.external_target_name(cx, target) {
                            self.diags.push(Diagnostic::error(
                                "E3019",
                                format!(
                                    "cannot verify send to '{name}': deployment-bound capability signatures are opaque; the delivery receipt is unchecked"
                                ),
                                tight_span(cx.text, target),
                            ));
                        }
                        if let Some(object) = object {
                            self.walk_object_values(cx, object);
                        }
                        self.sends
                            .insert(NodeKey::of(node), ResolvedType::Opaque("unresolved send"));
                    }
                }
            }
            ResolvedType::Error | ResolvedType::Unknown => {
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
                self.sends
                    .insert(NodeKey::of(node), ResolvedType::Opaque("unresolved send"));
            }
            other => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!(
                        "send target must be a capability operation or an exported scenario, found {}",
                        self.show(cx.module, &other)
                    ),
                    tight_span(cx.text, target),
                ));
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
            }
        }
        if let Some(when) = bare_keyword_value(node, "when", cx.text) {
            let ty = self.expr(cx, when, None);
            self.expect_bool(cx, tight_span(cx.text, when), &ty, "`when`");
            self.check_when_pure(cx, when);
        }
    }

    /// Dotted name of a `send` target rooted at a deployment-bound
    /// (external) import, if it is one.
    fn external_target_name(&self, cx: &Ctx<'_, '_>, target: &SyntaxNode) -> Option<String> {
        match target.kind {
            SyntaxKind::NameRef => match self.tables.node_binding.get(&NodeKey::of(target)) {
                Some(Binding::External { .. }) => nameref_word(target, cx.text).map(str::to_string),
                _ => None,
            },
            SyntaxKind::Member => {
                let parts = kids(target);
                if parts.len() < 3 {
                    return None;
                }
                let head = self.external_target_name(cx, parts[0])?;
                let name = name_text(parts[2], cx.text)?;
                Some(format!("{head}.{name}"))
            }
            SyntaxKind::Group => kids(target)
                .iter()
                .find(|n| is_expression(n.kind))
                .and_then(|n| self.external_target_name(cx, n)),
            _ => None,
        }
    }

    /// Resolve a `send` target rooted at a deployment-bound import
    /// against the consumed T13 owner schemas (T14).
    fn resolve_std_send_target(&self, cx: &Ctx<'_, '_>, target: &SyntaxNode) -> StdTarget {
        let Some((provider, member, op, display)) = self.external_op_spelling(cx, target) else {
            return StdTarget::NoSchema;
        };
        if provider != "std" {
            return StdTarget::NoSchema;
        }
        let Some(cap) = std_capability(&member) else {
            return StdTarget::NoSchema;
        };
        match cap.operations.iter().find(|operation| operation.name == op) {
            Some(op) => StdTarget::Known {
                op,
                display,
                capability: cap.name,
            },
            None => StdTarget::WrongOp {
                capability: cap.name.to_string(),
                op,
            },
        }
    }

    /// Dotted external `Cap.op` target as (provider, member, op) plus
    /// the author display spelling, when the target is a single-level
    /// member access rooted at a deployment-bound import. Deeper
    /// chains are not send targets and stay on the opaque path.
    fn external_op_spelling(
        &self,
        cx: &Ctx<'_, '_>,
        target: &SyntaxNode,
    ) -> Option<(String, String, String, String)> {
        match target.kind {
            SyntaxKind::Member => {
                let parts = kids(target);
                if parts.len() != 3 || parts[0].kind != SyntaxKind::NameRef {
                    return None;
                }
                let Binding::External { provider, name } = self
                    .tables
                    .node_binding
                    .get(&NodeKey::of(parts[0]))
                    .cloned()?
                else {
                    return None;
                };
                let op = name_text(parts[2], cx.text)?.to_string();
                let head = nameref_word(parts[0], cx.text)?;
                let display = format!("{head}.{op}");
                Some((provider, name, op, display))
            }
            SyntaxKind::Group => kids(target)
                .iter()
                .find(|n| is_expression(n.kind))
                .and_then(|n| self.external_op_spelling(cx, n)),
            _ => None,
        }
    }

    /// Check `send` bindings against a consumed T13 operation schema
    /// (T14): unknown inputs and missing required inputs are `E3010`,
    /// value mismatches are `E3001` — the same codes as local
    /// operations (`check_op_bindings`). Requiredness follows
    /// `std_send_requires_input` (B9); nominal-typed values are
    /// presence-checked only (see `std_schema_type`).
    fn check_std_send_bindings(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: &'static StdOperation,
        display: &str,
        object: Option<&SyntaxNode>,
    ) {
        let mut seen: Vec<String> = Vec::new();
        if let Some(object) = object {
            for (key, key_node, value) in object_entries(object, cx.text) {
                let found = op.inputs.iter().find(|input| input.0 == key);
                let Some(&(_, declared)) = found else {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("'{display}' has no input '{key}'"),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                    continue;
                };
                seen.push(key.to_string());
                let Some(expected) = std_schema_type(declared) else {
                    self.entry_value(cx, key_node, value, None);
                    continue;
                };
                let (actual, value_span) =
                    self.entry_value(cx, key_node, value, Some(expected.clone()));
                if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "'{key}': expected {}, found {}",
                            self.show(cx.module, &expected),
                            self.show(cx.module, &actual)
                        ),
                        value_span,
                    ));
                }
            }
        }
        for (name, declared) in op.inputs {
            if seen.iter().any(|s| s == name) || !std_send_requires_input(declared) {
                continue;
            }
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("missing required input '{name}' to '{display}'"),
                tight_span(cx.text, object.unwrap_or(node)),
            ));
        }
    }

    /// Resolve a fixture recipe head over a deployment-bound import
    /// against the consumed T13 owner schemas (T14). Only
    /// two-segment `Alias.op` heads resolve; bare aliases name no
    /// operation and stay on the opaque path.
    fn resolve_std_recipe_head(
        &self,
        module: ModuleId,
        head: &SyntaxNode,
        text: &str,
    ) -> StdTarget {
        let segments = path_segments(head, text);
        if segments.len() != 2 {
            return StdTarget::NoSchema;
        }
        let scopes = &self.tables.module_scopes[module.0 as usize];
        let Some(ScopedName::External { provider, name }) = scopes.prod.get(segments[0]) else {
            return StdTarget::NoSchema;
        };
        if provider != "std" {
            return StdTarget::NoSchema;
        }
        let Some(cap) = std_capability(name) else {
            return StdTarget::NoSchema;
        };
        match cap
            .operations
            .iter()
            .find(|operation| operation.name == segments[1])
        {
            Some(op) => StdTarget::Known {
                op,
                display: segments.join("."),
                capability: cap.name,
            },
            None => StdTarget::WrongOp {
                capability: cap.name.to_string(),
                op: segments[1].to_string(),
            },
        }
    }

    /// Check a delivery recipe over a consumed T13 operation (T14):
    /// the same four attributes and envelope consistency as local
    /// operation recipes (`E3015`), with `request=` validated against
    /// the owner schema inputs.
    fn check_std_recipe(
        &mut self,
        cx: &Ctx<'_, '_>,
        object: &SyntaxNode,
        op: &'static StdOperation,
        display: &str,
    ) {
        let mut request = None;
        let mut status = None;
        let mut result = None;
        let mut error = None;
        for (key, key_node, value) in object_entries(object, cx.text) {
            match key {
                "request" => request = Some((key_node, value)),
                "status" => status = Some((key_node, value)),
                "result" => result = Some((key_node, value)),
                "error" => error = Some((key_node, value)),
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!(
                            "unknown delivery recipe attribute '{key}'; only request=, status=, result= and error= are accepted"
                        ),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                }
            }
        }
        match request {
            Some((_, Some(request))) if request.kind == SyntaxKind::Object => {
                self.check_std_recipe_request(cx, op, display, request);
            }
            Some((key_node, _)) => {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    "delivery recipes need a complete request={...}".to_string(),
                    tight_span(cx.text, key_node),
                ));
            }
            None => {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    "delivery recipes need a complete request={...}".to_string(),
                    tight_span(cx.text, object),
                ));
            }
        }
        self.check_fixture_envelope(cx, object, status, result, error);
    }

    /// Check a T13 delivery recipe `request=` against the owner
    /// schema inputs (T14a): unknown inputs, value mismatches and
    /// missing required inputs are `E3015`, mirroring local
    /// `check_fixture_request`. Requiredness follows
    /// `std_recipe_requires_input`; nominal-typed values are
    /// presence-checked only (see `std_schema_type`).
    fn check_std_recipe_request(
        &mut self,
        cx: &Ctx<'_, '_>,
        op: &'static StdOperation,
        display: &str,
        request: &SyntaxNode,
    ) {
        let mut seen: Vec<String> = Vec::new();
        for (key, key_node, value) in object_entries(request, cx.text) {
            let found = op.inputs.iter().find(|input| input.0 == key);
            let Some(&(_, declared)) = found else {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("unknown request input '{key}' for {display}"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            seen.push(key.to_string());
            let Some(expected) = std_schema_type(declared) else {
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
        for (name, declared) in op.inputs {
            if seen.iter().any(|s| s == name) || !std_recipe_requires_input(declared) {
                continue;
            }
            self.diags.push(Diagnostic::error(
                "E3015",
                format!("request is missing required input '{name}'"),
                tight_span(cx.text, request),
            ));
        }
    }

    /// Whether an operation may be a `send` target: a bound
    /// capability operation or a bound exported user operation
    /// (DESIGN §8.1).
    fn send_target_ok(&mut self, cx: &Ctx<'_, '_>, target: &SyntaxNode, id: SymbolId) -> bool {
        match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::CapabilityOp { .. } => true,
            SymbolKind::Scenario { trusted, .. } => {
                if *trusted {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        "cannot send to a trusted handler".to_string(),
                        tight_span(cx.text, target),
                    ));
                    return false;
                }
                if !self.tables.symbols[id.0 as usize].exported {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!(
                            "cannot send to '{}'; send targets must be exported scenarios",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, target),
                    ));
                    return false;
                }
                true
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!(
                        "'{}' is not a send target; send needs a capability operation or an exported scenario",
                        record_name(self.tables, cx.module, id)
                    ),
                    tight_span(cx.text, target),
                ));
                false
            }
        }
    }

    /// `schedule key at=... event=Path {...}`: text key, datetime
    /// instant, complete event values.
    fn stmt_schedule(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let key = parts.iter().find(|n| is_expression(n.kind)).copied();
        if let Some(key) = key {
            let ty = self.expr(cx, key, None);
            let want = ResolvedType::Scalar(Scalar::Text);
            if !ty.is_error() && !self.types_compatible(&ty, &want) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "schedule key must be text, found {}",
                        self.show(cx.module, &ty)
                    ),
                    tight_span(cx.text, key),
                ));
            }
            self.check_schedule_key_unique(cx, key);
        }
        if let Some(at) = bare_keyword_value(node, "at", cx.text) {
            let ty = self.expr(cx, at, None);
            let want = ResolvedType::Scalar(Scalar::Datetime);
            if !ty.is_error() && !self.types_compatible(&ty, &want) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "schedule at= must be datetime, found {}",
                        self.show(cx.module, &ty)
                    ),
                    tight_span(cx.text, at),
                ));
            }
        }
        // The event path follows `event =` (mirror resolve); the key
        // is an expression and never a bare `Path`.
        let mut event_path = None;
        for (i, part) in parts.iter().enumerate() {
            if is_name(part, cx.text, "event") {
                event_path = parts.get(i + 2).copied();
            }
        }
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let event = event_path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
        match event {
            Some(event)
                if matches!(
                    self.tables.symbols[event.0 as usize].kind,
                    SymbolKind::Event { .. }
                ) =>
            {
                if let Some(object) = object {
                    self.check_event_values(cx, node, event, object);
                }
            }
            Some(event) => {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "schedule event must be an event, found {}",
                        record_name(self.tables, cx.module, event)
                    ),
                    tight_span(cx.text, event_path.unwrap_or(node)),
                ));
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
            }
            None => {
                if let Some(object) = object {
                    self.walk_object_values(cx, object);
                }
            }
        }
    }

    /// Literal schedule keys are unique within their module (DESIGN
    /// §8: a dynamic key is unique within app/owner/package).
    fn check_schedule_key_unique(&mut self, cx: &Ctx<'_, '_>, key: &SyntaxNode) {
        let Some(value) = string_literal_value(key) else {
            return;
        };
        let slot = (cx.module, value.clone());
        if let Some(first) = self.schedule_keys.get(&slot) {
            let mut diagnostic = Diagnostic::error(
                "E3001",
                format!("duplicate schedule key '{value}'"),
                tight_span(cx.text, key),
            );
            diagnostic.related.push(Related {
                span: *first,
                message: "first use here".to_string(),
            });
            self.diags.push(diagnostic);
        } else {
            self.schedule_keys.insert(slot, tight_span(cx.text, key));
        }
    }

    /// `cancel expr`: the key must be text.
    fn stmt_cancel(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        if let Some(key) = parts.iter().find(|n| is_expression(n.kind)).copied() {
            let ty = self.expr(cx, key, None);
            let want = ResolvedType::Scalar(Scalar::Text);
            if !ty.is_error() && !self.types_compatible(&ty, &want) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "cancel key must be text, found {}",
                        self.show(cx.module, &ty)
                    ),
                    tight_span(cx.text, key),
                ));
            }
        }
    }

    /// `return expr`: against the enclosing scenario's result.
    fn stmt_return(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let value = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(value) = value else {
            return;
        };
        match self.current_result.clone() {
            Some(Some(expected)) => {
                let actual = self.expr(cx, value, Some(expected.clone()));
                if !actual.is_error() {
                    self.assign_ok(cx, tight_span(cx.text, value), &actual, &expected, "return");
                }
            }
            Some(None) => {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "void scenario cannot return a value".to_string(),
                    tight_span(cx.text, value),
                ));
                self.expr(cx, value, None);
            }
            None => {
                self.expr(cx, value, None);
            }
        }
    }

    /// `if cond ... else ...`: boolean condition, narrowed branches
    /// (T03 §4). Each branch threads its own sequence (its `require`
    /// facts and invalidations stay inside); after the join only
    /// facts valid on every path survive, which the caller's
    /// sequence enforces by invalidating what any branch dropped.
    fn stmt_if(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let mut else_at = None;
        for (i, part) in parts.iter().enumerate() {
            if is_name(part, cx.text, "else") {
                else_at = Some(i);
            }
        }
        let cond = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(cond) = cond else {
            return;
        };
        let ty = self.expr(cx, cond, None);
        self.expect_bool(cx, tight_span(cx.text, cond), &ty, "`if` condition");
        let mut then_env = cx.narrow.clone();
        self.collect_narrow(cx, cond, false, &mut then_env);
        let mut else_env = cx.narrow.clone();
        self.collect_narrow(cx, cond, true, &mut else_env);
        let mut then_stmts: Vec<&SyntaxNode> = Vec::new();
        let mut else_stmts: Vec<&SyntaxNode> = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if part.kind == SyntaxKind::Name || std::ptr::eq(*part, cond) {
                continue;
            }
            if matches!(part.kind, SyntaxKind::Punct) {
                continue;
            }
            if else_at.is_some_and(|at| i > at) {
                else_stmts.push(part);
            } else {
                then_stmts.push(part);
            }
        }
        {
            let branch_cx = Ctx {
                module: cx.module,
                file: cx.file,
                text: cx.text,
                narrow: &then_env,
                strict: cx.strict,
                server_default: cx.server_default,
            };
            self.walk_seq(&branch_cx, &then_stmts);
        }
        {
            let branch_cx = Ctx {
                module: cx.module,
                file: cx.file,
                text: cx.text,
                narrow: &else_env,
                strict: cx.strict,
                server_default: cx.server_default,
            };
            self.walk_seq(&branch_cx, &else_stmts);
        }
    }

    /// Finite enum arms use the checked subject domain, never lexical names.
    fn stmt_match(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let subject = parts.iter().find(|n| is_expression(n.kind)).copied();
        let subject_ty = subject.map(|subject| self.expr(cx, subject, None));
        let cases = match &subject_ty {
            Some(ResolvedType::Enum { cases, .. }) => Some(cases.clone()),
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "match subject must be a known nonnullable finite enum".to_string(),
                    tight_span(cx.text, subject.unwrap_or(node)),
                ));
                None
            }
        };
        let mut seen = HashSet::new();
        let mut valid = cases.is_some();
        let arms: Vec<_> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::MatchArm)
            .copied()
            .collect();
        for arm in &arms {
            let arm_parts = kids(arm);
            let label = arm_parts
                .iter()
                .filter(|n| n.kind == SyntaxKind::Name)
                .nth(1)
                .copied();
            let case = label.and_then(|label| name_text(label, cx.text));
            if let Some(cases) = &cases {
                match case {
                    Some(case) if cases.iter().any(|known| known == case) => {
                        self.types
                            .enum_match_cases
                            .insert(NodeKey::of(arm), case.to_string());
                        if !seen.insert(case.to_string()) {
                            valid = false;
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                format!("duplicate match case '{case}'"),
                                tight_span(cx.text, label.unwrap_or(arm)),
                            ));
                        }
                    }
                    _ => {
                        valid = false;
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!(
                                "match case '{}' is not in the subject enum",
                                case.unwrap_or("")
                            ),
                            tight_span(cx.text, label.unwrap_or(arm)),
                        ));
                    }
                }
            }
            let statements: Vec<_> = arm_parts
                .into_iter()
                .filter(|n| !matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct))
                .collect();
            // Each arm inherits the incoming facts; arm-local requirements
            // and invalidations stay within its own sequential walk.
            self.walk_seq(cx, &statements);
        }
        if let Some(cases) = cases {
            let missing: Vec<_> = cases
                .iter()
                .filter(|case| !seen.contains(*case))
                .cloned()
                .collect();
            if !missing.is_empty() {
                valid = false;
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "match must cover every subject enum case; missing {}",
                        missing.join(", ")
                    ),
                    tight_span(cx.text, node),
                ));
            }
        }
        if valid && !arms.is_empty() {
            self.types.exhaustive_matches.insert(NodeKey::of(node));
        }
    }

    /// `for item in domain limit=n ...`: collection domain, positive
    /// integer limit, item-typed body.
    fn stmt_for(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        let mut limit_at = None;
        for (i, part) in parts.iter().enumerate() {
            if is_name(part, cx.text, "limit") {
                limit_at = Some(i);
            }
        }
        // Header expressions (domain, then the `limit =` value) mirror
        // resolve: the first expression is the domain, a second one is
        // the limit only at `limit_at + 2`.
        let mut domain = None;
        let mut limit = None;
        let mut header_end = 0;
        let mut seen_domain = false;
        for (i, part) in parts.iter().enumerate() {
            if !is_expression(part.kind) {
                continue;
            }
            let is_header = if !seen_domain {
                seen_domain = true;
                true
            } else {
                limit_at.is_some_and(|at| i == at + 2)
            };
            if is_header {
                if domain.is_none() {
                    domain = Some(*part);
                } else {
                    limit = Some(*part);
                }
                header_end = i;
            }
        }
        // The `limit=` slot is parser-required.
        if let Some(domain) = domain {
            let ty = self.expr(cx, domain, None);
            match ty {
                ResolvedType::Array { element, .. } => {
                    self.fors.insert(NodeKey::of(node), (*element).clone());
                }
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {
                    self.fors.insert(NodeKey::of(node), ty);
                }
                other => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "for domain must be a collection, found {}",
                            self.show(cx.module, &other)
                        ),
                        tight_span(cx.text, domain),
                    ));
                    self.fors.insert(NodeKey::of(node), ResolvedType::Error);
                }
            }
        }
        if let Some(limit) = limit {
            let ty = self.expr(cx, limit, None);
            let want = ResolvedType::Scalar(Scalar::Int);
            if !ty.is_error() && !self.types_compatible(&ty, &want) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("for limit must be int, found {}", self.show(cx.module, &ty)),
                    tight_span(cx.text, limit),
                ));
            } else if let Some(n) = int_literal_value(limit, cx.text)
                && n <= 0
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("for limit must be positive, found {n}"),
                    tight_span(cx.text, limit),
                ));
            }
        }
        // T03 §4: facts established inside the body never survive
        // the loop (the body's sequence env stays inside), and facts
        // from before survive only if no iteration path invalidates
        // them — so the body starts from the outer facts minus what
        // any iteration may drop (IC6).
        let body: Vec<&SyntaxNode> = parts.iter().skip(header_end + 1).copied().collect();
        let mut body_env = cx.narrow.clone();
        for part in &body {
            self.invalidate_after(cx.text, part, &mut body_env);
        }
        // T07: items of a filtered query domain satisfy its `where`,
        // so the domain's own alias facts narrow the selected item
        // in the body (remapped to the for-item declaration; only
        // when no `select` reshaped the element). Seeded after the
        // iteration invalidation: each row carries fresh facts, and
        // body writes drop them through the ordinary rule (T03 §8).
        if let Some(domain) = domain {
            let query = unwrap_groups(domain);
            if query.kind == SyntaxKind::Query && !Self::query_has_select(query, cx.text) {
                let facts = self.selected_row_facts(cx, query);
                if !facts.is_empty() {
                    let item = DeclKey::ForItem(NodeKey::of(node));
                    for (key, ty) in &facts {
                        body_env.insert(
                            NarrowKey {
                                decl: item.clone(),
                                path: key.path.clone(),
                            },
                            ty.clone(),
                        );
                    }
                }
            }
        }
        let body_cx = Ctx {
            module: cx.module,
            file: cx.file,
            text: cx.text,
            narrow: &body_env,
            strict: cx.strict,
            server_default: cx.server_default,
        };
        self.walk_seq(&body_cx, &body);
    }

    // --- Phase 2: record/field lookup --------------------------------

    /// Fields of a model/contract/event/preferences record.
    fn record_fields(&self, record: SymbolId) -> Vec<SymbolId> {
        match &self.tables.symbols[record.0 as usize].kind {
            SymbolKind::Model { fields, .. }
            | SymbolKind::Contract { fields }
            | SymbolKind::Event { fields }
            | SymbolKind::Preferences { fields } => fields.clone(),
            _ => Vec::new(),
        }
    }

    /// Fields of a model (empty for non-models).
    fn model_fields(&self, model: SymbolId) -> Vec<SymbolId> {
        match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model { fields, .. } => fields.clone(),
            _ => Vec::new(),
        }
    }

    /// Field of `owner` named `name`.
    fn record_field_named(&self, owner: SymbolId, name: &str) -> Option<SymbolId> {
        self.record_fields(owner)
            .into_iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
    }

    /// Field of `model` named `name`.
    fn model_field_named(&self, model: SymbolId, name: &str) -> Option<SymbolId> {
        self.record_field_named(model, name)
    }

    /// Field of `event` named `name`.
    fn event_field_named(&self, event: SymbolId, name: &str) -> Option<SymbolId> {
        self.record_field_named(event, name)
    }

    /// Whether a field is server-initialized (never author-supplied).
    fn field_is_server(&self, field: SymbolId) -> bool {
        self.shapes.get(&field).is_some_and(|s| s.1)
    }

    /// Whether a field is a required `create` input: no default, no
    /// server initializer, and a non-nullable declared type. Ordinary
    /// arrays (`T[]`, marker unset) omit to `[]`, so only required
    /// arrays (`T[]!`, marker set) are required inputs (T09: the `!`
    /// spelling in [`Typer::shapes` is the sole marker, mirroring
    /// `field_is_required` for constructs and `FieldData.required_array`
    /// in effects).
    fn field_is_required_input(&self, field: SymbolId) -> bool {
        if matches!(
            self.tables.symbols[field.0 as usize].kind,
            SymbolKind::DeriveField { .. }
        ) {
            return false;
        }
        let (has_default, has_server, required_array) = self
            .shapes
            .get(&field)
            .copied()
            .unwrap_or((false, false, false));
        if has_default || has_server {
            return false;
        }
        match self.decl_type(field) {
            ResolvedType::Nullable(_) => false,
            ResolvedType::Array { .. } => required_array,
            _ => true,
        }
    }

    // --- Phase 2: scenarios and rules ----------------------------------

    /// Check a scenario: parameter defaults, `by=`/`on=`/`read=`/
    /// `scope=`/`label=`, leading guards, the `do` body (with the
    /// declared result as the `return` expectation) and light example
    /// headers.
    fn phase2_scenario(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "scenario"]) else {
            return;
        };
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Scenario { params, .. } => params.clone(),
            _ => Vec::new(),
        };
        // Attribute vocabulary, by/on exclusivity, trusted shape and
        // the user parameter list are the parser's (`E12xx`).
        self.check_param_defaults(file, text, module, node, &params);
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        if let Some(by) = attribute_value(node, "by", text) {
            let ty = self.expr(&cx, by, None);
            self.expect_bool(&cx, tight_span(text, by), &ty, "`by=`");
        }
        let hook =
            attribute_value(node, "on", text).map(|on| self.check_scenario_on(&cx, node, id, on));
        let read = self.check_scenario_read(&cx, node, id);
        if let Some(label) = attribute_value(node, "label", text) {
            self.check_scalar_caption(&cx, label, "label");
        }
        if let Some(expose) = attribute_value(node, "expose", text) {
            self.check_scenario_expose(text, expose);
        }
        // Leading guards narrow the `do` body.
        let mut env = NarrowEnv::default();
        // A validated declared event types the handler payload:
        // `event` carries the event's record instead of `{opaque}`.
        let on_event = attribute_value(node, "on", text)
            .and_then(|on| self.on_event_payload(module, text, on));
        if let Some(event) = on_event {
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                ResolvedType::Record {
                    symbol: event,
                    stored: false,
                },
            );
        }
        // A validated delivery completion types the handler payload
        // with the DESIGN §8 envelope instead of `{opaque}`: the
        // op's declared result flows to `event.result` and the closed
        // status vocabulary to `event.status`.
        if let Some(on) = attribute_value(node, "on", text)
            && let Some(envelope) = self.on_completion_payload(module, text, on)
        {
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                envelope,
            );
        }
        if let Some(on) = attribute_value(node, "on", text)
            && self
                .types
                .delivery_progress_handlers
                .contains_key(&NodeKey::of(on))
        {
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                ResolvedType::Object(vec![(
                    "delivery_id".to_string(),
                    ResolvedType::Scalar(Scalar::Text),
                )]),
            );
        }
        // `by=` authorization narrows `actor` for guards and the body
        // (DESIGN §3); the resolver already narrowed
        // members/owner/authenticated, so this only adds role
        // spellings (and their boolean combinations).
        if let Some(by) = attribute_value(node, "by", text)
            && self.auth_proves_actor(by, text)
        {
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxActor,
                    path: Vec::new(),
                },
                ResolvedType::Scalar(Scalar::User),
            );
        }
        for child in kids(node) {
            if child.kind == SyntaxKind::Require && !has_error(child) {
                let guard_cx = Ctx {
                    module,
                    file,
                    text,
                    narrow: &env,
                    strict: true,
                    server_default: false,
                };
                self.walk_guard(&guard_cx, child);
                if let Some(cond) = kids(child).iter().find(|n| is_expression(n.kind)) {
                    let snapshot = env.clone();
                    let narrow_cx = Ctx {
                        module,
                        file,
                        text,
                        narrow: &snapshot,
                        strict: true,
                        server_default: false,
                    };
                    self.collect_narrow(&narrow_cx, cond, false, &mut env);
                }
            }
        }
        let result = self.results.get(&id).cloned().unwrap_or(None);
        if read && result.is_none() {
            self.diags.push(Diagnostic::error(
                "E3001",
                "read operations need a declared result type".to_string(),
                tight_span(text, node),
            ));
        }
        let prev_op = self.current_op.replace(id);
        let prev_result = self.current_result.replace(result.clone());
        let prev_hook = std::mem::replace(&mut self.current_hook, hook.flatten());
        let prev_read = std::mem::replace(&mut self.current_read, read);
        for child in kids(node) {
            if child.kind == SyntaxKind::DoBlock && !has_error(child) {
                let body_cx = Ctx {
                    module,
                    file,
                    text,
                    narrow: &env,
                    strict: true,
                    server_default: false,
                };
                self.walk_do_block(&body_cx, child);
                if result.is_some() {
                    self.check_body_returns(text, node, child);
                }
            }
        }
        self.current_op = prev_op;
        self.current_result = prev_result;
        self.current_hook = prev_hook;
        self.current_read = prev_read;
        for child in kids(node) {
            if child.kind == SyntaxKind::Examples && !has_error(child) {
                self.check_example_headers(file, text, module, child, on_event);
            }
        }
    }

    /// Event symbol behind a handler's `on=`, when it names a
    /// validated declared event: single-segment local events and
    /// `Cap.event` capability events. Queues, timers, model hooks,
    /// change events, completions and unknown sources yield `None`
    /// (their payloads stay opaque).
    fn on_event_payload(&self, module: ModuleId, text: &str, on: &SyntaxNode) -> Option<SymbolId> {
        if on.kind != SyntaxKind::Path {
            return None;
        }
        let segments = path_segments(on, text);
        match segments.len() {
            1 => self.prod_or_imported(module, segments[0]).filter(|id| {
                matches!(
                    self.tables.symbols[id.0 as usize].kind,
                    SymbolKind::Event { .. }
                )
            }),
            2 => {
                let head = self.prod_or_imported(module, segments[0])?;
                match &self.tables.symbols[head.0 as usize].kind {
                    SymbolKind::Capability { events, .. } => events
                        .iter()
                        .copied()
                        .find(|e| self.tables.symbols[e.0 as usize].name == segments[1]),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// Delivery envelope behind a handler's `on=Cap.op.completed`
    /// (DESIGN §8): `delivery_id:text`,
    /// `status:enum(pending,succeeded,failed,unknown,skipped)`,
    /// `result:R?` from the op's declared result, `error:{opaque}`.
    /// Mirrors the examples pass T35/R24 envelope, with the closed
    /// DESIGN:654 status vocabulary so bare outcomes claim. Anything
    /// else yields `None` (payload stays opaque).
    fn on_completion_payload(
        &self,
        module: ModuleId,
        text: &str,
        on: &SyntaxNode,
    ) -> Option<ResolvedType> {
        if on.kind != SyntaxKind::Path {
            return None;
        }
        let segments = path_segments(on, text);
        if segments.len() != 3 || segments[2] != "completed" {
            return None;
        }
        let head = self.prod_or_imported(module, segments[0])?;
        let SymbolKind::Capability { ops, .. } = &self.tables.symbols[head.0 as usize].kind else {
            return None;
        };
        let op = ops
            .iter()
            .copied()
            .find(|o| self.tables.symbols[o.0 as usize].name == segments[1])?;
        let result = self
            .results
            .get(&op)
            .cloned()
            .flatten()
            .map(|r| {
                if matches!(r, ResolvedType::Nullable(_)) {
                    r
                } else {
                    ResolvedType::Nullable(Box::new(r))
                }
            })
            .unwrap_or(ResolvedType::Null);
        Some(ResolvedType::Object(vec![
            (
                "delivery_id".to_string(),
                ResolvedType::Scalar(Scalar::Text),
            ),
            (
                "status".to_string(),
                ResolvedType::Enum {
                    cases: ["pending", "succeeded", "failed", "unknown", "skipped"]
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    owner: None,
                },
            ),
            ("result".to_string(), result),
            ("error".to_string(), ResolvedType::Opaque("delivery error")),
        ]))
    }

    /// Whether a `by=`/`read=` authorization expression proves an
    /// authenticated caller when TRUE (DESIGN §3: authenticated/
    /// member/role authorization narrows `actor` to non-null).
    /// Mirrors the resolver's `proves_auth` boolean structure
    /// (`and` needs one side, `or` needs both, `not` flips to the
    /// false polarity) and additionally accepts bare role
    /// references, which the resolver leaves nullable. A call
    /// admits only when it tests a declared role on the literal
    /// caller (T06 no-leak: `r(actor)` admits; `r(owner)`,
    /// derive/builtin calls, and member paths prove nothing about
    /// the caller).
    fn auth_proves_actor(&self, node: &SyntaxNode, text: &str) -> bool {
        self.auth_proofs(node, text)[&NodeKey::of(node)].0
    }

    /// Caller-admission facts for both polarities, computed once per subtree.
    /// Narrowing consults this table rather than rewalking each logical prefix.
    fn auth_proofs(&self, node: &SyntaxNode, text: &str) -> HashMap<NodeKey, (bool, bool)> {
        let mut work = vec![(node, false)];
        let mut proofs = HashMap::new();
        while let Some((current, ready)) = work.pop() {
            if !ready {
                work.push((current, true));
                match current.kind {
                    SyntaxKind::Group | SyntaxKind::Unary | SyntaxKind::Binary => {
                        work.extend(
                            kids(current)
                                .into_iter()
                                .filter(|n| is_expression(n.kind))
                                .map(|n| (n, false)),
                        );
                    }
                    _ => {}
                }
                continue;
            }
            let proof = |n: &SyntaxNode| {
                proofs
                    .get(&NodeKey::of(n))
                    .copied()
                    .unwrap_or((false, false))
            };
            let parts = kids(current);
            let result = match current.kind {
                SyntaxKind::NameRef => {
                    let word = parts.iter().find_map(|n| name_text(n, text)).unwrap_or("");
                    (
                        matches!(word, "members" | "owner" | "authenticated")
                            || matches!(
                                self.tables.node_binding.get(&NodeKey::of(current)),
                                Some(Binding::Symbol(id)) if matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role)
                            ),
                        word == "public",
                    )
                }
                SyntaxKind::Call => (self.role_call_on_caller(current, text), false),
                SyntaxKind::Group => parts.iter().filter(|n| n.kind != SyntaxKind::Punct).fold(
                    (false, false),
                    |(a, b), n| {
                        let (t, f) = proof(n);
                        (a || t, b || f)
                    },
                ),
                SyntaxKind::Binary if parts.len() == 3 => {
                    let (lt, lf) = proof(parts[0]);
                    let (rt, rf) = proof(parts[2]);
                    match op_text(current, text).unwrap_or("") {
                        "and" => (lt || rt, lf && rf),
                        "or" => (lt && rt, lf || rf),
                        _ => (false, false),
                    }
                }
                SyntaxKind::Unary if parts.first().is_some_and(|n| is_name(n, text, "not")) => {
                    parts
                        .iter()
                        .find(|n| is_expression(n.kind))
                        .map(|n| {
                            let (t, f) = proof(n);
                            (f, t)
                        })
                        .unwrap_or((false, false))
                }
                _ => (false, false),
            };
            proofs.insert(NodeKey::of(current), result);
        }
        proofs
    }

    /// Whether `node` is a declared role tested on the literal
    /// caller: `r(actor)` where `r` resolves to a `Role` symbol and
    /// the single unnamed subject resolves to the `actor` contextual
    /// fact (T06: bare `r` is the canonical caller spelling; the
    /// call form admits exactly when its subject is the caller, and
    /// never for another subject or a non-role callee).
    fn role_call_on_caller(&self, node: &SyntaxNode, text: &str) -> bool {
        let parts = kids(node);
        let Some(callee) = parts.iter().find(|n| is_expression(n.kind)) else {
            return false;
        };
        if unwrap_groups(callee).kind != SyntaxKind::NameRef {
            return false;
        }
        let is_role = matches!(
            self.tables.node_binding.get(&NodeKey::of(unwrap_groups(callee))),
            Some(Binding::Symbol(id))
                if matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role)
        );
        if !is_role {
            return false;
        }
        let mut args = parts.iter().filter(|n| n.kind == SyntaxKind::Argument);
        let (Some(arg), None) = (args.next(), args.next()) else {
            return false;
        };
        let arg_parts = kids(arg);
        if arg_parts.len() >= 3
            && arg_parts[0].kind == SyntaxKind::Name
            && is_punct(arg_parts[1], text, "=")
        {
            return false;
        }
        let Some(value) = arg_parts.iter().find(|n| is_expression(n.kind)) else {
            return false;
        };
        let value = unwrap_groups(value);
        value.kind == SyntaxKind::NameRef
            && matches!(
                self.tables.node_binding.get(&NodeKey::of(value)),
                Some(Binding::Context(ContextVar::Actor(_)))
            )
    }

    /// Check `read=`/`scope=` on a scenario: `read=true` selects a
    /// pure read operation, `scope=authority` needs `read=true`
    /// (`E3001`). The parser pins both value spellings. Returns
    /// whether this scenario is a read operation.
    fn check_scenario_read(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, _id: SymbolId) -> bool {
        let read = attribute_value(node, "read", cx.text).is_some();
        if attribute_value(node, "scope", cx.text).is_some() && !read {
            let scope = attribute_value(node, "scope", cx.text).unwrap_or(node);
            self.diags.push(Diagnostic::error(
                "E3001",
                "scope=authority needs read=true".to_string(),
                tight_span(cx.text, scope),
            ));
        }
        read
    }

    /// Check every path of a result-bearing body returns (`E3001`).
    fn check_body_returns(&mut self, text: &str, node: &SyntaxNode, body: &SyntaxNode) {
        let stmts: Vec<&SyntaxNode> = kids(body)
            .into_iter()
            .filter(|s| s.kind != SyntaxKind::Name)
            .collect();
        if !self.stmts_return(text, &stmts) {
            let span = arrow_result(node)
                .map(|t| tight_span(text, t))
                .unwrap_or_else(|| tight_span(text, node));
            self.diags.push(Diagnostic::error(
                "E3001",
                "a result-bearing scenario must return on every path".to_string(),
                span,
            ));
        }
    }

    /// Whether a statement list always returns.
    fn stmts_return(&self, text: &str, stmts: &[&SyntaxNode]) -> bool {
        stmts.iter().any(|s| self.stmt_returns(text, s))
    }

    /// Whether one statement always returns (`for` may run zero times;
    /// an `if` without `else` may fall through).
    fn stmt_returns(&self, text: &str, node: &SyntaxNode) -> bool {
        match node.kind {
            SyntaxKind::Return => true,
            SyntaxKind::If => {
                let parts = kids(node);
                let mut split = None;
                for (i, part) in parts.iter().enumerate() {
                    if is_name(part, text, "else") {
                        split = Some(i);
                        break;
                    }
                }
                let Some(split) = split else {
                    return false;
                };
                if split < 1 || parts.len() < 2 {
                    return false;
                }
                let branch_returns = |slice: &[&SyntaxNode]| {
                    slice.iter().any(|s| {
                        !matches!(s.kind, SyntaxKind::Name | SyntaxKind::Punct)
                            && self.stmt_returns(text, s)
                    })
                };
                branch_returns(&parts[1..split]) && branch_returns(&parts[split + 1..])
            }
            SyntaxKind::Match => {
                self.types.exhaustive_matches.contains(&NodeKey::of(node))
                    && kids(node)
                        .into_iter()
                        .filter(|arm| arm.kind == SyntaxKind::MatchArm)
                        .all(|arm| {
                            let statements: Vec<_> = kids(arm)
                                .into_iter()
                                .filter(|n| !matches!(n.kind, SyntaxKind::Name | SyntaxKind::Punct))
                                .collect();
                            self.stmts_return(text, &statements)
                        })
            }
            _ => false,
        }
    }

    /// Check scenario parameter defaults against their declared types
    /// (`E3011`), plus parameter label captions.
    fn check_param_defaults(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        params: &[SymbolId],
    ) {
        let param_nodes: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
            .collect();
        for (i, param_node) in param_nodes.iter().enumerate() {
            let Some(param) = params.get(i).copied() else {
                continue;
            };
            let expected = self.decl_type(param);
            // Only the owning type's immediate `=` introduces a default;
            // choice metadata and a parameter named `choices` never do.
            let default = field_parts(param_node, text).default;
            if let Some(default) = default {
                if default.kind == SyntaxKind::NameRef
                    && let Some(Binding::Symbol(seed)) =
                        self.tables.node_binding.get(&NodeKey::of(default))
                    && matches!(
                        self.tables.symbols[seed.0 as usize].kind,
                        SymbolKind::Param { .. }
                    )
                {
                    self.types.param_default_copy_sources.insert(param, *seed);
                }
                for (name, span) in self.effectful_calls(default, text) {
                    self.diags.push(Diagnostic::error(
                        "E3011",
                        format!(
                            "default for '{}' must be pure; '{name}' is not allowed here",
                            self.tables.symbols[param.0 as usize].name
                        ),
                        span,
                    ));
                }
                let narrow = NarrowEnv::default();
                let cx = Self::body_cx(module, file, text, &narrow);
                let actual = self.expr(&cx, default, Some(expected.clone()));
                if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                    self.diags.push(Diagnostic::error(
                        "E3011",
                        format!(
                            "default for '{}': expected {}, found {}",
                            self.tables.symbols[param.0 as usize].name,
                            self.show(module, &expected),
                            self.show(module, &actual)
                        ),
                        tight_span(text, default),
                    ));
                }
            }
            let parts = kids(param_node);
            for (j, part) in parts.iter().enumerate() {
                if is_name(part, text, "label")
                    && let Some(caption) = parts.get(j + 2)
                {
                    let narrow = NarrowEnv::default();
                    let cx = Self::body_cx(module, file, text, &narrow);
                    self.check_scalar_caption(&cx, caption, "label");
                }
            }
            let parts = kids(param_node);
            let choices = parts
                .iter()
                .position(|part| is_type_node(part.kind))
                .and_then(|type_at| {
                    parts
                        .iter()
                        .enumerate()
                        .skip(type_at + 1)
                        .find_map(|(index, part)| {
                            (is_name(part, text, "choices")
                                && parts
                                    .get(index + 1)
                                    .is_some_and(|eq| is_punct(eq, text, "=")))
                            .then(|| parts.get(index + 2).copied())
                            .flatten()
                        })
                });
            if let Some(choices) = choices {
                match self.checked_input_choice(module, text, param, choices) {
                    Ok(choice) => {
                        self.types.input_choices.insert(param, choice);
                    }
                    Err(message) => self.diags.push(Diagnostic::error(
                        "E3001",
                        message,
                        tight_span(text, choices),
                    )),
                }
            }
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            self.check_description_slot(&cx, param_node);
        }
    }

    /// Decode choice assistance as declaration metadata, never as an expression.
    fn checked_input_choice(
        &self,
        module: ModuleId,
        text: &str,
        assisted: SymbolId,
        metadata: &SyntaxNode,
    ) -> Result<CheckedInputChoice, String> {
        let fail = |message: &str| format!("choices=: {message}");
        let SymbolKind::Param { owner, .. } = self.tables.symbols[assisted.0 as usize].kind else {
            return Err(fail("requires an owning operation input"));
        };
        let SymbolKind::Scenario {
            params: inputs,
            trusted: false,
            ..
        } = &self.tables.symbols[owner.0 as usize].kind
        else {
            return Err(fail("is supported only on ordinary scenario parameters"));
        };
        if metadata.kind != SyntaxKind::Object {
            return Err(fail("requires a metadata object"));
        }
        let entries = object_entries(metadata, text);
        let mut keys = HashSet::new();
        for (key, _, value) in &entries {
            if !matches!(*key, "read" | "value" | "labels") || value.is_none() {
                return Err(fail(
                    "accepts only explicit read=, value= and labels= entries",
                ));
            }
            if !keys.insert(*key) {
                return Err(fail("duplicate metadata entry"));
            }
        }
        let entry = |key| {
            entries
                .iter()
                .find(|(name, _, _)| *name == key)
                .and_then(|(_, _, value)| *value)
        };
        let read = entry("read").ok_or_else(|| fail("requires read="))?;
        if read.kind != SyntaxKind::Call {
            return Err(fail(
                "read= must name an owning read operation and its input mappings",
            ));
        }
        let call_parts = kids(read);
        let callee = call_parts
            .iter()
            .find(|n| is_expression(n.kind))
            .copied()
            .ok_or_else(|| fail("missing read operation"))?;
        let read_name = (callee.kind == SyntaxKind::NameRef)
            .then(|| nameref_word(callee, text))
            .flatten()
            .ok_or_else(|| fail("read= must name a local or imported scenario"))?;
        let read_operation = self
            .prod_or_imported(module, read_name)
            .ok_or_else(|| fail("unknown read operation"))?;
        if read_operation == owner {
            return Err(fail("cannot look up choices through its own operation"));
        }
        let SymbolKind::Scenario {
            params: read_params,
            trusted: false,
            ..
        } = &self.tables.symbols[read_operation.0 as usize].kind
        else {
            return Err(fail("read= must select an ordinary read=true scenario"));
        };
        if !self.read_scenarios.contains(&read_operation) {
            return Err(fail("read= cannot select a mutation operation"));
        }
        let Some(Some(ResolvedType::Array { element, .. })) = self.results.get(&read_operation)
        else {
            return Err(fail(
                "read operation must return a collection of stored model references",
            ));
        };
        let ResolvedType::Record {
            symbol: candidate,
            stored: true,
        } = element.as_ref()
        else {
            return Err(fail(
                "read operation must return a collection of stored model references",
            ));
        };
        if !matches!(
            self.tables.symbols[candidate.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            return Err(fail(
                "read result candidates must be stored model references",
            ));
        }
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, metadata.span.file, text, &narrow);
        let mut mapped: Vec<Option<CheckedChoiceArgument>> = vec![None; read_params.len()];
        let mut positional = 0;
        for arg in call_parts.iter().filter(|n| n.kind == SyntaxKind::Argument) {
            let arg = self
                .read_argument(&cx, arg)
                .ok_or_else(|| fail("invalid read argument mapping"))?;
            let index = if let Some(name) = &arg.name {
                read_params
                    .iter()
                    .position(|param| self.tables.symbols[param.0 as usize].name == *name)
                    .ok_or_else(|| fail("unknown read argument"))?
            } else {
                let index = positional;
                positional += 1;
                index
            };
            let parameter = *read_params
                .get(index)
                .ok_or_else(|| fail("too many read argument mappings"))?;
            if mapped[index].is_some() {
                return Err(fail("duplicate read argument mapping"));
            }
            let (input_name, path) = choice_input_path(arg.value, text)
                .ok_or_else(|| fail("read arguments must be input roots or stable member paths; executable expressions are unsupported"))?;
            let input = inputs
                .iter()
                .copied()
                .find(|input| self.tables.symbols[input.0 as usize].name == input_name)
                .ok_or_else(|| fail("read arguments must be rooted in this operation's inputs"))?;
            if input == assisted {
                return Err(fail("a choice input cannot depend on itself"));
            }
            let actual = self
                .choice_input_path_type(input, &path)
                .ok_or_else(|| fail("unsupported or nullable intermediate input member path"))?;
            let expected = self.decl_type(parameter);
            if actual.is_error()
                || expected.is_error()
                || !self.types_compatible(&actual, &expected)
            {
                return Err(fail(
                    "read argument type does not match its owning read input",
                ));
            }
            mapped[index] = Some(CheckedChoiceArgument {
                parameter,
                input,
                path,
            });
        }
        for (index, parameter) in read_params.iter().enumerate() {
            let ty = self.decl_type(*parameter);
            let required = !self.param_has_default(*parameter)
                && !matches!(ty, ResolvedType::Nullable(_) | ResolvedType::Array { .. });
            if mapped[index].is_none() && required {
                return Err(fail("missing required read argument mapping"));
            }
        }
        let (value, actual) = if let Some(value) = entry("value") {
            let field_name = string_literal_value(value)
                .ok_or_else(|| fail("value= requires one declared candidate field name string"))?;
            let field = self
                .record_field_named(*candidate, &field_name)
                .ok_or_else(|| fail("value= names no declared candidate field"))?;
            let actual = self.decl_type(field);
            if !self.choice_leaf_supported(&actual) {
                return Err(fail(
                    "value= requires a supported candidate scalar, enum or model-reference leaf",
                ));
            }
            (CheckedChoiceValue::Field(field_name), actual)
        } else {
            (CheckedChoiceValue::Record, element.as_ref().clone())
        };
        let expected = self.decl_type(assisted);
        if !self.types_compatible(&actual, &expected) {
            return Err(fail(
                "candidate value is incompatible with the assisted input",
            ));
        }
        let labels_node = entry("labels").ok_or_else(|| fail("requires labels="))?;
        if labels_node.kind != SyntaxKind::Array {
            return Err(fail(
                "labels= requires an array of declared candidate field name strings",
            ));
        }
        let mut labels = Vec::new();
        for node in kids(labels_node)
            .into_iter()
            .filter(|n| is_expression(n.kind))
        {
            let name = string_literal_value(node)
                .ok_or_else(|| fail("labels= accepts only candidate field name strings"))?;
            if labels.contains(&name) {
                return Err(fail("duplicate candidate label field"));
            }
            let field = self
                .record_field_named(*candidate, &name)
                .ok_or_else(|| fail("labels= names no declared candidate field"))?;
            if !self.choice_leaf_supported(&self.decl_type(field)) {
                return Err(fail(
                    "labels= requires supported candidate scalar, enum or model-reference leaves",
                ));
            }
            labels.push(name);
        }
        if labels.is_empty() {
            return Err(fail("labels= requires at least one candidate field"));
        }
        Ok(CheckedInputChoice {
            read_operation,
            arguments: mapped.into_iter().flatten().collect(),
            value,
            labels,
        })
    }

    /// Only stored fields and the model's owning parent relation are stable.
    fn choice_input_path_type(&self, input: SymbolId, path: &[String]) -> Option<ResolvedType> {
        let mut ty = self.decl_type(input);
        for member in path {
            let ResolvedType::Record { symbol, .. } = ty else {
                return None;
            };
            ty = if let Some(field) = self.record_field_named(symbol, member) {
                self.decl_type(field)
            } else if member == "parent" {
                ResolvedType::Record {
                    symbol: contained_parent_of(self.tables, symbol)?,
                    stored: true,
                }
            } else {
                return None;
            };
        }
        (!matches!(
            ty,
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_)
        ))
        .then_some(ty)
    }

    fn choice_leaf_supported(&self, ty: &ResolvedType) -> bool {
        match ty.nullable_inner().unwrap_or(ty) {
            ResolvedType::Scalar(Scalar::Secret | Scalar::Json | Scalar::Bytes | Scalar::File) => {
                false
            }
            ResolvedType::Scalar(_) | ResolvedType::Enum { .. } => true,
            ResolvedType::Record {
                symbol,
                stored: true,
            } => matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Model { .. }
            ),
            _ => false,
        }
    }

    /// Reject cycles after every owning parameter's metadata has been checked.
    fn check_input_choice_cycles(&mut self) {
        let mut inputs: Vec<_> = self.types.input_choices.keys().copied().collect();
        inputs.sort_by_key(|input| input.0);
        let mut cyclic = Vec::new();
        for input in inputs {
            let mut pending = self.types.input_choices[&input]
                .arguments
                .iter()
                .map(|arg| arg.input)
                .collect::<Vec<_>>();
            let mut seen = HashSet::new();
            while let Some(dependency) = pending.pop() {
                if dependency == input {
                    cyclic.push(input);
                    break;
                }
                if seen.insert(dependency)
                    && let Some(choice) = self.types.input_choices.get(&dependency)
                {
                    pending.extend(choice.arguments.iter().map(|arg| arg.input));
                }
            }
        }
        for input in cyclic {
            self.types.input_choices.remove(&input);
            self.diags.push(Diagnostic::error(
                "E3001",
                "choices=: dependent input mappings form a cycle".to_string(),
                self.tables.symbols[input.0 as usize].span,
            ));
        }
    }

    /// Check a trusted handler's `on=` source against the finite
    /// registry (DESIGN §6): declared events, `every(duration)`,
    /// model hooks (`Model.create/update/delete`, at most one per
    /// model/operation), committed change events
    /// (`Model.created/updated/deleted`), `teams.member_removed`,
    /// `instrumentation.error`, capability events (`Cap.event`),
    /// delivery completions (`Cap.op.completed`,
    /// `Scenario.completed`) and declared queues (`E3010`). Returns
    /// the hook identity for pre-commit model hooks.
    fn check_scenario_on(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        _id: SymbolId,
        on: &SyntaxNode,
    ) -> Option<(SymbolId, CrudOp)> {
        if on.kind == SyntaxKind::Call {
            return self.check_on_every(cx, on);
        }
        if on.kind != SyntaxKind::Path {
            self.diags.push(Diagnostic::error(
                "E3010",
                "on= needs an event source path or every(duration)".to_string(),
                tight_span(cx.text, on),
            ));
            return None;
        }
        let segments = path_segments(on, cx.text);
        match segments.len() {
            1 => self.check_on_event(cx, on, &segments),
            2 => self.check_on_two_seg(cx, on, &segments),
            3 => self.check_on_completed(cx, on, &segments),
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                None
            }
        }
    }

    /// Check `on=every(duration)`: one duration argument.
    fn check_on_every(&mut self, cx: &Ctx<'_, '_>, on: &SyntaxNode) -> Option<(SymbolId, CrudOp)> {
        let parts = kids(on);
        let head = parts
            .iter()
            .find(|n| is_expression(n.kind))
            .and_then(|n| kids(n).iter().find_map(|m| name_text(m, cx.text)));
        if head != Some("every") {
            self.diags.push(Diagnostic::error(
                "E3010",
                "on= needs an event source path or every(duration)".to_string(),
                tight_span(cx.text, on),
            ));
            return None;
        }
        let args: Vec<&SyntaxNode> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .filter_map(|arg| kids(arg).iter().find(|n| is_expression(n.kind)).copied())
            .collect();
        if args.len() != 1 {
            self.diags.push(Diagnostic::error(
                "E3010",
                "every() takes exactly one duration".to_string(),
                tight_span(cx.text, on),
            ));
            return None;
        }
        // Resolve never walks `on=` (a path slot, not an expression
        // scope); the grammar takes a duration token here.
        if !matches!(
            literal_leaf(args[0], cx.text),
            Some((SyntaxKind::Duration, _))
        ) {
            self.diags.push(Diagnostic::error(
                "E3010",
                "every() needs a duration literal".to_string(),
                tight_span(cx.text, args[0]),
            ));
        }
        None
    }

    /// Check a single-segment `on=` source: a declared event or a
    /// declared queue.
    fn check_on_event(
        &mut self,
        cx: &Ctx<'_, '_>,
        on: &SyntaxNode,
        segments: &[&str],
    ) -> Option<(SymbolId, CrudOp)> {
        if let Some(event) = self.prod_or_imported(cx.module, segments[0]) {
            if matches!(
                self.tables.symbols[event.0 as usize].kind,
                SymbolKind::Event { .. }
            ) {
                return None;
            }
            self.diags.push(Diagnostic::error(
                "E3010",
                format!(
                    "on={} names {}, not an event",
                    segments[0],
                    record_name(self.tables, cx.module, event)
                ),
                tight_span(cx.text, on),
            ));
            return None;
        }
        // Declared queues are delivery sources too (DESIGN §8); their
        // payloads are deployment-typed, so accept the name.
        if self
            .queue_names
            .contains(&(cx.module, segments[0].to_string()))
        {
            return None;
        }
        self.diags.push(Diagnostic::error(
            "E3010",
            format!("unknown event '{}'", segments.join(".")),
            tight_span(cx.text, on),
        ));
        None
    }

    /// Check a two-segment `on=` source: model hooks and committed
    /// events, `teams.member_removed`, `instrumentation.error`,
    /// capability events and exported-scenario completions.
    fn check_on_two_seg(
        &mut self,
        cx: &Ctx<'_, '_>,
        on: &SyntaxNode,
        segments: &[&str],
    ) -> Option<(SymbolId, CrudOp)> {
        if segments == ["teams", "member_removed"] || segments == ["instrumentation", "error"] {
            return None;
        }
        // `Scenario.completed` for exported user operations.
        if segments[1] == "completed" {
            return self.check_on_scenario_completed(cx, on, segments);
        }
        let Some(head) = self.prod_or_imported(cx.module, segments[0]) else {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("unknown event source '{}'", segments.join(".")),
                tight_span(cx.text, on),
            ));
            return None;
        };
        match &self.tables.symbols[head.0 as usize].kind {
            SymbolKind::Model { .. } => self.check_on_model_source(cx, on, head, segments),
            SymbolKind::Capability { ops, events } => {
                let (ops, events) = (ops.clone(), events.clone());
                if events
                    .iter()
                    .any(|e| self.tables.symbols[e.0 as usize].name == segments[1])
                {
                    return None;
                }
                if ops
                    .iter()
                    .any(|o| self.tables.symbols[o.0 as usize].name == segments[1])
                {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!(
                            "on={} names an operation; delivery completions use {}.completed",
                            segments.join("."),
                            segments.join(".")
                        ),
                        tight_span(cx.text, on),
                    ));
                    return None;
                }
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                None
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                None
            }
        }
    }

    /// Check `on=Model.create/...`: pre-commit hooks (deduped, returned)
    /// and committed change events (accepted).
    fn check_on_model_source(
        &mut self,
        cx: &Ctx<'_, '_>,
        on: &SyntaxNode,
        model: SymbolId,
        segments: &[&str],
    ) -> Option<(SymbolId, CrudOp)> {
        let hook_op = match segments[1] {
            "create" => Some(CrudOp::Create),
            "update" => Some(CrudOp::Update),
            "delete" => Some(CrudOp::Delete),
            "created" | "updated" | "deleted" => None,
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                return None;
            }
        };
        let op = hook_op?;
        // At most one hook per model/CRUD operation (DESIGN §6).
        let slot = (model, op);
        if let Some(first) = self.hooks_seen.get(&slot) {
            let mut diagnostic = Diagnostic::error(
                "E3010",
                format!(
                    "duplicate {} hook for model '{}'",
                    op.as_str(),
                    self.tables.symbols[model.0 as usize].name
                ),
                tight_span(cx.text, on),
            );
            diagnostic.related.push(Related {
                span: *first,
                message: "first hook here".to_string(),
            });
            self.diags.push(diagnostic);
            return None;
        }
        self.hooks_seen.insert(slot, tight_span(cx.text, on));
        Some(slot)
    }

    /// Check `on=Scenario.completed`: an exported user operation.
    fn check_on_scenario_completed(
        &mut self,
        cx: &Ctx<'_, '_>,
        on: &SyntaxNode,
        segments: &[&str],
    ) -> Option<(SymbolId, CrudOp)> {
        match self.prod_or_imported(cx.module, segments[0]) {
            Some(id) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Scenario { trusted, .. } if !trusted => {
                    if !self.tables.symbols[id.0 as usize].exported {
                        self.diags.push(Diagnostic::error(
                            "E3010",
                            format!("on={} needs an exported scenario", segments.join(".")),
                            tight_span(cx.text, on),
                        ));
                    }
                    None
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("unknown event source '{}'", segments.join(".")),
                        tight_span(cx.text, on),
                    ));
                    None
                }
            },
            None => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                None
            }
        }
    }

    /// Check three-segment delivery lifecycle sources. Progress belongs only
    /// to the original operations in the accepted associated-progress manifest;
    /// cancel/reconcile command receipts do not gain owning progress handlers.
    fn check_on_completed(
        &mut self,
        cx: &Ctx<'_, '_>,
        on: &SyntaxNode,
        segments: &[&str],
    ) -> Option<(SymbolId, CrudOp)> {
        if segments[2] == "progressed" {
            let scopes = &self.tables.module_scopes[cx.module.0 as usize];
            if let Some(ScopedName::External { provider, name }) = scopes.prod.get(segments[0])
                && provider == "std"
                && let Some(cap) = std_capability(name)
                && cap.operations.iter().any(|op| op.name == segments[1])
                && matches!(
                    (cap.name, segments[1]),
                    ("std.TextGenerationV1", "generate") | ("std.ImagesV1", "submit")
                )
            {
                let owner = &self.tables.modules[cx.module.0 as usize].name;
                self.types
                    .delivery_progress_handlers
                    .insert(NodeKey::of(on), format!("{owner}.{}", segments.join(".")));
                return None;
            }
        }
        if segments[2] != "completed" {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("unknown event source '{}'", segments.join(".")),
                tight_span(cx.text, on),
            ));
            return None;
        }
        match self.prod_or_imported(cx.module, segments[0]) {
            Some(head) => match &self.tables.symbols[head.0 as usize].kind {
                SymbolKind::Capability { ops, .. } => {
                    if ops
                        .iter()
                        .any(|o| self.tables.symbols[o.0 as usize].name == segments[1])
                    {
                        return None;
                    }
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("unknown event source '{}'", segments.join(".")),
                        tight_span(cx.text, on),
                    ));
                    None
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("unknown event source '{}'", segments.join(".")),
                        tight_span(cx.text, on),
                    ));
                    None
                }
            },
            None => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("unknown event source '{}'", segments.join(".")),
                    tight_span(cx.text, on),
                ));
                None
            }
        }
    }

    /// Check `examples` header bindings lightly: names resolve and enum
    /// cases claim, but only position-independent facts (`E6001`) apply.
    /// `on_event` carries the handler's validated event payload (T10 C2):
    /// an `event={...}` literal checks against the event record so nested
    /// bare cases claim their enum types; still diagnostic-free here.
    fn check_example_headers(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        on_event: Option<SymbolId>,
    ) {
        let narrow = NarrowEnv::default();
        let cx = Ctx {
            module,
            file,
            text,
            narrow: &narrow,
            strict: false,
            server_default: false,
        };
        for child in kids(node) {
            if child.kind == SyntaxKind::Attribute
                && let Some((key, value)) = attribute_parts(child)
            {
                let expect = match on_event {
                    Some(event) if is_name(key, text, "event") => Some(ResolvedType::Record {
                        symbol: event,
                        stored: false,
                    }),
                    _ => None,
                };
                self.expr(&cx, value, expect);
            }
        }
        // Headers retain their type-owned unresolved diagnostics; general
        // BDD expression values retain the runner's diagnostic profile.
        let unresolved_before = self.types.unresolved_names.len();
        let rows: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::ExampleRow)
            .collect();
        let mut observation_types = Vec::new();
        let mut input_types = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let mut expected = false;
            let mut column = 0;
            for part in kids(row) {
                if is_punct(part, text, "->") {
                    expected = true;
                    column = 0;
                }
                if !is_expression(part.kind) {
                    continue;
                }
                if index == 0 {
                    if expected {
                        observation_types.push(self.expr(&cx, part, None));
                    } else {
                        input_types.push(self.expr(&cx, part, None));
                    }
                } else {
                    let expectation = if expected {
                        observation_types.get(column).cloned()
                    } else {
                        input_types.get(column).cloned()
                    };
                    self.expr(&cx, part, expectation);
                }
                column += 1;
            }
        }
        if let Some(body) = kids(node)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::DoBlock)
        {
            let mut env = NarrowEnv::default();
            for step in kids(body) {
                let cx = Ctx {
                    module,
                    file,
                    text,
                    narrow: &env,
                    strict: false,
                    server_default: false,
                };
                match step.kind {
                    SyntaxKind::Let => self.stmt_let(&cx, step),
                    SyntaxKind::ExampleCall => {
                        for part in kids(step) {
                            if part.kind == SyntaxKind::Object {
                                self.expr(&cx, part, None);
                            }
                        }
                    }
                    SyntaxKind::ExampleAssert => {
                        let mut expected = false;
                        let mut observations: Vec<(&SyntaxNode, ResolvedType)> = Vec::new();
                        let mut column = 0;
                        let mut refinements = NarrowEnv::default();
                        for part in kids(step) {
                            if is_punct(part, text, "->") {
                                expected = true;
                            }
                            if !is_expression(part.kind) {
                                continue;
                            }
                            if expected {
                                self.expr(
                                    &cx,
                                    part,
                                    observations.get(column).map(|(_, ty)| ty.clone()),
                                );
                                if text[part.span.start as usize..part.span.end as usize].trim()
                                    == "true"
                                    && let Some((observed, _)) = observations.get(column)
                                {
                                    refinements.extend(self.extract_narrow(&cx, observed, false));
                                }
                                column += 1;
                            } else {
                                observations.push((part, self.expr(&cx, part, None)));
                            }
                        }
                        env.extend(refinements);
                    }
                    _ => {}
                }
            }
        }
        self.types.unresolved_names.truncate(unresolved_before);
    }

    // --- Phase 2: labels, messages and captions -------------------------

    /// Check a scalar caption (`label=` on declarations, page titles,
    /// UI headings): literal text, an inline descriptor, a `Label`
    /// table (field labels only, via `expected`), or a static path to
    /// a zero-parameter message (`E3013`/`E3016`).
    fn check_scalar_caption(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, what: &str) {
        self.check_caption(cx, node, what, None);
    }

    /// Check a field/parameter/derived-field label: scalar caption or
    /// the closed `{text,values}` object; `values=` keys must be cases
    /// of the (nullable-unwrapped) enum/bool `expected` type.
    fn check_field_label(
        &mut self,
        cx: &Ctx<'_, '_>,
        _field: &SyntaxNode,
        name: &str,
        expected: &ResolvedType,
        label: &SyntaxNode,
    ) {
        if label.kind == SyntaxKind::Label {
            self.check_label_table(cx, label, name, Some(expected));
            return;
        }
        self.check_caption(cx, label, "label", None);
    }

    /// Check one caption value: string literal, inline descriptor,
    /// label table (needs `expected`), or message path.
    fn check_caption(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        what: &str,
        expected: Option<&ResolvedType>,
    ) {
        match node.kind {
            SyntaxKind::Literal => {
                if !invalid_string_literal(node) && string_literal_value(node).is_none() {
                    self.diags.push(Diagnostic::error(
                        "E3016",
                        format!("{what} must be text, a message or a label table"),
                        tight_span(cx.text, node),
                    ));
                }
            }
            SyntaxKind::MessageValue => {
                self.check_message_value(cx, node, what, None);
            }
            SyntaxKind::Label => {
                self.check_label_table(cx, node, what, expected);
            }
            SyntaxKind::CrudLabels => {
                self.diags.push(Diagnostic::error(
                    "E3013",
                    format!("{what} takes a caption, not a CRUD label map"),
                    tight_span(cx.text, node),
                ));
            }
            SyntaxKind::Path => {
                self.check_message_path(cx, node, what);
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!("{what} must be text, a message or a label table"),
                    tight_span(cx.text, node),
                ));
            }
        }
    }

    /// Check a message-path caption: it must name a shared
    /// zero-parameter message (`E3016`); unresolvable paths were
    /// already reported by resolve.
    fn check_message_path(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, what: &str) {
        let Some(id) = self.tables.node_symbol.get(&NodeKey::of(node)).copied() else {
            return;
        };
        match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Message { params } if params.is_empty() => {}
            SymbolKind::Message { .. } => {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!(
                        "{what} cannot reference '{}'; parameterized messages need call syntax",
                        self.tables.symbols[id.0 as usize].name
                    ),
                    tight_span(cx.text, node),
                ));
            }
            _ => {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!(
                        "{what} must reference a message, found {}",
                        record_name(self.tables, cx.module, id)
                    ),
                    tight_span(cx.text, node),
                ));
            }
        }
    }

    /// Check one field/parameter description slot (`desc=` or the
    /// legacy `@{desc}` annotation): static text, an inline descriptor
    /// with locale variants, or a static zero-parameter message path
    /// (`E3016`). Duplicates, dynamic values, call arguments and
    /// record-query tails are the parser's (`E12xx`); this pass still
    /// enforces static-only, so any non-static value that reaches it
    /// fails here with a located diagnostic. Error subtrees were
    /// already diagnosed. Attached `#` sets are not re-validated here.
    fn check_description_slot(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        if has_error(node) {
            return;
        }
        for child in kids(node) {
            match child.kind {
                SyntaxKind::DescriptionValue => {
                    let value = kids(child).into_iter().last();
                    match value.map(|n| n.kind) {
                        Some(SyntaxKind::Literal) => {
                            let literal = value.expect("matched literal");
                            if !invalid_string_literal(literal)
                                && string_literal_value(literal).is_none()
                            {
                                self.diags.push(Diagnostic::error(
                                    "E3016",
                                    "description must be text or a static message reference"
                                        .to_string(),
                                    tight_span(cx.text, literal),
                                ));
                            }
                        }
                        Some(SyntaxKind::MessageValue) => {
                            self.check_message_value(
                                cx,
                                value.expect("matched descriptor"),
                                "description",
                                None,
                            );
                        }
                        Some(SyntaxKind::Path) => {
                            self.check_message_path(
                                cx,
                                value.expect("matched path"),
                                "description",
                            );
                        }
                        _ => {
                            self.diags.push(Diagnostic::error(
                                "E3016",
                                "description must be text or a static message reference"
                                    .to_string(),
                                tight_span(cx.text, child),
                            ));
                        }
                    }
                }
                SyntaxKind::Annotation => {
                    let literal = kids(child)
                        .into_iter()
                        .find(|n| n.kind == SyntaxKind::Literal);
                    match literal {
                        Some(found)
                            if invalid_string_literal(found)
                                || string_literal_value(found).is_some() => {}
                        _ => {
                            self.diags.push(Diagnostic::error(
                                "E3016",
                                "description must be text or a static message reference"
                                    .to_string(),
                                tight_span(cx.text, child),
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Check an inline descriptor: string source, string-or-null
    /// variants with valid BCP 47 tags that neither duplicate each
    /// other (canonically) nor repeat the owner's source tag, and
    /// slots covered by `params` when a signature is supplied (`E3016`).
    /// `None` preserves raw descriptors for later explicit binding;
    /// `Some(&[])` checks a named zero-parameter message.
    fn check_message_value(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        what: &str,
        params: Option<&[String]>,
    ) {
        let parts = kids(node);
        let base = parts
            .iter()
            .find(|n| n.kind == SyntaxKind::Literal)
            .copied();
        let Some(base) = base else {
            return;
        };
        let base_slots = string_literal_value(base)
            .map(|text| message_slots(&text))
            .unwrap_or_default();
        for slot in &base_slots {
            if params.is_some_and(|params| !params.iter().any(|p| p == slot)) {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!("{what} placeholder '{{{slot}}}' names no message parameter"),
                    tight_span(cx.text, base),
                ));
            }
        }
        let source = self.module_source_tag(cx.module);
        let mut seen: Vec<String> = Vec::new();
        for child in parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::MessageVariant)
        {
            let var_parts = kids(child);
            let key_node = var_parts.first().copied();
            let value_node = var_parts
                .iter()
                .find(|n| n.kind == SyntaxKind::Literal)
                .copied();
            let Some(key_node) = key_node else {
                continue;
            };
            // Variant keys are language identifiers or quoted tags
            // (the parser leaves quoted keys as bare `String` leaves,
            // not `Literal` nodes).
            let tag = if key_node.kind == SyntaxKind::Literal {
                let Some(tag) = string_literal_value(key_node) else {
                    continue;
                };
                tag
            } else if key_node.kind == SyntaxKind::String {
                let Some(tag) = string_leaf_value(key_node) else {
                    continue;
                };
                tag
            } else {
                name_text(key_node, cx.text).unwrap_or("").to_string()
            };
            if let Some(problem) = valid_locale(&tag) {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!("{what} locale '{tag}' is not a valid language tag: {problem}"),
                    tight_span(cx.text, key_node),
                ));
                continue;
            }
            let canonical = tag.to_ascii_lowercase();
            if canonical == source.to_ascii_lowercase() {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!("{what} variant '{tag}' repeats the source language '{source}'"),
                    tight_span(cx.text, key_node),
                ));
            } else if seen.contains(&canonical) {
                self.diags.push(Diagnostic::error(
                    "E3016",
                    format!("{what} has a duplicate '{tag}' variant"),
                    tight_span(cx.text, key_node),
                ));
            } else {
                seen.push(canonical);
            }
            // Variant values are strings or explicit null (absence).
            if let Some(value) = value_node {
                if let Some(text) = string_literal_value(value) {
                    // Variants may use a subset of the signature; every
                    // placeholder must still name a parameter.
                    for slot in message_slots(&text) {
                        if params.is_some_and(|params| !params.iter().any(|p| p == &slot)) {
                            self.diags.push(Diagnostic::error(
                                "E3016",
                                format!(
                                    "{what} placeholder '{{{slot}}}' names no message parameter"
                                ),
                                tight_span(cx.text, value),
                            ));
                        }
                    }
                } else if !invalid_string_literal(value) && !is_null_literal(value, cx.text) {
                    self.diags.push(Diagnostic::error(
                        "E3016",
                        format!("{what} variant '{tag}' must be text or null"),
                        tight_span(cx.text, value),
                    ));
                }
            }
        }
    }

    /// Check a field-label `{text,values}` table: captions everywhere,
    /// `values=` keys owned by the (unwrapped) enum/bool `expected`
    /// type (`E3013`).
    fn check_label_table(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        _what: &str,
        expected: Option<&ResolvedType>,
    ) {
        let parts = kids(node);
        let mut i = 0;
        let mut seen_cases: Vec<String> = Vec::new();
        while i < parts.len() {
            let part = parts[i];
            if is_name(part, cx.text, "text") {
                if let Some(caption) = parts.get(i + 2) {
                    self.check_caption(cx, caption, "text", None);
                }
                i += 3;
                continue;
            }
            if is_name(part, cx.text, "values") {
                // The `values={...}` case map follows as LabelCase
                // children (possibly wrapped in punctuation).
                for case in parts.iter().filter(|n| n.kind == SyntaxKind::LabelCase) {
                    let case_parts = kids(case);
                    let key = case_parts
                        .first()
                        .and_then(|n| name_text(n, cx.text))
                        .or_else(|| {
                            // Bool wire values parse as Name leaves too.
                            case_parts.first().and_then(|n| match n.kind {
                                SyntaxKind::Name | SyntaxKind::Literal => {
                                    literal_leaf(n, cx.text).map(|(_, s)| s)
                                }
                                _ => None,
                            })
                        })
                        .unwrap_or("");
                    let caption = case_parts.iter().find(|n| {
                        matches!(
                            n.kind,
                            SyntaxKind::Literal
                                | SyntaxKind::MessageValue
                                | SyntaxKind::Path
                                | SyntaxKind::Label
                        )
                    });
                    if seen_cases.iter().any(|s| s == key) {
                        self.diags.push(Diagnostic::error(
                            "E3013",
                            format!("duplicate label case '{key}'"),
                            tight_span(cx.text, case),
                        ));
                    } else {
                        seen_cases.push(key.to_string());
                    }
                    if let Some(expected) = expected
                        && !Self::label_case_owned(expected, key)
                    {
                        self.diags.push(Diagnostic::error(
                            "E3013",
                            format!("label case '{key}' is not a case of the labeled type"),
                            tight_span(cx.text, case),
                        ));
                    }
                    if key == "null" {
                        self.diags.push(Diagnostic::error(
                            "E3013",
                            "null keeps shared unavailable presentation, never a label case"
                                .to_string(),
                            tight_span(cx.text, case),
                        ));
                    }
                    if let Some(caption) = caption {
                        self.check_caption(cx, caption, "label case", None);
                    }
                }
                i += 1;
                continue;
            }
            i += 1;
        }
    }

    /// Whether a label `values=` key is owned by the labeled type:
    /// enum cases by name, `true`/`false` for bool (after nullable
    /// unwrapping).
    fn label_case_owned(expected: &ResolvedType, key: &str) -> bool {
        let unwrapped = match expected {
            ResolvedType::Nullable(inner) => inner.as_ref(),
            other => other,
        };
        match unwrapped {
            ResolvedType::Enum { cases, .. } => cases.iter().any(|c| c == key),
            ResolvedType::Scalar(Scalar::Bool) => matches!(key, "true" | "false"),
            _ => false,
        }
    }

    /// Source language tag of `module` (`source=` header or `"en"`).
    fn module_source_tag(&self, module: ModuleId) -> String {
        self.module_source
            .get(&module)
            .cloned()
            .unwrap_or_else(|| "en".to_string())
    }

    /// Check a `require ... message=` value: literal text or a message
    /// value (`E3014`).
    fn check_text_or_message(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, what: &str) {
        if invalid_string_literal(node) || string_literal_value(node).is_some() {
            return;
        }
        if node.kind == SyntaxKind::MessageValue {
            self.check_message_value(cx, node, what, None);
            return;
        }
        if node.kind == SyntaxKind::Path || node.kind == SyntaxKind::NameRef {
            // Resolve never walks `message=`; look the name up as a
            // message directly.
            let segments = path_segments(node, cx.text);
            let name = if node.kind == SyntaxKind::NameRef {
                kids(node)
                    .iter()
                    .find_map(|n| name_text(n, cx.text))
                    .unwrap_or("")
            } else if segments.len() == 1 {
                segments[0]
            } else {
                ""
            };
            if !name.is_empty()
                && let Some(id) = self.prod_or_imported(cx.module, name)
                && let SymbolKind::Message { params } = &self.tables.symbols[id.0 as usize].kind
                && params.is_empty()
            {
                return;
            }
            self.diags.push(Diagnostic::error(
                "E3014",
                format!("{what} must be literal text or a shared message"),
                tight_span(cx.text, node),
            ));
            return;
        }
        // Message calls are legal but resolve never walks
        // `message=`, so validate the callee directly and accept the
        // arguments unchecked.
        if node.kind == SyntaxKind::Call {
            let head = kids(node)
                .iter()
                .find(|n| is_expression(n.kind))
                .and_then(|n| kids(n).iter().find_map(|m| name_text(m, cx.text)))
                .unwrap_or("");
            let is_message = self.prod_or_imported(cx.module, head).is_some_and(|id| {
                matches!(
                    self.tables.symbols[id.0 as usize].kind,
                    SymbolKind::Message { .. }
                )
            });
            if !is_message {
                self.diags.push(Diagnostic::error(
                    "E3014",
                    format!("{what} must be literal text or a shared message"),
                    tight_span(cx.text, node),
                ));
            }
            return;
        }
        // General expressions: accept text or message results.
        let ty = self.expr(cx, node, None);
        match ty {
            ResolvedType::Scalar(Scalar::Text) | ResolvedType::Message(_) => {}
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {}
            other => {
                self.diags.push(Diagnostic::error(
                    "E3014",
                    format!(
                        "{what} must be literal text or a message, found {}",
                        self.show(cx.module, &other)
                    ),
                    tight_span(cx.text, node),
                ));
            }
        }
    }

    // --- Phase 2: field modifiers and preferences -----------------------

    /// Check one `trim`/`unique`/`min=`/`max=` modifier against the
    /// field's declared type (`E3012`): `trim` needs string-like,
    /// `unique` needs non-array, text/array bounds are int lengths and
    /// numeric bounds match the field's scalar.
    fn check_field_modifier(
        &mut self,
        cx: &Ctx<'_, '_>,
        field: &SyntaxNode,
        name: &str,
        expected: &ResolvedType,
        modifier: FieldModifier<'_>,
    ) {
        let unwrapped = match expected {
            ResolvedType::Nullable(inner) => inner.as_ref(),
            other => other,
        };
        match modifier {
            FieldModifier::Machine(word) => {
                let parts = field_parts(field, cx.text);
                let name_span = kids(field).first().map(|n| n.span);
                let stored = self.tables.symbols.iter().any(|symbol| {
                    Some(symbol.span) == name_span && matches!(symbol.kind,
                        SymbolKind::Field { owner, .. } if matches!(self.tables.symbols[owner.0 as usize].kind, SymbolKind::Model { .. }))
                });
                let initial = parts.default.and_then(|n| nameref_word(n, cx.text));
                let valid = stored
                    && parts.server.is_none()
                    && matches!(expected, ResolvedType::Enum { cases, .. } if initial.is_some_and(|v| cases.iter().any(|c| c == v)));
                if !valid {
                    self.diags.push(Diagnostic::error("E3012",
                        format!("field '{name}': machine needs a stored nonnullable enum with a constant initial case"),
                        tight_span(cx.text, word)));
                }
            }
            FieldModifier::Trim(word) => {
                let ok = matches!(unwrapped, ResolvedType::Scalar(s) if s.is_string_like());
                if !ok {
                    self.diags.push(Diagnostic::error(
                        "E3012",
                        format!("field '{name}': trim needs a string-like type"),
                        tight_span(cx.text, word),
                    ));
                }
            }
            FieldModifier::Unique(word) => {
                if matches!(unwrapped, ResolvedType::Array { .. }) {
                    self.diags.push(Diagnostic::error(
                        "E3012",
                        format!("field '{name}': unique needs a non-array type"),
                        tight_span(cx.text, word),
                    ));
                }
            }
            FieldModifier::Min(word) | FieldModifier::Max(word) => {
                let which = if matches!(modifier, FieldModifier::Min(_)) {
                    "min"
                } else {
                    "max"
                };
                let Some(bound) = modifier_value(field, word) else {
                    return;
                };
                // R16/T11: a numeric bound types against the field scalar,
                // so an integral spelling inhabits decimal (length bounds
                // keep `None`: `check_length_bound` owns that check, and an
                // int literal already types int without an expectation).
                let numeric_expect = match unwrapped {
                    ResolvedType::Scalar(s)
                        if matches!(
                            s,
                            Scalar::Int | Scalar::Decimal | Scalar::Money | Scalar::Duration
                        ) =>
                    {
                        Some(ResolvedType::Scalar(*s))
                    }
                    _ => None,
                };
                let bound_ty = self.expr(cx, bound, numeric_expect);
                match unwrapped {
                    ResolvedType::Scalar(s) if s.is_string_like() => {
                        self.check_length_bound(cx, name, which, bound, &bound_ty);
                    }
                    ResolvedType::Array { .. } => {
                        self.check_length_bound(cx, name, which, bound, &bound_ty);
                    }
                    ResolvedType::Scalar(s)
                        if matches!(
                            s,
                            Scalar::Int | Scalar::Decimal | Scalar::Money | Scalar::Duration
                        ) =>
                    {
                        let want = ResolvedType::Scalar(*s);
                        if !bound_ty.is_error() && !self.types_compatible(&bound_ty, &want) {
                            self.diags.push(Diagnostic::error(
                                "E3012",
                                format!(
                                    "field '{name}': {which}= needs {}, found {}",
                                    self.show(cx.module, &want),
                                    self.show(cx.module, &bound_ty)
                                ),
                                tight_span(cx.text, bound),
                            ));
                        }
                    }
                    _ => {
                        self.diags.push(Diagnostic::error(
                            "E3012",
                            format!("field '{name}': {which}= needs a text, array or numeric type"),
                            tight_span(cx.text, word),
                        ));
                    }
                }
            }
        }
    }

    /// Check a text/array length bound: an int, non-negative (`E3012`).
    fn check_length_bound(
        &mut self,
        cx: &Ctx<'_, '_>,
        name: &str,
        which: &str,
        bound: &SyntaxNode,
        bound_ty: &ResolvedType,
    ) {
        let want = ResolvedType::Scalar(Scalar::Int);
        if bound_ty.is_error() {
            return;
        }
        if !self.types_compatible(bound_ty, &want) {
            self.diags.push(Diagnostic::error(
                "E3012",
                format!(
                    "field '{name}': {which}= needs an int length, found {}",
                    self.show(cx.module, bound_ty)
                ),
                tight_span(cx.text, bound),
            ));
            return;
        }
        if let Some(n) = int_literal_value(bound, cx.text)
            && n < 0
        {
            self.diags.push(Diagnostic::error(
                "E3012",
                format!("field '{name}': {which}= length cannot be negative"),
                tight_span(cx.text, bound),
            ));
        }
    }

    /// Check int-literal `min<=max` on one field (`E3012`).
    fn check_min_max_order(
        &mut self,
        cx: &Ctx<'_, '_>,
        field: &SyntaxNode,
        name: &str,
        modifiers: &[FieldModifier<'_>],
    ) {
        let mut min_value = None;
        let mut max_value = None;
        for modifier in modifiers {
            match modifier {
                FieldModifier::Min(word) => {
                    if let Some(bound) = modifier_value(field, word) {
                        min_value = int_literal_value(bound, cx.text).map(|n| (n, bound));
                    }
                }
                FieldModifier::Max(word) => {
                    if let Some(bound) = modifier_value(field, word) {
                        max_value = int_literal_value(bound, cx.text).map(|n| (n, bound));
                    }
                }
                _ => {}
            }
        }
        if let (Some((lo, _)), Some((hi, bound))) = (min_value, max_value)
            && lo > hi
        {
            self.diags.push(Diagnostic::error(
                "E3012",
                format!("field '{name}': min= ({lo}) exceeds max= ({hi})"),
                tight_span(cx.text, bound),
            ));
        }
    }

    /// Check a preferences field type (DESIGN §9): scalars (except
    /// file/secret), enums and nullable model references only (`E3008`).
    fn check_prefs_field_type(
        &mut self,
        text: &str,
        module: ModuleId,
        field: &SyntaxNode,
        name: &str,
        expected: &ResolvedType,
    ) {
        let ok = match expected {
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
            ResolvedType::Scalar(s) => !matches!(s, Scalar::File | Scalar::Secret),
            ResolvedType::Enum { .. } => true,
            ResolvedType::Nullable(inner) => {
                matches!(
                    inner.as_ref(),
                    ResolvedType::Scalar(s) if !matches!(s, Scalar::File | Scalar::Secret)
                ) || matches!(inner.as_ref(), ResolvedType::Enum { .. })
                    || matches!(inner.as_ref(), ResolvedType::Record { .. })
            }
            ResolvedType::Record { .. } => false,
            _ => false,
        };
        if !ok {
            self.diags.push(Diagnostic::error(
                "E3008",
                format!(
                    "preferences field '{name}': {} is not supported in preferences; use a scalar, enum or nullable model reference",
                    self.show(module, expected)
                ),
                tight_span(text, field),
            ));
        }
    }

    /// Check a preferences default is a context-free constant: literals
    /// (including descriptors), claimed enum cases and signed numbers
    /// (`E3011`).
    fn check_prefs_default_const(
        &mut self,
        text: &str,
        _module: ModuleId,
        _field: &SyntaxNode,
        name: &str,
        default: &SyntaxNode,
    ) {
        if !self.is_const_default(default) {
            self.diags.push(Diagnostic::error(
                "E3011",
                format!("preferences field '{name}': the default must be a context-free constant"),
                tight_span(text, default),
            ));
        }
    }

    /// Whether a default expression is a context-free constant.
    fn is_const_default(&self, node: &SyntaxNode) -> bool {
        match node.kind {
            SyntaxKind::Literal | SyntaxKind::MessageValue => true,
            SyntaxKind::NameRef => self.types.resolved_cases.contains(&NodeKey::of(node)),
            SyntaxKind::Group => kids(node)
                .iter()
                .filter(|n| is_expression(n.kind))
                .all(|n| self.is_const_default(n)),
            SyntaxKind::Unary => kids(node)
                .iter()
                .find(|n| is_expression(n.kind))
                .is_some_and(|n| self.is_const_default(n)),
            _ => false,
        }
    }

    // --- Phase 2: call graph -------------------------------------------

    /// Record each module's `source=` language tag (default `"en"`
    /// when absent, via [`Typer::module_source_tag`]). Tag validity is
    /// phase 2's (`E3001`); the raw tag is recorded regardless so
    /// variant checks compare against the authored owner tag.
    fn collect_module_sources(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = module_of_node(self.tables, &text, child) else {
                    continue;
                };
                if let Some(source) = attribute_value(child, "source", &text)
                    && let Some(tag) = string_literal_value(source)
                {
                    self.module_source.insert(module, tag);
                }
            }
        }
    }

    /// Collect `read=true` scenarios before phase 1 (declared
    /// types and callers may precede callees in source).
    fn collect_read_scenarios(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = module_of_node(self.tables, &text, child) else {
                    continue;
                };
                for section in kids(child) {
                    if section.kind != SyntaxKind::Section {
                        continue;
                    }
                    for item in kids(section) {
                        if item.kind != SyntaxKind::Scenario || has_error(item) {
                            continue;
                        }
                        let is_read = attribute_value(item, "read", &text).is_some_and(|attr| {
                            matches!(literal_leaf(attr, &text), Some((_, "true")))
                        });
                        if is_read
                            && let Some(id) =
                                self.decl_symbol(module, &text, item, &["export", "scenario"])
                        {
                            self.read_scenarios.insert(id);
                        }
                    }
                }
            }
        }
    }

    /// Report static `call` cycles over scenarios and derived functions
    /// (`E3005`): synchronous calls cannot recurse (DESIGN §5).
    fn check_cycles(&mut self) {
        let mut edges: HashMap<SymbolId, Vec<(SymbolId, Span)>> = HashMap::new();
        for (caller, callee, span) in &self.call_edges {
            if !self.is_callable_symbol(*caller) || !self.is_callable_symbol(*callee) {
                continue;
            }
            edges.entry(*caller).or_default().push((*callee, *span));
        }
        let mut reported: HashSet<Vec<SymbolId>> = HashSet::new();
        // Prefer declaration-index order for a fixed supplied file order.
        // Sorting only origins preserves authored edge order and closing spans.
        let mut callers: Vec<SymbolId> = edges.keys().copied().collect();
        callers.sort_by_key(|id| id.0);
        for caller in callers {
            // Depth-first search for a path back to `caller`.
            let mut stack: Vec<(SymbolId, Vec<SymbolId>)> = vec![(caller, vec![caller])];
            let mut visited: HashSet<SymbolId> = HashSet::new();
            while let Some((current, path)) = stack.pop() {
                let Some(nexts) = edges.get(&current) else {
                    continue;
                };
                for (next, span) in nexts {
                    if *next == caller && (path.len() > 1 || current == caller) {
                        let mut key = path.clone();
                        key.sort_by_key(|id| id.0);
                        if reported.insert(key) {
                            let mut names: Vec<String> = path
                                .iter()
                                .map(|id| self.tables.symbols[id.0 as usize].name.clone())
                                .collect();
                            names.push(self.tables.symbols[caller.0 as usize].name.clone());
                            self.diags.push(Diagnostic::error(
                                "E3005",
                                format!("call cycle: {}", names.join(" -> ")),
                                *span,
                            ));
                        }
                        continue;
                    }
                    if visited.contains(next) || path.contains(next) {
                        continue;
                    }
                    visited.insert(*next);
                    let mut extended = path.clone();
                    extended.push(*next);
                    stack.push((*next, extended));
                }
            }
        }
    }

    /// Whether a symbol participates in call cycles (scenarios and
    /// derived functions; capability/CRUD operations are leaves).
    fn is_callable_symbol(&self, id: SymbolId) -> bool {
        matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::Scenario { .. } | SymbolKind::DeriveFn { .. }
        )
    }

    // --- Phase 2: rules, selectors and purity ----------------------------

    /// Check a rule by kind: `Policy` (`read`/`where`, `fields=`),
    /// `Unique` (`where`, `fields=`), `Lock` (`when`, `fields=`),
    /// `Retain` (`until=`, deduped) and `Invariant` bodies.
    fn phase2_rule(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        // Rule targets resolve through the production namespace (or
        // the owner's preferences for `invariant preferences:`).
        let target = kids(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::Path)
            .copied();
        let target_symbol =
            target.and_then(|t| self.tables.node_symbol.get(&NodeKey::of(t)).copied());
        let target_model = match target_symbol {
            Some(id) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Model { .. } => Some(id),
                SymbolKind::Preferences { .. } if node.kind == SyntaxKind::Invariant => None,
                _ => {
                    if let Some(target) = target {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!(
                                "rules target models, found {}",
                                record_name(self.tables, module, id)
                            ),
                            tight_span(text, target),
                        ));
                    }
                    None
                }
            },
            None => None,
        };
        match node.kind {
            SyntaxKind::Invariant => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        let ty = self.expr(&cx, child, None);
                        self.expect_bool(&cx, tight_span(text, child), &ty, "invariant");
                    }
                }
            }
            SyntaxKind::Retain => {
                if let Some(model) = target_model {
                    self.check_retain_dedupe(text, node, model);
                }
                if let Some(until) = attribute_value(node, "until", text) {
                    self.check_retain_until(&cx, node, until);
                }
            }
            SyntaxKind::Policy => {
                if let Some(read) = attribute_value(node, "read", text) {
                    let ty = self.expr(&cx, read, None);
                    self.expect_bool(&cx, tight_span(text, read), &ty, "`read=`");
                }
                if let Some(where_) = attribute_value(node, "where", text) {
                    // `read=` authorization narrows `actor` in `where=`
                    // (DESIGN §3), exactly as scenario `by=` does.
                    let mut narrowed = NarrowEnv::default();
                    if attribute_value(node, "read", text)
                        .is_some_and(|read| self.auth_proves_actor(read, text))
                    {
                        narrowed.insert(
                            NarrowKey {
                                decl: DeclKey::CtxActor,
                                path: Vec::new(),
                            },
                            ResolvedType::Scalar(Scalar::User),
                        );
                    }
                    let where_cx = Ctx {
                        module,
                        file,
                        text,
                        narrow: &narrowed,
                        strict: true,
                        server_default: false,
                    };
                    let ty = self.expr(&where_cx, where_, None);
                    self.expect_bool(&where_cx, tight_span(text, where_), &ty, "`where=`");
                }
                if let Some(model) = target_model
                    && let Some(fields) = attribute_value(node, "fields", text)
                {
                    // Policy grants are a read context: readable
                    // metadata is selectable (T08/R07); grants confer
                    // no flow fact and no write permission.
                    self.check_selectors(&cx, node, model, fields, "fields", true);
                }
            }
            SyntaxKind::Unique => {
                if let Some(value) = attribute_value(node, "where", text) {
                    let ty = self.expr(&cx, value, None);
                    self.expect_bool(&cx, tight_span(text, value), &ty, "`where=`");
                }
                if let Some(model) = target_model
                    && let Some(fields) = attribute_value(node, "fields", text)
                {
                    self.check_selectors(&cx, node, model, fields, "fields", false);
                }
            }
            SyntaxKind::Lock => {
                if let Some(when) = attribute_value(node, "when", text) {
                    if matches!(literal_leaf(when, text), Some((_, "true"))) {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            "an omitted lock predicate already means true; do not repeat when=true"
                                .to_string(),
                            tight_span(text, when),
                        ));
                    }
                    let ty = self.expr(&cx, when, None);
                    self.expect_bool(&cx, tight_span(text, when), &ty, "`when=`");
                }
                if let Some(model) = target_model
                    && let Some(fields) = attribute_value(node, "fields", text)
                {
                    self.check_selectors(&cx, node, model, fields, "fields", false);
                }
            }
            _ => {}
        }
    }

    /// Reject a second `retain` on one model (`E3017`).
    fn check_retain_dedupe(&mut self, text: &str, node: &SyntaxNode, model: SymbolId) {
        if let Some(first) = self.retain_seen.get(&model) {
            let mut diagnostic = Diagnostic::error(
                "E3017",
                format!(
                    "duplicate retain for model '{}'; at most one lifetime per model",
                    self.tables.symbols[model.0 as usize].name
                ),
                tight_span(text, node),
            );
            diagnostic.related.push(Related {
                span: *first,
                message: "first retain here".to_string(),
            });
            self.diags.push(diagnostic);
        } else {
            self.retain_seen.insert(model, tight_span(text, node));
        }
    }

    /// Check `retain ... until=`: a pure `datetime?` in `row` scope
    /// without clock/caller/operation/random dependencies (`E3017`).
    fn check_retain_until(&mut self, cx: &Ctx<'_, '_>, _node: &SyntaxNode, until: &SyntaxNode) {
        let ty = self.expr(cx, until, None);
        let ok = matches!(
            ty,
            ResolvedType::Scalar(Scalar::Datetime)
                | ResolvedType::Nullable(_)
                | ResolvedType::Null
                | ResolvedType::Error
                | ResolvedType::Unknown
                | ResolvedType::Opaque(_)
        ) && match &ty {
            ResolvedType::Nullable(inner) => {
                matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::Datetime))
            }
            _ => true,
        };
        if !ok {
            self.diags.push(Diagnostic::error(
                "E3017",
                format!(
                    "retain until= must be datetime?, found {}",
                    self.show(cx.module, &ty)
                ),
                tight_span(cx.text, until),
            ));
        }
        for banned in ["actor", "now", "operation"] {
            if expr_uses_name(until, cx.text, banned) {
                self.diags.push(Diagnostic::error(
                    "E3017",
                    format!("retain until= cannot use {banned}"),
                    tight_span(cx.text, until),
                ));
            }
        }
        for (name, span) in self.effectful_calls(until, cx.text) {
            self.diags.push(Diagnostic::error(
                "E3017",
                format!("retain until= must be pure; '{name}' is not allowed here"),
                span,
            ));
        }
    }

    /// Validate `Selectors` paths against a model: every path must
    /// navigate canonical member information (declared fields,
    /// readable metadata in read contexts, contained-model `parent`,
    /// singular embedded value leaves), descending through singular
    /// embedded values only; descending markers belong to `order=`
    /// (`E2013`/`E3001`). Accepted selectors confer no narrowing fact
    /// and no permission. Returns the selected dotted paths.
    fn check_selectors(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        selectors: &SyntaxNode,
        what: &str,
        allow_reserved: bool,
    ) -> Vec<String> {
        let mut selected = Vec::new();
        if selectors.kind != SyntaxKind::Selectors {
            return selected;
        }
        for child in kids(selectors) {
            let (path, descending) = match child.kind {
                SyntaxKind::Path => (child, false),
                SyntaxKind::Descending => (
                    kids(child)
                        .iter()
                        .find(|n| n.kind == SyntaxKind::Path)
                        .copied()
                        .unwrap_or(child),
                    true,
                ),
                _ => continue,
            };
            if descending && what != "order" {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("descending markers belong to order=, not {what}="),
                    tight_span(cx.text, child),
                ));
            }
            let segments = path_segments(path, cx.text);
            if segments.is_empty() {
                continue;
            }
            // Policy `fields=` and UI `columns=` additionally accept
            // delivery-observation leaves (DESIGN §8.1, B4 scope;
            // A5/S2 keeps `filter=`/`search=` excluded until
            // predicate-observation lowering lands); every other
            // selector keeps the contract-only rule below.
            if segments.len() > 1
                && (node.kind == SyntaxKind::Policy || what == "columns")
                && let Some(canonical) = self.selector_delivery_leaf(model, &segments)
            {
                self.types
                    .delivery_selectors
                    .insert(NodeKey::of(path), canonical.clone());
                selected.push(canonical);
                continue;
            }
            if self.navigate_selector(cx, node, model, path, &segments, allow_reserved) {
                selected.push(segments.join("."));
            }
        }
        selected
    }

    /// Whether a selector path ends at a delivery-observation leaf
    /// (`id`/`status`/`error`/`result` on a delivery value) with an
    /// expression-resolvable prefix (DESIGN §7.1 delivery-observation
    /// leaves, e.g. `notification.status`, `request.error`,
    /// `current.request.status`). Declared std result objects also admit
    /// their typed children. Silent (no diagnostics): the legacy navigation
    /// below reports failures.
    fn selector_delivery_leaf(&self, model: SymbolId, segments: &[&str]) -> Option<String> {
        let first = self.model_field_named(model, segments[0])?;
        let mut current = self.decl_type(first);
        let mut canonical: Vec<String> = segments
            .iter()
            .map(|segment| (*segment).to_string())
            .collect();
        let mut observed = false;
        let rest = &segments[1..];
        for (i, segment) in rest.iter().enumerate() {
            let last = i == rest.len() - 1;
            current = current.nullable_inner().unwrap_or(&current).clone();
            match &current {
                ResolvedType::Record { symbol, .. } => {
                    current = self.decl_type(self.record_field_named(*symbol, segment)?);
                }
                ResolvedType::StdDelivery { op, .. }
                    if *segment == "result"
                        || (*segment == "progress" && delivery_progress_alias(&current)) =>
                {
                    if *segment == "progress" {
                        canonical[i + 1] = "result".to_string();
                    }
                    observed = true;
                    if last {
                        return Some(canonical.join("."));
                    }
                    current = std_delivery_result_type(op);
                }
                ResolvedType::Delivery { .. }
                | ResolvedType::StdDelivery { .. }
                | ResolvedType::Opaque(_) => {
                    return (last && matches!(*segment, "id" | "status" | "error" | "result"))
                        .then(|| canonical.join("."));
                }
                ResolvedType::Object(fields) if observed => {
                    current = fields.iter().find(|(name, _)| name == segment)?.1.clone();
                }
                _ => return None,
            }
        }
        observed.then(|| canonical.join("."))
    }

    /// Push an `E2013` for a selector path that names no canonical
    /// member.
    fn selector_fail(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        name: &str,
    ) {
        self.member_fail(
            node,
            tight_span(cx.text, path),
            format!("model {}", record_name(self.tables, cx.module, model)),
            name.to_string(),
        );
    }

    /// Navigate one selector path from `model`: declared fields,
    /// readable metadata (read contexts only), contained-model
    /// `parent` and singular embedded value leaves — the same roots
    /// expression member lookup accepts (T08 canonical agreement;
    /// R07/R08). Interior components must be singular embedded typed
    /// values, never references, arrays or authorities (DESIGN §4);
    /// unknown leaves, invalid terminal descent, unauthorized
    /// traversal and disclosure keep failing. Poisoned (`Error`) and
    /// unknown (`Unknown`) bases stay silent (cascade suppression);
    /// unavailable-schema (`Opaque`) bases defer silently, exactly as
    /// in expressions, except the known delivery-observation leaves
    /// stay terminal (B4). Reports `E2013` and returns `false` on
    /// failure.
    fn navigate_selector(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        allow_reserved: bool,
    ) -> bool {
        // Declared fields first, exactly as expression lookup orders
        // them (a declared field shadows same-spelled metadata).
        let mut current = if let Some(field) = self.model_field_named(model, segments[0]) {
            self.decl_type(field)
        } else if segments[0] == "parent" {
            // Contained-model `parent` (DESIGN §2/§4); terminal in
            // selectors (a grant cannot name another record's fields).
            let Some(parent) = contained_parent_of(self.tables, model) else {
                self.selector_fail(cx, node, model, path, segments[0]);
                return false;
            };
            ResolvedType::Record {
                symbol: parent,
                stored: true,
            }
        } else if is_reserved_name(segments[0]) {
            // Readable record metadata in read/grant contexts only;
            // write contexts (CRUD inputs, locks, uniqueness) keep
            // rejecting it, and metadata writes stay rejected.
            if !allow_reserved {
                self.selector_fail(cx, node, model, path, segments[0]);
                return false;
            }
            let Some(ty) = reserved_member_type(segments[0]) else {
                self.selector_fail(cx, node, model, path, segments[0]);
                return false;
            };
            ty
        } else {
            self.selector_fail(cx, node, model, path, segments[0]);
            return false;
        };
        let rest = &segments[1..];
        for (i, segment) in rest.iter().enumerate() {
            let last = i == rest.len() - 1;
            let inner = match &current {
                ResolvedType::Nullable(inner) => inner.as_ref().clone(),
                other => other.clone(),
            };
            match &inner {
                // Deferral, mirroring expression member lookup: an
                // already-diagnosed base stays silent (cascade
                // suppression) and an unavailable-schema base stays
                // silent (supported-but-unavailable; T13 schemas will
                // type it later).
                ResolvedType::Error | ResolvedType::Unknown => return true,
                ResolvedType::Opaque(payload) => {
                    // Known delivery-observation leaves stay terminal
                    // on deployment-bound deliveries (B4); every other
                    // opaque member defers to the pending schema.
                    if payload == &"external delivery target"
                        && matches!(segment, &"id" | &"status" | &"error" | &"result")
                        && !last
                    {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                    return true;
                }
                ResolvedType::Record { symbol, .. } => {
                    // Interior components must be singular embedded
                    // values, never references, arrays or authorities
                    // (DESIGN §4): only contracts navigate.
                    if !matches!(
                        self.tables.symbols[symbol.0 as usize].kind,
                        SymbolKind::Contract { .. }
                    ) {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                    let Some(next) = self.record_field_named(*symbol, segment) else {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    };
                    current = self.decl_type(next);
                }
                // Singular embedded value leaves, exactly as
                // expressions read them (R08; DESIGN §3/§4).
                ResolvedType::Scalar(Scalar::Money) => match *segment {
                    "minor" => current = ResolvedType::Scalar(Scalar::Int),
                    "currency" => current = ResolvedType::Scalar(Scalar::Currency),
                    _ => {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                },
                ResolvedType::Scalar(Scalar::User) => match *segment {
                    // Stable `user.id` is readable (DESIGN §3);
                    // account contact stays disclosure-gated (only
                    // `actor.email` reads, and selectors never have an
                    // actor root).
                    "id" => current = ResolvedType::Scalar(Scalar::Text),
                    _ => {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                },
                ResolvedType::Scalar(Scalar::Member) => match *segment {
                    "id" => current = ResolvedType::Scalar(Scalar::Text),
                    "user" => current = ResolvedType::Scalar(Scalar::User),
                    "team" => current = ResolvedType::Team,
                    _ => {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                },
                ResolvedType::Team => match *segment {
                    "id" => current = ResolvedType::Scalar(Scalar::Text),
                    "timezone" => current = ResolvedType::Scalar(Scalar::Timezone),
                    _ => {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                },
                ResolvedType::OperationContext => match *segment {
                    "id" | "source" => current = ResolvedType::Scalar(Scalar::Text),
                    _ => {
                        self.selector_fail(cx, node, model, path, &segments.join("."));
                        return false;
                    }
                },
                // Every other base rejects deeper navigation: unknown
                // scalar leaves, arrays, delivery interiors past the
                // B4 observation leaves (accepted above, never
                // descended), unions, actions and operations
                // (DESIGN §4).
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    return false;
                }
            }
        }
        true
    }

    /// Effectful builtin calls under `node`: (name, span) for every
    /// call whose catalog effects are not pure. Without a catalog,
    /// nothing is known effectful.
    fn effectful_calls(&self, node: &SyntaxNode, text: &str) -> Vec<(String, Span)> {
        let mut found = Vec::new();
        self.collect_effectful(node, text, &mut found);
        found
    }

    /// Walk helper for [`Typer::effectful_calls`].
    fn collect_effectful(&self, node: &SyntaxNode, text: &str, found: &mut Vec<(String, Span)>) {
        if node.kind == SyntaxKind::Call
            && let Some(head) = kids(node)
                .iter()
                .find(|n| is_expression(n.kind))
                .and_then(|n| kids(n).iter().find_map(|m| name_text(m, text)))
        {
            let effectful = self
                .catalog
                .and_then(|c| c.effects(head))
                .is_some_and(|e| e != Effects::Pure);
            if effectful {
                found.push((head.to_string(), tight_span(text, node)));
            }
        }
        for child in &node.children {
            self.collect_effectful(child, text, found);
        }
    }

    /// Check a `send ... when=` dispatch guard is pure (`E3010`).
    fn check_when_pure(&mut self, cx: &Ctx<'_, '_>, when: &SyntaxNode) {
        for (name, span) in self.effectful_calls(when, cx.text) {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("when= must be a pure dispatch guard; '{name}' is not allowed here"),
                span,
            ));
        }
    }

    // --- Phase 2: context, roles, derives, messages ----------------------

    /// Check the deployment context blocks of one app/package
    /// (GRAMMAR `context_*` rows): queue names are collected for
    /// `schedule queue=` validation, `ttl=`/`max=` must be positive
    /// durations/quantities, theme/locale values are closed sets and
    /// well-formed BCP 47, and conflicting duplicate declarations are
    /// `E2002`. Attribute presence the parser pins (`key=`, `type=`)
    /// is not re-checked.
    fn phase2_context(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for context in kids(node) {
            if context.kind != SyntaxKind::Context || has_error(context) {
                continue;
            }
            for decl in kids(context) {
                if decl.kind != SyntaxKind::ContextDecl || has_error(decl) {
                    continue;
                }
                let names: Vec<&str> = kids(decl)
                    .iter()
                    .filter_map(|n| name_text(n, text))
                    .collect();
                let head = names.first().copied().unwrap_or("");
                let decl_name = match head {
                    "queue" | "binding" | "analytics" => names.get(1).copied().unwrap_or(""),
                    _ => "",
                };
                if !matches!(head, "" | "queue")
                    && !seen.insert((head.to_string(), decl_name.to_string()))
                {
                    self.diags.push(Diagnostic::error(
                        "E2002",
                        format!("duplicate context declaration '{head}'"),
                        tight_span(text, decl),
                    ));
                    continue;
                }
                match head {
                    "queue" => {
                        if !decl_name.is_empty()
                            && !self.queue_names.insert((module, decl_name.to_string()))
                        {
                            self.diags.push(Diagnostic::error(
                                "E2002",
                                format!("duplicate queue '{decl_name}'"),
                                tight_span(text, decl),
                            ));
                        }
                        if let Some(ty) = attribute_value(decl, "type", text) {
                            let _ = self.resolve_type_node(file, text, module, ty, None);
                        }
                    }
                    "cache" => {
                        if let Some(ttl) = attribute_value(decl, "ttl", text) {
                            let ty = self.expr(&cx, ttl, None);
                            match &ty {
                                ResolvedType::Scalar(Scalar::Duration) => {
                                    if duration_value(ttl, text).is_some_and(|ms| ms <= 0) {
                                        self.diags.push(Diagnostic::error(
                                            "E3001",
                                            "cache ttl must be a positive duration".to_string(),
                                            tight_span(text, ttl),
                                        ));
                                    }
                                }
                                ResolvedType::Error
                                | ResolvedType::Unknown
                                | ResolvedType::Opaque(_) => {}
                                _ => {
                                    self.diags.push(Diagnostic::error(
                                        "E3001",
                                        "cache ttl must be a duration".to_string(),
                                        tight_span(text, ttl),
                                    ));
                                }
                            }
                        }
                    }
                    "files" => {
                        if let Some(max) = attribute_value(decl, "max", text) {
                            let ty = self.expr(&cx, max, None);
                            match &ty {
                                ResolvedType::Scalar(Scalar::Bytes) => {
                                    if bytes_value(max, text).is_some_and(|n| n <= 0) {
                                        self.diags.push(Diagnostic::error(
                                            "E3001",
                                            "files max must be a positive byte quantity"
                                                .to_string(),
                                            tight_span(text, max),
                                        ));
                                    }
                                }
                                ResolvedType::Error
                                | ResolvedType::Unknown
                                | ResolvedType::Opaque(_) => {}
                                _ => {
                                    self.diags.push(Diagnostic::error(
                                        "E3001",
                                        "files max must be a byte quantity".to_string(),
                                        tight_span(text, max),
                                    ));
                                }
                            }
                        }
                        // `types=` is a parser-pinned STRING; the
                        // media-type allowlist format is unspecified,
                        // so no value check (reported gap).
                    }
                    "theme" => {
                        let mut present = false;
                        for (key, allowed) in [
                            ("mode", &["system", "light", "dark"][..]),
                            ("accent", &["blue", "green", "purple"][..]),
                            ("density", &["comfortable", "compact"][..]),
                        ] {
                            if let Some(value) = attribute_value(decl, key, text) {
                                present = true;
                                let word = nameref_word(value, text).unwrap_or("");
                                if !allowed.contains(&word) {
                                    self.diags.push(Diagnostic::error(
                                        "E3001",
                                        format!(
                                            "theme {key} must be one of {}",
                                            allowed.join(", ")
                                        ),
                                        tight_span(text, value),
                                    ));
                                }
                            }
                        }
                        if !present {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                "theme needs at least one of mode=, accent= or density="
                                    .to_string(),
                                tight_span(text, decl),
                            ));
                        }
                    }
                    "locale" => {
                        if let Some(default) = attribute_value(decl, "default", text)
                            && let Some(tag) = string_literal_value(default)
                            && let Some(problem) = valid_locale(&tag)
                        {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                format!("locale default: {problem}"),
                                tight_span(text, default),
                            ));
                        }
                    }
                    "analytics" => {
                        for field in kids(decl) {
                            if field.kind != SyntaxKind::Field || has_error(field) {
                                continue;
                            }
                            let ty = kids(field)
                                .iter()
                                .find(|n| is_type_node(n.kind))
                                .map(|t| self.resolve_type_node(file, text, module, t, None))
                                .unwrap_or(ResolvedType::Error);
                            if let Some(label) = attribute_value(field, "label", text) {
                                let name = kids(field)
                                    .iter()
                                    .find_map(|n| name_text(n, text))
                                    .unwrap_or("field");
                                self.check_field_label(&cx, field, name, &ty, label);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// Check app/package header attributes: `source=` must be a
    /// well-formed BCP 47 tag and `label=` a scalar caption. `uses=`
    /// membership is resolve's.
    fn phase2_owner_attrs(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) {
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        if let Some(source) = attribute_value(node, "source", text)
            && let Some(tag) = string_literal_value(source)
            && let Some(problem) = valid_locale(&tag)
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("source language: {problem}"),
                tight_span(text, source),
            ));
        }
        if let Some(label) = attribute_value(node, "label", text) {
            self.check_scalar_caption(&cx, label, "label");
        }
    }

    /// Check a role declaration: roles carry only a label caption
    /// (GRAMMAR `role` row); membership is not a role-suite concept.
    fn phase2_role(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        if let Some(label) = attribute_value(node, "label", text) {
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            self.check_scalar_caption(&cx, label, "label");
        }
    }

    /// Find the symbol a `derive` path declares: derived functions
    /// use a package-local prod name, derived fields resolve via the
    /// canonical `Module.Model.field` registration.
    fn derive_symbol(&self, module: ModuleId, text: &str, node: &SyntaxNode) -> Option<SymbolId> {
        let path = kids(node)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::Path)?;
        let segments = path_segments(path, text);
        if segments.len() == 1 {
            match self.tables.module_scopes[module.0 as usize]
                .prod
                .get(segments[0])
            {
                Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(*id),
                _ => None,
            }
        } else if segments.len() == 2 {
            let module_name = &self.tables.modules[module.0 as usize].name;
            let canonical = format!("{}.{}.{}", module_name, segments[0], segments[1]);
            self.tables.by_canonical.get(&canonical).copied()
        } else {
            None
        }
    }

    /// Check a derived field/function: parameter defaults, body
    /// purity (`E3010`), the value against the declared type
    /// (`E3001`) and the trailing field label. Path ownership
    /// (`E2014`) is resolve's.
    fn phase2_derive(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let Some(id) = self.derive_symbol(module, text, node) else {
            return;
        };
        let (params, expected, what) = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::DeriveFn { params, .. } => {
                let ty = kids(node)
                    .iter()
                    .find(|n| is_type_node(n.kind))
                    .map(|t| self.resolve_type_node(file, text, module, t, Some(id)))
                    .unwrap_or(ResolvedType::Error);
                (params.clone(), ty, "derived function")
            }
            SymbolKind::DeriveField { .. } => (Vec::new(), self.decl_type(id), "derived field"),
            _ => return,
        };
        if !params.is_empty() {
            self.check_param_defaults(file, text, module, node, &params);
        }
        let mut after_path = false;
        let mut value = None;
        for part in kids(node) {
            if part.kind == SyntaxKind::Path {
                after_path = true;
            } else if after_path && is_expression(part.kind) {
                value = Some(part);
                break;
            }
        }
        if let Some(label) = kids(node).iter().find(|n| n.kind == SyntaxKind::Label) {
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            let name = self.tables.symbols[id.0 as usize].name.clone();
            self.check_field_label(&cx, node, &name, &expected, label);
        }
        let Some(value) = value else { return };
        for (name, span) in self.effectful_calls(value, text) {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("{what} value must be pure; '{name}' is not allowed here"),
                span,
            ));
        }
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let actual = self.expr(&cx, value, Some(expected.clone()));
        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "{what}: expected {}, found {}",
                    self.show(module, &expected),
                    self.show(module, &actual)
                ),
                tight_span(text, value),
            ));
        }
    }

    /// Check a named message: parameter defaults plus the inline
    /// descriptor slots against the parameter names (`E3014`). ICU
    /// pattern validation belongs to a later stage.
    fn phase2_message(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let Some(id) = self.decl_symbol(module, text, node, &["export", "message"]) else {
            return;
        };
        let SymbolKind::Message { params } = &self.tables.symbols[id.0 as usize].kind else {
            return;
        };
        let params = params.clone();
        self.check_param_defaults(file, text, module, node, &params);
        let names: Vec<String> = params
            .iter()
            .map(|p| self.tables.symbols[p.0 as usize].name.clone())
            .collect();
        if let Some(value) = kids(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::MessageValue)
        {
            let narrow = NarrowEnv::default();
            let cx = Self::body_cx(module, file, text, &narrow);
            self.check_message_value(&cx, value, "message", Some(&names));
        }
    }

    /// Check a capability declaration: `version=` must be an int
    /// literal, operation signatures contribute parameter defaults,
    /// and event schemas check as fields. Operations are
    /// signature-only (no suite).
    fn phase2_capability(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) {
        let Some(cap) = self.decl_symbol(module, text, node, &["export", "capability"]) else {
            return;
        };
        if let Some(version) = attribute_value(node, "version", text)
            && int_literal_value(version, text).is_none()
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "capability version must be an int literal".to_string(),
                tight_span(text, version),
            ));
        }
        for child in kids(node) {
            if has_error(child) {
                continue;
            }
            match child.kind {
                SyntaxKind::CapabilityOp => {
                    let Some(op) = self.member_symbol(cap, text, child) else {
                        continue;
                    };
                    if let SymbolKind::CapabilityOp { params, .. } =
                        &self.tables.symbols[op.0 as usize].kind
                    {
                        let params = params.clone();
                        self.check_param_defaults(file, text, module, child, &params);
                    }
                }
                SyntaxKind::Event => {
                    let Some(event) = self.member_symbol(cap, text, child) else {
                        continue;
                    };
                    for field in kids(child) {
                        if field.kind == SyntaxKind::Field && !has_error(field) {
                            self.phase2_field(file, text, module, event, field, false);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Check a CRUD declaration (GRAMMAR `CRUD` row): `by=`/`fields=`
    /// are required, selector lists navigate the target model without
    /// reserved or server-owned inputs, mode values are the closed
    /// explicit sets, `expose=` names enabled operations (or sole
    /// `none`) and `label=` is a closed enabled-operation caption map.
    fn phase2_crud(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let path = kids(node).into_iter().find(|n| n.kind == SyntaxKind::Path);
        let model = path.and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
        let Some(model) = model else { return };
        if !matches!(
            self.tables.symbols[model.0 as usize].kind,
            SymbolKind::Model { .. }
        ) {
            return;
        }
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let Some(crud) = self.tables.crud_of_model.get(&model).copied() else {
            return;
        };
        let (create, update, delete) = match &self.tables.symbols[crud.0 as usize].kind {
            SymbolKind::Crud {
                create,
                update,
                delete,
                ..
            } => (*create, *update, *delete),
            _ => return,
        };
        let enabled = |op: &str| match op {
            "create" => create,
            "update" => update,
            "delete" => delete,
            _ => false,
        };
        let Some(by) = attribute_value(node, "by", text) else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "crud needs by=".to_string(),
                tight_span(text, node),
            ));
            return;
        };
        let ty = self.expr(&cx, by, None);
        self.expect_bool(&cx, tight_span(text, by), &ty, "`by=`");
        let fields = attribute_value(node, "fields", text);
        let Some(fields) = fields else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "crud needs fields=".to_string(),
                tight_span(text, node),
            ));
            return;
        };
        let selected = self.check_selectors(&cx, node, model, fields, "fields=", false);
        self.check_crud_inputs(model, text, fields, &selected);
        if let Some(narrow) = attribute_value(node, "create_fields", text) {
            let created = self.check_selectors(&cx, node, model, narrow, "create_fields=", false);
            self.check_crud_inputs(model, text, narrow, &created);
            let mut a = selected.clone();
            let mut b = created.clone();
            a.sort();
            b.sort();
            if a == b {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    "do not copy an identical list into create_fields=".to_string(),
                    tight_span(text, narrow),
                ));
            }
        }
        if let Some(when) = attribute_value(node, "when", text) {
            // `by=` authorization narrows `actor` in `when=` (T06),
            // exactly as policy `read=` does for `where=`: the guard
            // runs only for admitted callers.
            let mut narrowed = NarrowEnv::default();
            if self.auth_proves_actor(by, text) {
                narrowed.insert(
                    NarrowKey {
                        decl: DeclKey::CtxActor,
                        path: Vec::new(),
                    },
                    ResolvedType::Scalar(Scalar::User),
                );
            }
            let when_cx = Ctx {
                module,
                file,
                text,
                narrow: &narrowed,
                strict: true,
                server_default: false,
            };
            let ty = self.expr(&when_cx, when, None);
            self.expect_bool(&when_cx, tight_span(text, when), &ty, "`when=`");
            self.check_when_pure(&when_cx, when);
        }
        for key in ["create", "update"] {
            if let Some(mode) = attribute_value(node, key, text) {
                let word = nameref_word(mode, text).unwrap_or("");
                if word != "none" {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!("unknown {key} mode '{word}'; {key}= supports only none"),
                        tight_span(text, mode),
                    ));
                }
            }
        }
        if let Some(mode) = attribute_value(node, "delete", text) {
            match nameref_word(mode, text).unwrap_or("") {
                "none" | "remove" => {}
                "archive" => {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "delete=archive is the default; do not repeat it".to_string(),
                        tight_span(text, mode),
                    ));
                }
                word => {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        format!("unknown delete mode '{word}'"),
                        tight_span(text, mode),
                    ));
                }
            }
        }
        if let Some(expose) = attribute_value(node, "expose", text) {
            self.check_crud_expose(text, expose, enabled);
        }
        if let Some(label) = attribute_value(node, "label", text) {
            self.check_crud_labels(&cx, label, enabled);
        }
        for child in kids(node) {
            if child.kind == SyntaxKind::Examples && !has_error(child) {
                self.check_example_headers(file, text, module, child, None);
            }
        }
    }

    /// Reject server-owned fields selected as CRUD inputs (`E3009`):
    /// the server prepares those without staging the write.
    fn check_crud_inputs(
        &mut self,
        model: SymbolId,
        text: &str,
        node: &SyntaxNode,
        selected: &[String],
    ) {
        for name in selected {
            if let Some(field) = self.model_field_named(model, name)
                && (self.field_is_server(field) || self.machines.contains(&field))
            {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!(
                        "'{name}' is {} and cannot be a CRUD input",
                        if self.machines.contains(&field) {
                            "machine-managed"
                        } else {
                            "server-owned"
                        }
                    ),
                    tight_span(text, node),
                ));
            }
        }
    }

    /// Check `expose=`: operation names (or sole `none`), no
    /// duplicates, no mixing `none`, only enabled operations.
    fn check_crud_expose(
        &mut self,
        text: &str,
        expose: &SyntaxNode,
        enabled: impl Fn(&str) -> bool,
    ) {
        if expose.kind != SyntaxKind::Selectors {
            return;
        }
        let mut seen: Vec<String> = Vec::new();
        for child in kids(expose) {
            // Comma separators carry no word (mirrors
            // `check_selectors`; without this multi-value
            // allowlists spuriously fail on the comma).
            if child.kind == SyntaxKind::Punct {
                continue;
            }
            let word = match child.kind {
                SyntaxKind::Path => {
                    let segments = path_segments(child, text);
                    if segments.len() != 1 {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            "expose= names operations (create, update, delete) or sole none"
                                .to_string(),
                            tight_span(text, child),
                        ));
                        continue;
                    }
                    segments[0].to_string()
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "expose= names operations (create, update, delete) or sole none"
                            .to_string(),
                        tight_span(text, child),
                    ));
                    continue;
                }
            };
            if !matches!(word.as_str(), "create" | "update" | "delete" | "none") {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!("unknown exposed operation '{word}'"),
                    tight_span(text, child),
                ));
                continue;
            }
            if seen.contains(&word) {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!("duplicate exposed operation '{word}'"),
                    tight_span(text, child),
                ));
                continue;
            }
            seen.push(word);
        }
        if seen.contains(&"none".to_string()) && seen.len() > 1 {
            self.diags.push(Diagnostic::error(
                "E3009",
                "expose=none cannot be combined with operations".to_string(),
                tight_span(text, expose),
            ));
        }
        for word in &seen {
            if word != "none" && !enabled(word) {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!("'{word}' is not enabled and cannot be exposed"),
                    tight_span(text, expose),
                ));
            }
        }
    }

    /// Check scenario `expose=`: sole `none` (closed set), mirroring
    /// the CRUD publication allowlist (`E3009`). Omission exposes the
    /// operation (current behavior); `none` excludes it from
    /// publication. Unknown selectors, duplicates and non-word shapes
    /// fail checking with a precise diagnostic.
    ///
    /// EXTENSION POINT: future publication surfaces (e.g. `http`,
    /// `mcp`) widen this closed set. Each new surface needs its
    /// emission rule beside the `expose=none` skip in
    /// `collect_operations` (`codegen/js.rs`).
    fn check_scenario_expose(&mut self, text: &str, expose: &SyntaxNode) {
        if expose.kind != SyntaxKind::Selectors {
            return;
        }
        let mut seen: Vec<String> = Vec::new();
        for child in kids(expose) {
            // Comma separators carry no word (mirrors
            // `check_selectors`).
            if child.kind == SyntaxKind::Punct {
                continue;
            }
            let word = match child.kind {
                SyntaxKind::Path => {
                    let segments = path_segments(child, text);
                    if segments.len() != 1 {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            "expose= accepts only sole none".to_string(),
                            tight_span(text, child),
                        ));
                        continue;
                    }
                    segments[0].to_string()
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "expose= accepts only sole none".to_string(),
                        tight_span(text, child),
                    ));
                    continue;
                }
            };
            if word != "none" {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!(
                        "unknown exposed surface '{word}' (scenario expose= accepts only none)"
                    ),
                    tight_span(text, child),
                ));
                continue;
            }
            if seen.contains(&word) {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    format!("duplicate exposed surface '{word}'"),
                    tight_span(text, child),
                ));
                continue;
            }
            seen.push(word);
        }
    }

    /// Check `label=` on CRUD: closed `{create,update,delete}` keys
    /// over enabled operations, each a caption (`E3013`).
    fn check_crud_labels(
        &mut self,
        cx: &Ctx<'_, '_>,
        label: &SyntaxNode,
        enabled: impl Fn(&str) -> bool,
    ) {
        if label.kind != SyntaxKind::CrudLabels {
            return;
        }
        let keys: Vec<&str> = kids(label)
            .iter()
            .filter_map(|n| {
                if n.kind == SyntaxKind::Name {
                    name_text(n, cx.text)
                } else {
                    None
                }
            })
            .collect();
        let captions: Vec<&SyntaxNode> = kids(label)
            .into_iter()
            .filter(|n| {
                matches!(
                    n.kind,
                    SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
                )
            })
            .collect();
        for (i, key) in keys.iter().enumerate() {
            if !matches!(*key, "create" | "update" | "delete") {
                self.diags.push(Diagnostic::error(
                    "E3013",
                    format!("unknown crud label '{key}'"),
                    tight_span(cx.text, label),
                ));
                continue;
            }
            if !enabled(key) {
                self.diags.push(Diagnostic::error(
                    "E3013",
                    format!("label for disabled operation '{key}'"),
                    tight_span(cx.text, label),
                ));
            }
            if let Some(caption) = captions.get(i) {
                self.check_caption(cx, caption, "crud label", None);
            }
        }
    }

    /// Check a page (GRAMMAR `page` row): required static `title=`,
    /// pure-read `data=`, constant `order=`/`poll=`, static `group=`,
    /// `nav=none`, and `refresh=` naming a canonical user mutation
    /// with `poll=` present; then the widget suite.
    fn phase2_page(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let Some(title) = attribute_value(node, "title", text) else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "page needs title=".to_string(),
                tight_span(text, node),
            ));
            return;
        };
        self.check_page_static_text(&cx, title, "page title");
        if let Some(data) = attribute_value(node, "data", text) {
            if data.kind != SyntaxKind::Call {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "page data must be a read call".to_string(),
                    tight_span(text, data),
                ));
            } else {
                let ty = self.expr(&cx, data, None);
                let _ = ty;
                let callee = kids(data)
                    .iter()
                    .find(|n| n.kind == SyntaxKind::Path)
                    .and_then(|p| self.tables.node_symbol.get(&NodeKey::of(p)).copied());
                match callee {
                    Some(id) if self.callee_is_read(id) => {}
                    _ => {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            "page data must be a pure read call".to_string(),
                            tight_span(text, data),
                        ));
                    }
                }
                for (name, span) in self.effectful_calls(data, text) {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("page data must be pure; '{name}' is not allowed here"),
                        span,
                    ));
                }
            }
        }
        if let Some(order) = attribute_value(node, "order", text)
            && int_literal_value(order, text).is_none()
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "page order must be a constant integer".to_string(),
                tight_span(text, order),
            ));
        }
        if let Some(group) = attribute_value(node, "group", text) {
            self.check_page_static_text(&cx, group, "page group");
        }
        if let Some(nav) = attribute_value(node, "nav", text)
            && nameref_word(nav, text) != Some("none")
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "page nav supports only none".to_string(),
                tight_span(text, nav),
            ));
        }
        let poll = attribute_value(node, "poll", text);
        if let Some(poll) = poll {
            let _ = self.expr(&cx, poll, None);
            match duration_value(poll, text) {
                None => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "page poll must be a constant duration".to_string(),
                        tight_span(text, poll),
                    ));
                }
                Some(ms) if !(1000..=3_600_000).contains(&ms) || ms % 1000 != 0 => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "page poll must be whole seconds between 1s and 1h".to_string(),
                        tight_span(text, poll),
                    ));
                }
                Some(_) => {}
            }
        }
        if let Some(refresh) = attribute_value(node, "refresh", text) {
            if poll.is_none() {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "page refresh requires poll=".to_string(),
                    tight_span(text, refresh),
                ));
            }
            if let Some(target) = self.tables.node_symbol.get(&NodeKey::of(refresh)).copied() {
                let is_mutation = matches!(
                    self.tables.symbols[target.0 as usize].kind,
                    SymbolKind::Scenario { trusted: false, .. }
                ) && !self.read_scenarios.contains(&target);
                if !is_mutation {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "page refresh must name a canonical user mutation".to_string(),
                        tight_span(text, refresh),
                    ));
                }
            }
        }
        for child in kids(node) {
            if matches!(child.kind, SyntaxKind::Route | SyntaxKind::Attribute) {
                continue;
            }
            if has_error(child) {
                continue;
            }
            self.walk_ui_page(&cx, child, SyntaxKind::Page);
        }
    }

    /// Static page text: a string literal, a context-free message
    /// value or a path to a zero-parameter message (`E3013`).
    fn check_page_static_text(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, what: &str) {
        if invalid_string_literal(node) || string_literal_value(node).is_some() {
            return;
        }
        if node.kind == SyntaxKind::MessageValue {
            let template = kids(node)
                .iter()
                .find(|n| n.kind == SyntaxKind::Literal)
                .and_then(|lit| string_literal_value(lit))
                .unwrap_or_default();
            self.check_message_value(cx, node, what, None);
            if !message_slots(&template).is_empty() {
                self.diags.push(Diagnostic::error(
                    "E3013",
                    format!("{what} message must be context-free"),
                    tight_span(cx.text, node),
                ));
            }
            return;
        }
        if node.kind == SyntaxKind::Path {
            let ok = self
                .tables
                .node_symbol
                .get(&NodeKey::of(node))
                .copied()
                .is_some_and(|id| {
                    matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::Message { ref params } if params.is_empty()
                    )
                });
            if ok {
                return;
            }
        }
        self.diags.push(Diagnostic::error(
            "E3013",
            format!("{what} must be static text or a context-free message value"),
            tight_span(cx.text, node),
        ));
    }

    /// Stored model behind a widget domain type, when the domain is a
    /// record (or array of records) over a model.
    fn model_of_type(&self, ty: &ResolvedType) -> Option<SymbolId> {
        match ty {
            ResolvedType::Record { symbol, .. } => {
                match &self.tables.symbols[symbol.0 as usize].kind {
                    SymbolKind::Model { .. } => Some(*symbol),
                    _ => None,
                }
            }
            ResolvedType::Array { element, .. } => self.model_of_type(element),
            _ => None,
        }
    }

    /// Stored model of the enclosing `row` binding for `node`
    /// (edit-widget `fields=`), walking the resolve scope parents.
    fn scope_row_model(&self, node: &SyntaxNode) -> Option<SymbolId> {
        let mut scope = self.tables.expr_scope.get(&NodeKey::of(node)).copied()?;
        loop {
            let entry = self.tables.scopes.get(scope.0 as usize)?;
            if let Some(Binding::Context(ContextVar::RowModel(model))) = entry.bindings.get("row") {
                return Some(*model);
            }
            scope = entry.parent?;
        }
    }

    /// Walk one presentation widget: type the domain, validate closed
    /// NAME sets, required selector lists and selector navigation
    /// against the domain model, then recurse into nested widgets.
    /// `parent` is the immediate enclosing widget kind (`tab` must sit
    /// directly inside `tabs`).
    fn walk_ui_page(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, parent: SyntaxKind) {
        let domain = kids(node).iter().find(|n| is_expression(n.kind)).copied();
        let mut row_seed: Option<NarrowEnv> = None;
        match node.kind {
            SyntaxKind::Require => {
                if let Some(pred) = domain {
                    let ty = self.expr(cx, pred, None);
                    self.expect_bool(cx, tight_span(cx.text, pred), &ty, "`require`");
                    for (name, span) in self.effectful_calls(pred, cx.text) {
                        self.diags.push(Diagnostic::error(
                            "E3010",
                            format!("page require must be pure; '{name}' is not allowed here"),
                            span,
                        ));
                    }
                }
                return;
            }
            SyntaxKind::Card => {
                if let Some(domain) = domain {
                    let _ = self.expr(cx, domain, None);
                }
                if let Some(layout) = attribute_value(node, "layout", cx.text) {
                    let word = nameref_word(layout, cx.text).unwrap_or("");
                    if !matches!(word, "stack" | "columns") {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            "card layout must be stack or columns".to_string(),
                            tight_span(cx.text, layout),
                        ));
                    }
                }
            }
            SyntaxKind::Details => {
                if let Some(domain) = domain {
                    let _ = self.expr(cx, domain, None);
                }
                if let Some(open) = attribute_value(node, "open", cx.text) {
                    let _ = self.expr(cx, open, None);
                }
                // `display=` base values are unspecified (only the
                // drawer exception is documented): no check.
            }
            SyntaxKind::Tabs => {
                let has_tabs = kids(node).iter().any(|n| n.kind == SyntaxKind::Tab);
                if !has_tabs {
                    match domain {
                        None => {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                "tabs needs an enum preference selector or tab children"
                                    .to_string(),
                                tight_span(cx.text, node),
                            ));
                        }
                        Some(domain) => {
                            let ty = self.expr(cx, domain, None);
                            if !matches!(
                                ty,
                                ResolvedType::Enum { .. }
                                    | ResolvedType::Error
                                    | ResolvedType::Unknown
                                    | ResolvedType::Opaque(_)
                            ) {
                                self.diags.push(Diagnostic::error(
                                    "E3001",
                                    "tabs leaf needs an enum preference selector".to_string(),
                                    tight_span(cx.text, domain),
                                ));
                            }
                        }
                    }
                } else if let Some(domain) = domain {
                    let _ = self.expr(cx, domain, None);
                }
            }
            SyntaxKind::Tab => {
                if parent != SyntaxKind::Tabs {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "tab must be directly inside tabs".to_string(),
                        tight_span(cx.text, node),
                    ));
                }
                if let Some(caption) = domain {
                    let _ = self.expr(cx, caption, None);
                }
            }
            SyntaxKind::Collection => {
                let head = kids(node).iter().find_map(|n| name_text(n, cx.text));
                let model = domain
                    .map(|d| self.expr(cx, d, None))
                    .as_ref()
                    .and_then(|ty| self.model_of_type(ty));
                // Bare-model domains (`list Expense`) never pass through
                // query typing, so `row` would stay `Error`-typed in
                // children (killing enum-case claims and member checks).
                // Seed the row element from the domain model; query
                // domains already registered their precise element
                // above, so never overwrite.
                if let (Some(d), Some(model)) = (domain, model) {
                    self.rows
                        .entry(NodeKey::of(d))
                        .or_insert(ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        });
                }
                // T07: rows reaching the body satisfy every `where`,
                // so the domain's own alias facts narrow the
                // selected row there (CanCRM:414
                // `deal.next_action!=null` proves `row.next_action`
                // non-null at :416/:420). The alias facts seed the
                // body as-is (it may name the alias) plus a copy
                // remapped to the `row` declaration — but the row
                // copy only when no `select` reshaped the element
                // (narrowed paths must still resolve on the row
                // type). Nested collections shadow `row` with their
                // own declaration, so seeds never collide.
                if let Some(d) = domain {
                    let query = unwrap_groups(d);
                    if query.kind == SyntaxKind::Query {
                        let facts = self.selected_row_facts(cx, query);
                        if !facts.is_empty() {
                            let mut env = cx.narrow.clone();
                            env.extend(facts.iter().map(|(k, v)| (k.clone(), v.clone())));
                            if !Self::query_has_select(query, cx.text) {
                                let row_decl = DeclKey::CtxRowQuery(NodeKey::of(d));
                                for (key, ty) in &facts {
                                    env.insert(
                                        NarrowKey {
                                            decl: row_decl.clone(),
                                            path: key.path.clone(),
                                        },
                                        ty.clone(),
                                    );
                                }
                            }
                            row_seed = Some(env);
                        }
                    }
                }
                if head == Some("table") && attribute_value(node, "columns", cx.text).is_none() {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "table needs columns=".to_string(),
                        tight_span(cx.text, node),
                    ));
                }
                if head == Some("board") {
                    match attribute_value(node, "by", cx.text) {
                        None => {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                "board needs by=".to_string(),
                                tight_span(cx.text, node),
                            ));
                        }
                        Some(by) => {
                            self.check_board_by(cx, node, model, by);
                        }
                    }
                }
                if head == Some("calendar") {
                    for key in ["start", "end"] {
                        match attribute_value(node, key, cx.text) {
                            None => {
                                self.diags.push(Diagnostic::error(
                                    "E3001",
                                    format!("calendar needs {key}="),
                                    tight_span(cx.text, node),
                                ));
                            }
                            Some(endpoint) => {
                                self.check_calendar_endpoint(cx, node, model, endpoint, key);
                            }
                        }
                    }
                }
                if let Some(model) = model {
                    for key in ["columns", "search", "filter"] {
                        if let Some(sel) = attribute_value(node, key, cx.text) {
                            self.check_selectors(cx, node, model, sel, key, true);
                        }
                    }
                }
                if let Some(empty) = attribute_value(node, "empty", cx.text) {
                    let _ = self.expr(cx, empty, None);
                }
                if let Some(defaults) = attribute_value(node, "defaults", cx.text) {
                    let _ = self.expr(cx, defaults, None);
                }
                // `order=` (ui_order) and `display=` values need
                // runtime catalogs: no check (reported gap).
            }
            SyntaxKind::Form => {
                if let Some(domain) = domain {
                    let ty = self.expr(cx, domain, None);
                    if let Some(model) = self.model_of_type(&ty)
                        && let Some(sel) = attribute_value(node, "fields", cx.text)
                    {
                        self.check_selectors(cx, node, model, sel, "fields=", true);
                    }
                }
                if let Some(args) = attribute_value(node, "arguments", cx.text) {
                    let _ = self.expr(cx, args, None);
                }
                if let Some(submit) = attribute_value(node, "submit", cx.text) {
                    let _ = self.expr(cx, submit, None);
                }
                if let Some(display) = attribute_value(node, "display", cx.text)
                    && nameref_word(display, cx.text) != Some("inline")
                {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "form display supports only inline".to_string(),
                        tight_span(cx.text, display),
                    ));
                }
                let import = attribute_value(node, "import", cx.text);
                if let Some(import) = import
                    && nameref_word(import, cx.text) != Some("csv")
                {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "form import supports only csv".to_string(),
                        tight_span(cx.text, import),
                    ));
                }
                if attribute_value(node, "review", cx.text).is_some()
                    && import.is_some_and(|i| nameref_word(i, cx.text) != Some("csv"))
                {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "form review requires import=csv".to_string(),
                        tight_span(cx.text, node),
                    ));
                }
            }
            SyntaxKind::Edit => {
                if let Some(sel) = attribute_value(node, "fields", cx.text)
                    && let Some(model) = self.scope_row_model(sel)
                {
                    self.check_selectors(cx, node, model, sel, "fields=", true);
                }
            }
            SyntaxKind::UiLeaf => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        let _ = self.expr(cx, child, None);
                    }
                }
            }
            // Catalog positional domains are expressions, like leaf
            // domains; `NAME=word` options stay untyped (PR5 words).
            SyntaxKind::CatalogItem => {
                for child in kids(node) {
                    if is_expression(child.kind) {
                        let _ = self.expr(cx, child, None);
                    }
                }
                // `timeline` binds `row` to its domain element for the
                // `slot item` subtree (GRAMMAR: collections bind row):
                // seed a narrowing so `row` is the timeline model
                // rather than an enclosing collection's row.
                // Bare-model domains are catalog vocabulary the
                // resolver never walks (as with collections above),
                // so resolve those from the namespace.
                let head = kids(node).iter().find_map(|n| name_text(n, cx.text));
                if head == Some("timeline")
                    && let Some(d) = domain
                {
                    let mut model = self
                        .types
                        .node_types
                        .get(&NodeKey::of(d))
                        .as_ref()
                        .and_then(|ty| self.model_of_type(ty));
                    if model.is_none() && d.kind == SyntaxKind::NameRef {
                        model = nameref_word(d, cx.text)
                            .and_then(|w| self.prod_or_imported(cx.module, w))
                            .filter(|id| {
                                matches!(
                                    self.tables.symbols[id.0 as usize].kind,
                                    SymbolKind::Model { .. }
                                )
                            });
                    }
                    if let Some(model) = model {
                        // Seed the enclosing collection's `row`
                        // declaration (resolved from a direct `row`
                        // reference outside nested collections), so
                        // shadowing rows never collide.
                        let decl = first_row_binding(node, cx.text, self.tables)
                            .map(|binding| decl_key_of_binding(&binding, "row"));
                        if let Some(decl) = decl {
                            let mut env = cx.narrow.clone();
                            env.insert(
                                NarrowKey {
                                    decl,
                                    path: Vec::new(),
                                },
                                ResolvedType::Record {
                                    symbol: model,
                                    stored: true,
                                },
                            );
                            row_seed = Some(env);
                        }
                    }
                }
            }
            _ => {}
        }
        // A `timeline` row seed (above) applies to nested widgets only;
        // sibling subtrees keep the incoming context.
        let timeline_cx;
        let inner: &Ctx<'_, '_> = if let Some(ref env) = row_seed {
            timeline_cx = Ctx {
                module: cx.module,
                file: cx.file,
                text: cx.text,
                narrow: env,
                strict: cx.strict,
                server_default: cx.server_default,
            };
            &timeline_cx
        } else {
            cx
        };
        for child in kids(node) {
            if matches!(child.kind, SyntaxKind::Route | SyntaxKind::Attribute) {
                continue;
            }
            if has_error(child) || is_expression(child.kind) {
                continue;
            }
            if child.kind == SyntaxKind::Name || child.kind == SyntaxKind::Punct {
                continue;
            }
            self.walk_ui_page(inner, child, node.kind);
        }
    }

    /// Board `by=` must resolve to one enum field of the domain model.
    fn check_board_by(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: Option<SymbolId>,
        by: &SyntaxNode,
    ) {
        let paths: Vec<&SyntaxNode> = kids(by)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::Path)
            .collect();
        let single = paths.len() == 1
            && paths[0].kind == SyntaxKind::Path
            && path_segments(paths[0], cx.text).len() == 1;
        if !single || kids(by).iter().any(|n| n.kind == SyntaxKind::Descending) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "board by must resolve to one enum field".to_string(),
                tight_span(cx.text, by),
            ));
            return;
        }
        let name = path_segments(paths[0], cx.text)[0];
        let is_enum = model
            .and_then(|m| self.model_field_named(m, name))
            .is_some_and(|f| matches!(self.decl_type(f), ResolvedType::Enum { .. }));
        if !is_enum {
            self.diags.push(Diagnostic::error(
                "E3001",
                "board by must resolve to one enum field".to_string(),
                tight_span(cx.text, by),
            ));
            return;
        }
        if let Some(model) = model {
            self.check_selectors(cx, node, model, by, "by=", true);
        }
    }

    /// Calendar `start=`/`end=` must each resolve to one field.
    fn check_calendar_endpoint(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: Option<SymbolId>,
        endpoint: &SyntaxNode,
        key: &str,
    ) {
        let paths: Vec<&SyntaxNode> = kids(endpoint)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::Path)
            .collect();
        let single = paths.len() == 1
            && path_segments(paths[0], cx.text).len() == 1
            && !kids(endpoint)
                .iter()
                .any(|n| n.kind == SyntaxKind::Descending);
        if !single {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("calendar {key} must resolve to one field"),
                tight_span(cx.text, endpoint),
            ));
            return;
        }
        if let Some(model) = model {
            self.check_selectors(cx, node, model, endpoint, key, true);
        }
    }

    // --- Phase 2: fixtures, capabilities, CRUD ---------------------------

    /// Check a fixture recipe by target (DESIGN §5.1): model recipes
    /// take ordinary inputs (server fields explicitly initializable,
    /// reserved metadata rejected), user recipes take only a static
    /// `roles` list, file recipes take only `type`/`owner`, and
    /// operation recipes take a complete `request` plus consistent
    /// `status`/`result`/`error` (`E3015`).
    fn phase2_fixture(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let Some(id) = self.test_symbol(module, text, node, &["export", "fixture"]) else {
            return;
        };
        let target = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Fixture { target } => *target,
            _ => FixtureTarget::Unknown,
        };
        let parts = kids(node);
        let head = parts.iter().find(|n| n.kind == SyntaxKind::Path).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let Some(object) = object else {
            return;
        };
        match target {
            FixtureTarget::Unknown => {
                // A deployment-bound (external) head resolves to no
                // symbol and draws no `E2001`: the recipe is silently
                // opaque without this diagnostic. Genuinely unbound
                // heads stay silent here (their `E2001` covers them).
                if let Some(h) = head {
                    // T14: a recipe over a T13-known `std`
                    // operation validates against the consumed owner
                    // schema; an unknown op of a known capability is
                    // a wrong association (`E3015`).
                    match self.resolve_std_recipe_head(module, h, text) {
                        StdTarget::Known { op, display, .. } => {
                            self.check_std_recipe(&cx, object, op, &display);
                            return;
                        }
                        StdTarget::WrongOp { capability, op } => {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                format!(
                                    "'{capability}' has no sendable operation '{op}'; the delivery recipe names an operation outside the owner schema"
                                ),
                                tight_span(text, h),
                            ));
                            self.walk_object_values(&cx, object);
                            return;
                        }
                        StdTarget::NoSchema => {}
                    }
                    let segments = path_segments(h, text);
                    if let Some(first) = segments.first()
                        && let Some(ScopedName::External { .. }) = self.tables.module_scopes
                            [module.0 as usize]
                            .prod
                            .get(*first)
                    {
                        self.emit_opaque_recipe(text, h);
                    }
                }
                self.walk_object_values(&cx, object);
            }
            FixtureTarget::Model(model) => {
                self.check_fixture_model(&cx, node, model, object);
            }
            FixtureTarget::User => {
                self.check_fixture_user(&cx, node, object);
            }
            FixtureTarget::File => {
                self.check_fixture_file(&cx, node, module, object);
            }
            FixtureTarget::Operation(_) => {
                let op = head.and_then(|h| self.tables.node_symbol.get(&NodeKey::of(h)).copied());
                match op {
                    Some(op) => self.check_fixture_operation(&cx, node, op, object),
                    None => {
                        // A deployment-bound (external) operation has no
                        // signature to check the recipe against: the
                        // receipt is silently opaque without this
                        // diagnostic.
                        if let Some(h) = head {
                            self.emit_opaque_recipe(text, h);
                        }
                        self.walk_object_values(&cx, object);
                    }
                }
            }
        }
    }

    /// Report an unverifiable delivery recipe (`E3019`): the head
    /// names a deployment-bound capability whose signature is opaque.
    fn emit_opaque_recipe(&mut self, text: &str, head: &SyntaxNode) {
        self.diags.push(Diagnostic::error(
            "E3019",
            format!(
                "cannot verify delivery recipe for '{}': deployment-bound capability signatures are opaque; request/status/result/error are unchecked",
                path_segments(head, text).join(".")
            ),
            tight_span(text, head),
        ));
    }

    /// Check a model fixture recipe: ordinary inputs with required
    /// coverage, explicit server initialization allowed, reserved
    /// metadata rejected (`E3015`).
    fn check_fixture_model(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        model: SymbolId,
        object: &SyntaxNode,
    ) {
        let parent_model = match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                owner: ModelOwner::ChildOf(parent),
                ..
            } => Some(*parent),
            _ => None,
        };
        let mut seen: Vec<String> = Vec::new();
        for (key, key_node, value) in object_entries(object, cx.text) {
            if is_reserved_name(key) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("'{key}' is reserved metadata and cannot appear in recipes"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            }
            if key == "parent" {
                match parent_model {
                    Some(parent) => {
                        let expected = ResolvedType::Record {
                            symbol: parent,
                            stored: true,
                        };
                        let (actual, value_span) =
                            self.entry_value(cx, key_node, value, Some(expected.clone()));
                        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                format!(
                                    "'parent': expected {}, found {}",
                                    self.show(cx.module, &expected),
                                    self.show(cx.module, &actual)
                                ),
                                value_span,
                            ));
                        }
                    }
                    None => {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "'{}' is not contained; only child models take parent=",
                                record_name(self.tables, cx.module, model)
                            ),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                    }
                }
                seen.push(key.to_string());
                continue;
            }
            let Some(field) = self.model_field_named(model, key) else {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!(
                        "unknown field '{key}' on model {}",
                        record_name(self.tables, cx.module, model)
                    ),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            seen.push(key.to_string());
            let expected = self.decl_type(field);
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
        if parent_model.is_some() && !seen.iter().any(|k| k == "parent") {
            self.diags.push(Diagnostic::error(
                "E3015",
                "missing required field 'parent'".to_string(),
                tight_span(cx.text, object),
            ));
        }
        for field in self.model_fields(model) {
            let name = self.tables.symbols[field.0 as usize].name.clone();
            if seen.contains(&name) {
                continue;
            }
            if self.field_is_required_input(field) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("missing required field '{name}'"),
                    tight_span(cx.text, object),
                ));
            }
        }
    }

    /// Check a user fixture recipe: only `roles`, a static
    /// duplicate-free list of `owner` and visible declared roles.
    fn check_fixture_user(&mut self, cx: &Ctx<'_, '_>, _node: &SyntaxNode, object: &SyntaxNode) {
        for (key, key_node, value) in object_entries(object, cx.text) {
            if key != "roles" {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("unknown user recipe attribute '{key}'; only roles= is accepted"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            }
            let Some(list) = value else {
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            if list.kind != SyntaxKind::Array {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    "roles= must be a static list".to_string(),
                    tight_span(cx.text, list),
                ));
                self.expr(cx, list, None);
                continue;
            }
            let mut seen: Vec<String> = Vec::new();
            for element in kids(list) {
                if !is_expression(element.kind) {
                    continue;
                }
                let name = if element.kind == SyntaxKind::NameRef {
                    {
                        kids(element)
                            .iter()
                            .find_map(|n| name_text(n, cx.text))
                            .unwrap_or("")
                    }
                } else {
                    ""
                };
                if name.is_empty() {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        "roles= takes static role names, not dynamic values".to_string(),
                        tight_span(cx.text, element),
                    ));
                    self.expr(cx, element, None);
                    continue;
                }
                if matches!(name, "members" | "public" | "outsider") {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!("'{name}' cannot appear in roles="),
                        tight_span(cx.text, element),
                    ));
                    continue;
                }
                if seen.iter().any(|s| s == name) {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!("duplicate role '{name}'"),
                        tight_span(cx.text, element),
                    ));
                    continue;
                }
                seen.push(name.to_string());
                if name == "owner" {
                    continue;
                }
                match self.prod_or_imported(cx.module, name) {
                    Some(id)
                        if matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role) => {}
                    _ => {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!("unknown role '{name}'"),
                            tight_span(cx.text, element),
                        ));
                    }
                }
            }
        }
    }

    /// Check a file fixture recipe: only `type=` (a pinned sample
    /// MIME) and `owner=` (a test account or user fixture).
    fn check_fixture_file(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        module: ModuleId,
        object: &SyntaxNode,
    ) {
        for (key, key_node, value) in object_entries(object, cx.text) {
            match key {
                "type" => {
                    let Some(literal) = value else {
                        self.entry_value(cx, key_node, value, None);
                        continue;
                    };
                    if invalid_string_literal(literal) {
                        continue;
                    }
                    match string_literal_value(literal) {
                        Some(mime)
                            if matches!(
                                mime.as_str(),
                                "application/pdf"
                                    | "image/png"
                                    | "image/jpeg"
                                    | "text/plain"
                                    | "application/json"
                            ) => {}
                        Some(mime) => {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                format!("unsupported file sample type '{mime}'"),
                                tight_span(cx.text, literal),
                            ));
                        }
                        None => {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                "type= must be a static MIME type".to_string(),
                                tight_span(cx.text, literal),
                            ));
                            self.expr(cx, literal, None);
                        }
                    }
                }
                "owner" => {
                    let Some(name_ref) = value else {
                        self.entry_value(cx, key_node, value, None);
                        continue;
                    };
                    let name = if name_ref.kind == SyntaxKind::NameRef {
                        {
                            kids(name_ref)
                                .iter()
                                .find_map(|n| name_text(n, cx.text))
                                .unwrap_or("")
                        }
                    } else {
                        ""
                    };
                    if name.is_empty() {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            "owner= must be a test account or user fixture".to_string(),
                            tight_span(cx.text, name_ref),
                        ));
                        self.expr(cx, name_ref, None);
                        continue;
                    }
                    if matches!(name, "self" | "other" | "outsider") {
                        continue;
                    }
                    let is_user_fixture =
                        match self.tables.module_scopes[module.0 as usize].test.get(name) {
                            Some(
                                ScopedName::Local(id) | ScopedName::Imported { target: id, .. },
                            ) => matches!(
                                self.tables.symbols[id.0 as usize].kind,
                                SymbolKind::Fixture {
                                    target: FixtureTarget::User
                                }
                            ),
                            _ => false,
                        };
                    if !is_user_fixture {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "owner= must be a test account or user fixture, found '{name}'"
                            ),
                            tight_span(cx.text, name_ref),
                        ));
                    }
                }
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!("unknown file recipe attribute '{key}'; only type= and owner= are accepted"),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                }
            }
        }
    }

    /// Check an operation (delivery recipe) fixture: a complete
    /// `request=` plus a consistent `status=`/`result=`/`error=`
    /// envelope (`E3015`).
    fn check_fixture_operation(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: SymbolId,
        object: &SyntaxNode,
    ) {
        let mut request = None;
        let mut status = None;
        let mut result = None;
        let mut error = None;
        for (key, key_node, value) in object_entries(object, cx.text) {
            match key {
                "request" => request = Some((key_node, value)),
                "status" => status = Some((key_node, value)),
                "result" => result = Some((key_node, value)),
                "error" => error = Some((key_node, value)),
                _ => {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!(
                            "unknown delivery recipe attribute '{key}'; only request=, status=, result= and error= are accepted"
                        ),
                        tight_span(cx.text, key_node),
                    ));
                    self.entry_value(cx, key_node, value, None);
                }
            }
        }
        match request {
            Some((_, Some(request))) if request.kind == SyntaxKind::Object => {
                self.check_fixture_request(cx, node, op, request);
            }
            Some((key_node, _)) => {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    "delivery recipes need a complete request={...}".to_string(),
                    tight_span(cx.text, key_node),
                ));
            }
            None => {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    "delivery recipes need a complete request={...}".to_string(),
                    tight_span(cx.text, object),
                ));
            }
        }
        self.check_fixture_envelope(cx, object, status, result, error);
    }

    /// Check a delivery recipe `request=`: complete normalized inputs
    /// for the operation (ordinary defaults apply).
    fn check_fixture_request(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        op: SymbolId,
        request: &SyntaxNode,
    ) {
        match &self.tables.symbols[op.0 as usize].kind {
            SymbolKind::Scenario { params, .. } | SymbolKind::CapabilityOp { params, .. } => {
                let params = params.clone();
                let mut seen: Vec<String> = Vec::new();
                for (key, key_node, value) in object_entries(request, cx.text) {
                    let param = params
                        .iter()
                        .find(|p| self.tables.symbols[p.0 as usize].name == key);
                    let Some(param) = param.copied() else {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "unknown request input '{key}' for {}",
                                record_name(self.tables, cx.module, op)
                            ),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                        continue;
                    };
                    seen.push(key.to_string());
                    let expected = self.decl_type(param);
                    let (actual, value_span) =
                        self.entry_value(cx, key_node, value, Some(expected.clone()));
                    if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "'{key}': expected {}, found {}",
                                self.show(cx.module, &expected),
                                self.show(cx.module, &actual)
                            ),
                            value_span,
                        ));
                    }
                }
                for param in &params {
                    let name = self.tables.symbols[param.0 as usize].name.clone();
                    if seen.contains(&name) {
                        continue;
                    }
                    let has_default = self.shapes.get(param).is_some_and(|s| s.0);
                    if !has_default && !matches!(self.decl_type(*param), ResolvedType::Nullable(_))
                    {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!("request is missing required input '{name}'"),
                            tight_span(cx.text, request),
                        ));
                    }
                }
            }
            SymbolKind::CrudOp { model, op } => {
                self.check_fixture_crud_request(cx, *model, *op, request);
            }
            _ => {
                self.walk_object_values(cx, request);
            }
        }
    }

    /// Check a delivery recipe `request=` for a generated CRUD
    /// operation: create takes field inputs, update takes
    /// `record=`/`changes=`, delete takes `record=`.
    fn check_fixture_crud_request(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        op_kind: CrudOp,
        request: &SyntaxNode,
    ) {
        let mut seen: Vec<String> = Vec::new();
        for (key, key_node, value) in object_entries(request, cx.text) {
            seen.push(key.to_string());
            match op_kind {
                CrudOp::Create => {
                    if key == "parent" {
                        let parent = match &self.tables.symbols[model.0 as usize].kind {
                            SymbolKind::Model {
                                owner: ModelOwner::ChildOf(parent),
                                ..
                            } => Some(*parent),
                            _ => None,
                        };
                        match parent {
                            Some(parent) => {
                                let expected = ResolvedType::Record {
                                    symbol: parent,
                                    stored: true,
                                };
                                let (actual, value_span) =
                                    self.entry_value(cx, key_node, value, Some(expected.clone()));
                                if !actual.is_error() && !self.types_compatible(&actual, &expected)
                                {
                                    self.diags.push(Diagnostic::error(
                                        "E3015",
                                        format!(
                                            "'parent': expected {}, found {}",
                                            self.show(cx.module, &expected),
                                            self.show(cx.module, &actual)
                                        ),
                                        value_span,
                                    ));
                                }
                            }
                            None => {
                                self.diags.push(Diagnostic::error(
                                    "E3015",
                                    format!(
                                        "'{}' is not contained; only child models take parent=",
                                        record_name(self.tables, cx.module, model)
                                    ),
                                    tight_span(cx.text, key_node),
                                ));
                                self.entry_value(cx, key_node, value, None);
                            }
                        }
                        continue;
                    }
                    let Some(field) = self.model_field_named(model, key) else {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!("unknown request input '{key}'"),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                        continue;
                    };
                    let expected = self.decl_type(field);
                    let (actual, value_span) =
                        self.entry_value(cx, key_node, value, Some(expected.clone()));
                    if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "'{key}': expected {}, found {}",
                                self.show(cx.module, &expected),
                                self.show(cx.module, &actual)
                            ),
                            value_span,
                        ));
                    }
                }
                CrudOp::Update => {
                    if key == "record" {
                        let expected = ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        };
                        let (actual, value_span) =
                            self.entry_value(cx, key_node, value, Some(expected.clone()));
                        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                format!(
                                    "'record': expected {}, found {}",
                                    self.show(cx.module, &expected),
                                    self.show(cx.module, &actual)
                                ),
                                value_span,
                            ));
                        }
                    } else if key == "changes" {
                        match value {
                            Some(changes) if changes.kind == SyntaxKind::Object => {
                                self.check_fixture_changes(cx, model, changes);
                            }
                            _ => {
                                self.diags.push(Diagnostic::error(
                                    "E3015",
                                    "changes= must be an object of field updates".to_string(),
                                    tight_span(cx.text, key_node),
                                ));
                                self.entry_value(cx, key_node, value, None);
                            }
                        }
                    } else {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!(
                                "unknown request input '{key}'; update takes record= and changes="
                            ),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                    }
                }
                CrudOp::Delete => {
                    if key == "record" {
                        let expected = ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        };
                        let (actual, value_span) =
                            self.entry_value(cx, key_node, value, Some(expected.clone()));
                        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                            self.diags.push(Diagnostic::error(
                                "E3015",
                                format!(
                                    "'record': expected {}, found {}",
                                    self.show(cx.module, &expected),
                                    self.show(cx.module, &actual)
                                ),
                                value_span,
                            ));
                        }
                    } else {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!("unknown request input '{key}'; delete takes record="),
                            tight_span(cx.text, key_node),
                        ));
                        self.entry_value(cx, key_node, value, None);
                    }
                }
            }
        }
        // Completeness: required create fields, update's record and
        // changes, delete's record.
        match op_kind {
            CrudOp::Create => {
                for field in self.model_fields(model) {
                    let name = self.tables.symbols[field.0 as usize].name.clone();
                    if seen.contains(&name) || !self.field_is_required_input(field) {
                        continue;
                    }
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!("request is missing required input '{name}'"),
                        tight_span(cx.text, request),
                    ));
                }
                if matches!(
                    self.tables.symbols[model.0 as usize].kind,
                    SymbolKind::Model {
                        owner: ModelOwner::ChildOf(_),
                        ..
                    }
                ) && !seen.iter().any(|k| k == "parent")
                {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        "request is missing required input 'parent'".to_string(),
                        tight_span(cx.text, request),
                    ));
                }
            }
            CrudOp::Update => {
                for required in ["record", "changes"] {
                    if !seen.iter().any(|k| k == required) {
                        self.diags.push(Diagnostic::error(
                            "E3015",
                            format!("request is missing required input '{required}'"),
                            tight_span(cx.text, request),
                        ));
                    }
                }
            }
            CrudOp::Delete => {
                if !seen.iter().any(|k| k == "record") {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        "request is missing required input 'record'".to_string(),
                        tight_span(cx.text, request),
                    ));
                }
            }
        }
    }

    /// Check delivery recipe `changes=`: known updatable fields with
    /// compatible values.
    fn check_fixture_changes(&mut self, cx: &Ctx<'_, '_>, model: SymbolId, changes: &SyntaxNode) {
        for (key, key_node, value) in object_entries(changes, cx.text) {
            if is_reserved_name(key) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("'{key}' is reserved and cannot be changed"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            }
            let Some(field) = self.model_field_named(model, key) else {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!("unknown field '{key}'"),
                    tight_span(cx.text, key_node),
                ));
                self.entry_value(cx, key_node, value, None);
                continue;
            };
            let expected = self.decl_type(field);
            let (actual, value_span) =
                self.entry_value(cx, key_node, value, Some(expected.clone()));
            if !actual.is_error() && !self.types_compatible(&actual, &expected) {
                self.diags.push(Diagnostic::error(
                    "E3015",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    value_span,
                ));
            }
        }
    }

    /// Check a delivery recipe completion envelope: `status=` names a
    /// known outcome and `result=`/`error=` match it (DESIGN §8).
    fn check_fixture_envelope(
        &mut self,
        cx: &Ctx<'_, '_>,
        object: &SyntaxNode,
        status: Option<(&SyntaxNode, Option<&SyntaxNode>)>,
        result: Option<(&SyntaxNode, Option<&SyntaxNode>)>,
        error: Option<(&SyntaxNode, Option<&SyntaxNode>)>,
    ) {
        if status.is_some_and(|(_, value)| value.is_some_and(invalid_string_literal)) {
            // The lexer owns the invalid status diagnostic, but payloads
            // still need their independent name/type checks.
            for (key_node, value) in [result, error].into_iter().flatten() {
                self.entry_value(cx, key_node, value, None);
            }
            return;
        }
        // The status names a known outcome (absent means pending).
        let outcome = match status {
            None => "pending".to_string(),
            Some((key_node, value)) => {
                let name = value
                    .and_then(|v| match v.kind {
                        SyntaxKind::NameRef => kids(v)
                            .iter()
                            .find_map(|n| name_text(n, cx.text))
                            .map(str::to_string),
                        SyntaxKind::Literal => string_literal_value(v),
                        _ => None,
                    })
                    .unwrap_or_default();
                if !matches!(
                    name.as_str(),
                    "pending" | "succeeded" | "failed" | "unknown" | "skipped"
                ) {
                    self.diags.push(Diagnostic::error(
                        "E3015",
                        format!("unknown delivery status '{name}'"),
                        value
                            .map(|v| tight_span(cx.text, v))
                            .unwrap_or_else(|| tight_span(cx.text, key_node)),
                    ));
                    if let Some(v) = value {
                        self.expr(cx, v, None);
                    }
                    return;
                }
                // A bare status name has no binding; claim it so no
                // `E2001` follows the validated recipe.
                if let Some(v) = value
                    && v.kind == SyntaxKind::NameRef
                {
                    self.types.resolved_cases.insert(NodeKey::of(v));
                }
                name
            }
        };
        let has_value = |slot: &Option<(&SyntaxNode, Option<&SyntaxNode>)>| match slot {
            Some((_, Some(v))) => !is_null_literal(v, cx.text),
            _ => false,
        };
        let has_result = has_value(&result);
        let has_error = has_value(&error);
        let mut envelope_error = |what: &str| {
            self.diags.push(Diagnostic::error(
                "E3015",
                format!("inconsistent delivery envelope: {what}"),
                tight_span(cx.text, object),
            ));
        };
        match outcome.as_str() {
            "succeeded" => {
                if !has_result {
                    envelope_error("succeeded needs result=");
                }
                if has_error {
                    envelope_error("succeeded needs error=null");
                }
            }
            "failed" => {
                if !has_error {
                    envelope_error("failed needs error=");
                }
                if has_result {
                    envelope_error("failed needs result=null");
                }
            }
            "unknown" => {
                if has_result {
                    envelope_error("unknown needs result=null");
                }
            }
            _ => {
                if has_result || has_error {
                    envelope_error(&format!("{outcome} needs result=null and error=null"));
                }
            }
        }
        // Type the payload values for their side effects.
        for (key_node, value) in [result, error].into_iter().flatten() {
            self.entry_value(cx, key_node, value, None);
        }
    }

    // --- Phase 2: scenarios and operations (P3) ---
}

/// Metadata paths have no expression evaluation or ambient lexical scope.
fn choice_input_path(node: &SyntaxNode, text: &str) -> Option<(String, Vec<String>)> {
    match node.kind {
        SyntaxKind::NameRef => Some((nameref_word(node, text)?.to_string(), Vec::new())),
        SyntaxKind::Member => {
            let parts = kids(node);
            if parts.len() != 3 || !is_punct(parts[1], text, ".") {
                return None;
            }
            let (input, mut path) = choice_input_path(parts[0], text)?;
            path.push(name_text(parts[2], text)?.to_string());
            Some((input, path))
        }
        _ => None,
    }
}

/// Lexer-owned decoded value of a string `Literal` node.
/// Invalid strings have no payload; an empty valid string has `Some("")`.
fn string_literal_value(node: &SyntaxNode) -> Option<String> {
    if node.kind != SyntaxKind::Literal {
        return None;
    }
    kids(node).into_iter().find_map(string_leaf_value)
}

/// Lexer-owned value of a bare `String` token leaf (quoted message
/// locale keys are leaves, not `Literal` nodes).
fn string_leaf_value(node: &SyntaxNode) -> Option<String> {
    if node.kind != SyntaxKind::String {
        return None;
    }
    node.token()?.string_value.clone()
}

/// Recovery stays local to the invalid token: the lexer already emitted
/// its source diagnostic. Do not suppress valid sibling declarations.
fn invalid_string_literal(node: &SyntaxNode) -> bool {
    node.kind == SyntaxKind::Literal
        && kids(node).into_iter().any(|leaf| {
            leaf.kind == SyntaxKind::String
                && leaf
                    .token()
                    .is_some_and(|token| token.string_value.is_none())
        })
}

/// Whether a `Literal` node is the `null` literal.
fn is_null_literal(node: &SyntaxNode, text: &str) -> bool {
    literal_leaf(node, text)
        .is_some_and(|(kind, slice)| slice == "null" && kind != SyntaxKind::String)
}

/// Whether an expression mentions the bare name `name` (a NameRef
/// head or a member root).
fn expr_uses_name(node: &SyntaxNode, text: &str, name: &str) -> bool {
    match node.kind {
        SyntaxKind::NameRef => kids(node)
            .iter()
            .find_map(|n| name_text(n, text))
            .is_some_and(|word| word == name),
        _ => node.children.iter().any(|c| expr_uses_name(c, text, name)),
    }
}

/// Placeholder names in one message template: `{name}` plus the
/// leading variable of typed ICU forms (`{n, number, ...}`, `{k,
/// select, ...}`), recursing into plural/select branch bodies for
/// nested placeholders. Branch selectors and literal body words are
/// not slots: under the accepted profile (DESIGN §9.1; the runtime
/// parser in `packages/values/src/icu.ts`) a branch body is message
/// text and only `{...}` arguments bind. Quoted spans (`'{'`, `''`)
/// contribute nothing. Anything outside a well-formed complex-argument
/// shape falls back to the flat scan from the deviation point, so
/// malformed patterns keep their current diagnostics and genuinely
/// unknown names still fail (`E3016`); full ICU option validation
/// itself stays out of scope (DESIGN §9.1).
fn message_slots(template: &str) -> Vec<String> {
    let chars: Vec<char> = template.chars().collect();
    let mut slots = Vec::new();
    let mut i = 0;
    scan_message(&chars, &mut i, &mut slots, false, 0);
    slots
}

/// Scan message text, collecting slots, until the end of the template
/// (top level) or the closing brace of the enclosing branch body
/// (`nested`, consumed). A stray top-level close is malformed-pattern
/// noise the profile stage rejects; it is skipped here.
fn scan_message(chars: &[char], i: &mut usize, slots: &mut Vec<String>, nested: bool, depth: u32) {
    while *i < chars.len() {
        match chars[*i] {
            '\'' => skip_quoted(chars, i),
            '{' => scan_argument(chars, i, slots, depth),
            '}' => {
                *i += 1;
                if nested {
                    return;
                }
            }
            _ => *i += 1,
        }
    }
}

/// Scan one `{...}` argument at `chars[*i] == '{'`, pushing its slot
/// name and dispatching typed forms on the profile keyword.
fn scan_argument(chars: &[char], i: &mut usize, slots: &mut Vec<String>, depth: u32) {
    if depth > 32 {
        // Beyond the profile's nesting bound: the later stage rejects
        // the pattern; keep the scan total without recursing.
        *i += 1;
        return;
    }
    let mut j = *i + 1;
    let mut name = String::new();
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        name.push(chars[j]);
        j += 1;
    }
    // A slot name is followed by `}`, `,` or whitespace; anything
    // else (a nested or malformed brace) is skipped here.
    if name.is_empty() {
        *i += 1;
        return;
    }
    let end = chars.get(j).copied().unwrap_or('}');
    if end == '}' {
        push_slot(slots, name);
        *i = j + 1;
        return;
    }
    if end != ',' && !end.is_whitespace() {
        *i = j;
        return;
    }
    push_slot(slots, name);
    if end.is_whitespace() {
        // Legacy `{name ...}` shape: the name binds and the rest of
        // the span scans flat.
        *i = j;
        return;
    }
    let mut k = j + 1;
    skip_spaces(chars, &mut k);
    let keyword_start = k;
    while k < chars.len() && chars[k].is_ascii_alphabetic() {
        k += 1;
    }
    let keyword: String = chars[keyword_start..k].iter().collect();
    if matches!(keyword.as_str(), "plural" | "selectordinal" | "select") {
        let mut head = k;
        skip_spaces(chars, &mut head);
        if chars.get(head).copied() == Some(',') {
            *i = head + 1;
            scan_branches(chars, i, slots, depth + 1);
            return;
        }
        // Malformed complex head: resume the flat scan.
        *i = k;
        return;
    }
    // Simple (`number`/`date`/`time`) or out-of-profile type: the name
    // already binds; the interior scans flat so any nested unknown
    // name keeps failing exactly as before.
    *i = k;
}

/// Scan the branch list of a well-formed `{name,
/// plural|selectordinal|select, ...}` head: selectors contribute
/// nothing and bodies recurse for nested placeholders. Any structural
/// deviation abandons the branch walk and resumes the flat scan at
/// the deviation point (no brace is consumed on those paths, so the
/// fallback sees the same braces the flat scan would).
fn scan_branches(chars: &[char], i: &mut usize, slots: &mut Vec<String>, depth: u32) {
    loop {
        skip_spaces(chars, i);
        match chars.get(*i).copied() {
            None => return,
            Some('}') => {
                *i += 1;
                return;
            }
            Some('=') => {
                // Exact `=N` plural selector.
                *i += 1;
                let start = *i;
                while *i < chars.len() && (chars[*i].is_ascii_digit() || chars[*i] == '.') {
                    *i += 1;
                }
                if *i == start {
                    return;
                }
            }
            Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => {
                while *i < chars.len()
                    && (chars[*i].is_ascii_alphanumeric() || chars[*i] == '_' || chars[*i] == '-')
                {
                    *i += 1;
                }
            }
            // Quote, brace or anything else where a selector belongs:
            // malformed; resume the flat scan here.
            _ => return,
        }
        skip_spaces(chars, i);
        if chars.get(*i).copied() != Some('{') {
            return;
        }
        *i += 1;
        scan_message(chars, i, slots, true, depth);
    }
}

/// Skip an ICU apostrophe span at `chars[*i] == '\''`: `''` is one
/// literal apostrophe, otherwise everything to the next `'` is quoted.
fn skip_quoted(chars: &[char], i: &mut usize) {
    if chars.get(*i + 1).copied() == Some('\'') {
        *i += 2;
        return;
    }
    *i += 1;
    while *i < chars.len() && chars[*i] != '\'' {
        *i += 1;
    }
    *i += 1;
}

fn skip_spaces(chars: &[char], i: &mut usize) {
    while *i < chars.len() && chars[*i].is_whitespace() {
        *i += 1;
    }
}

fn push_slot(slots: &mut Vec<String>, name: String) {
    if !slots.contains(&name) {
        slots.push(name);
    }
}

/// Whether `node` is an inline message descriptor (`"… "@{…}`),
/// through groups. Per DESIGN §9.1 a suffixed string is a message
/// descriptor, not ordinary text — even though `expr` types it
/// `text` (inline descriptors declare no `Message` symbol).
fn is_message_descriptor(node: &SyntaxNode) -> bool {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::MessageValue => return true,
            SyntaxKind::Group => {
                let parts = kids(current);
                let Some(inner) = parts.iter().find(|n| is_expression(n.kind)) else {
                    return false;
                };
                current = inner;
            }
            _ => return false,
        }
    }
}

/// Entries of an `Object` node: (key text, key node, value node).
/// The value is `None` for shorthand entries (`{name}`), whose type
/// comes from the name's binding (see [`Typer::entry_value`]).
fn object_entries<'a>(
    object: &'a SyntaxNode,
    text: &'a str,
) -> Vec<(&'a str, &'a SyntaxNode, Option<&'a SyntaxNode>)> {
    let mut entries = Vec::new();
    for entry in object
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::ObjectEntry)
    {
        let parts = kids(entry);
        let Some(key_node) = parts
            .first()
            .copied()
            .filter(|n| n.kind == SyntaxKind::Name)
        else {
            continue;
        };
        let Some(key) = name_text(key_node, text) else {
            continue;
        };
        let value = parts.iter().find(|n| is_expression(n.kind)).copied();
        entries.push((key, key_node, value));
    }
    entries
}

/// Claim node for one object entry: its value node, or the key
/// node for shorthand entries (as `entry_value` types them).
fn claim_entry_node<'n>(
    entries: &[(&str, &'n SyntaxNode, Option<&'n SyntaxNode>)],
    key: &str,
) -> Option<&'n SyntaxNode> {
    entries
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, key_node, value)| value.unwrap_or(*key_node))
}

/// Whether `name` is reserved record metadata (DESIGN §2) and so
/// never a settable field.
fn is_reserved_name(name: &str) -> bool {
    matches!(
        name,
        "id" | "version" | "created" | "updated" | "created_by" | "updated_by" | "archived_at"
    )
}

/// Read-only type of reserved record metadata (DESIGN §2), shared
/// by expression member lookup and selector navigation so both
/// positions agree (T08 canonical member information).
fn reserved_member_type(name: &str) -> Option<ResolvedType> {
    match name {
        "id" => Some(ResolvedType::Scalar(Scalar::Text)),
        "version" => Some(ResolvedType::Scalar(Scalar::Int)),
        "created" | "updated" => Some(ResolvedType::Scalar(Scalar::Datetime)),
        "created_by" | "updated_by" => Some(ResolvedType::Scalar(Scalar::User)),
        "archived_at" => Some(ResolvedType::Nullable(Box::new(ResolvedType::Scalar(
            Scalar::Datetime,
        )))),
        _ => None,
    }
}

/// Containing parent of a contained model, if any (shared by
/// expression member lookup and selector navigation, T08).
fn contained_parent_of(tables: &ResolveTables, symbol: SymbolId) -> Option<SymbolId> {
    match &tables.symbols[symbol.0 as usize].kind {
        SymbolKind::Model {
            owner: ModelOwner::ChildOf(parent),
            ..
        } => Some(*parent),
        _ => None,
    }
}

/// Whether an effect node carries an `as NAME` binding.
fn has_as_binding(node: &SyntaxNode, text: &str) -> bool {
    let parts = kids(node);
    parts.iter().any(|n| is_name(n, text, "as"))
}

/// Value of a bare `key = expr` keyword among `node`'s direct parts
/// (a `Name`, `Punct`, expression triple, as in `send ... when=...`).
fn bare_keyword_value<'a>(node: &'a SyntaxNode, key: &str, text: &str) -> Option<&'a SyntaxNode> {
    let parts = kids(node);
    for (i, part) in parts.iter().enumerate() {
        if is_name(part, text, key) {
            return parts.get(i + 2).copied().filter(|n| is_expression(n.kind));
        }
    }
    None
}

/// Map a builtin scalar type name to its leaf.
fn scalar_named(name: &str) -> Option<Scalar> {
    match name {
        "bool" => Some(Scalar::Bool),
        "int" => Some(Scalar::Int),
        "decimal" => Some(Scalar::Decimal),
        "text" => Some(Scalar::Text),
        "email" => Some(Scalar::Email),
        "url" => Some(Scalar::Url),
        "locale" => Some(Scalar::Locale),
        "date" => Some(Scalar::Date),
        "datetime" => Some(Scalar::Datetime),
        "duration" => Some(Scalar::Duration),
        "timezone" => Some(Scalar::Timezone),
        "currency" => Some(Scalar::Currency),
        "money" => Some(Scalar::Money),
        "user" => Some(Scalar::User),
        "member" => Some(Scalar::Member),
        "file" => Some(Scalar::File),
        "secret" => Some(Scalar::Secret),
        "json" => Some(Scalar::Json),
        "bytes" => Some(Scalar::Bytes),
        _ => None,
    }
}

/// Identity of one narrowed root: the resolved declaration behind
/// the name, never its spelling (T03 §6: two spellings resolving to
/// the same declaration+path share facts; one spelling resolving to
/// different declarations never shares).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum DeclKey {
    Symbol(SymbolId),
    Let(NodeKey),
    QueryAlias(NodeKey),
    ForItem(NodeKey),
    CohortChild(NodeKey),
    CreateAs(NodeKey),
    CallAs(NodeKey),
    SendAs(NodeKey),
    RouteParam(NodeKey),
    CtxActor,
    CtxTeam,
    CtxNow,
    CtxOperation,
    CtxEvent,
    CtxRowModel(SymbolId),
    CtxRowQuery(NodeKey),
    CtxParent(SymbolId),
    CtxPreferences(ModuleId),
    CtxResult(Option<SymbolId>, Option<(SymbolId, CrudOp)>),
    CtxTestAccount(u8),
    /// Unresolvable or value-less roots (unbound names, builtins,
    /// predicates, poisoned bindings): keyed by spelling only so they
    /// never collide with a resolved declaration. Facts are only
    /// inserted for resolvable roots, so this arm stays lookup-only.
    Unresolved(String),
}

/// Declaration key of one lexical binding.
fn decl_key_of_binding(binding: &Binding, spelling: &str) -> DeclKey {
    match binding {
        Binding::Symbol(id) => DeclKey::Symbol(*id),
        Binding::Let { node } => DeclKey::Let(*node),
        Binding::QueryAlias { node } => DeclKey::QueryAlias(*node),
        Binding::ForItem { node } => DeclKey::ForItem(*node),
        Binding::CohortChild { node, .. } => DeclKey::CohortChild(*node),
        Binding::CreateAs { node } => DeclKey::CreateAs(*node),
        Binding::CallAs { node } => DeclKey::CallAs(*node),
        Binding::SendAs { node } => DeclKey::SendAs(*node),
        Binding::RouteParam { node } => DeclKey::RouteParam(*node),
        Binding::Context(ContextVar::Actor(_)) => DeclKey::CtxActor,
        Binding::Context(ContextVar::Team) => DeclKey::CtxTeam,
        Binding::Context(ContextVar::Now) => DeclKey::CtxNow,
        Binding::Context(ContextVar::Operation) => DeclKey::CtxOperation,
        Binding::Context(ContextVar::Event) => DeclKey::CtxEvent,
        Binding::Context(ContextVar::RowModel(model)) => DeclKey::CtxRowModel(*model),
        Binding::Context(ContextVar::RowQuery { node }) => DeclKey::CtxRowQuery(*node),
        Binding::Context(ContextVar::Parent { model }) => DeclKey::CtxParent(*model),
        Binding::Context(ContextVar::Preferences { module }) => DeclKey::CtxPreferences(*module),
        Binding::Context(ContextVar::Result { scenario, crud_op }) => {
            DeclKey::CtxResult(*scenario, *crud_op)
        }
        Binding::Context(ContextVar::TestAccount(account)) => {
            let slot = match account {
                super::resolve::TestAccount::Slf => 0,
                super::resolve::TestAccount::Other => 1,
                super::resolve::TestAccount::Outsider => 2,
            };
            DeclKey::CtxTestAccount(slot)
        }
        Binding::Builtin { .. }
        | Binding::Predicate
        | Binding::External { .. }
        | Binding::Error => DeclKey::Unresolved(spelling.to_string()),
    }
}

/// One narrowed path: a resolved declaration plus member hops from it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NarrowKey {
    decl: DeclKey,
    path: Vec<String>,
}

/// Narrowing environment: narrowed types by root path.
type NarrowEnv = HashMap<NarrowKey, ResolvedType>;

/// Invalidation causes collected from one statement subtree (T03 §8).
#[derive(Debug, Default)]
struct ScanInvalid {
    /// A `create`/`delete`/`call`/`send`/effect statement may mutate
    /// any record: drop every member-path fact.
    drop_all_paths: bool,
    /// `set` target roots: drop member-path facts under these
    /// declarations (the write may alias any path beneath its root).
    drop_roots: Vec<DeclKey>,
}

/// Expression context: position facts plus the active narrowing set.
struct Ctx<'b, 'n> {
    module: ModuleId,
    file: SourceId,
    text: &'b str,
    narrow: &'n NarrowEnv,
    strict: bool,
    /// Whether this expression is a server-default initializer (the
    /// only position that may call `random_secret()`).
    server_default: bool,
}

/// The types pass: declaration types plus per-node value types.
struct Typer<'a> {
    db: &'a SourceDb,
    catalog: Option<&'a Catalog>,
    tables: &'a ResolveTables,
    diags: &'a mut Vec<Diagnostic>,
    types: TypeTable,
    /// Declared type of every Field/Param/DeriveField symbol.
    decl: HashMap<SymbolId, ResolvedType>,
    /// Initializer shape of every Field/Param/DeriveField symbol:
    /// (has default, has server initializer, has `!`).
    shapes: HashMap<SymbolId, (bool, bool, bool)>,
    machines: HashSet<SymbolId>,
    /// Declared result of every Scenario/CapabilityOp symbol
    /// (`None` = void).
    results: HashMap<SymbolId, Option<ResolvedType>>,
    /// `let` statement node to inferred value type.
    lets: HashMap<NodeKey, ResolvedType>,
    /// `for` statement node to domain element type.
    fors: HashMap<NodeKey, ResolvedType>,
    /// `as` clause node to domain element type.
    aliases: HashMap<NodeKey, ResolvedType>,
    /// Query node to result element type (for `RowQuery` row bindings).
    rows: HashMap<NodeKey, ResolvedType>,
    /// `create` statement node to created record type.
    creates: HashMap<NodeKey, ResolvedType>,
    /// `call` statement node to result type (or opaque).
    calls: HashMap<NodeKey, ResolvedType>,
    /// `send` statement node to delivery type (or opaque).
    sends: HashMap<NodeKey, ResolvedType>,
    /// `RouteScalar` node to declared parameter type.
    routes: HashMap<NodeKey, ResolvedType>,
    /// Module to its preferences symbol, when declared.
    prefs: HashMap<ModuleId, SymbolId>,
    /// Declared type dependencies from the latest phase-1 round.
    field_reuse_edges: Vec<(SymbolId, SymbolId, Span)>,
    /// Scenario result expectation while walking its body:
    /// `None` = outside a scenario, `Some(None)` = void scenario.
    current_result: Option<Option<ResolvedType>>,
    /// Models with a `retain` declaration (span of the first).
    retain_seen: HashMap<SymbolId, Span>,
    /// Scenario whose body is being walked (`call` edge source).
    current_op: Option<SymbolId>,
    /// Static `call` edges: (caller scenario, callee scenario, span).
    call_edges: Vec<(SymbolId, SymbolId, Span)>,
    /// Literal schedule keys per module (span of the first use).
    schedule_keys: HashMap<(ModuleId, String), Span>,
    /// Declared `source=` language tag per module (default `"en"`).
    module_source: HashMap<ModuleId, String>,
    /// Fields whose default/server initializer reads `actor`.
    default_uses_actor: HashSet<SymbolId>,
    /// Triggering hook while walking its body: (model, operation).
    current_hook: Option<(SymbolId, CrudOp)>,
    /// Declared pre-commit hooks per (model, operation) (first span).
    hooks_seen: HashMap<(SymbolId, CrudOp), Span>,
    /// Whether the walked body belongs to a `read=true` operation.
    current_read: bool,
    /// Scenarios declared with `read=true` (collected pre-phase-2).
    read_scenarios: HashSet<SymbolId>,
    /// Context-declared queue names per module (send/on= targets).
    queue_names: HashSet<(ModuleId, String)>,
}

impl<'a> Typer<'a> {
    fn new(
        db: &'a SourceDb,
        catalog: Option<&'a Catalog>,
        tables: &'a ResolveTables,
        diags: &'a mut Vec<Diagnostic>,
    ) -> Self {
        Self {
            db,
            catalog,
            tables,
            diags,
            types: TypeTable::default(),
            decl: HashMap::new(),
            shapes: HashMap::new(),
            machines: HashSet::new(),
            results: HashMap::new(),
            lets: HashMap::new(),
            fors: HashMap::new(),
            aliases: HashMap::new(),
            rows: HashMap::new(),
            creates: HashMap::new(),
            calls: HashMap::new(),
            sends: HashMap::new(),
            routes: HashMap::new(),
            prefs: HashMap::new(),
            field_reuse_edges: Vec::new(),
            current_result: None,
            retain_seen: HashMap::new(),
            current_op: None,
            call_edges: Vec::new(),
            schedule_keys: HashMap::new(),
            module_source: HashMap::new(),
            default_uses_actor: HashSet::new(),
            current_hook: None,
            hooks_seen: HashMap::new(),
            current_read: false,
            read_scenarios: HashSet::new(),
            queue_names: HashSet::new(),
        }
    }

    /// Source text of `file` (empty when unknown; spans then stay
    /// whole-node).
    fn text(&self, file: SourceId) -> &str {
        file_text(self.db, file).unwrap_or("")
    }

    /// Display a type in `module` for diagnostics.
    fn show(&self, module: ModuleId, ty: &ResolvedType) -> String {
        ty.display(self.tables, module)
    }

    /// Record the type of `node`.
    fn record(&mut self, node: &SyntaxNode, ty: ResolvedType) -> ResolvedType {
        self.types.node_types.insert(NodeKey::of(node), ty.clone());
        ty
    }

    /// Push an `E2013` member failure for pass 2 emission.
    fn member_fail(&mut self, node: &SyntaxNode, span: Span, base: String, name: String) {
        self.types.unresolved_members.push(UnresolvedMember {
            node: NodeKey::of(node),
            span,
            base,
            name,
        });
    }
}

/// Tight span of `node`: leading/trailing trivia trimmed so primary
/// spans point at significant source (interior CST nodes union their
/// children's spans, so a `NameRef` after a space can cover `" trim"`).
/// Byte trims split on char boundaries, so the span stays valid.
fn tight_span(text: &str, node: &SyntaxNode) -> Span {
    let raw = text
        .get(node.span.start as usize..node.span.end as usize)
        .unwrap_or("");
    let leading = raw.len() - raw.trim_start().len();
    let trimmed = raw.trim();
    let start = node.span.start + leading as u32;
    Span::new(node.span.file, start, start + trimmed.len() as u32)
}

/// Append fixpoint-round diagnostics, skipping ones already present
/// (order-free phase-1 findings re-fire identically every round).
fn merge_round_diags(into: &mut Vec<Diagnostic>, extra: Vec<Diagnostic>) {
    for d in extra {
        let dup = into.iter().any(|e| {
            e.code == d.code
                && e.severity == d.severity
                && e.message == d.message
                && e.primary == d.primary
                && e.related.len() == d.related.len()
                && e.related
                    .iter()
                    .zip(d.related.iter())
                    .all(|(a, b)| a.span == b.span && a.message == b.message)
        });
        if !dup {
            into.push(d);
        }
    }
}

/// Literal leaf text of a `Literal` node: (leaf kind, raw source slice).
fn literal_leaf<'a>(node: &SyntaxNode, text: &'a str) -> Option<(SyntaxKind, &'a str)> {
    if node.kind != SyntaxKind::Literal {
        return None;
    }
    kids(node).iter().find_map(|leaf| {
        let slice = text.get(leaf.span.start as usize..leaf.span.end as usize)?;
        match leaf.kind {
            SyntaxKind::Integer
            | SyntaxKind::Decimal
            | SyntaxKind::Duration
            | SyntaxKind::Bytes
            | SyntaxKind::String
            | SyntaxKind::Name => Some((leaf.kind, slice)),
            _ => None,
        }
    })
}

/// Module of an `App`/`Package` node (mirrors the resolver: first
/// `Name` child that is not a head word).
fn module_of_node(tables: &ResolveTables, text: &str, node: &SyntaxNode) -> Option<ModuleId> {
    let name = kids(node).iter().find_map(|n| {
        let word = name_text(n, text)?;
        (!matches!(word, "app" | "package" | "export" | "migration")).then_some(word)
    })?;
    tables.module_by_name.get(name).copied()
}

/// `-> type` result annotation of a scenario/capability-op node.
fn arrow_result(node: &SyntaxNode) -> Option<&SyntaxNode> {
    let parts = kids(node);
    for i in 0..parts.len() {
        let is_arrow = parts[i]
            .token()
            .is_some_and(|t| t.kind == TokenKind::Punct(Punct::Arrow));
        if is_arrow {
            return parts.get(i + 1).copied().filter(|n| is_type_node(n.kind));
        }
    }
    None
}

/// Whether this CST kind is a type node.
fn is_type_node(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::NamedType
            | SyntaxKind::UnionType
            | SyntaxKind::ArrayType
            | SyntaxKind::NullableType
            | SyntaxKind::EnumType
            | SyntaxKind::ActionType
            | SyntaxKind::DeliveryType
            | SyntaxKind::InvocationType
    )
}

/// Field/parameter shape of one `Field`/`Parameter` node: type node,
/// default value, server value, modifiers, label caption.
struct FieldParts<'n> {
    type_node: Option<&'n SyntaxNode>,
    default: Option<&'n SyntaxNode>,
    server: Option<&'n SyntaxNode>,
    /// (`trim`|`unique` bare words and (`min`|`max`, value)).
    modifiers: Vec<FieldModifier<'n>>,
    label: Option<&'n SyntaxNode>,
    bang: bool,
}

#[derive(Debug, Clone, Copy)]
enum FieldModifier<'n> {
    Trim(&'n SyntaxNode),
    Unique(&'n SyntaxNode),
    Machine(&'n SyntaxNode),
    Min(&'n SyntaxNode),
    Max(&'n SyntaxNode),
}

/// Read the shape of a `Field`/`Parameter` node: `name : type
/// [= default] [server = expr] [modifiers] [label = caption] [!]`.
/// Duplicate attributes are the parser's (`E1202`); unknown words are
/// skipped here (the parser owns them too) so this pass stays silent.
fn field_parts<'n>(node: &'n SyntaxNode, text: &str) -> FieldParts<'n> {
    let mut parts = FieldParts {
        type_node: None,
        default: None,
        server: None,
        modifiers: Vec::new(),
        label: None,
        bang: false,
    };
    let children = kids(node);
    // Skip the field name (first `Name` child).
    let mut i = 0;
    let mut skipped_name = false;
    while i < children.len() {
        let part = children[i];
        if !skipped_name && part.kind == SyntaxKind::Name {
            skipped_name = true;
            i += 1;
            continue;
        }
        if is_type_node(part.kind) {
            if parts.type_node.is_none() {
                parts.type_node = Some(part);
            }
        } else if is_punct(part, text, "!") {
            parts.bang = true;
        } else if is_punct(part, text, "=") {
            // Bare `=` directly after the type introduces the default
            // value (`server`/`label`/`min`/`max` values have a word
            // before their `=`).
            let after_type = i > 0 && is_type_node(children[i - 1].kind);
            if after_type
                && parts.default.is_none()
                && let Some(next) = children.get(i + 1)
                && is_expression(next.kind)
            {
                parts.default = Some(*next);
            }
        } else if is_name(part, text, "server") {
            if let Some(value) = children.get(i + 2) {
                parts.server = Some(*value);
            }
        } else if is_name(part, text, "label") {
            if let Some(value) = children.get(i + 2) {
                parts.label = Some(*value);
            }
        } else if is_name(part, text, "trim") {
            parts.modifiers.push(FieldModifier::Trim(part));
        } else if is_name(part, text, "unique") {
            parts.modifiers.push(FieldModifier::Unique(part));
        } else if is_name(part, text, "machine") {
            parts.modifiers.push(FieldModifier::Machine(part));
        } else if is_name(part, text, "min") {
            parts.modifiers.push(FieldModifier::Min(part));
        } else if is_name(part, text, "max") {
            parts.modifiers.push(FieldModifier::Max(part));
        }
        i += 1;
    }
    parts
}

/// Value expression of a `min=`/`max=` modifier word (`word = value`).
fn modifier_value<'n>(node: &'n SyntaxNode, modifier: &SyntaxNode) -> Option<&'n SyntaxNode> {
    let children = kids(node);
    for i in 0..children.len() {
        if std::ptr::eq(children[i], modifier) {
            return children.get(i + 2).copied();
        }
    }
    None
}

impl<'a> Typer<'a> {
    // --- Phase 1: declared types -----------------------------------------

    /// Resolve every field/parameter/result/route annotation into
    /// [`Typer::decl`] and [`Typer::results`]. Type-structure violations
    /// (bad suffixes on resolved types, union arms, action/delivery
    /// targets, non-type annotations) are `E3008`/`E3009`/`E3010`.
    fn phase1(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        self.phase1_round(trees);
        // Forward field-chain references (`M.s` naming a field declared
        // later) read an absent `decl` entry on the first round and come
        // out tentative-`Error`, silently: every phase-1 diagnostic is
        // either order-free (identical every round) or silent on a
        // tentative `Error` (suffix, `!`, chain-navigation checks), so a
        // later round only ever resolves more types and adds diagnostics.
        // Iterate to fixpoint; each changing round settles at least one
        // entry, so `entries + 1` extra rounds always suffice.
        let bound = self.decl.len() + self.results.len() + self.routes.len() + 1;
        for _ in 0..bound {
            let before = (self.decl.clone(), self.results.clone(), self.routes.clone());
            let mut scratch = Vec::new();
            std::mem::swap(&mut *self.diags, &mut scratch);
            self.phase1_round(trees);
            let round = std::mem::replace(&mut *self.diags, scratch);
            merge_round_diags(self.diags, round);
            if (self.decl.clone(), self.results.clone(), self.routes.clone()) == before {
                break;
            }
        }
        // Chain-navigation failures re-record every round; keep the first
        // occurrence (pass-2 emission dedupes again).
        let mut seen = HashSet::new();
        self.types
            .unresolved_members
            .retain(|m| seen.insert((m.node, m.name.clone())));
        self.check_field_reuse_cycles();
    }

    fn phase1_round(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        self.field_reuse_edges.clear();
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for child in kids(tree) {
                if !matches!(child.kind, SyntaxKind::App | SyntaxKind::Package) {
                    continue;
                }
                let Some(module) = module_of_node(self.tables, &text, child) else {
                    continue;
                };
                self.phase1_module(*file, &text, module, child);
            }
        }
    }

    fn phase1_module(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        for section in kids(node) {
            if section.kind != SyntaxKind::Section {
                continue;
            }
            let marker = kids(section)
                .iter()
                .find_map(|n| name_text(n, text))
                .unwrap_or("");
            for item in kids(section) {
                if has_error(item) {
                    continue;
                }
                match marker {
                    "Given" => self.phase1_given(file, text, module, item),
                    "When" => self.phase1_when(file, text, module, item),
                    "Then" => self.phase1_then(file, text, module, item),
                    _ => {}
                }
            }
        }
    }

    fn phase1_given(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        match node.kind {
            SyntaxKind::Preferences => {
                if let Some(prefs) = self.prefs_symbol(module) {
                    self.prefs.insert(module, prefs);
                    for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                        self.phase1_field(file, text, module, prefs, field);
                    }
                }
            }
            SyntaxKind::Model | SyntaxKind::Contract | SyntaxKind::Event => {
                let head = match node.kind {
                    SyntaxKind::Model => "model",
                    SyntaxKind::Contract => "contract",
                    _ => "event",
                };
                if let Some(owner) = self.decl_symbol(module, text, node, &["export", head]) {
                    for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                        self.phase1_field(file, text, module, owner, field);
                    }
                }
            }
            SyntaxKind::Capability => {
                if let Some(cap) = self.decl_symbol(module, text, node, &["export", "capability"]) {
                    for child in node.children.iter().filter(|c| {
                        matches!(c.kind, SyntaxKind::CapabilityOp | SyntaxKind::Event)
                            && !has_error(c)
                    }) {
                        if child.kind == SyntaxKind::CapabilityOp {
                            if let Some(op) = self.member_symbol(cap, text, child) {
                                self.phase1_params(file, text, module, op, child);
                                let result = arrow_result(child)
                                    .map(|t| self.resolve_type_node(file, text, module, t, None));
                                self.results.insert(op, result);
                            }
                        } else if let Some(event) = self.member_symbol(cap, text, child) {
                            for field in child
                                .children
                                .iter()
                                .filter(|c| c.kind == SyntaxKind::Field)
                            {
                                self.phase1_field(file, text, module, event, field);
                            }
                        }
                    }
                }
            }
            SyntaxKind::Message => {
                if let Some(message) = self.decl_symbol(module, text, node, &["export", "message"])
                {
                    self.phase1_params(file, text, module, message, node);
                }
            }
            SyntaxKind::Derive => {
                let parts = kids(node);
                let is_function = parts.iter().any(|n| is_punct(n, text, "("));
                if is_function {
                    let name = parts
                        .iter()
                        .find(|n| n.kind == SyntaxKind::Path)
                        .map(|p| path_segments(p, text).join("."))
                        .unwrap_or_default();
                    if let Some(id) = self.prod_symbol(module, &name) {
                        self.phase1_params(file, text, module, id, node);
                        // Derived functions spell the result `: type`.
                        let mut result = None;
                        for i in 0..parts.len() {
                            if is_punct(parts[i], text, ":")
                                && let Some(next) = parts.get(i + 1)
                                && is_type_node(next.kind)
                            {
                                result =
                                    Some(self.resolve_type_node(file, text, module, next, None));
                            }
                        }
                        self.results.insert(id, result);
                    }
                } else if let Some(path) = parts.iter().find(|n| n.kind == SyntaxKind::Path) {
                    // Derived field: owner is the model symbol; the
                    // DeriveField symbol carries the type node.
                    let segments = path_segments(path, text);
                    if segments.len() == 2
                        && let Some(model) = self.prod_symbol(module, segments[0])
                    {
                        let field_name = segments[1].to_string();
                        let found = self.tables.symbols[model.0 as usize]
                            .fields_of()
                            .iter()
                            .find(|f| self.tables.symbols[f.0 as usize].name == field_name)
                            .copied();
                        if let Some(field) = found
                            && let Some(ty) = parts.iter().find(|n| is_type_node(n.kind))
                        {
                            let resolved =
                                self.resolve_type_node(file, text, module, ty, Some(field));
                            self.decl.insert(field, resolved);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn phase1_when(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        if node.kind != SyntaxKind::Scenario {
            return;
        }
        let name = kids(node)
            .iter()
            .find_map(|n| {
                let word = name_text(n, text)?;
                (!matches!(word, "export" | "scenario")).then_some(word.to_string())
            })
            .unwrap_or_default();
        if let Some(id) = self.prod_symbol(module, &name) {
            self.phase1_params(file, text, module, id, node);
            let result =
                arrow_result(node).map(|t| self.resolve_type_node(file, text, module, t, None));
            self.results.insert(id, result);
        }
    }

    fn phase1_then(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        if node.kind != SyntaxKind::Page {
            return;
        }
        for route in node
            .descendants()
            .filter(|n| n.kind == SyntaxKind::RouteScalar && !has_error(n))
        {
            let ty = kids(route)
                .iter()
                .find(|n| is_type_node(n.kind))
                .map(|t| self.resolve_type_node(file, text, module, t, None))
                .unwrap_or(ResolvedType::Error);
            self.routes.insert(NodeKey::of(route), ty);
        }
    }

    /// Resolve the type of one `Field` node into [`Typer::decl`].
    fn phase1_field(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        owner: SymbolId,
        field: &SyntaxNode,
    ) {
        if has_error(field) {
            return;
        }
        let name = kids(field)
            .first()
            .filter(|n| n.kind == SyntaxKind::Name)
            .and_then(|n| name_text(n, text))
            .unwrap_or("");
        if name.is_empty() {
            return;
        }
        let found = self.tables.symbols[owner.0 as usize]
            .fields_of()
            .iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
            .copied();
        let Some(id) = found else { return };
        let shape = field_parts(field, text);
        if shape
            .modifiers
            .iter()
            .any(|m| matches!(m, FieldModifier::Machine(_)))
        {
            self.machines.insert(id);
        }
        self.shapes.insert(
            id,
            (shape.default.is_some(), shape.server.is_some(), shape.bang),
        );
        let Some(type_node) = shape.type_node else {
            self.decl.insert(id, ResolvedType::Error);
            return;
        };
        let resolved = self.resolve_type_node(file, text, module, type_node, Some(id));
        // `!` is required-array-input metadata; the value type is the array.
        // Error/Opaque/Unknown already carry their own diagnostic: stay silent.
        if shape.bang
            && !matches!(
                resolved,
                ResolvedType::Array { .. }
                    | ResolvedType::Error
                    | ResolvedType::Opaque(_)
                    | ResolvedType::Unknown
            )
        {
            self.diags.push(Diagnostic::error(
                "E3008",
                format!(
                    "field '{name}' uses `!` on {}; only required array inputs take `!`",
                    self.show(module, &resolved)
                ),
                tight_span(text, field),
            ));
            self.decl.insert(id, ResolvedType::Error);
            return;
        }
        self.decl.insert(id, resolved);
    }

    /// Resolve every `Parameter` type of `owner` into [`Typer::decl`].
    /// A `!` on a parameter is `E3008` (parameters have no field-only
    /// `!`); the parser usually rejects it first.
    fn phase1_params(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        owner: SymbolId,
        node: &SyntaxNode,
    ) {
        let params = match &self.tables.symbols[owner.0 as usize].kind {
            SymbolKind::Scenario { params, .. }
            | SymbolKind::Message { params }
            | SymbolKind::DeriveFn { params, .. }
            | SymbolKind::CapabilityOp { params, .. } => params.clone(),
            _ => Vec::new(),
        };
        let param_nodes: Vec<&SyntaxNode> = node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
            .collect();
        for (param_node, id) in param_nodes.iter().zip(params.iter()) {
            if has_error(param_node) {
                self.decl.insert(*id, ResolvedType::Error);
                continue;
            }
            let shape = field_parts(param_node, text);
            self.shapes.insert(
                *id,
                (shape.default.is_some(), shape.server.is_some(), shape.bang),
            );
            if shape.bang {
                let name = self.tables.symbols[id.0 as usize].name.clone();
                self.diags.push(Diagnostic::error(
                    "E3008",
                    format!("parameter '{name}' must not use `!`; only stored fields take it"),
                    tight_span(text, param_node),
                ));
                self.decl.insert(*id, ResolvedType::Error);
                continue;
            }
            let Some(type_node) = shape.type_node else {
                self.decl.insert(*id, ResolvedType::Error);
                continue;
            };
            let resolved = self.resolve_type_node(file, text, module, type_node, Some(*id));
            self.decl.insert(*id, resolved);
        }
        // Positional mismatch (duplicate parameters already `E2002`):
        // unvisited parameter symbols stay absent and read as errors.
    }

    /// Production-scope symbol by local name.
    fn prod_symbol(&self, module: ModuleId, name: &str) -> Option<SymbolId> {
        match self.tables.module_scopes[module.0 as usize]
            .prod
            .get(name)?
        {
            super::resolve::ScopedName::Local(id) => Some(*id),
            _ => None,
        }
    }

    /// Production symbol by name, following import aliases.
    fn prod_or_imported(&self, module: ModuleId, name: &str) -> Option<SymbolId> {
        match self.tables.module_scopes[module.0 as usize].prod.get(name) {
            Some(ScopedName::Local(id) | ScopedName::Imported { target: id, .. }) => Some(*id),
            _ => None,
        }
    }

    /// Declared symbol of a Given declaration node (first non-head name).
    /// Capability member (op or event) symbol by node name.
    fn member_symbol(&self, cap: SymbolId, text: &str, node: &SyntaxNode) -> Option<SymbolId> {
        let name = kids(node).iter().find_map(|n| {
            let word = name_text(n, text)?;
            (word != "event").then_some(word)
        })?;
        let (ops, events) = match &self.tables.symbols[cap.0 as usize].kind {
            SymbolKind::Capability { ops, events } => (ops.clone(), events.clone()),
            _ => return None,
        };
        ops.into_iter()
            .chain(events)
            .find(|id| self.tables.symbols[id.0 as usize].name == name)
    }

    /// Preferences symbol of `module`, when declared.
    fn prefs_symbol(&self, module: ModuleId) -> Option<SymbolId> {
        self.tables
            .symbols
            .iter()
            .find(|s| s.module == module && matches!(s.kind, SymbolKind::Preferences { .. }))
            .map(|s| s.id)
    }

    /// Declared type of a field/parameter symbol (`Error` when absent).
    fn decl_type(&self, id: SymbolId) -> ResolvedType {
        self.decl.get(&id).cloned().unwrap_or(ResolvedType::Error)
    }

    /// Resolve one type node. `owner` is the declared field/parameter
    /// symbol for enum ownership (and reuse-cycle reporting).
    fn resolve_type_node(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
        if has_error(node) {
            return ResolvedType::Error;
        }
        match node.kind {
            SyntaxKind::NamedType => {
                let parts = kids(node);
                let path = parts.iter().find(|n| n.kind == SyntaxKind::Path);
                match path {
                    Some(path) => self.resolve_path_type(file, text, module, path, owner),
                    None => ResolvedType::Error,
                }
            }
            SyntaxKind::NullableType => {
                let inner = kids(node)
                    .iter()
                    .find(|n| is_type_node(n.kind))
                    .map(|t| self.resolve_type_node(file, text, module, t, owner))
                    .unwrap_or(ResolvedType::Error);
                match inner {
                    ResolvedType::Error | ResolvedType::Opaque(_) => inner,
                    ResolvedType::Nullable(_) => {
                        self.diags.push(Diagnostic::error(
                            "E3008",
                            format!(
                                "type '{}' is already nullable; `?` applies once",
                                self.show(module, &inner)
                            ),
                            tight_span(text, node),
                        ));
                        ResolvedType::Error
                    }
                    other => ResolvedType::Nullable(Box::new(other)),
                }
            }
            SyntaxKind::ArrayType => {
                let inner = kids(node)
                    .iter()
                    .find(|n| is_type_node(n.kind))
                    .map(|t| self.resolve_type_node(file, text, module, t, owner))
                    .unwrap_or(ResolvedType::Error);
                match inner {
                    ResolvedType::Error | ResolvedType::Opaque(_) => inner,
                    ResolvedType::Array { .. } => {
                        self.diags.push(Diagnostic::error(
                            "E3008",
                            "nested arrays are not permitted; use one `[]` suffix".to_string(),
                            tight_span(text, node),
                        ));
                        ResolvedType::Error
                    }
                    ResolvedType::Nullable(_) => {
                        self.diags.push(Diagnostic::error(
                            "E3008",
                            "nullable array elements are not permitted".to_string(),
                            tight_span(text, node),
                        ));
                        ResolvedType::Error
                    }
                    other => ResolvedType::Array {
                        element: Box::new(other),
                        // Every array value is ordered (authored
                        // order, `created,id`, or encounter order);
                        // only the nonempty proof is literal-based.
                        ordered: true,
                        nonempty: false,
                    },
                }
            }
            SyntaxKind::UnionType => self.resolve_union(file, text, module, node),
            SyntaxKind::EnumType => {
                let mut cases = Vec::new();
                for child in kids(node) {
                    if child.kind != SyntaxKind::Path {
                        continue;
                    }
                    for case in path_segments(child, text) {
                        cases.push(case.to_string());
                    }
                }
                ResolvedType::Enum { cases, owner }
            }
            SyntaxKind::ActionType => self.resolve_action(file, text, module, node),
            SyntaxKind::DeliveryType => self.resolve_delivery(file, text, module, node),
            SyntaxKind::InvocationType => self.resolve_invocation(file, text, module, node),
            _ => ResolvedType::Error,
        }
    }

    /// Resolve a `NamedType` path via the resolver's [`TypeRef`].
    /// Missing entries mean the resolver already diagnosed (`E2001`/
    /// `E2013`) or the path is external (opaque, silent).
    fn resolve_path_type(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        path: &SyntaxNode,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
        let key = NodeKey::of(path);
        let Some(typeref) = self.tables.node_typeref.get(&key).cloned() else {
            return ResolvedType::Opaque("unresolved type path");
        };
        match typeref {
            TypeRef::Scalar(name) => match scalar_named(&name) {
                Some(scalar) => ResolvedType::Scalar(scalar),
                None => match name.as_str() {
                    "Team" => ResolvedType::Team,
                    "OperationContext" => ResolvedType::OperationContext,
                    _ => ResolvedType::Opaque("unknown scalar"),
                },
            },
            TypeRef::External => ResolvedType::Opaque("external type"),
            TypeRef::Symbol(id) => self.symbol_type(file, text, module, id, path.span),
            TypeRef::FieldChain {
                head,
                fields,
                consumed,
            } => self.resolve_chain(file, text, module, path, head, &fields, consumed, owner),
        }
    }

    /// Value type denoted by a bare type symbol. Non-type symbols are
    /// `E3008` (the resolver accepted any scoped name here).
    fn symbol_type(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        id: SymbolId,
        span: Span,
    ) -> ResolvedType {
        let symbol = &self.tables.symbols[id.0 as usize];
        match &symbol.kind {
            SymbolKind::Model { .. }
            | SymbolKind::Contract { .. }
            | SymbolKind::Event { .. }
            | SymbolKind::Preferences { .. } => ResolvedType::Record {
                symbol: id,
                stored: true,
            },
            SymbolKind::Message { .. } => ResolvedType::Message(id),
            other => {
                let kind = match other {
                    SymbolKind::Role => "role",
                    SymbolKind::Capability { .. } => "capability",
                    SymbolKind::CapabilityOp { .. } => "capability operation",
                    SymbolKind::Scenario { .. } => "scenario",
                    SymbolKind::Crud { .. } => "crud declaration",
                    SymbolKind::CrudOp { .. } => "crud operation",
                    SymbolKind::Fixture { .. } => "fixture",
                    SymbolKind::DeriveFn { .. } => "derived function",
                    _ => "declaration",
                };
                // Field/Param/DeriveField cannot be named in type
                // position (resolve never produces them here); any
                // other hit is a genuine non-type annotation.
                let name = record_name(self.tables, module, id);
                self.diags.push(Diagnostic::error(
                    "E3008",
                    format!("{kind} '{name}' is not a type"),
                    Span::new(span.file, span.start, span.end),
                ));
                let _ = text;
                ResolvedType::Error
            }
        }
    }

    /// Continue a `Model.field…` reuse chain past the resolver's first
    /// level with resolved field types.
    #[allow(clippy::too_many_arguments)]
    fn resolve_chain(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        path: &SyntaxNode,
        head: SymbolId,
        fields: &[SymbolId],
        consumed: usize,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
        let segments = path_segments(path, text);
        let Some(first) = fields.first() else {
            return ResolvedType::Opaque("empty reuse chain");
        };
        let mut current = self.reused_field_type(owner, *first, path.span);
        // Navigate deeper segments (`consumed` counts the head plus
        // the resolver-validated field; qualified paths consumed one
        // extra package segment, which `consumed` accounts for).
        let base = if self.tables.module_by_name.contains_key(segments[0]) {
            1
        } else {
            0
        };
        for (i, segment) in segments.iter().enumerate().skip(consumed - base) {
            match current {
                ResolvedType::Record { symbol, .. } => {
                    let found = self.tables.symbols[symbol.0 as usize]
                        .fields_of()
                        .iter()
                        .find(|f| self.tables.symbols[f.0 as usize].name == *segment)
                        .copied();
                    match found {
                        Some(field) => {
                            current = self.reused_field_type(owner, field, path.span);
                        }
                        None => {
                            let base_name = record_name(self.tables, module, symbol);
                            self.member_fail(
                                path,
                                segment_span(path, i),
                                base_name,
                                (*segment).to_string(),
                            );
                            return ResolvedType::Error;
                        }
                    }
                }
                ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => {
                    return current;
                }
                other => {
                    self.member_fail(
                        path,
                        segment_span(path, i),
                        self.show(module, &other),
                        (*segment).to_string(),
                    );
                    return ResolvedType::Error;
                }
            }
        }
        let _ = (file, head);
        current
    }

    fn reused_field_type(
        &mut self,
        owner: Option<SymbolId>,
        field: SymbolId,
        span: Span,
    ) -> ResolvedType {
        if let Some(owner) = owner {
            self.field_reuse_edges.push((owner, field, span));
        }
        self.decl_type(field)
    }

    /// Cached field types cannot recurse while resolving an annotation.
    /// Diagnose dependency cycles after forward types reach their fixpoint,
    /// using iterative strongly connected components and authored edge order.
    fn check_field_reuse_cycles(&mut self) {
        if self.field_reuse_edges.is_empty() {
            return;
        }
        let count = self.tables.symbols.len();
        let mut forward = vec![Vec::new(); count];
        let mut reverse = vec![Vec::new(); count];
        for &(from, to, _) in &self.field_reuse_edges {
            forward[from.0 as usize].push(to.0 as usize);
            reverse[to.0 as usize].push(from.0 as usize);
        }
        let mut seen = vec![false; count];
        let mut order = Vec::new();
        for root in 0..count {
            let mut stack = vec![(root, false)];
            while let Some((node, finished)) = stack.pop() {
                if finished {
                    order.push(node);
                } else if !seen[node] {
                    seen[node] = true;
                    stack.push((node, true));
                    stack.extend(forward[node].iter().rev().map(|&next| (next, false)));
                }
            }
        }
        let mut components = vec![usize::MAX; count];
        let mut sizes = Vec::new();
        for root in order.into_iter().rev() {
            if components[root] != usize::MAX {
                continue;
            }
            let component = sizes.len();
            let mut size = 0;
            let mut stack = vec![root];
            while let Some(node) = stack.pop() {
                if components[node] != usize::MAX {
                    continue;
                }
                components[node] = component;
                size += 1;
                stack.extend(reverse[node].iter().copied());
            }
            sizes.push(size);
        }
        for &(from, to, span) in &self.field_reuse_edges {
            let component = components[from.0 as usize];
            if component == components[to.0 as usize] && (sizes[component] > 1 || from == to) {
                let module = self.tables.symbols[from.0 as usize].module;
                let name = record_name(self.tables, module, to);
                self.diags.push(Diagnostic::error(
                    "E3008",
                    format!("cyclic field-type reuse through '{name}'"),
                    span,
                ));
            }
        }
    }

    /// Resolve a `UnionType`: every arm must be a supported tagged
    /// named value type (model, contract, event). Primitive unions,
    /// `enum`/`action`/`delivery` arms and duplicates are `E3008`.
    fn resolve_union(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> ResolvedType {
        let mut arms = Vec::new();
        let mut bad = false;
        for child in kids(node) {
            if child.kind != SyntaxKind::Path {
                continue;
            }
            let key = NodeKey::of(child);
            match self.tables.node_typeref.get(&key).cloned() {
                Some(TypeRef::Symbol(id)) => match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::Model { .. }
                    | SymbolKind::Contract { .. }
                    | SymbolKind::Event { .. } => {
                        if arms.contains(&id) {
                            let name = record_name(self.tables, module, id);
                            self.diags.push(Diagnostic::error(
                                "E3008",
                                format!("duplicate union arm '{name}'"),
                                tight_span(text, child),
                            ));
                            bad = true;
                        } else {
                            arms.push(id);
                        }
                    }
                    _ => {
                        let name = record_name(self.tables, module, id);
                        self.diags.push(Diagnostic::error(
                            "E3008",
                            format!(
                                "union arm '{name}' is not a model, contract or event; primitive unions are not authorized"
                            ),
                            tight_span(text, child),
                        ));
                        bad = true;
                    }
                },
                Some(TypeRef::Scalar(name)) => {
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        format!(
                            "union arm '{name}' is primitive; union arms must be named value types"
                        ),
                        tight_span(text, child),
                    ));
                    bad = true;
                }
                Some(TypeRef::FieldChain { .. }) => {
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        "union arms must be named types, not field paths".to_string(),
                        tight_span(text, child),
                    ));
                    bad = true;
                }
                Some(TypeRef::External) | None => {
                    // External arms are opaque (PR5 schemas them); a
                    // missing entry means the resolver diagnosed.
                    if self.tables.node_typeref.contains_key(&key) {
                        return ResolvedType::Opaque("external union arm");
                    }
                    bad = true;
                }
            }
        }
        if bad || arms.is_empty() {
            ResolvedType::Error
        } else {
            ResolvedType::Union(arms)
        }
    }

    /// Whether `id` is a statically canonical enabled user mutation
    /// target: a non-trusted, non-read scenario or an enabled
    /// generated CRUD operation.
    fn is_mutation_target(&self, id: SymbolId) -> bool {
        match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Scenario { trusted, .. } => !*trusted && !self.read_scenarios.contains(&id),
            SymbolKind::CrudOp { model, op } => self.crud_op_enabled(*model, *op),
            _ => false,
        }
    }

    /// Resolve an `ActionType`: every target must be a statically
    /// canonical enabled user mutation (a non-trusted, non-read
    /// scenario or an enabled generated CRUD operation). Anything
    /// else is `E3009`.
    fn resolve_action(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> ResolvedType {
        let mut targets = Vec::new();
        let mut external = Vec::new();
        let mut bad = false;
        for child in kids(node) {
            if child.kind != SyntaxKind::Path {
                continue;
            }
            let key = NodeKey::of(child);
            match self.tables.node_symbol.get(&key).copied() {
                Some(id) => match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::Scenario { trusted, .. } => {
                        if *trusted {
                            let name = record_name(self.tables, module, id);
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!(
                                    "action target '{name}' is a trusted handler, not a user mutation"
                                ),
                                tight_span(text, child),
                            ));
                            bad = true;
                        } else if self.read_scenarios.contains(&id) {
                            let name = record_name(self.tables, module, id);
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!(
                                    "action target '{name}' is a read scenario, not a user mutation"
                                ),
                                tight_span(text, child),
                            ));
                            bad = true;
                        } else {
                            targets.push(id);
                        }
                    }
                    SymbolKind::CrudOp { model, op } => {
                        let enabled = match self.tables.crud_of_model.get(model) {
                            Some(crud) => match &self.tables.symbols[crud.0 as usize].kind {
                                SymbolKind::Crud {
                                    create,
                                    update,
                                    delete,
                                    ..
                                } => match op {
                                    CrudOp::Create => *create,
                                    CrudOp::Update => *update,
                                    CrudOp::Delete => *delete,
                                },
                                _ => false,
                            },
                            None => false,
                        };
                        if enabled {
                            targets.push(id);
                        } else {
                            let name = record_name(self.tables, module, id);
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!("action target '{name}' is not an enabled operation"),
                                tight_span(text, child),
                            ));
                            bad = true;
                        }
                    }
                    _ => {
                        let name = record_name(self.tables, module, id);
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            format!(
                                "action target '{name}' is not a canonical user mutation (scenario or Model.create/update/delete)"
                            ),
                            tight_span(text, child),
                        ));
                        bad = true;
                    }
                },
                None => {
                    // Bound-import targets carry no symbol; the
                    // resolver records their canonical identity
                    // instead (valid per DESIGN §2.1).
                    if let Some(canonical) = self.tables.node_external_op.get(&key).cloned() {
                        external.push(canonical);
                    } else {
                        // Resolver diagnosed (`E2001`/`E2013`).
                        bad = true;
                    }
                }
            }
        }
        if bad || (targets.is_empty() && external.is_empty()) {
            ResolvedType::Error
        } else {
            // Type-position values have unknown construction sites.
            ResolvedType::Action {
                targets,
                bound: None,
                external,
            }
        }
    }

    /// Resolve an `InvocationType` (DESIGN §2.2): a nonempty distinct
    /// closed set of local enabled user mutation targets. Trusted
    /// handlers, read scenarios, disabled operations, repeats and
    /// non-operations are `E3009`.
    fn resolve_invocation(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> ResolvedType {
        let mut targets = Vec::new();
        let mut bad = false;
        for child in kids(node) {
            if child.kind != SyntaxKind::Path {
                continue;
            }
            let key = NodeKey::of(child);
            match self.tables.node_symbol.get(&key).copied() {
                Some(id) => {
                    let name = record_name(self.tables, module, id);
                    if targets.contains(&id) {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            format!("duplicate invocation target '{name}'"),
                            tight_span(text, child),
                        ));
                        bad = true;
                        continue;
                    }
                    match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::Scenario { trusted, .. } => {
                            if *trusted {
                                self.diags.push(Diagnostic::error(
                                    "E3009",
                                    format!(
                                        "invocation target '{name}' is a trusted handler, not a user mutation"
                                    ),
                                    tight_span(text, child),
                                ));
                                bad = true;
                            } else if self.read_scenarios.contains(&id) {
                                self.diags.push(Diagnostic::error(
                                    "E3009",
                                    format!(
                                        "invocation target '{name}' is a read scenario, not a user mutation"
                                    ),
                                    tight_span(text, child),
                                ));
                                bad = true;
                            } else {
                                targets.push(id);
                            }
                        }
                        SymbolKind::CrudOp { model, op } => {
                            if self.crud_op_enabled(*model, *op) {
                                targets.push(id);
                            } else {
                                self.diags.push(Diagnostic::error(
                                    "E3009",
                                    format!(
                                        "invocation target '{name}' is not an enabled operation"
                                    ),
                                    tight_span(text, child),
                                ));
                                bad = true;
                            }
                        }
                        _ => {
                            self.diags.push(Diagnostic::error(
                                "E3009",
                                format!(
                                    "invocation target '{name}' is not a canonical user mutation (scenario or Model.create/update/delete)"
                                ),
                                tight_span(text, child),
                            ));
                            bad = true;
                        }
                    }
                }
                None => {
                    // Resolver diagnosed (`E2001`/`E2013`).
                    bad = true;
                }
            }
        }
        if bad || targets.is_empty() {
            ResolvedType::Error
        } else {
            ResolvedType::Invocation { targets }
        }
    }

    /// Resolve a `DeliveryType`: the single target must be a resolved
    /// bound capability operation or bound exported user operation.
    /// Anything else is `E3010`; external bindings stay opaque.
    fn resolve_delivery(
        &mut self,
        _file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> ResolvedType {
        let paths: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| n.kind == SyntaxKind::Path)
            .copied()
            .collect();
        if paths.len() != 1 {
            self.diags.push(Diagnostic::error(
                "E3010",
                "delivery() names one bound operation".to_string(),
                tight_span(text, node),
            ));
            return ResolvedType::Error;
        }
        let path = paths[0];
        let segments = path_segments(path, text);
        if segments.is_empty() {
            return ResolvedType::Error;
        }
        let scopes = &self.tables.module_scopes[module.0 as usize];
        match scopes.prod.get(segments[0]).cloned() {
            Some(super::resolve::ScopedName::Imported { target, bound }) => {
                if !bound {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!(
                            "delivery target '{}' is not bound; delivery() names a bound operation (use … from=deployment.NAME)",
                            segments.join(".")
                        ),
                        tight_span(text, path),
                    ));
                    return ResolvedType::Error;
                }
                let op = self.op_at_path(target, &segments[1..]);
                match op {
                    Some(id) => match &self.tables.symbols[id.0 as usize].kind {
                        SymbolKind::Scenario { .. } | SymbolKind::CapabilityOp { .. } => {
                            ResolvedType::Delivery { op: id }
                        }
                        _ => {
                            self.diags.push(Diagnostic::error(
                                "E3010",
                                format!(
                                    "delivery target '{}' is not a capability operation or user operation",
                                    segments.join(".")
                                ),
                                tight_span(text, path),
                            ));
                            ResolvedType::Error
                        }
                    },
                    None => ResolvedType::Error,
                }
            }
            Some(super::resolve::ScopedName::Local(_)) => {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!(
                        "delivery target '{}' is local; delivery() names a bound operation (use … from=deployment.NAME)",
                        segments.join(".")
                    ),
                    tight_span(text, path),
                ));
                ResolvedType::Error
            }
            Some(super::resolve::ScopedName::External { provider, name }) => {
                // T14c: a `delivery()` over a T13-known `std`
                // operation is a typed external receipt naming its
                // target; an unknown operation of a known capability
                // stays a wrong association (`E3010`, T14a); anything
                // without a consumed schema stays opaque.
                if provider == "std"
                    && segments.len() == 2
                    && let Some(cap) = std_capability(&name)
                {
                    match cap.operations.iter().find(|o| o.name == segments[1]) {
                        Some(op) => {
                            return ResolvedType::StdDelivery {
                                capability: cap.name,
                                op,
                            };
                        }
                        None => {
                            self.diags.push(Diagnostic::error(
                                "E3010",
                                format!(
                                    "'{}' has no sendable operation '{}'; delivery() names a sendable bound operation",
                                    cap.name, segments[1]
                                ),
                                tight_span(text, path),
                            ));
                            return ResolvedType::Error;
                        }
                    }
                }
                ResolvedType::Opaque("external delivery target")
            }
            None => {
                // Resolver diagnosed (`E2001`/`E2013`).
                ResolvedType::Error
            }
        }
    }

    /// Navigate from an imported head through capability-op segments.
    fn op_at_path(&self, head: SymbolId, segments: &[&str]) -> Option<SymbolId> {
        if segments.is_empty() {
            return Some(head);
        }
        if segments.len() != 1 {
            return None;
        }
        match &self.tables.symbols[head.0 as usize].kind {
            SymbolKind::Capability { ops, .. } => ops.iter().find_map(|id| {
                (self.tables.symbols[id.0 as usize].name == segments[0]).then_some(*id)
            }),
            _ => None,
        }
    }
}

/// Byte span of the `i`-th segment of a `Path` node.
fn segment_span(node: &SyntaxNode, index: usize) -> Span {
    let names: Vec<&SyntaxNode> = node
        .children
        .iter()
        .filter(|c| c.kind == SyntaxKind::Name)
        .collect();
    names.get(index).map(|n| n.span).unwrap_or(node.span)
}

impl<'a> Typer<'a> {
    // --- Expressions ---------------------------------------------------

    /// Type one expression node. Nodes the resolver did not walk (absent
    /// from `expr_scope`) are PR5/error positions: silent `Error`.
    /// `expect` threads the expected type inward for enum-case claiming
    /// and string-literal inhabitation.
    fn expr(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<ResolvedType>,
    ) -> ResolvedType {
        if has_error(node) {
            return ResolvedType::Error;
        }
        if !self.tables.expr_scope.contains_key(&NodeKey::of(node)) {
            return ResolvedType::Error;
        }
        let ty = match node.kind {
            SyntaxKind::Literal => self.type_literal(cx, node, expect.as_ref()),
            SyntaxKind::MessageValue => ResolvedType::Scalar(Scalar::Text),
            SyntaxKind::NameRef => self.type_nameref(cx, node, expect.as_ref()),
            SyntaxKind::Member => self.type_member(cx, node),
            SyntaxKind::Call => self.type_call(cx, node),
            SyntaxKind::Binary => self.type_binary(cx, node),
            SyntaxKind::Unary => self.type_unary(cx, node, expect.as_ref()),
            SyntaxKind::Group => kids(node)
                .iter()
                .find(|n| is_expression(n.kind))
                .map(|n| self.expr(cx, n, expect))
                .unwrap_or(ResolvedType::Error),
            SyntaxKind::Array => self.type_array(cx, node, expect.as_ref()),
            SyntaxKind::Object => self.type_object(cx, node, expect.as_ref(), true),
            SyntaxKind::Construct => self.type_construct(cx, node),
            SyntaxKind::Query => self.type_query(cx, node),
            SyntaxKind::Path => self.type_path_value(cx, node),
            _ => ResolvedType::Error,
        };
        self.record(node, ty.clone());
        ty
    }

    /// Whether `actual` fits `expected` (`E3001` otherwise). `Error`
    /// actuals, `Opaque` on either side and `Unknown` on either side
    /// unify silently. Returns compatibility only; callers keep the
    /// recorded value type.
    fn assign_ok(
        &mut self,
        cx: &Ctx<'_, '_>,
        span: Span,
        actual: &ResolvedType,
        expected: &ResolvedType,
        what: &str,
    ) -> bool {
        if actual.is_error()
            || matches!(actual, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(expected, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(expected, ResolvedType::Error)
        {
            return true;
        }
        if self.types_compatible(actual, expected) {
            return true;
        }
        if cx.strict {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "{what}: expected {}, found {}",
                    self.show(cx.module, expected),
                    self.show(cx.module, actual)
                ),
                span,
            ));
        }
        false
    }

    /// Structural compatibility for assignment (both sides concrete).
    fn types_compatible(&self, actual: &ResolvedType, expected: &ResolvedType) -> bool {
        match (actual, expected) {
            (ResolvedType::Null, ResolvedType::Nullable(_)) => true,
            (ResolvedType::Nullable(a), ResolvedType::Nullable(b)) => self.types_compatible(a, b),
            (_, ResolvedType::Nullable(b)) => self.types_compatible(actual, b),
            (ResolvedType::Scalar(a), ResolvedType::Scalar(b)) => a == b,
            (ResolvedType::Team, ResolvedType::Team)
            | (ResolvedType::OperationContext, ResolvedType::OperationContext) => true,
            (
                ResolvedType::Enum {
                    cases: ac,
                    owner: ao,
                },
                ResolvedType::Enum {
                    cases: bc,
                    owner: bo,
                },
            ) => ao == bo && (ao.is_some() || ac == bc),
            (
                ResolvedType::Record {
                    symbol: a,
                    stored: sa,
                },
                ResolvedType::Record {
                    symbol: b,
                    stored: sb,
                },
            ) => {
                if a != b {
                    return false;
                }
                // Detached constructs cannot stand in for stored model
                // rows (no id/version); contracts/events are values.
                if *sb && !*sa {
                    return !matches!(
                        self.tables.symbols[a.0 as usize].kind,
                        SymbolKind::Model { .. }
                    );
                }
                true
            }
            (ResolvedType::Message(a), ResolvedType::Message(b)) => a == b,
            (
                ResolvedType::Action {
                    targets: a,
                    external: ae,
                    ..
                },
                ResolvedType::Action {
                    targets: b,
                    external: be,
                    ..
                },
            ) => a.iter().all(|t| b.contains(t)) && ae.iter().all(|t| be.contains(t)),
            (ResolvedType::Invocation { targets: a }, ResolvedType::Invocation { targets: b }) => {
                a.iter().all(|t| b.contains(t))
            }
            (ResolvedType::Delivery { op: a }, ResolvedType::Delivery { op: b }) => a == b,
            // T14c: same-target std receipts associate; cross-target
            // ones (including local-vs-std, which falls to `_`) are
            // wrong associations and incompatible.
            (
                ResolvedType::StdDelivery {
                    capability: ac,
                    op: ao,
                },
                ResolvedType::StdDelivery {
                    capability: bc,
                    op: bo,
                },
            ) => ac == bc && ao.name == bo.name,
            (ResolvedType::Array { element: a, .. }, ResolvedType::Array { element: b, .. }) => {
                self.types_compatible(a, b)
            }
            (ResolvedType::Union(a), ResolvedType::Union(b)) => a.iter().all(|t| b.contains(t)),
            (ResolvedType::Record { symbol: a, .. }, ResolvedType::Union(b)) => b.contains(a),
            (ResolvedType::Object(a), ResolvedType::Object(b)) => b.iter().all(|(k, t)| {
                a.iter()
                    .find(|(ak, _)| ak == k)
                    .is_some_and(|(_, at)| self.types_compatible(at, t))
            }),
            (ResolvedType::Operation(a), ResolvedType::Operation(b)) => a == b,
            _ => false,
        }
    }

    /// Whether `actual` fits a `bool` slot (`E3007` otherwise).
    fn expect_bool(&mut self, cx: &Ctx<'_, '_>, span: Span, actual: &ResolvedType, what: &str) {
        match actual {
            ResolvedType::Scalar(Scalar::Bool)
            | ResolvedType::Error
            | ResolvedType::Opaque(_)
            | ResolvedType::Unknown => {}
            other => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3007",
                        format!(
                            "{what} must be bool, found {} (no implicit truthiness)",
                            self.show(cx.module, other)
                        ),
                        span,
                    ));
                }
            }
        }
    }

    /// Type a `Literal` node: leaf kind plus range checks (int64,
    /// decimal 38/18, duration/bytes magnitude). A `String` literal
    /// inhabits an expected validated string-like type after shape
    /// validation; anything else against a validated expectation is
    /// `E3001` at the use site.
    fn type_literal(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
        let Some((leaf, slice)) = literal_leaf(node, cx.text) else {
            return ResolvedType::Error;
        };
        match leaf {
            SyntaxKind::Integer => {
                // R16/T11: an integral spelling inhabits a uniquely-decimal
                // expectation exactly (DESIGN L165 precedent for validated
                // strings below): bigint coef at scale 0, no Number routing
                // and no int64 narrowing — decimals hold 38 digits (values
                // `decimalFromInteger`). Only this literal arm (plus `-` and
                // groups forwarding the expectation) inhabits decimal, so
                // int-typed variables and computed values never coerce.
                if expect.is_some_and(decimal_expectation) {
                    if cx.strict
                        && let Some(problem) = integral_decimal_range(slice)
                    {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!("integer literal `{slice}` {problem}"),
                            tight_span(cx.text, node),
                        ));
                        return ResolvedType::Error;
                    }
                    return ResolvedType::Scalar(Scalar::Decimal);
                }
                if cx.strict && slice.parse::<i64>().is_err() {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("integer literal `{slice}` overflows int64"),
                        tight_span(cx.text, node),
                    ));
                    return ResolvedType::Error;
                }
                ResolvedType::Scalar(Scalar::Int)
            }
            SyntaxKind::Decimal => {
                if cx.strict
                    && let Some(problem) = decimal_range(slice)
                {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("decimal literal `{slice}` {problem}"),
                        tight_span(cx.text, node),
                    ));
                    return ResolvedType::Error;
                }
                ResolvedType::Scalar(Scalar::Decimal)
            }
            SyntaxKind::Duration => {
                if cx.strict && duration_millis(slice).is_none() {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("duration literal `{slice}` overflows int64 milliseconds"),
                        tight_span(cx.text, node),
                    ));
                    return ResolvedType::Error;
                }
                ResolvedType::Scalar(Scalar::Duration)
            }
            SyntaxKind::Bytes => {
                if cx.strict && bytes_count(slice).is_none() {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("byte literal `{slice}` overflows int64 bytes"),
                        tight_span(cx.text, node),
                    ));
                    return ResolvedType::Error;
                }
                ResolvedType::Scalar(Scalar::Bytes)
            }
            SyntaxKind::String => {
                let Some(value) = string_literal_value(node) else {
                    return ResolvedType::Error;
                };
                if let Some(expected) = expect {
                    let unwrapped = match expected {
                        ResolvedType::Nullable(inner) => inner.as_ref(),
                        other => other,
                    };
                    if let ResolvedType::Scalar(s) = unwrapped
                        && s.is_string_like()
                        && *s != Scalar::Text
                    {
                        if cx.strict
                            && let Some(problem) = validated_shape(*s, &value)
                        {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                format!("`{value}` is not a valid {}: {problem}", s.as_str()),
                                tight_span(cx.text, node),
                            ));
                            return ResolvedType::Error;
                        }
                        return ResolvedType::Scalar(*s);
                    }
                }
                ResolvedType::Scalar(Scalar::Text)
            }
            SyntaxKind::Name => match slice {
                "true" | "false" => ResolvedType::Scalar(Scalar::Bool),
                "null" => ResolvedType::Null,
                _ => ResolvedType::Error,
            },
            _ => ResolvedType::Error,
        }
    }

    /// Type a `NameRef`: lexical bindings first (a bound name never
    /// becomes an enum case); otherwise claim an unbound name as a
    /// case of a uniquely expected enum type, resolve module names to
    /// `E3001` (packages are not values), and leave the rest for pass
    /// 2 `E2001` (typed `Error` for cascade suppression).
    fn type_nameref(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
        let key = NodeKey::of(node);
        if let Some(Binding::CohortChild { model, .. }) = self.tables.node_binding.get(&key) {
            self.types.cohort_child_references.insert(key, *model);
        }
        if let Some(Binding::Symbol(id)) = self.tables.node_binding.get(&key)
            && matches!(self.tables.symbols[id.0 as usize].kind, SymbolKind::Role)
        {
            self.types.role_references.insert(key, *id);
        }
        // Narrowed root (continuation fact on the resolved
        // declaration, T03 §6).
        if let Some(name) = kids(node).iter().find_map(|n| name_text(n, cx.text)) {
            let key = NodeKey::of(node);
            let decl = self
                .tables
                .node_binding
                .get(&key)
                .map(|binding| decl_key_of_binding(binding, name))
                .unwrap_or_else(|| DeclKey::Unresolved(name.to_string()));
            if let Some(narrowed) = cx.narrow.get(&NarrowKey {
                decl,
                path: Vec::new(),
            }) {
                return narrowed.clone();
            }
        }
        let key = NodeKey::of(node);
        if let Some(binding) = self.tables.node_binding.get(&key).cloned() {
            // A bare builtin is never a value — except under a unique
            // expected enum type carrying that spelling, where it
            // denotes the case. DESIGN §3 lists lexical names
            // (parameters, lets, aliases, imports, fixed context) without
            // builtins, and treats builtins separately as callable names
            // (§3: authored locals may hide them); only a true lexical
            // binding blocks elision. This rescues otherwise-error
            // programs (the flagship filter names a case `all`) and
            // changes no well-typed meaning.
            if let Binding::Builtin { id } = &binding
                && let Some(expected) = expect
                && let ResolvedType::Enum { cases, .. } = enum_expectation(expected)
                && cases.iter().any(|c| c == id)
            {
                self.types.resolved_cases.insert(key);
                return expected.clone();
            }
            return self.type_binding(cx, node, &binding);
        }
        // Unbound: enum-case claiming under a unique expectation.
        if let Some(name) = kids(node).iter().find_map(|n| name_text(n, cx.text)) {
            if let Some(expected) = expect
                && let ResolvedType::Enum { cases, .. } = enum_expectation(expected)
                && cases.iter().any(|c| c == name)
            {
                self.types.resolved_cases.insert(key);
                return expected.clone();
            }
            if self.tables.module_by_name.contains_key(name) {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("package '{name}' is not a value"),
                        tight_span(cx.text, node),
                    ));
                }
                return ResolvedType::Error;
            }
        }
        ResolvedType::Error
    }

    /// Type one resolved lexical binding as a value.
    fn type_binding(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        binding: &Binding,
    ) -> ResolvedType {
        match binding {
            Binding::Error => ResolvedType::Error,
            Binding::Predicate => ResolvedType::Scalar(Scalar::Bool),
            Binding::External { .. } => ResolvedType::Opaque("external import"),
            Binding::Builtin { id } => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("builtin '{id}' is not a value; call it with arguments"),
                        tight_span(cx.text, node),
                    ));
                }
                ResolvedType::Error
            }
            Binding::Symbol(id) => self.symbol_value_type(cx, node, *id),
            Binding::CohortChild { model, .. } => {
                self.types
                    .cohort_child_references
                    .insert(NodeKey::of(node), *model);
                ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                }
            }
            Binding::Let { node: key } => {
                self.lets.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            Binding::ForItem { node: key } => {
                self.fors.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            Binding::QueryAlias { node: key } => self
                .aliases
                .get(key)
                .cloned()
                .unwrap_or(ResolvedType::Error),
            Binding::CreateAs { node: key } => self
                .creates
                .get(key)
                .cloned()
                .unwrap_or(ResolvedType::Error),
            Binding::CallAs { node: key } => {
                self.calls.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            Binding::SendAs { node: key } => {
                self.sends.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            Binding::RouteParam { node: key } => {
                self.routes.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            Binding::Context(var) => self.context_type(cx, node, var),
        }
    }

    /// Value type of a symbol reference. Models denote their record
    /// collection; contracts/events/capabilities/derived functions are
    /// not values (`E3001`); roles are bools; operations are opaque
    /// references PR5 interprets.
    fn symbol_value_type(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: SymbolId,
    ) -> ResolvedType {
        let symbol = &self.tables.symbols[id.0 as usize];
        match &symbol.kind {
            SymbolKind::Model { .. } => ResolvedType::Array {
                element: Box::new(ResolvedType::Record {
                    symbol: id,
                    stored: true,
                }),
                ordered: true,
                nonempty: false,
            },
            SymbolKind::Contract { .. } | SymbolKind::Event { .. } => {
                if cx.strict {
                    let kind = if matches!(symbol.kind, SymbolKind::Contract { .. }) {
                        "contract"
                    } else {
                        "event"
                    };
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "{} '{}' is not a value; construct one with {} {{…}}",
                            kind,
                            record_name(self.tables, cx.module, id),
                            record_name(self.tables, cx.module, id),
                        ),
                        tight_span(cx.text, node),
                    ));
                }
                ResolvedType::Error
            }
            SymbolKind::Role => ResolvedType::Scalar(Scalar::Bool),
            SymbolKind::Message { .. } => ResolvedType::Message(id),
            SymbolKind::Scenario { .. }
            | SymbolKind::CapabilityOp { .. }
            | SymbolKind::CrudOp { .. } => ResolvedType::Operation(id),
            SymbolKind::Field { .. }
            | SymbolKind::Param { .. }
            | SymbolKind::DeriveField { .. } => self.decl_type(id),
            SymbolKind::Fixture { target } => match target {
                FixtureTarget::Model(model) => ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                },
                FixtureTarget::User => ResolvedType::Scalar(Scalar::User),
                FixtureTarget::File => ResolvedType::Scalar(Scalar::File),
                FixtureTarget::Operation(_) => ResolvedType::Opaque("operation fixture"),
                FixtureTarget::Unknown => ResolvedType::Error,
            },
            SymbolKind::DeriveFn { .. } => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "derived function '{}' is not a value; call it with arguments",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
                ResolvedType::Error
            }
            _ => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "'{}' is not a value in this position",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
                ResolvedType::Error
            }
        }
    }

    /// Value type of a contextual fact.
    fn context_type(
        &mut self,
        _cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        var: &ContextVar,
    ) -> ResolvedType {
        match var {
            ContextVar::Actor(kind) => match kind {
                ActorKind::Nullable => {
                    ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::User)))
                }
                ActorKind::NonNull => ResolvedType::Scalar(Scalar::User),
                ActorKind::Null => ResolvedType::Null,
            },
            ContextVar::Team => ResolvedType::Team,
            ContextVar::Now => ResolvedType::Scalar(Scalar::Datetime),
            ContextVar::Operation => ResolvedType::OperationContext,
            ContextVar::Event => ResolvedType::Opaque("trusted event payload"),
            ContextVar::RowModel(model) => ResolvedType::Record {
                symbol: *model,
                stored: true,
            },
            ContextVar::RowQuery { node: key } => {
                self.rows.get(key).cloned().unwrap_or(ResolvedType::Error)
            }
            ContextVar::Parent { model } => ResolvedType::Record {
                symbol: *model,
                stored: true,
            },
            ContextVar::Preferences { module } => match self.prefs.get(module) {
                Some(prefs) => ResolvedType::Record {
                    symbol: *prefs,
                    stored: true,
                },
                None => ResolvedType::Error,
            },
            ContextVar::Result { scenario, crud_op } => {
                if let Some(id) = scenario {
                    match self.results.get(id).cloned() {
                        Some(Some(ty)) => ty,
                        // Void scenario results and missing entries
                        // are PR5 UI-shape territory; stay silent.
                        Some(None) | None => ResolvedType::Opaque("void operation result"),
                    }
                } else if crud_op.is_some() {
                    // Generated CRUD results are schematized in PR5.
                    ResolvedType::Opaque("generated crud result")
                } else {
                    let _ = node;
                    ResolvedType::Error
                }
            }
            ContextVar::TestAccount(_) => ResolvedType::Scalar(Scalar::User),
        }
    }

    /// Type a `Member` node: model/capability symbol receivers resolve
    /// operations; otherwise the receiver type drives lookup. `.`
    /// needs a non-null receiver (`E3003`); `?.` wraps the field type
    /// nullable without nesting.
    fn type_member(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let parts = kids(node);
        if parts.len() < 3 {
            return ResolvedType::Error;
        }
        let (receiver, punct, name_node) = (parts[0], parts[1], parts[2]);
        let safe = is_punct(punct, cx.text, "?.");
        let Some(name) = name_text(name_node, cx.text) else {
            return ResolvedType::Error;
        };
        // Narrowed chain (safe-access/`is` continuation): the whole
        // chain proven a type is that type; otherwise a narrowed
        // receiver steps normally (plain `.` is sound on it).
        if let Some(narrowed) = self.narrowed_chain(cx, node) {
            return narrowed;
        }
        if let Some(narrowed) = self.narrowed_chain(cx, receiver) {
            return self.member_on(cx, node, name_node, name, &narrowed, safe);
        }
        // Model/capability symbol receivers (operations, not fields).
        if let Some(id) = self.symbol_receiver(cx, receiver) {
            let symbol = &self.tables.symbols[id.0 as usize];
            match &symbol.kind {
                SymbolKind::Model { .. } => {
                    return self.model_member(cx, node, name_node, id, name);
                }
                SymbolKind::Capability { ops, .. } => {
                    let ops = ops.clone();
                    for op in ops {
                        if self.tables.symbols[op.0 as usize].name == name {
                            return ResolvedType::Operation(op);
                        }
                    }
                    if cx.strict {
                        self.member_fail(
                            node,
                            name_node.span,
                            format!("capability {}", record_name(self.tables, cx.module, id)),
                            name.to_string(),
                        );
                    }
                    return ResolvedType::Error;
                }
                _ => {}
            }
        }
        // Hook payload sides (T30/C6): `event.after`/`event.before`
        // in a pre-commit hook carry the hooked model's record. The
        // receiver must resolve to the handler context `event`, never
        // merely spell it.
        if (name == "after" || name == "before")
            && let Some(side) = self.hook_payload_side(name)
            && receiver.kind == SyntaxKind::NameRef
            && let Some(Binding::Context(ContextVar::Event)) =
                self.tables.node_binding.get(&NodeKey::of(receiver))
        {
            return side;
        }
        let base = self.expr(cx, receiver, None);
        self.member_on(cx, node, name_node, name, &base, safe)
    }

    /// Member lookup on an already-typed receiver.
    fn member_on(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        base: &ResolvedType,
        safe: bool,
    ) -> ResolvedType {
        let (inner, was_nullable) = match base {
            ResolvedType::Nullable(inner) => (inner.as_ref().clone(), true),
            other => (other.clone(), false),
        };
        if was_nullable && !safe {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3003",
                    format!(
                        "receiver is {}; use `?.` or narrow it before `.`",
                        self.show(cx.module, base)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        }
        if matches!(inner, ResolvedType::Null) {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3003",
                    format!("cannot access member '{name}' of null"),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        }
        let found = self.member_lookup(cx, node, name_node, name, &inner);
        match found {
            None => ResolvedType::Error,
            Some(ty) => {
                if was_nullable {
                    match ty {
                        ResolvedType::Nullable(_) => ty,
                        ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => ty,
                        other => ResolvedType::Nullable(Box::new(other)),
                    }
                } else {
                    ty
                }
            }
        }
    }

    /// Look one member up on a non-null receiver type (`E2013` on
    /// failure, `None`; opaque/error propagate silently).
    fn member_lookup(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        base: &ResolvedType,
    ) -> Option<ResolvedType> {
        match base {
            ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => {
                Some(base.clone())
            }
            ResolvedType::Record { symbol, stored } => {
                self.record_member(cx, node, name_node, name, *symbol, *stored)
            }
            ResolvedType::Scalar(Scalar::Money) => match name {
                "minor" => Some(ResolvedType::Scalar(Scalar::Int)),
                "currency" => Some(ResolvedType::Scalar(Scalar::Currency)),
                _ => {
                    self.unknown_member(cx, node, name_node, name, "money");
                    None
                }
            },
            ResolvedType::Scalar(Scalar::User) => match name {
                "id" => Some(ResolvedType::Scalar(Scalar::Text)),
                "email" | "email_verified" => {
                    if self.is_actor_root(cx, node) {
                        Some(match name {
                            "email" => ResolvedType::Scalar(Scalar::Email),
                            _ => ResolvedType::Scalar(Scalar::Bool),
                        })
                    } else {
                        if cx.strict {
                            self.member_fail(
                                node,
                                name_node.span,
                                "user".to_string(),
                                format!("{name} (only actor.{name} is readable)"),
                            );
                        }
                        None
                    }
                }
                _ => {
                    self.unknown_member(cx, node, name_node, name, "user");
                    None
                }
            },
            ResolvedType::Scalar(Scalar::Member) => match name {
                "id" => Some(ResolvedType::Scalar(Scalar::Text)),
                "user" => Some(ResolvedType::Scalar(Scalar::User)),
                "team" => Some(ResolvedType::Team),
                _ => {
                    self.unknown_member(cx, node, name_node, name, "member");
                    None
                }
            },
            ResolvedType::Team => match name {
                "id" => Some(ResolvedType::Scalar(Scalar::Text)),
                "timezone" => Some(ResolvedType::Scalar(Scalar::Timezone)),
                _ => {
                    self.unknown_member(cx, node, name_node, name, "team");
                    None
                }
            },
            ResolvedType::OperationContext => match name {
                "id" | "source" => Some(ResolvedType::Scalar(Scalar::Text)),
                _ => {
                    self.unknown_member(cx, node, name_node, name, "operation");
                    None
                }
            },
            ResolvedType::Scalar(other) => {
                self.unknown_member(cx, node, name_node, name, other.as_str());
                None
            }
            ResolvedType::Array { .. } => {
                self.unknown_member(cx, node, name_node, name, "array");
                None
            }
            ResolvedType::Union(arms) => self.union_member(cx, node, name_node, name, arms),
            ResolvedType::Object(fields) => match fields.iter().find(|(k, _)| k == name) {
                Some((_, ty)) => Some(ty.clone()),
                None => {
                    self.unknown_member(cx, node, name_node, name, "object");
                    None
                }
            },
            ResolvedType::Delivery { op } => {
                let op = *op;
                match name {
                    "id" => Some(ResolvedType::Scalar(Scalar::Text)),
                    "status" => Some(ResolvedType::Opaque("delivery status")),
                    "error" => Some(ResolvedType::Opaque("delivery error")),
                    "result" => Some(match self.results.get(&op).cloned() {
                        Some(Some(ty)) => ResolvedType::Nullable(Box::new(ty)),
                        Some(None) | None => ResolvedType::Null,
                    }),
                    _ => {
                        self.unknown_member(
                            cx,
                            node,
                            name_node,
                            name,
                            &format!("delivery({})", record_name(self.tables, cx.module, op)),
                        );
                        None
                    }
                }
            }
            ResolvedType::StdDelivery { capability, op } => {
                let (capability, op) = (*capability, *op);
                match name {
                    "id" => Some(ResolvedType::Scalar(Scalar::Text)),
                    "status" => Some(ResolvedType::Opaque("delivery status")),
                    "error" => Some(ResolvedType::Opaque("delivery error")),
                    // T14d: `attempt.result` types against the
                    // consumed owner result shape (DESIGN §8.1:
                    // `result:R?` is the only nominal-typed leaf).
                    // Scalar/enum results reuse the existing
                    // vocabulary; transcribed T13c nominals resolve
                    // to their closed field object; unknown/absent
                    // nominals stay opaque, never guessed.
                    "result" => Some(std_delivery_result_type(op)),
                    "progress"
                        if delivery_progress_alias(&ResolvedType::StdDelivery {
                            capability,
                            op,
                        }) =>
                    {
                        Some(std_delivery_result_type(op))
                    }
                    _ => {
                        self.unknown_member(
                            cx,
                            node,
                            name_node,
                            name,
                            &format!("delivery({capability}.{})", op.name),
                        );
                        None
                    }
                }
            }
            other => {
                let base_name = self.show(cx.module, other);
                self.unknown_member(cx, node, name_node, name, &base_name);
                None
            }
        }
    }

    /// Record field or reserved metadata lookup.
    fn record_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        symbol: SymbolId,
        stored: bool,
    ) -> Option<ResolvedType> {
        self.record_member_at_span(cx, node, name_node.span, name, symbol, stored)
    }

    /// [`Typer::record_member`] with an explicit member span, shared by
    /// expression `Member` lookup and `set`/`delete` path targets so
    /// both positions resolve identically (declared fields, reserved
    /// members, contained-model `parent`, child collections).
    fn record_member_at_span(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        span: Span,
        name: &str,
        symbol: SymbolId,
        stored: bool,
    ) -> Option<ResolvedType> {
        let record = &self.tables.symbols[symbol.0 as usize];
        if let Some(field) = record
            .fields_of()
            .iter()
            .find(|f| self.tables.symbols[f.0 as usize].name == name)
            .copied()
        {
            return Some(self.decl_type(field));
        }
        let is_model = matches!(record.kind, SymbolKind::Model { .. });
        if is_model
            && stored
            && let Some(ty) = reserved_member_type(name)
        {
            return Some(ty);
        }
        if is_model {
            // `row.parent` on a contained model is its required
            // containing record (DESIGN §2/§4); `parentRecord.Child`
            // is the typed child collection (default record ordering).
            if name == "parent"
                && let Some(parent) = contained_parent_of(self.tables, symbol)
            {
                return Some(ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                });
            }
            if let Some(children) = self.tables.children_of.get(&symbol)
                && let Some(child) = children
                    .iter()
                    .find(|c| self.tables.symbols[c.0 as usize].name == name)
                    .copied()
            {
                return Some(ResolvedType::Array {
                    element: Box::new(ResolvedType::Record {
                        symbol: child,
                        stored: true,
                    }),
                    ordered: true,
                    nonempty: false,
                });
            }
        }
        let kind = match record.kind {
            SymbolKind::Model { .. } => "model",
            SymbolKind::Contract { .. } => "contract",
            SymbolKind::Event { .. } => "event",
            SymbolKind::Preferences { .. } => "preferences",
            _ => "record",
        };
        self.unknown_member_at_span(
            cx,
            node,
            span,
            name,
            &format!("{kind} {}", record_name(self.tables, cx.module, symbol)),
        );
        None
    }

    /// Union member lookup: only common compatible fields read directly.
    fn union_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        arms: &[SymbolId],
    ) -> Option<ResolvedType> {
        let mut common: Option<ResolvedType> = None;
        for arm in arms {
            let record = &self.tables.symbols[arm.0 as usize];
            let field = record
                .fields_of()
                .iter()
                .find(|f| self.tables.symbols[f.0 as usize].name == *name)
                .copied();
            let Some(field) = field else {
                common = None;
                break;
            };
            let ty = self.decl_type(field);
            match common.take() {
                None => common = Some(ty),
                Some(prev) => {
                    // Compatible bases unify; nullability unions.
                    let (pa, na) = strip_nullable(&prev);
                    let (pb, nb) = strip_nullable(&ty);
                    if pa == pb {
                        let merged = if na || nb {
                            ResolvedType::Nullable(Box::new(pa.clone()))
                        } else {
                            pa.clone()
                        };
                        common = Some(merged);
                    } else {
                        common = None;
                        break;
                    }
                }
            }
        }
        match common {
            Some(ty) if !ty.is_error() => Some(ty),
            _ => {
                let arms_name = arms
                    .iter()
                    .map(|a| record_name(self.tables, cx.module, *a))
                    .collect::<Vec<_>>()
                    .join("|");
                self.unknown_member(cx, node, name_node, name, &format!("union {arms_name}"));
                None
            }
        }
    }

    /// Record an `E2013` in strict positions.
    fn unknown_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        base: &str,
    ) {
        self.unknown_member_at_span(cx, node, name_node.span, name, base);
    }

    /// [`Typer::unknown_member`] with an explicit member span (for paths).
    fn unknown_member_at_span(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        span: Span,
        name: &str,
        base: &str,
    ) {
        if cx.strict {
            self.member_fail(node, span, base.to_string(), name.to_string());
        }
    }

    /// `Model.op` member: an enabled generated CRUD operation, else
    /// `E2013` (mirrors the resolver's message for disabled/absent
    /// operations).
    fn model_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        model: SymbolId,
        name: &str,
    ) -> ResolvedType {
        let op = match name {
            "create" => CrudOp::Create,
            "update" => CrudOp::Update,
            "delete" => CrudOp::Delete,
            _ => {
                if cx.strict {
                    self.member_fail(
                        node,
                        name_node.span,
                        format!("model {}", record_name(self.tables, cx.module, model)),
                        name.to_string(),
                    );
                }
                return ResolvedType::Error;
            }
        };
        let canonical = format!(
            "{}.{}.{}",
            self.tables.modules[self.tables.symbols[model.0 as usize].module.0 as usize].name,
            self.tables.symbols[model.0 as usize].name,
            op.as_str()
        );
        match self.tables.by_canonical.get(&canonical).copied() {
            Some(id) => ResolvedType::Operation(id),
            None => {
                if cx.strict {
                    self.member_fail(
                        node,
                        name_node.span,
                        format!("model {}", record_name(self.tables, cx.module, model)),
                        format!("{name} (disabled or no crud declaration)"),
                    );
                }
                ResolvedType::Error
            }
        }
    }

    /// Bare-symbol receiver of a member chain (`Todo` in `Todo.create`,
    /// `Mail` in `Mail.send`), through groups.
    fn symbol_receiver(&self, _cx: &Ctx<'_, '_>, receiver: &SyntaxNode) -> Option<SymbolId> {
        let mut current = receiver;
        loop {
            match current.kind {
                SyntaxKind::NameRef => {
                    return match self.tables.node_binding.get(&NodeKey::of(current)) {
                        Some(Binding::Symbol(id)) => Some(*id),
                        _ => None,
                    };
                }
                SyntaxKind::Group => {
                    current = kids(current).iter().find(|n| is_expression(n.kind))?;
                }
                _ => return None,
            }
        }
    }

    /// Whether the root of a member chain is exactly the `actor`
    /// contextual fact (only `actor.email`/`actor.email_verified`
    /// read; `let`-aliases do not carry the privilege).
    fn is_actor_root(&self, _cx: &Ctx<'_, '_>, node: &SyntaxNode) -> bool {
        let mut current = node;
        loop {
            match current.kind {
                SyntaxKind::Member => {
                    let parts = kids(current);
                    if parts.is_empty() {
                        return false;
                    }
                    current = parts[0];
                }
                SyntaxKind::Group => {
                    let parts = kids(current);
                    let Some(inner) = parts.iter().find(|n| is_expression(n.kind)) else {
                        return false;
                    };
                    current = *inner;
                }
                SyntaxKind::NameRef => {
                    return matches!(
                        self.tables.node_binding.get(&NodeKey::of(current)),
                        Some(Binding::Context(ContextVar::Actor(_)))
                    );
                }
                _ => return false,
            }
        }
    }

    /// Narrowing key of a member chain: the resolved declaration
    /// behind the root plus root-outward hops (`None` for non-name
    /// roots only; unresolvable roots fall back to a spelling key
    /// that matches the `NameRef` lookup).
    fn narrow_key_for(&self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> Option<NarrowKey> {
        let root_node = chain_root(node)?;
        let name = kids(root_node).iter().find_map(|n| name_text(n, cx.text))?;
        let decl = self
            .tables
            .node_binding
            .get(&NodeKey::of(root_node))
            .map(|binding| decl_key_of_binding(binding, name))
            .unwrap_or_else(|| DeclKey::Unresolved(name.to_string()));
        let (_, mut path) = member_path(node, cx.text)?;
        path.reverse();
        Some(NarrowKey { decl, path })
    }

    /// Narrowed type of a member chain from the narrowing environment,
    /// if its resolved declaration+path was narrowed.
    fn narrowed_chain(&self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> Option<ResolvedType> {
        let key = self.narrow_key_for(cx, node)?;
        cx.narrow.get(&key).cloned()
    }

    /// Narrowed type of one resolved binding (for shorthand reads),
    /// if a continuation fact covers its declaration root.
    fn narrowed_binding(&self, cx: &Ctx<'_, '_>, binding: &Binding) -> Option<ResolvedType> {
        let decl = decl_key_of_binding(binding, "");
        if matches!(decl, DeclKey::Unresolved(_)) {
            return None;
        }
        cx.narrow
            .get(&NarrowKey {
                decl,
                path: Vec::new(),
            })
            .cloned()
    }

    /// Type a `Path` in value position (`set`/`delete` targets,
    /// `message=`/`title=` captions): head via the recorded scope,
    /// then member navigation. Unbound heads are pass-2 `E2001`.
    fn type_path_value(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let segments = path_segments(node, cx.text);
        if segments.is_empty() {
            return ResolvedType::Error;
        }
        let key = NodeKey::of(node);
        let scope = self.tables.expr_scope.get(&key).copied();
        let binding = scope.and_then(|s| self.tables.resolve_name(s, segments[0], self.catalog));
        let head_decl = binding
            .as_ref()
            .map(|binding| decl_key_of_binding(binding, segments[0]));
        let head_is_context_event = matches!(binding, Some(Binding::Context(ContextVar::Event)));
        let mut current = match binding {
            Some(Binding::Symbol(id)) => {
                // A bare model in a path target is its record, not its
                // collection (`set Todo` is nonsense the kind check
                // rejects with the record expectation message).
                match &self.tables.symbols[id.0 as usize].kind {
                    SymbolKind::Model { .. } => ResolvedType::Record {
                        symbol: id,
                        stored: true,
                    },
                    _ => self.symbol_value_type(cx, node, id),
                }
            }
            Some(other) => self.type_binding(cx, node, &other),
            None => {
                if self.tables.module_by_name.contains_key(segments[0]) {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!("package '{}' is not a value", segments[0]),
                            tight_span(cx.text, node),
                        ));
                    }
                    return ResolvedType::Error;
                }
                self.types.unresolved_names.push(key);
                return ResolvedType::Error;
            }
        };
        // A continuation fact on the head declaration (T03 §6) applies
        // to path targets exactly as to expressions (C5 set-targets).
        if let Some(decl) = head_decl.as_ref()
            && let Some(narrowed) = cx.narrow.get(&NarrowKey {
                decl: decl.clone(),
                path: Vec::new(),
            })
        {
            current = narrowed.clone();
        }
        let mut prefix: Vec<String> = Vec::new();
        for (i, segment) in segments.iter().enumerate().skip(1) {
            // Hook payload sides (T30/C6): `event.after`/`event.before`
            // in a pre-commit hook carry the hooked model's record.
            if i == 1
                && head_is_context_event
                && let Some(side) = self.hook_payload_side(segment)
            {
                current = side;
            } else {
                if let ResolvedType::Nullable(_) = &current {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3003",
                            format!(
                                "receiver is {}; path targets cannot use `?.` here",
                                self.show(cx.module, &current)
                            ),
                            tight_span(cx.text, node),
                        ));
                    }
                    return ResolvedType::Error;
                }
                let span = segment_span(node, i);
                match self.member_lookup_on_span(cx, node, span, segment, &current) {
                    Some(ty) => current = ty,
                    None => return ResolvedType::Error,
                }
            }
            // Facts on intermediate prefixes apply step by step.
            prefix.push((*segment).to_string());
            if let Some(decl) = head_decl.as_ref()
                && let Some(narrowed) = cx.narrow.get(&NarrowKey {
                    decl: decl.clone(),
                    path: prefix.clone(),
                })
            {
                current = narrowed.clone();
            }
        }
        current
    }

    /// [`Typer::member_lookup`] with an explicit member span (for paths).
    fn member_lookup_on_span(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        span: Span,
        name: &str,
        base: &ResolvedType,
    ) -> Option<ResolvedType> {
        match base {
            ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => {
                Some(base.clone())
            }
            // Shared with expression `Member` lookup: `set x.parent`
            // resolves exactly where `x.parent` reads (GRAMMAR:358
            // `mutation_target=path`); phantom members still `E2013`.
            ResolvedType::Record { symbol, stored } => {
                let (symbol, stored) = (*symbol, *stored);
                self.record_member_at_span(cx, node, span, name, symbol, stored)
            }
            _ => {
                let base_name = self.show(cx.module, base);
                if cx.strict {
                    self.member_fail(node, span, base_name, name.to_string());
                }
                None
            }
        }
    }
}

/// Strip one nullable layer, reporting whether it was present.
fn strip_nullable(ty: &ResolvedType) -> (ResolvedType, bool) {
    match ty {
        ResolvedType::Nullable(inner) => ((**inner).clone(), true),
        other => (other.clone(), false),
    }
}

/// Unwrap `Group` parentheses to the inner expression.
fn unwrap_groups(mut node: &SyntaxNode) -> &SyntaxNode {
    loop {
        if node.kind == SyntaxKind::Group
            && let Some(inner) = kids(node).iter().find(|n| is_expression(n.kind))
        {
            node = inner;
        } else {
            return node;
        }
    }
}

/// Root `NameRef` node of a member chain (through groups). `None`
/// for non-name roots.
fn chain_root(node: &SyntaxNode) -> Option<&SyntaxNode> {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::Member => {
                let parts = kids(current);
                if parts.len() < 3 {
                    return None;
                }
                current = parts[0];
            }
            SyntaxKind::Group => {
                current = kids(current).iter().find(|n| is_expression(n.kind))?;
            }
            SyntaxKind::NameRef => return Some(current),
            _ => return None,
        }
    }
}

/// Binding of the first `row` name reference under `node`,
/// skipping nested `Collection` subtrees (their rows shadow the
/// enclosing one). Used to seed timeline row declarations.
fn first_row_binding(node: &SyntaxNode, text: &str, tables: &ResolveTables) -> Option<Binding> {
    if node.kind == SyntaxKind::NameRef
        && kids(node)
            .iter()
            .find_map(|n| name_text(n, text))
            .is_some_and(|word| word == "row")
    {
        return tables.node_binding.get(&NodeKey::of(node)).cloned();
    }
    for child in &node.children {
        if child.kind == SyntaxKind::Collection {
            continue;
        }
        if let Some(binding) = first_row_binding(child, text, tables) {
            return Some(binding);
        }
    }
    None
}

/// Whether a member chain uses `?.` on any hop (such chains
/// re-evaluate and never carry a T03 §2 fact).
fn chain_has_safe(node: &SyntaxNode, text: &str) -> bool {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::Member => {
                let parts = kids(current);
                if parts.len() < 3 {
                    return false;
                }
                if is_punct(parts[1], text, "?.") {
                    return true;
                }
                current = parts[0];
            }
            SyntaxKind::Group => {
                let parts = kids(current);
                let Some(inner) = parts.iter().find(|n| is_expression(n.kind)) else {
                    return false;
                };
                current = inner;
            }
            _ => return false,
        }
    }
}

/// Root name plus member hops of a member chain (leaf-first), through
/// groups. `None` for non-name roots.
fn member_path(node: &SyntaxNode, text: &str) -> Option<(String, Vec<String>)> {
    let mut path = Vec::new();
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::Member => {
                let parts = kids(current);
                if parts.len() < 3 {
                    return None;
                }
                path.push(name_text(parts[2], text)?.to_string());
                current = parts[0];
            }
            SyntaxKind::Group => {
                current = kids(current).iter().find(|n| is_expression(n.kind))?;
            }
            SyntaxKind::NameRef => {
                let root = kids(current).iter().find_map(|n| name_text(n, text))?;
                return Some((root.to_string(), path));
            }
            _ => return None,
        }
    }
}

/// Unwrap an enum expectation through nullability.
fn enum_expectation(expect: &ResolvedType) -> ResolvedType {
    match expect {
        ResolvedType::Nullable(inner) => enum_expectation(inner),
        other => other.clone(),
    }
}

impl<'a> Typer<'a> {
    // --- Operators and narrowing ---------------------------------------

    /// Type a `Binary` node: the DESIGN §3 matrix (`E3002`), `in`
    /// membership, `is` tests (`E3018`), `??` (`E3004`), short-circuit
    /// `and`/`or` (`E3007` operands; T03 §3 threading: `and`-right
    /// receives left-true facts, `or`-right left-false facts).
    fn type_binary(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        // Continuations retain the operand expectation, typing order and
        // short-circuit environment without one native frame per operator.
        type SharedNarrow = std::rc::Rc<NarrowEnv>;
        enum Work<'n> {
            Eval(&'n SyntaxNode, Option<ResolvedType>, SharedNarrow),
            First(&'n SyntaxNode, SharedNarrow, bool),
            Second(&'n SyntaxNode, SharedNarrow, ResolvedType, bool),
        }
        let mut work = vec![Work::Eval(node, None, std::rc::Rc::new(cx.narrow.clone()))];
        let mut value = ResolvedType::Error;
        while let Some(step) = work.pop() {
            let (current, narrow) = match &step {
                Work::Eval(n, _, env) | Work::First(n, env, _) | Work::Second(n, env, _, _) => {
                    (*n, env.clone())
                }
            };
            let local = Ctx {
                module: cx.module,
                file: cx.file,
                text: cx.text,
                narrow: &narrow,
                strict: cx.strict,
                server_default: cx.server_default,
            };
            let parts = kids(current);
            let op = op_text(current, cx.text).unwrap_or("");
            match step {
                Work::Eval(current, expect, narrow) => {
                    if current.kind != SyntaxKind::Binary {
                        value = self.expr(&local, current, expect);
                        continue;
                    }
                    if has_error(current)
                        || !self.tables.expr_scope.contains_key(&NodeKey::of(current))
                    {
                        value = ResolvedType::Error;
                        continue;
                    }
                    if parts.len() != 3
                        || !matches!(
                            op,
                            "and"
                                | "or"
                                | "??"
                                | "is"
                                | "in"
                                | "=="
                                | "!="
                                | "<"
                                | "<="
                                | ">"
                                | ">="
                                | "+"
                                | "-"
                                | "*"
                                | "/"
                                | "%"
                        )
                    {
                        value = self.record(current, ResolvedType::Error);
                        continue;
                    }
                    let reverse = matches!(op, "==" | "!=")
                        && self.is_case_candidate(parts[0])
                        && !self.is_case_candidate(parts[2]);
                    let first = if reverse { parts[2] } else { parts[0] };
                    work.push(Work::First(current, narrow.clone(), reverse));
                    work.push(Work::Eval(first, None, narrow));
                }
                Work::First(current, narrow, reverse) => {
                    if op == "is" {
                        value = self.type_is(&local, current, parts[2], value);
                        self.record(current, value.clone());
                        continue;
                    }
                    let mut right_narrow = narrow.clone();
                    if matches!(op, "and" | "or") {
                        self.expect_bool(
                            &local,
                            tight_span(cx.text, parts[0]),
                            &value,
                            "`and`/`or` operand",
                        );
                        let mut extended = (*narrow).clone();
                        extended.extend(self.extract_narrow(&local, parts[0], op == "or"));
                        right_narrow = std::rc::Rc::new(extended);
                    }
                    let expect = match op {
                        "==" | "!=" => Some(value.clone()),
                        "in" if matches!(
                            value,
                            ResolvedType::Enum { .. } | ResolvedType::Nullable(_)
                        ) =>
                        {
                            Some(ResolvedType::Array {
                                element: Box::new(value.clone()),
                                ordered: false,
                                nonempty: false,
                            })
                        }
                        _ => None,
                    };
                    let second = if reverse { parts[0] } else { parts[2] };
                    work.push(Work::Second(current, narrow, value, reverse));
                    work.push(Work::Eval(second, expect, right_narrow));
                    value = ResolvedType::Error;
                }
                Work::Second(current, _, first, reverse) => {
                    let (left, right) = if reverse {
                        (value, first)
                    } else {
                        (first, value)
                    };
                    value = match op {
                        "and" | "or" => {
                            self.expect_bool(
                                &local,
                                tight_span(cx.text, parts[2]),
                                &right,
                                "`and`/`or` operand",
                            );
                            if left.is_error() || right.is_error() {
                                ResolvedType::Error
                            } else if matches!(
                                left,
                                ResolvedType::Opaque(_) | ResolvedType::Unknown
                            ) || matches!(
                                right,
                                ResolvedType::Opaque(_) | ResolvedType::Unknown
                            ) {
                                ResolvedType::Opaque("logical operand")
                            } else {
                                ResolvedType::Scalar(Scalar::Bool)
                            }
                        }
                        "??" => self.type_coalesce(&local, current, left, right),
                        "in" => self.type_in(&local, current, parts[0], &left, parts[2], &right),
                        "==" | "!=" => {
                            let (left, right) = self
                                .claim_comparison_sides(&local, parts[0], left, parts[2], right);
                            self.type_equality(&local, current, op, &left, &right)
                        }
                        "<" | "<=" | ">" | ">=" => {
                            self.type_ordering(&local, current, op, &left, &right)
                        }
                        "+" | "-" | "*" | "/" | "%" => {
                            self.type_arithmetic(&local, current, op, &left, &right)
                        }
                        _ => ResolvedType::Error,
                    };
                    self.record(current, value.clone());
                }
            }
        }
        value
    }

    /// Claim pass: when exactly one side of `==`/`!=`/`in` is an
    /// unclaimed unbound name and the other side is enum-typed, claim
    /// it (`draft==status` as well as `status==draft`).
    fn claim_comparison_sides(
        &mut self,
        cx: &Ctx<'_, '_>,
        left_node: &SyntaxNode,
        left: ResolvedType,
        right_node: &SyntaxNode,
        right: ResolvedType,
    ) -> (ResolvedType, ResolvedType) {
        let left_unclaimed = self.is_claimable_name(left_node) && left.is_error();
        let right_unclaimed = self.is_claimable_name(right_node) && right.is_error();
        if left_unclaimed && !right_unclaimed {
            if let ResolvedType::Enum { cases, .. } = enum_expectation(&right)
                && let Some(name) = kids(left_node).iter().find_map(|n| name_text(n, cx.text))
                && cases.iter().any(|c| c == name)
            {
                let key = NodeKey::of(left_node);
                self.types.resolved_cases.insert(key);
                self.types.node_types.insert(key, right.clone());
                return (right.clone(), right);
            }
        } else if right_unclaimed
            && !left_unclaimed
            && let ResolvedType::Enum { cases, .. } = enum_expectation(&left)
            && let Some(name) = kids(right_node).iter().find_map(|n| name_text(n, cx.text))
            && cases.iter().any(|c| c == name)
        {
            let key = NodeKey::of(right_node);
            self.types.resolved_cases.insert(key);
            self.types.node_types.insert(key, left.clone());
            return (left.clone(), left);
        }
        (left, right)
    }

    /// Whether `node` is an unbound `NameRef` (claimable, else `E2001`).
    fn is_claimable_name(&self, node: &SyntaxNode) -> bool {
        if node.kind != SyntaxKind::NameRef {
            return false;
        }
        let key = NodeKey::of(node);
        !self.tables.node_binding.contains_key(&key) && !self.types.resolved_cases.contains(&key)
    }

    /// Whether `node` is a bare name that could denote an enum case: a
    /// `NameRef` (through `Group` parentheses) with no lexical binding,
    /// or a builtin spelling (builtins are callable names, not lexical
    /// bindings, so they never block elision).
    fn is_case_candidate(&self, node: &SyntaxNode) -> bool {
        let mut current = node;
        loop {
            match current.kind {
                SyntaxKind::NameRef => {
                    return matches!(
                        self.tables.node_binding.get(&NodeKey::of(current)),
                        None | Some(Binding::Builtin { .. })
                    );
                }
                SyntaxKind::Group => {
                    let Some(inner) = kids(current)
                        .iter()
                        .find(|n| is_expression(n.kind))
                        .copied()
                    else {
                        return false;
                    };
                    current = inner;
                }
                _ => return false,
            }
        }
    }

    /// `==`/`!=`: compatible values with the null rules (`E3002`).
    fn type_equality(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: &str,
        left: &ResolvedType,
        right: &ResolvedType,
    ) -> ResolvedType {
        if left.is_error() || right.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            return ResolvedType::Opaque("equality operand");
        }
        // Null rules: null equals null; any other side pairing with
        // null needs a nullable side.
        match (left, right) {
            (ResolvedType::Null, ResolvedType::Null) => {
                return ResolvedType::Scalar(Scalar::Bool);
            }
            (ResolvedType::Null, other) | (other, ResolvedType::Null) => {
                if matches!(other, ResolvedType::Nullable(_)) {
                    return ResolvedType::Scalar(Scalar::Bool);
                }
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3002",
                        format!(
                            "cannot compare {} with null with `{op}`; the other side is never null",
                            self.show(cx.module, other)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
                return ResolvedType::Error;
            }
            _ => {}
        }
        let (base_l, _) = strip_nullable(left);
        let (base_r, _) = strip_nullable(right);
        if self.equality_compatible(&base_l, &base_r) {
            ResolvedType::Scalar(Scalar::Bool)
        } else {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "cannot compare {} with {} with `{op}`",
                        self.show(cx.module, left),
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            ResolvedType::Error
        }
    }

    /// Whether two non-null bases admit `==`/`!=`.
    fn equality_compatible(&self, left: &ResolvedType, right: &ResolvedType) -> bool {
        match (left, right) {
            (ResolvedType::Scalar(a), ResolvedType::Scalar(b)) => {
                if a == b {
                    // Equality is not newly defined for secret, and
                    // json (open value, unlike array/contract) has no
                    // structural rule either: unlisted pairs error.
                    // Files compare reference identities.
                    return !matches!(a, Scalar::Secret | Scalar::Json);
                }
                match (a, b) {
                    // Exact int promotion inside the operator.
                    (Scalar::Int, Scalar::Decimal) | (Scalar::Decimal, Scalar::Int) => true,
                    // Validated string-likes compare with text or the
                    // same subtype; never across subtypes.
                    (Scalar::Text, other) | (other, Scalar::Text) if other.is_string_like() => true,
                    _ => false,
                }
            }
            (
                ResolvedType::Enum {
                    cases: ac,
                    owner: ao,
                },
                ResolvedType::Enum {
                    cases: bc,
                    owner: bo,
                },
            ) => ao == bo && (ao.is_some() || ac == bc),
            (ResolvedType::Record { symbol: a, .. }, ResolvedType::Record { symbol: b, .. }) => {
                a == b
            }
            (ResolvedType::Array { element: a, .. }, ResolvedType::Array { element: b, .. }) => {
                let (a, _) = strip_nullable(a);
                let (b, _) = strip_nullable(b);
                self.equality_compatible(&a, &b)
            }
            (ResolvedType::Message(a), ResolvedType::Message(b)) => a == b,
            (ResolvedType::Delivery { op: a }, ResolvedType::Delivery { op: b }) => a == b,
            // T14c: same-target std receipts compare; cross-target
            // ones (including local-vs-std via `_`) never do.
            (
                ResolvedType::StdDelivery {
                    capability: ac,
                    op: ao,
                },
                ResolvedType::StdDelivery {
                    capability: bc,
                    op: bo,
                },
            ) => ac == bc && ao.name == bo.name,
            (ResolvedType::Team, ResolvedType::Team)
            | (ResolvedType::OperationContext, ResolvedType::OperationContext) => true,
            (ResolvedType::Union(a), ResolvedType::Union(b)) => a == b,
            (ResolvedType::Record { symbol: a, .. }, ResolvedType::Union(b))
            | (ResolvedType::Union(b), ResolvedType::Record { symbol: a, .. }) => b.contains(a),
            _ => false,
        }
    }

    /// `<`/`<=`/`>`/`>=`: compatible ordered scalars, non-null
    /// (`E3002`). Money needs matching currencies at runtime (a value
    /// check, not a type check).
    fn type_ordering(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: &str,
        left: &ResolvedType,
        right: &ResolvedType,
    ) -> ResolvedType {
        if left.is_error() || right.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            return ResolvedType::Opaque("ordering operand");
        }
        if matches!(left, ResolvedType::Nullable(_) | ResolvedType::Null)
            || matches!(right, ResolvedType::Nullable(_) | ResolvedType::Null)
        {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "cannot order {} with {} with `{op}`; order needs non-null operands (narrow or use `??`)",
                        self.show(cx.module, left),
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        }
        let ordered = match (left, right) {
            (ResolvedType::Scalar(a), ResolvedType::Scalar(b)) => {
                if a == b {
                    a.is_ordered()
                } else {
                    match (a, b) {
                        (Scalar::Int, Scalar::Decimal) | (Scalar::Decimal, Scalar::Int) => true,
                        (Scalar::Text, other) | (other, Scalar::Text) if other.is_string_like() => {
                            true
                        }
                        _ => false,
                    }
                }
            }
            _ => false,
        };
        if ordered {
            ResolvedType::Scalar(Scalar::Bool)
        } else {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "cannot order {} with {} with `{op}`; only compatible ordered scalars order (enums never do)",
                        self.show(cx.module, left),
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            ResolvedType::Error
        }
    }

    /// `+`/`-`/`*`/`/`/`%`: the arithmetic matrix (`E3002`).
    fn type_arithmetic(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        op: &str,
        left: &ResolvedType,
        right: &ResolvedType,
    ) -> ResolvedType {
        if left.is_error() || right.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            return ResolvedType::Opaque("arithmetic operand");
        }
        if matches!(left, ResolvedType::Nullable(_) | ResolvedType::Null)
            || matches!(right, ResolvedType::Nullable(_) | ResolvedType::Null)
        {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "cannot compute {} {op} {}; arithmetic needs non-null operands (narrow or use `??`)",
                        self.show(cx.module, left),
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        }
        if let Some(result) = self.arithmetic_result(op, left, right) {
            return result;
        }
        if cx.strict {
            self.diags.push(Diagnostic::error(
                "E3002",
                format!(
                    "cannot compute {} {op} {}",
                    self.show(cx.module, left),
                    self.show(cx.module, right)
                ),
                tight_span(cx.text, node),
            ));
        }
        ResolvedType::Error
    }

    /// Arithmetic matrix result, if the pair is listed.
    fn arithmetic_result(
        &self,
        op: &str,
        left: &ResolvedType,
        right: &ResolvedType,
    ) -> Option<ResolvedType> {
        let int = || ResolvedType::Scalar(Scalar::Int);
        let decimal = || ResolvedType::Scalar(Scalar::Decimal);
        let money = || ResolvedType::Scalar(Scalar::Money);
        let duration = || ResolvedType::Scalar(Scalar::Duration);
        let datetime = || ResolvedType::Scalar(Scalar::Datetime);
        match (left, right) {
            (ResolvedType::Scalar(Scalar::Int), ResolvedType::Scalar(Scalar::Int)) => match op {
                "+" | "-" | "*" | "%" => Some(int()),
                "/" => Some(decimal()),
                _ => None,
            },
            (ResolvedType::Scalar(a), ResolvedType::Scalar(b))
                if matches!(
                    (a, b),
                    (Scalar::Int, Scalar::Decimal)
                        | (Scalar::Decimal, Scalar::Int)
                        | (Scalar::Decimal, Scalar::Decimal)
                ) =>
            {
                match op {
                    "+" | "-" | "*" | "/" => Some(decimal()),
                    _ => None,
                }
            }
            (ResolvedType::Scalar(Scalar::Money), ResolvedType::Scalar(Scalar::Money)) => {
                match op {
                    "+" | "-" => Some(money()),
                    "/" => Some(decimal()),
                    _ => None,
                }
            }
            (
                ResolvedType::Scalar(Scalar::Money),
                ResolvedType::Scalar(Scalar::Int | Scalar::Decimal),
            ) => match op {
                "*" | "/" => Some(money()),
                _ => None,
            },
            (
                ResolvedType::Scalar(Scalar::Int | Scalar::Decimal),
                ResolvedType::Scalar(Scalar::Money),
            ) => match op {
                "*" => Some(money()),
                _ => None,
            },
            (ResolvedType::Scalar(Scalar::Duration), ResolvedType::Scalar(Scalar::Duration)) => {
                match op {
                    "+" | "-" | "%" => Some(duration()),
                    "/" => Some(decimal()),
                    _ => None,
                }
            }
            (ResolvedType::Scalar(Scalar::Duration), ResolvedType::Scalar(Scalar::Int)) => match op
            {
                "*" | "/" => Some(duration()),
                _ => None,
            },
            (ResolvedType::Scalar(Scalar::Int), ResolvedType::Scalar(Scalar::Duration)) => match op
            {
                "*" => Some(duration()),
                _ => None,
            },
            (ResolvedType::Scalar(Scalar::Datetime), ResolvedType::Scalar(Scalar::Duration)) => {
                match op {
                    "+" | "-" => Some(datetime()),
                    _ => None,
                }
            }
            (ResolvedType::Scalar(Scalar::Duration), ResolvedType::Scalar(Scalar::Datetime)) => {
                match op {
                    "+" => Some(datetime()),
                    _ => None,
                }
            }
            (ResolvedType::Scalar(Scalar::Datetime), ResolvedType::Scalar(Scalar::Datetime)) => {
                match op {
                    "-" => Some(duration()),
                    _ => None,
                }
            }
            (ResolvedType::Array { element: a, .. }, ResolvedType::Array { element: b, .. })
                if op == "+" =>
            {
                let (a, _) = strip_nullable(a);
                let (b, _) = strip_nullable(b);
                if loose_equal(&a, &b) {
                    Some(ResolvedType::Array {
                        element: a.clone().into(),
                        ordered: true,
                        nonempty: false,
                    })
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// `in`: `T` against a collection of compatible `T` (`E3002`).
    fn type_in(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        left_node: &SyntaxNode,
        left: &ResolvedType,
        _right_node: &SyntaxNode,
        right: &ResolvedType,
    ) -> ResolvedType {
        if left.is_error() || right.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            return ResolvedType::Opaque("membership operand");
        }
        let ResolvedType::Array { element, .. } = right else {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "right side of `in` must be a collection, found {}",
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        };
        // Post-claim: unbound left name against an enum element.
        if self.is_claimable_name(left_node)
            && let ResolvedType::Enum { cases, .. } = enum_expectation(element)
            && let Some(name) = kids(left_node).iter().find_map(|n| name_text(n, cx.text))
            && cases.iter().any(|c| c == name)
        {
            let key = NodeKey::of(left_node);
            self.types.resolved_cases.insert(key);
            self.types.node_types.insert(key, (**element).clone());
            return ResolvedType::Scalar(Scalar::Bool);
        }
        let (base_l, _) = strip_nullable(left);
        let (base_e, _) = strip_nullable(element);
        if self.equality_compatible(&base_l, &base_e) {
            ResolvedType::Scalar(Scalar::Bool)
        } else {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3002",
                    format!(
                        "cannot test {} for membership in {}",
                        self.show(cx.module, left),
                        self.show(cx.module, right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            ResolvedType::Error
        }
    }

    /// `??`: nullable `T?` left with `T`/`T?` right, no coercion
    /// (`E3004`). Non-null right means a non-null result.
    fn type_coalesce(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        left: ResolvedType,
        right: ResolvedType,
    ) -> ResolvedType {
        if left.is_error() || right.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            return ResolvedType::Opaque("coalesce operand");
        }
        let ResolvedType::Nullable(inner) = &left else {
            if matches!(left, ResolvedType::Null) {
                return right;
            }
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3004",
                    format!(
                        "left side of `??` must be nullable, found {}",
                        self.show(cx.module, &left)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        };
        let (base_r, right_nullable) = strip_nullable(&right);
        if !self.types_compatible(&base_r, inner) {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3004",
                    format!(
                        "right side of `??` must be {} or {}?, found {} (no coercion)",
                        self.show(cx.module, inner),
                        self.show(cx.module, inner),
                        self.show(cx.module, &right)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            return ResolvedType::Error;
        }
        if right_nullable {
            ResolvedType::Nullable(inner.clone())
        } else {
            (**inner).clone()
        }
    }

    /// `is`: the right operand resolves as a type-test target (the
    /// resolver recorded its [`TypeRef`]). Unions test arms, `json`
    /// tests contracts, anything else tests the same type (`E3018`).
    fn type_is(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        right_node: &SyntaxNode,
        left: ResolvedType,
    ) -> ResolvedType {
        if left.is_error() {
            return ResolvedType::Error;
        }
        if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown) {
            return ResolvedType::Opaque("is operand");
        }
        let key = NodeKey::of(right_node);
        let target = match self.tables.node_typeref.get(&key).cloned() {
            Some(TypeRef::Scalar(name)) => match scalar_named(&name) {
                Some(scalar) => ResolvedType::Scalar(scalar),
                None => match name.as_str() {
                    "Team" => ResolvedType::Team,
                    "OperationContext" => ResolvedType::OperationContext,
                    _ => return ResolvedType::Opaque("is target"),
                },
            },
            Some(TypeRef::Symbol(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Model { .. }
                | SymbolKind::Contract { .. }
                | SymbolKind::Event { .. } => ResolvedType::Record {
                    symbol: id,
                    stored: true,
                },
                _ => {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3018",
                            format!(
                                "`is` target '{}' is not a permitted type-test target",
                                record_name(self.tables, cx.module, id)
                            ),
                            tight_span(cx.text, right_node),
                        ));
                    }
                    return ResolvedType::Error;
                }
            },
            Some(TypeRef::FieldChain { .. }) => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3018",
                        "`is` targets name a type, not a field path".to_string(),
                        tight_span(cx.text, right_node),
                    ));
                }
                return ResolvedType::Error;
            }
            Some(TypeRef::External) => return ResolvedType::Opaque("is target"),
            None => return ResolvedType::Error,
        };
        let (base, _) = strip_nullable(&left);
        let holds = match (&base, &target) {
            (ResolvedType::Union(arms), ResolvedType::Record { symbol, .. }) => {
                arms.contains(symbol)
            }
            (ResolvedType::Scalar(Scalar::Json), ResolvedType::Record { symbol, .. }) => matches!(
                self.tables.symbols[symbol.0 as usize].kind,
                SymbolKind::Contract { .. }
            ),
            (left, right) => loose_equal(left, right),
        };
        if holds {
            ResolvedType::Scalar(Scalar::Bool)
        } else {
            if cx.strict {
                let reason = match (&base, &target) {
                    (ResolvedType::Union(_), _) => "the tested type is not a union arm",
                    (ResolvedType::Scalar(Scalar::Json), _) => "`is` on json only tests contracts",
                    _ => "the tested value can never hold that type",
                };
                self.diags.push(Diagnostic::error(
                    "E3018",
                    format!(
                        "`is` test of {} against {} fails: {reason}",
                        self.show(cx.module, &left),
                        self.show(cx.module, &target)
                    ),
                    tight_span(cx.text, node),
                ));
            }
            ResolvedType::Error
        }
    }

    /// Type a `Unary` node: `-` over int/decimal/duration/money
    /// (`E3002`), `not` over bool (`E3007`). `-` forwards a decimal
    /// expectation to its operand (R16/T11), so a negative integral
    /// spelling inhabits decimal exactly like a positive one.
    fn type_unary(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
        let operand = kids(node).iter().find(|n| is_expression(n.kind)).copied();
        let Some(operand) = operand else {
            return ResolvedType::Error;
        };
        // `order=-created` keeps its signed ordering expression; the
        // operand still types normally.
        let op = kids(node)
            .iter()
            .find_map(|n| match n.kind {
                SyntaxKind::Punct => n.token().map(|t| t.text(cx.text)),
                SyntaxKind::Name => name_text(n, cx.text),
                _ => None,
            })
            .unwrap_or("");
        // Only a uniquely-decimal expectation forwards (every other
        // expectation keeps the historical `None`, so no other operand
        // typing changes).
        let operand_expect = if op == "-" && expect.is_some_and(decimal_expectation) {
            expect
        } else {
            None
        };
        // `-9223372036854775808` is `i64::MIN`: valid at the result
        // boundary (DESIGN §3), so the magnitude literal bypasses the
        // overflow error a bare `9223372036854775808` reports. Under a
        // uniquely-decimal expectation the magnitude (19 digits, well
        // within 38) inhabits decimal instead (R16/T11).
        let ty = if op == "-" && is_min_negation_operand(operand, cx.text) {
            if operand_expect.is_some() {
                self.record(operand, ResolvedType::Scalar(Scalar::Decimal))
            } else {
                self.record(operand, ResolvedType::Scalar(Scalar::Int))
            }
        } else {
            self.expr(cx, operand, operand_expect.cloned())
        };
        if ty.is_error() {
            return ResolvedType::Error;
        }
        if matches!(ty, ResolvedType::Opaque(_) | ResolvedType::Unknown) {
            return ResolvedType::Opaque("unary operand");
        }
        match op {
            "not" => {
                self.expect_bool(cx, tight_span(cx.text, node), &ty, "`not`");
                if matches!(ty, ResolvedType::Scalar(Scalar::Bool)) {
                    ty
                } else {
                    ResolvedType::Error
                }
            }
            "-" => match ty {
                ResolvedType::Scalar(s)
                    if matches!(
                        s,
                        Scalar::Int | Scalar::Decimal | Scalar::Duration | Scalar::Money
                    ) =>
                {
                    ResolvedType::Scalar(s)
                }
                _ => {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3002",
                            format!(
                                "unary `-` applies to int/decimal/duration/money, found {}",
                                self.show(cx.module, &ty)
                            ),
                            tight_span(cx.text, node),
                        ));
                    }
                    ResolvedType::Error
                }
            },
            _ => ResolvedType::Error,
        }
    }

    /// Extract narrowings from a condition (T03 §§2-4): null
    /// true/false facts, short-circuit `and`/`or` composition, `not`
    /// polarity, `is` narrowing and the retained `==` safe-access
    /// rule. `else_branch` selects the false-continuation facts.
    fn extract_narrow(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        else_branch: bool,
    ) -> NarrowEnv {
        let mut env = NarrowEnv::new();
        self.collect_narrow(cx, node, else_branch, &mut env);
        env
    }

    /// Collect narrowings from `node`. Short-circuit composition (T03
    /// §3): `and`-true carries left-true + right-true, `or`-false
    /// carries left-false + right-false; the other continuations carry
    /// nothing. `not` swaps polarity.
    fn collect_narrow(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        else_branch: bool,
        env: &mut NarrowEnv,
    ) {
        type SharedNarrow = std::rc::Rc<NarrowEnv>;
        enum Work<'n> {
            Eval(&'n SyntaxNode, bool, SharedNarrow),
            Left(&'n SyntaxNode, bool, SharedNarrow, NarrowEnv),
            Right(NarrowEnv, NarrowEnv),
            Merge(NarrowEnv),
        }
        let proofs = self.auth_proofs(node, cx.text);
        let mut work = vec![Work::Eval(
            node,
            else_branch,
            std::rc::Rc::new(cx.narrow.clone()),
        )];
        let mut value = NarrowEnv::new();
        while let Some(step) = work.pop() {
            match step {
                Work::Merge(mut base) => {
                    base.extend(value);
                    value = base;
                }
                Work::Right(mut base, mut extended) => {
                    extended.extend(value);
                    base.extend(extended);
                    value = base;
                }
                Work::Left(current, polarity, narrow, base) => {
                    let parts = kids(current);
                    let mut extended = (*narrow).clone();
                    extended.extend(value);
                    work.push(Work::Right(base, extended.clone()));
                    work.push(Work::Eval(parts[2], polarity, std::rc::Rc::new(extended)));
                    value = NarrowEnv::new();
                }
                Work::Eval(current, polarity, narrow) => {
                    let current = unwrap_groups(current);
                    let local = Ctx {
                        module: cx.module,
                        file: cx.file,
                        text: cx.text,
                        narrow: &narrow,
                        strict: cx.strict,
                        server_default: cx.server_default,
                    };
                    value = NarrowEnv::new();
                    let (on_true, on_false) = proofs
                        .get(&NodeKey::of(current))
                        .copied()
                        .unwrap_or((false, false));
                    if if polarity { on_false } else { on_true } {
                        value.insert(
                            NarrowKey {
                                decl: DeclKey::CtxActor,
                                path: Vec::new(),
                            },
                            ResolvedType::Scalar(Scalar::User),
                        );
                    }
                    let parts = kids(current);
                    if current.kind == SyntaxKind::Unary {
                        let is_not = parts.iter().any(|n| match n.kind {
                            SyntaxKind::Punct => {
                                n.token().is_some_and(|t| t.text(cx.text) == "not")
                            }
                            SyntaxKind::Name => name_text(n, cx.text).is_some_and(|w| w == "not"),
                            _ => false,
                        });
                        if is_not
                            && let Some(operand) = parts.iter().find(|n| is_expression(n.kind))
                        {
                            work.push(Work::Merge(value));
                            work.push(Work::Eval(operand, !polarity, narrow));
                            value = NarrowEnv::new();
                        }
                        continue;
                    }
                    if current.kind != SyntaxKind::Binary || parts.len() != 3 {
                        continue;
                    }
                    let op = op_text(current, cx.text).unwrap_or("");
                    if (op == "and" && !polarity) || (op == "or" && polarity) {
                        work.push(Work::Left(current, polarity, narrow.clone(), value));
                        work.push(Work::Eval(parts[0], polarity, narrow));
                        value = NarrowEnv::new();
                    } else if op == "is" {
                        self.narrow_is(&local, current, parts[0], parts[2], polarity, &mut value);
                    } else if matches!(op, "==" | "!=") {
                        self.narrow_null_eq(
                            &local,
                            parts[0],
                            parts[2],
                            op == "==",
                            polarity,
                            &mut value,
                        );
                        if !polarity && op == "==" {
                            self.narrow_safe_eq(&local, current, parts[0], parts[2], &mut value);
                        }
                    }
                }
            }
        }
        env.extend(value);
    }

    /// Narrow from a direct null test (T03 §2): `==`/`!=` with exactly
    /// one side the `null` literal and the other a stable plain path
    /// (no `?.`). `p == null` proves null on true / non-null on
    /// false; `p != null` the reverse. Cross-nullable comparisons
    /// and safe-access chains establish nothing.
    fn narrow_null_eq(
        &mut self,
        cx: &Ctx<'_, '_>,
        left_node: &SyntaxNode,
        right_node: &SyntaxNode,
        is_eq: bool,
        else_branch: bool,
        env: &mut NarrowEnv,
    ) {
        let left = unwrap_groups(left_node);
        let right = unwrap_groups(right_node);
        let left_null = left.kind == SyntaxKind::Literal && is_null_literal(left, cx.text);
        let right_null = right.kind == SyntaxKind::Literal && is_null_literal(right, cx.text);
        if left_null == right_null {
            return;
        }
        let tested = if left_null { right } else { left };
        if !matches!(
            tested.kind,
            SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group
        ) || chain_has_safe(tested, cx.text)
        {
            return;
        }
        let Some(key) = self.narrow_key_for(cx, tested) else {
            return;
        };
        if matches!(key.decl, DeclKey::Unresolved(_)) {
            return;
        }
        // True proves non-null for `!=` (null for `==`); the false
        // continuation proves the reverse.
        let nonnull = is_eq == else_branch;
        let recorded = self
            .types
            .node_types
            .get(&NodeKey::of(tested))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        if nonnull {
            let ResolvedType::Nullable(inner) = recorded else {
                return;
            };
            env.insert(key, (*inner).clone());
        } else {
            if !matches!(recorded, ResolvedType::Nullable(_) | ResolvedType::Null) {
                return;
            }
            env.insert(key, ResolvedType::Null);
        }
    }

    /// Narrow from `chain == proven-nonnull` (either side).
    fn narrow_safe_eq(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        left_node: &SyntaxNode,
        right_node: &SyntaxNode,
        env: &mut NarrowEnv,
    ) {
        let left = self
            .types
            .node_types
            .get(&NodeKey::of(left_node))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        let right = self
            .types
            .node_types
            .get(&NodeKey::of(right_node))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        if right.is_proven_nonnull() && safe_chain(left_node, cx.text).is_some() {
            self.narrow_chain_prefixes(cx, left_node, env);
        }
        if left.is_proven_nonnull() && safe_chain(right_node, cx.text).is_some() {
            self.narrow_chain_prefixes(cx, right_node, env);
        }
        let _ = (left, right);
    }

    /// Narrow every traversed nullable receiver of a safe chain plus
    /// the selected value itself.
    fn narrow_chain_prefixes(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, env: &mut NarrowEnv) {
        let Some((_, leaf_first)) = member_path(node, cx.text) else {
            return;
        };
        let Some(root_key) = self.narrow_key_for(cx, node) else {
            return;
        };
        if matches!(root_key.decl, DeclKey::Unresolved(_)) {
            return;
        }
        // Prefixes from the root outward (root, root.a, …, the full
        // selected value): every nullable one narrows to non-null.
        let hops: Vec<String> = leaf_first.into_iter().rev().collect();
        let mut path = Vec::new();
        // Check the root first, then each hop.
        for step in 0..=hops.len() {
            if step > 0 {
                path.push(hops[step - 1].clone());
            }
            let key = NarrowKey {
                decl: root_key.decl.clone(),
                path: path.clone(),
            };
            if env.contains_key(&key) {
                continue;
            }
            let ty = self.prefix_type(cx, node, &path);
            if let ResolvedType::Nullable(inner) = ty {
                env.insert(key, (*inner).clone());
            }
        }
    }

    /// Type of a chain prefix by re-walking from the root over
    /// recorded types, navigating `path` hops silently (diagnostics,
    /// if any, were already reported by the main pass).
    fn prefix_type(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        path: &[String],
    ) -> ResolvedType {
        let mut current = node;
        loop {
            match current.kind {
                SyntaxKind::Member => {
                    let parts = kids(current);
                    if parts.is_empty() {
                        return ResolvedType::Error;
                    }
                    current = parts[0];
                }
                SyntaxKind::Group => {
                    let parts = kids(current);
                    let Some(inner) = parts.iter().find(|n| is_expression(n.kind)) else {
                        return ResolvedType::Error;
                    };
                    current = *inner;
                }
                _ => break,
            }
        }
        let mut ty = self
            .types
            .node_types
            .get(&NodeKey::of(current))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        let silent_cx = Ctx {
            module: cx.module,
            file: cx.file,
            text: cx.text,
            narrow: cx.narrow,
            strict: false,
            server_default: cx.server_default,
        };
        for hop in path {
            let inner = match ty {
                ResolvedType::Nullable(inner) => inner.as_ref().clone(),
                other => other,
            };
            match self.member_lookup(&silent_cx, node, node, hop, &inner) {
                Some(next) => ty = next,
                None => return ResolvedType::Error,
            }
        }
        ty
    }

    /// Narrow from an `is` test: true branch takes the target (unions
    /// take the arm, `json` takes the contract record); false branch
    /// takes union-minus-arm, else unchanged.
    fn narrow_is(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        left_node: &SyntaxNode,
        right_node: &SyntaxNode,
        else_branch: bool,
        env: &mut NarrowEnv,
    ) {
        let subject_key = match left_node.kind {
            SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group => {
                self.narrow_key_for(cx, left_node)
            }
            _ => None,
        };
        let Some(subject_key) = subject_key else {
            return;
        };
        if matches!(subject_key.decl, DeclKey::Unresolved(_)) {
            return;
        }
        let subject = self
            .types
            .node_types
            .get(&NodeKey::of(left_node))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        let key = NodeKey::of(right_node);
        let target = match self.tables.node_typeref.get(&key).cloned() {
            Some(TypeRef::Scalar(name)) => match scalar_named(&name) {
                Some(scalar) => ResolvedType::Scalar(scalar),
                None => match name.as_str() {
                    "Team" => ResolvedType::Team,
                    "OperationContext" => ResolvedType::OperationContext,
                    _ => return,
                },
            },
            Some(TypeRef::Symbol(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Model { .. }
                | SymbolKind::Contract { .. }
                | SymbolKind::Event { .. } => ResolvedType::Record {
                    symbol: id,
                    stored: true,
                },
                _ => return,
            },
            _ => return,
        };
        let (base, _) = strip_nullable(&subject);
        let narrowed = if else_branch {
            match (&base, &target) {
                (ResolvedType::Union(arms), ResolvedType::Record { symbol, .. }) => {
                    let rest: Vec<SymbolId> =
                        arms.iter().filter(|a| *a != symbol).copied().collect();
                    if rest.len() == arms.len() || rest.is_empty() {
                        return;
                    }
                    if rest.len() == 1 {
                        ResolvedType::Record {
                            symbol: rest[0],
                            stored: true,
                        }
                    } else {
                        ResolvedType::Union(rest)
                    }
                }
                _ => return,
            }
        } else {
            match (&base, &target) {
                (ResolvedType::Union(arms), ResolvedType::Record { symbol, .. })
                    if arms.contains(symbol) =>
                {
                    target.clone()
                }
                (ResolvedType::Scalar(Scalar::Json), ResolvedType::Record { .. }) => target.clone(),
                (left, right) if loose_equal(left, right) => {
                    // Same-type test (possibly nullable subject):
                    // narrow to the non-null target.
                    target.clone()
                }
                _ => return,
            }
        };
        env.insert(
            NarrowKey {
                decl: subject_key.decl,
                path: subject_key.path,
            },
            narrowed,
        );
    }
}

/// Whether `node` is a safe-access chain (a member chain through
/// groups containing at least one `?.` with a name root).
fn safe_chain(node: &SyntaxNode, text: &str) -> Option<()> {
    let mut current = node;
    let mut safe = false;
    loop {
        match current.kind {
            SyntaxKind::Member => {
                let parts = kids(current);
                if parts.len() < 3 {
                    return None;
                }
                if is_punct(parts[1], text, "?.") {
                    safe = true;
                }
                current = parts[0];
            }
            SyntaxKind::Group => {
                current = kids(current).iter().find(|n| is_expression(n.kind))?;
            }
            SyntaxKind::NameRef => {
                return if safe { Some(()) } else { None };
            }
            _ => return None,
        }
    }
}

impl<'a> Typer<'a> {
    // --- Composite values ----------------------------------------------

    /// Type an `Array` literal: homogeneous elements (`E3001`), ordered
    /// by authored order, nonempty iff statically nonempty. The empty
    /// array has `Unknown` element type. An array/collection expectation
    /// threads its element type inward (enum claiming).
    fn type_array(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
        let elements: Vec<&SyntaxNode> = kids(node)
            .iter()
            .filter(|n| is_expression(n.kind))
            .copied()
            .collect();
        // T10: nullable-unwrap like the empty-literal arm below so
        // `Contract[]?` elements inherit their expected type too.
        let element_expect = match expect {
            Some(ResolvedType::Array { element, .. }) => Some((**element).clone()),
            Some(ResolvedType::Nullable(inner)) => match inner.as_ref() {
                ResolvedType::Array { element, .. } => Some((**element).clone()),
                _ => None,
            },
            _ => None,
        };
        if elements.is_empty() {
            // An empty literal unifies against an explicit expected
            // array type (nullable-unwrapped): `file[]=[]` is an empty
            // file array, not array-of-`{unknown}`.
            let expected_element = match expect {
                Some(ResolvedType::Array { element, .. }) => Some((**element).clone()),
                Some(ResolvedType::Nullable(inner)) => match inner.as_ref() {
                    ResolvedType::Array { element, .. } => Some((**element).clone()),
                    _ => None,
                },
                _ => None,
            };
            return ResolvedType::Array {
                element: Box::new(expected_element.unwrap_or(ResolvedType::Unknown)),
                ordered: true,
                nonempty: false,
            };
        }
        let mut element_ty: Option<ResolvedType> = None;
        let mut bad = false;
        for element in &elements {
            let ty = self.expr(cx, element, element_expect.clone());
            if ty.is_error() {
                bad = true;
                continue;
            }
            if matches!(ty, ResolvedType::Opaque(_) | ResolvedType::Unknown) {
                continue;
            }
            match &element_ty {
                None => element_ty = Some(ty),
                Some(first) => {
                    let (a, first_nullable) = strip_nullable(first);
                    let (b, nullable) = strip_nullable(&ty);
                    if !loose_equal(&a, &b) {
                        if cx.strict {
                            self.diags.push(Diagnostic::error(
                                "E3001",
                                format!(
                                    "array elements must have the same type, found {} and {}",
                                    self.show(cx.module, first),
                                    self.show(cx.module, &ty)
                                ),
                                tight_span(cx.text, element),
                            ));
                        }
                        bad = true;
                    } else if nullable && !first_nullable {
                        element_ty = Some(ty);
                    }
                }
            }
        }
        if bad {
            return ResolvedType::Error;
        }
        ResolvedType::Array {
            element: Box::new(element_ty.unwrap_or(ResolvedType::Unknown)),
            ordered: true,
            nonempty: true,
        }
    }

    /// Type an `Object` literal as a closed object. `check_entries`
    /// (false for light positions) enables per-entry validation
    /// against an object expectation; values always type (names
    /// resolve, operators check in strict mode).
    fn type_object(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
        check_entries: bool,
    ) -> ResolvedType {
        // T10: a bare literal against a known contract/event type
        // validates closed-recursively and inhabits the expected
        // record; every other expectation keeps the open object.
        if let Some(expected) = expect {
            let (inner, _) = strip_nullable(expected);
            if let ResolvedType::Record { symbol, .. } = inner
                && matches!(
                    self.tables.symbols[symbol.0 as usize].kind,
                    SymbolKind::Contract { .. } | SymbolKind::Event { .. }
                )
            {
                return self.type_structural_literal(cx, node, expected, symbol, check_entries);
            }
        }
        let mut fields = Vec::new();
        let mut bad = false;
        for entry in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
        {
            if has_error(entry) {
                bad = true;
                continue;
            }
            let entry_parts = kids(entry);
            let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let Some(key) = name_text(name_node, cx.text) else {
                continue;
            };
            let value_node = entry_parts.iter().find(|n| is_expression(n.kind)).copied();
            let entry_expect = match expect {
                Some(ResolvedType::Object(exp)) => {
                    exp.iter().find(|(k, _)| k == key).map(|(_, t)| t.clone())
                }
                _ => None,
            };
            let value_ty = match value_node {
                Some(value) => self.expr(cx, value, entry_expect.clone()),
                None => self.type_shorthand(cx, entry, name_node, key, entry_expect.clone()),
            };
            if value_ty.is_error() {
                bad = true;
            }
            if check_entries && let Some(expected) = entry_expect {
                self.assign_ok(
                    cx,
                    tight_span(cx.text, entry),
                    &value_ty,
                    &expected,
                    &format!("field '{key}'"),
                );
            }
            fields.push((key.to_string(), value_ty));
        }
        if bad {
            // Entries keep their recorded types; the object itself is
            // still usable for member lookup of its good fields.
        }
        ResolvedType::Object(fields)
    }

    /// Type a bare object literal against a known contract/event
    /// record (T10 closed recursive semantics): entries check against
    /// the declared fields with per-field expectations (nested
    /// literals, arrays and bare enum cases inherit theirs), unknown
    /// keys are `E2013`, value mismatches and missing required fields
    /// `E3001`, and the literal inhabits the expected record so the
    /// outer position checks clean. Models never take literals
    /// (references are identity, never embedded copies); unions and
    /// opaque expectations keep the open-object path. Supplied
    /// server-initialized fields validate strictly but are never
    /// required (fixtures are stored snapshots, DESIGN L403; the
    /// values `create` mode agrees).
    fn type_structural_literal(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expected: &ResolvedType,
        symbol: SymbolId,
        check_entries: bool,
    ) -> ResolvedType {
        let fields = self.tables.symbols[symbol.0 as usize].fields_of().to_vec();
        let mut seen: HashSet<String> = HashSet::new();
        for entry in node
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
        {
            if has_error(entry) {
                continue;
            }
            let entry_parts = kids(entry);
            let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let Some(key) = name_text(name_node, cx.text) else {
                continue;
            };
            seen.insert(key.to_string());
            let field = fields
                .iter()
                .find_map(|f| (self.tables.symbols[f.0 as usize].name == key).then_some(*f));
            let Some(field) = field else {
                // Closed: unknown keys fail (one error per broken
                // entry; the value's own unbound `E2001` is then
                // suppressed).
                if cx.strict {
                    let record = &self.tables.symbols[symbol.0 as usize];
                    let kind = match record.kind {
                        SymbolKind::Contract { .. } => "contract",
                        SymbolKind::Event { .. } => "event",
                        _ => "record",
                    };
                    self.member_fail(
                        entry,
                        name_node.span,
                        format!("{kind} {}", record_name(self.tables, cx.module, symbol)),
                        key.to_string(),
                    );
                }
                if let Some(value) = entry_parts.iter().find(|n| is_expression(n.kind)) {
                    let ty = self.expr(cx, value, None);
                    if ty.is_error() && self.is_claimable_name(value) {
                        self.types.resolved_cases.insert(NodeKey::of(value));
                    }
                } else if self.is_shorthand_unbound(name_node) {
                    self.types.resolved_cases.insert(NodeKey::of(name_node));
                }
                continue;
            };
            if matches!(
                self.tables.symbols[field.0 as usize].kind,
                SymbolKind::DeriveField { .. }
            ) && cx.strict
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("derived field '{key}' is computed and cannot be supplied"),
                    tight_span(cx.text, entry),
                ));
            }
            let field_expect = self.decl_type(field);
            let value_node = entry_parts.iter().find(|n| is_expression(n.kind)).copied();
            let value_ty = match value_node {
                Some(value) => self.expr(cx, value, Some(field_expect.clone())),
                None => self.type_shorthand(cx, entry, name_node, key, Some(field_expect.clone())),
            };
            if check_entries {
                self.assign_ok(
                    cx,
                    tight_span(cx.text, entry),
                    &value_ty,
                    &field_expect,
                    &format!("'{key}'"),
                );
            }
        }
        if check_entries {
            for field in &fields {
                let name = self.tables.symbols[field.0 as usize].name.clone();
                if seen.contains(&name) {
                    continue;
                }
                if self.field_is_required(*field) && cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "missing required field '{name}' of {}",
                            record_name(self.tables, cx.module, symbol)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
            }
        }
        expected.clone()
    }

    /// Type an object shorthand (`{field}` = `{field=field}`): the
    /// leading `Name` resolves as a reference (the resolver recorded
    /// its binding); an unbound shorthand claims an expected enum
    /// case by the same lookup.
    fn type_shorthand(
        &mut self,
        cx: &Ctx<'_, '_>,
        entry: &SyntaxNode,
        name_node: &SyntaxNode,
        key: &str,
        expect: Option<ResolvedType>,
    ) -> ResolvedType {
        let name_key = NodeKey::of(name_node);
        if let Some(binding) = self.tables.node_binding.get(&name_key).cloned() {
            // A shorthand reads its binding, so continuation facts
            // on that declaration apply (T03 §6).
            if let Some(narrowed) = self.narrowed_binding(cx, &binding) {
                self.types.node_types.insert(name_key, narrowed.clone());
                return narrowed;
            }
            let ty = self.type_binding(cx, name_node, &binding);
            self.types.node_types.insert(name_key, ty.clone());
            return ty;
        }
        if let Some(expected) = expect
            && let ResolvedType::Enum { cases, .. } = enum_expectation(&expected)
            && cases.iter().any(|c| c == key)
        {
            self.types.resolved_cases.insert(name_key);
            self.types.node_types.insert(name_key, expected.clone());
            return expected;
        }
        let _ = entry;
        ResolvedType::Error
    }

    /// Type a `Construct` (`Head {…}`): the head resolves as a type
    /// (recorded [`TypeRef`]); entries check against model/contract/
    /// event fields or message parameters. Unknown entries are
    /// `E2013`, value mismatches `E3001`, missing required fields
    /// `E3001`, supplied server fields `E3001`.
    fn type_construct(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let parts = kids(node);
        let head = parts.iter().find(|n| is_expression(n.kind)).copied();
        let object = parts.iter().find(|n| n.kind == SyntaxKind::Object).copied();
        let Some(head) = head else {
            return ResolvedType::Error;
        };
        let key = NodeKey::of(head);
        let head_ty = match self.tables.node_typeref.get(&key).cloned() {
            Some(TypeRef::Symbol(id)) => match &self.tables.symbols[id.0 as usize].kind {
                SymbolKind::Model { .. }
                | SymbolKind::Contract { .. }
                | SymbolKind::Event { .. } => ResolvedType::Record {
                    symbol: id,
                    stored: false,
                },
                SymbolKind::Message { .. } => ResolvedType::Message(id),
                _ => {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3008",
                            format!(
                                "cannot construct '{}'; only models, contracts, events and messages construct",
                                record_name(self.tables, cx.module, id)
                            ),
                            tight_span(cx.text, head),
                        ));
                    }
                    return ResolvedType::Error;
                }
            },
            Some(TypeRef::Scalar(name)) => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        format!("cannot construct a value of scalar type '{name}'"),
                        tight_span(cx.text, head),
                    ));
                }
                return ResolvedType::Error;
            }
            Some(TypeRef::FieldChain { .. }) => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        "cannot construct a field path; name a model, contract, event or message"
                            .to_string(),
                        tight_span(cx.text, head),
                    ));
                }
                return ResolvedType::Error;
            }
            Some(TypeRef::External) => {
                // The imported owner name, rather than the source alias,
                // selects a consumed std schema. Other providers and
                // nominal names without a schema retain the opaque path.
                let schema = nameref_word(head, cx.text)
                    .and_then(|name| {
                        self.tables.module_scopes[cx.module.0 as usize]
                            .prod
                            .get(name)
                    })
                    .and_then(|binding| match binding {
                        ScopedName::External { provider, name } if provider == "std" => {
                            nominal_schema(name)
                        }
                        _ => None,
                    });
                let Some(schema) = schema else {
                    return ResolvedType::Opaque("external construct");
                };
                let expected = std_nominal_object(schema);
                if let Some(object) = object {
                    self.type_object(cx, object, Some(&expected), true);
                    if cx.strict {
                        let entries = object_entries(object, cx.text);
                        for (name, key, _) in &entries {
                            if !schema.fields.iter().any(|(field, _)| field == name) {
                                self.member_fail(
                                    key,
                                    key.span,
                                    format!("std {}", schema.name),
                                    name.to_string(),
                                );
                            }
                        }
                        for (name, declared) in schema.fields {
                            if !entries.iter().any(|(key, _, _)| key == name)
                                && !declared.ends_with('?')
                                && !declared.ends_with("[]")
                            {
                                self.diags.push(Diagnostic::error(
                                    "E3001",
                                    format!("missing required field '{name}' of {}", schema.name),
                                    tight_span(cx.text, node),
                                ));
                            }
                        }
                    }
                }
                return expected;
            }
            None => return ResolvedType::Error,
        };
        let Some(object) = object else {
            return head_ty;
        };
        match head_ty.clone() {
            ResolvedType::Record { symbol, .. } => {
                self.check_record_entries(cx, node, object, symbol, true);
            }
            ResolvedType::Message(id) => {
                self.check_message_entries(cx, node, object, id);
            }
            _ => {}
        }
        head_ty
    }

    /// Check construct/fixture entries against record fields. Unknown
    /// fields are `E2013` (the value's own unbound `E2001` is then
    /// suppressed: one error per broken entry); value mismatches are
    /// `E3001`. `strict_entries` (constructs only) additionally
    /// rejects supplied server fields and missing required fields.
    fn check_record_entries(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        object: &SyntaxNode,
        symbol: SymbolId,
        strict_entries: bool,
    ) {
        let fields = self.tables.symbols[symbol.0 as usize].fields_of().to_vec();
        let mut seen: HashSet<String> = HashSet::new();
        for entry in object
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
        {
            if has_error(entry) {
                continue;
            }
            let entry_parts = kids(entry);
            let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let Some(key) = name_text(name_node, cx.text) else {
                continue;
            };
            seen.insert(key.to_string());
            let field = fields
                .iter()
                .find_map(|f| (self.tables.symbols[f.0 as usize].name == key).then_some(*f));
            let Some(field) = field else {
                if cx.strict {
                    let record = &self.tables.symbols[symbol.0 as usize];
                    let kind = match record.kind {
                        SymbolKind::Model { .. } => "model",
                        SymbolKind::Contract { .. } => "contract",
                        SymbolKind::Event { .. } => "event",
                        _ => "record",
                    };
                    self.member_fail(
                        entry,
                        name_node.span,
                        format!("{kind} {}", record_name(self.tables, cx.module, symbol)),
                        key.to_string(),
                    );
                }
                // Still type the value (inner errors surface) but
                // suppress its own unbound `E2001`.
                if let Some(value) = entry_parts.iter().find(|n| is_expression(n.kind)) {
                    let ty = self.expr(cx, value, None);
                    if ty.is_error() && self.is_claimable_name(value) {
                        self.types.resolved_cases.insert(NodeKey::of(value));
                    }
                } else if self.is_shorthand_unbound(name_node) {
                    self.types.resolved_cases.insert(NodeKey::of(name_node));
                }
                continue;
            };
            if matches!(
                self.tables.symbols[field.0 as usize].kind,
                SymbolKind::DeriveField { .. }
            ) && cx.strict
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("derived field '{key}' is computed and cannot be supplied"),
                    tight_span(cx.text, entry),
                ));
            }
            let expected = self.decl_type(field);
            if strict_entries && self.field_has_server(field) && cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("field '{key}' is server-initialized and cannot be supplied here"),
                    tight_span(cx.text, entry),
                ));
            }
            let value_node = entry_parts.iter().find(|n| is_expression(n.kind)).copied();
            let value_ty = match value_node {
                Some(value) => self.expr(cx, value, Some(expected.clone())),
                None => self.type_shorthand(cx, entry, name_node, key, Some(expected.clone())),
            };
            self.assign_ok(
                cx,
                tight_span(cx.text, entry),
                &value_ty,
                &expected,
                &format!("field '{key}'"),
            );
        }
        if strict_entries {
            for field in &fields {
                let name = self.tables.symbols[field.0 as usize].name.clone();
                if seen.contains(&name) {
                    continue;
                }
                if self.field_is_required(*field) && cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "missing required field '{name}' of {}",
                            record_name(self.tables, cx.module, symbol)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
            }
        }
    }

    /// Whether a field symbol has a `server=` initializer.
    fn field_has_server(&self, field: SymbolId) -> bool {
        self.shapes.get(&field).is_some_and(|s| s.1)
    }

    /// Whether a field must be supplied at construction: non-nullable,
    /// no default, no server initializer; arrays only with `!`.
    /// Derived fields are computed, never required.
    fn field_is_required(&self, field: SymbolId) -> bool {
        if matches!(
            self.tables.symbols[field.0 as usize].kind,
            SymbolKind::DeriveField { .. }
        ) {
            return false;
        }
        let shape = self
            .shapes
            .get(&field)
            .copied()
            .unwrap_or((false, false, false));
        if shape.0 || shape.1 {
            return false;
        }
        match self.decl.get(&field) {
            Some(ResolvedType::Nullable(_)) | None => false,
            Some(ResolvedType::Array { .. }) => shape.2,
            Some(_) => true,
        }
    }

    /// Whether a parameter symbol has a default value (callers may
    /// omit it).
    fn param_has_default(&self, param: SymbolId) -> bool {
        self.shapes.get(&param).is_some_and(|s| s.0)
    }

    /// Check construct entries against message parameters (named, with
    /// defaults omittable). Unknown parameters are `E2013`, value
    /// mismatches `E3001`, missing required parameters `E3001`.
    fn check_message_entries(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        object: &SyntaxNode,
        id: SymbolId,
    ) {
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Message { params } => params.clone(),
            _ => Vec::new(),
        };
        let mut seen: HashSet<String> = HashSet::new();
        for entry in object
            .children
            .iter()
            .filter(|c| c.kind == SyntaxKind::ObjectEntry)
        {
            if has_error(entry) {
                continue;
            }
            let entry_parts = kids(entry);
            let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
                continue;
            };
            let Some(key) = name_text(name_node, cx.text) else {
                continue;
            };
            seen.insert(key.to_string());
            let param = params
                .iter()
                .find_map(|p| (self.tables.symbols[p.0 as usize].name == key).then_some(*p));
            let Some(param) = param else {
                if cx.strict {
                    self.member_fail(
                        entry,
                        name_node.span,
                        format!("message {}", record_name(self.tables, cx.module, id)),
                        key.to_string(),
                    );
                }
                if let Some(value) = entry_parts.iter().find(|n| is_expression(n.kind)) {
                    let ty = self.expr(cx, value, None);
                    if ty.is_error() && self.is_claimable_name(value) {
                        self.types.resolved_cases.insert(NodeKey::of(value));
                    }
                } else if self.is_shorthand_unbound(name_node) {
                    self.types.resolved_cases.insert(NodeKey::of(name_node));
                }
                continue;
            };
            let expected = self.decl_type(param);
            let value_node = entry_parts.iter().find(|n| is_expression(n.kind)).copied();
            let value_ty = match value_node {
                Some(value) => self.expr(cx, value, Some(expected.clone())),
                None => self.type_shorthand(cx, entry, name_node, key, Some(expected.clone())),
            };
            self.assign_ok(
                cx,
                tight_span(cx.text, entry),
                &value_ty,
                &expected,
                &format!("parameter '{key}'"),
            );
        }
        let _ = node;
    }

    /// Whether a shorthand `Name` node is unbound (for `E2001`
    /// suppression on broken entries).
    fn is_shorthand_unbound(&self, name_node: &SyntaxNode) -> bool {
        let key = NodeKey::of(name_node);
        !self.tables.node_binding.contains_key(&key) && !self.types.resolved_cases.contains(&key)
    }

    /// Type a `Query`: the domain is a model or a collection
    /// (`E3006`); `where` is bool, `order` keys are ordered scalars,
    /// `select` projects. `as` aliases record the domain element for
    /// following clauses; the result element feeds `RowQuery` rows.
    fn type_query(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let parts = kids(node);
        let base = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(base) = base else {
            return ResolvedType::Error;
        };
        // A bare model domain is its ordered record collection.
        let mut element = match base.kind {
            SyntaxKind::NameRef => {
                let key = NodeKey::of(base);
                match self.tables.node_binding.get(&key).cloned() {
                    Some(Binding::Symbol(id))
                        if matches!(
                            self.tables.symbols[id.0 as usize].kind,
                            SymbolKind::Model { .. }
                        ) =>
                    {
                        let ty = ResolvedType::Record {
                            symbol: id,
                            stored: true,
                        };
                        self.types.node_types.insert(
                            key,
                            ResolvedType::Array {
                                element: Box::new(ty.clone()),
                                ordered: true,
                                nonempty: false,
                            },
                        );
                        ty
                    }
                    Some(Binding::Error) => return ResolvedType::Error,
                    _ => {
                        let base_ty = self.expr(cx, base, None);
                        match base_ty {
                            ResolvedType::Array { element, .. } => (*element).clone(),
                            ResolvedType::Error
                            | ResolvedType::Opaque(_)
                            | ResolvedType::Unknown => return base_ty,
                            other => {
                                if cx.strict {
                                    self.diags.push(Diagnostic::error(
                                        "E3006",
                                        format!(
                                            "query domain must be a model or collection, found {}",
                                            self.show(cx.module, &other)
                                        ),
                                        tight_span(cx.text, base),
                                    ));
                                }
                                return ResolvedType::Error;
                            }
                        }
                    }
                }
            }
            _ => {
                let base_ty = self.expr(cx, base, None);
                match base_ty {
                    ResolvedType::Array { element, .. } => (*element).clone(),
                    ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => {
                        return base_ty;
                    }
                    other => {
                        if cx.strict {
                            self.diags.push(Diagnostic::error(
                                "E3006",
                                format!(
                                    "query domain must be a model or collection, found {}",
                                    self.show(cx.module, &other)
                                ),
                                tight_span(cx.text, base),
                            ));
                        }
                        return ResolvedType::Error;
                    }
                }
            }
        };
        // Domain orderedness: record queries keep `created,id`; array
        // domains keep their flag.
        let base_ty = self
            .types
            .node_types
            .get(&NodeKey::of(base))
            .cloned()
            .unwrap_or(ResolvedType::Error);
        let mut ordered = match &base_ty {
            ResolvedType::Array { ordered, .. } => *ordered,
            _ => true,
        };
        let mut projected: Option<ResolvedType> = None;
        // Clauses run in written order; each `as` rebinds the alias.
        // T07: a `where` passes only rows satisfying it, so its
        // true-facts (null tests on the row alias) narrow the
        // selected row for every following clause
        // (`where`/`order`/`select`). Facts stay keyed on the
        // alias declaration (T03 §6): each `as` clause is its own
        // declaration, so sibling and nested aliases never share
        // them, while outer facts flow inward through the
        // enclosing environment exactly as the contract allows.
        let mut clause_env = cx.narrow.clone();
        for part in parts {
            if part.kind != SyntaxKind::QueryClause || has_error(part) {
                continue;
            }
            let head = kids(part)
                .iter()
                .find_map(|n| name_text(n, cx.text))
                .unwrap_or("");
            match head {
                "as" => {
                    self.aliases.insert(NodeKey::of(part), element.clone());
                }
                "archived" => {}
                "where" => {
                    for value in kids(part) {
                        if is_expression(value.kind) {
                            let ty = {
                                let clause_cx = Ctx {
                                    module: cx.module,
                                    file: cx.file,
                                    text: cx.text,
                                    narrow: &clause_env,
                                    strict: cx.strict,
                                    server_default: cx.server_default,
                                };
                                self.expr(&clause_cx, value, None)
                            };
                            self.expect_bool(cx, tight_span(cx.text, value), &ty, "`where` clause");
                            // Collect after typing: narrowing reads
                            // the recorded types of the tested paths.
                            let mut fresh = NarrowEnv::new();
                            {
                                let clause_cx = Ctx {
                                    module: cx.module,
                                    file: cx.file,
                                    text: cx.text,
                                    narrow: &clause_env,
                                    strict: cx.strict,
                                    server_default: cx.server_default,
                                };
                                self.collect_narrow(&clause_cx, value, false, &mut fresh);
                            }
                            clause_env.extend(fresh);
                        }
                    }
                }
                "order" => {
                    let clause_cx = Ctx {
                        module: cx.module,
                        file: cx.file,
                        text: cx.text,
                        narrow: &clause_env,
                        strict: cx.strict,
                        server_default: cx.server_default,
                    };
                    for value in kids(part) {
                        if is_expression(value.kind) {
                            let ty = self.expr(&clause_cx, value, None);
                            self.check_order_key(&clause_cx, value, &ty);
                        }
                    }
                }
                "select" => {
                    let clause_cx = Ctx {
                        module: cx.module,
                        file: cx.file,
                        text: cx.text,
                        narrow: &clause_env,
                        strict: cx.strict,
                        server_default: cx.server_default,
                    };
                    for value in kids(part) {
                        if is_expression(value.kind) {
                            let ty = self.expr(&clause_cx, value, None);
                            if !ty.is_error() {
                                projected = Some(ty);
                                element = projected.clone().unwrap_or(ResolvedType::Error);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let _ = &mut ordered;
        let result = ResolvedType::Array {
            element: Box::new(projected.unwrap_or(element.clone())),
            ordered,
            nonempty: false,
        };
        self.rows.insert(
            NodeKey::of(node),
            match &result {
                ResolvedType::Array { element, .. } => (**element).clone(),
                _ => ResolvedType::Error,
            },
        );
        result
    }

    /// True-facts of a query's `where` clauses about the
    /// query's OWN row alias (T07): every row reaching a row body
    /// satisfies each `where`, so its null tests narrow the
    /// selected row. Only facts keyed on this query's `as`
    /// declarations transfer — collection children inherit their
    /// own selected snapshot's facts, never a sibling's, and
    /// outer-binding facts stay in the query. The query must
    /// already be typed (narrowing reads recorded types).
    fn selected_row_facts(&mut self, cx: &Ctx<'_, '_>, query: &SyntaxNode) -> NarrowEnv {
        let mut own: HashSet<NodeKey> = HashSet::new();
        for part in kids(query) {
            if part.kind == SyntaxKind::QueryClause
                && kids(part)
                    .iter()
                    .find_map(|n| name_text(n, cx.text))
                    .is_some_and(|head| head == "as")
            {
                own.insert(NodeKey::of(part));
            }
        }
        if own.is_empty() {
            return NarrowEnv::new();
        }
        let mut out = NarrowEnv::new();
        let mut acc = cx.narrow.clone();
        for part in kids(query) {
            if part.kind != SyntaxKind::QueryClause
                || kids(part)
                    .iter()
                    .find_map(|n| name_text(n, cx.text))
                    .is_none_or(|head| head != "where")
            {
                continue;
            }
            for value in kids(part) {
                if !is_expression(value.kind) {
                    continue;
                }
                let mut fresh = NarrowEnv::new();
                {
                    let clause_cx = Ctx {
                        module: cx.module,
                        file: cx.file,
                        text: cx.text,
                        narrow: &acc,
                        strict: cx.strict,
                        server_default: cx.server_default,
                    };
                    self.collect_narrow(&clause_cx, value, false, &mut fresh);
                }
                for (key, ty) in fresh {
                    if matches!(&key.decl, DeclKey::QueryAlias(node) if own.contains(node)) {
                        acc.insert(key.clone(), ty.clone());
                        out.insert(key, ty);
                    }
                }
            }
        }
        out
    }

    /// Whether a query reshapes its element with `select` (T07:
    /// row facts remap to the `row`/item binding only when the
    /// element type is unchanged, so narrowed paths still resolve
    /// on the row type).
    fn query_has_select(query: &SyntaxNode, text: &str) -> bool {
        kids(query).iter().any(|part| {
            part.kind == SyntaxKind::QueryClause
                && kids(part)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .is_some_and(|head| head == "select")
        })
    }

    /// An `order` key must be an ordered scalar (`E3006`).
    fn check_order_key(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, ty: &ResolvedType) {
        match ty {
            ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => {}
            ResolvedType::Scalar(s) if s.is_ordered() => {}
            ResolvedType::Nullable(inner) if matches!(**inner, ResolvedType::Scalar(s) if s.is_ordered()) =>
                {}
            other => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3006",
                        format!(
                            "`order` keys must be ordered scalars, found {}",
                            self.show(cx.module, other)
                        ),
                        tight_span(cx.text, node),
                    ));
                }
            }
        }
    }
}

impl<'a> Typer<'a> {
    // --- Calls -----------------------------------------------------------

    /// Type an expression `Call`: builtin overloads from the catalog
    /// (`E6001` when planned, `E3005` on mismatch), derived functions,
    /// messages (result `Message`), role predicates (result `bool`).
    /// Scenarios/capability operations/CRUD operations are invoked
    /// with `call` statements, never expression calls (`E3005`).
    fn type_call(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let parts = kids(node);
        let callee = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(callee) = callee else {
            return ResolvedType::Error;
        };
        let args: Vec<CallArg> = parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::Argument)
            .filter_map(|arg| self.read_argument(cx, arg))
            .collect();
        // Positional fill first, then named (the parser owns order).
        match self.callee_kind(cx, callee) {
            CalleeKind::Error => ResolvedType::Error,
            CalleeKind::Opaque => ResolvedType::Opaque("external callee"),
            CalleeKind::Builtin(id) => self.call_builtin(cx, node, callee, &id, &args),
            CalleeKind::DeriveFn(id) => self.call_user_fn(cx, node, id, &args, "derived function"),
            CalleeKind::Message(id) => self.call_message(cx, node, id, &args),
            CalleeKind::Role(id) => self.call_role(cx, node, callee, id, &args),
            CalleeKind::NotCallable(reason) => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3005",
                        reason,
                        tight_span(cx.text, callee),
                    ));
                }
                // Still type the arguments (inner errors surface).
                for arg in &args {
                    self.expr(cx, arg.value, None);
                }
                ResolvedType::Error
            }
        }
    }

    /// Read one `Argument` node: positional (bare value) or named.
    fn read_argument<'n>(&self, cx: &Ctx<'_, '_>, arg: &'n SyntaxNode) -> Option<CallArg<'n>> {
        let arg_parts = kids(arg);
        if arg_parts.len() >= 3
            && arg_parts[0].kind == SyntaxKind::Name
            && is_punct(arg_parts[1], cx.text, "=")
        {
            let name = name_text(arg_parts[0], cx.text)?.to_string();
            let value = arg_parts[2..]
                .iter()
                .find(|n| is_expression(n.kind))
                .copied()?;
            Some(CallArg {
                name: Some(name),
                value,
                node: arg,
            })
        } else {
            let value = arg_parts.iter().find(|n| is_expression(n.kind)).copied()?;
            Some(CallArg {
                name: None,
                value,
                node: arg,
            })
        }
    }

    /// Classify an expression callee.
    fn callee_kind(&mut self, cx: &Ctx<'_, '_>, callee: &SyntaxNode) -> CalleeKind {
        let mut current = callee;
        loop {
            match current.kind {
                SyntaxKind::Group => {
                    let parts = kids(current);
                    let Some(inner) = parts.iter().find(|n| is_expression(n.kind)) else {
                        return CalleeKind::Error;
                    };
                    current = *inner;
                }
                SyntaxKind::NameRef => {
                    let key = NodeKey::of(current);
                    let name = kids(current)
                        .iter()
                        .find_map(|n| name_text(n, cx.text))
                        .unwrap_or("?");
                    return match self.tables.node_binding.get(&key).cloned() {
                        None => CalleeKind::Error,
                        Some(Binding::Error) => CalleeKind::Error,
                        Some(Binding::External { .. }) => CalleeKind::Opaque,
                        Some(Binding::Builtin { id }) => CalleeKind::Builtin(id),
                        Some(Binding::Symbol(id)) => {
                            match &self.tables.symbols[id.0 as usize].kind {
                                SymbolKind::DeriveFn { .. } => CalleeKind::DeriveFn(id),
                                SymbolKind::Message { .. } => CalleeKind::Message(id),
                                SymbolKind::Role => CalleeKind::Role(id),
                                SymbolKind::Scenario { .. }
                                | SymbolKind::CapabilityOp { .. }
                                | SymbolKind::CrudOp { .. } => CalleeKind::NotCallable(format!(
                                    "'{}' is an operation; invoke it with a `call` statement, not an expression call",
                                    record_name(self.tables, cx.module, id)
                                )),
                                SymbolKind::Model { .. } => CalleeKind::NotCallable(format!(
                                    "'{}' is a model; create rows with `create` or construct values with {} {{…}}",
                                    record_name(self.tables, cx.module, id),
                                    record_name(self.tables, cx.module, id),
                                )),
                                SymbolKind::Contract { .. } | SymbolKind::Event { .. } => {
                                    CalleeKind::NotCallable(format!(
                                        "'{}' is not callable; construct values with {} {{…}}",
                                        record_name(self.tables, cx.module, id),
                                        record_name(self.tables, cx.module, id),
                                    ))
                                }
                                _ => CalleeKind::NotCallable(format!("'{name}' is not callable")),
                            }
                        }
                        _ => CalleeKind::NotCallable(format!("'{name}' is not callable")),
                    };
                }
                SyntaxKind::Member => {
                    // `Mail.send(…)` in an expression: operations are
                    // still invoked with `call` statements.
                    let ty = self.expr(cx, current, None);
                    return match ty {
                        ResolvedType::Operation(id) => CalleeKind::NotCallable(format!(
                            "'{}' is an operation; invoke it with a `call` statement, not an expression call",
                            record_name(self.tables, cx.module, id)
                        )),
                        ResolvedType::Error => CalleeKind::Error,
                        ResolvedType::Opaque(_) | ResolvedType::Unknown => CalleeKind::Opaque,
                        _ => CalleeKind::NotCallable("this value is not callable".to_string()),
                    };
                }
                _ => {
                    let ty = self.expr(cx, current, None);
                    return match ty {
                        ResolvedType::Error => CalleeKind::Error,
                        ResolvedType::Opaque(_) | ResolvedType::Unknown => CalleeKind::Opaque,
                        _ => CalleeKind::NotCallable("this value is not callable".to_string()),
                    };
                }
            }
        }
    }

    /// Call a catalog builtin: availability first (`E6001` for
    /// planned), then overload matching (`E3005`). Arguments always
    /// type (inner errors surface); matching is skipped when any
    /// argument is poisoned.
    fn call_builtin(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        callee: &SyntaxNode,
        id: &str,
        args: &[CallArg],
    ) -> ResolvedType {
        let catalog = match self.catalog {
            Some(catalog) => catalog,
            None => return ResolvedType::Error,
        };
        // Availability: planned builtins cannot compile (`E6001`,
        // even in light positions — a position-independent fact).
        if catalog.availability(id) == Some(Availability::Planned) {
            let owner = catalog.lookup(id).map(|e| e.owner.as_str()).unwrap_or("");
            self.diags.push(Diagnostic::error(
                "E6001",
                if owner.is_empty() {
                    format!("builtin '{id}' is planned but not implemented yet")
                } else {
                    format!("builtin '{id}' is planned but not implemented yet (owner: {owner})")
                },
                tight_span(cx.text, callee),
            ));
            for arg in args {
                self.expr(cx, arg.value, None);
            }
            return ResolvedType::Error;
        }
        // Defensive only: the resolver already reports helper uses
        // as `E2006` and binds them `Error`, so a helper callee never
        // reaches this builtin path (N12).
        if catalog.is_helper(id) {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3005",
                    format!("'{id}' is a code-generation helper, not a callable builtin"),
                    tight_span(cx.text, callee),
                ));
            }
            for arg in args {
                self.expr(cx, arg.value, None);
            }
            return ResolvedType::Error;
        }
        // `random_secret()` is server-default-only (DESIGN §3).
        if catalog.effects(id) == Some(Effects::ServerDefaultOnly)
            && !cx.server_default
            && cx.strict
        {
            self.diags.push(Diagnostic::error(
                "E3005",
                format!("'{id}()' is permitted only in server defaults"),
                tight_span(cx.text, callee),
            ));
        }
        let overloads = catalog.overloads(id).unwrap_or(&[]).to_vec();
        // Type arguments without expectations first (expectations
        // apply per-overload during matching). Matching is
        // poison-tolerant: inner errors surface on their own.
        let mut typed: Vec<ResolvedType> = Vec::with_capacity(args.len());
        for arg in args {
            typed.push(self.expr(cx, arg.value, None));
        }
        let names_ok = self.check_catalog_arg_names(cx, id, args, &overloads);
        let arity_ok = self.check_catalog_arity(cx, node, id, args, &overloads);
        if names_ok && arity_ok {
            let mut literal_fail: Option<(Span, String)> = None;
            let mut cases_fail: Option<(NodeKey, Span, Vec<String>)> = None;
            // Best match wins: DESIGN §3 lists general overloads before
            // their `nonempty`/`ordered` twins, which would be dead under
            // first-match (every nonempty domain also inhabits the
            // general shape). Ties keep catalog order.
            let mut best: Option<(usize, ResolvedType, usize, Trial, Vec<usize>)> = None;
            for (index, overload) in overloads.iter().enumerate() {
                let mut trial = Trial::default();
                if let Some((result, slots)) =
                    self.try_overload(cx, overload, args, &typed, &mut trial)
                {
                    let score: usize = overload
                        .params
                        .iter()
                        .map(|param| Self::overload_specificity_count(&param.ty))
                        .sum();
                    let replace = best.as_ref().is_none_or(|(_, _, held, _, _)| score > *held);
                    if replace {
                        best = Some((index, result, score, trial, slots));
                    }
                    continue;
                }
                if literal_fail.is_none() {
                    literal_fail = trial.literal_fail;
                }
                if cases_fail.is_none() {
                    cases_fail = trial.cases_fail;
                }
            }
            if let Some((index, result, _, trial, slots)) = best {
                for (key, ty) in &trial.claimed {
                    self.types.resolved_cases.insert(*key);
                    self.types.node_types.insert(*key, ty.clone());
                }
                self.types.selected_calls.insert(
                    NodeKey::of(node),
                    SelectedCall {
                        target: SelectedCallTarget::Builtin {
                            id: id.to_string(),
                            overload: index,
                        },
                        arguments: args.iter().map(|arg| NodeKey::of(arg.value)).collect(),
                        slots: slots.iter().copied().map(Some).collect(),
                    },
                );
                let ordered_args: Vec<_> = slots.iter().map(|&slot| args[slot].clone()).collect();
                let ordered_types: Vec<_> = slots.iter().map(|&slot| typed[slot].clone()).collect();
                return self.finish_builtin_call(
                    cx,
                    &overloads[index],
                    id,
                    &ordered_args,
                    &ordered_types,
                    result,
                );
            }
            // Failure precedence: precise literal shape (`E3001`) >
            // precise case expectation (`E3005`) > generic mismatch
            // (`E3005`, suppressed when an unbound name explains it).
            if cx.strict {
                if let Some((span, message)) = literal_fail {
                    self.diags.push(Diagnostic::error("E3001", message, span));
                } else if let Some((key, span, cases)) = cases_fail {
                    // The precise expectation covers this name: no
                    // separate `E2001`.
                    self.types.resolved_cases.insert(key);
                    self.diags.push(Diagnostic::error(
                        "E3005",
                        format!("expected one of {}", cases.join("|")),
                        span,
                    ));
                } else if !self.any_unclaimed_name(args) {
                    let actuals: Vec<String> =
                        typed.iter().map(|t| self.show(cx.module, t)).collect();
                    self.diags.push(Diagnostic::error(
                        "E3005",
                        format!("no overload of '{id}' matches ({})", actuals.join(", ")),
                        tight_span(cx.text, node),
                    ));
                }
            }
        }
        ResolvedType::Error
    }

    /// Count of `nonempty`/`ordered` collection markers in one
    /// overload's parameter shapes: best-match specificity.
    fn overload_specificity_count(shape: &SigType) -> usize {
        match shape {
            SigType::NonemptyCollection(inner) | SigType::OrderedCollection(inner) => {
                1 + Self::overload_specificity_count(inner)
            }
            SigType::Collection(inner) | SigType::Nullable(inner) | SigType::Array(inner) => {
                Self::overload_specificity_count(inner)
            }
            SigType::Union(arms) => arms.iter().map(Self::overload_specificity_count).sum(),
            SigType::Object(fields) => fields
                .iter()
                .map(|(_, field)| Self::overload_specificity_count(field))
                .sum(),
            _ => 0,
        }
    }

    /// Whether any argument is an unbound name the matcher did not
    /// claim (its own `E2001` covers the call, so a generic `E3005`
    /// would be cascade noise).
    fn any_unclaimed_name(&self, args: &[CallArg]) -> bool {
        args.iter().any(|arg| {
            let mut current = arg.value;
            loop {
                match current.kind {
                    SyntaxKind::Group => {
                        let Some(inner) = kids(current)
                            .iter()
                            .find(|n| is_expression(n.kind))
                            .copied()
                        else {
                            return false;
                        };
                        current = inner;
                    }
                    SyntaxKind::NameRef => {
                        let key = NodeKey::of(current);
                        if self.types.resolved_cases.contains(&key) {
                            return false;
                        }
                        return matches!(
                            self.tables.node_binding.get(&key),
                            None | Some(Binding::Error)
                        );
                    }
                    _ => return false,
                }
            }
        })
    }

    /// Post-match checks for builtins with DESIGN rules beyond their
    /// signatures: `format` template keys, `date`/`datetime` literal
    /// shapes, `round` scale bounds, `dates` limit positivity, and the
    /// `local_instant` wall-time shape.
    fn finish_builtin_call(
        &mut self,
        cx: &Ctx<'_, '_>,
        overload: &SigOverload,
        id: &str,
        args: &[CallArg],
        typed: &[ResolvedType],
        result: ResolvedType,
    ) -> ResolvedType {
        match id {
            "format" => self.check_format_call(cx, args, typed),
            "date" => self.check_checked_constructor(cx, args, "date"),
            "datetime" => self.check_checked_constructor(cx, args, "datetime"),
            "round" => self.check_round_scale(cx, overload, args),
            "dates" => self.check_dates_limit(cx, overload, args),
            "local_instant" => self.check_local_instant_time(cx, overload, args),
            _ => {}
        }
        result
    }

    /// `round` scale literals must be 0–18 (DESIGN §3: other scales
    /// fail; non-literals fail at runtime).
    fn check_round_scale(&mut self, cx: &Ctx<'_, '_>, overload: &SigOverload, args: &[CallArg]) {
        if !cx.strict {
            return;
        }
        let Some(arg) = bound_arg(overload, args, "scale") else {
            return;
        };
        if let Some(scale) = int_literal_value(arg.value, cx.text)
            && !(0..=18).contains(&scale)
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("`round` scale must be 0–18, found {scale}"),
                tight_span(cx.text, arg.value),
            ));
        }
    }

    /// `dates` limit literals must be positive (DESIGN §3: nonpositive
    /// limits fail; non-literals fail at runtime).
    fn check_dates_limit(&mut self, cx: &Ctx<'_, '_>, overload: &SigOverload, args: &[CallArg]) {
        if !cx.strict {
            return;
        }
        let Some(arg) = bound_arg(overload, args, "limit") else {
            return;
        };
        if let Some(limit) = int_literal_value(arg.value, cx.text)
            && limit <= 0
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("`dates` limit must be positive, found {limit}"),
                tight_span(cx.text, arg.value),
            ));
        }
    }

    /// `local_instant` time literals must be `HH:MM[:SS]` (DESIGN §3;
    /// non-literals validate at runtime).
    fn check_local_instant_time(
        &mut self,
        cx: &Ctx<'_, '_>,
        overload: &SigOverload,
        args: &[CallArg],
    ) {
        if !cx.strict {
            return;
        }
        let Some(arg) = bound_arg(overload, args, "time") else {
            return;
        };
        let Some(value) = string_literal_value(arg.value) else {
            return;
        };
        if let Some(problem) = valid_wall_time(&value) {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("`{value}` is not a valid `local_instant` time: {problem}"),
                tight_span(cx.text, arg.value),
            ));
        }
    }

    /// `format` template/values cross-check: every `{key}` exists in
    /// the closed values object; literal templates must be well
    /// formed (`E3005`).
    fn check_format_call(&mut self, cx: &Ctx<'_, '_>, args: &[CallArg], typed: &[ResolvedType]) {
        if !cx.strict || args.len() != 2 {
            return;
        }
        // Message overload: first argument is a message (a declared
        // message value or an inline `"…"@{…}` descriptor, which
        // `expr` types `text`).
        let first_is_message = matches!(typed.first(), Some(ResolvedType::Message(_)))
            || (matches!(typed.first(), Some(ResolvedType::Scalar(Scalar::Text)))
                && is_message_descriptor(args[0].value));
        if first_is_message {
            return;
        }
        let ResolvedType::Object(fields) = &typed[1] else {
            return;
        };
        let Some(template) = string_literal_value(args[0].value) else {
            return;
        };
        match scan_format_template(&template) {
            Err(problem) => {
                self.diags.push(Diagnostic::error(
                    "E3005",
                    format!("malformed `format` template: {problem}"),
                    tight_span(cx.text, args[0].value),
                ));
            }
            Ok(keys) => {
                for key in keys {
                    if !fields.iter().any(|(k, _)| k == &key) {
                        self.diags.push(Diagnostic::error(
                            "E3005",
                            format!("`format` placeholder '{{{key}}}' has no values entry"),
                            tight_span(cx.text, args[0].value),
                        ));
                    }
                }
            }
        }
    }

    /// `date`/`datetime` checked constructors validate literal shapes
    /// (`E3001`); non-literals validate at runtime.
    fn check_checked_constructor(&mut self, cx: &Ctx<'_, '_>, args: &[CallArg], which: &str) {
        if !cx.strict || args.len() != 1 {
            return;
        }
        let Some(value) = string_literal_value(args[0].value) else {
            return;
        };
        let problem = match which {
            "date" => valid_date(&value).err(),
            _ => valid_datetime(&value).err(),
        };
        if let Some(problem) = problem {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("`{value}` is not a valid {which}: {problem}"),
                tight_span(cx.text, args[0].value),
            ));
        }
    }

    /// Call a derived function: positional/named binding, defaults
    /// omittable, `E3005` on arity/name errors, `E3001` on value
    /// mismatches.
    fn call_user_fn(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: SymbolId,
        args: &[CallArg],
        what: &str,
    ) -> ResolvedType {
        self.record_call_edge(tight_span(cx.text, node), id);
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::DeriveFn { params, .. } => params.clone(),
            _ => Vec::new(),
        };
        let bound = self.bind_arguments(cx, node, id, &params, args, what);
        let Some(bound) = bound else {
            return ResolvedType::Error;
        };
        self.publish_decl_call(
            node,
            SelectedCallTarget::DeriveFn(id),
            &params,
            args,
            &bound,
        );
        for (param, arg) in &bound {
            let expected = self.decl_type(*param);
            let actual = self.expr(cx, arg.value, Some(expected.clone()));
            if !actual.is_error() {
                self.assign_ok(
                    cx,
                    tight_span(cx.text, arg.value),
                    &actual,
                    &expected,
                    &format!("argument '{}'", self.tables.symbols[param.0 as usize].name),
                );
            }
        }
        match self.results.get(&id).cloned() {
            Some(Some(ty)) => ty,
            Some(None) | None => ResolvedType::Opaque("unresolved function result"),
        }
    }

    /// Call a message: like a user function, rendering `text`.
    fn call_message(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: SymbolId,
        args: &[CallArg],
    ) -> ResolvedType {
        let params = match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Message { params } => params.clone(),
            _ => Vec::new(),
        };
        let bound = self.bind_arguments(cx, node, id, &params, args, "message");
        let Some(bound) = bound else {
            return ResolvedType::Error;
        };
        self.publish_decl_call(node, SelectedCallTarget::Message(id), &params, args, &bound);
        for (param, arg) in &bound {
            let expected = self.decl_type(*param);
            let actual = self.expr(cx, arg.value, Some(expected.clone()));
            if !actual.is_error() {
                self.assign_ok(
                    cx,
                    tight_span(cx.text, arg.value),
                    &actual,
                    &expected,
                    &format!("argument '{}'", self.tables.symbols[param.0 as usize].name),
                );
            }
        }
        // A bound message call is still a message value (rendered at
        // its sink, including explicit-locale `format`); it is not
        // eagerly rendered text.
        ResolvedType::Message(id)
    }

    /// Call a role as a subject predicate: exactly one user/member
    /// argument, result `bool`.
    fn call_role(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        callee: &SyntaxNode,
        id: SymbolId,
        args: &[CallArg],
    ) -> ResolvedType {
        let name = record_name(self.tables, cx.module, id);
        if args.len() != 1 || args[0].name.is_some() {
            if cx.strict {
                self.diags.push(Diagnostic::error(
                    "E3005",
                    format!("role predicate '{name}' takes exactly one subject argument"),
                    tight_span(cx.text, node),
                ));
            }
            for arg in args {
                self.expr(cx, arg.value, None);
            }
            return ResolvedType::Error;
        }
        let actual = self.expr(cx, args[0].value, None);
        if actual.is_error() {
            return ResolvedType::Error;
        }
        let result = match &actual {
            ResolvedType::Scalar(Scalar::User) | ResolvedType::Scalar(Scalar::Member) => {
                ResolvedType::Scalar(Scalar::Bool)
            }
            ResolvedType::Opaque(_) | ResolvedType::Unknown => ResolvedType::Opaque("role subject"),
            other => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "role predicate '{name}' needs a user or member subject, found {}",
                            self.show(cx.module, other)
                        ),
                        tight_span(cx.text, args[0].value),
                    ));
                }
                let _ = callee;
                ResolvedType::Error
            }
        };
        if !result.is_error() {
            self.types.selected_calls.insert(
                NodeKey::of(node),
                SelectedCall {
                    target: SelectedCallTarget::Role(id),
                    arguments: vec![NodeKey::of(args[0].value)],
                    slots: vec![Some(0)],
                },
            );
        }
        result
    }

    fn publish_decl_call(
        &mut self,
        node: &SyntaxNode,
        target: SelectedCallTarget,
        params: &[SymbolId],
        args: &[CallArg],
        bound: &[(SymbolId, CallArg)],
    ) {
        let slots = params
            .iter()
            .map(|param| {
                bound
                    .iter()
                    .find(|(id, _)| id == param)
                    .map(|(_, supplied)| {
                        args.iter()
                            .position(|arg| NodeKey::of(arg.node) == NodeKey::of(supplied.node))
                            .expect("bound argument came from this call")
                    })
            })
            .collect();
        self.types.selected_calls.insert(
            NodeKey::of(node),
            SelectedCall {
                target,
                arguments: args.iter().map(|arg| NodeKey::of(arg.value)).collect(),
                slots,
            },
        );
    }

    /// Bind call arguments to parameters: positionals fill in order,
    /// named match by name; unknown names, duplicates (defensive) and
    /// missing required parameters are `E3005`. Returns the bound
    /// pairs, or `None` on failure (arguments still typed).
    fn bind_arguments<'n>(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: SymbolId,
        params: &[SymbolId],
        args: &[CallArg<'n>],
        what: &str,
    ) -> Option<Vec<(SymbolId, CallArg<'n>)>> {
        let name = record_name(self.tables, cx.module, id);
        let mut bound: Vec<(SymbolId, CallArg)> = Vec::new();
        let mut used: HashSet<SymbolId> = HashSet::new();
        let mut positional = 0usize;
        let mut bad = false;
        for arg in args {
            match &arg.name {
                None => {
                    // Next unfilled parameter in order.
                    let next = params.iter().find(|p| !used.contains(p));
                    match next {
                        Some(param) => {
                            used.insert(*param);
                            bound.push((*param, arg.clone()));
                            positional += 1;
                        }
                        None => {
                            if cx.strict {
                                self.diags.push(Diagnostic::error(
                                    "E3005",
                                    format!(
                                        "{what} '{name}' takes {} parameters, given too many",
                                        params.len()
                                    ),
                                    tight_span(cx.text, arg.node),
                                ));
                            }
                            bad = true;
                        }
                    }
                }
                Some(arg_name) => {
                    let found = params
                        .iter()
                        .find(|p| self.tables.symbols[p.0 as usize].name == *arg_name);
                    match found {
                        Some(param) => {
                            if !used.insert(*param) {
                                if cx.strict {
                                    self.diags.push(Diagnostic::error(
                                        "E3005",
                                        format!(
                                            "duplicate argument '{arg_name}' to {what} '{name}'"
                                        ),
                                        tight_span(cx.text, arg.node),
                                    ));
                                }
                                bad = true;
                            } else {
                                bound.push((*param, arg.clone()));
                            }
                        }
                        None => {
                            if cx.strict {
                                self.diags.push(Diagnostic::error(
                                    "E3005",
                                    format!("{what} '{name}' has no parameter '{arg_name}'"),
                                    tight_span(cx.text, arg.node),
                                ));
                            }
                            bad = true;
                        }
                    }
                }
            }
        }
        if !bad {
            for param in params {
                if !used.contains(param) && !self.param_has_default(*param) {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3005",
                            format!(
                                "missing required argument '{}' to {what} '{name}'",
                                self.tables.symbols[param.0 as usize].name
                            ),
                            tight_span(cx.text, node),
                        ));
                    }
                    bad = true;
                }
            }
        }
        let _ = positional;
        if bad {
            for arg in args {
                self.expr(cx, arg.value, None);
            }
            return None;
        }
        Some(bound)
    }
}

impl<'a> Typer<'a> {
    // --- Overload matching ---------------------------------------------

    /// Named-argument pre-check: every named argument must name a
    /// parameter of at least one overload (`E3005` otherwise). Returns
    /// `false` when the call is already doomed (arguments still typed
    /// by the caller).
    fn check_catalog_arg_names(
        &mut self,
        cx: &Ctx<'_, '_>,
        id: &str,
        args: &[CallArg],
        overloads: &[SigOverload],
    ) -> bool {
        let mut ok = true;
        for arg in args {
            let Some(want) = &arg.name else { continue };
            let known = overloads
                .iter()
                .flat_map(|o| o.params.iter())
                .any(|p| &p.name == want);
            if !known {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3005",
                        format!("'{id}' has no parameter '{want}'"),
                        tight_span(cx.text, arg.node),
                    ));
                }
                ok = false;
            }
        }
        ok
    }

    /// Arity pre-check: the argument count must match at least one
    /// overload (`E3005` otherwise).
    fn check_catalog_arity(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: &str,
        args: &[CallArg],
        overloads: &[SigOverload],
    ) -> bool {
        let mut arities: Vec<usize> = overloads.iter().map(|o| o.params.len()).collect();
        arities.sort_unstable();
        arities.dedup();
        if arities.contains(&args.len()) {
            return true;
        }
        if cx.strict {
            let expects = arities
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(" or ");
            self.diags.push(Diagnostic::error(
                "E3005",
                format!("'{id}' takes {expects} arguments, given {}", args.len()),
                tight_span(cx.text, node),
            ));
        }
        false
    }

    /// Try one overload: bind arguments to parameters (positional
    /// fill, then named), then match each parameter shape. Trial
    /// bindings are local; enum claims and literal re-types persist
    /// (a claim is correct whenever the expectation was).
    fn try_overload(
        &mut self,
        cx: &Ctx<'_, '_>,
        overload: &SigOverload,
        args: &[CallArg],
        typed: &[ResolvedType],
        trial: &mut Trial,
    ) -> Option<(ResolvedType, Vec<usize>)> {
        if overload.params.len() != args.len() {
            return None;
        }
        // Bind: positionals fill in order, named match by name.
        let mut slots: Vec<Option<usize>> = vec![None; overload.params.len()];
        for (index, arg) in args.iter().enumerate() {
            match &arg.name {
                None => {
                    let slot = slots.iter_mut().find(|s| s.is_none())?;
                    *slot = Some(index);
                }
                Some(want) => {
                    let slot = overload
                        .params
                        .iter()
                        .position(|p| &p.name == want)
                        .and_then(|pi| slots[pi].is_none().then_some(pi))?;
                    slots[slot] = Some(index);
                }
            }
        }
        // Match in parameter order (action targets bind before their
        // bindings objects are checked).
        for (param, slot) in overload.params.iter().zip(slots.iter().copied()) {
            let index = slot.expect("arity checked");
            let arg = &args[index];
            let actual = &typed[index];
            if !self.match_shape(cx, arg, actual, &param.ty, trial) {
                return None;
            }
        }
        Some((
            self.subst_shape(&overload.result, trial),
            slots
                .into_iter()
                .map(|slot| slot.expect("arity checked"))
                .collect(),
        ))
    }

    /// Match one argument against a signature shape, binding `T/O/S/K`
    /// variables into the trial. Error-typed arguments match
    /// (poison-tolerant; their own diagnostic covers them). Returns
    /// `false` on mismatch (no diagnostics during trials).
    fn match_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        shape: &SigType,
        trial: &mut Trial,
    ) -> bool {
        // Poison-tolerant: inner errors surface on their own.
        if actual.is_error() {
            // Unbound names may still be enum claims.
            if let SigType::EnumCases(cases) = shape {
                let claim_as = ResolvedType::Enum {
                    cases: cases.clone(),
                    owner: None,
                };
                return self.claim_enum_case(cx, arg.value, cases, claim_as, trial);
            }
            return true;
        }
        match shape {
            SigType::Any => self.bind_var(trial, SigVar::T, actual),
            SigType::Ordered => match actual {
                ResolvedType::Scalar(s) if s.is_ordered() => {
                    self.bind_var(trial, SigVar::O, actual)
                }
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::StringLike => match actual {
                ResolvedType::Scalar(s) if s.is_string_like() => {
                    self.bind_var(trial, SigVar::S, actual)
                }
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::GroupKey => {
                if !group_key_ok(actual) {
                    return false;
                }
                self.bind_var(trial, SigVar::K, actual)
            }
            SigType::Display => {
                if !display_ok(actual) {
                    return false;
                }
                self.bind_var(trial, SigVar::D, actual)
            }
            SigType::Named(name) => self.match_named(cx, arg, actual, name, trial),
            SigType::Collection(inner) => match actual {
                ResolvedType::Array { element, .. } => {
                    self.match_shape(cx, arg, element, inner, trial)
                }
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::OrderedCollection(inner) => match actual {
                ResolvedType::Array {
                    element, ordered, ..
                } if *ordered => self.match_shape(cx, arg, element, inner, trial),
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::NonemptyCollection(inner) => match actual {
                ResolvedType::Array {
                    element, nonempty, ..
                } if *nonempty => self.match_shape(cx, arg, element, inner, trial),
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::Array(inner) => match actual {
                ResolvedType::Array { element, .. } => {
                    self.match_shape(cx, arg, element, inner, trial)
                }
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::Nullable(inner) => match actual {
                ResolvedType::Nullable(inner_actual) => {
                    self.match_shape(cx, arg, inner_actual, inner, trial)
                }
                ResolvedType::Null => true,
                // Non-null values inhabit nullable shapes.
                _ => self.match_shape(cx, arg, actual, inner, trial),
            },
            SigType::Union(arms) => {
                for arm in arms {
                    let mut fork = trial.fork();
                    if self.match_shape(cx, arg, actual, arm, &mut fork) {
                        trial.commit(fork);
                        return true;
                    }
                }
                false
            }
            SigType::EnumCases(cases) => {
                // An already-enum-typed value matches when every one
                // of its cases is admitted (width-subtyping on case
                // sets: each possible value inhabits the shape);
                // anything else falls through to literal claiming.
                if let ResolvedType::Enum {
                    cases: actual_cases,
                    ..
                } = actual
                {
                    return actual_cases.iter().all(|c| cases.contains(c));
                }
                let claim_as = ResolvedType::Enum {
                    cases: cases.clone(),
                    owner: None,
                };
                self.claim_enum_case(cx, arg.value, cases, claim_as, trial)
            }
            SigType::Object(fields) => {
                let ResolvedType::Object(actual_fields) = actual else {
                    return matches!(actual, ResolvedType::Unknown | ResolvedType::Opaque(_));
                };
                // Closed: exact key sets.
                if actual_fields.len() != fields.len() {
                    return false;
                }
                for (name, ty) in fields {
                    let Some((_, value)) = actual_fields.iter().find(|(k, _)| k == name) else {
                        return false;
                    };
                    if !self.match_shape(cx, arg, value, ty, trial) {
                        return false;
                    }
                }
                true
            }
            SigType::ClosedDisplayObject => match actual {
                ResolvedType::Object(actual_fields) => {
                    actual_fields.iter().all(|(_, v)| display_nonnull(v))
                }
                ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
                _ => false,
            },
            SigType::Message => {
                matches!(
                    actual,
                    ResolvedType::Message(_) | ResolvedType::Unknown | ResolvedType::Opaque(_)
                ) || (matches!(actual, ResolvedType::Scalar(Scalar::Text))
                    && is_message_descriptor(arg.value))
            }
            SigType::ActionTarget => self.match_action_target(cx, arg, actual, trial),
            SigType::ActionBindings => self.match_action_bindings(cx, arg, actual, trial),
            SigType::InvocationArgs => self.match_invocation_args(cx, arg, actual, trial),
            // Results-only shapes never appear as parameters.
            SigType::ActionResult | SigType::InvocationResult => false,
        }
    }

    /// Bind a signature variable: first binding wins, later matches
    /// must be loosely equal.
    fn bind_var(&self, trial: &mut Trial, var: SigVar, actual: &ResolvedType) -> bool {
        match trial.bindings.get(&var) {
            None => {
                trial.bindings.insert(var, actual.clone());
                true
            }
            Some(bound) => loose_equal(bound, actual),
        }
    }

    /// Match a nominal shape: exact scalars, `Team`/`OperationContext`,
    /// literal inhabitation for validated strings, lenient unknowns.
    fn match_named(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        name: &str,
        trial: &mut Trial,
    ) -> bool {
        if matches!(actual, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
            return true;
        }
        if name == "Team" {
            return matches!(actual, ResolvedType::Team);
        }
        if name == "OperationContext" {
            return matches!(actual, ResolvedType::OperationContext);
        }
        let Some(want) = scalar_named(name) else {
            // Dotted nominals and lane-owned shapes: lenient.
            return true;
        };
        match actual {
            ResolvedType::Scalar(got) if *got == want => true,
            ResolvedType::Scalar(Scalar::Text) if want.is_validated_leaf() => {
                self.inhabit_validated(cx, arg, want, trial)
            }
            _ => false,
        }
    }

    /// Inhabit a validated string-like from a text literal: valid
    /// literals re-type to the leaf; invalid ones record a precise
    /// `E3001` for the no-match path and fail the trial. Non-literal
    /// text never proves the shape (DESIGN §3).
    fn inhabit_validated(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        want: Scalar,
        trial: &mut Trial,
    ) -> bool {
        let leaf = arg.value;
        let text = string_literal_value(leaf);
        let Some(text) = text else {
            return false;
        };
        match validated_shape(want, &text) {
            None => {
                self.record(leaf, ResolvedType::Scalar(want));
                true
            }
            Some(problem) => {
                trial.literal_fail.get_or_insert_with(|| {
                    (
                        tight_span(cx.text, leaf),
                        format!("`{text}` is not a valid {}: {problem}", want.as_str()),
                    )
                });
                false
            }
        }
    }

    /// Claim an unbound name as one of the expected enum cases.
    /// Wrong spellings record a precise `E3005` for the no-match path
    /// and fail the trial; bound values fail silently. The claim
    /// records `claim_as` (the expectation: catalog cases carry no
    /// owner, declared fields/parameters do).
    fn claim_enum_case(
        &mut self,
        cx: &Ctx<'_, '_>,
        value: &SyntaxNode,
        cases: &[String],
        claim_as: ResolvedType,
        trial: &mut Trial,
    ) -> bool {
        let mut current = value;
        loop {
            match current.kind {
                SyntaxKind::Group => {
                    let Some(inner) = kids(current)
                        .iter()
                        .find(|n| is_expression(n.kind))
                        .copied()
                    else {
                        return false;
                    };
                    current = inner;
                }
                SyntaxKind::NameRef => {
                    let Some(spelling) = kids(current).iter().find_map(|n| name_text(n, cx.text))
                    else {
                        return false;
                    };
                    let key = NodeKey::of(current);
                    match self.tables.node_binding.get(&key).cloned() {
                        Some(Binding::Error) | None => {
                            if cases.iter().any(|c| c == spelling) {
                                // Deferred: only the winning overload's
                                // claims flush (losers must not suppress
                                // `E2001` for names they merely resemble).
                                trial.claimed.push((key, claim_as));
                                return true;
                            }
                            trial.cases_fail.get_or_insert_with(|| {
                                (key, tight_span(cx.text, current), cases.to_vec())
                            });
                            return false;
                        }
                        _ => return false,
                    }
                }
                _ => return false,
            }
        }
    }

    /// Match an action target: a non-trusted, non-read scenario or
    /// an enabled CRUD operation; records the operation for the
    /// bindings check and the `Action` result.
    fn match_action_target(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        trial: &mut Trial,
    ) -> bool {
        if matches!(actual, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
            return true;
        }
        let ResolvedType::Operation(id) = actual else {
            return false;
        };
        if !self.is_mutation_target(*id) {
            return false;
        }
        let _ = (cx, arg);
        trial.action_op = Some(*id);
        true
    }

    /// Match action bindings: a closed object over exactly the
    /// target operation's record-typed parameters (DESIGN §2.1: bind
    /// every record parameter with its identity; non-record business
    /// arguments remain inputs and must not appear). CRUD update/delete
    /// bind `record`; a child-model create binds its protected `parent`;
    /// anything else binds nothing.
    fn match_action_bindings(
        &mut self,
        cx: &Ctx<'_, '_>,
        _arg: &CallArg,
        actual: &ResolvedType,
        trial: &mut Trial,
    ) -> bool {
        if matches!(actual, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
            return true;
        }
        let ResolvedType::Object(fields) = actual else {
            return false;
        };
        let Some(op) = trial.action_op else {
            return false;
        };
        let mut expected: Vec<(String, ResolvedType)> = Vec::new();
        match &self.tables.symbols[op.0 as usize].kind {
            SymbolKind::Scenario { params, .. } => {
                for param in params.clone() {
                    let ty = self.decl_type(param);
                    let (base, _) = strip_nullable(&ty);
                    if let ResolvedType::Record { symbol, .. } = base
                        && matches!(
                            self.tables.symbols[symbol.0 as usize].kind,
                            SymbolKind::Model { .. }
                        )
                    {
                        expected.push((self.tables.symbols[param.0 as usize].name.clone(), ty));
                    }
                }
            }
            SymbolKind::CrudOp { model, op } => {
                let model = *model;
                match op {
                    CrudOp::Update | CrudOp::Delete => {
                        expected.push((
                            "record".to_string(),
                            ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            },
                        ));
                    }
                    CrudOp::Create => {
                        if let SymbolKind::Model {
                            owner: ModelOwner::ChildOf(parent),
                            ..
                        } = &self.tables.symbols[model.0 as usize].kind
                        {
                            expected.push((
                                "parent".to_string(),
                                ResolvedType::Record {
                                    symbol: *parent,
                                    stored: true,
                                },
                            ));
                        }
                    }
                }
            }
            _ => return false,
        }
        if fields.len() != expected.len() {
            return false;
        }
        for (key, want) in &expected {
            let Some((_, value)) = fields.iter().find(|(k, _)| k == key) else {
                return false;
            };
            if matches!(
                value,
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_)
            ) {
                continue;
            }
            if !self.types_compatible(value, want) {
                let _ = cx;
                return false;
            }
        }
        trial.action_bound = Some(expected.iter().map(|(key, _)| key.clone()).collect());
        true
    }

    /// Match invocation arguments: a closed object over the target
    /// operation's COMPLETE normalized input schema (DESIGN §2.2), not
    /// `action`'s record-only bindings. Scenarios take every parameter
    /// (defaults omittable); CRUD create takes the creatable fields
    /// plus the contained `parent`; update takes `{record, changes}`;
    /// delete takes `{record}`. Bare enum cases claim against their
    /// expectation; poisoned values stay lenient.
    fn match_invocation_args(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        trial: &mut Trial,
    ) -> bool {
        if matches!(actual, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
            return true;
        }
        let ResolvedType::Object(fields) = actual else {
            return false;
        };
        let Some(op) = trial.action_op else {
            return false;
        };
        // Claim nodes for bare enum cases (shorthand entries claim
        // their key node, as `entry_value` does); absent when the
        // object arrives through a variable rather than literally.
        let entries: Vec<(&str, &SyntaxNode, Option<&SyntaxNode>)> =
            if arg.value.kind == SyntaxKind::Object {
                object_entries(arg.value, cx.text)
            } else {
                Vec::new()
            };
        let claim_node = |key: &str| claim_entry_node(&entries, key);
        match self.tables.symbols[op.0 as usize].kind.clone() {
            SymbolKind::Scenario { params, .. } => {
                for (key, _) in fields.iter() {
                    if !params
                        .iter()
                        .any(|p| self.tables.symbols[p.0 as usize].name == *key)
                    {
                        return false;
                    }
                }
                for param in &params {
                    let name = self.tables.symbols[param.0 as usize].name.clone();
                    let want = self.decl_type(*param);
                    match fields.iter().find(|(k, _)| *k == name) {
                        None => {
                            if !self.param_has_default(*param) {
                                return false;
                            }
                        }
                        Some((_, value)) => {
                            if matches!(value, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
                                continue;
                            }
                            if !self.invocation_value_fits(
                                cx,
                                claim_node(&name),
                                value,
                                &want,
                                trial,
                            ) {
                                return false;
                            }
                        }
                    }
                }
                true
            }
            SymbolKind::CrudOp { model, op } => match op {
                CrudOp::Create => self.match_invocation_create(cx, model, fields, &entries, trial),
                CrudOp::Update => self.match_invocation_update(cx, model, fields, &entries, trial),
                CrudOp::Delete => {
                    if fields.len() != 1 {
                        return false;
                    }
                    let Some((_, record)) = fields.iter().find(|(k, _)| k == "record") else {
                        return false;
                    };
                    if matches!(record, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
                        return true;
                    }
                    let want = ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    };
                    self.invocation_value_fits(cx, claim_node("record"), record, &want, trial)
                }
            },
            _ => false,
        }
    }

    /// Whether one invocation argument value fits its expectation:
    /// compatible types, or a bare enum case claimed against an enum
    /// expectation. Already-diagnosed values stay lenient.
    fn invocation_value_fits(
        &mut self,
        cx: &Ctx<'_, '_>,
        claim: Option<&SyntaxNode>,
        actual: &ResolvedType,
        expected: &ResolvedType,
        trial: &mut Trial,
    ) -> bool {
        if self.types_compatible(actual, expected) {
            return true;
        }
        let lenient = matches!(actual, ResolvedType::Error);
        let Some(node) = claim else {
            return lenient;
        };
        let (base, _) = strip_nullable(expected);
        let ResolvedType::Enum { cases, .. } = &base else {
            return lenient;
        };
        if self.claim_enum_case(cx, node, cases, expected.clone(), trial) {
            return true;
        }
        lenient
    }

    /// Invocation arguments for a CRUD create: creatable fields plus
    /// the contained `parent`, every required input present. The
    /// actor-context creation rule is construction-site state, not
    /// value shape, so it does not apply to immutable call values.
    fn match_invocation_create(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        fields: &[(String, ResolvedType)],
        entries: &[(&str, &SyntaxNode, Option<&SyntaxNode>)],
        trial: &mut Trial,
    ) -> bool {
        let contained_parent = match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                owner: ModelOwner::ChildOf(parent),
                ..
            } => Some(*parent),
            _ => None,
        };
        for (key, _) in fields.iter() {
            if key == "parent" {
                if contained_parent.is_none() {
                    return false;
                }
                continue;
            }
            let Some(field) = self.model_field_named(model, key) else {
                return false;
            };
            if is_reserved_name(key) || self.field_is_server(field) {
                return false;
            }
        }
        for (key, value) in fields.iter() {
            if matches!(value, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
                continue;
            }
            let want = if key == "parent" {
                ResolvedType::Record {
                    symbol: contained_parent.expect("checked parent"),
                    stored: true,
                }
            } else {
                self.decl_type(self.model_field_named(model, key).expect("checked key"))
            };
            if !self.invocation_value_fits(cx, claim_entry_node(entries, key), value, &want, trial)
            {
                return false;
            }
        }
        for field in self.model_fields(model) {
            let name = self.tables.symbols[field.0 as usize].name.clone();
            if fields.iter().any(|(k, _)| *k == name) {
                continue;
            }
            if self.field_is_required_input(field) {
                return false;
            }
        }
        if contained_parent.is_some() && !fields.iter().any(|(k, _)| k == "parent") {
            return false;
        }
        true
    }

    /// Invocation arguments for a CRUD update: exactly `{record,
    /// changes}` with valid partial set-values. Server-owned fields
    /// are never suppliable here: construction never adjusts a hook's
    /// pending record.
    fn match_invocation_update(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        fields: &[(String, ResolvedType)],
        entries: &[(&str, &SyntaxNode, Option<&SyntaxNode>)],
        trial: &mut Trial,
    ) -> bool {
        if fields.len() != 2 {
            return false;
        }
        let Some((_, record)) = fields.iter().find(|(k, _)| k == "record") else {
            return false;
        };
        let Some((_, changes)) = fields.iter().find(|(k, _)| k == "changes") else {
            return false;
        };
        if !matches!(record, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
            let want = ResolvedType::Record {
                symbol: model,
                stored: true,
            };
            if !self.invocation_value_fits(
                cx,
                claim_entry_node(entries, "record"),
                record,
                &want,
                trial,
            ) {
                return false;
            }
        }
        if matches!(
            changes,
            ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_)
        ) {
            return true;
        }
        let ResolvedType::Object(change_fields) = changes else {
            return false;
        };
        let nested: Vec<(&str, &SyntaxNode, Option<&SyntaxNode>)> =
            match claim_entry_node(entries, "changes") {
                Some(node) if node.kind == SyntaxKind::Object => object_entries(node, cx.text),
                _ => Vec::new(),
            };
        for (key, value) in change_fields.iter() {
            if is_reserved_name(key) {
                return false;
            }
            let Some(field) = self.model_field_named(model, key) else {
                return false;
            };
            if self.field_is_server(field) {
                return false;
            }
            if matches!(value, ResolvedType::Unknown | ResolvedType::Opaque(_)) {
                continue;
            }
            let want = self.decl_type(field);
            let claim = nested
                .iter()
                .find(|(k, _, _)| *k == key)
                .map(|(_, key_node, nested_value)| nested_value.unwrap_or(*key_node));
            if !self.invocation_value_fits(cx, claim, value, &want, trial) {
                return false;
            }
        }
        true
    }

    /// Substitute trial bindings into a result shape.
    fn subst_shape(&self, shape: &SigType, trial: &Trial) -> ResolvedType {
        match shape {
            SigType::Any => trial
                .bindings
                .get(&SigVar::T)
                .cloned()
                .unwrap_or(ResolvedType::Opaque("unbound result")),
            SigType::Ordered => trial
                .bindings
                .get(&SigVar::O)
                .cloned()
                .unwrap_or(ResolvedType::Opaque("unbound result")),
            SigType::StringLike => trial
                .bindings
                .get(&SigVar::S)
                .cloned()
                .unwrap_or(ResolvedType::Opaque("unbound result")),
            SigType::GroupKey => trial
                .bindings
                .get(&SigVar::K)
                .cloned()
                .unwrap_or(ResolvedType::Opaque("unbound result")),
            SigType::Display => trial
                .bindings
                .get(&SigVar::D)
                .cloned()
                .unwrap_or(ResolvedType::Opaque("unbound result")),
            SigType::Named(name) => {
                if name == "Team" {
                    return ResolvedType::Team;
                }
                if name == "OperationContext" {
                    return ResolvedType::OperationContext;
                }
                match scalar_named(name) {
                    Some(scalar) => ResolvedType::Scalar(scalar),
                    None => ResolvedType::Opaque("lane-owned result"),
                }
            }
            SigType::Collection(inner) => ResolvedType::Array {
                element: Box::new(self.subst_shape(inner, trial)),
                // Encounter order (group) — stable.
                ordered: true,
                nonempty: false,
            },
            SigType::OrderedCollection(inner) | SigType::Array(inner) => ResolvedType::Array {
                element: Box::new(self.subst_shape(inner, trial)),
                ordered: true,
                nonempty: false,
            },
            SigType::NonemptyCollection(inner) => ResolvedType::Array {
                element: Box::new(self.subst_shape(inner, trial)),
                ordered: true,
                nonempty: true,
            },
            SigType::Nullable(inner) => {
                let resolved = self.subst_shape(inner, trial);
                match resolved {
                    ResolvedType::Nullable(_) | ResolvedType::Error => resolved,
                    other => ResolvedType::Nullable(Box::new(other)),
                }
            }
            SigType::Union(arms) => {
                let mut resolved = arms.iter().map(|arm| self.subst_shape(arm, trial));
                let Some(first) = resolved.next() else {
                    return ResolvedType::Opaque("empty union result");
                };
                if resolved.all(|ty| loose_equal(&ty, &first)) {
                    first
                } else {
                    // Scalar unions are unrepresentable; no real
                    // builtin returns one (coverage-tested).
                    ResolvedType::Opaque("scalar union result")
                }
            }
            SigType::EnumCases(cases) => ResolvedType::Enum {
                cases: cases.clone(),
                owner: None,
            },
            SigType::Object(fields) => ResolvedType::Object(
                fields
                    .iter()
                    .map(|(name, ty)| (name.clone(), self.subst_shape(ty, trial)))
                    .collect(),
            ),
            SigType::ClosedDisplayObject => ResolvedType::Opaque("display object result"),
            SigType::Message => ResolvedType::Opaque("message result"),
            SigType::ActionTarget => ResolvedType::Opaque("action target result"),
            SigType::ActionBindings => ResolvedType::Opaque("action bindings result"),
            SigType::InvocationArgs => ResolvedType::Opaque("invocation arguments result"),
            SigType::ActionResult => match trial.action_op {
                Some(op) => ResolvedType::Action {
                    targets: vec![op],
                    bound: Some(trial.action_bound.clone().unwrap_or_default()),
                    external: Vec::new(),
                },
                None => ResolvedType::Opaque("unbound action result"),
            },
            SigType::InvocationResult => match trial.action_op {
                Some(op) => ResolvedType::Invocation { targets: vec![op] },
                None => ResolvedType::Opaque("unbound invocation result"),
            },
        }
    }
}

/// One input of an action target's call schema: its name, the
/// expected value type (`None` for update `changes`, which checks as
/// partial set-values instead), and whether the call must supply it
/// unless pre-bound at construction.
#[derive(Debug, Clone)]
struct ActionInput {
    name: String,
    expected: Option<ResolvedType>,
    required: bool,
}

/// One call argument: optional name plus borrowed value node.
#[derive(Debug, Clone)]
struct CallArg<'n> {
    name: Option<String>,
    value: &'n SyntaxNode,
    node: &'n SyntaxNode,
}

/// Expression callee classification.
enum CalleeKind {
    /// Already diagnosed (unbound, helper, poisoned).
    Error,
    /// External/boundary callee: silently opaque.
    Opaque,
    Builtin(String),
    DeriveFn(SymbolId),
    Message(SymbolId),
    Role(SymbolId),
    NotCallable(String),
}

/// Loose type equality: `Unknown` unifies, array flags and record
/// storage are ignored, objects compare by keys.
fn loose_equal(a: &ResolvedType, b: &ResolvedType) -> bool {
    match (a, b) {
        (ResolvedType::Unknown, _)
        | (_, ResolvedType::Unknown)
        | (ResolvedType::Error, _)
        | (_, ResolvedType::Error)
        | (ResolvedType::Opaque(_), _)
        | (_, ResolvedType::Opaque(_)) => true,
        (ResolvedType::Null, ResolvedType::Null) => true,
        (ResolvedType::Scalar(a), ResolvedType::Scalar(b)) => a == b,
        (ResolvedType::Team, ResolvedType::Team)
        | (ResolvedType::OperationContext, ResolvedType::OperationContext) => true,
        (
            ResolvedType::Enum {
                cases: ac,
                owner: ao,
            },
            ResolvedType::Enum {
                cases: bc,
                owner: bo,
            },
        ) => ao == bo && (ao.is_some() || ac == bc),
        (ResolvedType::Record { symbol: a, .. }, ResolvedType::Record { symbol: b, .. }) => a == b,
        (ResolvedType::Message(a), ResolvedType::Message(b)) => a == b,
        (
            ResolvedType::Action {
                targets: a,
                bound: ab,
                external: ae,
            },
            ResolvedType::Action {
                targets: b,
                bound: bb,
                external: be,
            },
        ) => a == b && ab == bb && ae == be,
        (ResolvedType::Invocation { targets: a }, ResolvedType::Invocation { targets: b }) => {
            a == b
        }
        (ResolvedType::Delivery { op: a }, ResolvedType::Delivery { op: b }) => a == b,
        // T14c: same-target std receipts only; cross-target ones
        // (including local-vs-std via `_`) are never loosely equal.
        (
            ResolvedType::StdDelivery {
                capability: ac,
                op: ao,
            },
            ResolvedType::StdDelivery {
                capability: bc,
                op: bo,
            },
        ) => ac == bc && ao.name == bo.name,
        (ResolvedType::Array { element: a, .. }, ResolvedType::Array { element: b, .. }) => {
            loose_equal(a, b)
        }
        (ResolvedType::Nullable(a), ResolvedType::Nullable(b)) => loose_equal(a, b),
        (ResolvedType::Union(a), ResolvedType::Union(b)) => a == b,
        (ResolvedType::Object(a), ResolvedType::Object(b)) => {
            a.len() == b.len()
                && a.iter().all(|(k, t)| {
                    b.iter()
                        .find(|(bk, _)| bk == k)
                        .is_some_and(|(_, bt)| loose_equal(t, bt))
                })
        }
        (ResolvedType::Operation(a), ResolvedType::Operation(b)) => a == b,
        _ => false,
    }
}

/// Signature type variables bound during one overload trial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum SigVar {
    /// Generic element `T`.
    T,
    /// Ordered scalar `O`.
    O,
    /// String-like `S`.
    S,
    /// Group key `K`.
    K,
    /// Display value `D`.
    D,
}

/// One overload trial: variable bindings plus the operation recorded
/// by an `action` target and the precise failures kept for the
/// no-match path.
#[derive(Debug, Default)]
struct Trial {
    bindings: HashMap<SigVar, ResolvedType>,
    action_op: Option<SymbolId>,
    action_bound: Option<Vec<String>>,
    literal_fail: Option<(Span, String)>,
    cases_fail: Option<(NodeKey, Span, Vec<String>)>,
    /// Enum-case claims, flushed only for the winning overload.
    claimed: Vec<(NodeKey, ResolvedType)>,
}

impl Trial {
    /// Fork bindings for one union arm (precise failures are shared:
    /// a failed arm's literal/case evidence still explains the call).
    fn fork(&self) -> Trial {
        Trial {
            bindings: self.bindings.clone(),
            action_op: self.action_op,
            action_bound: self.action_bound.clone(),
            literal_fail: self.literal_fail.clone(),
            cases_fail: self.cases_fail.clone(),
            claimed: self.claimed.clone(),
        }
    }

    /// Commit a successful arm's bindings.
    fn commit(&mut self, fork: Trial) {
        self.bindings = fork.bindings;
        self.action_op = fork.action_op;
        self.action_bound = fork.action_bound;
        self.claimed = fork.claimed;
        // Precise failures merge: keep the earliest evidence.
        if self.literal_fail.is_none() {
            self.literal_fail = fork.literal_fail;
        }
        if self.cases_fail.is_none() {
            self.cases_fail = fork.cases_fail;
        }
    }
}

/// Access a post-match argument already ordered by the winning slots.
fn bound_arg<'x, 'n>(
    overload: &SigOverload,
    args: &'x [CallArg<'n>],
    name: &str,
) -> Option<&'x CallArg<'n>> {
    args.get(overload.params.iter().position(|p| p.name == name)?)
}

/// Whether a type inhabits the group-key (`K`) class: group-key
/// scalars, enums, same-model record identity, optionally nullable
/// (DESIGN §3).
fn group_key_ok(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(s) => s.is_group_key(),
        ResolvedType::Enum { .. } | ResolvedType::Record { .. } => true,
        ResolvedType::Nullable(inner) => group_key_ok(inner),
        ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
        _ => false,
    }
}

/// Whether a type inhabits the non-null `Display` class: display
/// scalars and enums (DESIGN §3).
fn display_ok(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Scalar(s) => s.is_display(),
        ResolvedType::Enum { .. } => true,
        ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
        _ => false,
    }
}

/// Whether a `format` values-object field is a non-null display value.
fn display_nonnull(ty: &ResolvedType) -> bool {
    match ty {
        ResolvedType::Nullable(_) | ResolvedType::Null => false,
        other => display_ok(other),
    }
}

/// Word inside a `Name`/`NameRef` attribute value (`nav=`,
/// `layout=`, theme/mode values, CRUD modes).
fn nameref_word<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        return name_text(node, text);
    }
    kids(node).iter().find_map(|n| name_text(n, text))
}

/// Milliseconds of a duration literal (`Duration` leaf or
/// `Literal`-wrapped), or `None` for anything else/overflow.
fn duration_value(node: &SyntaxNode, text: &str) -> Option<i64> {
    if node.kind == SyntaxKind::Duration {
        let slice = text.get(node.span.start as usize..node.span.end as usize)?;
        return duration_millis(slice);
    }
    if node.kind == SyntaxKind::Literal {
        for leaf in kids(node) {
            if leaf.kind == SyntaxKind::Duration {
                let slice = text.get(leaf.span.start as usize..leaf.span.end as usize)?;
                return duration_millis(slice);
            }
        }
    }
    None
}

/// Byte count of a byte-quantity literal, or `None` for anything
/// else/overflow.
fn bytes_value(node: &SyntaxNode, text: &str) -> Option<i64> {
    if node.kind == SyntaxKind::Bytes {
        let slice = text.get(node.span.start as usize..node.span.end as usize)?;
        return bytes_count(slice);
    }
    if node.kind == SyntaxKind::Literal {
        for leaf in kids(node) {
            if leaf.kind == SyntaxKind::Bytes {
                let slice = text.get(leaf.span.start as usize..leaf.span.end as usize)?;
                return bytes_count(slice);
            }
        }
    }
    None
}

/// Read an integer literal value, seeing through groups and one
/// unary minus (including `-9223372036854775808` = `i64::MIN`).
/// Overflowing magnitudes yield `None` (the literal itself errors).
fn int_literal_value(node: &SyntaxNode, text: &str) -> Option<i64> {
    let mut current = node;
    loop {
        if let Some((SyntaxKind::Integer, slice)) = literal_leaf(current, text) {
            return slice.parse::<i64>().ok();
        }
        match current.kind {
            SyntaxKind::Group => {
                let inner = kids(current)
                    .iter()
                    .find(|n| is_expression(n.kind))
                    .copied()?;
                current = inner;
            }
            SyntaxKind::Unary => {
                let parts = kids(current);
                if !parts.iter().any(|p| is_punct(p, text, "-")) {
                    return None;
                }
                let operand = parts.iter().find(|n| is_expression(n.kind)).copied()?;
                let (_, slice) = literal_leaf(operand, text)?;
                if slice == "9223372036854775808" {
                    return Some(i64::MIN);
                }
                return slice.parse::<i64>().ok()?.checked_neg();
            }
            _ => return None,
        }
    }
}

/// Whether `node` is the integer literal `9223372036854775808`
/// (valid only as a unary-minus operand: `-2^63` is `i64::MIN`).
fn is_min_negation_operand(node: &SyntaxNode, text: &str) -> bool {
    matches!(
        literal_leaf(node, text),
        Some((SyntaxKind::Integer, "9223372036854775808"))
    )
}

/// Whether `expected` is uniquely decimal (R16/T11): exactly
/// `decimal`, modulo one nullable layer (mirrors the validated-string
/// rule in `type_literal`). Unions, overload shapes and every other
/// type never qualify, so overload positions never inhabit.
fn decimal_expectation(expected: &ResolvedType) -> bool {
    let unwrapped = match expected {
        ResolvedType::Nullable(inner) => inner.as_ref(),
        other => other,
    };
    matches!(unwrapped, ResolvedType::Scalar(Scalar::Decimal))
}

/// Check an integral spelling against the decimal
/// 38-significant-digit bound (R16/T11): leading zeros don't count,
/// all-zero counts 1 (mirrors values `significantDigits`). No int64
/// narrowing — decimals hold 38 digits. Returns the problem, or `None`
/// when the spelling fits.
fn integral_decimal_range(slice: &str) -> Option<String> {
    if slice.is_empty() || !slice.bytes().all(|b| b.is_ascii_digit()) {
        return Some("is malformed".to_string());
    }
    let significant = slice.trim_start_matches('0').len().max(1);
    if significant > 38 {
        return Some(format!("has {significant} significant digits (max 38)"));
    }
    None
}

/// Check a decimal literal slice (`digits.digits`) against the
/// 38-significant-digit / 18-fractional-digit bound (DESIGN §3).
/// Returns the problem, or `None` when the literal fits.
fn decimal_range(slice: &str) -> Option<String> {
    let (int_part, frac_part) = slice.split_once('.')?;
    if int_part.is_empty()
        || frac_part.is_empty()
        || !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return Some("is malformed".to_string());
    }
    if frac_part.len() > 18 {
        return Some(format!(
            "has {} fractional digits (max 18)",
            frac_part.len()
        ));
    }
    let significant = format!("{int_part}{frac_part}")
        .trim_start_matches('0')
        .len()
        .max(1);
    if significant > 38 {
        return Some(format!("has {significant} significant digits (max 38)"));
    }
    None
}

/// Duration literal slice to integer milliseconds (`ms/s/m/h/d`, a
/// day exactly 24 hours). `None` on overflow or malformed input.
fn duration_millis(slice: &str) -> Option<i64> {
    let (digits, factor) = ["ms", "s", "m", "h", "d"].iter().find_map(|suffix| {
        slice
            .strip_suffix(suffix)
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            .map(|d| {
                (
                    d,
                    match *suffix {
                        "ms" => 1i64,
                        "s" => 1_000,
                        "m" => 60_000,
                        "h" => 3_600_000,
                        _ => 86_400_000,
                    },
                )
            })
    })?;
    let magnitude: i64 = digits.parse().ok()?;
    magnitude.checked_mul(factor)
}

/// Byte literal slice to integer bytes (`B/KiB/MiB/GiB`, binary
/// prefixes). `None` on overflow or malformed input.
fn bytes_count(slice: &str) -> Option<i64> {
    let (digits, factor) = ["MiB", "KiB", "GiB", "B"].iter().find_map(|suffix| {
        slice
            .strip_suffix(suffix)
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            .map(|d| {
                (
                    d,
                    match *suffix {
                        "B" => 1i64,
                        "KiB" => 1_024,
                        "MiB" => 1_048_576,
                        _ => 1_073_741_824,
                    },
                )
            })
    })?;
    let magnitude: i64 = digits.parse().ok()?;
    magnitude.checked_mul(factor)
}

impl<'a> Typer<'a> {
    /// Whether a generated CRUD operation is enabled by its model's
    /// `crud` declaration.
    fn crud_op_enabled(&self, model: SymbolId, op: CrudOp) -> bool {
        let crud = match &self.tables.symbols[model.0 as usize].kind {
            SymbolKind::Model {
                crud: Some(crud), ..
            } => *crud,
            _ => return false,
        };
        match &self.tables.symbols[crud.0 as usize].kind {
            SymbolKind::Crud {
                create,
                update,
                delete,
                ..
            } => match op {
                CrudOp::Create => *create,
                CrudOp::Update => *update,
                CrudOp::Delete => *delete,
            },
            _ => false,
        }
    }
}

/// Validate a text literal against a validated string-like leaf
/// (DESIGN §3: every string-like except `text`). Returns the problem,
/// or `None` when the value is admissible.
fn validated_shape(leaf: Scalar, value: &str) -> Option<String> {
    match leaf {
        Scalar::Email => valid_email(value),
        Scalar::Url => valid_url(value),
        Scalar::Locale => valid_locale(value),
        Scalar::Timezone => valid_timezone(value),
        Scalar::Currency => valid_currency(value),
        _ => Some("not a validated string-like".to_string()),
    }
}

/// Email shape: exactly one interior ASCII `@`, excluding the public values
/// codec's explicit whitespace/C0/DEL scalar set. Preserve authored text;
/// domain grammar and ownership verification are outside shape admission.
fn valid_email(value: &str) -> Option<String> {
    if value.chars().any(|c| {
        matches!(
            c,
            '\u{0000}'..='\u{0020}'
                | '\u{007f}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
        )
    }) {
        return Some("whitespace is not allowed".to_string());
    }
    let mut parts = value.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            if local.is_empty() {
                return Some("empty local part".to_string());
            }
            if domain.is_empty() {
                return Some("empty domain".to_string());
            }
            None
        }
        _ => {
            if value.contains('@') {
                Some("want a single '@'".to_string())
            } else {
                Some("missing '@'".to_string())
            }
        }
    }
}

/// Ordinary URL admission mirrors the values wire owner: a WHATWG URL
/// with an HTTP(S) scheme. Keep the authored string; trusted `app_url`
/// origins have a separate policy.
fn valid_url(value: &str) -> Option<String> {
    match url::Url::parse(value) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => None,
        Ok(_) => Some("want an http(s) URL".to_string()),
        Err(problem) => Some(format!("invalid URL: {problem}")),
    }
}

/// Structural BCP 47 check (the runtime canonicalizes case and
/// variants via Intl; the checker accepts any-case well-formed tags).
fn valid_locale(value: &str) -> Option<String> {
    if value.is_empty() {
        return Some("empty language tag".to_string());
    }
    let mut parts = value.split('-');
    let lang = parts.next().unwrap_or("");
    if !(2..=3).contains(&lang.len()) || !lang.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Some("primary language must be 2–3 letters".to_string());
    }
    for subtag in parts {
        if !(2..=8).contains(&subtag.len()) || !subtag.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Some(format!("invalid subtag '{subtag}'"));
        }
    }
    None
}

/// Structural IANA zone shape. Zone *membership* comes from the pinned
/// runtime zone database (Intl) at runtime; the checker rejects only
/// malformed identifiers.
fn valid_timezone(value: &str) -> Option<String> {
    if value.eq_ignore_ascii_case("utc") {
        return None;
    }
    if value.is_empty() {
        return Some("empty timezone".to_string());
    }
    if value
        .bytes()
        .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Some("whitespace is not allowed".to_string());
    }
    for segment in value.split('/') {
        let shaped = !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+'));
        let headed = segment
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric());
        if !shaped || !headed {
            return Some(format!("invalid zone segment '{segment}'"));
        }
    }
    None
}

/// Currency admission: `isCurrencyShape` plus membership in the pinned
/// ISO 4217 table (mirroring `isKnownCurrency`: only table members
/// are currency values).
fn valid_currency(value: &str) -> Option<String> {
    if value.len() != 3 || !value.bytes().all(|b| b.is_ascii_uppercase()) {
        return Some("want 3 uppercase letters (ISO 4217)".to_string());
    }
    if KNOWN_CURRENCIES.binary_search(&value).is_ok() {
        return None;
    }
    if EXCLUDED_CURRENCIES.contains(&value) {
        return Some("has no pinned minor-unit scale (excluded from admission)".to_string());
    }
    Some("unknown ISO 4217 code".to_string())
}

/// Pinned ISO 4217 admission: the 165 codes with numeric minor units,
/// mirrored from the language-version-pinned currency-data table (SIX list-one,
/// Pblshd 2026-09-17). The 13 N.A.-scale codes are excluded (see below).
const KNOWN_CURRENCIES: [&str; 165] = [
    "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD",
    "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF",
    "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF",
    "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
    "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR",
    "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
    "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
    "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
    "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB",
    "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN",
    "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
    "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD",
    "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
];

/// The 13 ISO 4217 codes with N.A. minor units (metals, bond-market
/// units, supranationals, testing, no-currency): shaped but excluded.
const EXCLUDED_CURRENCIES: [&str; 13] = [
    "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XDR", "XPD", "XPT", "XSU", "XTS", "XUA", "XXX",
];

/// Supported instant range in milliseconds since the epoch (mirrors
/// the runtime `DATETIME_MIN_MS`/`DATETIME_MAX_MS`: 0001-01-01 through
/// 9999-12-31T23:59:59.999Z).
const DATETIME_MIN_MS: i64 = -62_135_596_800_000;
const DATETIME_MAX_MS: i64 = 253_402_300_799_999;

/// Checked `date(text)` shape: strict `YYYY-MM-DD`, proleptic
/// Gregorian years 0001–9999 (mirrors the runtime constructor).
fn valid_date(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(|b| b.is_ascii_digit())
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[8..10].iter().all(|b| b.is_ascii_digit());
    if !shaped {
        return Err("want YYYY-MM-DD".to_string());
    }
    let year: i64 = value[0..4].parse().unwrap_or(0);
    let month: i64 = value[5..7].parse().unwrap_or(0);
    let day: i64 = value[8..10].parse().unwrap_or(0);
    if !(1..=9999).contains(&year) {
        return Err("year outside 0001-9999".to_string());
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err("invalid civil date".to_string());
    }
    Ok(())
}

/// Checked `datetime(text)` shape: RFC 3339 instant with seconds and
/// an explicit `Z`/numeric offset (mirrors the runtime constructor:
/// leap second 60 rejected, nonzero sub-millisecond fractions
/// rejected, offset `HH<=23 MM<=59`, instant range-checked).
fn valid_datetime(value: &str) -> Result<(), String> {
    datetime_literal_millis(value).map(|_| ())
}

fn datetime_literal_millis(value: &str) -> Result<i64, String> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err("want an RFC 3339 instant (YYYY-MM-DDTHH:MM:SSZ)".to_string());
    }
    let digits = |range: std::ops::Range<usize>| {
        bytes[range.clone()]
            .iter()
            .all(|b| b.is_ascii_digit())
            .then(|| value[range].parse::<i64>().unwrap_or(-1))
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0..4),
        digits(5..7),
        digits(8..10),
        digits(11..13),
        digits(14..16),
        digits(17..19),
    ) else {
        return Err("want an RFC 3339 instant (YYYY-MM-DDTHH:MM:SSZ)".to_string());
    };
    if !(1..=9999).contains(&year) {
        return Err("year outside 0001-9999".to_string());
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err("invalid calendar date".to_string());
    }
    if hour > 23 || minute > 59 || second > 59 {
        return Err("invalid time of day".to_string());
    }
    // Optional fraction, then the required zone.
    let mut rest = &value[19..];
    let mut millis = 0i64;
    if let Some(fraction) = rest.strip_prefix('.') {
        let end = fraction.bytes().take_while(|b| b.is_ascii_digit()).count();
        if end == 0 {
            return Err("empty fractional seconds".to_string());
        }
        let digits = &fraction[..end];
        let padded = format!("{digits:0<3}");
        millis = padded[..3].parse::<i64>().unwrap_or(0);
        if digits.len() > 3 && !digits[3..].bytes().all(|b| b == b'0') {
            return Err("nonzero sub-millisecond fraction rejected".to_string());
        }
        rest = &fraction[end..];
    }
    let offset_ms = if rest.eq_ignore_ascii_case("z") {
        0
    } else if rest.len() == 6
        && (rest.as_bytes()[0] == b'+' || rest.as_bytes()[0] == b'-')
        && rest.as_bytes()[3] == b':'
        && rest[1..3].bytes().all(|b| b.is_ascii_digit())
        && rest[4..6].bytes().all(|b| b.is_ascii_digit())
    {
        let off_hour: i64 = rest[1..3].parse().unwrap_or(99);
        let off_minute: i64 = rest[4..6].parse().unwrap_or(99);
        if off_hour > 23 || off_minute > 59 {
            return Err("invalid zone offset".to_string());
        }
        let magnitude = (off_hour * 60 + off_minute) * 60_000;
        if rest.as_bytes()[0] == b'+' {
            magnitude
        } else {
            -magnitude
        }
    } else {
        return Err("want a Z or ±HH:MM zone offset".to_string());
    };
    let days = days_from_civil(year, month, day);
    let instant = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
        - offset_ms;
    if !(DATETIME_MIN_MS..=DATETIME_MAX_MS).contains(&instant) {
        return Err("instant outside the supported range".to_string());
    }
    Ok(instant)
}

/// Constructor literals use the same checked instant in canonical wire metadata.
pub(crate) fn canonical_datetime_literal(value: &str) -> Result<String, String> {
    let instant = datetime_literal_millis(value)?;
    let days = instant.div_euclid(86_400_000);
    let time = instant.rem_euclid(86_400_000);
    // Inverse of days_from_civil, matching the runtime's Gregorian conversion.
    let shifted = days + 719468;
    let era = shifted.div_euclid(146097);
    let doe = shifted - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let hour = time / 3_600_000;
    let minute = (time % 3_600_000) / 60_000;
    let second = (time % 60_000) / 1000;
    let milli = time % 1000;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"
    ))
}

/// Days in a proleptic Gregorian month.
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard
/// Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted = if month <= 2 { year - 1 } else { year };
    let era = if adjusted >= 0 {
        adjusted
    } else {
        adjusted - 399
    } / 400;
    let yoe = adjusted - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Scan a plain `format` template (mirrors the runtime `formatPlain`):
/// doubled braces are literals, `{key}` keys must be identifiers.
/// Returns placeholder keys in order.
fn scan_format_template(template: &str) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                if bytes.get(i + 1) == Some(&b'{') {
                    i += 2;
                    continue;
                }
                let rest = &template[i + 1..];
                let Some(end) = rest.find('}') else {
                    return Err("unterminated placeholder".to_string());
                };
                let key = &rest[..end];
                if !is_placeholder_key(key) {
                    return Err(format!("malformed placeholder: {{{key}}}"));
                }
                keys.push(key.to_string());
                i += 1 + end + 1;
            }
            b'}' => {
                if bytes.get(i + 1) == Some(&b'}') {
                    i += 2;
                    continue;
                }
                return Err("unmatched closing brace".to_string());
            }
            _ => {
                let width = template[i..].chars().next().map_or(1, |c| c.len_utf8());
                i += width;
            }
        }
    }
    Ok(keys)
}

/// Plain-template placeholder keys: ASCII identifiers (mirrors the
/// runtime `PLACEHOLDER_KEY`).
fn is_placeholder_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validated `HH:MM[:SS]` wall time (mirrors the runtime `TIME_RE`
/// plus range checks; closed shape for `local_instant`).
fn valid_wall_time(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 2 && parts.len() != 3 {
        return Some("want HH:MM[:SS]".to_string());
    }
    if !parts
        .iter()
        .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Some("want HH:MM[:SS]".to_string());
    }
    let number = |part: &str| part.parse::<u32>().unwrap_or(99);
    let bad_seconds = parts.len() == 3 && number(parts[2]) > 59;
    if number(parts[0]) > 23 || number(parts[1]) > 59 || bad_seconds {
        return Some("invalid time of day".to_string());
    }
    None
}
