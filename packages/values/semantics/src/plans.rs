//! Owner registration and generation handles, native side (V03.4).
//!
//! Mirrors `prepared/plan.ts` registry mechanics for native-issued plans:
//! copied scope strings, issuer-assigned `plan:abi:profile:backend:rev:
//! gN:seq` ids, deep-owned ordered plans, a shared default registry with
//! stable identity, and idempotent release. This module ADDS the V03.4
//! mechanics plan.ts defers: union/type dispatch resolved ONCE at
//! registration, bounded registration, and generation retirement with
//! inactive-scope invalidation (retired plans are never evicted).
//!
//! Registration inputs are Rust-native shapes (binding transport lands
//! in A07.3). Provenance, not shape, admits a schema: registration
//! requires recorded factory provenance whose revision matches the
//! owner scope. Error codes mirror `PlanErrorCode`, plus
//! `registry-full` and `inactive-generation` for the new mechanics.
//! Lookups never build caller-keyed caches: ids parse to an issuer
//! sequence plus full-equality verification.

use std::collections::HashMap;

use num_bigint::BigInt;

/// Plan-registry failure codes (mirrors `PlanErrorCode` + V03.4 additions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanCode {
    ForeignOwner,
    InvalidProfile,
    LegacyWrapper,
    MissingProvenance,
    StaleScope,
    MalformedSchema,
    UnknownPlan,
    UnknownDefault,
    UncopyableValue,
    RegistryFull,
    InactiveGeneration,
    UnknownDispatch,
    UnknownTarget,
}

impl PlanCode {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanCode::ForeignOwner => "foreign-owner",
            PlanCode::InvalidProfile => "invalid-profile",
            PlanCode::LegacyWrapper => "legacy-wrapper",
            PlanCode::MissingProvenance => "missing-provenance",
            PlanCode::StaleScope => "stale-scope",
            PlanCode::MalformedSchema => "malformed-schema",
            PlanCode::UnknownPlan => "unknown-plan",
            PlanCode::UnknownDefault => "unknown-default",
            PlanCode::UncopyableValue => "uncopyable-value",
            PlanCode::RegistryFull => "registry-full",
            PlanCode::InactiveGeneration => "inactive-generation",
            PlanCode::UnknownDispatch => "unknown-dispatch",
            PlanCode::UnknownTarget => "unknown-target",
        }
    }
}

/// Registration/resolution failure. Never raised for legacy validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanError {
    pub code: PlanCode,
    pub message: String,
}

impl PlanError {
    fn new(code: PlanCode, message: impl Into<String>) -> Self {
        PlanError {
            code,
            message: message.into(),
        }
    }
}

/// Owned plan metadata value. Plain data only; exotic host state
/// (class instances, functions, Maps) is unrepresentable here, so the
/// `uncopyable-value` refusal is structural. Text is UTF-16 units to
/// stay lossless (D2).
#[derive(Debug, Clone, PartialEq)]
pub enum Meta {
    Null,
    Bool(bool),
    NumBits(u64),
    Text(Vec<u16>),
    Bigint(BigInt),
    Array(Vec<Meta>),
    Object(Vec<(String, Meta)>),
    /// Explicit-undefined fill (N4). D3 excludes `own-undefined`
    /// from JSON-derived positions only; registered defaults are
    /// registry-minted (D4), so an explicit undefined default is
    /// storable and distinct from having no default at all.
    Undefined,
}

/// Field type base, mirroring `NormalizedType` bases.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeBase {
    Scalar { name: String },
    Stringlike { name: String },
    User,
    Member,
    File,
    Secret,
    Json,
    Nominal { path: String },
    Action { targets: Option<Vec<String>> },
    Invocation { targets: Option<Vec<String>> },
    Delivery { operation: Option<String> },
    Enum { cases: Vec<String> },
    Union { arms: Vec<String> },
}

/// One input field (contract field or operation input).
#[derive(Debug, Clone, PartialEq)]
pub struct FieldInput {
    pub name: String,
    pub type_id: String,
    pub base: TypeBase,
    pub array: bool,
    pub nullable: bool,
    pub required_array: bool,
    pub required: bool,
    pub has_default: bool,
    pub default: Option<Meta>,
    pub length_min: Option<f64>,
    pub length_max: Option<f64>,
    pub value_min: Option<Meta>,
    pub value_max: Option<Meta>,
    pub trim: Option<bool>,
    pub server_only: bool,
    pub default_origin: Option<String>,
    /// Carried `format` duty. Only `"name"` is admissible; anything else
    /// is a malformed owner schema, never a silently dropped constraint.
    pub format: Option<String>,
    /// Carried `distinctBy` duty. Only `true` (`"id"`) is admissible, and
    /// only on arrays of a nominal (declared-contract) base.
    pub distinct_by: bool,
    /// Carried `excludedIds` duty as lossless UTF-16 units. Requires
    /// `distinct_by`; entries must be distinct NAME ids of 1–80 scalars.
    pub excluded_ids: Vec<Vec<u16>>,
}

/// One input text alias: bounded text with NAME format (`type`/`format`
/// are pinned by the registration gate, so only bounds are stored).
#[derive(Debug, Clone, PartialEq)]
pub struct AliasInput {
    pub name: String,
    pub length_min: f64,
    pub length_max: f64,
}

