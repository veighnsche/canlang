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
//!
//! BGI-07 Given trait/keyword contract checking adds `E3020`
//! incompatible-contribution-target, `E3021` conflicting-contribution,
//! `E3022` contradictory-contribution-value, `E3023`
//! producer-binding-refused and `E3024` declaration-mismatch (plus
//! `E2011`/`E4056` from the resolve/effects helpers it composes).

use std::collections::{HashMap, HashSet};

use crate::diagnostic::{ConstructCandidates, ConstructRankingContext, Diagnostic, Related};
use crate::source::{SourceDb, SourceId, Span};
use crate::syntax::{Punct, SyntaxKind, SyntaxNode, TokenKind};

use super::catalog::{
    Availability, Catalog, Effects, SigOverload, SigType, StdNominal, StdOperation,
    T13B_DELIVERY_OBSERVABLES, nominal_schema, std_capability,
};
use super::resolve::{
    ActorKind, Binding, CheckedJudgment, CheckedJudgmentKind, CheckedValueConstraints, ContextVar,
    CrudOp, FixtureTarget, ModelOwner, ModuleId, ResolveTables, ScopedName, SymbolId, SymbolKind,
    TypeRef, UnresolvedMember, has_error, is_expression, object_entries,
};
use super::{
    NodeKey, attribute_parts, attribute_value, file_text, is_name, is_punct, kids, name_text,
    op_text, path_segments, tight_span, unwrap_groups,
};

mod given;

