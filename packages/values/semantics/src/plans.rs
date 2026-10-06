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
            // Shape gates (reserved names, default presence) run before
            // the bound so malformed input never consumes capacity.
            Self::check_schema(contracts, enums, operations)?;
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
                fields.push(FieldPlan {
                    name: field.name.clone(),
                    type_id: field.type_id.clone(),
                    base: field.base.clone(),
                    array: field.array,
                    nullable: field.nullable,
                    required_array: field.required_array,
                    required: field.required,
                    has_default: field.has_default,
                    default_ref,
                    length_min: field.length_min,
                    length_max: field.length_max,
                    value_min: field.value_min.clone(),
                    value_max: field.value_max.clone(),
                    trim: field.trim,
                    server_only: field.server_only,
                    default_origin: field.default_origin.clone(),
                    refs: type_refs(&field.base),
                });
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
                inputs.push(FieldPlan {
                    name: field.name.clone(),
                    type_id: field.type_id.clone(),
                    base: field.base.clone(),
                    array: field.array,
                    nullable: field.nullable,
                    required_array: field.required_array,
                    required: field.required,
                    has_default: field.has_default,
                    default_ref,
                    length_min: field.length_min,
                    length_max: field.length_max,
                    value_min: field.value_min.clone(),
                    value_max: field.value_max.clone(),
                    trim: field.trim,
                    server_only: field.server_only,
                    default_origin: field.default_origin.clone(),
                    refs: type_refs(&field.base),
                });
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
            dispatch,
        };
        state.plans.push(Some(plan));
        Ok(id)
    }

    fn check_schema(
        contracts: &[ContractInput],
        enums: &[EnumInput],
        operations: &[OperationInput],
    ) -> Result<(), PlanError> {
        for contract in contracts {
            reject_reserved("contract", &contract.name)?;
            for field in &contract.fields {
                reject_reserved("field", &field.name)?;
                if field.has_default && field.default.is_none() {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "field {}.{} claims a default it lacks",
                            contract.name, field.name
                        ),
                    ));
                }
            }
        }
        for enum_def in enums {
            reject_reserved("enum", &enum_def.name)?;
        }
        for operation in operations {
            reject_reserved("operation", &operation.name)?;
            for field in &operation.inputs {
                reject_reserved("input", &field.name)?;
                if field.has_default && field.default.is_none() {
                    return Err(PlanError::new(
                        PlanCode::MalformedSchema,
                        format!(
                            "input {}.{} claims a default it lacks",
                            operation.name, field.name
                        ),
                    ));
                }
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
    /// evicted (release stays the only removal).
    pub fn retire_generation(&mut self, owner: &OwnerToken) -> Result<u64, PlanError> {
        let state = self.state_mut(owner)?;
        state.generation += 1;
        Ok(state.generation)
    }

    /// Live plan count (retired plans still occupy slots until release).
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