/// One input contract / enum / operation.
#[derive(Debug, Clone, PartialEq)]
pub struct ContractInput {
    pub name: String,
    pub fields: Vec<FieldInput>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnumInput {
    pub name: String,
    pub cases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OperationInput {
    pub name: String,
    pub inputs: Vec<FieldInput>,
    pub mutation: bool,
}

/// Registration input: a normalized schema or a legacy string wrapper.
#[derive(Debug, Clone, PartialEq)]
pub enum SchemaInput {
    Normalized {
        contracts: Vec<ContractInput>,
        enums: Vec<EnumInput>,
        operations: Vec<OperationInput>,
        aliases: Vec<AliasInput>,
    },
    /// Unknown string wrappers stay on the legacy path (never plans).
    LegacyWrapper(String),
}

/// Factory provenance record (mirrors the V02.6 hook record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub factory: String,
    pub owner_rev: String,
}

/// Owner scope strings, copied and frozen at creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerScope {
    pub abi: String,
    pub profile: String,
    pub backend: String,
    pub owner_rev: String,
}

/// Unforgeable owner token: the id field is private, so only
/// [`Plans::create_owner`] mints resolvable tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OwnerToken {
    id: u64,
}

/// Opaque default reference (issuer-assigned key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultRef {
    pub key: String,
}

/// One ordered, immutable field plan.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldPlan {
    pub name: String,
    pub type_id: String,
    pub base: TypeBase,
    pub array: bool,
    pub nullable: bool,
    pub required_array: bool,
    pub required: bool,
    pub has_default: bool,
    pub default_ref: Option<DefaultRef>,
    pub length_min: Option<f64>,
    pub length_max: Option<f64>,
    pub value_min: Option<Meta>,
    pub value_max: Option<Meta>,
    pub trim: Option<bool>,
    pub server_only: bool,
    pub default_origin: Option<String>,
    pub refs: Vec<String>,
    pub format: Option<String>,
    pub distinct_by: bool,
    pub excluded_ids: Vec<Vec<u16>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContractPlan {
    pub name: String,
    pub fields: Vec<FieldPlan>,
    pub allowed: Vec<String>,
    pub required: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnumPlan {
    pub name: String,
    pub cases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OperationPlan {
    pub name: String,
    pub inputs: Vec<FieldPlan>,
    pub allowed: Vec<String>,
    pub required: Vec<String>,
    pub mutation: bool,
}

/// One registered text alias: bounded text with NAME format.
#[derive(Debug, Clone, PartialEq)]
pub struct AliasPlan {
    pub name: String,
    pub length_min: f64,
    pub length_max: f64,
}

/// One registered immutable plan, with its once-resolved dispatch table:
/// `(dotted type path, ordered union arms)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub id: String,
    pub profile: String,
    pub error_projection: String,
    pub generation: u64,
    pub sequence: u64,
    pub contracts: Vec<ContractPlan>,
    pub contract_order: Vec<String>,
    pub enums: Vec<EnumPlan>,
    pub enum_order: Vec<String>,
    pub operations: Vec<OperationPlan>,
    pub operation_order: Vec<String>,
    pub aliases: Vec<AliasPlan>,
    pub alias_order: Vec<String>,
    pub dispatch: Vec<(String, Vec<String>)>,
}

#[derive(Debug)]
struct OwnerState {
    scope: OwnerScope,
    generation: u64,
    next_sequence: u64,
    bound: usize,
    plans: Vec<Option<Plan>>,
    defaults: HashMap<String, Meta>,
}

/// The native plan registry. One instance serves one backend.
#[derive(Debug, Default)]
pub struct Plans {
    owners: HashMap<u64, OwnerState>,
    next_owner: u64,
}

fn type_refs(base: &TypeBase) -> Vec<String> {
    match base {
        TypeBase::Nominal { path } => vec![path.clone()],
        TypeBase::Union { arms } => arms.clone(),
        TypeBase::Enum { cases } => cases.clone(),
        TypeBase::Action { targets } | TypeBase::Invocation { targets } => {
            targets.clone().unwrap_or_default()
        }
        TypeBase::Delivery { operation } => operation.clone().into_iter().collect(),
        _ => Vec::new(),
    }
}

fn reject_reserved(where_: &str, name: &str) -> Result<(), PlanError> {
    if name == "__proto__" {
        return Err(PlanError::new(
            PlanCode::MalformedSchema,
            format!("{where_} name \"__proto__\" is reserved"),
        ));
    }
    Ok(())
}

/// Can NAME test over UTF-16 units: `^[A-Za-z_][A-Za-z0-9_]*$`
/// (mirrors `NAME_RE`; lone surrogates never match).
pub fn is_name_units(units: &[u16]) -> bool {
    let mut chars = units.iter();
    let Some(first) = chars.next() else {
        return false;
    };
    let head = *first;
    if !(head == b'_' as u16
        || (head >= b'A' as u16 && head <= b'Z' as u16)
        || (head >= b'a' as u16 && head <= b'z' as u16))
    {
        return false;
    }
    chars.all(|unit| {
        *unit == b'_' as u16
            || (*unit >= b'A' as u16 && *unit <= b'Z' as u16)
            || (*unit >= b'a' as u16 && *unit <= b'z' as u16)
            || (*unit >= b'0' as u16 && *unit <= b'9' as u16)
    })
}

/// Unicode scalar count over UTF-16 units: surrogate pairs count 1,
/// lone surrogates each count 1 (mirrors `scalarLength` iteration).
pub fn scalar_len_units(units: &[u16]) -> usize {
    let mut count = 0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if (0xD800..0xDC00).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|trail| (0xDC00..0xE000).contains(trail))
        {
            index += 2;
        } else {
            index += 1;
        }
        count += 1;
    }
    count
}