pub use given::{
    CheckedKeywordApplication, CheckedKeywordContract, CheckedTraitApplication,
    CheckedTraitContract, GIVEN_FIELD_VALIDATION_EXPORT, GIVEN_FIELD_VALIDATION_LIFECYCLE,
    GIVEN_PRODUCER_FIELD_VALIDATION, GIVEN_PRODUCER_UNIQUE_KEY, GIVEN_UNIQUE_KEY_EXPORT,
    GIVEN_UNIQUE_KEY_LIFECYCLE, GIVEN_UNIQUE_KEY_SEMANTICS, GivenContractTables,
    GivenContributedField, GivenFieldSchema, GivenSavedDeclaration, GivenSavedImport,
    GivenSavedUnit, check_given_contract_tables, given_closure_fingerprint,
    given_declaration_for_source, given_producer_known,
};
pub(crate) use given::{parse_given_carrier, split_given_consts};

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
    /// Anonymous message descriptor. Its checked schema and immutable local
    /// provenance live in the message tables; it never inhabits plain text.
    InlineMessage,
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
    /// Closed imported IncomingEmail value, retaining its canonical catalog
    /// identity through locals, declarations and generic element typing.
    StdNominal {
        name: &'static str,
        fields: Vec<(String, ResolvedType)>,
    },
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

    /// A bounded structural check shared by query facts and receipt source
    /// proofs. Concrete types remain data; this does not admit any profile.
    pub(crate) fn is_resolved_shape(&self) -> bool {
        let mut pending = vec![(self, 0usize)];
        let mut steps = 0usize;
        while let Some((ty, depth)) = pending.pop() {
            steps += 1;
            if steps > 4096 || depth > 64 {
                return false;
            }
            match ty {
                Self::Unknown | Self::Error | Self::Opaque(_) => return false,
                Self::Nullable(inner) | Self::Array { element: inner, .. } => {
                    pending.push((inner, depth + 1));
                }
                Self::Object(fields) | Self::StdNominal { fields, .. } => {
                    if fields.len() > 4096 {
                        return false;
                    }
                    pending.extend(fields.iter().map(|(_, ty)| (ty, depth + 1)));
                }
                _ => {}
            }
            if pending.len() > 4096 {
                return false;
            }
        }
        true
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
            ResolvedType::Error
            | ResolvedType::Unknown
            | ResolvedType::Null
            | ResolvedType::Scalar(_)
            | ResolvedType::Team
            | ResolvedType::OperationContext
            | ResolvedType::Enum { .. }
            | ResolvedType::Record { .. }
            | ResolvedType::InlineMessage
            | ResolvedType::StdNominal { .. }
            | ResolvedType::Opaque(_) => self.display_leaf(tables, module),
            _ => self.display_composite(tables, module),
        }
    }

    fn display_leaf(&self, tables: &ResolveTables, module: ModuleId) -> String {
        match self {
            ResolvedType::Error => "{error}".to_string(),
            ResolvedType::Unknown => "{unknown}".to_string(),
            ResolvedType::Null => "null".to_string(),
            ResolvedType::Scalar(s) => s.as_str().to_string(),
            ResolvedType::Team => "Team".to_string(),
            ResolvedType::OperationContext => "OperationContext".to_string(),
            ResolvedType::Enum { cases, .. } => format!("enum({})", cases.join(",")),
            ResolvedType::Record { symbol, .. } => record_name(tables, module, *symbol),
            ResolvedType::InlineMessage => "anonymous message descriptor".to_string(),
            ResolvedType::StdNominal { name, .. } => (*name).to_string(),
            ResolvedType::Opaque(_) => "{opaque}".to_string(),
            _ => unreachable!("display_leaf takes only leaf types"),
        }
    }

    fn display_composite(&self, tables: &ResolveTables, module: ModuleId) -> String {
        match self {
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
            _ => unreachable!("display_composite takes only composite types"),
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

#[derive(Debug, Clone)]
pub(crate) struct CheckedAnonymousMessage {
    pub descriptor: NodeKey,
    pub arguments: Vec<(String, NodeKey, ResolvedType)>,
}

#[derive(Debug, Clone)]
pub struct CheckedJudgmentSpecificationCall {
    pub judgment: SymbolId,
    pub options: NodeKey,
}

/// Only exact catalog-produced types in the consumed nominal profile claim identity.
/// Consumers must not infer a nominal name from an anonymous object shape.
pub(crate) fn checked_standard_nominal_name(ty: &ResolvedType) -> Option<&'static str> {
    let ResolvedType::StdNominal { name, .. } = ty else {
        return None;
    };
    let schema = nominal_schema(name)?;
    (ty == &std_nominal_object(schema)).then_some(schema.name)
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

/// Authored query positions retained by the actual type checker. These facts
/// describe checked source; they do not attest native query execution.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedQuery {
    pub node: NodeKey,
    pub domain: NodeKey,
    pub domain_type: ResolvedType,
    pub result: ResolvedType,
    pub clauses: Vec<CheckedQueryClause>,
    /// Exact row attribution for a closed nominal select; never an execution grant.
    pub projection: Option<Box<CheckedQueryProjection>>,
}

impl CheckedQuery {
    /// Compare the whole original query occurrence's domain/clause census.
    /// Consumer-specific source/type/owner and execution checks remain separate.
    pub(crate) fn matches_source_nodes(
        &self,
        node: &SyntaxNode,
        expression: fn(SyntaxKind) -> bool,
    ) -> bool {
        let mut domains = node.children.iter().filter(|child| expression(child.kind));
        let mut clauses = node
            .children
            .iter()
            .filter(|child| child.kind == SyntaxKind::QueryClause);
        node.kind == SyntaxKind::Query
            && self.node == NodeKey::of(node)
            && domains.next().map(NodeKey::of) == Some(self.domain)
            && domains.next().is_none()
            && self
                .clauses
                .iter()
                .all(|fact| clauses.next().map(NodeKey::of) == Some(fact.node))
            && clauses.next().is_none()
    }

    /// Re-read exact clause kinds, aliases and expression positions from source.
    pub(crate) fn matches_source(
        &self,
        node: &SyntaxNode,
        text: &str,
        expression: fn(SyntaxKind) -> bool,
    ) -> bool {
        self.matches_source_nodes(node, expression)
            && self
                .clauses
                .iter()
                .zip(
                    node.children
                        .iter()
                        .filter(|child| child.kind == SyntaxKind::QueryClause),
                )
                .all(|(fact, clause)| {
                    CheckedQueryClause::from_source(clause, text, expression).as_ref() == Some(fact)
                        && match &fact.kind {
                            CheckedQueryClauseKind::As { name } => {
                                kids(clause)
                                    .iter()
                                    .rev()
                                    .find_map(|part| name_text(part, text))
                                    == Some(name.as_str())
                            }
                            _ => true,
                        }
                })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedQueryProjection {
    pub node: NodeKey,
    pub contract: SymbolId,
    pub model: SymbolId,
    /// Actual query `as` declaration, independent of the alias spelling.
    pub alias: NodeKey,
    pub fields: Vec<CheckedQueryProjectionField>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedQueryProjectionField {
    pub field: SymbolId,
    /// Authored value expression or the shorthand key token.
    pub node: NodeKey,
    pub ty: ResolvedType,
    pub mapping: CheckedQueryProjectionMapping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckedQueryProjectionMapping {
    StoredReference,
    Version,
    DirectField { field: SymbolId },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedQueryClause {
    /// The actual clause node is also the declaration identity of an `as` alias.
    pub node: NodeKey,
    pub kind: CheckedQueryClauseKind,
    pub expressions: Vec<NodeKey>,
}

impl CheckedQueryClause {
    fn from_source(
        node: &SyntaxNode,
        text: &str,
        expression: fn(SyntaxKind) -> bool,
    ) -> Option<Self> {
        let parts = kids(node);
        let head = parts.iter().find_map(|part| name_text(part, text))?;
        let kind = match head {
            "as" => CheckedQueryClauseKind::As {
                name: name_text(parts.get(1)?, text)?.to_owned(),
            },
            "where" => CheckedQueryClauseKind::Where,
            "order" => CheckedQueryClauseKind::Order,
            "limit" => CheckedQueryClauseKind::Limit,
            "archived" => CheckedQueryClauseKind::Archived,
            "select" => CheckedQueryClauseKind::Select,
            _ => return None,
        };
        Some(Self {
            node: NodeKey::of(node),
            kind,
            expressions: parts
                .into_iter()
                .filter(|child| expression(child.kind))
                .map(NodeKey::of)
                .collect(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckedQueryClauseKind {
    As { name: String },
    Where,
    Order,
    Limit,
    Archived,
    Select,
}

/// Actual selected collection builtin and its checked external predicate.
/// This retains authored source positions; it grants no native query execution.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedCollectionCall {
    pub node: NodeKey,
    pub builtin: String,
    pub overload: usize,
    pub query: NodeKey,
    pub alias: NodeKey,
    pub model: SymbolId,
    pub predicate: Option<CheckedCollectionPredicate>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckedCollectionPredicate {
    pub node: NodeKey,
    pub ty: ResolvedType,
}

/// Separate value-domain proof for a bound child result or owning contract array.
/// It proves selected source/alias correspondence, never child completeness,
/// native authority, or admission of the predicate's provenance closure.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedContractCollectionCall {
    pub node: NodeKey,
    pub builtin: String,
    pub overload: usize,
    pub arguments: Vec<NodeKey>,
    /// Domain and predicate indices in the authored argument list.
    pub slots: [usize; 2],
    pub query: NodeKey,
    pub domain: NodeKey,
    /// Exact direct child CallAs, or a checked singular contract member domain.
    /// A member domain establishes no stored observation or native authority.
    pub call: Option<NodeKey>,
    pub alias: NodeKey,
    pub contract: SymbolId,
    pub predicate: CheckedCollectionPredicate,
}

/// Exact standard terminal source accepted by the source checker.
/// This fact supplies analysis identity and payload, not runtime enrollment.
#[derive(Debug, Clone)]
pub struct CheckedStdDeliveryCompletion {
    pub capability: String,
    pub op: String,
    pub source: String,
    /// Selected provider operation and its declared result, before envelope nullability.
    pub canonical_operation: String,
    pub result_type: String,
    /// Exact source-owned import provenance; absent routes grant no deployment binding.
    pub module: ModuleId,
    pub alias: String,
    pub import_span: Span,
    pub binding: Option<String>,
    pub from: Option<String>,
    pub payload: ResolvedType,
}

/// Immutable declaration provenance for one supported generation association.
#[derive(Debug, Clone)]
pub(crate) struct CheckedGenerationCallbackSource {
    pub model: SymbolId,
    pub field: SymbolId,
    pub type_node: NodeKey,
    pub module: ModuleId,
    pub canonical_operation: String,
    pub import_span: Span,
    pub binding: String,
    pub from: String,
    pub event: String,
    /// Ordinary handler declaration, on-expression, and canonical identity.
    pub handlers: Vec<(SymbolId, NodeKey, String)>,
    module_snapshot: String,
    symbol_snapshots: Vec<(SymbolId, String)>,
    field_type: ResolvedType,
}

impl CheckedGenerationCallbackSource {
    pub(crate) fn matches(&self, program: &super::CheckedProgram) -> bool {
        program
            .modules
            .get(self.module.0 as usize)
            .is_some_and(|module| format!("{module:?}") == self.module_snapshot)
            && self.symbol_snapshots.iter().all(|(id, snapshot)| {
                program
                    .symbols
                    .get(id.0 as usize)
                    .is_some_and(|symbol| format!("{symbol:?}") == *snapshot)
            })
            && program.types.symbol_types.get(&self.field) == Some(&self.field_type)
            && self.handlers.iter().all(|(_, on, _)| {
                program.types.delivery_progress_handlers.get(on) == Some(&self.event)
            })
    }
}

/// A checked protected observation; the path is never an ordinary receipt leaf.
#[derive(Debug, Clone)]
pub(crate) struct CheckedGenerationCallbackObservation {
    pub node: NodeKey,
    pub path: String,
    pub source: CheckedGenerationCallbackSource,
    ty: Option<ResolvedType>,
}

impl CheckedGenerationCallbackObservation {
    pub(crate) fn matches(&self, program: &super::CheckedProgram) -> bool {
        self.source.matches(program)
            && self
                .ty
                .as_ref()
                .is_none_or(|ty| program.types.node_types.get(&self.node) == Some(ty))
    }
}

/// Exact standard verified-event declaration accepted by source analysis.
/// Its payload does not grant inbound verification or runtime handler enrollment.
#[derive(Debug, Clone)]
pub struct CheckedStdCapabilityEvent {
    pub capability: String,
    pub event: String,
    pub source: String,
    pub payload: ResolvedType,
}

/// Exact original agenda endpoint correspondence, without expanding the
/// source language's endpoint suitability rules. Native profiles qualify `ty`.
#[derive(Debug, Clone)]
pub(crate) struct CheckedCalendarEndpoint {
    pub collection: NodeKey,
    pub value: NodeKey,
    pub path: NodeKey,
    pub module: ModuleId,
    pub model: SymbolId,
    pub field: SymbolId,
    pub relative_path: String,
    pub ty: ResolvedType,
}

/// Original checked selector and direct panel correspondence. This fact is
/// private to source analysis; editable type tables cannot manufacture it.
#[derive(Debug, Clone)]
pub(crate) struct CheckedBoundTabs {
    pub module: ModuleId,
    owner_module: super::resolve::Module,
    pub selector: NodeKey,
    pub field: SymbolId,
    pub ty: ResolvedType,
    pub panels: Vec<(NodeKey, NodeKey, String)>,
    nodes: Vec<(NodeKey, ResolvedType)>,
    symbols: Vec<(super::resolve::Symbol, Option<ResolvedType>)>,
    reuse: Vec<(SymbolId, Option<SymbolId>)>,
}

impl CheckedBoundTabs {
    pub(crate) fn matches(&self, program: &super::CheckedProgram) -> bool {
        program
            .modules
            .get(self.module.0 as usize)
            .is_some_and(|module| {
                module.id == self.owner_module.id
                    && module.name == self.owner_module.name
                    && module.kind == self.owner_module.kind
                    && module.file == self.owner_module.file
                    && module.span == self.owner_module.span
                    && module.name_span == self.owner_module.name_span
            })
            && program
                .types
                .preference_field_references
                .get(&self.selector)
                == Some(&self.field)
            && self
                .nodes
                .iter()
                .all(|(node, ty)| program.types.node_types.get(node) == Some(ty))
            && self.panels.iter().all(|(_, header, _)| {
                program.types.resolved_cases.contains(header)
                    && !program.types.bound_names.contains(header)
            })
            && self.reuse.iter().all(|(field, source)| {
                program.types.field_reuse_sources.get(field).copied() == *source
            })
            && self.symbols.iter().all(|(original, ty)| {
                let Some(current) = program.symbols.get(original.id.0 as usize) else {
                    return false;
                };
                let same_kind = match (&original.kind, &current.kind) {
                    (
                        SymbolKind::Field {
                            owner: a,
                            type_node: x,
                        },
                        SymbolKind::Field {
                            owner: b,
                            type_node: y,
                        },
                    ) => a == b && x == y,
                    (
                        SymbolKind::Preferences { fields: a },
                        SymbolKind::Preferences { fields: b },
                    )
                    | (SymbolKind::Contract { fields: a }, SymbolKind::Contract { fields: b }) => {
                        a == b
                    }
                    (
                        SymbolKind::Model {
                            fields: a,
                            owner: x,
                            crud: c,
                        },
                        SymbolKind::Model {
                            fields: b,
                            owner: y,
                            crud: d,
                        },
                    ) => a == b && x == y && c == d,
                    _ => false,
                };
                same_kind
                    && current.id == original.id
                    && current.module == original.module
                    && current.canonical == original.canonical
                    && current.name == original.name
                    && current.span == original.span
                    && current.exported == original.exported
                    && program.types.symbol_types.get(&original.id) == ty.as_ref()
            })
    }
}

/// Checked deployment declaration; canonical names are supplied only by IR.
#[derive(Debug, Clone)]
pub enum CheckedRuntimeBinding {
    DurableObject {
        name: String,
        key: SymbolId,
    },
    Queue {
        name: String,
        payload: ResolvedType,
    },
    Cache {
        ttl_milliseconds: i64,
    },
    Analytics {
        name: String,
        fields: Vec<(String, ResolvedType)>,
    },
}

/// Exact inline saved-control selector and its local preference declaration.
#[derive(Debug, Clone)]
pub(crate) struct CheckedPreferenceControl {
    pub panel: NodeKey,
    pub node: NodeKey,
    pub selector: NodeKey,
    pub field: SymbolId,
    pub owner: SymbolId,
    pub module: ModuleId,
    pub control: String,
    pub ty: ResolvedType,
}

/// Types and selected bindings per symbol and typed CST node.
#[derive(Debug, Clone, Default)]
pub struct TypeTable {
    pub(crate) preference_controls: HashMap<NodeKey, CheckedPreferenceControl>,
    pub runtime_bindings: HashMap<ModuleId, Vec<CheckedRuntimeBinding>>,
    bound_tabs: HashMap<NodeKey, CheckedBoundTabs>,
    calendar_endpoints: HashMap<NodeKey, CheckedCalendarEndpoint>,
    callback_diagnostic_sources: HashMap<SymbolId, CheckedGenerationCallbackSource>,
    callback_diagnostic_reads: HashMap<NodeKey, CheckedGenerationCallbackObservation>,
    callback_diagnostic_selectors: HashMap<NodeKey, CheckedGenerationCallbackObservation>,
    /// Selected query-domain collection calls; separate from authored Where clauses.
    pub checked_collection_calls: HashMap<NodeKey, CheckedCollectionCall>,
    /// Checked contract-array any/all; distinct from stored-model proofs.
    pub checked_contract_collection_calls: HashMap<NodeKey, CheckedContractCollectionCall>,
    /// Successful query typing, preserving domain and authored clause identities.
    pub checked_queries: HashMap<NodeKey, CheckedQuery>,
    /// Checked local view host models, without executable symbols.
    pub view_models: HashMap<NodeKey, SymbolId>,
    /// Successfully checked same-module show targets.
    pub view_uses: HashMap<NodeKey, NodeKey>,
    /// Checked declarations: one descriptor owns every derived shape.
    pub judgments: HashMap<SymbolId, CheckedJudgment>,
    /// Exact checked generated source constant references.
    pub judgment_specifications: HashMap<NodeKey, SymbolId>,
    /// Actual checked runtime specification calls and their options argument.
    pub judgment_specification_calls: HashMap<NodeKey, CheckedJudgmentSpecificationCall>,
    /// Owning generated and receiving fields/parameters retain value constraints.
    pub value_constraints: HashMap<SymbolId, CheckedValueConstraints>,
    /// Derived symbols have ordinary identities but no authored emission body.
    pub judgment_generated_symbols: HashSet<SymbolId>,
    /// Source-owned checked model-trait fields and their default/constraint metadata.
    pub given_fields: HashMap<SymbolId, GivenContributedField>,
    pub given_constraints: HashMap<SymbolId, Vec<GivenContributedField>>,
    /// Checked required-array field presence, independent of value cardinality.
    pub judgment_required_arrays: HashSet<SymbolId>,
    /// Exact earlier-parameter identity claimed by an authored bare default.
    pub param_default_copy_sources: HashMap<SymbolId, SymbolId>,
    /// Exact typed cohort-child reads, consumed without spelling rebinding.
    pub cohort_child_references: HashMap<NodeKey, SymbolId>,
    /// Exact checked bare-role value references, preserving lexical collisions.
    pub role_references: HashMap<NodeKey, SymbolId>,
    /// Immediate checked field reuse source, preserving declaration-owned labels.
    pub(crate) field_reuse_sources: HashMap<SymbolId, SymbolId>,
    /// Receiving preference fields, independent of a borrowed enum's owner.
    pub(crate) preference_field_references: HashMap<NodeKey, SymbolId>,
    /// Optional checked assistance; final input typing/defaults/grants are unchanged.
    pub input_choices: HashMap<SymbolId, CheckedInputChoice>,
    /// Checked external and capability/operation declaration heads for sends.
    pub target_bindings: HashMap<NodeKey, Binding>,
    /// Checked owning progress handler identities, consumed without source rebinding.
    pub delivery_progress_handlers: HashMap<NodeKey, String>,
    /// Checked standard terminal sources; no fabricated declaration symbols.
    pub std_delivery_completion_handlers: HashMap<NodeKey, CheckedStdDeliveryCompletion>,
    /// Checked standard declared events, retaining their owning field payload.
    pub std_capability_event_handlers: HashMap<NodeKey, CheckedStdCapabilityEvent>,
    /// Selected call authority consumed by IR without rebinding arguments.
    pub selected_calls: HashMap<NodeKey, SelectedCall>,
    /// Checked production statement-call results (`None` is void). Opaque
    /// heterogeneous results remain opaque rather than acquiring a schema.
    pub effect_call_results: HashMap<NodeKey, Option<ResolvedType>>,
    /// Explicit anonymous descriptor bindings, in authored evaluation order.
    pub(crate) anonymous_messages: HashMap<NodeKey, CheckedAnonymousMessage>,
    /// Immutable local references to an authored inline descriptor, checked
    /// bound anonymous call or typed named message. Carries provenance, never
    /// copied operands.
    pub(crate) message_descriptor_references: HashMap<NodeKey, NodeKey>,
    /// Finite anonymous descriptor leaves of a checker-selected builtin choose.
    /// Immutable aliases retain this origin without copying or replaying values.
    pub(crate) anonymous_message_choices: HashMap<NodeKey, Vec<NodeKey>>,
    /// Subject-domain labels checked for individual finite-enum match arms.
    pub enum_match_cases: HashMap<NodeKey, String>,
    /// Match statements with complete, unique checked subject-domain coverage.
    pub exhaustive_matches: HashSet<NodeKey>,
    /// Resolved value references, including fixed contexts. Retained for IR so
    /// enum-valued bindings are not reconstructed as case spellings.
    pub bound_names: HashSet<NodeKey>,
    /// Exact local value references, distinguished from module fixtures and
    /// contextual roots before lowering. A same-spelled fixture cannot replace
    /// an authored parameter, let, alias or effect binding.
    pub(crate) lexical_value_references: HashSet<NodeKey>,
    /// Exact fixed-context identity from the original resolver, kept private
    /// so IR can distinguish contextual roots from same-spelled lexical values.
    pub(crate) contextual_references: HashMap<NodeKey, ContextVar>,
    /// Resolved type of each typed CST node (absent = untyped position).
    pub node_types: HashMap<NodeKey, ResolvedType>,
    /// Canonical delivery observation selectors checked against their source owner.
    pub delivery_selectors: HashMap<NodeKey, String>,
    /// Field-relative signed UI order selectors checked against their own query alias.
    pub(crate) ui_order_selectors: HashMap<NodeKey, String>,
    /// Additional unbound names found by the types pass (pass 2 `E2001`).
    pub unresolved_names: Vec<NodeKey>,
    /// Checked enum case expressions: unbound expected cases and explicit
    /// declaration.field.case members (or names covered by precise `E3xxx`).
    /// Pass 2 `E2001` skips claimed names; IR lowers checked cases as literals.
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

impl TypeTable {
    pub(crate) fn calendar_endpoint(&self, node: &NodeKey) -> Option<&CheckedCalendarEndpoint> {
        self.calendar_endpoints.get(node)
    }

    pub(crate) fn bound_tabs(&self, node: &NodeKey) -> Option<&CheckedBoundTabs> {
        self.bound_tabs.get(node)
    }
}

impl TypeTable {
    pub(crate) fn callback_diagnostic_reads(
        &self,
    ) -> &HashMap<NodeKey, CheckedGenerationCallbackObservation> {
        &self.callback_diagnostic_reads
    }

    pub(crate) fn callback_diagnostic_selectors(
        &self,
    ) -> &HashMap<NodeKey, CheckedGenerationCallbackObservation> {
        &self.callback_diagnostic_selectors
    }
}

fn callback_enum(cases: &[&str]) -> ResolvedType {
    ResolvedType::Enum {
        cases: cases.iter().map(|case| (*case).to_string()).collect(),
        owner: None,
    }
}

/// The common union surface contains only the discriminant. Arm fields appear
/// solely after a checked comparison; absent arm fields never become nullable.
fn callback_diagnostic_result(arm: Option<&str>) -> ResolvedType {
    let (name, fields) = match arm {
        Some("complete") => (
            "GenerationCallbackDiagnosticComplete",
            vec![
                ("outcome".to_string(), callback_enum(&["complete"])),
                (
                    "failures".to_string(),
                    ResolvedType::Array {
                        element: Box::new(ResolvedType::StdNominal {
                            name: "GenerationCallbackFailure",
                            fields: vec![
                                ("deliveryId".to_string(), ResolvedType::Scalar(Scalar::Text)),
                                (
                                    "sourceOccurrence".to_string(),
                                    ResolvedType::Scalar(Scalar::Text),
                                ),
                                (
                                    "occurrenceId".to_string(),
                                    ResolvedType::Scalar(Scalar::Text),
                                ),
                                ("handler".to_string(), ResolvedType::Scalar(Scalar::Text)),
                                ("event".to_string(), ResolvedType::Scalar(Scalar::Text)),
                                // Read-only ABI output: the owner admits safe nonnegative
                                // integer timestamps before publishing this closed value.
                                (
                                    "recordedAtMs".to_string(),
                                    ResolvedType::Scalar(Scalar::Int),
                                ),
                                ("code".to_string(), callback_enum(&["require-false"])),
                                (
                                    "message".to_string(),
                                    callback_enum(&["handler requirement rejected the occurrence"]),
                                ),
                            ],
                        }),
                        ordered: true,
                        nonempty: false,
                    },
                ),
                (
                    "snapshotAttribution".to_string(),
                    callback_enum(&["unsupported"]),
                ),
            ],
        ),
        Some("unsupported") => (
            "GenerationCallbackDiagnosticUnsupported",
            vec![
                ("outcome".to_string(), callback_enum(&["unsupported"])),
                (
                    "reason".to_string(),
                    callback_enum(&[
                        "store-profile",
                        "bound-exceeded",
                        "origin-correspondence",
                        "occurrence-correspondence",
                    ]),
                ),
            ],
        ),
        _ => (
            "GenerationCallbackDiagnosticResult",
            vec![(
                "outcome".to_string(),
                callback_enum(&["complete", "unsupported"]),
            )],
        ),
    };
    ResolvedType::StdNominal { name, fields }
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
    typer.collect_scenario_flags(trees);
    // Source languages first: message/descriptor variant checks
    // (`E3016` source-repeat) compare against the owning module tag.
    typer.collect_module_sources(trees);
    typer.collect_judgment_messages(trees);
    typer.phase1(trees);
    typer.collect_callback_diagnostic_sources(trees);
    typer.phase2(trees);
    typer.check_runtime_authority(trees);
    typer.check_strict_membership_closures();
    typer.check_retention_context_closures();
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
    typer.types.lexical_value_references = tables
        .node_binding
        .iter()
        .filter(|(_, binding)| match binding {
            Binding::Symbol(id) => {
                matches!(tables.symbols[id.0 as usize].kind, SymbolKind::Param { .. })
            }
            Binding::Let { .. }
            | Binding::QueryAlias { .. }
            | Binding::ForItem { .. }
            | Binding::CohortChild { .. }
            | Binding::CreateAs { .. }
            | Binding::CallAs { .. }
            | Binding::SendAs { .. }
            | Binding::RouteParam { .. } => true,
            _ => false,
        })
        .map(|(key, _)| *key)
        .collect();
    typer.types.contextual_references = tables
        .node_binding
        .iter()
        .filter_map(|(key, binding)| match binding {
            Binding::Context(context) => Some((*key, context.clone())),
            _ => None,
        })
        .collect();
    typer.types.target_bindings = tables
        .node_binding
        .iter()
        .filter(|(_, binding)| match binding {
            Binding::External { .. } => true,
            Binding::Symbol(id) => {
                tables.judgments.contains(id)
                    || matches!(
                        tables.symbols[id.0 as usize].kind,
                        SymbolKind::Capability { .. }
                            | SymbolKind::CapabilityOp { .. }
                            | SymbolKind::Scenario { .. }
                    )
            }
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
    if let Some(element) = declared
        .strip_suffix("[]!")
        .or_else(|| declared.strip_suffix("[]"))
    {
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
    let fields = schema
        .fields
        .iter()
        .map(|(name, kind)| (name.to_string(), std_nominal_leaf_type(kind)))
        .collect();
    if matches!(
        schema.name,
        "OperationOutcome"
            | "PaymentState"
            | "IncomingEmail"
            | "TextMessage"
            | "TextRequest"
            | "WorkflowInput"
            | "WorkflowDefinition"
            | "ImageRequest"
    ) {
        ResolvedType::StdNominal {
            name: schema.name,
            fields,
        }
    } else {
        ResolvedType::Object(fields)
    }
}

pub(crate) fn sink_delivery_type() -> ResolvedType {
    std_nominal_leaf_type("DeliveryResult")
}

fn delivery_status_type() -> ResolvedType {
    nominal_schema("DeliveryResult")
        .and_then(|schema| schema.fields.iter().find(|(name, _)| *name == "status"))
        .map(|(_, kind)| std_nominal_leaf_type(kind))
        .unwrap_or(ResolvedType::Opaque("delivery status"))
}

fn delivery_error_type() -> ResolvedType {
    std_nominal_leaf_type("DeliveryError?")
}

fn completion_status_type() -> ResolvedType {
    let mut status = delivery_status_type();
    if let ResolvedType::Enum { cases, .. } = &mut status {
        // Pending is a receipt state, never a completion occurrence.
        cases.retain(|case| case != "pending");
    }
    status
}

/// Shared closed terminal envelope for body and example analysis.
/// Void remains null and an already nullable declared result is not wrapped twice.
pub(crate) fn completion_envelope(result: Option<ResolvedType>) -> ResolvedType {
    let result = match result {
        Some(result @ (ResolvedType::Nullable(_) | ResolvedType::Null)) => result,
        Some(result) => ResolvedType::Nullable(Box::new(result)),
        None => ResolvedType::Null,
    };
    ResolvedType::Object(vec![
        (
            "delivery_id".to_string(),
            ResolvedType::Scalar(Scalar::Text),
        ),
        ("status".to_string(), completion_status_type()),
        ("result".to_string(), result),
        ("error".to_string(), delivery_error_type()),
    ])
}

/// Map one T13c nominal leaf kind to its checkable type (T14d).
/// Scalar/enum/array spellings reuse [`std_schema_type`]
/// (transcribed refinements such as `amount: money` arrive
/// already refined); transcribed nominal refs nest their closed
/// object (the frozen tables are acyclic: requests nest messages,
/// runs nest outputs, nothing nests back). The published `CanDuration`
/// and `DatetimeValue` contracts use the duration and datetime scalars.
/// Transcribed nested schemas resolve through their owning named refs.
/// Unknown named refs stay opaque — transcribed,
/// never reinterpreted, never guessed.
fn std_nominal_leaf_type(declared: &str) -> ResolvedType {
    if declared == "CanDuration" {
        return ResolvedType::Scalar(Scalar::Duration);
    }
    if declared == "DatetimeValue" {
        return ResolvedType::Scalar(Scalar::Datetime);
    }
    if let Some(ty) = std_schema_type(declared) {
        return ty;
    }
    if let Some(inner) = declared.strip_suffix('?') {
        return ResolvedType::Nullable(Box::new(std_nominal_leaf_type(inner)));
    }
    if let Some(element) = declared
        .strip_suffix("[]!")
        .or_else(|| declared.strip_suffix("[]"))
    {
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
    /// Capture original owning type/import/handler declarations before bodies
    /// are checked. The existing declaration typer remains the source authority.
    fn collect_callback_diagnostic_sources(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        let mut nodes = HashMap::new();
        for (_, tree) in trees {
            let mut pending = vec![tree];
            while let Some(node) = pending.pop() {
                nodes.insert(NodeKey::of(node), node);
                pending.extend(kids(node));
            }
        }
        for symbol in &self.tables.symbols {
            let SymbolKind::Field {
                owner: model,
                type_node,
            } = symbol.kind
            else {
                continue;
            };
            if !matches!(
                self.tables.symbols[model.0 as usize].kind,
                SymbolKind::Model { .. }
            ) {
                continue;
            }
            let field_type = self.decl_type(symbol.id);
            let ResolvedType::StdDelivery { capability, op } =
                field_type.nullable_inner().unwrap_or(&field_type)
            else {
                continue;
            };
            if !matches!(
                (*capability, op.name),
                ("std.ImagesV1", "submit") | ("std.TextGenerationV1", "generate")
            ) {
                continue;
            }
            let Some(mut type_syntax) = nodes.get(&type_node).copied() else {
                continue;
            };
            while type_syntax.kind == SyntaxKind::NullableType {
                let Some(inner) = kids(type_syntax)
                    .into_iter()
                    .find(|node| is_type_node(node.kind))
                else {
                    break;
                };
                type_syntax = inner;
            }
            if type_syntax.kind != SyntaxKind::DeliveryType {
                continue;
            }
            let text = self.text(type_node.file);
            let paths: Vec<_> = kids(type_syntax)
                .into_iter()
                .filter(|node| node.kind == SyntaxKind::Path)
                .collect();
            if paths.len() != 1 {
                continue;
            }
            let segments = path_segments(paths[0], text);
            if segments.len() != 2 || segments[1] != op.name {
                continue;
            }
            let module = &self.tables.modules[symbol.module.0 as usize];
            let mut imports = module.imports.iter().flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(|member| member.alias == segments[0])
                    .map(move |member| (import, member))
            });
            let Some((import, member)) = imports.next() else {
                continue;
            };
            if imports.next().is_some()
                || import.provider != "std"
                || std_capability(&member.name).is_none_or(|cap| cap.name != *capability)
                || !matches!(self.tables.module_scopes[symbol.module.0 as usize].prod.get(segments[0]), Some(ScopedName::External { provider, name }) if provider == "std" && name == &member.name)
            {
                continue;
            }
            let Some(from) = import.from.clone() else {
                continue;
            };
            let event = format!("{}.{}.{}.progressed", module.name, member.alias, op.name);
            let mut handlers = Vec::new();
            let mut snapshots = vec![
                (symbol.id, format!("{symbol:?}")),
                (
                    model,
                    format!("{:?}", self.tables.symbols[model.0 as usize]),
                ),
            ];
            for handler in &self.tables.symbols {
                if handler.module != symbol.module
                    || !matches!(handler.kind, SymbolKind::Scenario { .. })
                {
                    continue;
                }
                // Resolve the exact scenario declaration instead of matching names.
                let Some(scenario) = nodes.values().copied().find(|node| {
                    node.kind == SyntaxKind::Scenario
                        && node.span.file == handler.span.file
                        && node.span.start <= handler.span.start
                        && node.span.end >= handler.span.end
                }) else {
                    continue;
                };
                let Some(on) = attribute_value(scenario, "on", text) else {
                    continue;
                };
                if path_segments(on, text) == [member.alias.as_str(), op.name, "progressed"] {
                    handlers.push((handler.id, NodeKey::of(on), handler.canonical.clone()));
                    snapshots.push((handler.id, format!("{handler:?}")));
                }
            }
            self.types.callback_diagnostic_sources.insert(
                symbol.id,
                CheckedGenerationCallbackSource {
                    model,
                    field: symbol.id,
                    type_node,
                    module: symbol.module,
                    canonical_operation: format!("{capability}.{}", op.name),
                    import_span: import.span,
                    binding: format!("{}.{}", module.name, member.alias),
                    from,
                    event,
                    handlers,
                    module_snapshot: format!("{module:?}"),
                    symbol_snapshots: snapshots,
                    field_type,
                },
            );
        }
    }

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
        for section in kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::Section)
        {
            for view in kids(section)
                .into_iter()
                .filter(|n| n.kind == SyntaxKind::View)
            {
                self.phase2_view(file, text, module, view);
            }
        }
        for section in kids(node) {
            if section.kind != SyntaxKind::Section {
                continue;
            }
            // A `#` description attaches to the following significant
            // sibling (one node per contiguous run); a scenario is
            // described exactly when that sibling is a Description.
            let items = kids(section);
            for (index, item) in items.iter().enumerate() {
                if has_error(item) {
                    continue;
                }
                let described = index > 0 && items[index - 1].kind == SyntaxKind::Description;
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
                    SyntaxKind::Judgment => self.phase2_judgment(file, text, module, item),
                    SyntaxKind::Scenario => {
                        self.phase2_scenario(file, text, module, item, described)
                    }
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

    /// Pair `Model at=Binding` with the exact root keyed declaration.
    /// Otherwise local execution could silently route declared DO data to D1.
    fn check_runtime_authority(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        let mut placed = HashSet::new();
        for (_, tree) in trees {
            let text = self.text(tree.span.file).to_string();
            for owner in kids(tree)
                .into_iter()
                .filter(|node| matches!(node.kind, SyntaxKind::App | SyntaxKind::Package))
            {
                let Some(module) = module_of_node(self.tables, &text, owner) else {
                    continue;
                };
                for model in owner
                    .descendants()
                    .filter(|node| node.kind == SyntaxKind::Model)
                {
                    let Some(id) = self.decl_symbol(module, &text, model, &["export"]) else {
                        continue;
                    };
                    let parts = kids(model);
                    let at = parts
                        .iter()
                        .position(|node| is_name(node, &text, "at"))
                        .and_then(|index| parts.get(index + 2).copied());
                    let Some(at) = at else { continue };
                    let path = path_segments(at, &text);
                    let (binding_module, binding_name) = match path.as_slice() {
                        [name] => (Some(module), *name),
                        [owner, name] => (self.tables.module_by_name.get(*owner).copied(), *name),
                        _ => (None, ""),
                    };
                    let matches = binding_module.and_then(|owner| self.types.runtime_bindings.get(&owner)).into_iter().flatten().filter(|binding|
                        matches!(binding, CheckedRuntimeBinding::DurableObject { name, key } if name == binding_name && *key == id)).count();
                    if matches == 1 {
                        placed.insert((binding_module.unwrap(), binding_name.to_string(), id));
                    } else {
                        self.diags.push(Diagnostic::error("E3001", "model at= must name its context DurableObject binding keyed by this root model".into(), tight_span(&text, at)));
                    }
                }
            }
        }
        for (module, declarations) in &self.types.runtime_bindings {
            for declaration in declarations {
                if let CheckedRuntimeBinding::DurableObject { name, key } = declaration
                    && !placed.contains(&(*module, name.clone(), *key))
                {
                    self.diags.push(Diagnostic::error("E3001", format!("DurableObject binding '{name}' requires its keyed root model to declare at={name}"), self.tables.symbols[key.0 as usize].span));
                }
            }
        }
    }

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
    /// Check one field initializer (`default=` or `server=`): actor use
    /// is recorded, the value must fit the declared type, and plain
    /// defaults in preferences must be constant.
    #[allow(clippy::too_many_arguments)]
    fn check_field_initializer(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        id: SymbolId,
        field: &SyntaxNode,
        name: &str,
        expected: &ResolvedType,
        init: &SyntaxNode,
        server: bool,
        in_prefs: bool,
    ) {
        if expr_uses_name(init, text, "actor") {
            self.default_uses_actor.insert(id);
        }
        let narrow = NarrowEnv::default();
        let cx = if server {
            Ctx {
                module,
                file,
                text,
                narrow: &narrow,
                strict: true,
                server_default: true,
            }
        } else {
            Self::body_cx(module, file, text, &narrow)
        };
        let actual = self.expr(&cx, init, Some(expected.clone()));
        self.check_field_membership_default(init, text, name);
        if !actual.is_error() && !self.types_compatible(&actual, expected) {
            self.diags.push(Diagnostic::error(
                "E3011",
                format!(
                    "{} for '{name}': expected {}, found {}",
                    if server {
                        "server initializer"
                    } else {
                        "default"
                    },
                    self.show(module, expected),
                    self.show(module, &actual)
                ),
                tight_span(text, init),
            ));
        }
        if in_prefs && !server {
            self.check_prefs_default_const(text, module, field, name, init);
        }
    }

    /// Check one field's modifiers: duplicates are `E3012`, `unique` is
    /// refused in preferences, then each modifier is checked in turn.
    #[allow(clippy::too_many_arguments)]
    fn check_field_modifiers(
        &mut self,
        cx: &Ctx<'_, '_>,
        field: &SyntaxNode,
        text: &str,
        name: &str,
        expected: &ResolvedType,
        modifiers: &[FieldModifier<'_>],
        in_prefs: bool,
    ) {
        let mut seen_modifiers: Vec<&str> = Vec::new();
        for modifier in modifiers {
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
            self.check_field_modifier(cx, field, name, expected, *modifier);
        }
    }

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
            self.check_field_initializer(
                file, text, module, id, field, &name, &expected, default, false, in_prefs,
            );
        }
        if let Some(server) = init.server {
            self.check_field_initializer(
                file, text, module, id, field, &name, &expected, server, true, in_prefs,
            );
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
        self.check_field_modifiers(
            &cx,
            field,
            text,
            &name,
            &expected,
            &init.modifiers,
            in_prefs,
        );
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
            SyntaxKind::Call => {
                let read_only = kids(stmt)
                    .into_iter()
                    .find(|node| is_expression(node.kind))
                    .and_then(|node| self.types.node_types.get(&NodeKey::of(node)))
                    .is_some_and(
                        |ty| matches!(ty, ResolvedType::Operation(id) if self.callee_is_read(*id)),
                    );
                if !read_only {
                    out.drop_all_paths = true;
                }
            }
            SyntaxKind::Create
            | SyntaxKind::Delete
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
                    self.types
                        .node_types
                        .insert(NodeKey::of(key_node), narrowed.clone());
                    return (narrowed, tight_span(cx.text, key_node));
                }
                let ty =
                    binding.map_or(ResolvedType::Error, |b| self.type_binding(cx, key_node, &b));
                self.types
                    .node_types
                    .insert(NodeKey::of(key_node), ty.clone());
                (ty, tight_span(cx.text, key_node))
            }
        }
    }

    /// Contextually type a supplied binding once, then report compatibility at
    /// the original explicit-value or shorthand span. Owners still qualify the
    /// field/parameter, defaults and required inputs before/after this step.
    fn check_entry_assignment(
        &mut self,
        cx: &Ctx<'_, '_>,
        key: &str,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
        expected: &ResolvedType,
        code: &'static str,
    ) {
        let (actual, value_span) = self.entry_value(cx, key_node, value, Some(expected.clone()));
        if !actual.is_error() && !self.types_compatible(&actual, expected) {
            self.diags.push(Diagnostic::error(
                code,
                format!(
                    "'{key}': expected {}, found {}",
                    self.show(cx.module, expected),
                    self.show(cx.module, &actual)
                ),
                value_span,
            ));
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
        if !ty.is_error()
            && let Some(descriptor) = self.checked_message_descriptor_origin(value).or_else(|| {
                matches!(ty, ResolvedType::Message(_)).then(|| NodeKey::of(unwrap_groups(value)))
            })
        {
            self.types
                .message_descriptor_references
                .insert(NodeKey::of(node), descriptor);
        }
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
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
        if let Some(result) = self.calls.get(&NodeKey::of(node)) {
            self.types.effect_call_results.insert(
                NodeKey::of(node),
                (result != &ResolvedType::Error).then(|| result.clone()),
            );
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
            return;
        };
        let (model, op) = (*model, *op);
        match (&input.expected, key) {
            (Some(expected), _) => {
                self.check_entry_assignment(cx, key, key_node, value, expected, "E3001");
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
                self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
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
        if target.kind == SyntaxKind::Member && self.stmt_declared_sink(cx, node, target, object) {
            return;
        }
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
                self.stmt_std_send(cx, node, target, object);
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
        self.check_send_when(cx, node);
    }

    fn check_send_when(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        if let Some(when) = bare_keyword_value(node, "when", cx.text) {
            let ty = self.expr(cx, when, None);
            self.expect_bool(cx, tight_span(cx.text, when), &ty, "`when`");
            self.check_dispatch_when(cx, when);
        }
    }

    fn stmt_declared_sink(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        target: &SyntaxNode,
        object: Option<&SyntaxNode>,
    ) -> bool {
        let parts = kids(target);
        let head = parts
            .first()
            .and_then(|head| name_or_ref_word(head, cx.text));
        let member = parts.last().and_then(|member| name_text(member, cx.text));
        let shadowed = parts
            .first()
            .is_some_and(|head| self.tables.node_binding.contains_key(&NodeKey::of(head)));
        let declaration = self
            .types
            .runtime_bindings
            .get(&cx.module)
            .into_iter()
            .flatten()
            .filter(|_| !shadowed)
            .find_map(|binding| match binding {
                CheckedRuntimeBinding::Queue { name, payload } if Some(name.as_str()) == head => {
                    Some(("publish", vec![("value".to_string(), payload.clone())]))
                }
                CheckedRuntimeBinding::Analytics { name, fields }
                    if Some(name.as_str()) == head =>
                {
                    Some(("write", fields.clone()))
                }
                _ => None,
            });
        let Some((operation, fields)) = declaration else {
            return false;
        };
        if member != Some(operation) {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("declared sink supports only '{operation}'"),
                tight_span(cx.text, target),
            ));
        }
        let mut seen = HashSet::new();
        if let Some(object) = object {
            for (key, key_node, value) in object_entries(object, cx.text) {
                self.check_sink_entry(cx, key_node, key, value, &fields, &mut seen);
            }
        }
        for (name, ty) in fields {
            if !seen.contains(&name) && !matches!(ty, ResolvedType::Nullable(_)) {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("missing required input '{name}' to declared sink"),
                    tight_span(cx.text, node),
                ));
            }
        }
        self.sends.insert(NodeKey::of(node), sink_delivery_type());
        self.check_send_when(cx, node);
        true
    }

    fn check_sink_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        key_node: &SyntaxNode,
        key: &str,
        value: Option<&SyntaxNode>,
        fields: &[(String, ResolvedType)],
        seen: &mut HashSet<String>,
    ) {
        seen.insert(key.to_string());
        let expected = fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, ty)| ty.clone());
        let (actual, span) = self.entry_value(cx, key_node, value, expected.clone());
        match expected {
            Some(expected) if !actual.is_error() && !self.types_compatible(&actual, &expected) => {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "'{key}': expected {}, found {}",
                        self.show(cx.module, &expected),
                        self.show(cx.module, &actual)
                    ),
                    span,
                ))
            }
            None => self.diags.push(Diagnostic::error(
                "E3010",
                format!("declared sink has no input '{key}'"),
                tight_span(cx.text, key_node),
            )),
            _ => {}
        }
    }

    fn stmt_std_send(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        target: &SyntaxNode,
        object: Option<&SyntaxNode>,
    ) {
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

    /// Dotted name of a `send` target rooted at a deployment-bound
    /// (external) import, if it is one.
    fn external_target_name(&self, cx: &Ctx<'_, '_>, target: &SyntaxNode) -> Option<String> {
        match target.kind {
            SyntaxKind::NameRef => match self.tables.node_binding.get(&NodeKey::of(target)) {
                Some(Binding::External { .. }) => {
                    name_or_ref_word(target, cx.text).map(str::to_string)
                }
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
                let head = name_or_ref_word(parts[0], cx.text)?;
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
                self.check_entry_assignment(cx, key, key_node, value, &expected, "E3001");
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3015");
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
            // Each arm inherits the incoming facts; the closed callback
            // discriminant additionally selects its exact contract arm.
            let mut arm_env = cx.narrow.clone();
            if let (Some(subject), Some(case @ ("complete" | "unsupported"))) = (subject, case)
                && cases
                    .as_ref()
                    .is_some_and(|cases| cases.iter().any(|known| known == case))
            {
                let subject = unwrap_groups(subject);
                let member = kids(subject);
                if subject.kind == SyntaxKind::Member
                    && member.len() == 3
                    && name_text(member[2], cx.text) == Some("outcome")
                    && self
                        .narrowed_chain(cx, member[0])
                        .or_else(|| self.types.node_types.get(&NodeKey::of(member[0])).cloned())
                        == Some(callback_diagnostic_result(None))
                    && let Some(key) = self.narrow_key_for(cx, member[0])
                    && !matches!(key.decl, DeclKey::Unresolved(_))
                {
                    arm_env.insert(key, callback_diagnostic_result(Some(case)));
                }
            }
            let arm_cx = Ctx {
                narrow: &arm_env,
                ..*cx
            };
            self.walk_seq(&arm_cx, &statements);
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

    /// Domain/limit/header-end of a `for` statement header: the first
    /// expression is the domain, a second one is the limit only at
    /// `limit_at + 2`.
    fn for_header_scan<'n>(
        parts: &[&'n SyntaxNode],
        text: &str,
    ) -> (Option<&'n SyntaxNode>, Option<&'n SyntaxNode>, usize) {
        let mut limit_at = None;
        for (i, part) in parts.iter().enumerate() {
            if is_name(part, text, "limit") {
                limit_at = Some(i);
            }
        }
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
        (domain, limit, header_end)
    }

    /// `for item in domain limit=n ...`: collection domain, positive
    /// integer limit, item-typed body.
    fn stmt_for(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let parts = kids(node);
        // Header expressions (domain, then the `limit =` value) mirror
        // resolve: the first expression is the domain, a second one is
        // the limit only at `limit_at + 2`.
        let (domain, limit, header_end) = Self::for_header_scan(&parts, cx.text);
        // The `limit=` slot is parser-required.
        if let Some(domain) = domain {
            self.check_for_domain(cx, node, domain);
        }
        if let Some(limit) = limit {
            self.check_for_limit(cx, limit);
        }
        self.walk_for_body(cx, node, &parts, domain, header_end);
    }

    fn check_for_domain(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, domain: &SyntaxNode) {
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

    fn check_for_limit(&mut self, cx: &Ctx<'_, '_>, limit: &SyntaxNode) {
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

    fn walk_for_body(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parts: &[&SyntaxNode],
        domain: Option<&SyntaxNode>,
        header_end: usize,
    ) {
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
    fn phase2_scenario(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        described: bool,
    ) {
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
        // DESIGN §5: `by` evaluates before any declared parameter
        // default, so an explicit-default parameter is unavailable to
        // it, directly or through a helper call.
        self.check_by_explicit_defaults(text, node, &params);
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        if let Some(by) = attribute_value(node, "by", text) {
            let ty = self.expr(&cx, by, None);
            self.expect_bool(&cx, tight_span(text, by), &ty, "`by=`");
        }
        let mut committed_event = false;
        let hook = attribute_value(node, "on", text)
            .map(|on| self.check_scenario_on(&cx, node, id, on, &mut committed_event));
        let read = self.check_scenario_read(&cx, node, id, described);
        if let Some(label) = attribute_value(node, "label", text) {
            self.check_scalar_caption(&cx, label, "label");
        }
        if let Some(expose) = attribute_value(node, "expose", text) {
            self.check_scenario_expose(text, expose);
        }
        // Leading guards narrow the `do` body.
        let mut env = NarrowEnv::default();
        let example_event =
            self.seed_scenario_event_env(module, text, node, committed_event, &mut env);
        self.walk_scenario_guards(module, file, text, node, &mut env);
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
                self.check_example_headers(file, text, module, child, example_event.as_ref());
            }
        }
    }

    fn seed_scenario_event_env(
        &mut self,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        committed_event: bool,
        env: &mut NarrowEnv,
    ) -> Option<ResolvedType> {
        // A validated declared event types the handler payload:
        // `event` carries the event's record instead of `{opaque}`.
        let on_event = attribute_value(node, "on", text)
            .and_then(|on| self.on_event_payload(module, text, on));
        let mut example_event = on_event.clone();
        if let Some(event) = on_event {
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                event,
            );
        }
        // Only the validated model-source branch admits these immutable
        // identities. The id stays text even for deletion; no stored record
        // or before/after snapshot is granted by a committed event.
        if committed_event {
            let payload = ResolvedType::Object(vec![
                ("id".to_string(), ResolvedType::Scalar(Scalar::Text)),
                ("version".to_string(), ResolvedType::Scalar(Scalar::Int)),
            ]);
            example_event = Some(payload.clone());
            env.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                payload,
            );
        }
        // A validated delivery completion types the handler payload
        // with the DESIGN §8 envelope instead of `{opaque}`: the
        // op's declared result flows to `event.result` and the closed
        // status vocabulary to `event.status`.
        if let Some(on) = attribute_value(node, "on", text)
            && let Some(envelope) = self.on_completion_payload(module, text, on)
        {
            example_event = Some(envelope.clone());
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
        example_event
    }

    fn walk_scenario_guards(
        &mut self,
        module: ModuleId,
        file: SourceId,
        text: &str,
        node: &SyntaxNode,
        env: &mut NarrowEnv,
    ) {
        for child in kids(node) {
            if child.kind == SyntaxKind::Require && !has_error(child) {
                let guard_cx = Ctx {
                    module,
                    file,
                    text,
                    narrow: env,
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
                    self.collect_narrow(&narrow_cx, cond, false, env);
                }
            }
        }
    }

    /// Event payload behind a handler's `on=`, when it names a
    /// validated declared event: single-segment local events and
    /// `Cap.event` capability events, and the fixed Identity removal payload.
    /// Queues, timers, model hooks,
    /// change events, completions and unknown sources yield `None`
    /// (their payloads stay opaque).
    fn on_event_payload(
        &self,
        module: ModuleId,
        text: &str,
        on: &SyntaxNode,
    ) -> Option<ResolvedType> {
        if on.kind != SyntaxKind::Path {
            return None;
        }
        if let Some(event) = self
            .types
            .std_capability_event_handlers
            .get(&NodeKey::of(on))
        {
            return Some(event.payload.clone());
        }
        let segments = path_segments(on, text);
        if let [name] = segments.as_slice()
            && let Some(payload) = self
                .types
                .runtime_bindings
                .get(&module)
                .into_iter()
                .flatten()
                .find_map(|binding| match binding {
                    CheckedRuntimeBinding::Queue {
                        name: declared,
                        payload,
                    } if declared == name => Some(payload.clone()),
                    _ => None,
                })
        {
            return Some(payload);
        }
        if segments == ["teams", "member_removed"] {
            // TeamsMemberRemovedEvent retains the removed subject. Remover and
            // causation belong to the separate verified ingress envelope.
            return Some(ResolvedType::Object(vec![
                ("team_id".into(), ResolvedType::Scalar(Scalar::Text)),
                ("membership_id".into(), ResolvedType::Scalar(Scalar::Text)),
                ("user".into(), ResolvedType::Scalar(Scalar::User)),
            ]));
        }
        let symbol = match segments.len() {
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
        };
        symbol.map(|symbol| ResolvedType::Record {
            symbol,
            stored: false,
        })
    }

    /// Delivery envelope behind a handler's `on=Cap.op.completed`
    /// (DESIGN §8): `delivery_id:text`,
    /// `status:enum(succeeded,failed,unknown,skipped)`,
    /// `result:R?` from the op's declared result, `error:DeliveryError?`.
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
        if let Some(completion) = self
            .types
            .std_delivery_completion_handlers
            .get(&NodeKey::of(on))
        {
            return Some(completion.payload.clone());
        }
        let head = self.prod_or_imported(module, segments[0])?;
        let SymbolKind::Capability { ops, .. } = &self.tables.symbols[head.0 as usize].kind else {
            return None;
        };
        let op = ops
            .iter()
            .copied()
            .find(|o| self.tables.symbols[o.0 as usize].name == segments[1])?;
        Some(completion_envelope(
            self.results.get(&op).cloned().flatten(),
        ))
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
    /// (`E3001`). A `read=true scope=authority` report is an explicit
    /// information grant, so DESIGN §522 requires a description
    /// identifying the information exposed (`E3001` when undescribed).
    /// The parser pins both value spellings. Returns whether this
    /// scenario is a read operation.
    fn check_scenario_read(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        _id: SymbolId,
        described: bool,
    ) -> bool {
        let read = attribute_value(node, "read", cx.text).is_some();
        let scope = attribute_value(node, "scope", cx.text);
        if scope.is_some() && !read {
            self.diags.push(Diagnostic::error(
                "E3001",
                "scope=authority needs read=true".to_string(),
                tight_span(cx.text, scope.unwrap_or(node)),
            ));
        }
        if scope.is_some() && read && !described {
            self.diags.push(Diagnostic::error(
                "E3001",
                "scope=authority reports must have a description identifying the information exposed"
                    .to_string(),
                tight_span(cx.text, scope.unwrap_or(node)),
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
            let field = field_parts(param_node, text);
            let default = field.default;
            if let Some(default) = default {
                self.parameter_defaults.insert(param, default.clone());
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
            if let Some(caption) = field.label {
                let narrow = NarrowEnv::default();
                let cx = Self::body_cx(module, file, text, &narrow);
                self.check_scalar_caption(&cx, caption, "label");
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

    /// Reject `by=` dependence on explicit-default parameters
    /// (DESIGN §5: admission runs before defaults, so `p:T=expr` is
    /// unavailable to `by` directly or through a helper call's
    /// arguments, even when a caller supplies it). Required inputs,
    /// implicit null/empty-array absence values and fixed admission
    /// facts are untouched. Reports `E3011` per offending reference
    /// without moving the permission expression or reordering
    /// defaults.
    fn check_by_explicit_defaults(&mut self, text: &str, node: &SyntaxNode, params: &[SymbolId]) {
        let Some(by) = attribute_value(node, "by", text) else {
            return;
        };
        let mut banned: HashSet<SymbolId> = HashSet::new();
        for (i, param_node) in kids(node)
            .into_iter()
            .filter(|c| c.kind == SyntaxKind::Parameter)
            .enumerate()
        {
            let Some(param) = params.get(i).copied() else {
                continue;
            };
            if field_parts(param_node, text).default.is_some() {
                banned.insert(param);
            }
        }
        if banned.is_empty() {
            return;
        }
        let mut work = vec![by];
        while let Some(current) = work.pop() {
            if current.kind == SyntaxKind::NameRef
                && let Some(Binding::Symbol(target)) =
                    self.tables.node_binding.get(&NodeKey::of(current))
                && banned.contains(target)
            {
                self.diags.push(Diagnostic::error(
                    "E3011",
                    format!(
                        "`by=` cannot use explicit-default parameter '{}': `by` runs before defaults; keep authorization on admission-available inputs, and put only business validation needing resolved defaults in leading `require` (`by=false` is forbidden, `require=false` is rule_failed)",
                        self.tables.symbols[target.0 as usize].name
                    ),
                    tight_span(text, current),
                ));
            }
            work.extend(kids(current));
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
        let (read_operation, read_params, candidate) =
            self.resolve_choice_read(module, text, read, owner)?;
        let mapped = self.map_choice_read_args(
            module,
            metadata.span.file,
            text,
            read,
            &read_params,
            inputs,
            assisted,
        )?;
        for (index, parameter) in read_params.iter().enumerate() {
            let ty = self.decl_type(*parameter);
            let required = !self.param_has_default(*parameter)
                && !matches!(ty, ResolvedType::Nullable(_) | ResolvedType::Array { .. });
            if mapped[index].is_none() && required {
                return Err(fail("missing required read argument mapping"));
            }
        }
        let (value, labels) = self.check_choice_value_labels(
            text,
            entry("value"),
            entry("labels"),
            candidate,
            assisted,
        )?;
        Ok(CheckedInputChoice {
            read_operation,
            arguments: mapped.into_iter().flatten().collect(),
            value,
            labels,
        })
    }

    /// Resolve the `read=` operation of a `choices=` metadata object to
    /// its scenario, its parameters and its stored-model candidate.
    fn resolve_choice_read(
        &self,
        module: ModuleId,
        text: &str,
        read: &SyntaxNode,
        owner: SymbolId,
    ) -> Result<(SymbolId, Vec<SymbolId>, SymbolId), String> {
        let fail = |message: &str| format!("choices=: {message}");
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
            .then(|| name_or_ref_word(callee, text))
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
        Ok((read_operation, read_params.clone(), *candidate))
    }

    /// Map the `read=` call arguments onto the read operation's inputs:
    /// every mapping must be an input-rooted stable path of matching type.
    fn map_choice_read_args(
        &self,
        module: ModuleId,
        metadata_file: SourceId,
        text: &str,
        read: &SyntaxNode,
        read_params: &[SymbolId],
        inputs: &[SymbolId],
        assisted: SymbolId,
    ) -> Result<Vec<Option<CheckedChoiceArgument>>, String> {
        let fail = |message: &str| format!("choices=: {message}");
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, metadata_file, text, &narrow);
        let call_parts = kids(read);
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
        Ok(mapped)
    }

    /// Check the `value=`/`labels=` entries of a `choices=` metadata
    /// object against the candidate's declared fields.
    fn check_choice_value_labels(
        &self,
        _text: &str,
        value: Option<&SyntaxNode>,
        labels_node: Option<&SyntaxNode>,
        candidate: SymbolId,
        assisted: SymbolId,
    ) -> Result<(CheckedChoiceValue, Vec<String>), String> {
        let fail = |message: &str| format!("choices=: {message}");
        let (value, actual) = if let Some(value) = value {
            let field_name = string_literal_value(value)
                .ok_or_else(|| fail("value= requires one declared candidate field name string"))?;
            let field = self
                .record_field_named(candidate, &field_name)
                .ok_or_else(|| fail("value= names no declared candidate field"))?;
            let actual = self.decl_type(field);
            if !self.choice_leaf_supported(&actual) {
                return Err(fail(
                    "value= requires a supported candidate scalar, enum or model-reference leaf",
                ));
            }
            (CheckedChoiceValue::Field(field_name), actual)
        } else {
            (
                CheckedChoiceValue::Record,
                ResolvedType::Record {
                    symbol: candidate,
                    stored: true,
                },
            )
        };
        let expected = self.decl_type(assisted);
        if !self.types_compatible(&actual, &expected) {
            return Err(fail(
                "candidate value is incompatible with the assisted input",
            ));
        }
        let labels_node = labels_node.ok_or_else(|| fail("requires labels="))?;
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
                .record_field_named(candidate, &name)
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
        Ok((value, labels))
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
    /// the hook identity for pre-commit model hooks; `committed_event` is
    /// set only by the validated model-source branch.
    fn check_scenario_on(
        &mut self,
        cx: &Ctx<'_, '_>,
        _node: &SyntaxNode,
        _id: SymbolId,
        on: &SyntaxNode,
        committed_event: &mut bool,
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
            2 => self.check_on_two_seg(cx, on, &segments, committed_event),
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
        committed_event: &mut bool,
    ) -> Option<(SymbolId, CrudOp)> {
        if segments == ["teams", "member_removed"] || segments == ["instrumentation", "error"] {
            return None;
        }
        // `Scenario.completed` for exported user operations.
        if segments[1] == "completed" {
            return self.check_on_scenario_completed(cx, on, segments);
        }
        let scopes = &self.tables.module_scopes[cx.module.0 as usize];
        if let Some(ScopedName::External { provider, name }) = scopes.prod.get(segments[0])
            && provider == "std"
            && let Some(cap) = std_capability(name)
        {
            if let Some(event) = cap.events.iter().find(|event| event.name == segments[1]) {
                let owner = &self.tables.modules[cx.module.0 as usize].name;
                self.types.std_capability_event_handlers.insert(
                    NodeKey::of(on),
                    CheckedStdCapabilityEvent {
                        capability: cap.name.to_string(),
                        event: event.name.to_string(),
                        source: format!("{owner}.{}", segments.join(".")),
                        payload: event.payload.map(std_nominal_leaf_type).unwrap_or_else(|| {
                            ResolvedType::Object(
                                event
                                    .fields
                                    .iter()
                                    .map(|(name, declared)| {
                                        (name.to_string(), std_nominal_leaf_type(declared))
                                    })
                                    .collect(),
                            )
                        }),
                    },
                );
                return None;
            }
            if cap.operations.iter().any(|op| op.name == segments[1]) {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!(
                        "on={} names an operation; delivery completions use {}.completed",
                        segments.join("."),
                        segments.join("."),
                    ),
                    tight_span(cx.text, on),
                ));
                return None;
            }
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
            SymbolKind::Model { .. } => {
                self.check_on_model_source(cx, on, head, segments, committed_event)
            }
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
        committed_event: &mut bool,
    ) -> Option<(SymbolId, CrudOp)> {
        let hook_op = match segments[1] {
            "create" => Some(CrudOp::Create),
            "update" => Some(CrudOp::Update),
            "delete" => Some(CrudOp::Delete),
            "created" | "updated" | "deleted" => {
                *committed_event = true;
                None
            }
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
        let scopes = &self.tables.module_scopes[cx.module.0 as usize];
        if let Some(ScopedName::External { provider, name }) = scopes.prod.get(segments[0])
            && provider == "std"
            && let Some(cap) = std_capability(name)
            && let Some(op) = cap.operations.iter().find(|op| op.name == segments[1])
        {
            let module = &self.tables.modules[cx.module.0 as usize];
            let mut imports = module.imports.iter().flat_map(|import| {
                import
                    .members
                    .iter()
                    .filter(move |member| member.alias == segments[0])
                    .map(move |member| (import, member))
            });
            let (import, member) = imports.next()?;
            // Resolver rejects duplicate aliases. Do not attach an arbitrary route
            // to their otherwise recoverable external binding in an invalid program.
            if imports.next().is_some() || import.provider != "std" || member.name != *name {
                return None;
            }
            let owner = &module.name;
            self.types.std_delivery_completion_handlers.insert(
                NodeKey::of(on),
                CheckedStdDeliveryCompletion {
                    capability: cap.name.to_string(),
                    op: op.name.to_string(),
                    source: format!("{owner}.{}", segments.join(".")),
                    canonical_operation: format!("{}.{}", cap.name, op.name),
                    result_type: op.result.to_string(),
                    module: cx.module,
                    alias: member.alias.clone(),
                    import_span: import.span,
                    binding: import
                        .from
                        .as_ref()
                        .map(|_| format!("{owner}.{}", member.alias)),
                    from: import.from.clone(),
                    payload: completion_envelope(Some(std_delivery_result_type(op))),
                },
            );
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
    /// `event_type` carries the handler's validated event payload (T10 C2):
    /// an `event={...}` literal checks against its record or completion envelope so nested
    /// bare cases claim their enum types; still diagnostic-free here.
    fn check_example_headers(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        event_type: Option<&ResolvedType>,
    ) {
        let mut narrow = NarrowEnv::default();
        if let Some(event_type) = event_type {
            narrow.insert(
                NarrowKey {
                    decl: DeclKey::CtxEvent,
                    path: Vec::new(),
                },
                event_type.clone(),
            );
        }
        let cx = Ctx {
            module,
            file,
            text,
            narrow: &narrow,
            strict: false,
            server_default: false,
        };
        let mut header_facts = NarrowEnv::default();
        self.check_example_header_attrs(&cx, node, text, event_type, &mut header_facts);
        // Headers retain their type-owned unresolved diagnostics; general
        // BDD expression values retain the runner's diagnostic profile.
        let unresolved_before = self.types.unresolved_names.len();
        let rows: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::ExampleRow)
            .collect();
        // An input column can replace its header value. Descendant inputs
        // keep a parent's nonnull proof; equal/ancestor inputs cannot.
        if let Some(heading) = rows.first() {
            self.prune_example_header_facts(&cx, heading, text, &mut header_facts);
        }
        narrow.extend(header_facts);
        let cx = Ctx {
            module,
            file,
            text,
            narrow: &narrow,
            strict: false,
            server_default: false,
        };
        self.check_example_table_rows(&cx, text, &rows);
        if let Some(body) = kids(node)
            .into_iter()
            .find(|n| n.kind == SyntaxKind::DoBlock)
        {
            self.check_example_body(module, file, text, body);
        }
        self.types.unresolved_names.truncate(unresolved_before);
    }

    /// Check `examples` header attributes: `event=` values check against
    /// the handler payload and establish nonnull facts.
    fn check_example_header_attrs(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        text: &str,
        event_type: Option<&ResolvedType>,
        header_facts: &mut NarrowEnv,
    ) {
        for child in kids(node) {
            if child.kind == SyntaxKind::Attribute
                && let Some((key, value)) = attribute_parts(child)
            {
                let expect = if is_name(key, text, "event") {
                    event_type.cloned()
                } else {
                    None
                };
                self.expr(cx, value, expect);
                if is_name(key, text, "event")
                    && let Some(event_type) = event_type
                {
                    self.example_object_nonnull_facts(
                        text,
                        value,
                        event_type,
                        &mut Vec::new(),
                        header_facts,
                    );
                }
            }
        }
    }

    /// Drop header nonnull facts shadowed by the heading row's input
    /// columns: descendant inputs keep a parent proof, equal/ancestor
    /// inputs cannot.
    fn prune_example_header_facts(
        &self,
        cx: &Ctx<'_, '_>,
        heading: &SyntaxNode,
        text: &str,
        header_facts: &mut NarrowEnv,
    ) {
        for part in kids(heading) {
            if is_punct(part, text, "->") {
                break;
            }
            if is_expression(part.kind)
                && let Some(target) = self.narrow_key_for(cx, part)
            {
                header_facts.retain(|key, _| {
                    key.decl != target.decl || !key.path.starts_with(&target.path)
                });
            }
        }
    }

    /// Type the example table rows: the first row establishes the column
    /// types, later rows check against them.
    fn check_example_table_rows(&mut self, cx: &Ctx<'_, '_>, text: &str, rows: &[&SyntaxNode]) {
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
                        observation_types.push(self.expr(cx, part, None));
                    } else {
                        input_types.push(self.expr(cx, part, None));
                    }
                } else {
                    let expectation = if expected {
                        observation_types.get(column).cloned()
                    } else {
                        input_types.get(column).cloned()
                    };
                    if expected {
                        self.check_example_expected(cx, part, expectation);
                    } else {
                        self.expr(cx, part, expectation);
                    }
                }
                column += 1;
            }
        }
    }

    /// Expected values are typed assertions, unlike deliberately invalid
    /// submitted example inputs. Preserve contextual literal inference first,
    /// then require compatibility even in the examples' light context.
    fn check_example_expected(
        &mut self,
        cx: &Ctx<'_, '_>,
        value: &SyntaxNode,
        expected: Option<ResolvedType>,
    ) {
        let actual = self.expr(cx, value, expected.clone());
        if let Some(expected) = expected {
            let strict = Ctx {
                strict: true,
                ..*cx
            };
            self.assign_ok(
                &strict,
                tight_span(cx.text, value),
                &actual,
                &expected,
                "example expected value",
            );
        }
    }

    /// Check the example body steps: bindings, calls and assertions with
    /// assertion refinements threaded into later steps.
    fn check_example_body(
        &mut self,
        module: ModuleId,
        file: SourceId,
        text: &str,
        body: &SyntaxNode,
    ) {
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
                    self.check_example_assert(module, file, text, step, &mut env);
                }
                _ => {}
            }
        }
    }

    /// Check one example assertion: inputs establish observations, `true`
    /// observations refine the environment for later steps.
    fn check_example_assert(
        &mut self,
        module: ModuleId,
        file: SourceId,
        text: &str,
        step: &SyntaxNode,
        env: &mut NarrowEnv,
    ) {
        let cx = Ctx {
            module,
            file,
            text,
            narrow: &*env,
            strict: false,
            server_default: false,
        };
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
                self.check_example_expected(
                    &cx,
                    part,
                    observations.get(column).map(|(_, ty)| ty.clone()),
                );
                if text[part.span.start as usize..part.span.end as usize].trim() == "true"
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

    /// Only explicit, checked fixture values establish member nonnull facts.
    /// The proof retains the declared type, never the literal's inferred shape.
    fn example_object_nonnull_facts(
        &mut self,
        text: &str,
        value: &SyntaxNode,
        expected: &ResolvedType,
        path: &mut Vec<String>,
        facts: &mut NarrowEnv,
    ) {
        let value = unwrap_groups(value);
        if value.kind != SyntaxKind::Object || has_error(value) {
            return;
        }
        let (expected, _) = strip_nullable(expected);
        for (name, _, supplied) in object_entries(value, text) {
            let Some(supplied) = supplied else {
                continue;
            };
            let declared = match &expected {
                ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => fields
                    .iter()
                    .find(|(field, _)| field == name)
                    .map(|(_, ty)| ty.clone()),
                ResolvedType::Record { symbol, .. } => {
                    let field = self.tables.symbols[symbol.0 as usize]
                        .fields_of()
                        .iter()
                        .find(|field| self.tables.symbols[field.0 as usize].name == name)
                        .copied();
                    field.map(|field| self.decl_type(field))
                }
                _ => None,
            };
            let Some(declared) = declared else {
                continue;
            };
            let Some(actual) = self.types.node_types.get(&NodeKey::of(supplied)) else {
                continue;
            };
            let concrete_object = unwrap_groups(supplied).kind == SyntaxKind::Object;
            let (actual_inner, _) = strip_nullable(actual);
            let nonnull =
                actual.is_proven_nonnull() || (concrete_object && actual_inner.is_proven_nonnull());
            if !nonnull || !self.types_compatible(&actual_inner, &declared) {
                continue;
            }
            path.push(name.to_string());
            if let ResolvedType::Nullable(inner) = &declared {
                facts.insert(
                    NarrowKey {
                        decl: DeclKey::CtxEvent,
                        path: path.clone(),
                    },
                    inner.as_ref().clone(),
                );
            }
            self.example_object_nonnull_facts(text, supplied, &declared, path, facts);
            path.pop();
        }
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
            ResolvedType::Scalar(Scalar::Text)
            | ResolvedType::Message(_)
            | ResolvedType::InlineMessage => {}
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
                let initial = parts.default.and_then(|n| name_or_ref_word(n, cx.text));
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
            SyntaxKind::NameRef | SyntaxKind::Member => {
                self.types.resolved_cases.contains(&NodeKey::of(node))
            }
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

    /// Collect scenario publication and input metadata before phase 1;
    /// declared types and pages may precede their targets in source.
    fn collect_scenario_flags(&mut self, trees: &[(SourceId, SyntaxNode)]) {
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
                        if let Some(id) =
                            self.decl_symbol(module, &text, item, &["export", "scenario"])
                        {
                            if is_read {
                                self.read_scenarios.insert(id);
                            }
                            if attribute_value(item, "expose", &text).is_some() {
                                self.unpublished_scenarios.insert(id);
                            }
                            if let SymbolKind::Scenario { params, .. } =
                                &self.tables.symbols[id.0 as usize].kind
                            {
                                for (param, parameter) in params.iter().zip(
                                    kids(item)
                                        .into_iter()
                                        .filter(|n| n.kind == SyntaxKind::Parameter),
                                ) {
                                    if let Some(default) = field_parts(parameter, &text).default {
                                        self.refresh_defaults.insert(*param, default.clone());
                                    }
                                }
                            }
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
        let target_model = self.resolve_rule_target(text, module, node);
        match node.kind {
            SyntaxKind::Invariant => {
                self.phase2_invariant(&cx, text, node);
            }
            SyntaxKind::Retain => {
                self.phase2_retain(&cx, text, node, target_model);
            }
            SyntaxKind::Policy => {
                self.phase2_policy_rule(file, module, text, node, &cx, target_model);
            }
            SyntaxKind::Unique => {
                self.phase2_unique_rule(&cx, text, node, target_model);
            }
            SyntaxKind::Lock => {
                self.phase2_lock_rule(&cx, text, node, target_model);
            }
            _ => {}
        }
    }

    fn resolve_rule_target(
        &mut self,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) -> Option<SymbolId> {
        let target = kids(node)
            .iter()
            .find(|n| n.kind == SyntaxKind::Path)
            .copied();
        let target_symbol =
            target.and_then(|t| self.tables.node_symbol.get(&NodeKey::of(t)).copied());
        match target_symbol {
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
        }
    }

    fn phase2_invariant(&mut self, cx: &Ctx<'_, '_>, text: &str, node: &SyntaxNode) {
        for child in kids(node) {
            if is_expression(child.kind) {
                let ty = self.expr(cx, child, None);
                self.expect_bool(cx, tight_span(text, child), &ty, "invariant");
            }
        }
    }

    fn phase2_retain(
        &mut self,
        cx: &Ctx<'_, '_>,
        text: &str,
        node: &SyntaxNode,
        target_model: Option<SymbolId>,
    ) {
        if let Some(model) = target_model {
            self.check_retain_dedupe(text, node, model);
        }
        if let Some(until) = attribute_value(node, "until", text) {
            self.check_retain_until(cx, node, until);
        }
    }

    fn phase2_policy_rule(
        &mut self,
        file: SourceId,
        module: ModuleId,
        text: &str,
        node: &SyntaxNode,
        cx: &Ctx<'_, '_>,
        target_model: Option<SymbolId>,
    ) {
        if let Some(read) = attribute_value(node, "read", text) {
            let ty = self.expr(cx, read, None);
            self.expect_bool(cx, tight_span(text, read), &ty, "`read=`");
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
            self.check_selectors(cx, node, model, fields, "fields", true);
        }
    }

    fn phase2_unique_rule(
        &mut self,
        cx: &Ctx<'_, '_>,
        text: &str,
        node: &SyntaxNode,
        target_model: Option<SymbolId>,
    ) {
        if let Some(value) = attribute_value(node, "where", text) {
            let ty = self.expr(cx, value, None);
            self.expect_bool(cx, tight_span(text, value), &ty, "`where=`");
        }
        if let Some(model) = target_model
            && let Some(fields) = attribute_value(node, "fields", text)
        {
            self.check_selectors(cx, node, model, fields, "fields", false);
        }
    }

    fn phase2_lock_rule(
        &mut self,
        cx: &Ctx<'_, '_>,
        text: &str,
        node: &SyntaxNode,
        target_model: Option<SymbolId>,
    ) {
        if let Some(when) = attribute_value(node, "when", text) {
            if matches!(literal_leaf(when, text), Some((_, "true"))) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "an omitted lock predicate already means true; do not repeat when=true"
                        .to_string(),
                    tight_span(text, when),
                ));
            }
            let ty = self.expr(cx, when, None);
            self.expect_bool(cx, tight_span(text, when), &ty, "`when=`");
        }
        if let Some(model) = target_model
            && let Some(fields) = attribute_value(node, "fields", text)
        {
            self.check_selectors(cx, node, model, fields, "fields", false);
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
        // Resolve the full consuming closure after every helper/default body
        // has been typed, including declarations in later/imported modules.
        self.retention_roots.push(until.clone());
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
    /// and no permission. Returns the selected dotted paths. An
    /// `OrderList` carries the same `Path`/`Descending` children as a
    /// fixed `order=` list, so preference-order cases share this path.
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
        if !matches!(
            selectors.kind,
            SyntaxKind::Selectors | SyntaxKind::OrderList
        ) {
            return selected;
        }
        // An `OrderList` wraps one `Selectors` in its brackets; validate
        // the inner list so preference cases share fixed-order rules.
        let selectors = if selectors.kind == SyntaxKind::OrderList {
            kids(selectors)
                .into_iter()
                .find(|child| child.kind == SyntaxKind::Selectors)
                .unwrap_or(selectors)
        } else {
            selectors
        };
        for child in kids(selectors) {
            self.check_selector_child(cx, node, model, what, allow_reserved, child, &mut selected);
        }
        selected
    }

    /// A `callback_diagnostics` leaf records its observation and ends
    /// the selector (`true`); anything else falls through (`false`).
    fn check_callback_observation(
        &mut self,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        what: &str,
        selected: &mut Vec<String>,
    ) -> bool {
        if segments.len() == 2
            && segments[1] == "callback_diagnostics"
            && (node.kind == SyntaxKind::Policy || what == "columns")
            && let Some(field) = self.model_field_named(model, segments[0])
            && let Some(source) = self.types.callback_diagnostic_sources.get(&field).cloned()
        {
            let canonical = segments.join(".");
            self.types.callback_diagnostic_selectors.insert(
                NodeKey::of(path),
                CheckedGenerationCallbackObservation {
                    node: NodeKey::of(path),
                    path: canonical.clone(),
                    source,
                    ty: None,
                },
            );
            selected.push(canonical);
            return true;
        }
        false
    }

    fn check_selector_child(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        what: &str,
        allow_reserved: bool,
        child: &SyntaxNode,
        selected: &mut Vec<String>,
    ) {
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
            _ => return,
        };
        if descending && what != "order" {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!("descending markers belong to order=, not {what}="),
                tight_span(cx.text, child),
            ));
        }
        let source_segments = path_segments(path, cx.text);
        let segments = if what == "order" && node.kind == SyntaxKind::Collection {
            self.ui_order_segments(cx, node, model, &source_segments)
        } else {
            source_segments
        };
        if segments.is_empty() {
            return;
        }
        if self.check_callback_observation(node, model, path, &segments, what, selected) {
            return;
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
            return;
        }
        if self.navigate_selector(cx, node, model, path, &segments, allow_reserved) {
            selected.push(segments.join("."));
            if what == "order" && node.kind == SyntaxKind::Collection {
                self.types.ui_order_selectors.insert(
                    NodeKey::of(path),
                    format!(
                        "{}{}",
                        if descending { "-" } else { "" },
                        segments.join(".")
                    ),
                );
            }
        }
    }

    /// Ordered-scalar (`E3006`) validation for one fixed or
    /// preference-case ordering list: each `Path`/`Descending` child
    /// must end at an ordered scalar. Canonicalization (and path
    /// navigation) already ran through `check_selectors`.
    fn check_order_key_list(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        list: &SyntaxNode,
    ) {
        // Same `OrderList` normalization as `check_selectors` above.
        let list = if list.kind == SyntaxKind::OrderList {
            kids(list)
                .into_iter()
                .find(|part| part.kind == SyntaxKind::Selectors)
                .unwrap_or(list)
        } else {
            list
        };
        for selector in kids(list) {
            let path = if selector.kind == SyntaxKind::Descending {
                kids(selector)
                    .iter()
                    .find(|part| part.kind == SyntaxKind::Path)
                    .copied()
            } else {
                Some(selector)
            };
            if let Some(path) = path
                && let Some(ty) = self.ui_selector_type(
                    model,
                    &self.ui_order_segments(cx, node, model, &path_segments(path, cx.text)),
                )
            {
                self.check_order_key(cx, path, &ty);
            }
        }
    }

    /// Validate a preference-dispatched `order=` (`E3001`/`E3006`):
    /// `by=` must name an enum preference, every case key must be one
    /// of its cases, and `default=` plus every case list must hold
    /// ordered-scalar selectors over the collection model. Case lists
    /// canonicalize through `check_selectors`, so lowering reads the
    /// same `ui_order_selectors` rows as fixed ordering. Enum cases
    /// without an entry fall back to `default=` at runtime.
    fn check_preference_order(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        order: &SyntaxNode,
    ) {
        let Some(by) = attribute_value(order, "by", cx.text) else {
            return;
        };
        // Resolve `by=` through the checked preference declarations,
        // never expression scope: collection attribute scope carries no
        // `preferences` binding, so `expr` stays a silent `Error` here.
        let segments = path_segments(by, cx.text);
        let cases = if segments.len() == 2 && segments[0] == "preferences" {
            let declared = self
                .prefs
                .get(&cx.module)
                .copied()
                .and_then(|prefs| self.record_field_named(prefs, segments[1]))
                .map(|field| self.decl_type(field));
            match declared {
                Some(ResolvedType::Enum { cases, .. }) => Some(cases),
                Some(_) => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "preference order by= must name an enum preference".to_string(),
                        tight_span(cx.text, by),
                    ));
                    None
                }
                None => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("unknown preference `preferences.{}`", segments[1]),
                        tight_span(cx.text, by),
                    ));
                    None
                }
            }
        } else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "preference order by= must name a preference (preferences.<name>)".to_string(),
                tight_span(cx.text, by),
            ));
            None
        };
        if let Some(default) = attribute_value(order, "default", cx.text) {
            self.check_selectors(cx, node, model, default, "order", true);
            self.check_order_key_list(cx, node, model, default);
        }
        if let Some(case_map) = attribute_value(order, "cases", cx.text) {
            for case in kids(case_map)
                .into_iter()
                .filter(|kid| kid.kind == SyntaxKind::OrderCase)
            {
                let key = kids(case)
                    .iter()
                    .find(|part| part.kind == SyntaxKind::Name)
                    .and_then(|part| part.token())
                    .map(|token| token.text(cx.text).to_string());
                if let Some(key) = key
                    && let Some(cases) = &cases
                    && !cases.contains(&key)
                {
                    self.diags.push(Diagnostic::error(
                        "E3006",
                        format!(
                            "unknown order case `{key}`; expected one of {}",
                            cases.join(", ")
                        ),
                        tight_span(cx.text, case),
                    ));
                }
                if let Some(list) = kids(case)
                    .iter()
                    .find(|part| part.kind == SyntaxKind::OrderList)
                    .copied()
                {
                    self.check_selectors(cx, node, model, list, "order", true);
                    self.check_order_key_list(cx, node, model, list);
                }
            }
        }
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
                ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. }
                    if observed =>
                {
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

    /// Checked terminal type of a UI selector, used only after ordinary
    /// selector navigation has reported invalid paths. This does not grant
    /// read access; the query runner still enforces current field grants.
    fn ui_order_segments<'s>(
        &self,
        cx: &Ctx<'_, '_>,
        collection: &SyntaxNode,
        model: SymbolId,
        segments: &[&'s str],
    ) -> Vec<&'s str> {
        let alias = kids(collection)
            .into_iter()
            .find(|child| is_expression(child.kind))
            .map(unwrap_groups)
            .filter(|domain| domain.kind == SyntaxKind::Query)
            .and_then(|domain| {
                kids(domain).into_iter().find_map(|clause| {
                    let parts = kids(clause);
                    if clause.kind != SyntaxKind::QueryClause
                        || !parts
                            .first()
                            .is_some_and(|part| is_name(part, cx.text, "as"))
                        || self.aliases.get(&NodeKey::of(clause))
                            != Some(&ResolvedType::Record {
                                symbol: model,
                                stored: true,
                            })
                    {
                        return None;
                    }
                    parts.get(1).and_then(|part| name_text(part, cx.text))
                })
            });
        if segments.len() > 1 && alias == segments.first().copied() {
            segments[1..].to_vec()
        } else {
            segments.to_vec()
        }
    }

    fn ui_selector_type(&self, model: SymbolId, segments: &[&str]) -> Option<ResolvedType> {
        let first = *segments.first()?;
        let mut current = if let Some(field) = self.model_field_named(model, first) {
            self.decl_type(field)
        } else if first == "parent" {
            ResolvedType::Record {
                symbol: contained_parent_of(self.tables, model)?,
                stored: true,
            }
        } else {
            reserved_member_type(first)?
        };
        for segment in &segments[1..] {
            current = match current.nullable_inner().unwrap_or(&current) {
                ResolvedType::Record { symbol, .. } => {
                    self.decl_type(self.record_field_named(*symbol, segment)?)
                }
                ResolvedType::Scalar(Scalar::Money) if *segment == "minor" => {
                    ResolvedType::Scalar(Scalar::Int)
                }
                ResolvedType::Scalar(Scalar::Money) if *segment == "currency" => {
                    ResolvedType::Scalar(Scalar::Currency)
                }
                ResolvedType::Scalar(Scalar::User) if *segment == "id" => {
                    ResolvedType::Scalar(Scalar::Text)
                }
                _ => return None,
            };
        }
        Some(current)
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
        let Some(mut current) =
            self.selector_head_type(cx, node, model, path, segments, allow_reserved)
        else {
            return false;
        };
        let rest = &segments[1..];
        for (i, segment) in rest.iter().enumerate() {
            let last = i == rest.len() - 1;
            match self.selector_step(cx, node, model, path, segments, segment, last, &current) {
                Ok(next) => current = next,
                Err(done) => return done,
            }
        }
        true
    }

    fn selector_head_type(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        allow_reserved: bool,
    ) -> Option<ResolvedType> {
        if let Some(field) = self.model_field_named(model, segments[0]) {
            Some(self.decl_type(field))
        } else if segments[0] == "parent" {
            // Contained-model `parent` (DESIGN §2/§4); terminal in
            // selectors (a grant cannot name another record's fields).
            let Some(parent) = contained_parent_of(self.tables, model) else {
                self.selector_fail(cx, node, model, path, segments[0]);
                return None;
            };
            Some(ResolvedType::Record {
                symbol: parent,
                stored: true,
            })
        } else if is_reserved_name(segments[0]) {
            // Readable record metadata in read/grant contexts only;
            // write contexts (CRUD inputs, locks, uniqueness) keep
            // rejecting it, and metadata writes stay rejected.
            if !allow_reserved {
                self.selector_fail(cx, node, model, path, segments[0]);
                return None;
            }
            let Some(ty) = reserved_member_type(segments[0]) else {
                self.selector_fail(cx, node, model, path, segments[0]);
                return None;
            };
            Some(ty)
        } else {
            self.selector_fail(cx, node, model, path, segments[0]);
            None
        }
    }

    fn selector_opaque_step(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        segment: &str,
        last: bool,
        payload: &str,
    ) -> Result<ResolvedType, bool> {
        // Known delivery-observation leaves stay terminal
        // on deployment-bound deliveries (B4); every other
        // opaque member defers to the pending schema.
        if payload == "external delivery target"
            && matches!(segment, "id" | "status" | "error" | "result")
            && !last
        {
            self.selector_fail(cx, node, model, path, &segments.join("."));
            return Err(false);
        }
        Err(true)
    }

    fn selector_record_step(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        segment: &str,
        symbol: SymbolId,
    ) -> Result<ResolvedType, bool> {
        // Interior components must be singular embedded
        // values, never references, arrays or authorities
        // (DESIGN §4): only contracts navigate.
        if !matches!(
            self.tables.symbols[symbol.0 as usize].kind,
            SymbolKind::Contract { .. }
        ) {
            self.selector_fail(cx, node, model, path, &segments.join("."));
            return Err(false);
        }
        let Some(next) = self.record_field_named(symbol, segment) else {
            self.selector_fail(cx, node, model, path, &segments.join("."));
            return Err(false);
        };
        Ok(self.decl_type(next))
    }

    /// One navigation step: `Ok` continues with a new type, `Err(done)`
    /// ends the traversal with the final answer.
    fn selector_step(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        path: &SyntaxNode,
        segments: &[&str],
        segment: &str,
        last: bool,
        current: &ResolvedType,
    ) -> Result<ResolvedType, bool> {
        let inner = match current {
            ResolvedType::Nullable(inner) => inner.as_ref().clone(),
            other => other.clone(),
        };
        match &inner {
            // Deferral, mirroring expression member lookup: an
            // already-diagnosed base stays silent (cascade
            // suppression) and an unavailable-schema base stays
            // silent (supported-but-unavailable; T13 schemas will
            // type it later).
            ResolvedType::Error | ResolvedType::Unknown => Err(true),
            ResolvedType::Opaque(payload) => {
                self.selector_opaque_step(cx, node, model, path, segments, segment, last, payload)
            }
            ResolvedType::Record { symbol, .. } => {
                self.selector_record_step(cx, node, model, path, segments, segment, *symbol)
            }
            // Singular embedded value leaves, exactly as
            // expressions read them (R08; DESIGN §3/§4).
            ResolvedType::Scalar(Scalar::Money) => match segment {
                "minor" => Ok(ResolvedType::Scalar(Scalar::Int)),
                "currency" => Ok(ResolvedType::Scalar(Scalar::Currency)),
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    Err(false)
                }
            },
            ResolvedType::Scalar(Scalar::User) => match segment {
                // Stable `user.id` is readable (DESIGN §3);
                // account contact stays disclosure-gated (only
                // `actor.email` reads, and selectors never have an
                // actor root).
                "id" => Ok(ResolvedType::Scalar(Scalar::Text)),
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    Err(false)
                }
            },
            ResolvedType::Scalar(Scalar::Member) => match segment {
                "id" => Ok(ResolvedType::Scalar(Scalar::Text)),
                "user" => Ok(ResolvedType::Scalar(Scalar::User)),
                "team" => Ok(ResolvedType::Team),
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    Err(false)
                }
            },
            ResolvedType::Team => match segment {
                "id" => Ok(ResolvedType::Scalar(Scalar::Text)),
                "timezone" => Ok(ResolvedType::Scalar(Scalar::Timezone)),
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    Err(false)
                }
            },
            ResolvedType::OperationContext => match segment {
                "id" | "source" => Ok(ResolvedType::Scalar(Scalar::Text)),
                _ => {
                    self.selector_fail(cx, node, model, path, &segments.join("."));
                    Err(false)
                }
            },
            // Every other base rejects deeper navigation: unknown
            // scalar leaves, arrays, delivery interiors past the
            // B4 observation leaves (accepted above, never
            // descended), unions, actions and operations
            // (DESIGN §4).
            _ => {
                self.selector_fail(cx, node, model, path, &segments.join("."));
                Err(false)
            }
        }
    }

    /// Effectful builtin calls under `node`: (name, span) for every
    /// call whose catalog effects are not pure. Without a catalog,
    /// nothing is known effectful.
    fn effectful_calls(&mut self, node: &SyntaxNode, text: &str) -> Vec<(String, Span)> {
        let mut found = Vec::new();
        self.collect_effectful(node, text, &mut found);
        self.strict_purity_roots.push(node.clone());
        found
    }

    /// Selected bounded membership reads retain their StateRead catalog effect.
    /// This typing admission supplies no private runtime stage or authority.
    fn checked_membership_call(&self, node: &SyntaxNode) -> bool {
        let Some(selected) = self.types.selected_calls.get(&NodeKey::of(node)) else {
            return false;
        };
        let SelectedCallTarget::Builtin { id, overload: 0 } = &selected.target else {
            return false;
        };
        if id != "active_member"
            || selected.arguments.len() != 2
            || selected.slots.len() != 2
            || self.types.node_types.get(&NodeKey::of(node))
                != Some(&ResolvedType::Scalar(Scalar::Bool))
        {
            return false;
        }
        let Some(catalog) = self.catalog else {
            return false;
        };
        let Some(overloads) = catalog.overloads(id) else {
            return false;
        };
        let Some(signature) = overloads.first() else {
            return false;
        };
        if catalog.effects(id) != Some(Effects::StateRead)
            || signature.params.len() != 2
            || signature.result != SigType::Named("bool".to_string())
        {
            return false;
        }
        for (index, (name, declared, expected)) in [
            ("person", "user", ResolvedType::Scalar(Scalar::User)),
            ("team", "Team", ResolvedType::Team),
        ]
        .into_iter()
        .enumerate()
        {
            let parameter = &signature.params[index];
            if parameter.name != name
                || parameter.ty != SigType::Named(declared.to_string())
                || parameter.alias.is_some()
                || parameter.in_scope.is_some()
            {
                return false;
            }
            let Some(argument) =
                selected.slots[index].and_then(|slot| selected.arguments.get(slot))
            else {
                return false;
            };
            if self.types.node_types.get(argument) != Some(&expected) {
                return false;
            }
        }
        selected.slots[0] != selected.slots[1]
    }

    fn check_field_membership_default(&mut self, value: &SyntaxNode, text: &str, name: &str) {
        // A membership read needs an owning decision/read stage. Field
        // initializers have no such stage, including server initializers.
        self.strict_purity_roots.push(value.clone());
        let mut pending = vec![value];
        while let Some(node) = pending.pop() {
            if self.checked_membership_call(node) {
                self.diags.push(Diagnostic::error(
                    "E3011",
                    format!("initializer for '{name}' cannot read active membership"),
                    tight_span(text, node),
                ));
            }
            pending.extend(kids(node).into_iter().rev());
        }
    }

    fn bounded_membership_effectful_calls(
        &self,
        node: &SyntaxNode,
        text: &str,
    ) -> Vec<(String, Span)> {
        let mut found = Vec::new();
        let mut pending = vec![node];
        while let Some(current) = pending.pop() {
            if current.kind == SyntaxKind::Call && !self.checked_membership_call(current) {
                // Inspect this call only; its arguments retain their own checks.
                if let Some(head) = kids(current)
                    .into_iter()
                    .find(|child| is_expression(child.kind))
                    .and_then(|head| {
                        kids(head)
                            .into_iter()
                            .find_map(|child| name_text(child, text))
                    })
                    && self
                        .catalog
                        .and_then(|catalog| catalog.effects(head))
                        .is_some_and(|effects| effects != Effects::Pure)
                {
                    found.push((head.to_string(), tight_span(text, current)));
                }
            }
            pending.extend(kids(current).into_iter().rev());
        }
        found
    }

    /// A checked bounded helper cannot smuggle membership into an ordinary
    /// default, caption, retention, CRUD condition or other strict pure site.
    fn check_strict_membership_closures(&mut self) {
        let roots = std::mem::take(&mut self.strict_purity_roots);
        let mut reported = HashSet::new();
        for root in roots {
            let mut pending = vec![&root];
            while let Some(node) = pending.pop() {
                if let Some(id) = self.membership_derive_at(node)
                    && self.derive_reads_membership(id)
                    && reported.insert(NodeKey::of(node))
                {
                    let span = tight_span(self.text(node.span.file), node);
                    let canonical = &self.tables.symbols[id.0 as usize].canonical;
                    self.diags.push(Diagnostic::error("E3010", format!("pure value cannot call membership-reading derived function '{canonical}'"), span));
                }
                pending.extend(kids(node).into_iter().rev());
            }
        }
    }

    /// Retention is row-only even when a contextual expression is extracted
    /// into a helper. Follow resolved bodies and only defaults actually omitted
    /// at each selected call; same-spelled parameters/fields are not context.
    fn check_retention_context_closures(&mut self) {
        for root in std::mem::take(&mut self.retention_roots) {
            let mut pending = vec![&root];
            let mut visited = HashSet::new();
            let mut banned = HashSet::new();
            while let Some(node) = pending.pop() {
                if !visited.insert(NodeKey::of(node)) {
                    continue;
                }
                match self.tables.node_binding.get(&NodeKey::of(node)) {
                    Some(Binding::Context(ContextVar::Actor(_))) => {
                        banned.insert("actor");
                    }
                    Some(Binding::Context(ContextVar::Now)) => {
                        banned.insert("now");
                    }
                    Some(Binding::Context(ContextVar::Operation)) => {
                        banned.insert("operation");
                    }
                    _ => {}
                }
                if let Some(id) = self.membership_derive_at(node) {
                    if let Some(body) = self.membership_derive_bodies.get(&id) {
                        pending.push(body);
                    }
                    if let Some(selected) = self.types.selected_calls.get(&NodeKey::of(node))
                        && let SymbolKind::DeriveFn { params, .. } =
                            &self.tables.symbols[id.0 as usize].kind
                    {
                        for (param, slot) in params.iter().zip(&selected.slots) {
                            if slot.is_none()
                                && let Some(default) = self.parameter_defaults.get(param)
                            {
                                pending.push(default);
                            }
                        }
                    }
                }
                pending.extend(kids(node).into_iter().rev());
            }
            let span = tight_span(self.text(root.span.file), &root);
            for name in ["actor", "now", "operation"] {
                if banned.contains(name) {
                    self.diags.push(Diagnostic::error(
                        "E3017",
                        format!("retain until= cannot use {name}"),
                        span,
                    ));
                }
            }
        }
    }

    /// Both calls and computed-field access retain their transitive read effect.
    /// Admitting a contextual bool field must not smuggle membership into a
    /// default or other strict pure consumer through a member read.
    fn membership_derive_at(&self, node: &SyntaxNode) -> Option<SymbolId> {
        if let Some(SelectedCall {
            target: SelectedCallTarget::DeriveFn(id),
            ..
        }) = self.types.selected_calls.get(&NodeKey::of(node))
        {
            return Some(*id);
        }
        if node.kind != SyntaxKind::Member {
            return None;
        }
        let parts = kids(node);
        let receiver = parts.first()?;
        let mut ty = self.types.node_types.get(&NodeKey::of(receiver))?;
        if let ResolvedType::Nullable(inner) = ty {
            ty = inner;
        }
        let ResolvedType::Record {
            symbol,
            stored: true,
        } = ty
        else {
            return None;
        };
        let name = name_text(parts.last()?, self.text(node.span.file))?;
        let field = self.record_field_named(*symbol, name)?;
        matches!(
            self.tables.symbols[field.0 as usize].kind,
            SymbolKind::DeriveField { .. }
        )
        .then_some(field)
    }

    fn derive_reads_membership(&self, id: SymbolId) -> bool {
        let mut functions = vec![id];
        let mut visited = HashSet::new();
        while let Some(id) = functions.pop() {
            if !visited.insert(id) {
                continue;
            }
            let Some(body) = self.membership_derive_bodies.get(&id) else {
                continue;
            };
            let mut pending = vec![body];
            while let Some(node) = pending.pop() {
                if self.checked_membership_call(node) {
                    return true;
                }
                if let Some(callee) = self.membership_derive_at(node) {
                    functions.push(callee);
                }
                pending.extend(kids(node).into_iter().rev());
            }
        }
        false
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

    fn check_dispatch_when(&mut self, cx: &Ctx<'_, '_>, when: &SyntaxNode) {
        for (name, span) in self.bounded_membership_effectful_calls(when, cx.text) {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("when= must be a bounded dispatch guard; '{name}' is not allowed here"),
                span,
            ));
        }
    }

    // --- Phase 2: context, roles, derives, messages ----------------------

    /// Check one `queue` context declaration: duplicate names are
    /// `E2002` and a `type=` payload is recorded for scheduling.
    fn context_queue_decl(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        decl: &SyntaxNode,
        decl_name: &str,
    ) {
        if !decl_name.is_empty() && !self.queue_names.insert((module, decl_name.to_string())) {
            self.diags.push(Diagnostic::error(
                "E2002",
                format!("duplicate queue '{decl_name}'"),
                tight_span(text, decl),
            ));
        }
        if let Some(ty) = attribute_value(decl, "type", text) {
            let payload = self.resolve_type_node(file, text, module, ty, None);
            self.types.runtime_bindings.entry(module).or_default().push(
                CheckedRuntimeBinding::Queue {
                    name: decl_name.to_string(),
                    payload,
                },
            );
        }
    }

    /// Check one `binding` context declaration: a `key=` naming a root
    /// model binds a durable object, anything else is `E3001`.
    fn context_binding_decl(
        &mut self,
        text: &str,
        module: ModuleId,
        decl: &SyntaxNode,
        decl_name: &str,
    ) {
        if let Some(key) = attribute_value(decl, "key", text)
            .and_then(|key| self.tables.node_symbol.get(&NodeKey::of(key)))
            .copied()
        {
            if matches!(
                self.tables.symbols[key.0 as usize].kind,
                SymbolKind::Model {
                    owner: ModelOwner::Team | ModelOwner::App,
                    ..
                }
            ) {
                self.types.runtime_bindings.entry(module).or_default().push(
                    CheckedRuntimeBinding::DurableObject {
                        name: decl_name.to_string(),
                        key,
                    },
                );
            } else {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "DurableObject key must name a root model".into(),
                    tight_span(text, decl),
                ));
            }
        }
    }

    /// Check one `cache` context declaration: `ttl=` must be a positive
    /// static duration literal.
    fn context_cache_decl(
        &mut self,
        cx: &Ctx<'_, '_>,
        module: ModuleId,
        decl: &SyntaxNode,
        text: &str,
    ) {
        if let Some(ttl) = attribute_value(decl, "ttl", text) {
            let ty = self.expr(cx, ttl, None);
            match &ty {
                ResolvedType::Scalar(Scalar::Duration) => {
                    self.context_cache_ttl(module, text, ttl);
                }
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {}
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

    /// Check a duration-typed `cache ttl=`: static, positive literals bind.
    fn context_cache_ttl(&mut self, module: ModuleId, text: &str, ttl: &SyntaxNode) {
        if let Some(ttl_milliseconds) = duration_value(ttl, text).filter(|ms| *ms > 0) {
            self.types
                .runtime_bindings
                .entry(module)
                .or_default()
                .push(CheckedRuntimeBinding::Cache { ttl_milliseconds });
        }
        if duration_value(ttl, text).is_none() {
            self.diags.push(Diagnostic::error(
                "E6008",
                "cache ttl requires a static duration literal in the current runtime profile"
                    .into(),
                tight_span(text, ttl),
            ));
        }
        if duration_value(ttl, text).is_some_and(|ms| ms <= 0) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "cache ttl must be a positive duration".to_string(),
                tight_span(text, ttl),
            ));
        }
    }

    /// Check one `files` context declaration: `max=` must be a positive
    /// byte quantity. (`types=` format is unspecified: no value check.)
    fn context_files_decl(&mut self, cx: &Ctx<'_, '_>, decl: &SyntaxNode, text: &str) {
        if let Some(max) = attribute_value(decl, "max", text) {
            let ty = self.expr(cx, max, None);
            match &ty {
                ResolvedType::Scalar(Scalar::Bytes) => {
                    if bytes_value(max, text).is_some_and(|n| n <= 0) {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            "files max must be a positive byte quantity".to_string(),
                            tight_span(text, max),
                        ));
                    }
                }
                ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {}
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

    /// Check one `theme` context declaration: closed value sets per key,
    /// at least one key present.
    fn context_theme_decl(&mut self, decl: &SyntaxNode, text: &str) {
        let mut present = false;
        for (key, allowed) in [
            ("mode", &["system", "light", "dark"][..]),
            ("accent", &["blue", "green", "purple"][..]),
            ("density", &["comfortable", "compact"][..]),
        ] {
            if let Some(value) = attribute_value(decl, key, text) {
                present = true;
                let word = name_or_ref_word(value, text).unwrap_or("");
                if !allowed.contains(&word) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("theme {key} must be one of {}", allowed.join(", ")),
                        tight_span(text, value),
                    ));
                }
            }
        }
        if !present {
            self.diags.push(Diagnostic::error(
                "E3001",
                "theme needs at least one of mode=, accent= or density=".to_string(),
                tight_span(text, decl),
            ));
        }
    }

    /// Check one `analytics` context declaration: resolve each field type
    /// and record the event binding.
    fn context_analytics_decl(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        cx: &Ctx<'_, '_>,
        decl: &SyntaxNode,
        decl_name: &str,
    ) {
        let mut fields = Vec::new();
        for field in kids(decl) {
            if field.kind != SyntaxKind::Field || has_error(field) {
                continue;
            }
            let ty = kids(field)
                .iter()
                .find(|n| is_type_node(n.kind))
                .map(|t| self.resolve_type_node(file, text, module, t, None))
                .unwrap_or(ResolvedType::Error);
            if let Some(name) = kids(field).into_iter().find_map(|n| name_text(n, text)) {
                fields.push((name.to_string(), ty.clone()));
            }
            if let Some(label) = attribute_value(field, "label", text) {
                let name = kids(field)
                    .iter()
                    .find_map(|n| name_text(n, text))
                    .unwrap_or("field");
                self.check_field_label(cx, field, name, &ty, label);
            }
        }
        self.types.runtime_bindings.entry(module).or_default().push(
            CheckedRuntimeBinding::Analytics {
                name: decl_name.to_string(),
                fields,
            },
        );
    }

    /// Check one `locale` context declaration: the default must be a
    /// well-formed BCP 47 tag.
    fn context_locale_decl(&mut self, decl: &SyntaxNode, text: &str) {
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

    /// Check declaration bookkeeping for one context row: runtime
    /// resource conflicts and duplicate declarations are `E2002`.
    /// Returns false when the declaration is a duplicate to skip.
    fn check_context_decl_bookkeeping(
        &mut self,
        text: &str,
        module: ModuleId,
        decl: &SyntaxNode,
        head: &str,
        decl_name: &str,
        seen: &mut HashSet<(String, String)>,
        resource_names: &mut HashSet<String>,
    ) -> bool {
        if matches!(head, "queue" | "binding" | "analytics" | "cache") {
            let resource_name = if head == "cache" { "KV" } else { decl_name };
            if !resource_names.insert(resource_name.to_string())
                || self.tables.module_scopes[module.0 as usize]
                    .prod
                    .contains_key(resource_name)
            {
                self.diags.push(Diagnostic::error("E2002", format!("runtime binding '{resource_name}' conflicts with another declaration or import"), tight_span(text, decl)));
            }
        }
        if !matches!(head, "" | "queue") && !seen.insert((head.to_string(), decl_name.to_string()))
        {
            self.diags.push(Diagnostic::error(
                "E2002",
                format!("duplicate context declaration '{head}'"),
                tight_span(text, decl),
            ));
            return false;
        }
        true
    }

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
        let mut resource_names = HashSet::new();
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
                if !self.check_context_decl_bookkeeping(
                    text,
                    module,
                    decl,
                    head,
                    decl_name,
                    &mut seen,
                    &mut resource_names,
                ) {
                    continue;
                }
                match head {
                    "queue" => self.context_queue_decl(file, text, module, decl, decl_name),
                    "binding" => self.context_binding_decl(text, module, decl, decl_name),
                    "cache" => self.context_cache_decl(&cx, module, decl, text),
                    "files" => self.context_files_decl(&cx, decl, text),
                    "theme" => self.context_theme_decl(decl, text),
                    "locale" => self.context_locale_decl(decl, text),
                    "analytics" => {
                        self.context_analytics_decl(file, text, module, &cx, decl, decl_name);
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
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let actual = self.expr(&cx, value, Some(expected.clone()));
        // Contextual State reads keep their consuming authority through
        // helpers whatever the derived result type is: a Boolean result
        // never defines permission to read (DESIGN §3). Derived fields of
        // every type admit the same checked bounded membership reads as
        // derived functions, with identical order/failure rules; bodies
        // stay registered for transitive strict-site closure.
        let membership_function = matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::DeriveFn { .. }
        ) || matches!(
            self.tables.symbols[id.0 as usize].kind,
            SymbolKind::DeriveField { .. }
        );
        let forbidden_calls = if membership_function {
            self.membership_derive_bodies.insert(id, value.clone());
            self.bounded_membership_effectful_calls(value, text)
        } else {
            self.effectful_calls(value, text)
        };
        for (name, span) in forbidden_calls {
            self.diags.push(Diagnostic::error(
                "E3010", format!("{what} value must be pure or a checked bounded membership read; '{name}' is not allowed here"), span,
            ));
        }
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

    fn collect_judgment_messages(&mut self, trees: &[(SourceId, SyntaxNode)]) {
        for (file, tree) in trees {
            let text = self.text(*file).to_string();
            for module_node in kids(tree)
                .into_iter()
                .filter(|n| matches!(n.kind, SyntaxKind::App | SyntaxKind::Package))
            {
                let Some(module) = module_of_node(self.tables, &text, module_node) else {
                    continue;
                };
                for section in kids(module_node)
                    .into_iter()
                    .filter(|n| n.kind == SyntaxKind::Section)
                {
                    for message in kids(section)
                        .into_iter()
                        .filter(|n| n.kind == SyntaxKind::Message)
                    {
                        if let Some(id) =
                            self.decl_symbol(module, &text, message, &["export", "message"])
                        {
                            self.judgment_messages.insert(id, message.clone());
                        }
                    }
                }
            }
        }
    }

    /// Count the actual static source string, following only resolved
    /// zero-input message declarations. No executable expression is admitted.
    fn judgment_caption_scalars(
        &mut self,
        cx: &Ctx<'_, '_>,
        caption: &SyntaxNode,
    ) -> Option<usize> {
        if caption.kind != SyntaxKind::MessageValue {
            self.check_caption(cx, caption, "judgment caption", None);
        }
        let value = match caption.kind {
            SyntaxKind::Literal => string_literal_value(caption),
            SyntaxKind::MessageValue => {
                self.check_message_value(cx, caption, "judgment caption", Some(&[]));
                kids(caption).into_iter().find_map(string_literal_value)
            }
            SyntaxKind::Path => {
                let id = self
                    .tables
                    .node_symbol
                    .get(&NodeKey::of(caption))
                    .copied()?;
                if !matches!(&self.tables.symbols[id.0 as usize].kind, SymbolKind::Message { params } if params.is_empty())
                {
                    return None;
                }
                let message = self.judgment_messages.get(&id)?.clone();
                let descriptor = kids(&message)
                    .into_iter()
                    .find(|n| n.kind == SyntaxKind::MessageValue)?;
                let message_module = self.tables.symbols[id.0 as usize].module;
                let message_text = self.text(message.span.file).to_string();
                let message_cx =
                    Self::body_cx(message_module, message.span.file, &message_text, cx.narrow);
                self.check_message_value(&message_cx, descriptor, "judgment message", Some(&[]));
                kids(descriptor).into_iter().find_map(string_literal_value)
            }
            _ => None,
        };
        let Some(value) = value else {
            self.diags.push(Diagnostic::error(
                "E3016",
                "judgment captions must be verified static text or zero-parameter messages"
                    .to_string(),
                tight_span(cx.text, caption),
            ));
            return None;
        };
        let count = value.chars().count();
        if value.trim().is_empty() || count > 2_000 {
            self.diags.push(Diagnostic::error(
                "E3001",
                "judgment instruction/criterion must contain 1–2000 Unicode scalars".to_string(),
                tight_span(cx.text, caption),
            ));
        }
        Some(count)
    }

    fn phase2_judgment(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let Some(owner) = self.decl_symbol(module, text, node, &["export", "judgment"]) else {
            return;
        };
        let Some(mut judgment) = self.tables.judgment_declarations.get(&owner).cloned() else {
            return;
        };
        let before = self.diags.len();
        match attribute_value(node, "version", text).and_then(|n| {
            (n.kind == SyntaxKind::Literal)
                .then(|| int_literal_value(n, text))
                .flatten()
        }) {
            Some(version) => judgment.version = version,
            None => self.diags.push(Diagnostic::error(
                "E3001",
                "judgment version must be an int literal".to_string(),
                node.span,
            )),
        }
        if !(1..=32).contains(&judgment.questions.len()) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "judgment requires 1–32 questions".to_string(),
                node.span,
            ));
        }
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        let mut combined = 0;
        let mut question_names = HashSet::new();
        let mut complete = true;
        for item in kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::JudgmentItem)
        {
            self.phase2_judgment_item(
                &cx,
                &judgment,
                item,
                text,
                &mut question_names,
                &mut complete,
                &mut combined,
            );
        }
        if combined > 24_000 {
            self.diags.push(Diagnostic::error(
                "E3001",
                "judgment specification exceeds 24000 combined source-language Unicode scalars"
                    .to_string(),
                node.span,
            ));
        }
        if complete && before == self.diags.len() {
            self.types.judgments.insert(owner, judgment);
        }
    }

    fn phase2_judgment_item(
        &mut self,
        cx: &Ctx<'_, '_>,
        judgment: &CheckedJudgment,
        item: &SyntaxNode,
        text: &str,
        question_names: &mut HashSet<String>,
        complete: &mut bool,
        combined: &mut usize,
    ) {
        let parts = kids(item);
        let Some(name) = parts.iter().find_map(|n| name_text(n, text)) else {
            return;
        };
        if !question_names.insert(name.to_string()) {
            *complete = false; // The owning resolver already reported E2002.
        }
        let Some(question) = judgment.questions.iter().find(|q| q.name == name) else {
            *complete = false;
            return;
        };
        let count = if question.kind == CheckedJudgmentKind::Choice {
            question.options.len()
        } else {
            question.levels.len()
        };
        let allowed = match question.kind {
            CheckedJudgmentKind::Noul => true,
            CheckedJudgmentKind::Choice if question.runtime => count <= 26,
            CheckedJudgmentKind::Choice => (2..=26).contains(&count),
            CheckedJudgmentKind::Score => (2..=10).contains(&count),
        };
        if !allowed {
            self.diags.push(Diagnostic::error("E3001", "static judgment choices require 2–26 options; runtime choices permit at most 26 authored options; scores require 2–10 ordered levels".to_string(), item.span));
        }
        let mut ids = HashSet::new();
        for option in question.options.iter().chain(question.levels.iter()) {
            if question.runtime && !(1..=80).contains(&option.id.chars().count()) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "runtime judgment option IDs require 1–80 Unicode scalars matching NAME"
                        .to_string(),
                    item.span,
                ));
            }
            if !ids.insert(&option.id) {
                self.diags.push(Diagnostic::error(
                    "E2002",
                    format!("duplicate judgment option/level '{}'", option.id),
                    item.span,
                ));
            }
        }
        for caption in parts.iter().copied().filter(|n| {
            matches!(
                n.kind,
                SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
            )
        }) {
            *combined += self.judgment_caption_scalars(cx, caption).unwrap_or(0);
        }
        for option in parts
            .iter()
            .filter(|n| n.kind == SyntaxKind::JudgmentOption)
        {
            for caption in kids(option).into_iter().filter(|n| {
                matches!(
                    n.kind,
                    SyntaxKind::Literal | SyntaxKind::MessageValue | SyntaxKind::Path
                )
            }) {
                *combined += self.judgment_caption_scalars(cx, caption).unwrap_or(0);
            }
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
            // R26 layer 1 (T37 pilot): a CRUD `when=` is an authorization
            // guard running for admitted callers, like a send `when=`
            // (not a pure value). Bounded purity admits membership reads
            // (the ledger's promised "admitted-actor use passes in
            // composite policies and CRUD `when=`"); impure builtins
            // still reject, derive bodies stay pure-gated, and commit-time
            // revalidation (T32) backstops freshness. Policy `where=`
            // already admits these calls; this aligns the two guards.
            self.check_dispatch_when(&when_cx, when);
        }
        for key in ["create", "update"] {
            if let Some(mode) = attribute_value(node, key, text) {
                let word = name_or_ref_word(mode, text).unwrap_or("");
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
            match name_or_ref_word(mode, text).unwrap_or("") {
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

    /// Check declaration-owned UI before publishing any same-module uses.
    fn phase2_view(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        if has_error(node) || node.descendants().any(|n| n.kind == SyntaxKind::Show) {
            return;
        }
        let key = NodeKey::of(node);
        let Some(model) = self.tables.view_models.get(&key).copied() else {
            return;
        };
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        self.check_action_panel_targets(&cx, node);
        let before = self.diags.len();
        for child in kids(node) {
            if matches!(
                child.kind,
                SyntaxKind::Name | SyntaxKind::Punct | SyntaxKind::Parameter
            ) {
                continue;
            }
            self.walk_ui_page(&cx, child, SyntaxKind::View);
        }
        if self.diags.len() == before {
            self.types.view_models.insert(key, model);
        }
    }

    /// Check a page (GRAMMAR `page` row): required static `title=`,
    /// pure-read `data=`, constant `order=`/`poll=`, static `group=`,
    /// `nav=none`, and `refresh=` naming a canonical user mutation
    /// with `poll=` present; then the widget suite.
    /// Index page route records to their declared models for route IR.
    fn index_page_route_records(&mut self, node: &SyntaxNode) {
        for route in kids(node)
            .into_iter()
            .filter(|part| part.kind == SyntaxKind::Route)
        {
            for record in kids(route)
                .into_iter()
                .filter(|part| part.kind == SyntaxKind::RouteRecord)
            {
                let model = kids(record)
                    .into_iter()
                    .find(|part| part.kind == SyntaxKind::Path)
                    .and_then(|path| self.tables.node_symbol.get(&NodeKey::of(path)).copied());
                if let Some(model) = model
                    && matches!(
                        self.tables.symbols[model.0 as usize].kind,
                        SymbolKind::Model { .. }
                    )
                {
                    self.types.node_types.insert(
                        NodeKey::of(record),
                        ResolvedType::Record {
                            symbol: model,
                            stored: true,
                        },
                    );
                }
            }
        }
    }

    /// Register top-level page admission guards for team-authority reads.
    fn register_page_guards(&mut self, node: &SyntaxNode, text: &str) {
        for child in kids(node) {
            if (child.kind == SyntaxKind::Require
                || child.kind == SyntaxKind::UiLeaf
                    && kids(child).iter().find_map(|part| name_text(part, text)) == Some("require"))
                && let Some(pred) = kids(child)
                    .into_iter()
                    .find(|part| is_expression(part.kind))
            {
                self.membership_page_guards.insert(NodeKey::of(pred));
            }
        }
    }

    /// Check one `data=` page attribute: a pure read call.
    fn check_page_data(&mut self, cx: &Ctx<'_, '_>, text: &str, data: &SyntaxNode) {
        if data.kind != SyntaxKind::Call {
            self.diags.push(Diagnostic::error(
                "E3001",
                "page data must be a read call".to_string(),
                tight_span(text, data),
            ));
            return;
        }
        let ty = self.expr(cx, data, None);
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

    /// Check the `poll=`/`refresh=` page attributes: whole-second
    /// durations in range and a same-page mutation with repeatable inputs.
    fn check_page_poll_refresh(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, text: &str) {
        let poll = attribute_value(node, "poll", text);
        if let Some(poll) = poll {
            let _ = self.expr(cx, poll, None);
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
            let Some(target) = self.tables.node_symbol.get(&NodeKey::of(refresh)).copied() else {
                if refresh.kind != SyntaxKind::Path {
                    self.diags.push(Diagnostic::error(
                        "E3009",
                        "page refresh must name a canonical user mutation".to_string(),
                        tight_span(text, refresh),
                    ));
                }
                return;
            };
            let valid_target = matches!(
                self.tables.symbols[target.0 as usize].kind,
                SymbolKind::Scenario { trusted: false, .. }
            ) && !self.read_scenarios.contains(&target)
                && !self.unpublished_scenarios.contains(&target)
                && !self.tables.judgment_generated_symbols.contains(&target);
            if !valid_target {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    "page refresh must name an enabled canonical user mutation without generated business inputs".to_string(),
                    tight_span(text, refresh),
                ));
                return;
            }
            if let SymbolKind::Scenario { params, .. } =
                &self.tables.symbols[target.0 as usize].kind
            {
                for param in params {
                    let ty = self.decl_type(*param);
                    if self.field_has_server(*param) || !self.refresh_input_type(&ty) {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            format!("page refresh parameter '{}' must contain only repeatable non-secret values; records, file, secret and engine-resolved inputs are not allowed",
                                self.tables.symbols[param.0 as usize].name),
                            tight_span(text, refresh),
                        ));
                    }
                    if let Some(default) = self.refresh_defaults.get(param)
                        && !self.refresh_static_default(default, *param, &ty)
                    {
                        self.diags.push(Diagnostic::error(
                            "E3009",
                            format!("page refresh parameter '{}' needs a static default or an earlier parameter copy; contextual or generated defaults cannot be repeated",
                                self.tables.symbols[param.0 as usize].name),
                            tight_span(text, refresh),
                        ));
                    }
                }
            }
            let mut pending = vec![node];
            let mut presented = false;
            while let Some(candidate) = pending.pop() {
                if candidate.kind == SyntaxKind::Form {
                    let domain = attribute_value(candidate, "action", text)
                        .or_else(|| kids(candidate).into_iter().find(|n| is_expression(n.kind)));
                    presented |= domain.is_some_and(|domain| {
                        self.tables.node_symbol.get(&NodeKey::of(domain)) == Some(&target)
                            || matches!(self.tables.node_binding.get(&NodeKey::of(domain)),
                                Some(Binding::Symbol(id)) if *id == target)
                    });
                }
                pending.extend(kids(candidate));
            }
            if !presented {
                self.diags.push(Diagnostic::error(
                    "E3009",
                    "page refresh mutation must be presented by a form on the same page"
                        .to_string(),
                    tight_span(text, refresh),
                ));
            }
        }
    }

    /// Follow checked input shapes rather than nominal spellings. Contracts may
    /// carry ordinary values, but cannot hide records or non-repeatable inputs.
    fn refresh_input_type(&self, ty: &ResolvedType) -> bool {
        let mut pending = vec![ty.clone()];
        let mut seen = HashSet::new();
        let mut steps = 0usize;
        while let Some(ty) = pending.pop() {
            steps += 1;
            if steps > 4096 {
                return false;
            }
            match ty {
                ResolvedType::Scalar(Scalar::File | Scalar::Secret) => return false,
                ResolvedType::Scalar(_) | ResolvedType::Null | ResolvedType::Enum { .. } => {}
                ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } => {
                    pending.push(*inner)
                }
                ResolvedType::Record { symbol, .. } => {
                    let SymbolKind::Contract { fields } =
                        &self.tables.symbols[symbol.0 as usize].kind
                    else {
                        return false;
                    };
                    if seen.insert(symbol) {
                        for field in fields {
                            let ty = self.decl_type(*field);
                            if self.field_has_server(*field)
                                || self.refresh_defaults.get(field).is_some_and(|default| {
                                    !self.refresh_static_default(default, *field, &ty)
                                })
                            {
                                return false;
                            }
                            pending.push(ty);
                        }
                    }
                }
                ResolvedType::Union(arms) => {
                    pending.extend(arms.into_iter().map(|symbol| ResolvedType::Record {
                        symbol,
                        stored: false,
                    }));
                }
                ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => {
                    pending.extend(fields.into_iter().map(|(_, ty)| ty))
                }
                _ => return false,
            }
        }
        true
    }

    /// Only defaults whose repeat stability is proven locally are admitted.
    /// Calls and contextual names require fresh business input and fail closed.
    fn refresh_static_default(
        &self,
        node: &SyntaxNode,
        param: SymbolId,
        expected: &ResolvedType,
    ) -> bool {
        let text = self.text(node.span.file);
        let mut pending = vec![node];
        while let Some(node) = pending.pop() {
            match node.kind {
                SyntaxKind::Literal => {}
                SyntaxKind::NameRef => {
                    let copy = matches!(self.tables.node_binding.get(&NodeKey::of(node)), Some(Binding::Symbol(seed))
                        if matches!((&self.tables.symbols[param.0 as usize].kind, &self.tables.symbols[seed.0 as usize].kind),
                            (SymbolKind::Param { owner, index, .. }, SymbolKind::Param { owner: seed_owner, index: seed_index, .. }) if owner == seed_owner && seed_index < index));
                    let enum_case = !self.tables.node_binding.contains_key(&NodeKey::of(node))
                        && matches!(expected, ResolvedType::Enum { cases, .. }
                            if name_or_ref_word(node, text).is_some_and(|name| cases.iter().any(|case| case == name)));
                    if !copy && !enum_case {
                        return false;
                    }
                }
                SyntaxKind::Group
                | SyntaxKind::Unary
                | SyntaxKind::Binary
                | SyntaxKind::Array
                | SyntaxKind::Object
                | SyntaxKind::ObjectEntry => {
                    pending.extend(kids(node).into_iter().filter(|child| {
                        is_expression(child.kind) || child.kind == SyntaxKind::ObjectEntry
                    }));
                }
                _ => return false,
            }
        }
        true
    }

    fn phase2_page(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let narrow = NarrowEnv::default();
        let cx = Self::body_cx(module, file, text, &narrow);
        self.check_action_panel_targets(&cx, node);
        // Preserve the resolver's exact declaration association for route IR.
        // The authored token is syntax; its Model identity is never inferred
        // from the URL spelling during code generation.
        self.index_page_route_records(node);
        // Top-level page admission guards read with the viewer's team
        // authority wherever the owning context supplies the required
        // facts: an incidental route record never defines permission to
        // read (DESIGN §3). Pure guards behave identically under either
        // purity check, so every top-level guard is registered; nested
        // container gates keep their strict pure contract until their
        // render-gate inventory can carry the same owning sources.
        self.register_page_guards(node, text);
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
            self.check_page_data(&cx, text, data);
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
            && name_or_ref_word(nav, text) != Some("none")
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "page nav supports only none".to_string(),
                tight_span(text, nav),
            ));
        }
        self.check_page_poll_refresh(&cx, node, text);
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
    /// value or a resolved reference to a zero-parameter message (`E3013`).
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
        if matches!(node.kind, SyntaxKind::Path | SyntaxKind::NameRef) {
            let key = NodeKey::of(node);
            let symbol = self.tables.node_symbol.get(&key).copied().or_else(|| {
                match self.tables.node_binding.get(&key) {
                    Some(Binding::Symbol(id)) => Some(*id),
                    _ => None,
                }
            });
            let ok = symbol.is_some_and(|id| {
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

    /// The existing bare-model scan/table profile has one direct readonly text
    /// suite, static empty text and three declared scalar columns. This is an
    /// inventory of complete construct recipes, never keyword substitution.
    fn office_collection_source_profile(
        &self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
    ) -> bool {
        let SymbolKind::Model { fields, .. } = &self.tables.symbols[model.0 as usize].kind else {
            return false;
        };
        if fields.len() != 3 {
            return false;
        }
        let declared = fields
            .iter()
            .map(|field| self.decl_type(*field))
            .collect::<Vec<_>>();
        if declared != [ResolvedType::Scalar(Scalar::Text), ResolvedType::Nullable(Box::new(ResolvedType::Scalar(Scalar::Int))), ResolvedType::Scalar(Scalar::Bool)]
            || fields.iter().any(|field| !matches!(self.tables.symbols[field.0 as usize].kind, SymbolKind::Field { owner, .. } if owner == model))
        { return false; }
        // Only authored fields count: created/updated metadata is not a declared
        // agenda endpoint. This finite model has no enum or image/file selector.
        let domains = kids(node)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect::<Vec<_>>();
        let [domain] = domains.as_slice() else {
            return false;
        };
        if domain.kind != SyntaxKind::NameRef
            || !matches!(self.tables.node_binding.get(&NodeKey::of(domain)), Some(Binding::Symbol(id)) if *id == model)
        {
            return false;
        }
        let attributes = kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::Attribute)
            .collect::<Vec<_>>();
        let [empty] = attributes.as_slice() else {
            return false;
        };
        let Some((name, value)) = attribute_parts(empty) else {
            return false;
        };
        if name_text(name, cx.text) != Some("empty") || string_literal_value(value).is_none() {
            return false;
        }
        let suites = kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::UiLeaf)
            .collect::<Vec<_>>();
        let [suite] = suites.as_slice() else {
            return false;
        };
        if kids(suite)
            .into_iter()
            .find_map(|child| name_text(child, cx.text))
            != Some("text")
        {
            return false;
        }
        let values = kids(suite)
            .into_iter()
            .filter(|child| is_expression(child.kind))
            .collect::<Vec<_>>();
        if values.len() != fields.len() {
            return false;
        }
        let mut selected = HashSet::new();
        for value in values {
            if value.kind != SyntaxKind::Member {
                return false;
            }
            let parts = kids(value);
            let [receiver, punct, name] = parts.as_slice() else {
                return false;
            };
            if !is_punct(punct, cx.text, ".")
                || name_or_ref_word(receiver, cx.text) != Some("row")
                || !matches!(self.tables.node_binding.get(&NodeKey::of(receiver)), Some(Binding::Context(ContextVar::RowModel(id))) if *id == model)
            {
                return false;
            }
            let Some(field) =
                name_text(name, cx.text).and_then(|name| self.model_field_named(model, name))
            else {
                return false;
            };
            if !fields.contains(&field)
                || !selected.insert(field)
                || self.types.node_types.get(&NodeKey::of(value)) != Some(&self.decl_type(field))
            {
                return false;
            }
        }
        selected.len() == fields.len()
    }

    /// Account for every collection in the actual owning UI registry and any
    /// selected component catalog. Unknown additions or changed shapes abstain.
    fn office_collection_catalog_complete(&self) -> bool {
        let Some(catalog) = self.catalog else {
            return false;
        };
        let source = include_str!("../../../packages/ui/src/catalog.ts");
        let Some((_, declarations)) =
            source.split_once("const ENTRIES: ReadonlyArray<ComponentCatalogEntry> = [\n")
        else {
            return false;
        };
        let Some((declarations, _)) = declarations.split_once("\n];") else {
            return false;
        };
        let mut collections = HashSet::new();
        let mut words = HashSet::new();
        for line in declarations
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Some((id, shape)) = Self::parse_catalog_line(line, &mut words) else {
                return false;
            };
            if Self::catalog_quoted(shape, "profile").as_deref() == Some("collection") {
                if !Self::verify_collection_line(shape, &id, &mut collections) {
                    return false;
                }
            } else if shape.contains("alternates: ") && shape.contains("\"collection\"") {
                return false;
            }
        }
        if collections.len() != 10 {
            return false;
        }
        for id in catalog.ids() {
            if !Self::verify_catalog_entry(catalog, id, &collections) {
                return false;
            }
        }
        // List/table use the current native readonly renderRow profile. Board
        // lacks a declared enum grouping; calendar lacks declared nonnullable
        // endpoints. Legacy grammar gallery has no image/file selector or native
        // factory. The five sequence collections require item slots and have no
        // current native factories; hover_gallery also needs image values.
        true
    }

    /// Read one `key: "value"` out of a catalog source line.
    fn catalog_quoted(line: &str, key: &str) -> Option<String> {
        let (_, value) = line.split_once(&format!("{key}: \""))?;
        Some(value.split_once('"')?.0.to_string())
    }

    /// The expected compiler shape of one collection component id.
    fn expected_collection_shape(id: &str) -> Option<(&str, &str, &[&str], bool)> {
        match id {
            "list" => Some((
                "list",
                "query",
                &[
                    "columns", "order", "search", "filter", "empty", "defaults", "display",
                ],
                false,
            )),
            "table" => Some((
                "table",
                "query",
                &[
                    "columns", "order", "search", "filter", "empty", "defaults", "display",
                ],
                false,
            )),
            "gallery" => Some((
                "gallery",
                "query",
                &["image", "order", "search", "filter", "empty", "defaults"],
                false,
            )),
            "board" => Some((
                "board",
                "query",
                &[
                    "by", "columns", "order", "search", "filter", "empty", "defaults",
                ],
                false,
            )),
            "calendar" => Some((
                "calendar",
                "query",
                &[
                    "start", "end", "columns", "order", "search", "filter", "empty", "defaults",
                ],
                false,
            )),
            "timeline" => Some(("timeline", "sequence", &[], true)),
            "carousel" => Some(("carousel", "sequence", &[], true)),
            "hover_gallery" => Some(("hoverGallery", "sequence", &[], true)),
            "steps" => Some(("steps", "sequence", &[], true)),
            "text_rotate" => Some(("textRotate", "sequence", &[], true)),
            _ => None,
        }
    }

    /// Parse one catalog source line to its id and notes-stripped shape:
    /// well-formed component entries with fresh ids only.
    fn parse_catalog_line<'n>(
        line: &'n str,
        words: &mut HashSet<String>,
    ) -> Option<(String, &'n str)> {
        if !line.starts_with("{ id: \"") || !line.ends_with(" },") {
            return None;
        }
        let id = Self::catalog_quoted(line, "id")?;
        if !words.insert(id.clone()) {
            return None;
        }
        let shape = line
            .split_once(", notes: ")
            .map_or(line, |(shape, _)| shape);
        if Self::catalog_quoted(shape, "kind").as_deref() != Some("component") {
            return None;
        }
        Some((id, shape))
    }

    /// Verify one collection catalog line against its expected shape and
    /// record its id.
    fn verify_collection_line(shape: &str, id: &str, collections: &mut HashSet<String>) -> bool {
        let Some((js, header, attributes, item_slot)) = Self::expected_collection_shape(id) else {
            return false;
        };
        if Self::catalog_quoted(shape, "owner").as_deref() != Some("lane-05")
            || Self::catalog_quoted(shape, "js").as_deref() != Some(js)
            || Self::catalog_quoted(shape, "availability").as_deref() != Some("implemented")
            || Self::catalog_quoted(shape, "header").as_deref() != Some(header)
            || shape.contains("alternates: ")
        {
            return false;
        }
        let actual_attributes = if let Some((_, values)) = shape.split_once("attributes: [") {
            let Some((values, _)) = values.split_once(']') else {
                return false;
            };
            let Some(values) = values
                .split(", ")
                .map(|value| value.strip_prefix('"')?.strip_suffix('"'))
                .collect::<Option<Vec<_>>>()
            else {
                return false;
            };
            values
        } else {
            Vec::new()
        };
        if actual_attributes != attributes
            || item_slot
                != shape.contains("slots: [{ name: \"item\", required: true, repeatable: true }]")
            || !item_slot && shape.contains("slots: ")
        {
            return false;
        }
        collections.insert(id.to_string());
        true
    }

    /// Verify one compiler-catalog entry against the expected collection
    /// shape: non-collections stay out, collections match exactly.
    fn verify_catalog_entry(catalog: &Catalog, id: &str, collections: &HashSet<String>) -> bool {
        let Some(entry) = catalog.lookup(id) else {
            return false;
        };
        let collection = entry.component.as_ref().is_some_and(|shape| {
            shape.profile == "collection"
                || shape
                    .alternates
                    .iter()
                    .any(|profile| profile == "collection")
        });
        if !collection && !collections.contains(id) {
            return true;
        }
        let Some((js, header, attributes, item_slot)) = Self::expected_collection_shape(id) else {
            return false;
        };
        let Some(shape) = &entry.component else {
            return false;
        };
        !(entry.js != js
            || entry.owner != "lane-05"
            || entry.availability != Availability::Implemented
            || shape.profile != "collection"
            || shape.header != header
            || !shape.alternates.is_empty()
            || shape
                .attributes
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                != attributes
            || if item_slot {
                shape.slots.len() != 1
                    || shape.slots[0].name != "item"
                    || !shape.slots[0].required
                    || !shape.slots[0].repeatable
            } else {
                !shape.slots.is_empty()
            })
    }

    /// A diagnostic-only row scope never assigns executable semantics to the
    /// unknown word, even when the complete alternative inventory is known.
    fn diagnose_unknown_collection_presentation(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        model: SymbolId,
        before: usize,
    ) {
        let Some(head) = kids(node)
            .into_iter()
            .find(|child| child.kind == SyntaxKind::Name)
        else {
            return;
        };
        let word = name_text(head, cx.text).unwrap_or("");
        let domain_checked = kids(node)
            .into_iter()
            .find(|child| is_expression(child.kind))
            .and_then(|domain| self.types.node_types.get(&NodeKey::of(domain)))
            .is_some_and(|ty| self.model_of_type(ty) == Some(model));
        let body_checked = kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::UiLeaf)
            .flat_map(kids)
            .filter(|value| is_expression(value.kind))
            .all(|value| {
                self.scope_row_model(value) == Some(model)
                    && self
                        .types
                        .node_types
                        .get(&NodeKey::of(value))
                        .is_some_and(|ty| {
                            !matches!(ty, ResolvedType::Error | ResolvedType::Unknown)
                        })
            });
        let structural_error = self.diags.iter().any(|diagnostic| {
            diagnostic.primary.file == cx.file && diagnostic.code.starts_with("E1")
        });
        let checked =
            domain_checked && body_checked && !structural_error && self.diags.len() == before;
        let complete = checked
            && self.office_collection_source_profile(cx, node, model)
            && self.office_collection_catalog_complete();
        let gap = if complete {
            "complete readonly alternatives: list; table with declared columns and display=split. Excluded board: no declared enum grouping; gallery: no declared image/file selector; calendar: no declared nonnullable date/datetime endpoints; timeline, carousel, hover_gallery, steps, text_rotate: direct text lacks required item/sequence slots and current native factories (hover_gallery also needs images)"
        } else if checked {
            "complete replacement coverage is unknown: board, gallery and calendar require distinct selectors, and catalog collections own different child slots"
        } else {
            "complete replacement coverage is unknown: the original model domain or row suite did not finish checking"
        };
        let mut diagnostic = Diagnostic::error(
            "E2001",
            format!("unknown collection presentation '{word}'; {gap}"),
            head.span,
        );
        diagnostic.construct_candidates = Some(Box::new(ConstructCandidates {
            version: 1,
            disposition: if complete { "exact" } else { "unknown" },
            slot: Some("then.collection-presentation"),
            ids: if complete {
                vec!["can.v1.ui.list", "can.v1.ui.table"]
            } else {
                Vec::new()
            },
            complete,
            context: complete.then(|| ConstructRankingContext {
                version: 1,
                message_kind: "unknown_collection_presentation",
                section: "Then",
                guess: word.to_string(),
                exact_source_span: true,
                structural_recovery: false,
                recovery_complete: true,
                name_filter_complete: true,
                material_intent_choice: true,
                evidence_sufficient: false,
                unsupported_behavior_proven: false,
            }),
        }));
        self.diags.push(diagnostic);
    }

    fn check_action_panel_targets(&mut self, cx: &Ctx<'_, '_>, owner: &SyntaxNode) {
        let spelling = |value: &SyntaxNode| {
            name_or_ref_word(value, cx.text)
                .map(str::to_owned)
                .or_else(|| string_literal_value(value))
        };
        let panels: HashSet<_> = owner
            .descendants()
            .filter(|node| {
                node.kind == SyntaxKind::CatalogItem
                    && kids(node)
                        .iter()
                        .find_map(|n| name_text(n, cx.text))
                        .is_some_and(|word| matches!(word, "modal" | "drawer"))
            })
            .filter_map(|node| attribute_value(node, "id", cx.text).and_then(spelling))
            .collect();
        for primitive in owner.descendants().filter(|node| {
            node.kind == SyntaxKind::UiLeaf
                && kids(node)
                    .iter()
                    .find_map(|n| name_text(n, cx.text))
                    .is_some_and(|word| matches!(word, "primary" | "secondary"))
        }) {
            if let Some(target) = attribute_value(primitive, "opens", cx.text)
                && !spelling(target).is_some_and(|name| panels.contains(&name))
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "action opens must name a declared local modal or drawer id".into(),
                    target.span,
                ));
            }
        }
    }

    /// Details widgets type their domain and `open=` binding; `display=`
    /// base values are unspecified (only the drawer exception is
    /// documented): no check.
    fn check_details_widget(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
    ) {
        if let Some(domain) = domain {
            let _ = self.expr(cx, domain, None);
        }
        if let Some(open) = attribute_value(node, "open", cx.text) {
            let ty = self.expr(cx, open, None);
            self.expect_bool(cx, tight_span(cx.text, open), &ty, "`details open=`");
        }
    }

    /// Inline selectors are vocabulary, so bind them explicitly instead of
    /// treating a same-spelled expression or a foreign field as an editor.
    fn check_preference_panel(&mut self, cx: &Ctx<'_, '_>, panel: &SyntaxNode) {
        for node in kids(panel)
            .into_iter()
            .filter(|node| node.kind != SyntaxKind::Name)
        {
            if let Some(fact) = self.preference_control_fact(cx, panel, node) {
                self.types
                    .preference_controls
                    .insert(NodeKey::of(node), fact);
            } else {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "preferences controls require one local bool toggle or text/int input field"
                        .into(),
                    node.span,
                ));
            }
        }
    }

    fn preference_control_fact(
        &mut self,
        cx: &Ctx<'_, '_>,
        panel: &SyntaxNode,
        node: &SyntaxNode,
    ) -> Option<CheckedPreferenceControl> {
        if node.kind != SyntaxKind::CatalogItem {
            return None;
        }
        let parts = kids(node);
        let control = parts.iter().find_map(|part| name_text(part, cx.text))?;
        if !matches!(control, "toggle" | "input")
            || parts
                .iter()
                .any(|part| !matches!(part.kind, SyntaxKind::Name | SyntaxKind::NameRef))
        {
            return None;
        }
        let headers: Vec<_> = parts
            .iter()
            .filter(|part| part.kind == SyntaxKind::NameRef)
            .copied()
            .collect();
        let [selector] = headers.as_slice() else {
            return None;
        };
        let name = name_or_ref_word(selector, cx.text)?;
        let owner = self
            .tables
            .symbols
            .iter()
            .find(|symbol| {
                symbol.module == cx.module && matches!(symbol.kind, SymbolKind::Preferences { .. })
            })?
            .clone();
        let field = owner
            .fields_of()
            .iter()
            .find(|field| self.tables.symbols[field.0 as usize].name == name)
            .copied()?;
        let ty = self.decl_type(field);
        let base = ty.nullable_inner().unwrap_or(&ty);
        let valid = match control {
            "toggle" => *base == ResolvedType::Scalar(Scalar::Bool),
            "input" => matches!(base, ResolvedType::Scalar(Scalar::Text | Scalar::Int)),
            _ => false,
        };
        valid.then(|| CheckedPreferenceControl {
            panel: NodeKey::of(panel),
            node: NodeKey::of(node),
            selector: NodeKey::of(selector),
            field,
            owner: owner.id,
            module: cx.module,
            control: control.to_string(),
            ty,
        })
    }

    /// Walk one presentation widget: type the domain, validate closed
    /// NAME sets, required selector lists and selector navigation
    /// against the domain model, then recurse into nested widgets.
    /// `parent` is the immediate enclosing widget kind (`tab` must sit
    /// directly inside `tabs`).
    fn walk_ui_page(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, parent: SyntaxKind) {
        self.walk_ui_page_with_tab_case(
            cx,
            node,
            parent,
            None,
            matches!(parent, SyntaxKind::Form | SyntaxKind::Edit),
            matches!(
                parent,
                SyntaxKind::Form | SyntaxKind::Edit | SyntaxKind::PreferencePanel
            ),
            if parent == SyntaxKind::Page {
                UiActionOwner::Page
            } else {
                UiActionOwner::None
            },
        );
    }

    /// URL and source-bound File destinations share one checked attribute profile.
    fn check_ui_destination_attributes(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, word: &str) {
        if word == "link" && attribute_value(node, "target", cx.text).is_none() {
            self.diags.push(Diagnostic::error(
                "E3001",
                "link requires one target".into(),
                node.span,
            ));
        }
        if matches!(word, "button" | "link")
            && (attribute_value(node, "target", cx.text).is_some()
                || attribute_value(node, "caption", cx.text).is_some())
        {
            for name in ["target", "caption"] {
                let Some(value) = attribute_value(node, name, cx.text) else {
                    continue;
                };
                let ty = self.expr(cx, value, None);
                let valid = if name == "target" {
                    // Accepted destination types remain valid source;
                    // URL/File emission needs its separate native profile.
                    // Only `link` accepts a nullable URL destination; a
                    // button keeps its existing non-nullable profile.
                    matches!(
                        ty,
                        ResolvedType::Scalar(Scalar::Text | Scalar::Url | Scalar::File)
                            | ResolvedType::Error
                    ) || matches!(&ty, ResolvedType::Nullable(inner)
                        if inner.as_ref() == &ResolvedType::Scalar(Scalar::File)
                            || (word == "link"
                                && inner.as_ref() == &ResolvedType::Scalar(Scalar::Url)))
                } else {
                    (word == "link" && ty == ResolvedType::Scalar(Scalar::Url))
                        || matches!(
                            ty,
                            ResolvedType::Scalar(Scalar::Text)
                                | ResolvedType::InlineMessage
                                | ResolvedType::Message(_)
                                | ResolvedType::Error
                        )
                };
                if !valid {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!(
                            "{word} {name} needs {}",
                            if name == "target" {
                                if word == "link" {
                                    "text, url, nullable url, file or nullable file"
                                } else {
                                    "text, url, file or nullable file"
                                }
                            } else {
                                "text or a message descriptor"
                            }
                        ),
                        tight_span(cx.text, value),
                    ));
                }
                for (call, span) in self.effectful_calls(value, cx.text) {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("{word} {name} must be pure; '{call}' is not allowed here"),
                        span,
                    ));
                }
            }
        }
    }

    /// A bound tabs owner supplies its exact enum only to direct tab headers.
    /// Body/gate scopes and lexical name resolution remain the ordinary UI walk.
    #[allow(clippy::too_many_arguments)]
    /// Check a `primary`/`secondary` action primitive against its owning
    /// action region.
    fn check_primitive_action(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        word: &str,
        form_owner: bool,
        action_owner: UiActionOwner,
    ) {
        let primitive = matches!(word, "primary" | "secondary")
            && matches!(node.kind, SyntaxKind::Form | SyntaxKind::UiLeaf);
        if primitive {
            let submit = attribute_value(node, "submit", cx.text).is_some();
            let valid = if form_owner {
                word == "primary" && submit && action_owner == UiActionOwner::Form
            } else {
                !submit
                    && matches!(
                        action_owner,
                        UiActionOwner::Page
                            | UiActionOwner::Card
                            | UiActionOwner::Row
                            | UiActionOwner::PanelActions
                            | UiActionOwner::Drawer
                    )
            };
            if !valid {
                self.diags.push(Diagnostic::error("E3001", if form_owner {
                    "an owning form/edit admits only primary submit=true directly in its action region".into()
                } else if submit {
                    "submit action requires an owning form/edit action region".into()
                } else {
                    format!("{word} needs an explicit action owner: page, card, list/table/board row, drawer details, or modal/drawer slot actions")
                }, node.span));
            }
        }
    }

    /// The action owner children of one page node inherit.
    fn child_action_owner_for(
        node: &SyntaxNode,
        text: &str,
        word: &str,
        form_owner: bool,
        action_owner: UiActionOwner,
    ) -> UiActionOwner {
        if let Some(owner) = Self::child_region_owner(node, text, word, form_owner, action_owner) {
            return owner;
        }
        match node.kind {
            SyntaxKind::Form | SyntaxKind::Edit => UiActionOwner::Form,
            SyntaxKind::Card if !form_owner => UiActionOwner::Card,
            SyntaxKind::Collection if !form_owner && matches!(word, "list" | "table" | "board") => {
                UiActionOwner::Row
            }
            SyntaxKind::UiLeaf if word == "require" => action_owner,
            SyntaxKind::Page => UiActionOwner::Page,
            SyntaxKind::View
            | SyntaxKind::Card
            | SyntaxKind::Collection
            | SyntaxKind::Details
            | SyntaxKind::CatalogItem
            | SyntaxKind::Slot
            | SyntaxKind::Tabs
            | SyntaxKind::Tab
            | SyntaxKind::Show
            | SyntaxKind::UiLeaf => UiActionOwner::None,
            _ => action_owner,
        }
    }

    /// A drawer/panel region owner, when the node declares one.
    fn child_region_owner(
        node: &SyntaxNode,
        text: &str,
        word: &str,
        form_owner: bool,
        action_owner: UiActionOwner,
    ) -> Option<UiActionOwner> {
        match node.kind {
            SyntaxKind::Details
                if !form_owner
                    && attribute_value(node, "display", text)
                        .is_some_and(|value| name_or_ref_word(value, text) == Some("drawer")) =>
            {
                Some(UiActionOwner::Drawer)
            }
            SyntaxKind::CatalogItem if !form_owner && matches!(word, "modal" | "drawer") => {
                Some(UiActionOwner::Panel)
            }
            SyntaxKind::Slot
                if !form_owner
                    && action_owner == UiActionOwner::Panel
                    && kids(node).iter().filter_map(|n| name_text(n, text)).nth(1)
                        == Some("actions") =>
            {
                Some(UiActionOwner::PanelActions)
            }
            _ => None,
        }
    }

    /// Walk a `show` node: exactly one `{row=expression}` object against
    /// the view's stored model.
    fn walk_show_node(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        let objects: Vec<_> = kids(node)
            .into_iter()
            .filter(|n| n.kind == SyntaxKind::Object)
            .collect();
        let entries = objects.first().map(|args| object_entries(args, cx.text));
        let row = entries
            .as_ref()
            .and_then(|entries| match entries.as_slice() {
                [("row", _, Some(value))] if objects.len() == 1 => Some(*value),
                _ => None,
            });
        let Some(row) = row else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "show requires exactly the explicit row argument {row=expression}".to_string(),
                tight_span(cx.text, node),
            ));
            for args in objects {
                self.walk_object_values(cx, args);
            }
            return;
        };
        let before = self.diags.len();
        let actual = self.expr(cx, row, None);
        for (name, span) in self.effectful_calls(row, cx.text) {
            self.diags.push(Diagnostic::error(
                "E3010",
                format!("show row argument must be pure; '{name}' is not allowed here"),
                span,
            ));
        }
        let key = NodeKey::of(node);
        let target = self.tables.show_views.get(&key).copied();
        if let Some((target, model)) = target.and_then(|target| {
            self.types
                .view_models
                .get(&target)
                .copied()
                .map(|model| (target, model))
        }) {
            let expected = ResolvedType::Record {
                symbol: model,
                stored: true,
            };
            if actual != expected {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "show row must be the view's exact nonnullable stored model".to_string(),
                    tight_span(cx.text, row),
                ));
            } else if self.diags.len() == before {
                self.types.view_uses.insert(key, target);
            }
        }
    }

    /// Walk a `require` node: a pure boolean predicate.
    fn walk_require_node(&mut self, cx: &Ctx<'_, '_>, domain: Option<&SyntaxNode>) {
        if let Some(pred) = domain {
            let ty = self.expr(cx, pred, None);
            self.expect_bool(cx, tight_span(cx.text, pred), &ty, "`require`");
            let forbidden = if self.membership_page_guards.contains(&NodeKey::of(pred)) {
                self.bounded_membership_effectful_calls(pred, cx.text)
            } else {
                self.effectful_calls(pred, cx.text)
            };
            for (name, span) in forbidden {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("page require must be pure; '{name}' is not allowed here"),
                    span,
                ));
            }
        }
    }

    /// Walk a `tabs` node: tab children or an enum preference selector;
    /// a bound owned selector sets the expected tab case.
    fn walk_tabs_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
        bound_tab_expected: &mut Option<ResolvedType>,
    ) {
        let has_tabs = kids(node).iter().any(|n| n.kind == SyntaxKind::Tab);
        if !has_tabs {
            match domain {
                None => {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        "tabs needs an enum preference selector or tab children".to_string(),
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
            self.walk_bound_tabs_selector(cx, domain, bound_tab_expected);
        }
    }

    /// Check a bound tabs selector: an owned nonnullable enum preference
    /// sets the expected tab case.
    fn walk_bound_tabs_selector(
        &mut self,
        cx: &Ctx<'_, '_>,
        domain: &SyntaxNode,
        bound_tab_expected: &mut Option<ResolvedType>,
    ) {
        let ty = self.expr(cx, domain, None);
        let mut selector = domain;
        while selector.kind == SyntaxKind::Group {
            let Some(inner) = kids(selector)
                .into_iter()
                .find(|child| is_expression(child.kind))
            else {
                break;
            };
            selector = inner;
        }
        let owned = self
            .types
            .preference_field_references
            .get(&NodeKey::of(selector))
            .and_then(|id| self.tables.symbols.get(id.0 as usize))
            .is_some_and(|field| {
                field.module == cx.module
                    && matches!(&field.kind, SymbolKind::Field { owner, .. }
                        if self.tables.symbols.get(owner.0 as usize).is_some_and(|owner|
                            owner.module == cx.module && matches!(owner.kind, SymbolKind::Preferences { .. })))
            });
        if owned && matches!(ty, ResolvedType::Enum { .. }) {
            *bound_tab_expected = Some(ty);
        } else if !matches!(ty, ResolvedType::Error) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "bound tab panels need an owned nonnullable enum preference selector".to_string(),
                tight_span(cx.text, domain),
            ));
        }
    }

    /// Walk a `tab` node: directly inside `tabs`, caption against the
    /// bound case.
    fn walk_tab_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parent: SyntaxKind,
        domain: Option<&SyntaxNode>,
        tab_case: Option<&ResolvedType>,
    ) {
        if parent != SyntaxKind::Tabs {
            self.diags.push(Diagnostic::error(
                "E3001",
                "tab must be directly inside tabs".to_string(),
                tight_span(cx.text, node),
            ));
        }
        if let Some(caption) = domain {
            let _ = self.expr(cx, caption, tab_case.cloned());
        }
    }

    /// Walk a `card` node: type its domain and check its layout.
    fn walk_card_node(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, domain: Option<&SyntaxNode>) {
        if let Some(domain) = domain {
            let _ = self.expr(cx, domain, None);
        }
        if let Some(layout) = attribute_value(node, "layout", cx.text) {
            let word = name_or_ref_word(layout, cx.text).unwrap_or("");
            if !matches!(word, "stack" | "columns") {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "card layout must be stack or columns".to_string(),
                    tight_span(cx.text, layout),
                ));
            }
        }
    }

    /// Walk a collection node: seed the row from its domain model,
    /// check its shape attributes and selectors.
    fn walk_collection_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
        row_seed: &mut Option<NarrowEnv>,
    ) {
        let head = kids(node).iter().find_map(|n| name_text(n, cx.text));
        let domain_type = domain.map(|d| self.expr(cx, d, None));
        let model = domain_type.as_ref().and_then(|ty| self.model_of_type(ty));
        self.seed_collection_row(cx, domain, head, &domain_type, model, row_seed);
        self.check_collection_shape(cx, node, head, model);
        if let Some(model) = model {
            self.check_collection_selectors(cx, node, model);
        }
        if let Some(empty) = attribute_value(node, "empty", cx.text) {
            let _ = self.expr(cx, empty, None);
        }
        if let Some(defaults) = attribute_value(node, "defaults", cx.text) {
            let _ = self.expr(cx, defaults, None);
        }
        // Preference-dispatched `order=` and `display=` remain
        // separate runtime profiles; fixed ordering is checked above.
    }

    /// Seed a collection's row element: bare-model domains seed from the
    /// domain model, readonly inspection fields from their schema, and
    /// query domains contribute their `where` facts.
    fn seed_collection_row(
        &mut self,
        cx: &Ctx<'_, '_>,
        domain: Option<&SyntaxNode>,
        head: Option<&str>,
        domain_type: &Option<ResolvedType>,
        model: Option<SymbolId>,
        row_seed: &mut Option<NarrowEnv>,
    ) {
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
        // Bound arrays carry their checked element owner into the nested
        // collection's own row slot. Contract rows remain readonly values:
        // preserve their stored flag instead of inventing a model fetch or
        // inheriting the enclosing collection's row. Inspection fields keep
        // their exact standard nominal schema through the same mechanism.
        if let Some(d) = domain
            && let Some(ResolvedType::Array { element, .. }) = domain_type
            && (matches!(element.as_ref(), ResolvedType::Record { symbol, .. }
                if self.tables.symbols.get(symbol.0 as usize).is_some_and(|owner|
                    matches!(owner.kind, SymbolKind::Model { .. } | SymbolKind::Contract { .. })))
                || head == Some("list")
                    && element.as_ref() == &std_nominal_leaf_type("WorkflowField"))
        {
            self.rows
                .entry(NodeKey::of(d))
                .or_insert_with(|| (**element).clone());
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
                    *row_seed = Some(env);
                }
            }
        }
    }

    /// Check a collection's shape attributes: `table` needs `columns=`,
    /// `board` needs `by=`, `calendar` needs `start=`/`end=`.
    fn check_collection_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        head: Option<&str>,
        model: Option<SymbolId>,
    ) {
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
    }

    /// Check a collection's selectors against its domain model:
    /// `columns=`/`search=`/`filter=`, `order=` and text-like searches.
    fn check_collection_selectors(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, model: SymbolId) {
        for key in ["columns", "search", "filter"] {
            if let Some(sel) = attribute_value(node, key, cx.text) {
                self.check_selectors(cx, node, model, sel, key, true);
            }
        }
        if let Some(order) = attribute_value(node, "order", cx.text) {
            if order.kind == SyntaxKind::Selectors {
                self.check_selectors(cx, node, model, order, "order", true);
                self.check_order_key_list(cx, node, model, order);
            } else if order.kind == SyntaxKind::PreferenceOrder {
                self.check_preference_order(cx, node, model, order);
            }
        }
        if let Some(search) = attribute_value(node, "search", cx.text) {
            for selector in kids(search) {
                if let Some(ty) = self.ui_selector_type(model, &path_segments(selector, cx.text))
                    && !matches!(ty, ResolvedType::Scalar(s) if s.is_string_like())
                {
                    self.diags.push(Diagnostic::error(
                        "E3006",
                        "search selectors must name nonnullable text-like fields".to_string(),
                        tight_span(cx.text, selector),
                    ));
                }
            }
        }
    }

    /// Walk a `form` node: action captions and targets, field
    /// selectors and display/import/review attributes.
    fn walk_form_node(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, domain: Option<&SyntaxNode>) {
        let primitive = kids(node)
            .iter()
            .find_map(|n| name_text(n, cx.text))
            .is_some_and(|word| matches!(word, "primary" | "secondary"));
        if primitive {
            if let Some(caption) = kids(node)
                .into_iter()
                .find(|n| is_expression(n.kind) || n.kind == SyntaxKind::MessageValue)
            {
                self.check_caption(cx, caption, "action caption", None);
                let _ = self.expr(cx, caption, None);
            }
            if let Some(target) = attribute_value(node, "action", cx.text) {
                self.check_form_action_target(cx, node, target);
            }
        }
        let form_target = attribute_value(node, "action", cx.text).or(domain);
        if let Some(domain) = form_target {
            let ty = self.expr(cx, domain, None);
            if let Some(model) = self.model_of_type(&ty)
                && let Some(sel) = attribute_value(node, "fields", cx.text)
            {
                self.check_selectors(cx, node, model, sel, "fields=", true);
            }
            if let ResolvedType::Operation(operation) = ty {
                let inputs = match self.tables.symbols[operation.0 as usize].kind {
                    SymbolKind::CrudOp { model, .. } => self
                        .model_fields(model)
                        .iter()
                        .map(|field| {
                            (
                                self.tables.symbols[field.0 as usize].name.clone(),
                                self.decl_type(*field),
                            )
                        })
                        .collect(),
                    _ => self
                        .action_inputs(operation)
                        .into_iter()
                        .filter_map(|input| input.expected.map(|ty| (input.name, ty)))
                        .collect(),
                };
                self.check_form_text_controls(cx, node, &inputs);
            }
        }
        if let Some(args) = attribute_value(node, "arguments", cx.text) {
            let _ = self.expr(cx, args, None);
        }
        if let Some(submit) = attribute_value(node, "submit", cx.text) {
            let _ = self.expr(cx, submit, None);
        }
        self.check_form_display_import(cx, node);
    }

    /// Explicit text controls consume prepared fields of the owning operation.
    /// Reject incompatible types before emitting a page that would throw in UI.
    fn check_form_text_controls(
        &mut self,
        cx: &Ctx<'_, '_>,
        owner: &SyntaxNode,
        inputs: &HashMap<String, ResolvedType>,
    ) {
        let mut pending = kids(owner);
        while let Some(node) = pending.pop() {
            if matches!(
                node.kind,
                SyntaxKind::Form | SyntaxKind::Edit | SyntaxKind::PreferencePanel
            ) {
                continue;
            }
            let word = kids(node)
                .iter()
                .find_map(|part| name_text(part, cx.text))
                .unwrap_or("");
            if node.kind == SyntaxKind::CatalogItem && matches!(word, "input" | "textarea") {
                let headers: Vec<_> = kids(node)
                    .into_iter()
                    .filter(|part| is_expression(part.kind))
                    .collect();
                if let [selector] = headers.as_slice()
                    && let Some(name) = name_or_ref_word(selector, cx.text)
                    && let Some(ty) = inputs.get(name)
                {
                    let base = ty.nullable_inner().unwrap_or(ty);
                    let accepted = match base {
                        ResolvedType::Scalar(scalar) => {
                            scalar.is_string_like()
                                || (word == "input"
                                    && matches!(
                                        scalar,
                                        Scalar::Int
                                            | Scalar::Decimal
                                            | Scalar::Money
                                            | Scalar::Duration
                                            | Scalar::Date
                                            | Scalar::Datetime
                                    ))
                        }
                        ResolvedType::Error | ResolvedType::Unknown | ResolvedType::Opaque(_) => {
                            true
                        }
                        _ => false,
                    };
                    if !accepted {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!(
                                "field '{name}': {word} needs a text-like{} input, got {}",
                                if word == "input" {
                                    ", numeric, duration, date or datetime"
                                } else {
                                    ""
                                },
                                ty.display(self.tables, cx.module)
                            ),
                            selector.span,
                        ));
                    }
                }
            }
            pending.extend(kids(node));
        }
    }

    /// Check a form's `display=`/`import=`/`review=` attributes.
    fn check_form_display_import(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) {
        if let Some(display) = attribute_value(node, "display", cx.text)
            && name_or_ref_word(display, cx.text) != Some("inline")
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "form display supports only inline".to_string(),
                tight_span(cx.text, display),
            ));
        }
        let import = attribute_value(node, "import", cx.text);
        if let Some(import) = import
            && name_or_ref_word(import, cx.text) != Some("csv")
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "form import supports only csv".to_string(),
                tight_span(cx.text, import),
            ));
        }
        if attribute_value(node, "review", cx.text).is_some()
            && import.is_some_and(|i| name_or_ref_word(i, cx.text) != Some("csv"))
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "form review requires import=csv".to_string(),
                tight_span(cx.text, node),
            ));
        }
    }

    /// Check a form action target: a declared operation with required
    /// protected record arguments and checked argument values.
    fn check_form_action_target(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        target: &SyntaxNode,
    ) {
        let Some(operation) = self.tables.node_symbol.get(&NodeKey::of(target)).copied() else {
            self.diags.push(Diagnostic::error(
                "E3001",
                "action requires a checked declared operation".into(),
                target.span,
            ));
            return;
        };
        let schema = self.action_inputs(operation);
        if schema.is_empty()
            && !matches!(
                self.tables.symbols[operation.0 as usize].kind,
                SymbolKind::Scenario { .. }
                    | SymbolKind::CrudOp { .. }
                    | SymbolKind::CapabilityOp { .. }
            )
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "action requires a declared operation".into(),
                target.span,
            ));
        }
        if let SymbolKind::CrudOp { model, op } = self.tables.symbols[operation.0 as usize].kind
            && !self.crud_op_enabled(model, op)
        {
            self.diags.push(Diagnostic::error(
                "E3001",
                "action CRUD operation is disabled".into(),
                target.span,
            ));
        }
        let bound: HashSet<_> = attribute_value(node, "arguments", cx.text)
            .map(|arguments| {
                object_entries(arguments, cx.text)
                    .into_iter()
                    .map(|(name, _, _)| name)
                    .collect()
            })
            .unwrap_or_default();
        for input in &schema {
            if matches!(
                self.tables.symbols[operation.0 as usize].kind,
                SymbolKind::CrudOp {
                    op: CrudOp::Update | CrudOp::Delete,
                    ..
                }
            ) && input.name == "record"
                && !bound.contains(input.name.as_str())
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!(
                        "action requires explicit protected record argument '{}'",
                        input.name
                    ),
                    target.span,
                ));
            }
        }
        if let Some(arguments) = attribute_value(node, "arguments", cx.text) {
            for (name, key, value) in object_entries(arguments, cx.text) {
                if !schema.iter().any(|input| input.name == name) {
                    self.diags.push(Diagnostic::error(
                        "E3001",
                        format!("'{name}' is not an input of this action"),
                        key.span,
                    ));
                }
                self.check_action_value(cx, node, operation, &schema, name, key, value);
            }
        }
    }

    /// Walk a leaf node: primitive `target=`/`submit=` attributes and
    /// require-leaf purity gates.
    fn walk_ui_leaf_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
    ) {
        let primitive = kids(node)
            .iter()
            .find_map(|n| name_text(n, cx.text))
            .is_some_and(|word| matches!(word, "primary" | "secondary"));
        if primitive {
            if let Some(caption) = domain {
                self.check_caption(cx, caption, "action caption", None);
                let _ = self.expr(cx, caption, None);
            }
            for name in ["target", "submit"] {
                self.check_leaf_action_attr(cx, node, name);
            }
        }
        let require_leaf = kids(node).iter().find_map(|n| name_text(n, cx.text)) == Some("require");
        for child in kids(node) {
            if is_expression(child.kind) {
                let _ = self.expr(cx, child, None);
                // Card/tab gates are checked before their subtree and
                // skipped below. Standalone page/form require leaves
                // retain the same pure gate, including helper closures.
                if require_leaf {
                    let forbidden = if self.membership_page_guards.contains(&NodeKey::of(child)) {
                        self.bounded_membership_effectful_calls(child, cx.text)
                    } else {
                        self.effectful_calls(child, cx.text)
                    };
                    for (name, span) in forbidden {
                        self.diags.push(Diagnostic::error(
                            "E3010",
                            format!("page require must be pure; '{name}' is not allowed here"),
                            span,
                        ));
                    }
                }
            }
        }
    }

    /// Check one leaf action attribute: `submit=` needs literal `true`,
    /// `target=` needs a text-like target; both must be pure.
    fn check_leaf_action_attr(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, name: &str) {
        if let Some(value) = attribute_value(node, name, cx.text) {
            let ty = self.expr(cx, value, None);
            let valid = if name == "submit" {
                ty == ResolvedType::Scalar(Scalar::Bool)
                    && matches!(literal_leaf(value, cx.text), Some((_, "true")))
            } else {
                matches!(
                    ty,
                    ResolvedType::Scalar(Scalar::Text | Scalar::Url | Scalar::File)
                        | ResolvedType::Error
                ) || matches!(&ty, ResolvedType::Nullable(inner)
                    if inner.as_ref() == &ResolvedType::Scalar(Scalar::File))
            };
            if !valid {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    if name == "submit" {
                        "action submit requires literal true".into()
                    } else {
                        format!("action {name} has an invalid target type")
                    },
                    value.span,
                ));
            }
            for (call, span) in self.effectful_calls(value, cx.text) {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("action {name} must be pure; '{call}' is not allowed here"),
                    span,
                ));
            }
        }
    }

    /// Walk a catalog item: button/tooltip rules, collapse/stat/count
    /// options, child expressions and timeline row seeding.
    #[allow(clippy::too_many_arguments)]
    fn walk_catalog_item_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parent: SyntaxKind,
        domain: Option<&SyntaxNode>,
        word: &str,
        submit_owner: bool,
        unknown_presentation: bool,
        row_seed: &mut Option<NarrowEnv>,
    ) {
        if word == "button" {
            self.check_catalog_button(cx, node, submit_owner);
        }
        if word == "tooltip"
            && node.descendants().any(|child| {
                matches!(child.kind, SyntaxKind::Form | SyntaxKind::UiLeaf)
                    && kids(child)
                        .iter()
                        .find_map(|part| name_text(part, cx.text))
                        .is_some_and(|name| matches!(name, "primary" | "secondary"))
            })
        {
            self.diags.push(Diagnostic::error("E3001", "tooltip is noninteractive and cannot contain primary or secondary actions, including nested owners".into(), node.span));
        }
        if unknown_presentation && let Some(empty) = attribute_value(node, "empty", cx.text) {
            self.check_page_static_text(cx, empty, "collection empty");
        }
        // Collapse shares Details' expression-valued open option;
        // retain its checked type instead of treating it as vocabulary.
        if kids(node).iter().find_map(|n| name_text(n, cx.text)) == Some("collapse")
            && let Some(open) = attribute_value(node, "open", cx.text)
        {
            let ty = self.expr(cx, open, None);
            self.expect_bool(cx, tight_span(cx.text, open), &ty, "`collapse open=`");
        }
        if word == "button" {
            self.check_ui_destination_attributes(cx, node, word);
        }
        self.check_catalog_stat_count(cx, node, parent);
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
            self.seed_timeline_row(cx, node, d, row_seed);
        }
    }

    /// Check a catalog `button`: exactly one binding, submit only with
    /// an owning form/edit/panel.
    fn check_catalog_button(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode, submit_owner: bool) {
        let bindings = ["action", "submit", "target", "opens"]
            .iter()
            .filter(|name| attribute_value(node, name, cx.text).is_some())
            .count();
        if bindings != 1 {
            self.diags.push(Diagnostic::error(
                "E3001",
                "button requires exactly one of action, submit, target or opens".into(),
                node.span,
            ));
        }
        if !submit_owner && let Some(submit) = attribute_value(node, "submit", cx.text) {
            self.diags.push(Diagnostic::error(
                "E3001",
                "button submit requires an owning canonical form, edit or preferences panel".into(),
                tight_span(cx.text, submit),
            ));
        }
    }

    /// Check catalog `stat`/`count` options: text-like descriptions and
    /// list-owned counts.
    fn check_catalog_stat_count(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parent: SyntaxKind,
    ) {
        if kids(node).iter().find_map(|n| name_text(n, cx.text)) == Some("stat")
            && let Some(value) = attribute_value(node, "description", cx.text)
        {
            let ty = self.expr(cx, value, None);
            if !matches!(
                ty,
                ResolvedType::Scalar(Scalar::Text)
                    | ResolvedType::InlineMessage
                    | ResolvedType::Message(_)
                    | ResolvedType::Error
            ) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "stat description needs text or a message descriptor".to_string(),
                    tight_span(cx.text, value),
                ));
            }
            for (name, span) in self.effectful_calls(value, cx.text) {
                self.diags.push(Diagnostic::error(
                    "E3010",
                    format!("stat description must be pure; '{name}' is not allowed here"),
                    span,
                ));
            }
        }
        if kids(node).iter().find_map(|n| name_text(n, cx.text)) == Some("count") {
            if parent != SyntaxKind::Collection {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "count belongs directly inside a list".to_string(),
                    tight_span(cx.text, node),
                ));
            }
            if let Some(label) = attribute_value(node, "label", cx.text) {
                self.check_page_static_text(cx, label, "count label");
            }
        }
    }

    /// Seed a `timeline` item's `row` narrowing from its domain element,
    /// resolving bare-model domains from the namespace.
    fn seed_timeline_row(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        d: &SyntaxNode,
        row_seed: &mut Option<NarrowEnv>,
    ) {
        let mut model = self
            .types
            .node_types
            .get(&NodeKey::of(d))
            .as_ref()
            .and_then(|ty| self.model_of_type(ty));
        if model.is_none() && d.kind == SyntaxKind::NameRef {
            model = name_or_ref_word(d, cx.text)
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
                *row_seed = Some(env);
            }
        }
    }

    /// Walk the simple page nodes (preference panels, details, forms,
    /// edits, leaves and catalog items) that carry no tab case.
    #[allow(clippy::too_many_arguments)]
    fn walk_ui_simple_node(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parent: SyntaxKind,
        domain: Option<&SyntaxNode>,
        word: &str,
        submit_owner: bool,
        unknown_presentation: Option<SymbolId>,
        row_seed: &mut Option<NarrowEnv>,
    ) {
        match node.kind {
            SyntaxKind::PreferencePanel => self.check_preference_panel(cx, node),
            SyntaxKind::Details => self.check_details_widget(cx, node, domain),
            SyntaxKind::Form => {
                self.walk_form_node(cx, node, domain);
            }
            SyntaxKind::Edit => {
                if let Some(sel) = attribute_value(node, "fields", cx.text)
                    && let Some(model) = self.scope_row_model(sel)
                {
                    self.check_selectors(cx, node, model, sel, "fields=", true);
                }
            }
            SyntaxKind::UiLeaf => {
                self.walk_ui_leaf_node(cx, node, domain);
            }
            SyntaxKind::CatalogItem => {
                self.walk_catalog_item_node(
                    cx,
                    node,
                    parent,
                    domain,
                    word,
                    submit_owner,
                    unknown_presentation.is_some(),
                    row_seed,
                );
            }
            _ => {}
        }
    }

    /// Walk a page node's children in order, skipping gates already
    /// checked, routes, attributes, errors and plain expressions.
    #[allow(clippy::too_many_arguments)]
    fn walk_page_children(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        inner: &Ctx<'_, '_>,
        gated: bool,
        bound_tab_expected: Option<&ResolvedType>,
        form_owner: bool,
        submit_owner: bool,
        child_action_owner: UiActionOwner,
    ) {
        for child in kids(node) {
            if gated
                && child.kind == SyntaxKind::UiLeaf
                && kids(child).iter().find_map(|n| name_text(n, cx.text)) == Some("require")
            {
                continue;
            }
            if matches!(child.kind, SyntaxKind::Route | SyntaxKind::Attribute) {
                continue;
            }
            if has_error(child) || is_expression(child.kind) {
                continue;
            }
            if child.kind == SyntaxKind::Name || child.kind == SyntaxKind::Punct {
                continue;
            }
            self.walk_ui_page_with_tab_case(
                inner,
                child,
                node.kind,
                if node.kind == SyntaxKind::Tabs && child.kind == SyntaxKind::Tab {
                    bound_tab_expected
                } else {
                    None
                },
                form_owner || matches!(node.kind, SyntaxKind::Form | SyntaxKind::Edit),
                submit_owner
                    || matches!(
                        node.kind,
                        SyntaxKind::Form | SyntaxKind::Edit | SyntaxKind::PreferencePanel
                    ),
                child_action_owner,
            );
        }
    }

    fn walk_ui_page_with_tab_case(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        parent: SyntaxKind,
        tab_case: Option<&ResolvedType>,
        form_owner: bool,
        submit_owner: bool,
        action_owner: UiActionOwner,
    ) {
        let word = kids(node)
            .iter()
            .find_map(|n| name_text(n, cx.text))
            .unwrap_or("");
        self.check_primitive_action(cx, node, word, form_owner, action_owner);
        if word == "link" {
            self.check_ui_destination_attributes(cx, node, word);
        }
        let child_action_owner =
            Self::child_action_owner_for(node, cx.text, word, form_owner, action_owner);
        let unknown_presentation = self
            .tables
            .unknown_collection_presentations
            .get(&NodeKey::of(node))
            .copied();
        let before_presentation = self.diags.len();
        let domain = kids(node).iter().find(|n| is_expression(n.kind)).copied();
        let mut row_seed: Option<NarrowEnv> = None;
        let mut bound_tab_expected = None;
        match node.kind {
            SyntaxKind::Show => {
                self.walk_show_node(cx, node);
                return;
            }
            SyntaxKind::Require => {
                self.walk_require_node(cx, domain);
                return;
            }
            SyntaxKind::Card => self.walk_card_node(cx, node, domain),
            SyntaxKind::Tabs => {
                self.walk_tabs_node(cx, node, domain, &mut bound_tab_expected);
            }
            SyntaxKind::Tab => self.walk_tab_node(cx, node, parent, domain, tab_case),
            SyntaxKind::Collection => {
                self.walk_collection_node(cx, node, domain, &mut row_seed);
            }
            // Catalog positional domains are expressions, like leaf
            // domains; `NAME=word` options stay untyped (PR5 words).
            _ => self.walk_ui_simple_node(
                cx,
                node,
                parent,
                domain,
                word,
                submit_owner,
                unknown_presentation,
                &mut row_seed,
            ),
        }
        // Direct card/tab gates run before the container's children. Their
        // stable-path facts belong only to that gated subtree, like row seeds.
        let gated = self.walk_gated_requires(cx, node, &mut row_seed);
        // Child contexts never escape into sibling subtrees.
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
        self.walk_page_children(
            cx,
            node,
            inner,
            gated,
            bound_tab_expected.as_ref(),
            form_owner,
            submit_owner,
            child_action_owner,
        );
        if let Some(model) = unknown_presentation {
            self.diagnose_unknown_collection_presentation(cx, node, model, before_presentation);
        }
        self.check_bound_tabs(cx, node, domain, bound_tab_expected);
    }

    /// Check direct card/tab `require` gates before the container's
    /// children; their facts belong only to that gated subtree.
    /// Returns whether the node is gated.
    fn walk_gated_requires(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        row_seed: &mut Option<NarrowEnv>,
    ) -> bool {
        let gated = matches!(node.kind, SyntaxKind::Card | SyntaxKind::Tab);
        if gated {
            let mut env = row_seed.take().unwrap_or_else(|| cx.narrow.clone());
            for gate in kids(node).into_iter().filter(|child| {
                child.kind == SyntaxKind::UiLeaf
                    && kids(child).iter().find_map(|n| name_text(n, cx.text)) == Some("require")
                    && !has_error(child)
            }) {
                let Some(pred) = kids(gate).into_iter().find(|n| is_expression(n.kind)) else {
                    continue;
                };
                let gate_cx = Ctx {
                    module: cx.module,
                    file: cx.file,
                    text: cx.text,
                    narrow: &env,
                    strict: cx.strict,
                    server_default: cx.server_default,
                };
                let before = self.diags.len();
                let ty = self.expr(&gate_cx, pred, None);
                self.expect_bool(&gate_cx, tight_span(cx.text, pred), &ty, "`require`");
                for (name, span) in self.effectful_calls(pred, cx.text) {
                    self.diags.push(Diagnostic::error(
                        "E3010",
                        format!("page require must be pure; '{name}' is not allowed here"),
                        span,
                    ));
                }
                if self.diags.len() == before && ty == ResolvedType::Scalar(Scalar::Bool) {
                    let mut facts = NarrowEnv::default();
                    self.collect_narrow(&gate_cx, pred, false, &mut facts);
                    env.extend(facts);
                }
            }
            *row_seed = Some(env);
        }
        gated
    }

    /// Check bound tab panels against their owning enum preference: every
    /// case exactly once, then record the binding.
    fn check_bound_tabs(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
        bound: Option<ResolvedType>,
    ) {
        let Some(ty @ ResolvedType::Enum { .. }) = bound else {
            return;
        };
        let ResolvedType::Enum { cases, owner } = &ty else {
            unreachable!()
        };
        let (panels, nodes, seen) = self.collect_bound_tab_panels(cx, node, &ty, cases);
        self.record_bound_tabs(
            cx,
            node,
            domain,
            ty.clone(),
            cases,
            *owner,
            panels,
            nodes,
            seen,
        );
    }

    /// Collect bound tab panels: each tab header must name an exact case
    /// of the owning enum preference, exactly once.
    fn collect_bound_tab_panels(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        ty: &ResolvedType,
        cases: &[String],
    ) -> (
        Vec<(NodeKey, NodeKey, String)>,
        Vec<(NodeKey, ResolvedType)>,
        HashSet<String>,
    ) {
        let mut panels = Vec::new();
        let mut nodes = Vec::new();
        let mut seen = HashSet::new();
        for tab in kids(node)
            .into_iter()
            .filter(|child| child.kind == SyntaxKind::Tab)
        {
            let Some(header) = kids(tab)
                .into_iter()
                .find(|child| is_expression(child.kind))
            else {
                continue;
            };
            let mut case = header;
            nodes.push((NodeKey::of(header), ty.clone()));
            while case.kind == SyntaxKind::Group {
                let Some(inner) = kids(case)
                    .into_iter()
                    .find(|child| is_expression(child.kind))
                else {
                    break;
                };
                case = inner;
                nodes.push((NodeKey::of(case), ty.clone()));
            }
            let name = name_or_ref_word(case, cx.text);
            if case.kind != SyntaxKind::NameRef
                || !self.types.resolved_cases.contains(&NodeKey::of(case))
                || !name.is_some_and(|name| cases.iter().any(|known| known == name))
            {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    "bound tab header must name an exact case of its owning enum preference"
                        .to_string(),
                    tight_span(cx.text, header),
                ));
                continue;
            }
            let name = name.expect("checked exact enum case").to_string();
            panels.push((NodeKey::of(tab), NodeKey::of(case), name.clone()));
            if !seen.insert(name.clone()) {
                self.diags.push(Diagnostic::error(
                    "E3001",
                    format!("bound tabs repeats case '{name}'"),
                    tight_span(cx.text, header),
                ));
            }
        }
        (panels, nodes, seen)
    }

    /// Record a complete bound-tabs binding: every owning enum case
    /// present exactly once, with its selector and symbol inventory.
    #[allow(clippy::too_many_arguments)]
    fn record_bound_tabs(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        domain: Option<&SyntaxNode>,
        ty: ResolvedType,
        cases: &[String],
        owner: Option<SymbolId>,
        panels: Vec<(NodeKey, NodeKey, String)>,
        nodes: Vec<(NodeKey, ResolvedType)>,
        seen: HashSet<String>,
    ) {
        let mut nodes = nodes;
        let missing: Vec<_> = cases
            .iter()
            .filter(|case| !seen.contains(*case))
            .cloned()
            .collect();
        if !missing.is_empty() {
            self.diags.push(Diagnostic::error(
                "E3001",
                format!(
                    "bound tabs needs every owning enum case exactly once; missing {}",
                    missing.join(", ")
                ),
                tight_span(cx.text, domain.expect("bound selector")),
            ));
        }
        if missing.is_empty() && panels.len() == cases.len() && seen.len() == cases.len() {
            let mut selector = domain.expect("bound selector");
            nodes.push((NodeKey::of(selector), ty.clone()));
            while selector.kind == SyntaxKind::Group {
                let Some(inner) = kids(selector)
                    .into_iter()
                    .find(|child| is_expression(child.kind))
                else {
                    break;
                };
                selector = inner;
                nodes.push((NodeKey::of(selector), ty.clone()));
            }
            if let Some(field) = self
                .types
                .preference_field_references
                .get(&NodeKey::of(selector))
                .copied()
            {
                let mut symbols = Vec::new();
                let mut reuse = Vec::new();
                let mut pending = vec![field];
                if let Some(owner) = owner {
                    pending.push(owner);
                }
                let mut visited = HashSet::new();
                while let Some(id) = pending.pop() {
                    if !visited.insert(id) {
                        continue;
                    }
                    let Some(symbol) = self.tables.symbols.get(id.0 as usize) else {
                        continue;
                    };
                    symbols.push((symbol.clone(), self.decl.get(&id).cloned()));
                    if let SymbolKind::Field { owner, .. } = symbol.kind {
                        pending.push(owner);
                        let source = self.types.field_reuse_sources.get(&id).copied();
                        reuse.push((id, source));
                        if let Some(source) = source {
                            pending.push(source);
                        }
                    }
                }
                self.types.bound_tabs.insert(
                    NodeKey::of(node),
                    CheckedBoundTabs {
                        module: cx.module,
                        owner_module: self.tables.modules[cx.module.0 as usize].clone(),
                        selector: NodeKey::of(selector),
                        field,
                        ty,
                        panels,
                        nodes,
                        symbols,
                        reuse,
                    },
                );
            }
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
            let selected = self.check_selectors(cx, node, model, endpoint, key, true);
            let segments = path_segments(paths[0], cx.text);
            if let [name] = segments.as_slice()
                && selected.len() == 1
                && selected[0] == *name
                && let Some(field) = self.model_field_named(model, name)
                && matches!(self.tables.symbols.get(field.0 as usize).map(|symbol| &symbol.kind),
                    Some(SymbolKind::Field { owner, .. }) if *owner == model)
            {
                let fact = CheckedCalendarEndpoint {
                    collection: NodeKey::of(node),
                    value: NodeKey::of(endpoint),
                    path: NodeKey::of(paths[0]),
                    module: cx.module,
                    model,
                    field,
                    relative_path: (*name).to_string(),
                    ty: self.decl_type(field),
                };
                self.types
                    .calendar_endpoints
                    .insert(fact.value, fact.clone());
                self.types.calendar_endpoints.insert(fact.path, fact);
            }
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
                        self.check_entry_assignment(cx, key, key_node, value, &expected, "E3015");
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3015");
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
                    self.check_entry_assignment(cx, key, key_node, value, &expected, "E3015");
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
                CrudOp::Create => self.check_fixture_create_entry(cx, model, key, key_node, value),
                CrudOp::Update => self.check_fixture_update_entry(cx, model, key, key_node, value),
                CrudOp::Delete => self.check_fixture_delete_entry(cx, model, key, key_node, value),
            }
        }
        // Completeness: required create fields, update's record and
        // changes, delete's record.
        self.check_fixture_request_complete(cx, model, op_kind, request, &seen);
    }

    /// Check one request entry value against its expected type (`E3015`
    /// on mismatch).
    fn check_fixture_typed_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
        expected: ResolvedType,
        what: &str,
    ) {
        let (actual, value_span) = self.entry_value(cx, key_node, value, Some(expected.clone()));
        if !actual.is_error() && !self.types_compatible(&actual, &expected) {
            self.diags.push(Diagnostic::error(
                "E3015",
                format!(
                    "'{what}': expected {}, found {}",
                    self.show(cx.module, &expected),
                    self.show(cx.module, &actual)
                ),
                value_span,
            ));
        }
    }

    /// Check one `create` request entry: `parent=` for child models,
    /// otherwise a known field with a compatible value.
    fn check_fixture_create_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        key: &str,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) {
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
                    self.check_fixture_typed_entry(
                        cx,
                        key_node,
                        value,
                        ResolvedType::Record {
                            symbol: parent,
                            stored: true,
                        },
                        "parent",
                    );
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
            return;
        }
        let Some(field) = self.model_field_named(model, key) else {
            self.diags.push(Diagnostic::error(
                "E3015",
                format!("unknown request input '{key}'"),
                tight_span(cx.text, key_node),
            ));
            self.entry_value(cx, key_node, value, None);
            return;
        };
        let expected = self.decl_type(field);
        self.check_fixture_typed_entry(cx, key_node, value, expected, key);
    }

    /// Check one `update` request entry: `record=` plus a `changes=`
    /// object of field updates.
    fn check_fixture_update_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        key: &str,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) {
        if key == "record" {
            self.check_fixture_typed_entry(
                cx,
                key_node,
                value,
                ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
                "record",
            );
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
                format!("unknown request input '{key}'; update takes record= and changes="),
                tight_span(cx.text, key_node),
            ));
            self.entry_value(cx, key_node, value, None);
        }
    }

    /// Check one `delete` request entry: only `record=`.
    fn check_fixture_delete_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        key: &str,
        key_node: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) {
        if key == "record" {
            self.check_fixture_typed_entry(
                cx,
                key_node,
                value,
                ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
                "record",
            );
        } else {
            self.diags.push(Diagnostic::error(
                "E3015",
                format!("unknown request input '{key}'; delete takes record="),
                tight_span(cx.text, key_node),
            ));
            self.entry_value(cx, key_node, value, None);
        }
    }

    /// Check request completeness: required create fields, update's
    /// record and changes, delete's record.
    fn check_fixture_request_complete(
        &mut self,
        cx: &Ctx<'_, '_>,
        model: SymbolId,
        op_kind: CrudOp,
        request: &SyntaxNode,
        seen: &[String],
    ) {
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
            self.check_entry_assignment(cx, key, key_node, value, &expected, "E3015");
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
        SyntaxKind::NameRef => Some((name_or_ref_word(node, text)?.to_string(), Vec::new())),
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

/// Names in source order from the one ICU grammar, across every branch.
/// Malformed patterns supply no speculative slots: E5007 owns their failure.
fn message_slots(template: &str) -> Vec<String> {
    let Ok(usages) = super::icu::parse(template) else {
        return Vec::new();
    };
    let mut slots = Vec::new();
    for usage in usages {
        push_slot(&mut slots, usage.name);
    }
    slots
}

fn push_slot(slots: &mut Vec<String>, name: String) {
    if !slots.contains(&name) {
        slots.push(name);
    }
}

/// Whether `node` is an inline message descriptor (`"… "@{…}`),
/// through groups. Per DESIGN §9.1 a suffixed string is a message
/// descriptor, not ordinary text. Inline descriptors declare no `Message`
/// symbol and retain their own checked value type.
fn is_message_descriptor(node: &SyntaxNode) -> bool {
    message_descriptor_node(node).is_some()
}

fn message_descriptor_node(node: &SyntaxNode) -> Option<&SyntaxNode> {
    let mut current = node;
    loop {
        match current.kind {
            SyntaxKind::MessageValue => return Some(current),
            SyntaxKind::Group => {
                let parts = kids(current);
                let inner = parts.iter().find(|n| is_expression(n.kind))?;
                current = inner;
            }
            _ => return None,
        }
    }
}

/// Entries of an `Object` node: (key text, key node, value node).
/// The value is `None` for shorthand entries (`{name}`), whose type
/// comes from the name's binding (see [`Typer::entry_value`]).
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
        Binding::Let { .. }
        | Binding::QueryAlias { .. }
        | Binding::ForItem { .. }
        | Binding::CohortChild { .. }
        | Binding::CreateAs { .. }
        | Binding::CallAs { .. }
        | Binding::SendAs { .. }
        | Binding::RouteParam { .. } => node_binding_decl_key(binding),
        Binding::Context(context) => context_decl_key(context),
        Binding::Builtin { .. }
        | Binding::Predicate
        | Binding::External { .. }
        | Binding::Error => DeclKey::Unresolved(spelling.to_string()),
    }
}