/// Validates one carried `excludedIds` entry: distinct NAME id of
/// 1–80 scalars (mirrors the factory gate; `NAME_RE` implies non-empty).
fn check_excluded_id(
    where_: &str,
    units: &[u16],
    seen: &mut Vec<Vec<u16>>,
) -> Result<(), PlanError> {
    if !is_name_units(units) || scalar_len_units(units) > 80 || seen.contains(&units.to_vec()) {
        return Err(PlanError::new(
            PlanCode::MalformedSchema,
            format!("{where_} excludedIds must contain distinct NAME ids of 1-80 scalars"),
        ));
    }
    seen.push(units.to_vec());
    Ok(())
}

/// Copies one input field into its immutable plan, carrying the full
/// current duties (bounds, trim, carried format/distinctBy/excludedIds).
fn plan_field(field: &FieldInput) -> FieldPlan {
    FieldPlan {
        name: field.name.clone(),
        type_id: field.type_id.clone(),
        base: field.base.clone(),
        array: field.array,
        nullable: field.nullable,
        required_array: field.required_array,
        required: field.required,
        has_default: field.has_default,
        default_ref: None,
        length_min: field.length_min,
        length_max: field.length_max,
        value_min: field.value_min.clone(),
        value_max: field.value_max.clone(),
        trim: field.trim,
        server_only: field.server_only,
        default_origin: field.default_origin.clone(),
        refs: type_refs(&field.base),
        format: field.format.clone(),
        distinct_by: field.distinct_by,
        excluded_ids: field.excluded_ids.clone(),
    }
}

impl Plans {
    /// Mints one owner registry bound to copied scope strings and a
    /// registration bound. Synchronous.
    pub fn create_owner(
        &mut self,
        scope: OwnerScope,
        bound: usize,
    ) -> Result<OwnerToken, PlanError> {
        for (key, value) in [
            ("abiVersion", &scope.abi),
            ("profileVersion", &scope.profile),
            ("backendId", &scope.backend),
            ("ownerRevision", &scope.owner_rev),
        ] {
            if value.is_empty() {
                return Err(PlanError::new(
                    PlanCode::ForeignOwner,
                    format!("owner scope {key} must be a non-empty string"),
                ));
            }
        }
        let id = self.next_owner;
        self.next_owner += 1;
        self.owners.insert(
            id,
            OwnerState {
                scope,
                generation: 0,
                next_sequence: 0,
                bound,
                plans: Vec::new(),
                defaults: HashMap::new(),
            },
        );
        Ok(OwnerToken { id })
    }

    fn state(&self, owner: &OwnerToken) -> Result<&OwnerState, PlanError> {
        self.owners.get(&owner.id).ok_or_else(|| {
            PlanError::new(
                PlanCode::ForeignOwner,
                "unknown plan owner (not issued by create_owner)",
            )
        })
    }

    fn state_mut(&mut self, owner: &OwnerToken) -> Result<&mut OwnerState, PlanError> {
        self.owners.get_mut(&owner.id).ok_or_else(|| {
            PlanError::new(
                PlanCode::ForeignOwner,
                "unknown plan owner (not issued by create_owner)",
            )
        })
    }

    /// Registers an immutable plan. Performs every gate before storing:
    /// owner, profile, wrapper/shape, provenance, revision, reserved
    /// names, default presence, then the registration bound.
    pub fn register(
        &mut self,
        owner: &OwnerToken,
        profile: &str,
        schema: &SchemaInput,
        provenance: Option<&Provenance>,
    ) -> Result<String, PlanError> {
        // Borrow once for gates that only read; re-borrow mutably to store.
        {
            let state = self.state(owner)?;
            if profile.is_empty() {
                return Err(PlanError::new(
                    PlanCode::InvalidProfile,
                    "profile version must be a non-empty string",
                ));
            }
            let SchemaInput::Normalized {
                contracts,
                enums,
                operations,
                aliases,
            } = schema
            else {
                return Err(PlanError::new(
                    PlanCode::LegacyWrapper,
                    "unknown string wrappers stay outside the plan cache (legacy path)",
                ));
            };
            let Some(record) = provenance else {
                return Err(PlanError::new(
                    PlanCode::MissingProvenance,
                    "schema lacks factory provenance",
                ));
            };
            if record.factory != "normalizeSchema" {
                return Err(PlanError::new(
                    PlanCode::MissingProvenance,
                    "schema lacks factory provenance",
                ));
            }
            if record.owner_rev != state.scope.owner_rev {
                return Err(PlanError::new(
                    PlanCode::StaleScope,
                    "schema provenance revision does not match the owner scope",
                ));
            }
            // Shape gates (reserved names, duplicates, default presence,
            // carried format/distinctBy/excludedIds/alias duties) run
            // before the bound so malformed input never consumes capacity.
            Self::check_schema(contracts, enums, operations, aliases)?;
            let live = state.plans.iter().filter(|p| p.is_some()).count();
            if live >= state.bound {
                return Err(PlanError::new(
                    PlanCode::RegistryFull,
                    "owner plan registry is at its bound",
                ));
            }
        }
        let state = self.state_mut(owner)?;
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        let id = format!(
            "plan:{}:{}:{}:{}:g{}:{}",
            state.scope.abi,
            state.scope.profile,
            state.scope.backend,
            state.scope.owner_rev,
            state.generation,
            sequence
        );
        let SchemaInput::Normalized {
            contracts,
            enums,
            operations,
            aliases,
        } = schema
        else {
            unreachable!("wrapper rejected above");
        };
        let mut dispatch: Vec<(String, Vec<String>)> = Vec::new();
        let mut contract_plans = Vec::with_capacity(contracts.len());
        let mut contract_order = Vec::with_capacity(contracts.len());
        for contract in contracts {
            let mut fields = Vec::with_capacity(contract.fields.len());
            let mut allowed = Vec::with_capacity(contract.fields.len());
            let mut required = Vec::new();
            for field in &contract.fields {
                let path = format!("contracts.{}.fields.{}", contract.name, field.name);
                let key = format!("{sequence}:{path}");
                let default_ref = if field.has_default {
                    let default = field.default.clone().ok_or_else(|| {
                        PlanError::new(
                            PlanCode::MalformedSchema,
                            format!(
                                "field {}.{} claims a default it lacks",
                                contract.name, field.name
                            ),
                        )
                    })?;
                    state.defaults.insert(key.clone(), default);
                    Some(DefaultRef { key })
                } else {
                    None
                };
                if let TypeBase::Union { arms } = &field.base {
                    dispatch.push((path.clone(), arms.clone()));
                }
                let mut built = plan_field(field);
                built.default_ref = default_ref;
                fields.push(built);
                allowed.push(field.name.clone());
                if field.required {
                    required.push(field.name.clone());
                }
            }
            contract_order.push(contract.name.clone());
            contract_plans.push(ContractPlan {
                name: contract.name.clone(),
                fields,
                allowed,
                required,
            });
        }
        let mut enum_plans = Vec::with_capacity(enums.len());
        let mut enum_order = Vec::with_capacity(enums.len());
        for enum_def in enums {
            enum_order.push(enum_def.name.clone());
            enum_plans.push(EnumPlan {
                name: enum_def.name.clone(),
                cases: enum_def.cases.clone(),
            });
        }
        let mut operation_plans = Vec::with_capacity(operations.len());
        let mut operation_order = Vec::with_capacity(operations.len());
        for operation in operations {
            let mut inputs = Vec::with_capacity(operation.inputs.len());
            let mut allowed = Vec::with_capacity(operation.inputs.len());
            let mut required = Vec::new();
            for field in &operation.inputs {
                let path = format!("operations.{}.inputs.{}", operation.name, field.name);
                let key = format!("{sequence}:{path}");
                let default_ref = if field.has_default {
                    let default = field.default.clone().ok_or_else(|| {
                        PlanError::new(
                            PlanCode::MalformedSchema,
                            format!(
                                "input {}.{} claims a default it lacks",
                                operation.name, field.name
                            ),
                        )
                    })?;
                    state.defaults.insert(key.clone(), default);
                    Some(DefaultRef { key })
                } else {
                    None
                };
                if let TypeBase::Union { arms } = &field.base {
                    dispatch.push((path.clone(), arms.clone()));
                }
                let mut built = plan_field(field);
                built.default_ref = default_ref;
                inputs.push(built);
                allowed.push(field.name.clone());
                if field.required {
                    required.push(field.name.clone());
                }
            }
            operation_order.push(operation.name.clone());
            operation_plans.push(OperationPlan {
                name: operation.name.clone(),
                inputs,
                allowed,
                required,
                mutation: operation.mutation,
            });
        }
        let mut alias_plans = Vec::with_capacity(aliases.len());
        let mut alias_order = Vec::with_capacity(aliases.len());
        for alias in aliases {
            alias_order.push(alias.name.clone());
            alias_plans.push(AliasPlan {
                name: alias.name.clone(),
                length_min: alias.length_min,
                length_max: alias.length_max,
            });
        }
        let plan = Plan {
            id: id.clone(),
            profile: profile.to_string(),
            error_projection: profile.to_string(),
            generation: state.generation,
            sequence,
            contracts: contract_plans,
            contract_order,
            enums: enum_plans,
            enum_order,
            operations: operation_plans,
            operation_order,
            aliases: alias_plans,
            alias_order,
            dispatch,
        };
        state.plans.push(Some(plan));
        Ok(id)
    }