fn node_binding_decl_key(binding: &Binding) -> DeclKey {
    match binding {
        Binding::Let { node } => DeclKey::Let(*node),
        Binding::QueryAlias { node } => DeclKey::QueryAlias(*node),
        Binding::ForItem { node } => DeclKey::ForItem(*node),
        Binding::CohortChild { node, .. } => DeclKey::CohortChild(*node),
        Binding::CreateAs { node } => DeclKey::CreateAs(*node),
        Binding::CallAs { node } => DeclKey::CallAs(*node),
        Binding::SendAs { node } => DeclKey::SendAs(*node),
        Binding::RouteParam { node } => DeclKey::RouteParam(*node),
        _ => unreachable!("node_binding_decl_key takes only node-carrying bindings"),
    }
}

fn context_decl_key(context: &ContextVar) -> DeclKey {
    match context {
        ContextVar::Actor(_) => DeclKey::CtxActor,
        ContextVar::Team => DeclKey::CtxTeam,
        ContextVar::Now => DeclKey::CtxNow,
        ContextVar::Operation => DeclKey::CtxOperation,
        ContextVar::Event => DeclKey::CtxEvent,
        ContextVar::RowModel(model) => DeclKey::CtxRowModel(*model),
        ContextVar::RowQuery { node } => DeclKey::CtxRowQuery(*node),
        ContextVar::Parent { model } => DeclKey::CtxParent(*model),
        ContextVar::Preferences { module } => DeclKey::CtxPreferences(*module),
        ContextVar::Result { scenario, crud_op } => DeclKey::CtxResult(*scenario, *crud_op),
        ContextVar::TestAccount(account) => {
            let slot = match account {
                super::resolve::TestAccount::Slf => 0,
                super::resolve::TestAccount::Other => 1,
                super::resolve::TestAccount::Outsider => 2,
            };
            DeclKey::CtxTestAccount(slot)
        }
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
#[derive(Clone, Copy, PartialEq, Eq)]
enum UiActionOwner {
    None,
    Page,
    Card,
    Row,
    Panel,
    PanelActions,
    Drawer,
    Form,
}

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
    /// Publication/default metadata needed by refresh even before the target body is checked.
    unpublished_scenarios: HashSet<SymbolId>,
    refresh_defaults: HashMap<SymbolId, SyntaxNode>,
    /// Context-declared queue names per module (send/on= targets).
    queue_names: HashSet<(ModuleId, String)>,
    judgment_messages: HashMap<SymbolId, SyntaxNode>,
    /// Existing strict purity sites retain their source roots for helper closure.
    strict_purity_roots: Vec<SyntaxNode>,
    retention_roots: Vec<SyntaxNode>,
    parameter_defaults: HashMap<SymbolId, SyntaxNode>,
    membership_derive_bodies: HashMap<SymbolId, SyntaxNode>,
    membership_page_guards: HashSet<NodeKey>,
}

/// Peel single-expression `Group` wrappers (at most 64 deep).
fn ungroup(mut current: &SyntaxNode) -> Option<&SyntaxNode> {
    for _ in 0..64 {
        if current.kind != SyntaxKind::Group {
            return Some(current);
        }
        let mut children = current
            .children
            .iter()
            .filter(|child| is_expression(child.kind));
        current = children.next()?;
        if children.next().is_some() {
            return None;
        }
    }
    None
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
            unpublished_scenarios: HashSet::new(),
            refresh_defaults: HashMap::new(),
            queue_names: HashSet::new(),
            judgment_messages: HashMap::new(),
            strict_purity_roots: Vec::new(),
            retention_roots: Vec::new(),
            parameter_defaults: HashMap::new(),
            membership_derive_bodies: HashMap::new(),
            membership_page_guards: HashSet::new(),
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

/// One `min`/`max`/flag modifier word of a field, if `part` names one.
fn field_modifier<'n>(part: &'n SyntaxNode, text: &str) -> Option<FieldModifier<'n>> {
    if is_name(part, text, "trim") {
        Some(FieldModifier::Trim(part))
    } else if is_name(part, text, "unique") {
        Some(FieldModifier::Unique(part))
    } else if is_name(part, text, "machine") {
        Some(FieldModifier::Machine(part))
    } else if is_name(part, text, "min") {
        Some(FieldModifier::Min(part))
    } else if is_name(part, text, "max") {
        Some(FieldModifier::Max(part))
    } else {
        None
    }
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
        } else if let Some(modifier) = field_modifier(part, text) {
            parts.modifiers.push(modifier);
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
        self.decl.extend(self.tables.judgment_types.clone());
        self.types.given_fields = self.tables.given_fields.clone();
        self.types.given_constraints = self.tables.given_constraints.clone();
        for (id, field) in &self.tables.given_fields {
            if let Some(ty) = std_schema_type(&field.type_name) {
                self.decl.insert(*id, ty);
                self.shapes
                    .insert(*id, (field.default.is_some(), false, false));
            }
        }
        self.types.value_constraints = self.tables.judgment_value_constraints.clone();
        for field in self.tables.judgment_types.keys() {
            self.shapes.insert(
                *field,
                (
                    false,
                    false,
                    self.tables.judgment_required_arrays.contains(field),
                ),
            );
        }
        self.types.judgment_generated_symbols = self.tables.judgment_generated_symbols.clone();
        self.types.judgment_required_arrays = self.tables.judgment_required_arrays.clone();
        for (owner, judgment) in &self.tables.judgment_declarations {
            self.shapes.insert(judgment.state, (false, false, true));
            for parameter in [judgment.evaluate_options, judgment.specification_options]
                .into_iter()
                .flatten()
            {
                self.shapes.insert(parameter, (false, false, false));
            }
            if let Some(specification) = judgment.specification {
                self.results.insert(
                    specification,
                    Some(ResolvedType::Record {
                        symbol: self.tables.judgment_standard_records["JudgmentSpec"],
                        stored: true,
                    }),
                );
            }
            self.results.insert(
                judgment.evaluate,
                Some(ResolvedType::Record {
                    symbol: *owner,
                    stored: true,
                }),
            );
        }
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
            let before = (
                self.decl.clone(),
                self.results.clone(),
                self.routes.clone(),
                self.types.value_constraints.clone(),
            );
            let mut scratch = Vec::new();
            std::mem::swap(&mut *self.diags, &mut scratch);
            self.phase1_round(trees);
            let round = std::mem::replace(&mut *self.diags, scratch);
            merge_round_diags(self.diags, round);
            if (
                self.decl.clone(),
                self.results.clone(),
                self.routes.clone(),
                self.types.value_constraints.clone(),
            ) == before
            {
                break;
            }
        }
        // Chain-navigation failures re-record every round; keep the first
        // occurrence (pass-2 emission dedupes again).
        let mut seen = HashSet::new();
        self.types
            .unresolved_members
            .retain(|m| seen.insert((m.node, m.name.clone())));
        // Existing fields keep their authored shape, while an admitted
        // field-trait default makes omission legal before body checking.
        for (field, constraints) in &self.tables.given_constraints {
            if constraints
                .iter()
                .any(|constraint| constraint.default.is_some())
            {
                self.shapes.entry(*field).or_insert((false, false, false)).0 = true;
            }
        }
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
            SyntaxKind::Model | SyntaxKind::Contract | SyntaxKind::Event => {
                self.phase1_record(file, text, module, node);
            }
            SyntaxKind::Capability => {
                self.phase1_capability(file, text, module, node);
            }
            SyntaxKind::Message => {
                if let Some(message) = self.decl_symbol(module, text, node, &["export", "message"])
                {
                    self.phase1_params(file, text, module, message, node);
                }
            }
            SyntaxKind::Derive => {
                self.phase1_derive(file, text, module, node);
            }
            _ => {}
        }
    }

    fn phase1_record(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
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

    fn phase1_capability(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
    ) {
        if let Some(cap) = self.decl_symbol(module, text, node, &["export", "capability"]) {
            for child in node.children.iter().filter(|c| {
                matches!(c.kind, SyntaxKind::CapabilityOp | SyntaxKind::Event) && !has_error(c)
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

    fn phase1_derive(&mut self, file: SourceId, text: &str, module: ModuleId, node: &SyntaxNode) {
        let parts = kids(node);
        let is_function = parts.iter().any(|n| is_punct(n, text, "("));
        if is_function {
            self.phase1_derive_function(file, text, module, node, &parts);
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
                    let resolved = self.resolve_type_node(file, text, module, ty, Some(field));
                    self.decl.insert(field, resolved);
                }
            }
        }
    }

    fn phase1_derive_function(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        parts: &[&SyntaxNode],
    ) {
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
                    result = Some(self.resolve_type_node(file, text, module, next, None));
                }
            }
            self.results.insert(id, result);
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
        if node.kind == SyntaxKind::Preferences {
            if let Some(prefs) = self.prefs_symbol(module) {
                self.prefs.insert(module, prefs);
                for field in node.children.iter().filter(|c| c.kind == SyntaxKind::Field) {
                    self.phase1_field(file, text, module, prefs, field);
                }
            }
            return;
        }
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
        if let Some(default) = shape.default {
            self.refresh_defaults.insert(id, default.clone());
        }

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
        self.intersect_reused_constraints(id, field, text, &shape.modifiers);
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
            self.intersect_reused_constraints(*id, param_node, text, &shape.modifiers);
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

    fn inherit_value_constraints(&mut self, owner: Option<SymbolId>, source: SymbolId) {
        if let Some(owner) = owner {
            if let Some(constraints) = self.types.value_constraints.get(&source).cloned() {
                self.types.value_constraints.insert(owner, constraints);
            } else {
                self.types.value_constraints.remove(&owner);
            }
        }
    }

    /// A receiving declaration narrows inherited bounds without weakening them.
    fn intersect_reused_constraints(
        &mut self,
        id: SymbolId,
        node: &SyntaxNode,
        text: &str,
        modifiers: &[FieldModifier<'_>],
    ) {
        let Some(mut constraints) = self.types.value_constraints.get(&id).cloned() else {
            return;
        };
        for modifier in modifiers {
            let (word, minimum) = match modifier {
                FieldModifier::Min(word) => (*word, true),
                FieldModifier::Max(word) => (*word, false),
                _ => continue,
            };
            let Some(bound) = modifier_value(node, word) else {
                continue;
            };
            let Some(value) = int_literal_value(bound, text).filter(|value| *value >= 0) else {
                self.diags.push(Diagnostic::error(
                    "E3012",
                    "a reused judgment value bound requires a nonnegative int literal".to_string(),
                    tight_span(text, bound),
                ));
                continue;
            };
            if minimum {
                constraints.min = Some(constraints.min.map_or(value, |old| old.max(value)));
            } else {
                constraints.max = Some(constraints.max.map_or(value, |old| old.min(value)));
            }
        }
        if matches!((constraints.min, constraints.max), (Some(min), Some(max)) if min > max) {
            self.diags.push(Diagnostic::error(
                "E3012",
                "receiving bounds conflict with inherited judgment value bounds".to_string(),
                tight_span(text, node),
            ));
        }
        self.types.value_constraints.insert(id, constraints);
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
            SyntaxKind::NullableType => self.resolve_nullable_type(file, text, module, node, owner),
            SyntaxKind::ArrayType => self.resolve_array_type(file, text, module, node, owner),
            SyntaxKind::UnionType => self.resolve_union(file, text, module, node),
            SyntaxKind::EnumType => Self::resolve_enum_type_node(node, text, owner),
            SyntaxKind::ActionType => self.resolve_action(file, text, module, node),
            SyntaxKind::DeliveryType => self.resolve_delivery(file, text, module, node),
            SyntaxKind::InvocationType => self.resolve_invocation(file, text, module, node),
            _ => ResolvedType::Error,
        }
    }

    fn resolve_nullable_type(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
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

    fn resolve_array_type(
        &mut self,
        file: SourceId,
        text: &str,
        module: ModuleId,
        node: &SyntaxNode,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
        let inner = kids(node)
            .iter()
            .find(|n| is_type_node(n.kind))
            .map(|t| self.resolve_type_node(file, text, module, t, owner))
            .unwrap_or(ResolvedType::Error);
        // Scalar alias bounds belong to each element. The alias
        // retains them; outer field bounds describe array length.
        if matches!(inner, ResolvedType::Scalar(_))
            && let Some(owner) = owner
            && let Some(constraints) = self.types.value_constraints.get_mut(&owner)
            && constraints.alias.is_some()
        {
            constraints.min = None;
            constraints.max = None;
            constraints.format = None;
        }
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

    fn resolve_enum_type_node(
        node: &SyntaxNode,
        text: &str,
        owner: Option<SymbolId>,
    ) -> ResolvedType {
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
            TypeRef::External => {
                let segments = path_segments(path, text);
                let schema = segments
                    .first()
                    .and_then(|name| self.tables.module_scopes[module.0 as usize].prod.get(*name))
                    .and_then(|binding| match binding {
                        ScopedName::External { provider, name }
                            if provider == "std" && name != "WorkflowField" =>
                        {
                            nominal_schema(name)
                        }
                        _ => None,
                    });
                let Some(schema) = schema else {
                    return ResolvedType::Opaque("external type");
                };
                let mut current = std_nominal_object(schema);
                for (i, name) in segments.iter().enumerate().skip(1) {
                    match &current {
                        ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => {
                            if let Some((_, ty)) = fields.iter().find(|(field, _)| field == *name) {
                                current = ty.clone();
                                continue;
                            }
                        }
                        ResolvedType::Opaque(_) | ResolvedType::Unknown | ResolvedType::Error => {
                            return current;
                        }
                        _ => {}
                    }
                    self.member_fail(
                        path,
                        segment_span(path, i),
                        self.show(module, &current),
                        (*name).to_string(),
                    );
                    return ResolvedType::Error;
                }
                current
            }
            TypeRef::Symbol(id) => {
                self.inherit_value_constraints(owner, id);
                self.symbol_type(file, text, module, id, path.span)
            }
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
        if self.tables.judgment_generated_symbols.contains(&id) && self.decl.contains_key(&id) {
            return self.decl_type(id);
        }
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
            self.types.field_reuse_sources.insert(owner, field);
        }
        self.inherit_value_constraints(owner, field);
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
        if segments == ["evaluate"]
            && let Some(judgment) = self.tables.judgment_declarations.get(&head)
        {
            return Some(judgment.evaluate);
        }
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
            SyntaxKind::MessageValue => ResolvedType::InlineMessage,
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
            (ResolvedType::Message(a), ResolvedType::Message(b)) => a == b,
            (ResolvedType::Delivery { op: a }, ResolvedType::Delivery { op: b }) => a == b,
            (ResolvedType::Operation(a), ResolvedType::Operation(b)) => a == b,
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
            ) => Self::enums_compatible(actual, expected, ac, ao, bc, bo),
            (
                ResolvedType::Record {
                    symbol: a,
                    stored: sa,
                },
                ResolvedType::Record {
                    symbol: b,
                    stored: sb,
                },
            ) => self.records_compatible(a, *sa, b, *sb),
            _ => self.types_compatible_composite(actual, expected),
        }
    }

    /// Whether two enum shapes are compatible: same owner, same
    /// anonymous cases, or the one-way completion-to-delivery status
    /// relation.
    fn enums_compatible(
        actual: &ResolvedType,
        expected: &ResolvedType,
        ac: &[String],
        ao: &Option<SymbolId>,
        bc: &[String],
        bo: &Option<SymbolId>,
    ) -> bool {
        ao == bo
            && (ao.is_some()
                || ac == bc
                // A terminal completion outcome fits its owning
                // receipt status. This exact std relation is one-way;
                // named enum identity and other anonymous sets stay strict.
                || (ao.is_none()
                    && *actual == completion_status_type()
                    && *expected == delivery_status_type()))
    }

    /// Whether two record shapes are compatible: same symbol, and a
    /// detached construct never stands in for stored model rows.
    fn records_compatible(&self, a: &SymbolId, sa: bool, b: &SymbolId, sb: bool) -> bool {
        if a != b {
            return false;
        }
        // Detached constructs cannot stand in for stored model
        // rows (no id/version); contracts/events are values.
        if sb && !sa {
            return !matches!(
                self.tables.symbols[a.0 as usize].kind,
                SymbolKind::Model { .. }
            );
        }
        true
    }

    /// Whether two composite shapes are compatible: action/invocation
    /// containment, std-delivery association, structural element, union,
    /// nominal and object width rules.
    fn types_compatible_composite(&self, actual: &ResolvedType, expected: &ResolvedType) -> bool {
        match (actual, expected) {
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
            (
                ResolvedType::StdNominal {
                    name: a,
                    fields: af,
                },
                ResolvedType::StdNominal {
                    name: b,
                    fields: bf,
                },
            ) => a == b && af == bf,
            (ResolvedType::Object(a), ResolvedType::Object(b)) => self.objects_compatible(a, b),
            _ => false,
        }
    }

    /// Whether object `actual` covers object `expected`: every expected
    /// entry is present and compatible; missing entries must be
    /// nullable (omissible, like contract/event fields).
    fn objects_compatible(
        &self,
        a: &[(String, ResolvedType)],
        b: &[(String, ResolvedType)],
    ) -> bool {
        b.iter()
            .all(|(k, t)| match a.iter().find(|(ak, _)| ak == k) {
                Some((_, at)) => self.types_compatible(at, t),
                // Published std object schemas use nullable fields
                // for omissible entries, like contract/event fields.
                None => matches!(t, ResolvedType::Nullable(_)),
            })
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
                self.type_integer_literal(cx, node, slice, expect)
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
            SyntaxKind::String => self.type_string_literal(cx, node, expect),
            SyntaxKind::Name => match slice {
                "true" | "false" => ResolvedType::Scalar(Scalar::Bool),
                "null" => ResolvedType::Null,
                _ => ResolvedType::Error,
            },
            _ => ResolvedType::Error,
        }
    }

    fn type_integer_literal(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        slice: &str,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
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

    fn type_string_literal(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
    ) -> ResolvedType {
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
                if let Some(descriptor) = self.types.message_descriptor_references.get(key).copied()
                {
                    self.types
                        .message_descriptor_references
                        .insert(NodeKey::of(node), descriptor);
                }
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
            SymbolKind::Message { params } => {
                if params.is_empty() {
                    ResolvedType::Message(id)
                } else {
                    if cx.strict {
                        self.diags.push(Diagnostic::error(
                            "E3005",
                            format!(
                                "parameterized message '{}' is not a bare value; use an ordinary call to bind its parameters",
                                record_name(self.tables, cx.module, id)
                            ),
                            tight_span(cx.text, node),
                        ));
                    }
                    ResolvedType::Error
                }
            }
            SymbolKind::Scenario { .. }
            | SymbolKind::CapabilityOp { .. }
            | SymbolKind::CrudOp { .. } => ResolvedType::Operation(id),
            SymbolKind::Field { .. }
            | SymbolKind::Param { .. }
            | SymbolKind::DeriveField { .. } => self.decl_type(id),
            SymbolKind::Fixture { target } => Self::fixture_value_type(self.tables, *target),
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

    /// Value type of a fixture recipe target.
    fn fixture_value_type(tables: &ResolveTables, target: FixtureTarget) -> ResolvedType {
        match target {
            FixtureTarget::Model(model) => ResolvedType::Record {
                symbol: model,
                stored: true,
            },
            FixtureTarget::User => ResolvedType::Scalar(Scalar::User),
            FixtureTarget::File => ResolvedType::Scalar(Scalar::File),
            FixtureTarget::Operation(Some(op))
                if matches!(
                    tables.symbols[op.0 as usize].kind,
                    SymbolKind::CapabilityOp { .. }
                ) =>
            {
                ResolvedType::Delivery { op }
            }
            FixtureTarget::Operation(_) => ResolvedType::Opaque("operation fixture"),
            FixtureTarget::Unknown => ResolvedType::Error,
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
        // An explicit case is a checked declaration path, never a runtime
        // field read. Resolve the root through the ordinary lexical binding.
        if let Some(ty) = self.type_enum_case_member(cx, node, receiver, name_node, name, safe) {
            return ty;
        }
        if name == "callback_diagnostics" {
            return self.type_callback_diagnostics(cx, node, receiver, name_node, name, safe);
        }
        // Narrowed chain (safe-access/`is` continuation): the whole
        // chain proven a type is that type; otherwise a narrowed
        // receiver steps normally (plain `.` is sound on it).
        if let Some(narrowed) = self.narrowed_chain(cx, node) {
            // A proven member still evaluates its real receiver. Visit that
            // occurrence with the same continuation facts so source consumers
            // retain its checked binding/type and nested receiver occurrences.
            self.expr(cx, receiver, None);
            return narrowed;
        }
        if let Some(narrowed) = self.narrowed_chain(cx, receiver) {
            // This shortcut already uses the checked continuation fact. Keep
            // its original receiver occurrence for lowering/source consumers,
            // just as ordinary expression checking records its receiver.
            self.expr(cx, receiver, None);
            return self.member_on(cx, node, name_node, name, &narrowed, safe);
        }
        // Model/capability symbol receivers (operations, not fields).
        if let Some(ty) = self.type_symbol_member(cx, node, receiver, name_node, name, safe) {
            return ty;
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

    fn type_enum_case_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        receiver: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        safe: bool,
    ) -> Option<ResolvedType> {
        if safe || receiver.kind != SyntaxKind::Member {
            return None;
        }
        let field_parts = kids(receiver);
        if field_parts.len() == 3
            && is_punct(field_parts[1], cx.text, ".")
            && let Some(owner) = self.symbol_receiver(cx, field_parts[0])
            && matches!(
                self.tables.symbols[owner.0 as usize].kind,
                SymbolKind::Model { .. } | SymbolKind::Contract { .. }
            )
            && let Some(field_name) = name_text(field_parts[2], cx.text)
        {
            // A judgment's static specification is its checked standard record,
            // not a nominal enum field path. Let ordinary member typing resolve
            // the actual JudgmentSpec receiver before selecting its field.
            if field_name == "specification"
                && self.tables.judgment_declarations.contains_key(&owner)
            {
                return None;
            }
            let Some(field) = self.record_field_named(owner, field_name) else {
                self.unknown_member(cx, receiver, field_parts[2], field_name, "enum case owner");
                return Some(ResolvedType::Error);
            };
            let ty = self.decl_type(field);
            let ResolvedType::Enum { cases, .. } = &ty else {
                self.unknown_member(cx, node, name_node, name, "singular nonnullable enum field");
                return Some(ResolvedType::Error);
            };
            if !cases.iter().any(|case| case == name) {
                self.unknown_member(cx, node, name_node, name, "enum field");
                return Some(ResolvedType::Error);
            }
            self.types.resolved_cases.insert(NodeKey::of(node));
            return Some(ty);
        }
        None
    }

    fn type_callback_diagnostics(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        receiver: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        safe: bool,
    ) -> ResolvedType {
        let base = self.expr(cx, receiver, None);
        if matches!(base, ResolvedType::Error | ResolvedType::Null) {
            return self.member_on(cx, node, name_node, name, &base, safe);
        }
        let source = if receiver.kind == SyntaxKind::Member {
            let receipt_parts = kids(receiver);
            receipt_parts
                .first()
                .and_then(|record| self.types.node_types.get(&NodeKey::of(record)))
                .and_then(|ty| match ty.nullable_inner().unwrap_or(ty) {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => Some(*symbol),
                    _ => None,
                })
                .and_then(|model| {
                    receipt_parts
                        .get(2)
                        .and_then(|field_name| name_text(field_name, cx.text))
                        .and_then(|field_name| self.model_field_named(model, field_name))
                })
                .and_then(|field| self.types.callback_diagnostic_sources.get(&field).cloned())
        } else {
            None
        };
        if let Some(source) = source {
            if matches!(base, ResolvedType::Nullable(_)) && !safe {
                return self.member_on(cx, node, name_node, name, &base, safe);
            }
            let ty = if matches!(base, ResolvedType::Nullable(_)) {
                ResolvedType::Nullable(Box::new(callback_diagnostic_result(None)))
            } else {
                callback_diagnostic_result(None)
            };
            let field_name = &self.tables.symbols[source.field.0 as usize].name;
            self.types.callback_diagnostic_reads.insert(
                NodeKey::of(node),
                CheckedGenerationCallbackObservation {
                    node: NodeKey::of(node),
                    path: format!("{field_name}.callback_diagnostics"),
                    source,
                    ty: Some(ty.clone()),
                },
            );
            return ty;
        }
        self.unknown_member(cx, node, name_node, name, "checked generation association");
        ResolvedType::Error
    }

    fn type_symbol_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        receiver: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        safe: bool,
    ) -> Option<ResolvedType> {
        let id = self.symbol_receiver(cx, receiver)?;
        if self.tables.judgments.contains(&id) {
            return Some(self.type_judgment_member(cx, node, name_node, name, safe, id));
        }
        let symbol = &self.tables.symbols[id.0 as usize];
        match &symbol.kind {
            SymbolKind::Model { .. } => Some(self.model_member(cx, node, name_node, id, name)),
            SymbolKind::Capability { ops, .. } => {
                let ops = ops.clone();
                for op in ops {
                    if self.tables.symbols[op.0 as usize].name == name {
                        return Some(ResolvedType::Operation(op));
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
                Some(ResolvedType::Error)
            }
            _ => None,
        }
    }

    fn type_judgment_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        safe: bool,
        id: SymbolId,
    ) -> ResolvedType {
        if let Some(judgment) = self.tables.judgment_declarations.get(&id) {
            if !safe && name == "evaluate" {
                return ResolvedType::Operation(judgment.evaluate);
            }
            if !safe && name == "specification" {
                if let Some(function) = judgment.specification {
                    return ResolvedType::Operation(function);
                }
                if let Some(symbol) = self
                    .tables
                    .judgment_standard_records
                    .get("JudgmentSpec")
                    .copied()
                {
                    self.types
                        .judgment_specifications
                        .insert(NodeKey::of(node), id);
                    return ResolvedType::Record {
                        symbol,
                        stored: true,
                    };
                }
                self.diags.push(Diagnostic::error(
                    "E6006",
                    "static judgment specification requires the consumed std.JudgmentSpec schema"
                        .to_string(),
                    tight_span(cx.text, node),
                ));
                return ResolvedType::Error;
            }
        }
        self.member_fail(
            node,
            name_node.span,
            format!("judgment {}", record_name(self.tables, cx.module, id)),
            name.to_string(),
        );
        ResolvedType::Error
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
            ResolvedType::Scalar(_) | ResolvedType::Team | ResolvedType::OperationContext => {
                self.scalar_member(cx, node, name_node, name, base)
            }
            ResolvedType::Array { .. } => {
                self.unknown_member(cx, node, name_node, name, "array");
                None
            }
            ResolvedType::Union(arms) => self.union_member(cx, node, name_node, name, arms),
            ResolvedType::Object(fields) | ResolvedType::StdNominal { fields, .. } => {
                match fields.iter().find(|(k, _)| k == name) {
                    Some((_, ty)) => Some(ty.clone()),
                    None => {
                        self.unknown_member(cx, node, name_node, name, "object");
                        None
                    }
                }
            }
            ResolvedType::Delivery { op } => self.delivery_member(cx, node, name_node, name, *op),
            ResolvedType::StdDelivery { capability, op } => {
                self.std_delivery_member(cx, node, name_node, name, capability, op)
            }
            other => {
                let base_name = self.show(cx.module, other);
                self.unknown_member(cx, node, name_node, name, &base_name);
                None
            }
        }
    }

    fn scalar_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        base: &ResolvedType,
    ) -> Option<ResolvedType> {
        match base {
            ResolvedType::Scalar(Scalar::Money) => match name {
                "minor" => Some(ResolvedType::Scalar(Scalar::Int)),
                "currency" => Some(ResolvedType::Scalar(Scalar::Currency)),
                _ => {
                    self.unknown_member(cx, node, name_node, name, "money");
                    None
                }
            },
            ResolvedType::Scalar(Scalar::User) => self.user_member(cx, node, name_node, name),
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
            _ => {
                let base_name = self.show(cx.module, base);
                self.unknown_member(cx, node, name_node, name, &base_name);
                None
            }
        }
    }

    fn user_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
    ) -> Option<ResolvedType> {
        match name {
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
        }
    }

    fn delivery_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        op: SymbolId,
    ) -> Option<ResolvedType> {
        match name {
            "id" => Some(ResolvedType::Scalar(Scalar::Text)),
            "status" => Some(delivery_status_type()),
            "error" => Some(delivery_error_type()),
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

    fn std_delivery_member(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        name_node: &SyntaxNode,
        name: &str,
        capability: &'static str,
        op: &'static StdOperation,
    ) -> Option<ResolvedType> {
        match name {
            "id" => Some(ResolvedType::Scalar(Scalar::Text)),
            "status" => Some(delivery_status_type()),
            "error" => Some(delivery_error_type()),
            // T14d: `attempt.result` types against the
            // consumed owner result shape (DESIGN §8.1:
            // `result:R?` is the only nominal-typed leaf).
            // Scalar/enum results reuse the existing
            // vocabulary; transcribed T13c nominals resolve
            // to their closed field object; unknown/absent
            // nominals stay opaque, never guessed.
            "result" => Some(std_delivery_result_type(op)),
            "progress"
                if delivery_progress_alias(&ResolvedType::StdDelivery { capability, op }) =>
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
            if matches!(record.kind, SymbolKind::Preferences { .. }) {
                self.types
                    .preference_field_references
                    .insert(NodeKey::of(node), field);
            }
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

/// Shared narrowed facts across one binary worklist.
type SharedNarrow = std::rc::Rc<NarrowEnv>;

/// One pending binary-operand step: evaluate, combine first, combine second.
enum BinaryWork<'n> {
    Eval(&'n SyntaxNode, Option<ResolvedType>, SharedNarrow),
    First(&'n SyntaxNode, SharedNarrow, bool),
    Second(&'n SyntaxNode, SharedNarrow, ResolvedType, bool),
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
        let mut work = vec![BinaryWork::Eval(
            node,
            None,
            std::rc::Rc::new(cx.narrow.clone()),
        )];
        let mut value = ResolvedType::Error;
        while let Some(step) = work.pop() {
            let (current, narrow) = match &step {
                BinaryWork::Eval(n, _, env)
                | BinaryWork::First(n, env, _)
                | BinaryWork::Second(n, env, _, _) => (*n, env.clone()),
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
                BinaryWork::Eval(current, expect, narrow) => {
                    self.binary_step_eval(
                        cx, &local, current, &parts, op, expect, narrow, &mut work, &mut value,
                    );
                }
                BinaryWork::First(current, narrow, reverse) => {
                    self.binary_step_first(
                        cx, &local, current, &parts, op, narrow, reverse, &mut work, &mut value,
                    );
                }
                BinaryWork::Second(current, _, first, reverse) => {
                    let (left, right) = if reverse {
                        (value, first)
                    } else {
                        (first, value)
                    };
                    value = self.binary_step_second(&local, current, &parts, op, left, right);
                    self.record(current, value.clone());
                }
            }
        }
        value
    }

    fn binary_step_eval<'n>(
        &mut self,
        _cx: &Ctx<'_, '_>,
        local: &Ctx<'_, '_>,
        current: &'n SyntaxNode,
        parts: &[&'n SyntaxNode],
        op: &str,
        expect: Option<ResolvedType>,
        narrow: SharedNarrow,
        work: &mut Vec<BinaryWork<'n>>,
        value: &mut ResolvedType,
    ) {
        if current.kind != SyntaxKind::Binary {
            *value = self.expr(local, current, expect);
            return;
        }
        if has_error(current) || !self.tables.expr_scope.contains_key(&NodeKey::of(current)) {
            *value = ResolvedType::Error;
            return;
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
            *value = self.record(current, ResolvedType::Error);
            return;
        }
        let reverse = matches!(op, "==" | "!=")
            && self.is_case_candidate(parts[0])
            && !self.is_case_candidate(parts[2]);
        let first = if reverse { parts[2] } else { parts[0] };
        work.push(BinaryWork::First(current, narrow.clone(), reverse));
        work.push(BinaryWork::Eval(first, None, narrow));
    }

    fn binary_step_first<'n>(
        &mut self,
        cx: &Ctx<'_, '_>,
        local: &Ctx<'_, '_>,
        current: &'n SyntaxNode,
        parts: &[&'n SyntaxNode],
        op: &str,
        narrow: SharedNarrow,
        reverse: bool,
        work: &mut Vec<BinaryWork<'n>>,
        value: &mut ResolvedType,
    ) {
        if op == "is" {
            *value = self.type_is(
                local,
                current,
                parts[2],
                std::mem::replace(value, ResolvedType::Error),
            );
            self.record(current, value.clone());
            return;
        }
        let mut right_narrow = narrow.clone();
        if matches!(op, "and" | "or") {
            self.expect_bool(
                local,
                tight_span(cx.text, parts[0]),
                value,
                "`and`/`or` operand",
            );
            let mut extended = (*narrow).clone();
            extended.extend(self.extract_narrow(local, parts[0], op == "or"));
            right_narrow = std::rc::Rc::new(extended);
        }
        let expect = match op {
            "==" | "!=" => Some(value.clone()),
            "??" if unwrap_groups(parts[2]).kind == SyntaxKind::Array
                && !kids(unwrap_groups(parts[2]))
                    .into_iter()
                    .any(|child| is_expression(child.kind)) =>
            {
                // The fallback supplies no elements to infer. Use
                // only the checked nullable left array; all nonempty
                // and mismatched fallbacks keep ordinary checking.
                value
                    .nullable_inner()
                    .filter(|inner| matches!(inner, ResolvedType::Array { .. }))
                    .cloned()
            }
            "in" if matches!(
                *value,
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
        work.push(BinaryWork::Second(
            current,
            narrow,
            std::mem::replace(value, ResolvedType::Error),
            reverse,
        ));
        work.push(BinaryWork::Eval(second, expect, right_narrow));
    }

    fn binary_step_second(
        &mut self,
        local: &Ctx<'_, '_>,
        current: &SyntaxNode,
        parts: &[&SyntaxNode],
        op: &str,
        left: ResolvedType,
        right: ResolvedType,
    ) -> ResolvedType {
        match op {
            "and" | "or" => self.binary_logical(local, parts, left, right),
            "??" => self.type_coalesce(local, current, left, right),
            "in" => self.type_in(local, current, parts[0], &left, parts[2], &right),
            "==" | "!=" => {
                let (left, right) =
                    self.claim_comparison_sides(local, parts[0], left, parts[2], right);
                self.type_equality(local, current, op, &left, &right)
            }
            "<" | "<=" | ">" | ">=" => self.type_ordering(local, current, op, &left, &right),
            "+" | "-" | "*" | "/" | "%" => self.type_arithmetic(local, current, op, &left, &right),
            _ => ResolvedType::Error,
        }
    }

    fn binary_logical(
        &mut self,
        local: &Ctx<'_, '_>,
        parts: &[&SyntaxNode],
        left: ResolvedType,
        right: ResolvedType,
    ) -> ResolvedType {
        self.expect_bool(
            local,
            tight_span(local.text, parts[2]),
            &right,
            "`and`/`or` operand",
        );
        if left.is_error() || right.is_error() {
            ResolvedType::Error
        } else if matches!(left, ResolvedType::Opaque(_) | ResolvedType::Unknown)
            || matches!(right, ResolvedType::Opaque(_) | ResolvedType::Unknown)
        {
            ResolvedType::Opaque("logical operand")
        } else {
            ResolvedType::Scalar(Scalar::Bool)
        }
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
        if let Some(claimed) = self.claim_callback_literal(cx, left_node, &right) {
            return (claimed, right);
        }
        if let Some(claimed) = self.claim_callback_literal(cx, right_node, &left) {
            return (left, claimed);
        }
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

    /// Contract callback literals include hyphens/spaces and therefore use
    /// quoted text in source. Claim only exact literals in the closed domain.
    fn claim_callback_literal(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expected: &ResolvedType,
    ) -> Option<ResolvedType> {
        let ResolvedType::Enum { cases, owner: None } = expected else {
            return None;
        };
        let callback_domain = cases == &["complete", "unsupported"]
            || cases == &["complete"]
            || cases == &["unsupported"]
            || cases == &["require-false"]
            || cases == &["handler requirement rejected the occurrence"]
            || cases
                == &[
                    "store-profile",
                    "bound-exceeded",
                    "origin-correspondence",
                    "occurrence-correspondence",
                ];
        if !callback_domain || node.kind != SyntaxKind::Literal {
            return None;
        }
        let literal = cx.text[node.span.start as usize..node.span.end as usize].trim();
        let quoted = literal
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))?;
        if !cases.iter().any(|case| case == quoted) {
            return None;
        }
        self.record(node, expected.clone());
        Some(expected.clone())
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
            (
                ResolvedType::StdNominal {
                    name: a,
                    fields: af,
                },
                ResolvedType::StdNominal {
                    name: b,
                    fields: bf,
                },
            ) => a == b && af == bf,
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
        match (left, right) {
            (ResolvedType::Scalar(Scalar::Int), ResolvedType::Scalar(Scalar::Int)) => {
                Self::arith_ints(op)
            }
            (ResolvedType::Scalar(a), ResolvedType::Scalar(b))
                if matches!(
                    (a, b),
                    (Scalar::Int, Scalar::Decimal)
                        | (Scalar::Decimal, Scalar::Int)
                        | (Scalar::Decimal, Scalar::Decimal)
                ) =>
            {
                Self::arith_decimals(op)
            }
            (ResolvedType::Scalar(Scalar::Money), ResolvedType::Scalar(Scalar::Money)) => {
                Self::arith_money_pair(op)
            }
            (
                ResolvedType::Scalar(Scalar::Money),
                ResolvedType::Scalar(Scalar::Int | Scalar::Decimal),
            ) => Self::arith_money_scaled(op),
            (
                ResolvedType::Scalar(Scalar::Int | Scalar::Decimal),
                ResolvedType::Scalar(Scalar::Money),
            ) => Self::arith_scaled_money(op),
            (ResolvedType::Scalar(left), ResolvedType::Scalar(right))
                if matches!(left, Scalar::Duration | Scalar::Datetime | Scalar::Int)
                    && matches!(right, Scalar::Duration | Scalar::Datetime | Scalar::Int) =>
            {
                Self::arith_temporal(op, left, right)
            }
            (ResolvedType::Array { element: a, .. }, ResolvedType::Array { element: b, .. })
                if op == "+" =>
            {
                Self::arith_concat(a, b)
            }
            _ => None,
        }
    }

    fn arith_ints(op: &str) -> Option<ResolvedType> {
        match op {
            "+" | "-" | "*" | "%" => Some(ResolvedType::Scalar(Scalar::Int)),
            "/" => Some(ResolvedType::Scalar(Scalar::Decimal)),
            _ => None,
        }
    }

    fn arith_decimals(op: &str) -> Option<ResolvedType> {
        match op {
            "+" | "-" | "*" | "/" => Some(ResolvedType::Scalar(Scalar::Decimal)),
            _ => None,
        }
    }

    fn arith_money_pair(op: &str) -> Option<ResolvedType> {
        match op {
            "+" | "-" => Some(ResolvedType::Scalar(Scalar::Money)),
            "/" => Some(ResolvedType::Scalar(Scalar::Decimal)),
            _ => None,
        }
    }

    fn arith_money_scaled(op: &str) -> Option<ResolvedType> {
        match op {
            "*" | "/" => Some(ResolvedType::Scalar(Scalar::Money)),
            _ => None,
        }
    }

    fn arith_scaled_money(op: &str) -> Option<ResolvedType> {
        match op {
            "*" => Some(ResolvedType::Scalar(Scalar::Money)),
            _ => None,
        }
    }

    fn arith_temporal(op: &str, left: &Scalar, right: &Scalar) -> Option<ResolvedType> {
        match (left, right) {
            (Scalar::Duration, Scalar::Duration) => match op {
                "+" | "-" | "%" => Some(ResolvedType::Scalar(Scalar::Duration)),
                "/" => Some(ResolvedType::Scalar(Scalar::Decimal)),
                _ => None,
            },
            (Scalar::Duration, Scalar::Int) => match op {
                "*" | "/" => Some(ResolvedType::Scalar(Scalar::Duration)),
                _ => None,
            },
            (Scalar::Int, Scalar::Duration) => match op {
                "*" => Some(ResolvedType::Scalar(Scalar::Duration)),
                _ => None,
            },
            (Scalar::Datetime, Scalar::Duration) => match op {
                "+" | "-" => Some(ResolvedType::Scalar(Scalar::Datetime)),
                _ => None,
            },
            (Scalar::Duration, Scalar::Datetime) => match op {
                "+" => Some(ResolvedType::Scalar(Scalar::Datetime)),
                _ => None,
            },
            (Scalar::Datetime, Scalar::Datetime) => match op {
                "-" => Some(ResolvedType::Scalar(Scalar::Duration)),
                _ => None,
            },
            _ => None,
        }
    }

    fn arith_concat(a: &ResolvedType, b: &ResolvedType) -> Option<ResolvedType> {
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
                        self.narrow_callback_outcome(
                            &local,
                            parts[0],
                            parts[2],
                            op == "==",
                            polarity,
                            &mut value,
                        );
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

    fn narrow_callback_outcome(
        &mut self,
        cx: &Ctx<'_, '_>,
        left: &SyntaxNode,
        right: &SyntaxNode,
        is_eq: bool,
        else_branch: bool,
        env: &mut NarrowEnv,
    ) {
        for (member, literal) in [(left, right), (right, left)] {
            let member = unwrap_groups(member);
            let parts = kids(member);
            if member.kind != SyntaxKind::Member
                || parts.len() != 3
                || name_text(parts[2], cx.text) != Some("outcome")
            {
                continue;
            }
            let receiver = parts[0];
            let ty = self
                .narrowed_chain(cx, receiver)
                .or_else(|| self.types.node_types.get(&NodeKey::of(receiver)).cloned());
            let Some(ty) = ty else {
                continue;
            };
            let nullable = matches!(ty, ResolvedType::Nullable(_));
            if ty.nullable_inner().unwrap_or(&ty) != &callback_diagnostic_result(None) {
                continue;
            }
            let literal = unwrap_groups(literal);
            let spelling = if literal.kind == SyntaxKind::Literal {
                cx.text[literal.span.start as usize..literal.span.end as usize]
                    .trim()
                    .strip_prefix('"')
                    .and_then(|value| value.strip_suffix('"'))
            } else if self.types.resolved_cases.contains(&NodeKey::of(literal))
                && self.is_case_candidate(literal)
            {
                kids(literal)
                    .into_iter()
                    .find_map(|node| name_text(node, cx.text))
            } else {
                None
            };
            let Some(case @ ("complete" | "unsupported")) = spelling else {
                continue;
            };
            let equal = is_eq != else_branch;
            if nullable && !equal {
                continue;
            }
            let arm = if equal {
                case
            } else if case == "complete" {
                "unsupported"
            } else {
                "complete"
            };
            let Some(key) = self.narrow_key_for(cx, receiver) else {
                continue;
            };
            if matches!(key.decl, DeclKey::Unresolved(_)) {
                continue;
            }
            env.insert(key, callback_diagnostic_result(Some(arm)));
        }
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
            self.type_object_entry(cx, entry, expect, check_entries, &mut fields, &mut bad);
        }
        if bad {
            // Entries keep their recorded types; the object itself is
            // still usable for member lookup of its good fields.
        }
        self.check_std_nominal_object(cx, node, expect, &fields, bad, check_entries)
    }

    fn type_object_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        entry: &SyntaxNode,
        expect: Option<&ResolvedType>,
        check_entries: bool,
        fields: &mut Vec<(String, ResolvedType)>,
        bad: &mut bool,
    ) {
        if has_error(entry) {
            *bad = true;
            return;
        }
        let entry_parts = kids(entry);
        let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
            return;
        };
        let Some(key) = name_text(name_node, cx.text) else {
            return;
        };
        let value_node = entry_parts.iter().find(|n| is_expression(n.kind)).copied();
        let entry_expect = match expect.map(|ty| ty.nullable_inner().unwrap_or(ty)) {
            Some(ResolvedType::Object(exp) | ResolvedType::StdNominal { fields: exp, .. }) => {
                exp.iter().find(|(k, _)| k == key).map(|(_, t)| t.clone())
            }
            _ => None,
        };
        let value_ty = match value_node {
            Some(value) => self.expr(cx, value, entry_expect.clone()),
            None => self.type_shorthand(cx, entry, name_node, key, entry_expect.clone()),
        };
        if value_ty.is_error() {
            *bad = true;
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

    fn check_std_nominal_object(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        expect: Option<&ResolvedType>,
        fields: &[(String, ResolvedType)],
        bad: bool,
        check_entries: bool,
    ) -> ResolvedType {
        if let Some(ResolvedType::StdNominal {
            name,
            fields: declared,
        }) = expect.map(|ty| ty.nullable_inner().unwrap_or(ty))
        {
            let closed = fields.iter().all(|(key, actual)| {
                declared
                    .iter()
                    .find(|(field, _)| field == key)
                    .is_some_and(|(_, expected)| self.types_compatible(actual, expected))
            });
            let complete = declared.iter().all(|(key, ty)| {
                fields.iter().any(|(field, _)| field == key)
                    || matches!(ty, ResolvedType::Nullable(_) | ResolvedType::Array { .. })
            });
            if check_entries && cx.strict {
                for (key, key_node, _) in object_entries(node, cx.text) {
                    if !declared.iter().any(|(field, _)| field == key) {
                        self.member_fail(
                            key_node,
                            key_node.span,
                            (*name).to_string(),
                            key.to_string(),
                        );
                    }
                }
                for (key, ty) in declared {
                    if !fields.iter().any(|(field, _)| field == key)
                        && !matches!(ty, ResolvedType::Nullable(_) | ResolvedType::Array { .. })
                    {
                        self.diags.push(Diagnostic::error(
                            "E3001",
                            format!("missing required field '{key}' of {name}"),
                            tight_span(cx.text, node),
                        ));
                    }
                }
            }
            if !bad && closed && complete {
                return ResolvedType::StdNominal {
                    name,
                    fields: declared.clone(),
                };
            }
        }
        ResolvedType::Object(fields.to_vec())
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
    /// event fields. Message values use ordinary calls or static references,
    /// never object-style construction. Unknown entries are
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
            Some(TypeRef::Symbol(id)) => {
                let Some(record) = self.construct_symbol_type(cx, head, id) else {
                    return ResolvedType::Error;
                };
                record
            }
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
                        "cannot construct a field path; name a model, contract or event"
                            .to_string(),
                        tight_span(cx.text, head),
                    ));
                }
                return ResolvedType::Error;
            }
            Some(TypeRef::External) => {
                return self.type_external_construct(cx, node, head, object);
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

    /// Record type of a construct head symbol, or `None` with the
    /// `E3008` diagnostic recorded (message/foreign heads never build).
    fn construct_symbol_type(
        &mut self,
        cx: &Ctx<'_, '_>,
        head: &SyntaxNode,
        id: SymbolId,
    ) -> Option<ResolvedType> {
        match &self.tables.symbols[id.0 as usize].kind {
            SymbolKind::Model { .. } | SymbolKind::Contract { .. } | SymbolKind::Event { .. } => {
                Some(ResolvedType::Record {
                    symbol: id,
                    stored: false,
                })
            }
            SymbolKind::Message { params } => {
                if cx.strict {
                    let guidance = if params.is_empty() {
                        "reference a zero-parameter message directly"
                    } else {
                        "use an ordinary call to bind its parameters"
                    };
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        format!(
                            "cannot construct message '{}' with an object; {guidance}",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, head),
                    ));
                }
                None
            }
            _ => {
                if cx.strict {
                    self.diags.push(Diagnostic::error(
                        "E3008",
                        format!(
                            "cannot construct '{}'; only models, contracts and events construct",
                            record_name(self.tables, cx.module, id)
                        ),
                        tight_span(cx.text, head),
                    ));
                }
                None
            }
        }
    }

    /// Externally-owned construct head: a consumed std schema object,
    /// or the opaque external path.
    fn type_external_construct(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        head: &SyntaxNode,
        object: Option<&SyntaxNode>,
    ) -> ResolvedType {
        // The imported owner name, rather than the source alias,
        // selects a consumed std schema. Other providers and
        // nominal names without a schema retain the opaque path.
        let schema = name_or_ref_word(head, cx.text)
            .and_then(|name| {
                self.tables.module_scopes[cx.module.0 as usize]
                    .prod
                    .get(name)
            })
            .and_then(|binding| match binding {
                ScopedName::External { provider, name }
                    if provider == "std" && name != "WorkflowField" =>
                {
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
                self.check_std_schema_entries(cx, node, object, schema);
            }
        }
        expected
    }

    fn check_std_schema_entries(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        object: &SyntaxNode,
        schema: &StdNominal,
    ) {
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
            self.check_record_entry(cx, entry, &fields, symbol, strict_entries, &mut seen);
        }
        if strict_entries {
            self.check_missing_required_fields(cx, node, &fields, symbol, &seen);
        }
    }

    fn check_record_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        entry: &SyntaxNode,
        fields: &[SymbolId],
        symbol: SymbolId,
        strict_entries: bool,
        seen: &mut HashSet<String>,
    ) {
        if has_error(entry) {
            return;
        }
        let entry_parts = kids(entry);
        let Some(name_node) = entry_parts.first().filter(|n| n.kind == SyntaxKind::Name) else {
            return;
        };
        let Some(key) = name_text(name_node, cx.text) else {
            return;
        };
        seen.insert(key.to_string());
        let field = fields
            .iter()
            .find_map(|f| (self.tables.symbols[f.0 as usize].name == key).then_some(*f));
        let Some(field) = field else {
            self.check_unknown_record_entry(cx, entry, &entry_parts, name_node, key, symbol);
            return;
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

    fn check_unknown_record_entry(
        &mut self,
        cx: &Ctx<'_, '_>,
        entry: &SyntaxNode,
        entry_parts: &[&SyntaxNode],
        name_node: &SyntaxNode,
        key: &str,
        symbol: SymbolId,
    ) {
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
    }

    fn check_missing_required_fields(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        fields: &[SymbolId],
        symbol: SymbolId,
        seen: &HashSet<String>,
    ) {
        for field in fields {
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

    /// Attach only a complete direct-row projection after ordinary typing has
    /// established constructor ownership and every expression's lexical binding.
    fn checked_query_projection(
        &self,
        cx: &Ctx<'_, '_>,
        expression: &SyntaxNode,
        alias: NodeKey,
    ) -> Option<CheckedQueryProjection> {
        let (contract, model, expression, declared_fields, model_fields, entries) =
            self.query_projection_shape(cx.text, expression, alias)?;
        let mut seen = HashSet::new();
        let mut fields = Vec::new();
        for (name, key, value) in entries {
            fields.push(self.query_projection_field(
                cx,
                alias,
                model,
                contract,
                declared_fields,
                model_fields,
                &mut seen,
                name,
                key,
                value,
            )?);
        }
        Some(CheckedQueryProjection {
            node: NodeKey::of(expression),
            contract,
            model,
            alias,
            fields,
        })
    }

    /// Resolve the contract/model shape behind a query projection: the
    /// alias must be a stored model row and the expression a construct
    /// of the contract with exactly its declared entries.
    fn query_projection_shape<'n, 's>(
        &'s self,
        text: &'n str,
        expression: &'n SyntaxNode,
        alias: NodeKey,
    ) -> Option<(
        SymbolId,
        SymbolId,
        &'n SyntaxNode,
        &'s [SymbolId],
        &'s [SymbolId],
        Vec<(&'n str, &'n SyntaxNode, Option<&'n SyntaxNode>)>,
    )> {
        fn grouped(mut node: &SyntaxNode) -> Option<&SyntaxNode> {
            for _ in 0..64 {
                if node.kind != SyntaxKind::Group {
                    return Some(node);
                }
                node = kids(node)
                    .into_iter()
                    .find(|node| is_expression(node.kind))?;
            }
            None
        }
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = self.aliases.get(&alias)?
        else {
            return None;
        };
        let model_symbol = self.tables.symbols.get(model.0 as usize)?;
        if !matches!(model_symbol.kind, SymbolKind::Model { .. }) {
            return None;
        }
        let expression = grouped(expression)?;
        if expression.kind != SyntaxKind::Construct {
            return None;
        }
        let parts = kids(expression);
        let head = parts
            .iter()
            .find(|node| is_expression(node.kind))
            .copied()?;
        let TypeRef::Symbol(contract) = self.tables.node_typeref.get(&NodeKey::of(head))? else {
            return None;
        };
        let declaration = self.tables.symbols.get(contract.0 as usize)?;
        let SymbolKind::Contract {
            fields: declared_fields,
        } = &declaration.kind
        else {
            return None;
        };
        if self.types.node_types.get(&NodeKey::of(expression))
            != Some(&ResolvedType::Record {
                symbol: *contract,
                stored: false,
            })
        {
            return None;
        }
        let object = parts
            .iter()
            .find(|node| node.kind == SyntaxKind::Object)
            .copied()?;
        let entries = object_entries(object, text);
        if entries.len() != declared_fields.len() || entries.len() > 200 {
            return None;
        }
        Some((
            *contract,
            *model,
            expression,
            declared_fields,
            model_symbol.fields_of(),
            entries,
        ))
    }

    /// Check one query-projection entry against the contract's declared
    /// fields: stored-row references, `version` or direct scalar fields.
    #[allow(clippy::too_many_arguments)]
    fn query_projection_field(
        &self,
        cx: &Ctx<'_, '_>,
        alias: NodeKey,
        model: SymbolId,
        contract: SymbolId,
        declared_fields: &[SymbolId],
        model_fields: &[SymbolId],
        seen: &mut HashSet<SymbolId>,
        name: &str,
        key: &SyntaxNode,
        value: Option<&SyntaxNode>,
    ) -> Option<CheckedQueryProjectionField> {
        fn grouped(mut node: &SyntaxNode) -> Option<&SyntaxNode> {
            for _ in 0..64 {
                if node.kind != SyntaxKind::Group {
                    return Some(node);
                }
                node = kids(node)
                    .into_iter()
                    .find(|node| is_expression(node.kind))?;
            }
            None
        }
        fn scalar_field(mut ty: &ResolvedType) -> bool {
            for _ in 0..64 {
                match ty {
                    ResolvedType::Nullable(inner) => ty = inner,
                    ResolvedType::Scalar(_) | ResolvedType::Enum { .. } => return true,
                    _ => return false,
                }
            }
            false
        }
        let is_row = |node: &SyntaxNode| {
            matches!(self.tables.node_binding.get(&NodeKey::of(node)), Some(Binding::QueryAlias {node: bound}) if *bound == alias)
                && self.types.node_types.get(&NodeKey::of(node))
                    == Some(&ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    })
        };
        let field = *declared_fields.iter().find(|field| {
            self.tables
                .symbols
                .get(field.0 as usize)
                .is_some_and(|symbol| symbol.name == name)
        })?;
        if !seen.insert(field) {
            return None;
        }
        let field_symbol = self.tables.symbols.get(field.0 as usize)?;
        if !matches!(field_symbol.kind, SymbolKind::Field {owner,..} if owner == contract) {
            return None;
        }
        let original = value.unwrap_or(key);
        let node = grouped(original)?;
        let ty = self.types.node_types.get(&NodeKey::of(original))?.clone();
        let mapping = if is_row(node) {
            CheckedQueryProjectionMapping::StoredReference
        } else {
            if node.kind != SyntaxKind::Member {
                return None;
            }
            let parts = kids(node);
            if parts.len() != 3 || !is_punct(parts[1], cx.text, ".") || !is_row(grouped(parts[0])?)
            {
                return None;
            }
            let name = name_text(parts[2], cx.text)?;
            if name == "version" {
                if ty != ResolvedType::Scalar(Scalar::Int) {
                    return None;
                }
                CheckedQueryProjectionMapping::Version
            } else {
                let source = *model_fields.iter().find(|field| {
                    self.tables
                        .symbols
                        .get(field.0 as usize)
                        .is_some_and(|symbol| symbol.name == name)
                })?;
                if !matches!(self.tables.symbols.get(source.0 as usize)?.kind, SymbolKind::Field {owner,..} if owner == model)
                    || !scalar_field(&ty)
                {
                    return None;
                }
                CheckedQueryProjectionMapping::DirectField { field: source }
            }
        };
        Some(CheckedQueryProjectionField {
            field,
            node: NodeKey::of(original),
            ty,
            mapping,
        })
    }

    /// Rebind `cx` onto a clause environment: clause expressions see
    /// the accumulated `where` facts.
    fn clause_cx<'b, 'n>(cx: &Ctx<'b, 'n>, clause_env: &'n NarrowEnv) -> Ctx<'b, 'n> {
        Ctx {
            module: cx.module,
            file: cx.file,
            text: cx.text,
            narrow: clause_env,
            strict: cx.strict,
            server_default: cx.server_default,
        }
    }

    /// Resolve a `NameRef` query domain: a bare bound model is its
    /// ordered record collection, otherwise the base type rules apply.
    /// `Err` carries the early-exit type.
    fn query_nameref_domain(
        &mut self,
        cx: &Ctx<'_, '_>,
        base: &SyntaxNode,
    ) -> Result<ResolvedType, ResolvedType> {
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
                Ok(ty)
            }
            Some(Binding::Error) => Err(ResolvedType::Error),
            _ => {
                let base_ty = self.expr(cx, base, None);
                self.query_base_element(cx, base, base_ty)
            }
        }
    }

    /// Resolve a non-model query domain to its element: collections
    /// unwrap, poison passes through, anything else is `E3006`.
    /// `Err` carries the early-exit type.
    fn query_base_element(
        &mut self,
        cx: &Ctx<'_, '_>,
        base: &SyntaxNode,
        base_ty: ResolvedType,
    ) -> Result<ResolvedType, ResolvedType> {
        match base_ty {
            ResolvedType::Array { element, .. } => Ok((*element).clone()),
            ResolvedType::Error | ResolvedType::Opaque(_) | ResolvedType::Unknown => Err(base_ty),
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
                Err(ResolvedType::Error)
            }
        }
    }

    /// Check one `where` clause: every value must be boolean, and its
    /// true-facts narrow the row for the following clauses.
    fn check_where_clause(
        &mut self,
        cx: &Ctx<'_, '_>,
        part: &SyntaxNode,
        clause_env: &mut NarrowEnv,
    ) {
        for value in kids(part) {
            if is_expression(value.kind) {
                let ty = {
                    let clause_cx = Self::clause_cx(cx, clause_env);
                    self.expr(&clause_cx, value, None)
                };
                self.expect_bool(cx, tight_span(cx.text, value), &ty, "`where` clause");
                // Collect after typing: narrowing reads
                // the recorded types of the tested paths.
                let mut fresh = NarrowEnv::new();
                {
                    let clause_cx = Self::clause_cx(cx, clause_env);
                    self.collect_narrow(&clause_cx, value, false, &mut fresh);
                }
                clause_env.extend(fresh);
            }
        }
    }

    /// Check one `order` clause: leading `-` selects descending order,
    /// keys must be ordered scalars.
    fn check_order_clause(&mut self, cx: &Ctx<'_, '_>, part: &SyntaxNode, clause_env: &NarrowEnv) {
        let clause_cx = Self::clause_cx(cx, clause_env);
        for value in kids(part) {
            if is_expression(value.kind) {
                // In an order clause, leading '-' selects descending
                // order; it does not negate the checked scalar key.
                let key = if value.kind == SyntaxKind::Unary
                    && kids(value).iter().any(|part| is_punct(part, cx.text, "-"))
                {
                    kids(value)
                        .into_iter()
                        .find(|part| is_expression(part.kind))
                        .unwrap_or(value)
                } else {
                    value
                };
                let ty = self.expr(&clause_cx, key, None);
                if !std::ptr::eq(key, value) {
                    self.types.node_types.insert(NodeKey::of(value), ty.clone());
                }
                self.check_order_key(&clause_cx, value, &ty);
            }
        }
    }

    /// Check one `select` clause: the first value may project through
    /// the row alias; every non-error value rebinds the element.
    #[allow(clippy::too_many_arguments)]
    fn check_select_clause(
        &mut self,
        cx: &Ctx<'_, '_>,
        part: &SyntaxNode,
        clause_env: &NarrowEnv,
        projection_alias: Option<NodeKey>,
        select_count: &mut usize,
        projection: &mut Option<Box<CheckedQueryProjection>>,
        projected: &mut Option<ResolvedType>,
        element: &mut ResolvedType,
    ) {
        let clause_cx = Self::clause_cx(cx, clause_env);
        for value in kids(part) {
            if is_expression(value.kind) {
                let ty = self.expr(&clause_cx, value, None);
                *select_count += 1;
                *projection = if *select_count == 1 {
                    projection_alias.and_then(|alias| {
                        self.checked_query_projection(&clause_cx, value, alias)
                            .map(Box::new)
                    })
                } else {
                    None
                };
                if !ty.is_error() {
                    *projected = Some(ty);
                    *element = projected.clone().unwrap_or(ResolvedType::Error);
                }
            }
        }
    }

    /// Whether a query is fully resolved: domain and result contain no
    /// poison, every clause expression is typed, and no new error was
    /// recorded while checking the query.
    fn query_fully_resolved(
        &self,
        base_ty: &ResolvedType,
        result: &ResolvedType,
        checked_clauses: &[CheckedQueryClause],
        diagnostic_start: usize,
    ) -> bool {
        base_ty.is_resolved_shape()
            && result.is_resolved_shape()
            && checked_clauses.iter().all(|clause| {
                clause.expressions.iter().all(|expression| {
                    self.types
                        .node_types
                        .get(expression)
                        .is_some_and(ResolvedType::is_resolved_shape)
                })
            })
            && !self.diags[diagnostic_start..]
                .iter()
                .any(|diag| diag.severity == crate::diagnostic::Severity::Error)
    }

    /// Type a model/collection query and its authored clause scopes. The
    /// projected element feeds both the result and optional source attribution.
    fn type_query(&mut self, cx: &Ctx<'_, '_>, node: &SyntaxNode) -> ResolvedType {
        let query_key = NodeKey::of(node);
        self.types.checked_queries.remove(&query_key);
        let diagnostic_start = self.diags.len();
        let parts = kids(node);
        let base = parts.iter().find(|n| is_expression(n.kind)).copied();
        let Some(base) = base else {
            return ResolvedType::Error;
        };
        // A bare model domain is its ordered record collection.
        // Helpers return `Err` for the early-exit type.
        let mut element = match base.kind {
            SyntaxKind::NameRef => match self.query_nameref_domain(cx, base) {
                Ok(element) => element,
                Err(early) => return early,
            },
            _ => {
                let base_ty = self.expr(cx, base, None);
                match self.query_base_element(cx, base, base_ty) {
                    Ok(element) => element,
                    Err(early) => return early,
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
        let mut checked_clauses = Vec::new();
        let mut projection = None;
        let mut projection_alias = None;
        let mut select_count = 0usize;
        let mut complete_clauses = !has_error(node);
        for part in parts {
            if part.kind != SyntaxKind::QueryClause || has_error(part) {
                continue;
            }
            let head = kids(part)
                .iter()
                .find_map(|n| name_text(n, cx.text))
                .unwrap_or("");
            if let Some(clause) = CheckedQueryClause::from_source(part, cx.text, is_expression) {
                checked_clauses.push(clause);
            } else {
                complete_clauses = false;
            }
            match head {
                "as" => {
                    self.aliases.insert(NodeKey::of(part), element.clone());
                    projection_alias = Some(NodeKey::of(part));
                }
                "archived" => {}
                "where" => self.check_where_clause(cx, part, &mut clause_env),
                "order" => self.check_order_clause(cx, part, &clause_env),
                "select" => self.check_select_clause(
                    cx,
                    part,
                    &clause_env,
                    projection_alias,
                    &mut select_count,
                    &mut projection,
                    &mut projected,
                    &mut element,
                ),
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
        if complete_clauses
            && self.query_fully_resolved(&base_ty, &result, &checked_clauses, diagnostic_start)
        {
            self.types.checked_queries.insert(
                query_key,
                CheckedQuery {
                    node: query_key,
                    domain: NodeKey::of(base),
                    domain_type: base_ty,
                    result: result.clone(),
                    clauses: checked_clauses,
                    projection,
                },
            );
        }
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
        self.types
            .checked_collection_calls
            .remove(&NodeKey::of(node));
        self.types
            .checked_contract_collection_calls
            .remove(&NodeKey::of(node));
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
        if let Some(descriptor) = message_descriptor_node(callee) {
            return self.call_anonymous_message(cx, node, descriptor, &args);
        }
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
                    return self.callee_name_ref_kind(cx, current);
                }
                SyntaxKind::Member => {
                    // `Mail.send(…)` in an expression: operations are
                    // still invoked with `call` statements.
                    return self.callee_member_kind(cx, current);
                }
                _ => {
                    return self.callee_value_kind(cx, current);
                }
            }
        }
    }

    fn callee_name_ref_kind(&mut self, cx: &Ctx<'_, '_>, current: &SyntaxNode) -> CalleeKind {
        let key = NodeKey::of(current);
        let name = kids(current)
            .iter()
            .find_map(|n| name_text(n, cx.text))
            .unwrap_or("?");
        match self.tables.node_binding.get(&key).cloned() {
            None => CalleeKind::Error,
            Some(Binding::Error) => CalleeKind::Error,
            Some(Binding::External { .. }) => CalleeKind::Opaque,
            Some(Binding::Builtin { id }) => CalleeKind::Builtin(id),
            Some(Binding::Symbol(id)) => self.callee_symbol_kind(cx, id, name),
            _ => CalleeKind::NotCallable(format!("'{name}' is not callable")),
        }
    }

    fn callee_symbol_kind(&mut self, cx: &Ctx<'_, '_>, id: SymbolId, name: &str) -> CalleeKind {
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

    fn callee_member_kind(&mut self, cx: &Ctx<'_, '_>, current: &SyntaxNode) -> CalleeKind {
        let ty = self.expr(cx, current, None);
        match ty {
            ResolvedType::Operation(id)
                if self.tables.judgment_generated_symbols.contains(&id)
                    && matches!(
                        self.tables.symbols[id.0 as usize].kind,
                        SymbolKind::DeriveFn { .. }
                    ) =>
            {
                CalleeKind::DeriveFn(id)
            }
            ResolvedType::Operation(id) => CalleeKind::NotCallable(format!(
                "'{}' is an operation; invoke it with a `call` statement, not an expression call",
                record_name(self.tables, cx.module, id)
            )),
            ResolvedType::Error => CalleeKind::Error,
            ResolvedType::Opaque(_) | ResolvedType::Unknown => CalleeKind::Opaque,
            _ => CalleeKind::NotCallable("this value is not callable".to_string()),
        }
    }

    fn callee_value_kind(&mut self, cx: &Ctx<'_, '_>, current: &SyntaxNode) -> CalleeKind {
        let ty = self.expr(cx, current, None);
        match ty {
            ResolvedType::Error => CalleeKind::Error,
            ResolvedType::Opaque(_) | ResolvedType::Unknown => CalleeKind::Opaque,
            _ => CalleeKind::NotCallable("this value is not callable".to_string()),
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
        let diagnostic_start = self.diags.len();
        let catalog = match self.catalog {
            Some(catalog) => catalog,
            None => return ResolvedType::Error,
        };
        // Availability: planned builtins cannot compile (`E6001`,
        // even in light positions — a position-independent fact).
        if self.check_planned_builtin(cx, callee, catalog, id, args) {
            return ResolvedType::Error;
        }
        // Defensive only: the resolver already reports helper uses
        // as `E2006` and binds them `Error`, so a helper callee never
        // reaches this builtin path (N12).
        if self.check_helper_builtin(cx, callee, catalog, id, args) {
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
            // Best match wins: DESIGN §3 lists general overloads before
            // their `nonempty`/`ordered` twins, which would be dead under
            // first-match (every nonempty domain also inhabits the
            // general shape). Ties keep catalog order.
            let (best, literal_fail, cases_fail) =
                self.find_best_overload(cx, &overloads, args, &typed);
            if let Some((index, result, _, trial, slots)) = best {
                return self.record_best_builtin_call(
                    cx,
                    node,
                    id,
                    &overloads,
                    index,
                    result,
                    trial,
                    slots,
                    args,
                    &typed,
                    diagnostic_start,
                );
            }
            // Failure precedence: precise literal shape (`E3001`) >
            // precise case expectation (`E3005`) > generic mismatch
            // (`E3005`, suppressed when an unbound name explains it).
            self.report_overload_failure(cx, node, id, args, &typed, literal_fail, cases_fail);
        }
        ResolvedType::Error
    }

    fn check_planned_builtin(
        &mut self,
        cx: &Ctx<'_, '_>,
        callee: &SyntaxNode,
        catalog: &Catalog,
        id: &str,
        args: &[CallArg],
    ) -> bool {
        if catalog.availability(id) != Some(Availability::Planned) {
            return false;
        }
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
        true
    }

    fn check_helper_builtin(
        &mut self,
        cx: &Ctx<'_, '_>,
        callee: &SyntaxNode,
        catalog: &Catalog,
        id: &str,
        args: &[CallArg],
    ) -> bool {
        if !catalog.is_helper(id) {
            return false;
        }
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
        true
    }

    fn find_best_overload(
        &mut self,
        cx: &Ctx<'_, '_>,
        overloads: &[SigOverload],
        args: &[CallArg],
        typed: &[ResolvedType],
    ) -> (
        Option<(usize, ResolvedType, usize, Trial, Vec<usize>)>,
        Option<(Span, String)>,
        Option<(NodeKey, Span, Vec<String>)>,
    ) {
        let mut literal_fail: Option<(Span, String)> = None;
        let mut cases_fail: Option<(NodeKey, Span, Vec<String>)> = None;
        let mut best: Option<(usize, ResolvedType, usize, Trial, Vec<usize>)> = None;
        for (index, overload) in overloads.iter().enumerate() {
            let mut trial = Trial::default();
            if let Some((result, slots)) = self.try_overload(cx, overload, args, typed, &mut trial)
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
        (best, literal_fail, cases_fail)
    }

    fn record_best_builtin_call(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: &str,
        overloads: &[SigOverload],
        index: usize,
        result: ResolvedType,
        trial: Trial,
        slots: Vec<usize>,
        args: &[CallArg],
        typed: &[ResolvedType],
        diagnostic_start: usize,
    ) -> ResolvedType {
        for (key, ty) in &trial.literal_retypes {
            self.types.node_types.insert(*key, ty.clone());
        }
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
        let result = self.finish_builtin_call(
            cx,
            &overloads[index],
            id,
            &ordered_args,
            &ordered_types,
            result,
        );
        self.record_choose_leaves(node, id, &result, &ordered_args, diagnostic_start);
        if !result.is_error()
            && !self.diags[diagnostic_start..]
                .iter()
                .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
            && let Some(fact) = self.checked_collection_call(node, &overloads[index], &ordered_args)
        {
            self.types
                .checked_collection_calls
                .insert(NodeKey::of(node), fact);
        }
        if !result.is_error()
            && !self.diags[diagnostic_start..]
                .iter()
                .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
            && let Some(fact) =
                self.checked_contract_collection_call(cx, node, &overloads[index], &ordered_args)
        {
            self.types
                .checked_contract_collection_calls
                .insert(NodeKey::of(node), fact);
        }
        result
    }

    fn record_choose_leaves(
        &mut self,
        node: &SyntaxNode,
        id: &str,
        result: &ResolvedType,
        ordered_args: &[CallArg],
        diagnostic_start: usize,
    ) {
        if id == "choose"
            && *result == ResolvedType::InlineMessage
            && !self.diags[diagnostic_start..]
                .iter()
                .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
            && let [_, yes, no] = ordered_args
            && let Some(yes) = self.checked_message_descriptor_origin(yes.value)
            && let Some(no) = self.checked_message_descriptor_origin(no.value)
        {
            let mut leaves = Vec::new();
            for origin in [yes, no] {
                for leaf in self
                    .types
                    .anonymous_message_choices
                    .get(&origin)
                    .map(Vec::as_slice)
                    .unwrap_or(std::slice::from_ref(&origin))
                {
                    if !leaves.contains(leaf) {
                        leaves.push(*leaf);
                    }
                }
            }
            self.types
                .anonymous_message_choices
                .insert(NodeKey::of(node), leaves);
        }
    }

    fn report_overload_failure(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        id: &str,
        args: &[CallArg],
        typed: &[ResolvedType],
        literal_fail: Option<(Span, String)>,
        cases_fail: Option<(NodeKey, Span, Vec<String>)>,
    ) {
        if !cx.strict {
            return;
        }
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
            let actuals: Vec<String> = typed.iter().map(|t| self.show(cx.module, t)).collect();
            self.diags.push(Diagnostic::error(
                "E3005",
                format!("no overload of '{id}' matches ({})", actuals.join(", ")),
                tight_span(cx.text, node),
            ));
        }
    }

    fn checked_collection_call(
        &self,
        node: &SyntaxNode,
        overload: &SigOverload,
        ordered_args: &[CallArg],
    ) -> Option<CheckedCollectionCall> {
        let (id, index, has_predicate) =
            self.check_collection_call_shape(node, overload, ordered_args)?;
        let (query, element, model) = self.collection_call_model_query(node, ordered_args)?;
        // The resolver exports the first actual top-level As declaration to
        // later arguments. No spelling-based search through unrelated aliases.
        let alias = query
            .clauses
            .iter()
            .find(|clause| matches!(clause.kind, CheckedQueryClauseKind::As { .. }))?
            .node;
        if self.aliases.get(&alias) != Some(element)
            || self
                .types
                .node_types
                .get(&NodeKey::of(ordered_args[0].value))
                != Some(&query.result)
        {
            return None;
        }
        let predicate = if has_predicate {
            let argument = ordered_args.get(1)?;
            let key = NodeKey::of(argument.value);
            let ty = self.types.node_types.get(&key)?;
            if ty != &ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            Some(CheckedCollectionPredicate {
                node: key,
                ty: ty.clone(),
            })
        } else {
            None
        };
        Some(CheckedCollectionCall {
            node: NodeKey::of(node),
            builtin: id,
            overload: index,
            query: query.node,
            alias,
            model,
            predicate,
        })
    }

    /// Validate the target/arity/shape of an `any`/`all`/`count`/`first`
    /// builtin call: the builtin id, its overload index and whether a
    /// predicate argument is required.
    fn check_collection_call_shape(
        &self,
        node: &SyntaxNode,
        overload: &SigOverload,
        ordered_args: &[CallArg],
    ) -> Option<(String, usize, bool)> {
        let selected = self.types.selected_calls.get(&NodeKey::of(node))?;
        let SelectedCallTarget::Builtin {
            id,
            overload: index,
        } = &selected.target
        else {
            return None;
        };
        let has_predicate = matches!(id.as_str(), "any" | "all");
        if !has_predicate && !matches!(id.as_str(), "count" | "first") {
            return None;
        }
        if overload.params.len() != if has_predicate { 2 } else { 1 }
            || ordered_args.len() != overload.params.len()
            || selected.slots.len() != ordered_args.len()
        {
            return None;
        }
        let domain = overload.params.first()?;
        if domain.name != "domain"
            || !matches!(
                domain.ty,
                SigType::Collection(_)
                    | SigType::OrderedCollection(_)
                    | SigType::NonemptyCollection(_)
            )
        {
            return None;
        }
        if has_predicate {
            let predicate = overload.params.get(1)?;
            if predicate.name != "predicate"
                || predicate.ty != SigType::Named("bool".into())
                || domain.alias.is_none()
                || predicate.in_scope != domain.alias
            {
                return None;
            }
        }
        Some((id.clone(), *index, has_predicate))
    }

    /// Resolve the model query behind a collection builtin call: slots
    /// must line up with the arguments and the first argument must be a
    /// checked query over one stored model.
    fn collection_call_model_query(
        &self,
        node: &SyntaxNode,
        ordered_args: &[CallArg],
    ) -> Option<(&CheckedQuery, &ResolvedType, SymbolId)> {
        let selected = self.types.selected_calls.get(&NodeKey::of(node))?;
        for (slot, argument) in selected.slots.iter().zip(ordered_args) {
            if selected.arguments.get((*slot)?) != Some(&NodeKey::of(argument.value)) {
                return None;
            }
        }
        let mut query_node = ordered_args.first()?.value;
        let mut depth = 0usize;
        while query_node.kind == SyntaxKind::Group {
            depth += 1;
            if depth > 64 {
                return None;
            }
            query_node = kids(query_node)
                .into_iter()
                .find(|child| is_expression(child.kind))?;
        }
        if query_node.kind != SyntaxKind::Query {
            return None;
        }
        let query = self.types.checked_queries.get(&NodeKey::of(query_node))?;
        let ResolvedType::Array { element, .. } = &query.result else {
            return None;
        };
        let ResolvedType::Record {
            symbol: model,
            stored: true,
        } = element.as_ref()
        else {
            return None;
        };
        if !matches!(
            self.tables.symbols.get(model.0 as usize)?.kind,
            SymbolKind::Model { .. }
        ) {
            return None;
        }
        Some((query, element.as_ref(), *model))
    }

    fn checked_contract_collection_call(
        &self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        overload: &SigOverload,
        ordered_args: &[CallArg],
    ) -> Option<CheckedContractCollectionCall> {
        let (id, index, arguments, slots) =
            self.contract_call_shape(node, overload, ordered_args)?;
        let (query_node, query, alias, contract) = self.contract_call_query(ordered_args)?;
        let domain_node = ungroup(
            kids(query_node)
                .into_iter()
                .find(|child| is_expression(child.kind))?,
        )?;
        let call = self.contract_call_domain(cx, query, domain_node)?;
        let predicate = ordered_args[1].value;
        let boolean = ResolvedType::Scalar(Scalar::Bool);
        if self.types.node_types.get(&NodeKey::of(predicate)) != Some(&boolean) {
            return None;
        }
        // Direct scalar/ref leaves, literals and checked nested any/all cannot
        // suspend the Values callback. Disclosure joins their actual fields,
        // bindings, operators and retained child/stored provenance separately.
        if !self.contract_predicate_suspends(predicate, &boolean) {
            return None;
        }
        Some(CheckedContractCollectionCall {
            node: NodeKey::of(node),
            builtin: id,
            overload: index,
            arguments,
            slots,
            query: query.node,
            domain: query.domain,
            call,
            alias: alias.node,
            contract,
            predicate: CheckedCollectionPredicate {
                node: NodeKey::of(predicate),
                ty: boolean,
            },
        })
    }

    fn contract_call_shape(
        &self,
        node: &SyntaxNode,
        overload: &SigOverload,
        ordered_args: &[CallArg],
    ) -> Option<(String, usize, Vec<NodeKey>, [usize; 2])> {
        let selected = self.types.selected_calls.get(&NodeKey::of(node))?;
        let SelectedCallTarget::Builtin {
            id,
            overload: index,
        } = &selected.target
        else {
            return None;
        };
        if !matches!(id.as_str(), "any" | "all")
            || overload.params.len() != 2
            || ordered_args.len() != 2
            || selected.arguments.len() != 2
            || selected.slots.len() != 2
        {
            return None;
        }
        let domain_param = &overload.params[0];
        let predicate_param = &overload.params[1];
        if domain_param.name != "domain"
            || predicate_param.name != "predicate"
            || !matches!(
                domain_param.ty,
                SigType::Collection(_)
                    | SigType::OrderedCollection(_)
                    | SigType::NonemptyCollection(_)
            )
            || domain_param.alias.is_none()
            || predicate_param.in_scope != domain_param.alias
            || predicate_param.ty != SigType::Named("bool".into())
        {
            return None;
        }
        let slots = [selected.slots[0]?, selected.slots[1]?];
        if slots[0] == slots[1] {
            return None;
        }
        for (slot, argument) in slots.iter().zip(ordered_args) {
            if selected.arguments.get(*slot) != Some(&NodeKey::of(argument.value)) {
                return None;
            }
        }
        Some((id.clone(), *index, selected.arguments.clone(), slots))
    }

    fn contract_call_query<'n, 's>(
        &'s self,
        ordered_args: &[CallArg<'n>],
    ) -> Option<(
        &'n SyntaxNode,
        &'s CheckedQuery,
        &'s CheckedQueryClause,
        SymbolId,
    )> {
        let query_node = ungroup(ordered_args[0].value)?;
        if query_node.kind != SyntaxKind::Query {
            return None;
        }
        let query = self.types.checked_queries.get(&NodeKey::of(query_node))?;
        let [alias] = query.clauses.as_slice() else {
            return None;
        };
        if !matches!(alias.kind, CheckedQueryClauseKind::As { .. })
            || query.projection.is_some()
            || !alias.expressions.is_empty()
            || query.domain_type != query.result
            || self
                .types
                .node_types
                .get(&NodeKey::of(ordered_args[0].value))
                != Some(&query.result)
        {
            return None;
        }
        let ResolvedType::Array { element, .. } = &query.domain_type else {
            return None;
        };
        let ResolvedType::Record {
            symbol: contract, ..
        } = element.as_ref()
        else {
            return None;
        };
        if !matches!(
            self.tables.symbols.get(contract.0 as usize)?.kind,
            SymbolKind::Contract { .. }
        ) || self.aliases.get(&alias.node) != Some(element.as_ref())
        {
            return None;
        }
        Some((query_node, query, alias, *contract))
    }

    fn contract_call_domain(
        &self,
        cx: &Ctx<'_, '_>,
        query: &CheckedQuery,
        domain_node: &SyntaxNode,
    ) -> Option<Option<NodeKey>> {
        match domain_node.kind {
            SyntaxKind::NameRef => {
                let Binding::CallAs { node: call } =
                    self.tables.node_binding.get(&NodeKey::of(domain_node))?
                else {
                    return None;
                };
                if self
                    .types
                    .effect_call_results
                    .get(call)
                    .and_then(Option::as_ref)
                    != Some(&query.domain_type)
                {
                    return None;
                }
                Some(Some(*call))
            }
            SyntaxKind::Member => {
                let parts = kids(domain_node);
                if parts.len() != 3 || !is_punct(parts[1], cx.text, ".") {
                    return None;
                }
                let ResolvedType::Record { symbol: owner, .. } =
                    self.types.node_types.get(&NodeKey::of(parts[0]))?
                else {
                    return None;
                };
                let owner_symbol = self.tables.symbols.get(owner.0 as usize)?;
                let SymbolKind::Contract { fields } = &owner_symbol.kind else {
                    return None;
                };
                let name = name_text(parts[2], cx.text)?;
                let field = fields.iter().find(|field| {
                    self.tables
                        .symbols
                        .get(field.0 as usize)
                        .is_some_and(|symbol| symbol.name == name)
                })?;
                if !matches!(self.tables.symbols.get(field.0 as usize)?.kind,
                    SymbolKind::Field {owner: field_owner, ..} if field_owner == *owner)
                    || self.decl.get(field) != Some(&query.domain_type)
                    || self.types.node_types.get(&NodeKey::of(domain_node))
                        != Some(&query.domain_type)
                {
                    return None;
                }
                Some(None)
            }
            _ => None,
        }
    }

    fn contract_predicate_suspends(&self, predicate: &SyntaxNode, boolean: &ResolvedType) -> bool {
        let mut pending = vec![predicate];
        let mut visits = 0;
        while let Some(expression) = pending.pop() {
            visits += 1;
            if visits > 4096 {
                return false;
            }
            if expression.kind == SyntaxKind::Call {
                let key = NodeKey::of(expression);
                let Some(nested) = self.types.checked_contract_collection_calls.get(&key) else {
                    return false;
                };
                if nested.node != key
                    || !matches!(nested.builtin.as_str(), "any" | "all")
                    || nested.predicate.ty != *boolean
                    || self.types.node_types.get(&key) != Some(boolean)
                {
                    return false;
                }
                // The nested call was checked independently. Traverse only its
                // actual value domain and predicate, never arbitrary query syntax.
                let Some(nested_query) = self.types.checked_queries.get(&nested.query) else {
                    return false;
                };
                let Some(nested_domain_key) = nested.arguments.get(nested.slots[0]).copied() else {
                    return false;
                };
                let Some(nested_domain) = kids(expression).into_iter().find_map(|argument| {
                    kids(argument)
                        .into_iter()
                        .find(|value| NodeKey::of(value) == nested_domain_key)
                }) else {
                    return false;
                };
                let Some(nested_query_node) = ungroup(nested_domain) else {
                    return false;
                };
                if nested_query_node.kind != SyntaxKind::Query
                    || nested_query.node != NodeKey::of(nested_query_node)
                    || nested_query.domain != nested.domain
                {
                    return false;
                }
                let Some(domain) = kids(nested_query_node)
                    .into_iter()
                    .find(|value| NodeKey::of(value) == nested.domain)
                else {
                    return false;
                };
                pending.push(domain);
                let Some(predicate) = kids(expression).into_iter().find_map(|argument| {
                    kids(argument)
                        .into_iter()
                        .find(|value| NodeKey::of(value) == nested.predicate.node)
                }) else {
                    return false;
                };
                pending.push(predicate);
                continue;
            }
            if !matches!(
                expression.kind,
                SyntaxKind::NameRef
                    | SyntaxKind::Path
                    | SyntaxKind::Literal
                    | SyntaxKind::Member
                    | SyntaxKind::Group
                    | SyntaxKind::Unary
                    | SyntaxKind::Binary
            ) {
                return false;
            }
            pending.extend(
                expression
                    .children
                    .iter()
                    .filter(|child| is_expression(child.kind)),
            );
        }
        true
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
        // message value or a checked anonymous descriptor).
        let first_is_message = matches!(typed.first(), Some(ResolvedType::Message(_)))
            || (matches!(typed.first(), Some(ResolvedType::InlineMessage))
                && self.is_checked_message_descriptor(args[0].value));
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
        let before = self.diags.len();
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
        let mut valid_arguments = true;
        for (param, arg) in &bound {
            let expected = self.decl_type(*param);
            let actual = self.expr(cx, arg.value, Some(expected.clone()));
            if !actual.is_error() {
                valid_arguments &= self.assign_ok(
                    cx,
                    tight_span(cx.text, arg.value),
                    &actual,
                    &expected,
                    &format!("argument '{}'", self.tables.symbols[param.0 as usize].name),
                );
            } else {
                valid_arguments = false;
            }
        }
        if valid_arguments
            && self.diags.len() == before
            && let Some((owner, _)) = self
                .tables
                .judgment_declarations
                .iter()
                .find(|(_, judgment)| judgment.specification == Some(id))
            && let Some((_, argument)) = bound.first()
        {
            self.types.judgment_specification_calls.insert(
                NodeKey::of(node),
                CheckedJudgmentSpecificationCall {
                    judgment: *owner,
                    options: NodeKey::of(argument.value),
                },
            );
        }
        match self.results.get(&id).cloned() {
            Some(Some(ty)) => ty,
            Some(None) | None => ResolvedType::Opaque("unresolved function result"),
        }
    }

    /// Call a message: like a user function, rendering `text`.
    fn is_checked_message_descriptor(&self, node: &SyntaxNode) -> bool {
        self.checked_message_descriptor_origin(node).is_some()
    }

    fn checked_message_descriptor_origin(&self, node: &SyntaxNode) -> Option<NodeKey> {
        let mut current = node;
        while current.kind == SyntaxKind::Group {
            current = kids(current).into_iter().find(|n| is_expression(n.kind))?;
        }
        let key = NodeKey::of(current);
        if is_message_descriptor(current)
            || self.types.anonymous_messages.contains_key(&key)
            || self.types.anonymous_message_choices.contains_key(&key)
        {
            Some(key)
        } else {
            self.types.message_descriptor_references.get(&key).copied()
        }
    }

    fn call_anonymous_message(
        &mut self,
        cx: &Ctx<'_, '_>,
        node: &SyntaxNode,
        descriptor: &SyntaxNode,
        args: &[CallArg],
    ) -> ResolvedType {
        let before = self.diags.len();
        let mut slots = Vec::new();
        let mut patterns_valid = true;
        for literal in descriptor
            .descendants()
            .filter(|n| n.kind == SyntaxKind::Literal)
        {
            if let Some(template) = string_literal_value(literal) {
                match super::icu::parse(&template) {
                    Ok(usages) => {
                        for usage in usages {
                            push_slot(&mut slots, usage.name);
                        }
                    }
                    Err(_) => patterns_valid = false,
                }
            }
        }
        let mut names = Vec::new();
        let mut arguments = Vec::new();
        let mut valid = true;
        for arg in args {
            let ty = self.expr(cx, arg.value, None);
            let Some(name) = &arg.name else {
                self.diags.push(Diagnostic::error(
                    "E3005",
                    "anonymous messages require explicit named arguments".to_string(),
                    tight_span(cx.text, arg.node),
                ));
                valid = false;
                continue;
            };
            // A malformed pattern cannot establish that a supplied binding is
            // unused. Keep its admitted schema for E5007's typed checkpoints;
            // duplicate names and value admission remain unconditional.
            if names.contains(name) || (patterns_valid && !slots.contains(name)) {
                self.diags.push(Diagnostic::error(
                    "E3005",
                    format!(
                        "anonymous message argument '{name}' is duplicate or names no placeholder"
                    ),
                    tight_span(cx.text, arg.node),
                ));
                valid = false;
            }
            names.push(name.clone());
            if !super::examples::message_param_ok(&ty) {
                if !ty.is_error() {
                    self.diags.push(Diagnostic::error(
                        "E5009",
                        format!("message argument '{name}' must be a nonnullable display value"),
                        tight_span(cx.text, arg.value),
                    ));
                }
                valid = false;
            }
            arguments.push((name.clone(), NodeKey::of(arg.value), ty));
        }
        self.check_message_value(cx, descriptor, "anonymous message", Some(&names));
        if slots.iter().any(|slot| !names.contains(slot)) {
            valid = false;
        }
        if !valid || self.diags.len() != before {
            return ResolvedType::Error;
        }
        self.types.anonymous_messages.insert(
            NodeKey::of(node),
            CheckedAnonymousMessage {
                descriptor: NodeKey::of(descriptor),
                arguments,
            },
        );
        ResolvedType::InlineMessage
    }

    /// Call a named message, preserving its declared signature.
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
            ResolvedType::Nullable(inner)
                if matches!(inner.as_ref(), ResolvedType::Scalar(Scalar::User)) =>
            {
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
    /// bindings and contextual types are local; only the selected
    /// overload commits enum claims and validated literal re-types.
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
            SigType::Ordered => {
                self.match_scalar_class(actual, Scalar::is_ordered, SigVar::O, trial)
            }
            SigType::StringLike => {
                self.match_scalar_class(actual, Scalar::is_string_like, SigVar::S, trial)
            }
            SigType::GroupKey => self.match_guarded_shape(actual, group_key_ok, SigVar::K, trial),
            SigType::Display => self.match_guarded_shape(actual, display_ok, SigVar::D, trial),
            SigType::Named(name) => self.match_named(cx, arg, actual, name, trial),
            SigType::Collection(inner)
            | SigType::OrderedCollection(inner)
            | SigType::NonemptyCollection(inner)
            | SigType::Array(inner) => {
                self.match_collection_shape(cx, arg, actual, shape, inner, trial)
            }
            SigType::Nullable(inner) => self.match_nullable_shape(cx, arg, actual, inner, trial),
            SigType::Union(arms) => self.match_union_shape(cx, arg, actual, arms, trial),
            SigType::EnumCases(cases) => self.match_enum_claim(cx, arg, actual, cases, trial),
            SigType::Object(fields) => self.match_object_shape(cx, arg, actual, fields, trial),
            SigType::ClosedDisplayObject => self.match_display_object(actual),
            SigType::Message => self.match_message_shape(arg, actual),
            SigType::ActionTarget => self.match_action_target(cx, arg, actual, trial),
            SigType::ActionBindings => self.match_action_bindings(cx, arg, actual, trial),
            SigType::InvocationArgs => self.match_invocation_args(cx, arg, actual, trial),
            // Results-only shapes never appear as parameters.
            SigType::ActionResult | SigType::InvocationResult => false,
        }
    }

    /// Match a scalar class (`O`/`S`): scalars passing the predicate
    /// bind the class variable.
    fn match_scalar_class(
        &self,
        actual: &ResolvedType,
        ok: fn(Scalar) -> bool,
        var: SigVar,
        trial: &mut Trial,
    ) -> bool {
        match actual {
            ResolvedType::Scalar(s) if ok(*s) => self.bind_var(trial, var, actual),
            ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
            _ => false,
        }
    }

    /// Match a nullable shape: null inhabits, nullable unwraps,
    /// non-null values match the inner shape.
    fn match_nullable_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        inner: &SigType,
        trial: &mut Trial,
    ) -> bool {
        match actual {
            ResolvedType::Nullable(inner_actual) => {
                self.match_shape(cx, arg, inner_actual, inner, trial)
            }
            ResolvedType::Null => true,
            // Non-null values inhabit nullable shapes.
            _ => self.match_shape(cx, arg, actual, inner, trial),
        }
    }

    /// Match a guarded scalar class: values the guard admits bind the
    /// class variable.
    fn match_guarded_shape(
        &self,
        actual: &ResolvedType,
        ok: fn(&ResolvedType) -> bool,
        var: SigVar,
        trial: &mut Trial,
    ) -> bool {
        if !ok(actual) {
            return false;
        }
        self.bind_var(trial, var, actual)
    }

    /// Match an enum shape: already-enum values match by case-set width
    /// subtyping, anything else falls through to literal claiming.
    fn match_enum_claim(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        cases: &[String],
        trial: &mut Trial,
    ) -> bool {
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
            cases: cases.to_vec(),
            owner: None,
        };
        self.claim_enum_case(cx, arg.value, cases, claim_as, trial)
    }

    /// Match a closed display object: every field must be displayable.
    fn match_display_object(&self, actual: &ResolvedType) -> bool {
        match actual {
            ResolvedType::Object(actual_fields)
            | ResolvedType::StdNominal {
                fields: actual_fields,
                ..
            } => actual_fields.iter().all(|(_, v)| display_nonnull(v)),
            ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
            _ => false,
        }
    }

    /// Match a message shape: descriptors, or inline messages already
    /// checked as descriptors.
    fn match_message_shape(&self, arg: &CallArg, actual: &ResolvedType) -> bool {
        matches!(
            actual,
            ResolvedType::Message(_) | ResolvedType::Unknown | ResolvedType::Opaque(_)
        ) || (matches!(actual, ResolvedType::InlineMessage)
            && self.is_checked_message_descriptor(arg.value))
    }

    /// Match an array-carrying shape, enforcing the ordered/nonempty
    /// flag the shape requires before matching the element.
    fn match_collection_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        shape: &SigType,
        inner: &SigType,
        trial: &mut Trial,
    ) -> bool {
        let flags_ok = match shape {
            SigType::OrderedCollection(_) => {
                matches!(actual, ResolvedType::Array { ordered: true, .. })
            }
            SigType::NonemptyCollection(_) => {
                matches!(actual, ResolvedType::Array { nonempty: true, .. })
            }
            _ => true,
        };
        match actual {
            ResolvedType::Array { element, .. } if flags_ok => {
                self.match_shape(cx, arg, element, inner, trial)
            }
            ResolvedType::Unknown | ResolvedType::Opaque(_) => true,
            _ => false,
        }
    }

    /// Match a closed object shape: exact key sets, each value
    /// matching its declared field shape.
    fn match_object_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        fields: &[(String, SigType)],
        trial: &mut Trial,
    ) -> bool {
        let (ResolvedType::Object(actual_fields)
        | ResolvedType::StdNominal {
            fields: actual_fields,
            ..
        }) = actual
        else {
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

    /// Match a union shape: the first admitting arm commits its trial.
    fn match_union_shape(
        &mut self,
        cx: &Ctx<'_, '_>,
        arg: &CallArg,
        actual: &ResolvedType,
        arms: &[SigType],
        trial: &mut Trial,
    ) -> bool {
        for arm in arms {
            let mut fork = trial.fork();
            if self.match_shape(cx, arg, actual, arm, &mut fork) {
                trial.commit(fork);
                return true;
            }
        }
        false
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
                trial
                    .literal_retypes
                    .push((NodeKey::of(leaf), ResolvedType::Scalar(want)));
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
            SigType::Any
            | SigType::Ordered
            | SigType::StringLike
            | SigType::GroupKey
            | SigType::Display => Self::subst_shape_var(shape, trial),
            SigType::Collection(_)
            | SigType::OrderedCollection(_)
            | SigType::Array(_)
            | SigType::NonemptyCollection(_)
            | SigType::Nullable(_)
            | SigType::Union(_) => self.subst_shape_collection(shape, trial),
            _ => self.subst_shape_leaf(shape, trial),
        }
    }

    fn subst_shape_var(shape: &SigType, trial: &Trial) -> ResolvedType {
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
            _ => unreachable!("subst_shape_var takes only variable shapes"),
        }
    }

    fn subst_shape_collection(&self, shape: &SigType, trial: &Trial) -> ResolvedType {
        match shape {
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
            _ => unreachable!("subst_shape_collection takes only collection shapes"),
        }
    }

    fn subst_shape_leaf(&self, shape: &SigType, trial: &Trial) -> ResolvedType {
        match shape {
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
            _ => unreachable!("subst_shape_leaf takes only leaf shapes"),
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
        _ => loose_equal_structured(a, b),
    }
}

fn loose_equal_structured(a: &ResolvedType, b: &ResolvedType) -> bool {
    match (a, b) {
        (
            ResolvedType::Enum {
                cases: ac,
                owner: ao,
            },
            ResolvedType::Enum {
                cases: bc,
                owner: bo,
            },
        ) => loose_equal_enum(ao, bo, ac, bc),
        (ResolvedType::Record { symbol: a, .. }, ResolvedType::Record { symbol: b, .. }) => a == b,
        (ResolvedType::Message(a), ResolvedType::Message(b)) => a == b,
        (ResolvedType::InlineMessage, ResolvedType::InlineMessage) => true,
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
        ) => loose_equal_action(a, ab, ae, b, bb, be),
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
        (
            ResolvedType::StdNominal {
                name: a,
                fields: af,
            },
            ResolvedType::StdNominal {
                name: b,
                fields: bf,
            },
        ) => a == b && af == bf,
        (ResolvedType::Object(a), ResolvedType::Object(b)) => loose_equal_fields(a, b),
        (ResolvedType::Operation(a), ResolvedType::Operation(b)) => a == b,
        _ => false,
    }
}

fn loose_equal_action(
    a: &[SymbolId],
    ab: &Option<Vec<String>>,
    ae: &[String],
    b: &[SymbolId],
    bb: &Option<Vec<String>>,
    be: &[String],
) -> bool {
    a == b && ab == bb && ae == be
}

fn loose_equal_enum(
    ao: &Option<SymbolId>,
    bo: &Option<SymbolId>,
    ac: &[String],
    bc: &[String],
) -> bool {
    ao == bo && (ao.is_some() || ac == bc)
}

fn loose_equal_fields(a: &[(String, ResolvedType)], b: &[(String, ResolvedType)]) -> bool {
    a.len() == b.len()
        && a.iter().all(|(k, t)| {
            b.iter()
                .find(|(bk, _)| bk == k)
                .is_some_and(|(_, bt)| loose_equal(t, bt))
        })
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
    /// Validated literals do not mark enum cases as resolved.
    literal_retypes: Vec<(NodeKey, ResolvedType)>,
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
            literal_retypes: self.literal_retypes.clone(),
        }
    }

    /// Commit a successful arm's bindings.
    fn commit(&mut self, fork: Trial) {
        self.bindings = fork.bindings;
        self.action_op = fork.action_op;
        self.action_bound = fork.action_bound;
        self.claimed = fork.claimed;
        self.literal_retypes = fork.literal_retypes;
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
fn name_or_ref_word<'a>(node: &SyntaxNode, text: &'a str) -> Option<&'a str> {
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
/// ISO 4217 table owned by Values (only table members
/// are currency values).
fn valid_currency(value: &str) -> Option<String> {
    if value.len() != 3 || !value.bytes().all(|b| b.is_ascii_uppercase()) {
        return Some("want 3 uppercase letters (ISO 4217)".to_string());
    }
    if values_semantics::currency_facts::currency_table_scale(value).is_some() {
        return None;
    }
    if EXCLUDED_CURRENCIES.contains(&value) {
        return Some("has no pinned minor-unit scale (excluded from admission)".to_string());
    }
    Some("unknown ISO 4217 code".to_string())
}

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
    let (year, month, day, hour, minute, second, rest) = parse_datetime_parts(value)?;
    // Optional fraction, then the required zone.
    let (millis, rest) = parse_datetime_fraction(rest)?;
    let offset_ms = parse_zone_offset(rest)?;
    let days = days_from_civil(year, month, day);
    let instant = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
        - offset_ms;
    if !(DATETIME_MIN_MS..=DATETIME_MAX_MS).contains(&instant) {
        return Err("instant outside the supported range".to_string());
    }
    Ok(instant)
}

fn parse_datetime_parts(value: &str) -> Result<(i64, i64, i64, i64, i64, i64, &str), String> {
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
    Ok((year, month, day, hour, minute, second, &value[19..]))
}

fn parse_datetime_fraction(rest: &str) -> Result<(i64, &str), String> {
    let Some(fraction) = rest.strip_prefix('.') else {
        return Ok((0, rest));
    };
    let end = fraction.bytes().take_while(|b| b.is_ascii_digit()).count();
    if end == 0 {
        return Err("empty fractional seconds".to_string());
    }
    let digits = &fraction[..end];
    let padded = format!("{digits:0<3}");
    let millis = padded[..3].parse::<i64>().unwrap_or(0);
    if digits.len() > 3 && !digits[3..].bytes().all(|b| b == b'0') {
        return Err("nonzero sub-millisecond fraction rejected".to_string());
    }
    Ok((millis, &fraction[end..]))
}

fn parse_zone_offset(rest: &str) -> Result<i64, String> {
    if rest.eq_ignore_ascii_case("z") {
        return Ok(0);
    }
    if rest.len() == 6
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
            Ok(magnitude)
        } else {
            Ok(-magnitude)
        }
    } else {
        Err("want a Z or ±HH:MM zone offset".to_string())
    }
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