    /// Carried-duty gate for one field: `format` is only `"name"`,
    /// `distinctBy` only applies to arrays of a nominal base, and
    /// `excludedIds` requires `distinctBy` with distinct 1–80-scalar
    /// NAME ids. Anything else is malformed owner metadata, never a
    /// silently dropped constraint.
    fn check_field_duties(where_: &str, field: &FieldInput) -> Result<(), PlanError> {
        if field.format.as_deref().is_some_and(|format| format != "name") {
            return Err(PlanError::new(
                PlanCode::MalformedSchema,
                format!("{where_} format must be \"name\""),
            ));
        }
        // Mirrors the factory gate exactly: nominal base only (a
        // declared contract, model or alias array carries ids).
        let nominal_array = field.array && matches!(field.base, TypeBase::Nominal { .. });
        if field.distinct_by && !nominal_array {
            return Err(PlanError::new(
                PlanCode::MalformedSchema,
                format!("{where_} distinctBy=id applies only to declared-contract arrays"),
            ));
        }
        if !field.excluded_ids.is_empty() && !field.distinct_by {
            return Err(PlanError::new(
                PlanCode::MalformedSchema,
                format!("{where_} excludedIds requires distinctBy=id"),
            ));
        }
        let mut seen: Vec<Vec<u16>> = Vec::with_capacity(field.excluded_ids.len());
        for units in &field.excluded_ids {
            check_excluded_id(where_, units, &mut seen)?;
        }
        for bound in [field.length_min, field.length_max] {
            if bound.is_some_and(|limit| !limit.is_finite()) {
                return Err(PlanError::new(
                    PlanCode::MalformedSchema,
                    format!("{where_} length bounds must be finite numbers"),
                ));
            }
        }
        Ok(())
    }

    fn check_schema(
        contracts: &[ContractInput],
        enums: &[EnumInput],
        operations: &[OperationInput],
        aliases: &[AliasInput],
    ) -> Result<(), PlanError> {
        // Declaration names share one namespace with loader models
        // (models are factory-checked); duplicates here are malformed.
        let mut declared: Vec<&str> = Vec::new();
        for name in contracts
            .iter()
            .map(|contract| contract.name.as_str())
            .chain(enums.iter().map(|enum_def| enum_def.name.as_str()))
            .chain(operations.iter().map(|operation| operation.name.as_str()))
            .chain(aliases.iter().map(|alias| alias.name.as_str()))
        {
            if declared.contains(&name) {
                return Err(PlanError::new(
                    PlanCode::MalformedSchema,
                    format!("duplicate declaration {name:?}"),
                ));
            }
            declared.push(name);
        }
        for contract in contracts {
            reject_reserved("contract", &contract.name)?;
            let mut fields: Vec<&str> = Vec::new();
            for field in &contract.fields {
                reject_reserved("field", &field.name)?;
                if fields.contains(&field.name.as_str()) {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "duplicate field {}.{}",
                            contract.name, field.name
                        ),
                    ));
                }
                fields.push(field.name.as_str());
                if field.has_default && field.default.is_none() {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "field {}.{} claims a default it lacks",
                            contract.name, field.name
                        ),
                    ));
                }
                Self::check_field_duties(
                    &format!("field {}.{}", contract.name, field.name),
                    field,
                )?;
            }
        }
        for enum_def in enums {
            reject_reserved("enum", &enum_def.name)?;
        }
        for alias in aliases {
            reject_reserved("alias", &alias.name)?;
            for bound in [alias.length_min, alias.length_max] {
                if !bound.is_finite() {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!("alias {} bounds must be finite numbers", alias.name),
                    ));
                }
            }
            if alias.length_min > alias.length_max {
                return Err(PlanError::new(
                    PlanCode::MalformedSchema,
                    format!("alias {} bounds cannot be empty", alias.name),
                ));
            }
        }
        // Receiving length bounds must intersect the declared text alias
        // they resolve through (mirrors the factory intersection gate).
        let alias_bounds = |path: &str| -> Option<(f64, f64)> {
            aliases.iter().find_map(|alias| {
                (alias.name == path).then_some((alias.length_min, alias.length_max))
            })
        };
        let check_alias_bounds =
            |where_: &str, base: &TypeBase, min: Option<f64>, max: Option<f64>| {
                let TypeBase::Nominal { path } = base else {
                    return Ok(());
                };
                let Some((alias_min, alias_max)) = alias_bounds(path) else {
                    return Ok(());
                };
                let minimum = min.unwrap_or(0.0).max(alias_min);
                let maximum = max
                    .unwrap_or(f64::INFINITY)
                    .min(alias_max);
                if minimum > maximum {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!("{where_} receiving bounds cannot satisfy the declared text alias"),
                    ));
                }
                Ok(())
            };
        for operation in operations {
            reject_reserved("operation", &operation.name)?;
            let mut inputs: Vec<&str> = Vec::new();
            for field in &operation.inputs {
                reject_reserved("input", &field.name)?;
                if inputs.contains(&field.name.as_str()) {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "duplicate input {}.{}",
                            operation.name, field.name
                        ),
                    ));
                }
                inputs.push(field.name.as_str());
                if field.has_default && field.default.is_none() {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "input {}.{} claims a default it lacks",
                            operation.name, field.name
                        ),
                    ));
                }
                Self::check_field_duties(
                    &format!("input {}.{}", operation.name, field.name),
                    field,
                )?;
                check_alias_bounds(
                    &format!("input {}.{}", operation.name, field.name),
                    &field.base,
                    field.length_min,
                    field.length_max,
                )?;
            }
        }
        for contract in contracts {
            for field in &contract.fields {
                check_alias_bounds(
                    &format!("field {}.{}", contract.name, field.name),
                    &field.base,
                    field.length_min,
                    field.length_max,
                )?;
            }
        }
        Ok(())
    }

    /// Parses an issuer id to its sequence. Caller strings size nothing:
    /// the sequence indexes the plan vec and the full id must match.
    fn parse_sequence(id: &str) -> Option<u64> {
        let tail = id.strip_prefix("plan:")?;
        let (head, seq) = tail.rsplit_once(':')?;
        let (_scope, generation) = head.rsplit_once(":g")?;
        let _gen: u64 = generation.parse().ok()?;
        seq.parse().ok()
    }

    /// Reads one live plan. Unknown, released, or retired-generation
    /// handles fail closed; foreign-owner handles are unknown here.
    pub fn get(&self, owner: &OwnerToken, id: &str) -> Result<&Plan, PlanError> {
        let state = self.state(owner)?;
        let Some(sequence) = Self::parse_sequence(id) else {
            return Err(PlanError::new(
                PlanCode::UnknownPlan,
                "plan id must be an issued plan handle",
            ));
        };
        let slot: usize = sequence.try_into().unwrap_or(usize::MAX);
        let Some(Some(plan)) = state.plans.get(slot) else {
            return Err(PlanError::new(
                PlanCode::UnknownPlan,
                "no live plan for this handle in this owner scope",
            ));
        };
        if plan.id != id {
            return Err(PlanError::new(
                PlanCode::UnknownPlan,
                "no live plan for this handle in this owner scope",
            ));
        }
        if plan.generation != state.generation {
            return Err(PlanError::new(
                PlanCode::InactiveGeneration,
                "plan handle is from a retired generation",
            ));
        }
        Ok(plan)
    }

    /// Union arms resolved ONCE at registration. Repeated reads return
    /// the stored table; nothing re-resolves.
    pub fn dispatch_arms(
        &self,
        owner: &OwnerToken,
        id: &str,
        type_path: &str,
    ) -> Result<&[String], PlanError> {
        let plan = self.get(owner, id)?;
        plan.dispatch
            .iter()
            .find(|(path, _)| path == type_path)
            .map(|(_, arms)| arms.as_slice())
            .ok_or_else(|| {
                PlanError::new(
                    PlanCode::UnknownDispatch,
                    "no union dispatch for this type path in this plan",
                )
            })
    }

    /// Resolves one default through the shared registry. Forged or
    /// unknown references fail; live ones return the stored value.
    /// Generation-blind by intent (N3): defaults are plan-content
    /// identity keyed by sequence and path, so a held reference
    /// survives retirement — retirement scopes handles, not content.
    pub fn resolve_default(
        &self,
        owner: &OwnerToken,
        reference: &DefaultRef,
    ) -> Result<&Meta, PlanError> {
        let state = self.state(owner)?;
        state.defaults.get(&reference.key).ok_or_else(|| {
            PlanError::new(
                PlanCode::UnknownDefault,
                "no registered default for this reference",
            )
        })
    }

    /// Releases one plan. Idempotent: unknown or released ids are
    /// silent no-ops (after the owner gate).
    pub fn release(&mut self, owner: &OwnerToken, id: &str) {
        let Ok(state) = self.state_mut(owner) else {
            return;
        };
        let Some(sequence) = Self::parse_sequence(id) else {
            return;
        };
        let slot: usize = sequence.try_into().unwrap_or(usize::MAX);
        if let Some(entry) = state.plans.get_mut(slot) {
            if entry.as_ref().is_some_and(|plan| plan.id == id) {
                *entry = None;
            }
        }
    }

    /// Retires the current generation and starts the next. Older
    /// handles fail with `inactive-generation`; stored plans are NOT
    /// evicted (release stays the only removal), so retired but
    /// unreleased plans still occupy the registration bound (N2: the
    /// TS half reclaims its live set on retire instead — recorded
    /// divergence, same release-frees rule in both halves).
    pub fn retire_generation(&mut self, owner: &OwnerToken) -> Result<u64, PlanError> {
        let state = self.state_mut(owner)?;
        state.generation += 1;
        Ok(state.generation)
    }

    /// Live plan count (retired plans still occupy slots until
    /// release — N2: unlike the TS half's live set, which reclaims
    /// on retire).
    pub fn live_count(&self, owner: &OwnerToken) -> Result<usize, PlanError> {
        Ok(self
            .state(owner)?
            .plans
            .iter()
            .filter(|p| p.is_some())
            .count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> OwnerScope {
        OwnerScope {
            abi: "v1".to_string(),
            profile: "values".to_string(),
            backend: "native".to_string(),
            owner_rev: "artifact-1".to_string(),
        }
    }

    fn provenance() -> Provenance {
        Provenance {
            factory: "normalizeSchema".to_string(),
            owner_rev: "artifact-1".to_string(),
        }
    }

    fn field(name: &str) -> FieldInput {
        FieldInput {
            name: name.to_string(),
            type_id: "int".to_string(),
            base: TypeBase::Scalar {
                name: "int".to_string(),
            },
            array: false,
            nullable: false,
            required_array: false,
            required: true,
            has_default: false,
            default: None,
            length_min: None,
            length_max: None,
            value_min: None,
            value_max: None,
            trim: None,
            server_only: false,
            default_origin: None,
            format: None,
            distinct_by: false,
            excluded_ids: Vec::new(),
        }
    }

    fn schema() -> SchemaInput {
        SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "User".to_string(),
                fields: vec![field("b"), field("a")],
            }],
            enums: vec![EnumInput {
                name: "Role".to_string(),
                cases: vec!["admin".to_string(), "user".to_string()],
            }],
            operations: vec![OperationInput {
                name: "create".to_string(),
                inputs: vec![field("name")],
                mutation: true,
            }],
            aliases: Vec::new(),
        }
    }

    fn union_schema() -> SchemaInput {
        let mut pick = field("pick");
        pick.base = TypeBase::Union {
            arms: vec!["A".to_string(), "B".to_string()],
        };
        SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "Choice".to_string(),
                fields: vec![pick],
            }],
            enums: vec![],
            operations: vec![],
            aliases: Vec::new(),
        }
    }

    #[test]
    fn owner_scope_strings_are_copied_and_gated() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        assert_eq!(plans.live_count(&owner).unwrap(), 0);
        let mut bad = scope();
        bad.backend = String::new();
        assert_eq!(
            plans.create_owner(bad, 8).unwrap_err().code,
            PlanCode::ForeignOwner
        );
    }

    #[test]
    fn registration_assigns_ids_and_preserves_order() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let id = plans
            .register(&owner, "values/v1", &schema(), Some(&provenance()))
            .unwrap();
        assert_eq!(id, "plan:v1:values:native:artifact-1:g0:0");
        let plan = plans.get(&owner, &id).unwrap();
        assert_eq!(plan.error_projection, "values/v1");
        assert_eq!(plan.contract_order, vec!["User".to_string()]);
        assert_eq!(
            plan.contracts[0].allowed,
            vec!["b".to_string(), "a".to_string()]
        );
        assert_eq!(
            plan.contracts[0].required,
            vec!["b".to_string(), "a".to_string()]
        );
        assert_eq!(
            plan.enums[0].cases,
            vec!["admin".to_string(), "user".to_string()]
        );
        assert!(plan.operations[0].mutation);
        // Caller mutation after registration cannot reach the plan:
        // inputs are owned values, so there is nothing to alias.
        assert_eq!(plans.live_count(&owner).unwrap(), 1);
    }

    #[test]
    fn registration_gates_run_in_order() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let prov = provenance();
        assert_eq!(
            plans
                .register(&owner, "", &schema(), Some(&prov))
                .unwrap_err()
                .code,
            PlanCode::InvalidProfile
        );
        assert_eq!(
            plans
                .register(
                    &owner,
                    "v",
                    &SchemaInput::LegacyWrapper("s".to_string()),
                    Some(&prov)
                )
                .unwrap_err()
                .code,
            PlanCode::LegacyWrapper
        );
        assert_eq!(
            plans
                .register(&owner, "v", &schema(), None)
                .unwrap_err()
                .code,
            PlanCode::MissingProvenance
        );
        let stale = Provenance {
            factory: "normalizeSchema".to_string(),
            owner_rev: "artifact-9".to_string(),
        };
        assert_eq!(
            plans
                .register(&owner, "v", &schema(), Some(&stale))
                .unwrap_err()
                .code,
            PlanCode::StaleScope
        );
        let proto = field("__proto__");
        let bad = SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "C".to_string(),
                fields: vec![proto],
            }],
            enums: vec![],
            operations: vec![],
            aliases: Vec::new(),
        };
        assert_eq!(
            plans
                .register(&owner, "v", &bad, Some(&prov))
                .unwrap_err()
                .code,
            PlanCode::MalformedSchema
        );
        let mut claimed = field("x");
        claimed.has_default = true;
        let bad_default = SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "C".to_string(),
                fields: vec![claimed],
            }],
            enums: vec![],
            operations: vec![],
            aliases: Vec::new(),
        };
        assert_eq!(
            plans
                .register(&owner, "v", &bad_default, Some(&prov))
                .unwrap_err()
                .code,
            PlanCode::MalformedSchema
        );
    }

    #[test]
    fn defaults_resolve_with_stable_identity() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let mut with_default = field("n");
        with_default.has_default = true;
        with_default.default = Some(Meta::NumBits(1.0_f64.to_bits()));
        let input = SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "C".to_string(),
                fields: vec![with_default],
            }],
            enums: vec![],
            operations: vec![],
            aliases: Vec::new(),
        };
        let id = plans
            .register(&owner, "v", &input, Some(&provenance()))
            .unwrap();
        let plan = plans.get(&owner, &id).unwrap();
        let reference = plan.contracts[0].fields[0].default_ref.clone().unwrap();
        let first = plans.resolve_default(&owner, &reference).unwrap() as *const Meta;
        let second = plans.resolve_default(&owner, &reference).unwrap() as *const Meta;
        assert_eq!(first, second);
        assert_eq!(
            plans.resolve_default(&owner, &reference).unwrap(),
            &Meta::NumBits(1.0_f64.to_bits())
        );
        let forged = DefaultRef {
            key: "9:contracts.C.fields.n".to_string(),
        };
        assert_eq!(
            plans.resolve_default(&owner, &forged).unwrap_err().code,
            PlanCode::UnknownDefault
        );
        // N3: a held default reference survives retirement with the
        // same stable identity (the plan handle itself goes stale,
        // but content resolution is generation-blind).
        plans.retire_generation(&owner).unwrap();
        assert_eq!(
            plans.get(&owner, &id).unwrap_err().code,
            PlanCode::InactiveGeneration
        );
        let after = plans.resolve_default(&owner, &reference).unwrap() as *const Meta;
        assert_eq!(first, after);
    }

    #[test]
    fn retired_plans_occupy_the_bound_until_release() {
        // N2 record: retirement never frees bound here (the TS half
        // reclaims its live set on retire); only release removes.
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 1).unwrap();
        let first = plans
            .register(&owner, "v", &schema(), Some(&provenance()))
            .unwrap();
        plans.retire_generation(&owner).unwrap();
        assert_eq!(plans.live_count(&owner).unwrap(), 1);
        assert_eq!(
            plans
                .register(&owner, "v", &schema(), Some(&provenance()))
                .unwrap_err()
                .code,
            PlanCode::RegistryFull
        );
        plans.release(&owner, &first);
        assert_eq!(plans.live_count(&owner).unwrap(), 0);
        plans
            .register(&owner, "v", &schema(), Some(&provenance()))
            .unwrap();
    }

    #[test]
    fn undefined_is_a_storable_explicit_default() {
        // N4: explicit-undefined fills register and resolve; only the
        // absence of has_default means "no default".
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let mut maybe = field("maybe");
        maybe.has_default = true;
        maybe.default = Some(Meta::Undefined);
        let input = SchemaInput::Normalized {
            contracts: vec![ContractInput {
                name: "C".to_string(),
                fields: vec![maybe, field("plain")],
            }],
            enums: vec![],
            operations: vec![],
            aliases: Vec::new(),
        };
        let id = plans
            .register(&owner, "v", &input, Some(&provenance()))
            .unwrap();
        let plan = plans.get(&owner, &id).unwrap();
        assert!(plan.contracts[0].fields[1].default_ref.is_none());
        let reference = plan.contracts[0].fields[0].default_ref.clone().unwrap();
        assert_eq!(
            plans.resolve_default(&owner, &reference).unwrap(),
            &Meta::Undefined
        );
    }

    #[test]
    fn union_dispatch_resolves_once() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let id = plans
            .register(&owner, "v", &union_schema(), Some(&provenance()))
            .unwrap();
        let path = "contracts.Choice.fields.pick";
        let first = plans.dispatch_arms(&owner, &id, path).unwrap();
        assert_eq!(first, &["A".to_string(), "B".to_string()]);
        let second = plans.dispatch_arms(&owner, &id, path).unwrap();
        assert_eq!(first.as_ptr(), second.as_ptr());
        assert_eq!(
            plans
                .dispatch_arms(&owner, &id, "contracts.Choice.fields.nope")
                .unwrap_err()
                .code,
            PlanCode::UnknownDispatch
        );
    }

    #[test]
    fn registration_is_bounded_and_malformed_consumes_nothing() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 1).unwrap();
        let prov = provenance();
        assert_eq!(
            plans
                .register(
                    &owner,
                    "v",
                    &SchemaInput::LegacyWrapper("s".to_string()),
                    Some(&prov)
                )
                .unwrap_err()
                .code,
            PlanCode::LegacyWrapper
        );
        plans.register(&owner, "v", &schema(), Some(&prov)).unwrap();
        assert_eq!(
            plans
                .register(&owner, "v", &schema(), Some(&prov))
                .unwrap_err()
                .code,
            PlanCode::RegistryFull
        );
    }

    #[test]
    fn release_is_idempotent_and_handles_fail_closed() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let id = plans
            .register(&owner, "v", &schema(), Some(&provenance()))
            .unwrap();
        plans.release(&owner, "plan:v1:values:native:artifact-1:g0:7");
        plans.release(&owner, "not-a-plan");
        assert_eq!(plans.live_count(&owner).unwrap(), 1);
        plans.release(&owner, &id);
        plans.release(&owner, &id);
        assert_eq!(plans.live_count(&owner).unwrap(), 0);
        assert_eq!(
            plans.get(&owner, &id).unwrap_err().code,
            PlanCode::UnknownPlan
        );
        for bad in ["nope", "plan:a", "plan:a:b:c:d:gX:0", "plan:a:b:c:d:g0:zz"] {
            assert_eq!(
                plans.get(&owner, bad).unwrap_err().code,
                PlanCode::UnknownPlan,
                "{bad}"
            );
        }
    }

    #[test]
    fn generation_retirement_invalidates_without_eviction() {
        let mut plans = Plans::default();
        let owner = plans.create_owner(scope(), 8).unwrap();
        let first = plans
            .register(&owner, "v", &schema(), Some(&provenance()))
            .unwrap();
        assert_eq!(plans.retire_generation(&owner).unwrap(), 1);
        assert_eq!(
            plans.get(&owner, &first).unwrap_err().code,
            PlanCode::InactiveGeneration
        );
        // Retired plans are not evicted: only release removes.
        assert_eq!(plans.live_count(&owner).unwrap(), 1);
        let second = plans
            .register(&owner, "v", &schema(), Some(&provenance()))
            .unwrap();
        assert_eq!(second, "plan:v1:values:native:artifact-1:g1:1");
        plans.get(&owner, &second).unwrap();
        assert_eq!(
            plans.get(&owner, &first).unwrap_err().code,
            PlanCode::InactiveGeneration
        );
    }

    #[test]
    fn handles_never_cross_owners() {
        let mut plans = Plans::default();
        let first = plans.create_owner(scope(), 8).unwrap();
        let mut other_scope = scope();
        other_scope.backend = "worker".to_string();
        let second = plans.create_owner(other_scope, 8).unwrap();
        let id = plans
            .register(&first, "v", &schema(), Some(&provenance()))
            .unwrap();
        assert_eq!(
            plans.get(&second, &id).unwrap_err().code,
            PlanCode::UnknownPlan
        );
    }
}
