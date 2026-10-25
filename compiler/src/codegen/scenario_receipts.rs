//! Match complete checked disclosure paths to actual executable native IR sites.
//! This helper never activates capture or publishes a plan on its own.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::analysis::scenario_disclosure::{
    DependencyRole, DisclosureChoice, DisclosureEffect, DisclosureEffectKind,
    DisclosureIntrinsicKind, DisclosureModelResult, DisclosureSource, InfluenceKind,
    ScenarioDisclosure,
};
use crate::analysis::{NodeKey, ResolvedType, Scalar};
use crate::source::{SourceDb, Span, sha256_hex};
use crate::syntax::{SyntaxKind, SyntaxNode};

use super::ir::{
    IrBinOp, IrCallTarget, IrDefault, IrDeleteMode, IrEffectCallTarget, IrExpr, IrGuard, IrItem,
    IrItemKind, IrOwner, IrProgram, IrQuery, IrStmt, IrType, TypedExpr,
};
use super::js::{JsFieldDefault, JsModel, JsModelField, JsModelFieldType, JsValueTypes};
use super::send_guards::PreparedSendGuard;

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptSource {
    pub path: String,
    pub sha256: String,
    pub module: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptDisclosurePlan {
    /// Private nongrant SEND source frame; never a public return recipe.
    #[serde(
        rename = "retainedGuardedHandler",
        skip_serializing_if = "Option::is_none"
    )]
    pub retained_guarded_handler: Option<serde_json::Value>,
    #[serde(rename = "sourceLoops", skip_serializing_if = "Option::is_none")]
    pub source_loops: Option<serde_json::Value>,
    #[serde(rename = "sourceEmissions", skip_serializing_if = "Option::is_none")]
    pub source_emissions: Option<serde_json::Value>,
    pub version: u8,
    pub source: ReceiptSource,
    /// Complete checked event owner-decision profile, when this plan is an event receipt.
    #[serde(rename = "eventDecision", skip_serializing_if = "Option::is_none")]
    pub event_decision: Option<serde_json::Value>,
    /// Complete checked owner decision for the exact term creation flow.
    #[serde(rename = "termDecision", skip_serializing_if = "Option::is_none")]
    pub term_decision: Option<serde_json::Value>,
    /// Complete source-bound owner decision for bounded leave request creation.
    #[serde(
        rename = "leaveRequestDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub leave_request_decision: Option<serde_json::Value>,
    /// Source-bound serial owner decision for leave approval/rejection.
    #[serde(
        rename = "leaveDecideDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub leave_decide_decision: Option<serde_json::Value>,
    /// Source-stamped serial owner decision for referral source reversal.
    #[serde(
        rename = "referRejectDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub refer_reject_decision: Option<serde_json::Value>,
    /// Complete source-bound retry charge and term update in one serial owner frame.
    #[serde(
        rename = "memberRetryDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub member_retry_decision: Option<serde_json::Value>,
    /// Exact movement-credit refund branch and its complete owner domains.
    #[serde(
        rename = "rentMovementRefundDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub rent_movement_refund_decision: Option<serde_json::Value>,
    /// Exact collection owner, financial scans, guarded dispatch and settlement.
    #[serde(
        rename = "invoiceCollectDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub invoice_collect_decision: Option<serde_json::Value>,
    /// Exact correspondence/reminder Booking notice owner and localized text sinks.
    #[serde(rename = "rentNoticeDecision", skip_serializing_if = "Option::is_none")]
    pub rent_notice_decision: Option<serde_json::Value>,
    #[serde(
        rename = "invoiceIssueDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub invoice_issue_decision: Option<serde_json::Value>,
    #[serde(
        rename = "observeVenueDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub observe_venue_decision: Option<serde_json::Value>,
    /// Exact source-bound renewal reminder SEND owner with its staged rule.
    #[serde(
        rename = "successRenewalDecision",
        skip_serializing_if = "Option::is_none"
    )]
    pub success_renewal_decision: Option<serde_json::Value>,
    #[serde(rename = "purchaseReceiveAll", skip_serializing_if = "Option::is_none")]
    pub purchase_receive_all: Option<serde_json::Value>,
    #[serde(rename = "eventNoticeAudit", skip_serializing_if = "Option::is_none")]
    pub event_notice_audit: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub queries: Vec<ReceiptQuery>,
    pub returns: Vec<ReceiptReturn>,
}

/// Emission layout of an already collected owner decision. The source-specific
/// collectors still prove the whole body; this layout grants no receipt or role.
pub(super) struct OwnerDecisionBody {
    pub decision: serde_json::Value,
    pub runtime: &'static str,
    pub context: &'static str,
    pub parameters: &'static [&'static str],
    pub guards: usize,
    pub effects: usize,
    pub admission: OwnerDecisionAdmission,
    pub first_defaults: bool,
    /// These owners explicitly route original guards through the shared observer.
    /// Other complete owner bodies retain their private guard consumers.
    pub source_guard_bridge: bool,
    /// A header-only bridge leaves the owner's financial guard/query ledger intact.
    pub source_guard_site: Option<(u32, u32)>,
    pub missing_body: &'static str,
}

#[derive(Clone, Copy)]
pub(super) enum OwnerDecisionAdmission {
    None,
    Original,
    Role {
        name: &'static str,
        missing: &'static str,
    },
}

impl ReceiptDisclosurePlan {
    pub(super) fn owner_body(&self, canonical: &str) -> Option<OwnerDecisionBody> {
        use OwnerDecisionAdmission::{None as NoAdmission, Original, Role};
        let missing = "the exact authored body is missing";
        let (
            decision,
            runtime,
            context,
            parameters,
            guards,
            effects,
            admission,
            first_defaults,
            missing_body,
        ): (_, _, _, &'static [&'static str], _, _, _, _, _) = match canonical {
            "rent_reservations.correspondence" | "rent_reservations.remind" => (
                self.rent_notice_decision.as_ref()?,
                "nativeScenarioRentNoticeDecision",
                "booking notice owner decision",
                &["event"],
                1,
                if canonical == "rent_reservations.correspondence" {
                    3
                } else {
                    4
                },
                NoAdmission,
                false,
                "the exact authored event body is missing",
            ),
            "invoice.issue" => (
                self.invoice_issue_decision.as_ref()?,
                "nativeScenarioInvoiceIssueDecision",
                "invoice issue owner decision",
                &["invoice", "number"],
                2,
                7,
                Original,
                true,
                "the exact authored defaults stage is missing",
            ),
            "invoice.collect" => (
                self.invoice_collect_decision.as_ref()?,
                "nativeScenarioInvoiceCollectDecision",
                "invoice collection owner decision",
                &["invoice"],
                2,
                7,
                Original,
                false,
                missing,
            ),
            "rent_reservations.refund_movement_credit" => (
                self.rent_movement_refund_decision.as_ref()?,
                "nativeScenarioRentMovementRefundDecision",
                "movement-credit refund owner decision",
                &["movement", "charge_source", "amount", "reason"],
                2,
                2,
                Role {
                    name: "rent_reservations.billing",
                    missing: "the original billing admission is missing",
                },
                false,
                missing,
            ),
            "refer.reject_source" => (
                self.refer_reject_decision.as_ref()?,
                "nativeScenarioReferRejectDecision",
                "referral rejection owner decision",
                &["evidence", "reason"],
                1,
                3,
                Role {
                    name: "refer.program_manager",
                    missing: "the original role admission is missing",
                },
                false,
                missing,
            ),
            "member_terms.retry_collection" => (
                self.member_retry_decision.as_ref()?,
                "nativeScenarioMemberRetryDecision",
                "member retry owner decision",
                &["term"],
                2,
                4,
                Original,
                false,
                missing,
            ),
            "leave.decide" => (
                self.leave_decide_decision.as_ref()?,
                "nativeScenarioLeaveDecideDecision",
                "leave decide owner decision",
                &["request", "approve", "reason"],
                1,
                2,
                NoAdmission,
                false,
                missing,
            ),
            "leave.request" => (
                self.leave_request_decision.as_ref()?,
                "nativeScenarioLeaveRequestDecision",
                "leave request owner decision",
                &["calendar", "from", "until", "bucket", "reason", "reviewer"],
                3,
                6,
                NoAdmission,
                false,
                missing,
            ),
            _ => return None,
        };
        let source_guard_site = if self.rent_movement_refund_decision.is_some() {
            let node = decision.get("membershipSite")?.get("node")?;
            Some((
                u32::try_from(node.get("start")?.as_u64()?).ok()?,
                u32::try_from(node.get("end")?.as_u64()?).ok()?,
            ))
        } else {
            None
        };
        Some(OwnerDecisionBody {
            decision: decision.clone(),
            runtime,
            context,
            parameters,
            guards,
            effects,
            admission,
            first_defaults,
            source_guard_bridge: self.invoice_collect_decision.is_some()
                || self.invoice_issue_decision.is_some()
                || self.leave_decide_decision.is_some()
                || self.rent_movement_refund_decision.is_some(),
            source_guard_site,
            missing_body,
        })
    }
}

/// Budget only complete, source-checked contained loops whose sole effect
/// is emitting their exactly typed item. This data grants no scan by itself.
pub(super) fn checked_source_emissions(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    entry: &str,
) -> Option<serde_json::Value> {
    let mut loops = Vec::new();
    let mut emitted = HashSet::new();
    let mut total = 0u16;
    for proof in &checked.effects {
        let DisclosureEffectKind::ForMember {
            domain,
            maximum,
            parameter,
            model,
            body,
            ..
        } = &proof.kind
        else {
            continue;
        };
        let [body_node] = body.as_slice() else {
            continue;
        };
        let Some(emit) = checked
            .effects
            .iter()
            .find(|candidate| candidate.node == *body_node)
        else {
            continue;
        };
        let DisclosureEffectKind::Emit { event } = emit.kind else {
            continue;
        };
        total = total.checked_add(*maximum)?;
        if total > 500 {
            return None;
        }
        emitted.insert(*body_node);
        let parameter = ir.items.get(parameter.0 as usize)?;
        let IrItemKind::Param {
            ty:
                IrType::Known(ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                }),
            default: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let event_name = &ir.items.get(event.0 as usize)?.canonical;
        let handlers = ir
            .items
            .iter()
            .filter(|item| {
                matches!(&item.kind,IrItemKind::Scenario {
            event_source:Some(super::ir::IrEventSource::Declared(name)),..} if name==event_name)
            })
            .collect::<Vec<_>>();
        if handlers.len() > 1
            || handlers.iter().any(|item| {
                !matches!(
                    &item.kind,
                    IrItemKind::Scenario {
                        cohort: None,
                        hook: None,
                        ..
                    }
                )
            })
        {
            return None;
        }
        let handler = handlers.first().map(|item| item.canonical.as_str());
        let id = sha256_hex(
            format!(
                "{}:{}:{}:{}",
                checked.source.sha256, owner.canonical, proof.node.start, proof.node.end
            )
            .as_bytes(),
        );
        loops.push(serde_json::json!({"id":id,"node":{"start":proof.node.start,"end":proof.node.end},
            "domain":{"start":domain.start,"end":domain.end},"maximum":maximum,
            "parameter":parameter.name,"parentModel":ir.items.get(parent.0 as usize)?.canonical,
            "model":ir.items.get(model.0 as usize)?.canonical,"event":event_name,"handler":handler}));
    }
    if loops.is_empty()
        || checked.effects.iter().any(|proof| {
            matches!(proof.kind, DisclosureEffectKind::Emit { .. })
                && !emitted.contains(&proof.node)
        })
    {
        return None;
    }
    Some(
        serde_json::json!({"source":transport_source(&checked.source,entry)?,"owner":owner.canonical,"loops":loops}),
    )
}

/// Apply an already authenticated borrowed subset; preserve surviving rows
/// verbatim and retain the existing transport capacity.
pub(super) fn project_plan_returns(
    plan: &mut ReceiptDisclosurePlan,
    returned: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
) -> Option<()> {
    if returned.is_empty() || returned.len() > 200 {
        return None;
    }
    plan.returns
        .retain(|row| returned.iter().any(|original| original.id == row.id));
    if plan.returns.len() != returned.len()
        || plan
            .returns
            .iter()
            .zip(returned)
            .any(|(row, original)| row.id != original.id)
    {
        return None;
    }
    let nodes = query_plan_nodes(
        plan.queries.len(),
        plan.returns.iter().map(|row| {
            (
                row.influences.len(),
                row.dependencies.len(),
                row.dependencies
                    .iter()
                    .filter(|read| read.query_id.is_some())
                    .count(),
                row.intrinsics.len(),
            )
        }),
    )?;
    if nodes > 20_000 {
        return None;
    }
    Some(())
}

/// Shared accounting for the existing closed native query-plan transport.
/// The source feasibility owner counts original rows; emission counts DTO rows.
pub(super) fn query_plan_nodes(
    query_count: usize,
    returns: impl IntoIterator<Item = (usize, usize, usize, usize)>,
) -> Option<usize> {
    returns.into_iter().try_fold(
        7usize.checked_add(40usize.checked_mul(query_count)?)?,
        |nodes, (influences, dependencies, linked, intrinsics)| {
            nodes.checked_add(
                9usize
                    .checked_add(5usize.checked_mul(influences)?)?
                    .checked_add(10usize.checked_mul(dependencies)?)?
                    .checked_add(linked)?
                    .checked_add(16usize.checked_mul(intrinsics)?)?,
            )
        },
    )
}

/// Original source and the independently prepared guards/query plan consumed
/// together by the native receipt matcher. This is private compiler input.
pub(super) struct NativeReceiptSources<'a> {
    pub source_context: Option<&'a super::source_context::FreshSourceContext<'a>>,
    pub db: Option<&'a SourceDb>,
    pub send_guards: Option<&'a HashMap<Span, PreparedSendGuard>>,
    pub query_plan: Option<&'a ReceiptDisclosurePlan>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQuery {
    pub id: String,
    pub source: ReceiptSource,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ReceiptQueryParent>,
    pub order: Vec<ReceiptQueryOrder>,
    pub limit: Option<u16>,
    pub archived: String,
    pub dependencies: Vec<ReceiptQueryDependency>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryParent {
    pub source: ReceiptSource,
    pub model: String,
    pub origin: ReceiptQueryParentOrigin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(super) enum ReceiptQueryParentOrigin {
    AdmittedReference {
        parameter: String,
    },
    StoredReference {
        #[serde(rename = "dependencyId")]
        dependency_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryOrder {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryDependency {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    pub field: String,
    #[serde(rename = "type")]
    pub type_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryProjection {
    pub kind: String,
    #[serde(rename = "queryId")]
    pub query_id: String,
    pub source: ReceiptSource,
    pub fields: Vec<ReceiptQueryProjectionField>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptQueryProjectionField {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptReturn {
    pub id: String,
    pub source: ReceiptSource,
    pub influences: Vec<ReceiptInfluence>,
    pub dependencies: Vec<ReceiptDependency>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub intrinsics: Vec<ReceiptIntrinsic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<ReceiptQueryProjection>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptInfluence {
    pub id: String,
    pub kind: String,
    #[serde(rename = "queryId", skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ReceiptRole {
    Data,
    Control,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptDependency {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    pub model: String,
    pub field: String,
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(rename = "queryId", skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptIntrinsic {
    pub id: String,
    pub source: ReceiptSource,
    pub role: ReceiptRole,
    #[serde(rename = "type")]
    pub type_id: String,
    #[serde(flatten)]
    pub kind: NativeIntrinsicKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(super) enum NativeIntrinsicKind {
    CreatedModelVersion { created: serde_json::Value },
    OperationId,
    AdmittedInput { parameter: String },
    AdmittedReferenceVersion { parameter: String, model: String },
}

#[derive(Debug, Clone)]
pub(super) struct NativeIntrinsic {
    pub id: String,
    pub kind: NativeIntrinsicKind,
}

#[derive(Debug, Clone)]
pub(super) struct NativeDependency {
    pub id: String,
    pub model: String,
    pub field: String,
    /// Original observed reference paired with this scalar read; private
    /// lowering input, never part of the transported disclosure plan.
    pub source_dependency_id: Option<String>,
    /// This exact source alias was promoted when its original Let getter ran.
    pub captured_reference: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeDecisionKind {
    ParameterDefault,
    OptionalInput(crate::analysis::SymbolId),
    QuerySelection,
    If,
    For,
    Match,
    And,
    Or,
    Coalesce,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct NativeSite {
    pub calls: Vec<Span>,
    pub span: Span,
    /// Omission and the default expression's own decision may share a span.
    pub default_selection: bool,
}

#[derive(Debug, Clone)]
pub(super) struct NativeReturn {
    pub id: String,
    pub span: Span,
    pub decisions: Vec<(String, DisclosureChoice)>,
    pub implicit: bool,
    /// Observe target identity on the genuine result view. Stored references
    /// first promote their once-read source; admitted Contract slots already
    /// carry their exact native view.
    pub reference_result: Option<NativeDependency>,
}

#[derive(Debug, Clone)]
pub(super) struct NativeScenarioReceipt {
    pub plan: ReceiptDisclosurePlan,
    /// One observation site may supply both data and control identities.
    pub dependencies: HashMap<NativeSite, Vec<NativeDependency>>,
    pub intrinsics: HashMap<NativeSite, Vec<NativeIntrinsic>>,
    pub decisions: HashMap<NativeSite, NativeDecisionKind>,
    pub decision_keys: HashMap<NativeSite, String>,
    pub calls: HashMap<NativeSite, String>,
    pub returns: Vec<NativeReturn>,
    /// Private original occurrence join, never a transported recipe field.
    pub current_revision: Option<NativeCurrentRevision>,
}

#[derive(Debug, Clone)]
pub(super) struct NativeCurrentRevision {
    pub template: String,
    pub revision: String,
    pub parameter: String,
    pub published_source: Span,
    pub published: Span,
    pub retained_source: Span,
    pub digest_control: Span,
    pub digest_data: Span,
    pub outputs: Span,
    pub duration: Span,
    pub published_source_id: String,
    pub published_id: String,
    pub retained_control_id: String,
    pub retained_data_id: String,
    pub digest_control_id: String,
    pub digest_data_id: String,
    pub outputs_id: String,
    pub duration_id: String,
}

impl NativeCurrentRevision {
    fn from_sites(
        sites: &super::scenario_current_revision::CurrentRevisionSites<'_>,
    ) -> Option<Self> {
        if !matches!(sites.revision_statement, IrStmt::Let { value, .. }
            if std::ptr::eq(value, sites.revision_read.value))
            || sites.active.as_ref().is_some_and(|active| {
                active.value.span.end > sites.presence.span.start
                    || active.dependency.role != DependencyRole::Control
                    || active.dependency.node.end > sites.presence_read.control.node.start
            })
            || sites.presence.span.start > sites.presence_read.value.span.start
            || sites.presence.span.end < sites.presence_read.value.span.end
            || sites.digest_presence.span.start > sites.digest_control.value.span.start
            || sites.digest_presence.span.end < sites.digest_control.value.span.end
        {
            return None;
        }
        Some(Self {
            template: sites.template.canonical.clone(),
            revision: sites.revision.canonical.clone(),
            parameter: sites.parameter.name.clone(),
            published_source: sites.published_read.value.span,
            published: sites.published.value.span,
            retained_source: sites.revision_read.value.span,
            digest_control: sites.digest_control.value.span,
            digest_data: sites.digest_data.value.span,
            outputs: sites.outputs.value.span,
            duration: sites.duration.value.span,
            published_source_id: sites.published_read.control.id.clone(),
            published_id: sites.published.dependency.id.clone(),
            retained_control_id: sites.revision_read.control.id.clone(),
            retained_data_id: sites.revision_read.data?.id.clone(),
            digest_control_id: sites.digest_control.dependency.id.clone(),
            digest_data_id: sites.digest_data.dependency.id.clone(),
            outputs_id: sites.outputs.dependency.id.clone(),
            duration_id: sites.duration.dependency.id.clone(),
        })
    }
}

/// Nongrant checked result provenance. The owning receipt collector still
/// seals the actual executable effects, source, descriptors and return sites.
pub(super) fn has_original_created_model_result(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    if ir
        .committed_sources
        .requires_native_model_result(scenario.0 as usize)
    {
        return true;
    }
    let Some(disclosure) = ir.scenario_disclosures.get(&scenario) else {
        return false;
    };
    let Some(facts) = disclosure.source_facts() else {
        return false;
    };
    let Some(ResolvedType::Record {
        symbol: model,
        stored: true,
    }) = &facts.result
    else {
        return false;
    };
    if facts.scenario != scenario || facts.read {
        return false;
    }
    if let ScenarioDisclosure::Complete(checked) = disclosure {
        return checked.scenario == scenario
            && facts.node == checked.node
            && facts.source == checked.source
            && !checked.returns.is_empty()
            && checked.returns.iter().all(|returned| {
                returned.source == checked.source
                    && returned
                        .model_result
                        .is_some_and(|origin| origin.model() == *model)
            });
    }
    // Keep this pair's native source requirement when a copied binding or
    // unsupported continuation prevents its complete provenance proof. The
    // immutable constructor/count census supplies no executable recipe.
    let Some([first, second]) = facts.creates.as_deref() else {
        return false;
    };
    first.model == *model
        && second.model != first.model
        && first.source == facts.source
        && second.source == facts.source
        && first.node.file == second.node.file
        && first.node.end <= second.node.start
        && facts.queries.as_deref().is_some_and(|queries| {
            queries.iter().any(|query| {
                query.source == facts.source
                    && query.model == second.model
                    && query.count.as_ref().is_some_and(|count| {
                        count.statement == second.node && count.contained_parent.is_some()
                    })
            })
        })
}

/// Retain the original dispatch requirement even if editable executable SEND
/// IR no longer contains its predicate. A missing sealed Rule is not a plain SEND.
pub(super) fn has_original_guarded_send(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    ir.scenario_disclosures
        .get(&scenario)
        .is_some_and(|disclosure| {
            matches!(disclosure, ScenarioDisclosure::Complete(checked)
                if checked.effects.iter().any(|effect| matches!(effect.kind,
                    DisclosureEffectKind::Send { when: Some(_), .. })))
                || disclosure.source_facts().is_some_and(|facts| {
                    facts.decision_sites.as_ref().is_some_and(|sites| {
                        sites.iter().any(|site| {
                            site.owner == scenario
                                && site.stage
                                    == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
                        })
                    })
                })
        })
}

/// Retain this original source requirement independently of editable effects
/// or owner IDs. The private census carries checked catalog identities.
pub(super) fn has_original_images_source(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    let Some(facts) = ir
        .scenario_disclosures
        .get(&scenario)
        .and_then(|value| value.source_facts())
    else {
        return false;
    };
    let Some(types) = facts.expression_types.as_deref() else {
        return false;
    };
    ["ImageRequest", "WorkflowDefinition"].iter().all(|name| {
        types
            .iter()
            .any(|(_, ty)| crate::analysis::types::checked_standard_nominal_name(ty) == Some(*name))
    })
}

/// Original transcript attribution is source evidence only. Its native query
/// and stored-message consumer must be released before a recipe can be emitted.
pub(super) fn has_original_transcript_source(
    ir: &IrProgram,
    scenario: crate::analysis::SymbolId,
) -> bool {
    ir.scenario_disclosures
        .get(&scenario)
        .and_then(|disclosure| disclosure.source_facts())
        .and_then(|facts| facts.transcripts.as_deref())
        .is_some_and(|transcripts| !transcripts.is_empty())
}

fn result_statement_at(effects: &[IrStmt], at: Span) -> Option<&IrStmt> {
    fn collect<'a>(
        effects: &'a [IrStmt],
        at: Span,
        depth: usize,
        found: &mut Vec<&'a IrStmt>,
    ) -> Option<()> {
        if depth > 16 {
            return None;
        }
        for statement in effects {
            match statement {
                IrStmt::Return { span, .. }
                | IrStmt::Create { span, .. }
                | IrStmt::Call { span, .. }
                    if *span == at =>
                {
                    found.push(statement)
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    collect(then_branch, at, depth + 1, found)?;
                    collect(else_branch, at, depth + 1, found)?;
                }
                IrStmt::Match { arms, .. } => {
                    for arm in arms {
                        collect(&arm.body, at, depth + 1, found)?;
                    }
                }
                _ => {}
            }
        }
        Some(())
    }
    let mut found = Vec::new();
    collect(effects, at, 0, &mut found)?;
    (found.len() == 1).then(|| found[0])
}

pub(super) fn checked_created_model_result(
    ir: &IrProgram,
    item: &IrItem,
) -> Option<crate::analysis::SymbolId> {
    fn visit(ir: &IrProgram, item: &IrItem, depth: usize) -> Option<crate::analysis::SymbolId> {
        if depth > 16 {
            return None;
        }
        let IrItemKind::Scenario {
            trusted: false,
            event_source: None,
            hook: None,
            cohort: None,
            read: false,
            expose_excluded: false,
            result:
                Some(ResolvedType::Record {
                    symbol: model,
                    stored: true,
                }),
            effects,
            params,
            ..
        } = &item.kind
        else {
            return None;
        };
        let declaration = ir.items.get(model.0 as usize)?;
        if declaration.id != *model || !matches!(declaration.kind, IrItemKind::Model { .. }) {
            return None;
        }
        let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&item.id)? else {
            return None;
        };
        let facts = checked.source_facts.as_deref()?;
        if checked.scenario != item.id
            || facts.scenario != item.id
            || facts.node != checked.node
            || facts.source != checked.source
            || facts.read
            || facts.result
                != Some(ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                })
            || checked.returns.is_empty()
        {
            return None;
        }
        // Finite first-query slice D (CAN18-v1): whole-row idempotent replay
        // (`if previous!=null ... return previous` alongside a same-model
        // create) for one single-Text-equality id-ordered family. A contained
        // scan retains its original required parent operand and owning schema.
        // All other shapes (including bare `require ...==null` absence and
        // direct `return <first>` without a create) stay refused below.
        let replay_sites = checked
            .returns
            .iter()
            .filter(|returned| returned.model_result.is_none())
            .map(|returned| returned.node)
            .collect::<HashSet<_>>();
        let model_sites = checked
            .returns
            .iter()
            .filter(|returned| returned.model_result.is_some())
            .map(|returned| returned.node)
            .collect::<HashSet<_>>();
        if !replay_sites.is_empty()
            && (replay_sites.len() != 1
                || model_sites.len() != 1
                || !replay_sites.is_disjoint(&model_sites))
        {
            return None;
        }
        for returned in &checked.returns {
            if returned.model_result.is_none() {
                // Whole-row replay return: `return <first-let>` for the same
                // model. The creating return below anchors `model`; this path
                // only proves the replayed row is the admitted first query.
                let IrStmt::Return {
                    value: Some(value), ..
                } = result_statement_at(effects, node_span(returned.node))?
                else {
                    return None;
                };
                if returned.source != checked.source {
                    return None;
                }
                let IrExpr::Name(binding) = &value.expr else {
                    return None;
                };
                if value.ty
                    != (ResolvedType::Record {
                        symbol: *model,
                        stored: true,
                    })
                {
                    return None;
                }
                let queries = facts.queries.as_deref()?;
                let query = if queries.len() == 1 {
                    &queries[0]
                } else {
                    checked_purchase_helper_query_influences(facts)?;
                    queries.iter().find(|query| query.first.is_some())?
                };
                let first = query.first.as_ref()?;
                if query.model != *model
                    || query.count.is_some()
                    || !query.text_keyed_first_replay()
                {
                    return None;
                }
                let (let_name, let_value) =
                    effects.iter().find_map(|statement| match statement {
                        IrStmt::Let { name, value, span } if *span == node_span(first.binding) => {
                            Some((name, value))
                        }
                        _ => None,
                    })?;
                if let_name != binding {
                    return None;
                }
                let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &let_value.expr
                else {
                    return None;
                };
                let [domain] = args.as_slice() else {
                    return None;
                };
                let IrExpr::Query(scan) = &domain.expr else {
                    return None;
                };
                checked_first_query_order(query, scan)?;
                checked_first_query_predicate(ir, item, query, scan)?;
                if let Some((receiver, parameter_id)) = first.contained_parent {
                    let parameter = ir.items.get(parameter_id.0 as usize)?;
                    let IrItemKind::Param {
                        owner: parameter_owner,
                        index,
                        ty: IrType::Known(input_ty),
                        default: None,
                        default_node: None,
                        default_copy_source: None,
                        array_bounds: None,
                        ..
                    } = &parameter.kind
                    else {
                        return None;
                    };
                    let fact = facts.parameters.get(*index)?;
                    let ResolvedType::Record {
                        symbol: input_model,
                        stored: true,
                    } = input_ty
                    else {
                        return None;
                    };
                    let parent = scan.parent.as_deref()?;
                    let parent_model = match &parent.expr {
                        IrExpr::Name(name) if name == &parameter.name && parent.ty == *input_ty => {
                            *input_model
                        }
                        IrExpr::Member { base, field }
                            if field == "parent"
                                && base.ty == *input_ty
                                && matches!(&base.expr, IrExpr::Name(name) if name == &parameter.name) =>
                        {
                            let IrItemKind::Model {
                                owner: super::ir::IrOwner::ChildOf(parent),
                                ..
                            } = &ir.items.get(input_model.0 as usize)?.kind
                            else {
                                return None;
                            };
                            *parent
                        }
                        _ => return None,
                    };
                    let inventory = facts.stored_contracts.as_deref()?;
                    let child = inventory
                        .iter()
                        .find(|schema| schema.model && schema.id == *model)?;
                    let parent_schema = inventory
                        .iter()
                        .find(|schema| schema.model && schema.id == parent_model)?;
                    if *parameter_owner != item.id
                        || params.get(*index) != Some(&parameter_id)
                        || params.iter().filter(|id| **id == parameter_id).count() != 1
                        || parameter.module != item.module
                        || parameter.canonical != format!("{}.{}", item.canonical, parameter.name)
                        || fact.parameter != parameter_id
                        || fact.ty != *input_ty
                        || fact.default.is_some()
                        || fact.constraints.is_some()
                        || parent.span != node_span(receiver)
                        || parent.ty
                            != (ResolvedType::Record {
                                symbol: parent_model,
                                stored: true,
                            })
                        || child.parent != Some(parent_model)
                        || child.owner
                            != Some(crate::analysis::resolve::ModelOwner::ChildOf(parent_model))
                        || !matches!(&declaration.kind, IrItemKind::Model { owner: super::ir::IrOwner::ChildOf(actual), .. } if *actual == parent_model)
                        || child.source != query.source
                        || parent_schema.source != query.source
                        || child.field_order.iter().any(|id| {
                            ir.items
                                .get(id.0 as usize)
                                .is_none_or(|field| field.name == "parent")
                        })
                    {
                        return None;
                    }
                } else if scan.parent.is_some() {
                    return None;
                }
                if first.binding.file != returned.node.file
                    || first.binding.end > returned.node.start
                    || returned.influences.len() != 4
                {
                    return None;
                }
                continue;
            }
            let origin = returned.model_result?;
            if origin.model() != *model || returned.source != checked.source {
                return None;
            }
            let IrStmt::Return {
                value: Some(value), ..
            } = result_statement_at(effects, node_span(returned.node))?
            else {
                return None;
            };
            if let DisclosureModelResult::Reference {
                model: actual,
                node,
                source_model,
                field,
            } = origin
            {
                let IrExpr::Member { base, field: name } = &value.expr else {
                    return None;
                };
                let declared = ir.items.get(field.0 as usize)?;
                let IrItemKind::Field {
                    owner,
                    ty: IrType::Known(ty),
                    default: None,
                    server: None,
                    ..
                } = &declared.kind
                else {
                    return None;
                };
                let target = ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                };
                if actual != *model
                    || *owner != source_model
                    || declared.name != *name
                    || *ty != target
                    || value.ty != target
                    || value.span != node_span(node)
                    || base.ty
                        != (ResolvedType::Record {
                            symbol: source_model,
                            stored: true,
                        })
                    || !returned.dependencies.iter().any(|read| {
                        read.node == node
                            && read.model == source_model
                            && read.field == field
                            && read.ty == target
                            && read.role == DependencyRole::Data
                            && read.calls.is_empty()
                            && read.query_id.is_none()
                    })
                    || !returned.dependencies.iter().any(|read| {
                        read.node == node
                            && read.model == *model
                            && read.field == *model
                            && read.field_name == "id"
                            && read.ty == ResolvedType::Scalar(Scalar::Text)
                            && read.type_id == "text"
                            && read.role == DependencyRole::Data
                            && read.calls.is_empty()
                            && read.query_id.is_none()
                    })
                {
                    return None;
                }
                continue;
            }
            let (node, binding) = match origin {
                DisclosureModelResult::Reference { .. } => unreachable!(),
                DisclosureModelResult::Parameter {
                    model: actual,
                    parameter,
                    node,
                } => {
                    let param = ir.items.get(parameter.0 as usize)?;
                    let IrItemKind::Param {
                        owner: parameter_owner,
                        index,
                        ty: IrType::Known(ty),
                        default: None,
                        default_node: None,
                        default_copy_source: None,
                        array_bounds: None,
                        ..
                    } = &param.kind
                    else {
                        return None;
                    };
                    let fact = facts.parameters.get(*index)?;
                    if matches!(value.expr, IrExpr::Member { .. }) {
                        let (root, _) = checked_contract_parameter_path(ir, item, value, None)?;
                        if actual != *model
                            || root != parameter
                            || value.span != node_span(node)
                            || value.ty
                                != (ResolvedType::Record {
                                    symbol: actual,
                                    stored: true,
                                })
                            || !returned.dependencies.iter().any(|read| {
                                read.node == node
                                    && read.model == actual
                                    && read.field == actual
                                    && read.field_name == "id"
                                    && read.type_id == "text"
                                    && read.role == DependencyRole::Data
                                    && read.calls.is_empty()
                                    && read.query_id.is_none()
                            })
                        {
                            return None;
                        }
                        continue;
                    }
                    if actual != *model
                        || *parameter_owner != item.id
                        || fact.parameter != parameter
                        || fact.default.is_some()
                        || fact.constraints.is_some()
                        || *ty
                            != (ResolvedType::Record {
                                symbol: actual,
                                stored: true,
                            })
                        || !returned.dependencies.iter().any(|dependency| {
                            dependency.node == node
                                && dependency.calls.is_empty()
                                && dependency.query_id.is_none()
                                && dependency.role == DependencyRole::Data
                                && dependency.model == actual
                                && dependency.field == actual
                                && dependency.field_name == "id"
                                && dependency.type_id == "text"
                                && dependency.ty == ResolvedType::Scalar(Scalar::Text)
                        })
                    {
                        return None;
                    }
                    // The parameter declaration precedes its original direct return.
                    (fact.node, &param.name)
                }
                DisclosureModelResult::Create {
                    model: actual,
                    node,
                } => {
                    let proof = checked
                        .effects
                        .iter()
                        .find(|proof| proof.node == node && proof.source == checked.source)?;
                    let DisclosureEffectKind::Create {
                        model: proven,
                        binding,
                        ..
                    } = &proof.kind
                    else {
                        return None;
                    };
                    let IrStmt::Create {
                        model: target,
                        binding: Some(actual_binding),
                        when: None,
                        ..
                    } = result_statement_at(effects, node_span(node))?
                    else {
                        return None;
                    };
                    if actual != *proven
                        || target != &declaration.canonical
                        || binding != actual_binding
                    {
                        return None;
                    }
                    (node, binding)
                }
                DisclosureModelResult::Call {
                    model: actual,
                    node,
                    operation,
                } => {
                    let proof = checked
                        .effects
                        .iter()
                        .find(|proof| proof.node == node && proof.source == checked.source)?;
                    let DisclosureEffectKind::Call {
                        operation: proven, ..
                    } = &proof.kind
                    else {
                        return None;
                    };
                    let IrStmt::Call {
                        target:
                            IrEffectCallTarget::Operation {
                                operation: target, ..
                            },
                        binding: Some(binding),
                        result,
                        ..
                    } = result_statement_at(effects, node_span(node))?
                    else {
                        return None;
                    };
                    let source_call = facts.calls.iter().find(|call| call.node == node)?;
                    if operation != *proven
                        || target != &operation
                        || source_call.operation != operation
                        || source_call.binding.as_ref() != Some(binding)
                        || source_call.result != *result
                        || *result
                            != Some(ResolvedType::Record {
                                symbol: actual,
                                stored: true,
                            })
                        || visit(ir, ir.items.get(operation.0 as usize)?, depth + 1)? != actual
                    {
                        return None;
                    }
                    (node, binding)
                }
            };
            if node.file != returned.node.file
                || node.end > returned.node.start
                || value.ty
                    != (ResolvedType::Record {
                        symbol: *model,
                        stored: true,
                    })
                || !matches!(&value.expr, IrExpr::Name(name) if name == binding)
            {
                return None;
            }
        }
        Some(*model)
    }
    visit(ir, item, 0)
}

/// Private source association for an executed whole-Contract Require read.
/// The query owns the selected receiver, not a candidate dependency slot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReceiptRequireConsumption {
    pub site_index: usize,
    pub query_id: String,
    pub node: ReceiptRequireNode,
    pub dependency: ReceiptDependency,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ReceiptRequireNode {
    pub start: u32,
    pub end: u32,
}

pub(super) struct NativeRequireConsumption {
    pub association: ReceiptRequireConsumption,
    pub site: NativeSite,
    pub observation: NativeDependency,
}

/// Reuse the existing inlined call recipe and original checked slots. These
/// borrowed frames normalize lexical formals; they grant no row authority.
fn find_typed_subtree<'a>(roots: &[&'a TypedExpr], span: Span) -> Option<&'a TypedExpr> {
    let mut pending = roots.to_vec();
    let mut found = None;
    let mut steps = 0;
    while let Some(value) = pending.pop() {
        steps += 1;
        if steps > 16384 {
            return None;
        }
        if value.span == span && found.replace(value).is_some() {
            return None;
        }
        match &value.expr {
            IrExpr::Binary { left, right, .. } => {
                pending.push(right);
                pending.push(left);
            }
            IrExpr::Unary { operand, .. } | IrExpr::Member { base: operand, .. } => {
                pending.push(operand)
            }
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => {
                pending.extend(args.iter().rev())
            }
            _ => {}
        }
    }
    found
}

fn span_inside_node(span: Span, node: crate::analysis::NodeKey) -> bool {
    span.file == node.file && span.start >= node.start && span.end <= node.end
}

struct RequireHelperFrame<'a> {
    derive: &'a IrItem,
    source: &'a crate::analysis::scenario_disclosure::CheckedDecisionCall,
    arguments: &'a [TypedExpr],
    parameters: &'a [crate::analysis::SymbolId],
    defaults: Vec<Option<&'a TypedExpr>>,
}

fn helper_site_valid(
    ir: &IrProgram,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    site: &crate::analysis::scenario_disclosure::CheckedDecisionSite,
    outer: crate::analysis::NodeKey,
) -> bool {
    !(read.calls.len() > 16
        || outer.file != site.node.file
        || outer.start < site.node.start
        || outer.end > site.node.end
        || (read.source != site.source
            && !imported_field_source_corresponds(
                ir,
                owner,
                &read.model_name,
                &read.source,
                &site.source,
            ))
        || read.query_id.is_some()
        || read.role != DependencyRole::Control
        || read.node.kind != SyntaxKind::Member as u8)
}

fn helper_derive_calls(
    ir: &IrProgram,
    owner: &IrItem,
    site: &crate::analysis::scenario_disclosure::CheckedDecisionSite,
    outer: crate::analysis::NodeKey,
) -> Option<()> {
    for called in site.calls.iter().filter(|called| {
        called
            .chain
            .first()
            .is_some_and(|frame| frame.node == outer)
            || called.node == outer && called.chain.is_empty()
    }) {
        let crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::DeriveFn(id) =
            called.target
        else {
            return None;
        };
        let derive = ir.items.get(id.0 as usize)?;
        let IrItemKind::DeriveFn {
            result: IrType::Known(ResolvedType::Scalar(scalar)),
            expr: Some(_),
            ..
        } = &derive.kind
        else {
            return None;
        };
        if (derive.module != owner.module && !imported_canonical(ir, owner, &derive.canonical))
            || called.source != site.source
            || !supported_type_id(scalar.as_str())
        {
            return None;
        }
    }
    Some(())
}

fn require_helper_call<'a, 's, 'r>(
    ir: &'a IrProgram,
    owner: &IrItem,
    site: &'s crate::analysis::scenario_disclosure::CheckedDecisionSite,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    call: &crate::analysis::NodeKey,
    depth: usize,
    frames: &[RequireHelperFrame<'a>],
    roots: &[&'r TypedExpr],
    boolean: &ResolvedType,
) -> Option<(
    &'a IrItem,
    &'s crate::analysis::scenario_disclosure::CheckedDecisionCall,
    &'a TypedExpr,
    &'a [crate::analysis::SymbolId],
    &'a ResolvedType,
    &'r [TypedExpr],
)> {
    let mut candidates = site.calls.iter().filter(|candidate| {
        candidate.node == *call
            && candidate.chain.len() == depth
            && candidate
                .chain
                .iter()
                .zip(&read.calls[..depth])
                .all(|(frame, node)| frame.node == *node)
    });
    let source = candidates.next()?;
    if candidates.next().is_some() || source.source != site.source {
        return None;
    }
    let crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::DeriveFn(id) =
        source.target
    else {
        return None;
    };
    if source.chain.iter().zip(frames).any(|(frame, prior)| {
        frame.derive != prior.derive.id
            || (frame.module != owner.module
                && ir
                    .items
                    .get(frame.derive.0 as usize)
                    .is_none_or(|derive| !imported_canonical(ir, owner, &derive.canonical)))
            || frame.source != site.source
    }) {
        return None;
    }
    let derive = ir.items.get(id.0 as usize)?;
    let IrItemKind::DeriveFn {
        params,
        expr: Some(body),
        result: IrType::Known(result),
    } = &derive.kind
    else {
        return None;
    };
    if require_frame_shape_mismatch(
        ir,
        derive,
        owner,
        params.len(),
        source.slots.len(),
        &body.ty,
        result,
        depth,
        boolean,
    ) {
        return None;
    }
    let actual = find_typed_subtree(roots, node_span(*call))?;
    let (target, arguments) = match &actual.expr {
        IrExpr::Call { target, args }
            if source.slots.iter().copied().eq((0..args.len()).map(Some)) =>
        {
            (target, args.as_slice())
        }
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } if slots == &source.slots => (target, args.as_slice()),
        _ => return None,
    };
    if !matches!(target, IrCallTarget::DeriveFn(name) if name == &derive.canonical)
        || actual.ty != *result
        || arguments.len() != source.arguments.len()
        || arguments
            .iter()
            .zip(&source.arguments)
            .any(|(value, (node, ty))| !span_inside_node(value.span, *node) || value.ty != *ty)
    {
        return None;
    }
    Some((derive, source, body, params, result, arguments))
}

fn require_helper_defaults<'a: 'x, 'x>(
    ir: &'a IrProgram,
    derive: &'a IrItem,
    params: &'a [crate::analysis::SymbolId],
    source: &crate::analysis::scenario_disclosure::CheckedDecisionCall,
    arguments: &'x [TypedExpr],
) -> Option<(Vec<Option<&'x TypedExpr>>, usize)> {
    let mut defaults = Vec::new();
    let mut default_count = 0;
    for (index, parameter_id) in params.iter().enumerate() {
        let parameter = ir.items.get(parameter_id.0 as usize)?;
        let IrItemKind::Param {
            owner: parameter_owner,
            index: parameter_index,
            ty: IrType::Known(ty),
            default,
            default_node,
            array_bounds: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        if *parameter_owner != derive.id
            || *parameter_index != index
            || parameter.module != derive.module
            || !(matches!(ty, ResolvedType::Scalar(scalar) if supported_type_id(scalar.as_str()))
                || matches!(ty, ResolvedType::Record { stored: true, symbol } if matches!(&ir.items.get(symbol.0 as usize)?.kind, IrItemKind::Model { .. })))
        {
            return None;
        }
        if let Some(argument) = source.slots[index] {
            if arguments.get(argument)?.ty != *ty {
                return None;
            }
            defaults.push(None);
        } else {
            let (Some(default), Some(node)) = (default, default_node) else {
                return None;
            };
            let value = match default {
                IrDefault::Literal(value) | IrDefault::Computed { expr: value, .. } => value,
            };
            if value.ty != *ty
                || !span_inside_node(value.span, *node)
                || source
                    .defaults
                    .iter()
                    .filter(|(id, key)| id == parameter_id && key == node)
                    .count()
                    != 1
            {
                return None;
            }
            defaults.push(Some(value));
            default_count += 1;
        }
    }
    Some((defaults, default_count))
}

fn resolve_frame_receiver<'x>(
    ir: &IrProgram,
    frame: &RequireHelperFrame<'x>,
    mut receiver: &'x TypedExpr,
    model_type: &ResolvedType,
    db: &SourceDb,
) -> Option<&'x TypedExpr> {
    let mut seen = HashSet::new();
    loop {
        let IrExpr::Name(name) = &receiver.expr else {
            return None;
        };
        let mut parameters = frame
            .parameters
            .iter()
            .enumerate()
            .filter_map(|(index, id)| {
                let parameter = ir.items.get(id.0 as usize)?;
                (parameter.name == *name).then_some((index, parameter))
            });
        let (index, parameter) = parameters.next()?;
        if parameters.next().is_some() || !seen.insert(parameter.id) {
            return None;
        }
        created_record_name_matches(receiver, model_type, &parameter.name, receiver.span, db)?;
        match frame.source.slots[index] {
            Some(slot) => {
                receiver = frame.arguments.get(slot)?;
                break;
            }
            None => receiver = frame.defaults.get(index)?.as_ref().copied()?,
        }
    }
    Some(receiver)
}

fn resolve_helper_receiver<'x>(
    ir: &IrProgram,
    frames: &[RequireHelperFrame<'x>],
    roots: &[&'x TypedExpr],
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    db: &SourceDb,
) -> Option<&'x TypedExpr> {
    let member = find_typed_subtree(roots, node_span(read.node))?;
    let IrExpr::Member { base, field } = &member.expr else {
        return None;
    };
    if field != &read.field_name || member.ty != read.ty {
        return None;
    }
    let model_type = ResolvedType::Record {
        symbol: read.model,
        stored: true,
    };
    let mut receiver = base.as_ref();
    for frame in frames.iter().rev() {
        receiver = resolve_frame_receiver(ir, frame, receiver, &model_type, db)?;
    }
    Some(receiver)
}

fn helper_consuming_query<'a>(
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    outer: crate::analysis::NodeKey,
    binding: &str,
    ir: &'a IrProgram,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::DisclosureQuery,
    &'a crate::analysis::scenario_disclosure::DisclosureFirstQuery,
)> {
    let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
        query.model == read.model
            && query.first.as_ref().is_some_and(|first| {
                first.binding.end <= outer.start
                    && matches!(&owner.kind, IrItemKind::Scenario { effects, .. }
                if effects.iter().any(|statement| matches!(statement, IrStmt::Let { name, span, .. }
                    if name == binding && *span == node_span(first.binding))))
            })
    });
    let query = queries.next()?;
    if queries.next().is_some() {
        return None;
    }
    let first = query.first.as_ref()?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let initializer = effects.iter().find_map(|statement| match statement {
        IrStmt::Let { name, value, span }
            if name == binding && *span == node_span(first.binding) =>
        {
            Some(value)
        }
        _ => None,
    })?;
    if checked_owner_first_query_ir(ir, owner, initializer, first.call, db)? != query {
        return None;
    }
    Some((query, first))
}

fn helper_consumed_field(
    ir: &IrProgram,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    db: &SourceDb,
) -> Option<()> {
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == read.model)?;
    match_stored_contract_schema(ir, schema, db)?;
    let field = schema.fields.iter().find(|field| field.id == read.field)?;
    match_stored_contract_field(ir, field, db)?;
    if field.ty != read.ty
        || field.name != read.field_name
        || (field.source != read.source
            && !imported_field_source_corresponds(
                ir,
                owner,
                &read.model_name,
                &field.source,
                &read.source,
            ))
        || field.owner != schema.id
        || field.required_array
        || schema.canonical != read.model_name
    {
        return None;
    }
    Some(())
}

fn require_frame_shape_mismatch(
    ir: &IrProgram,
    derive: &IrItem,
    owner: &IrItem,
    params_len: usize,
    slots_len: usize,
    body_ty: &ResolvedType,
    result: &ResolvedType,
    depth: usize,
    boolean: &ResolvedType,
) -> bool {
    (derive.module != owner.module && !imported_canonical(ir, owner, &derive.canonical))
        || params_len > 64
        || params_len != slots_len
        || *body_ty != *result
        || depth == 0 && result != boolean
}

fn checked_require_helper_consumption(
    ir: &IrProgram,
    owner: &IrItem,
    condition: &TypedExpr,
    site: &crate::analysis::scenario_disclosure::CheckedDecisionSite,
    site_index: usize,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    db: &SourceDb,
) -> Option<NativeRequireConsumption> {
    let outer = *read.calls.first()?;
    // Helper field reads keep their declaring-module source; across a
    // proven import the provider/consumer pair corresponds exactly.
    if !helper_site_valid(ir, owner, read, site, outer) {
        return None;
    }
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    // This finite same-owner pure closure contains no catalog/StateRead calls.
    // The source census still retains unsupported calls for refusal here.
    helper_derive_calls(ir, owner, site, outer)?;
    let mut frames: Vec<RequireHelperFrame<'_>> = Vec::new();
    let mut roots = vec![condition];
    for (depth, call) in read.calls.iter().enumerate() {
        let (derive, source, body, params, _result, arguments) = require_helper_call(
            ir, owner, site, read, call, depth, &frames, &roots, &boolean,
        )?;
        let (defaults, default_count) =
            require_helper_defaults(ir, derive, params, source, arguments)?;
        if default_count != source.defaults.len() {
            return None;
        }
        roots = vec![body];
        roots.extend(defaults.iter().flatten().copied());
        frames.push(RequireHelperFrame {
            derive,
            source,
            arguments,
            parameters: params,
            defaults,
        });
    }
    let receiver = resolve_helper_receiver(ir, &frames, &roots, read, db)?;
    let IrExpr::Name(binding) = &receiver.expr else {
        return None;
    };
    let model_type = ResolvedType::Record {
        symbol: read.model,
        stored: true,
    };
    created_record_name_matches(receiver, &model_type, binding, node_span(outer), db)?;
    let (query, _) = helper_consuming_query(facts, owner, read, outer, binding, ir, db)?;
    let ResolvedType::Scalar(scalar) = &read.ty else {
        return None;
    };
    if !supported_type_id(scalar.as_str()) || read.type_id != scalar.as_str() {
        return None;
    }
    helper_consumed_field(ir, facts, owner, read, db)?;
    Some(NativeRequireConsumption {
        association: ReceiptRequireConsumption {
            site_index,
            query_id: query.id.clone(),
            node: ReceiptRequireNode {
                start: outer.start,
                end: outer.end,
            },
            dependency: ReceiptDependency {
                id: read.id.clone(),
                source: transport_source(&read.source, &read.source.module)?,
                role: ReceiptRole::Control,
                model: read.model_name.clone(),
                field: read.field_name.clone(),
                type_id: read.type_id.clone(),
                query_id: None,
            },
        },
        site: checked_site(read.node, &read.calls)?,
        observation: NativeDependency {
            id: read.id.clone(),
            model: read.model_name.clone(),
            field: read.field_name.clone(),
            source_dependency_id: None,
            captured_reference: false,
        },
    })
}
pub(super) fn checked_require_consumptions(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    prepared: &super::scenario_feasibility::PreparedRequireReturns<'_>,
) -> Option<Vec<NativeRequireConsumption>> {
    use crate::analysis::scenario_disclosure::{
        CheckedDecisionPosition as Position, CheckedDecisionStage as Stage,
    };
    let checked = prepared.checked_scenario(ir, owner.id)?;
    if !std::ptr::eq(ir.items.get(owner.id.0 as usize)?, owner) {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let sites: Vec<_> = facts
        .decision_sites
        .as_deref()?
        .iter()
        .filter(|site| {
            site.owner == owner.id
                && !matches!(
                    site.stage,
                    Stage::ReadPolicy | Stage::ReadPredicate | Stage::SendDispatch
                )
        })
        .collect();
    let mut out = Vec::new();
    let mut ids = HashSet::new();
    for consumption in &checked.require_consumptions {
        let mut selected = sites.iter().enumerate().filter(|(_, site)| {
            site.statement == consumption.statement
                && site.node == consumption.condition
                && matches!(site.stage, Stage::LeadingRequire | Stage::BodyRequire)
        });
        let (site_index, site) = selected.next()?;
        if selected.next().is_some() || site.source != checked.source {
            return None;
        }
        let (head, tail) = site.position.split_first()?;
        let mut statement = match head {
            Position::Guard(index) if site.stage == Stage::LeadingRequire => guards.get(*index)?,
            Position::Body(index) if site.stage == Stage::BodyRequire => effects.get(*index)?,
            _ => return None,
        };
        for position in tail {
            statement = match (position, statement) {
                (Position::Then(index), IrStmt::If { then_branch, .. }) => {
                    then_branch.get(*index)?
                }
                (Position::Else(index), IrStmt::If { else_branch, .. }) => {
                    else_branch.get(*index)?
                }
                _ => return None,
            };
        }
        let IrStmt::Require { cond, span } = statement else {
            return None;
        };
        if *span != node_span(consumption.statement)
            || cond.span != node_span(consumption.condition)
            || cond.ty != ResolvedType::Scalar(Scalar::Bool)
            || consumption.dependencies.is_empty()
        {
            return None;
        }
        for read in &consumption.dependencies {
            if !read.calls.is_empty() {
                if out.len() >= 200 || !ids.insert(read.id.clone()) || read.id.is_empty() {
                    return None;
                }
                out.push(checked_require_helper_consumption(
                    ir, owner, cond, site, site_index, facts, read, db,
                )?);
                continue;
            }
            if out.len() >= 200
                || !ids.insert(read.id.clone())
                || read.id.is_empty()
                || !read.calls.is_empty()
                || read.query_id.is_some()
                || read.source != site.source
                || read.role != DependencyRole::Control
                || read.node.kind != SyntaxKind::Member as u8
                || read.node.file != consumption.condition.file
                || read.node.start < consumption.condition.start
                || read.node.end > consumption.condition.end
            {
                return None;
            }
            // Existing result observations and admitted Model guards keep their
            // defining authority path. Applicability comes from the sealed
            // original source receiver, never an editable actual-IR name.
            if checked.returns.iter().any(|returned| {
                returned
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.id == read.id)
            }) {
                // DESIGN442 (0411): a guard-consumed decision read still needs
                // its execution capture — the State owner grant rides the bound
                // execution dependency, while the result path keeps its own
                // checks. Narrow to the single guard-consumed first query for
                // this model (the State grant independently requires a
                // single-query plan), so every other return-dep read keeps
                // the result path exactly.
                let decision = facts
                    .queries
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .filter(|query| query.first.is_some() && query.model == read.model)
                    .collect::<Vec<_>>();
                if decision.len() != 1
                    || !decision[0]
                        .first
                        .as_ref()
                        .is_some_and(|first| first.guard_consumed)
                {
                    continue;
                }
            }
            let text = &db.get(read.node.file)?.text;
            let original_member = checked_effect_node(ir, owner, read.node, db)?;
            let field = original_member
                .children
                .iter()
                .rev()
                .find(|node| node.kind == SyntaxKind::Name)?;
            if field.token()?.text(text) != read.field_name {
                return None;
            }
            let mut base = original_member.children.iter().find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef | SyntaxKind::Group | SyntaxKind::Member | SyntaxKind::Call
                )
            })?;
            let mut depth = 0;
            while base.kind == SyntaxKind::Group {
                depth += 1;
                if depth > 16 {
                    return None;
                }
                base = base.children.iter().find(|node| {
                    matches!(
                        node.kind,
                        SyntaxKind::NameRef
                            | SyntaxKind::Group
                            | SyntaxKind::Member
                            | SyntaxKind::Call
                    )
                })?;
            }
            if base.kind != SyntaxKind::NameRef {
                continue;
            }
            let names: Vec<_> = base
                .children
                .iter()
                .filter(|node| !matches!(node.kind, SyntaxKind::Trivia | SyntaxKind::Comment))
                .collect();
            let [name] = names.as_slice() else {
                return None;
            };
            if name.kind != SyntaxKind::Name {
                return None;
            }
            let receiver = name.token()?.text(text);
            let mut origins = Vec::new();
            for query in facts
                .queries
                .as_deref()?
                .iter()
                .filter(|query| query.first.is_some() && query.model == read.model)
            {
                let first = query.first.as_ref()?;
                let original = checked_effect_node(ir, owner, first.binding, db)?;
                let names: Vec<_> = original
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .collect();
                let [keyword, name] = names.as_slice() else {
                    return None;
                };
                if keyword.token()?.text(text) != "let" {
                    return None;
                }
                if name.token()?.text(text) == receiver && first.binding.end <= read.node.start {
                    origins.push(query);
                }
            }
            let query = match origins.as_slice() {
                [] => continue,
                [query] => *query,
                _ => return None,
            };
            // Select the actual expression inside this Require, retaining its
            // original lazy evaluation position instead of hoisting a read.
            let value = find_typed_subtree(&[cond], node_span(read.node))?;
            let IrExpr::Member { base, field } = &value.expr else {
                return None;
            };
            let IrExpr::Name(binding) = &base.expr else {
                return None;
            };
            if value.ty != read.ty
                || field != &read.field_name
                || base.ty
                    != (ResolvedType::Record {
                        symbol: read.model,
                        stored: true,
                    })
            {
                return None;
            }
            if query.model_name != read.model_name {
                return None;
            }
            let first = query.first.as_ref()?;
            let mut lets = effects.iter().filter_map(|statement| match statement {
                IrStmt::Let { name, value, span } if *span == node_span(first.binding) => {
                    Some((name, value))
                }
                _ => None,
            });
            let (name, initializer) = lets.next()?;
            if lets.next().is_some()
                || name != binding
                || first.binding.end > read.node.start
                || checked_owner_first_query_ir(ir, owner, initializer, first.call, db)? != query
            {
                return None;
            }
            created_record_name_matches(base, &base.ty, name, base.span, db)?;
            let schemas = facts.stored_contracts.as_deref()?;
            let schema = schemas
                .iter()
                .find(|schema| schema.model && schema.id == read.model)?;
            match_stored_contract_schema(ir, schema, db)?;
            let field = schema.fields.iter().find(|field| field.id == read.field)?;
            match_stored_contract_field(ir, field, db)?;
            let type_matches = match &read.ty {
                ResolvedType::Scalar(scalar) => {
                    supported_type_id(scalar.as_str()) && read.type_id == scalar.as_str()
                }
                ResolvedType::Record {
                    symbol: contract, ..
                } => {
                    let contract = schemas
                        .iter()
                        .find(|schema| !schema.model && schema.id == *contract)?;
                    match_stored_contract_fields(ir, contract, db)?;
                    contract.canonical == read.type_id
                }
                _ => false,
            };
            if field.ty != read.ty
                || field.name != read.field_name
                || (field.source != read.source
                    && !imported_field_source_corresponds(
                        ir,
                        owner,
                        &read.model_name,
                        &field.source,
                        &read.source,
                    ))
                || field.owner != schema.id
                || field.required_array
                || schema.canonical != read.model_name
                || !type_matches
            {
                return None;
            }
            out.push(NativeRequireConsumption {
                association: ReceiptRequireConsumption {
                    site_index,
                    query_id: query.id.clone(),
                    node: ReceiptRequireNode {
                        start: read.node.start,
                        end: read.node.end,
                    },
                    dependency: ReceiptDependency {
                        id: read.id.clone(),
                        source: transport_source(&read.source, &read.source.module)?,
                        role: ReceiptRole::Control,
                        model: read.model_name.clone(),
                        field: read.field_name.clone(),
                        type_id: read.type_id.clone(),
                        query_id: None,
                    },
                },
                site: checked_site(read.node, &read.calls)?,
                observation: NativeDependency {
                    id: read.id.clone(),
                    model: read.model_name.clone(),
                    field: read.field_name.clone(),
                    source_dependency_id: None,
                    captured_reference: false,
                },
            });
        }
    }
    Some(out)
}

/// Plain (non-machine) enum data reads transport as the sealed `enum(a,b)`
/// identity, mirroring the query-predicate enum convention. A reused enum
/// (`I.role: C.role`) names its declaring field, so the nominal path pins
/// through the enum owner item rather than the reading field. The caller
/// retains the transition/machine scoping: transition values and machine
/// fields never enter here.
fn checked_plain_enum_data_transport(
    ir: &IrProgram,
    dependency_type_id: &str,
    ty_cases: &[String],
    enum_owner: crate::analysis::SymbolId,
    descriptor: &JsModelField,
) -> Option<String> {
    if descriptor.machine.is_some()
        || descriptor.nullable
        || descriptor.array_required.is_some()
        || descriptor.server_only
    {
        return None;
    }
    match &descriptor.field {
        JsModelFieldType::Enum { values } if values.as_slice() == ty_cases => {}
        JsModelFieldType::Nominal { name }
            if name == dependency_type_id
                && descriptor.value_type.as_deref() == Some(dependency_type_id) => {}
        _ => return None,
    }
    let owner_item = ir.items.get(enum_owner.0 as usize)?;
    let IrItemKind::Field {
        ty:
            IrType::Known(ResolvedType::Enum {
                cases: owner_cases,
                owner: Some(original_owner),
            }),
        ..
    } = &owner_item.kind
    else {
        return None;
    };
    if owner_item.id != enum_owner
        || owner_item.canonical != dependency_type_id
        || owner_cases.as_slice() != ty_cases
        || *original_owner != enum_owner
    {
        return None;
    }
    let inline = format!("enum({})", ty_cases.join(","));
    if descriptor.value_type.as_deref() != Some(dependency_type_id)
        && inventory_type(descriptor).as_deref() != Some(inline.as_str())
    {
        return None;
    }
    Some(inline)
}

/// `models` must be the actual descriptors emitted by the owning emitter.
/// `entry_module` is the actual artifact callable module, not an inferred
/// package path: native scenario implementations currently execute in entry.
pub(super) fn collect_native_scenario_receipt_with_feasibility(
    ir: &IrProgram,
    item: &IrItem,
    models: &[JsModel],
    entry_module: &str,
    value_types: Option<&JsValueTypes>,
    sources: NativeReceiptSources<'_>,
    feasibility: Option<&super::scenario_feasibility::PreparedRequireReturns<'_>>,
) -> Option<NativeScenarioReceipt> {
    let transcript = has_original_transcript_source(ir, item.id);
    let NativeReceiptSources {
        source_context,
        db,
        send_guards,
        query_plan,
    } = sources;
    let IrItemKind::Scenario {
        trusted,
        event_source,
        hook,
        cohort,
        result,
        read: false,
        expose_excluded: false,
        effects,
        params,
        ..
    } = &item.kind
    else {
        return None;
    };
    if item.canonical == "maintain.remind" {
        return super::event_decisions::collect_maintain_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "member_terms.term" {
        return super::term_decisions::collect_term_receipt(source_context?, item, entry_module);
    }
    if item.canonical == "leave.request" {
        return super::leave_decisions::collect_leave_receipt(source_context?, item, entry_module);
    }
    if item.canonical == "leave.decide" {
        return super::leave_decisions::collect_leave_decide_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "refer.reject_source" {
        return super::refer_decisions::collect_reject_receipt(source_context?, item, entry_module);
    }
    if item.canonical == "member_terms.retry_collection" {
        return super::member_retry_decisions::collect_retry_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "invoice.collect" {
        return super::invoice_collect_decisions::collect_collect_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "rent_reservations.correspondence"
        || item.canonical == "rent_reservations.remind"
    {
        return super::rent_notice_decisions::collect_notice_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "invoice.issue" {
        return super::invoice_issue_decisions::collect_issue_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "events.observe_venue" {
        return super::event_send_decisions::collect_observe_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if matches!(
        item.canonical.as_str(),
        "success.renewal_due" | "success.remind"
    ) {
        return super::success_send_decisions::collect_success_notice_receipt(
            source_context?,
            item,
            entry_module,
            send_guards?,
        );
    }
    if item.canonical == "rent_reservations.refund_movement_credit" {
        return super::rent_movement_refund_decisions::collect_refund_receipt(
            source_context?,
            item,
            entry_module,
        );
    }
    // C23 hook slice: a declared-event handler may carry a native receipt
    // for its exact single-first query plan. The plan join below re-proves
    // the query, so every other trusted shape keeps the refusal; only the
    // declared-event/void combination proceeds past this gate.
    let hook_receipt = *trusted
        && matches!(event_source, Some(super::ir::IrEventSource::Declared(_)))
        && hook.is_none()
        && cohort.is_none();
    if !hook_receipt && (*trusted || event_source.is_some() || hook.is_some() || cohort.is_some()) {
        return None;
    }
    let created_model = checked_created_model_result(ir, item);
    if (transcript && created_model.is_none())
        || (!result.as_ref().is_none_or(native_result_type) && created_model.is_none())
        || entry_module.is_empty()
    {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&item.id)? else {
        return None;
    };
    let reminder_recipient = if item.canonical == "appointments.remind" {
        let [IrStmt::Send { span, .. }, IrStmt::Create { .. }] = effects.as_slice() else {
            return None;
        };
        let guard = send_guards?.get(span)?;
        let path = guard.descriptor.get("eventSource")?.get("recipientPath")?;
        let source_id = path.get("sourceDependencyId")?.as_str()?;
        let leaf_id = path.get("leafDependencyId")?.as_str()?;
        if guard.event_source.as_ref()?.model_field != "appointment"
            || source_id.is_empty()
            || leaf_id.is_empty()
            || source_id == leaf_id
        {
            return None;
        }
        Some((source_id.to_string(), leaf_id.to_string()))
    } else {
        None
    };
    let returned_paths: Vec<_> = match feasibility
        .filter(|_| super::scenario_feasibility::requires_projection(checked, ir))
    {
        Some(prepared) => prepared.returns(ir, item.id)?,
        None => checked.returns.iter().collect(),
    };
    if checked.scenario != item.id || returned_paths.is_empty() || returned_paths.len() > 200 {
        return None;
    }
    let module = ir.modules.get(item.module.0 as usize)?;
    if module.id != item.module || checked.source.module != module.name {
        return None;
    }
    if checked.node.file != module.file
        || checked.node.kind != SyntaxKind::Scenario as u8
        || checked.node.file != item.span.file
        || checked.node.start > item.span.start
        || checked.node.end < item.span.end
    {
        return None;
    }
    let source = transport_source(&checked.source, entry_module)?;
    if created_model.is_some()
        || has_original_guarded_send(ir, item.id)
        || has_original_images_source(ir, item.id)
    {
        let db = db?;
        super::scenario_calls::checked_source(ir, item, db)?;
        if item.canonical != format!("{}.{}", module.name, item.name)
            || db
                .get(item.span.file)?
                .text
                .get(item.span.start as usize..item.span.end as usize)?
                != item.name
        {
            return None;
        }
    }
    if has_original_images_source(ir, item.id) {
        checked_images_source(ir, item, db?)?;
    }
    let purchase_all = if matches!(
        item.canonical.as_str(),
        "purchase.receive" | "CanPurchase.receive"
    ) {
        Some(super::purchase_all::checked(
            source_context?,
            item,
            entry_module,
        )?)
    } else {
        None
    };
    let value_plan = if checked
        .source_facts
        .as_deref()?
        .query_values
        .as_deref()
        .is_some_and(|values| !values.is_empty())
    {
        Some(checked_native_value_query_plan(
            source_context?,
            item,
            checked,
            entry_module,
        )?)
    } else {
        None
    };
    let first_plan = if value_plan.is_some() {
        Some(None)
    } else {
        checked_native_first_query_plan(
            ir,
            item,
            checked,
            query_plan,
            entry_module,
            db,
            &returned_paths,
            source_context,
        )
    };

    let first_plan = first_plan?;
    // Guard-only plain boolean `any` queries carry no first/count plan, so a
    // locally derived guard plan backs their return influences instead.
    let guard_plan = if first_plan.is_none() {
        checked_guard_any_query_plan(ir, item, checked, entry_module)
    } else {
        None
    };
    let effective_plan = value_plan.as_ref().or(first_plan).or(guard_plan.as_ref());

    let event_notice = if item.canonical == "events.attendee_notice" {
        Some(super::event_notice_audit::checked(
            source_context?,
            item,
            entry_module,
        )?)
    } else {
        None
    };
    let updated_model_owner = source_context.is_some_and(|context| {
        checked
            .source_facts
            .as_deref()
            .and_then(|facts| facts.creates.as_deref())
            .is_some_and(|creates| {
                creates.len() == 1
                    && source_owned_updated_model_create(context, item, &creates[0]).is_some()
            })
            || source_owned_void_member_loops(context, item).is_some()
    });
    let copy_loop = source_context.and_then(|context| source_owned_copy_loop(context, item));
    let sibling_loop = source_context.and_then(|context| source_owned_body_loop(context, item));
    let sites = match Sites::collect(
        ir,
        item,
        send_guards,
        db,
        purchase_all.as_ref(),
        event_notice.as_ref(),
        updated_model_owner,
        copy_loop.as_ref(),
        sibling_loop.as_ref(),
        source_context,
    ) {
        Some(sites) => sites,
        None => {
            return None;
        }
    };

    if !sites.enum_values.is_empty() {
        let context = source_context?;
        context.same_scenario(ir, item)?;
        for (id, cases) in &sites.enum_values {
            let actual = ir.items.get(id.0 as usize)?;
            let original = context.fresh().items.get(id.0 as usize)?;
            let (
                IrItemKind::Field {
                    owner: actual_owner,
                    ..
                },
                IrItemKind::Field {
                    owner: original_owner,
                    ..
                },
            ) = (&actual.kind, &original.kind)
            else {
                return None;
            };
            if actual_owner != original_owner {
                return None;
            }
            let parent = ir.items.get(actual_owner.0 as usize)?;
            let original_parent = context.fresh().items.get(original_owner.0 as usize)?;
            if parent.id != original_parent.id
                || parent.canonical != original_parent.canonical
                || parent.name != original_parent.name
                || parent.module != original_parent.module
                || parent.span != original_parent.span
                || std::mem::discriminant(&parent.kind)
                    != std::mem::discriminant(&original_parent.kind)
            {
                return None;
            }
            if actual.id!=*id || original.id!=*id || actual.canonical!=original.canonical
                || actual.name!=original.name || actual.module!=original.module || actual.span!=original.span
                || ![actual,original].iter().all(|item|matches!(&item.kind,
                    IrItemKind::Field{ty:IrType::Known(ResolvedType::Enum{owner:Some(owner),cases:declared}),..}
                        if owner==id && declared==cases)) {return None;}
        }
    }
    match_effect_proofs(
        ir,
        item,
        models,
        checked,
        &sites,
        db,
        send_guards,
        source_context,
    )?;

    let sealed_created_tail = source_context.is_some_and(|context| {
        checked
            .source_facts
            .as_deref()
            .and_then(|facts| facts.creates.as_deref())
            .is_some_and(|creates| {
                creates.first().is_some_and(|original| {
                    source_owned_void_create(context, item, original).is_some()
                        || source_owned_created_return_tail(context, item, original).is_some()
                })
            })
    });
    let mut profile_scalar_pairs = HashMap::new();
    let mut profile_source_pairs = HashMap::new();
    let mut captured_scalar_sites = HashSet::new();
    let mut captured_reference_sources = HashSet::new();
    let scalar_result = matches!(
        &item.kind,
        IrItemKind::Scenario {
            result: Some(ResolvedType::Scalar(_)),
            ..
        }
    );
    let captured_reference = db.is_some_and(|db| sites.members.values().flatten().any(|expression|
        matches!(&expression.expr, IrExpr::Member {base,..} if checked_reference_alias_initializer(ir,item,base,db).is_some())));
    if (created_model.is_some() || sealed_created_tail || scalar_result || captured_reference)
        && let Some(db) = db
    {
        for (site, expressions) in &sites.members {
            let [expression] = expressions.as_slice() else {
                continue;
            };
            let Some(pairs) = checked_profile_scalar_pairs(ir, item, expression, db)
                .or_else(|| checked_reference_receiver_pairs(ir, item, expression, db))
                .or_else(|| {
                    checked_helper_reference_scalar_pairs(source_context?, item, expression)
                })
            else {
                continue;
            };
            let IrExpr::Member { base, .. } = &expression.expr else {
                return None;
            };
            let first = pairs.first()?;
            let source_site = checked_site(first.0.node, &first.0.calls)?;
            let [source_expression] = sites.members.get(&source_site)?.as_slice() else {
                return None;
            };
            let original_receiver =
                checked_reference_alias_initializer(ir, item, base, db).unwrap_or(base);
            if !std::ptr::eq(original_receiver, base.as_ref()) {
                captured_scalar_sites.insert(site.clone());
                captured_reference_sources.insert(source_site.clone());
            }
            if !std::ptr::eq(*source_expression, original_receiver)
                || pairs.iter().any(|(source, _)| {
                    checked_site(source.node, &source.calls).as_ref() != Some(&source_site)
                })
                || profile_scalar_pairs
                    .insert(site.clone(), pairs.clone())
                    .is_some()
            {
                return None;
            }
            // Several original scalar consumers may borrow the same captured
            // reference. Keep every checked leaf association on that one
            // getter rather than selecting or overwriting a consumer.
            let sources = profile_source_pairs
                .entry(source_site)
                .or_insert_with(Vec::new);
            for pair in pairs {
                if !sources.contains(&pair) {
                    sources.push(pair);
                }
            }
        }
    }
    // A captured reference may itself follow an original containment edge.
    // Retain its complete authenticated source chain, including separately
    // consumed CONTROL reads of the same original getters.
    let mut pending_sources = captured_reference_sources
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    while let Some(site) = pending_sources.pop() {
        if let Some(pairs) = profile_scalar_pairs.get(&site) {
            for (source, _) in pairs {
                let source_site = checked_site(source.node, &source.calls)?;
                if captured_reference_sources.insert(source_site.clone()) {
                    if captured_reference_sources.len() > 200 {
                        return None;
                    }
                    pending_sources.push(source_site);
                }
            }
        }
    }
    let current_sites =
        db.and_then(|db| super::scenario_current_revision::checked_current_revision(ir, item, db));
    if current_sites.is_some() && feasibility.is_none() {
        return None;
    }
    let current_revision = match current_sites.as_ref() {
        Some(current) => Some(NativeCurrentRevision::from_sites(current)?),
        None => None,
    };
    let profile_descriptors = if current_sites.is_some() || !profile_scalar_pairs.is_empty() {
        Some(super::js::Emitter::source_models(ir, db?)?)
    } else {
        None
    };
    let has_emitting_loop = checked.effects.iter().any(|proof| match &proof.kind {
        DisclosureEffectKind::ForMember { body, .. } => body.iter().any(|node| {
            checked.effects.iter().any(|effect| {
                effect.node == *node && matches!(effect.kind, DisclosureEffectKind::Emit { .. })
            })
        }),
        _ => false,
    });
    if has_emitting_loop && checked_source_emissions(ir, item, checked, entry_module).is_none() {
        return None;
    }
    if checked_source_emissions(ir, item, checked, entry_module).is_some() {
        let context = source_context?;
        context.same_scenario(ir, item)?;
    }
    let mut recipe = NativeScenarioReceipt {
        plan: ReceiptDisclosurePlan {
            retained_guarded_handler: None,
            source_loops: None,
            source_emissions: checked_source_emissions(ir, item, checked, entry_module),
            version: 1,
            event_decision: None,
            term_decision: None,
            leave_request_decision: None,
            leave_decide_decision: None,
            refer_reject_decision: None,
            member_retry_decision: None,
            rent_movement_refund_decision: None,
            invoice_collect_decision: None,
            rent_notice_decision: None,
            invoice_issue_decision: None,
            observe_venue_decision: None,
            success_renewal_decision: None,
            purchase_receive_all: None,
            event_notice_audit: None,
            source,
            queries: effective_plan.map_or_else(Vec::new, |plan| plan.queries.clone()),
            returns: Vec::new(),
        },
        dependencies: HashMap::new(),
        intrinsics: HashMap::new(),
        decisions: HashMap::new(),
        decision_keys: HashMap::new(),
        calls: sites.calls.clone(),
        returns: Vec::new(),
        current_revision,
    };
    if updated_model_owner || copy_loop.is_some() {
        let mut loops = Vec::new();
        for effect in &checked.effects {
            let DisclosureEffectKind::ForMember {
                domain,
                maximum,
                parameter,
                model,
                ..
            } = &effect.kind
            else {
                continue;
            };
            let parameter = ir.items.get(parameter.0 as usize)?;
            let IrItemKind::Param {
                ty: IrType::Known(ResolvedType::Record { symbol: parent, .. }),
                ..
            } = &parameter.kind
            else {
                return None;
            };
            let parent = ir.items.get(parent.0 as usize)?;
            let model = ir.items.get(model.0 as usize)?;
            let id = sha256_hex(
                format!(
                    "source-loop/v1:{}:{}:{}:{}:{}:{}:{}:{}",
                    checked.source.path,
                    checked.source.sha256,
                    item.canonical,
                    effect.node.start,
                    effect.node.end,
                    domain.start,
                    domain.end,
                    maximum
                )
                .as_bytes(),
            );
            let mut loop_ = serde_json::json!({"id":id,"node":{"start":effect.node.start,"end":effect.node.end},
                "domain":{"start":domain.start,"end":domain.end},"maximum":maximum,"parameter":parameter.name,
                "parentModel":parent.canonical,"model":model.canonical,"filtered":domain.kind==SyntaxKind::Query as u8});
            if let Some(copy) = &copy_loop {
                loop_["copy"] = copy.clone();
            }
            loops.push(loop_);
        }
        if loops.is_empty() {
            return None;
        }
        recipe.plan.source_loops = Some(
            serde_json::json!({"source":recipe.plan.source,"owner":item.canonical,"loops":loops}),
        );
    }
    recipe.plan.purchase_receive_all = purchase_all;
    if item.canonical == "events.attendee_notice" {
        recipe.plan.event_notice_audit = event_notice;
    }
    let mut source_origins = HashMap::new();
    source_origins.insert(
        (checked.node.file, checked.source.module.clone()),
        checked.source.clone(),
    );
    let mut return_ids = HashSet::new();
    let mut matched_returns = HashSet::new();
    let mut dependency_ids =
        HashMap::<String, (NativeSite, String, String, String, ReceiptRole)>::new();
    let mut intrinsic_ids =
        HashMap::<String, (NativeSite, NativeIntrinsicKind, String, ReceiptRole)>::new();
    // State's v1 own-data parser bounds each array/global dependency inventory
    // at 200 and the closed plan traversal at 20,000 JSON nodes.
    let mut data_nodes: usize = effective_plan.map_or(7, |plan| 7 + 40 * plan.queries.len());

    for returned in returned_paths {
        if (effective_plan.is_none() && !returned.influences.is_empty())
            || returned.node.file != checked.node.file
            || returned.id.is_empty()
            || !return_ids.insert(returned.id.clone())
        {
            return None;
        }
        if returned
            .dependencies
            .len()
            .checked_add(returned.intrinsics.len())?
            > 200
        {
            return None;
        }
        data_nodes = data_nodes.checked_add(
            9 + 5 * returned.influences.len()
                + 10 * returned.dependencies.len()
                + returned
                    .dependencies
                    .iter()
                    .filter(|read| read.query_id.is_some())
                    .count()
                + 16 * returned.intrinsics.len(),
        )?;
        if data_nodes > 20_000 {
            return None;
        }
        let return_span = node_span(returned.node);
        let implicit = returned.node == checked.node;
        // The checked whole declaration anchor owns implicit void fallthrough;
        // its containing name span is the actual emitter attribution site.
        if (implicit && result.is_some())
            || (!implicit
                && (returned.node.kind != SyntaxKind::Return as u8
                    || !sites.returns.contains(&return_span)))
        {
            return None;
        }
        if returned.source != checked.source {
            return None;
        }
        if let Some(model) = created_model {
            let IrStmt::Return {
                value: Some(value),
                span,
            } = result_statement_at(effects, return_span)?
            else {
                return None;
            };
            if matches!(
                returned.model_result,
                Some(DisclosureModelResult::Reference { .. })
            ) {
                let target = checked_reference_model_result(ir, item, value, models, db?)?;
                if target.id != model {
                    return None;
                }
            } else if checked_contract_parameter_path(ir, item, value, db).is_some() {
                if checked_contract_parameter_row(ir, item, value, models, db?)?.id != model {
                    return None;
                }
            } else {
                let IrExpr::Name(binding) = &value.expr else {
                    return None;
                };
                created_record_name_matches(
                    value,
                    &ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    },
                    binding,
                    *span,
                    db?,
                )?;
            }
            checked_effect_node(ir, item, returned.node, db?)?;
        }
        if !implicit {
            matched_returns.insert(return_span);
        }
        let mut native_return = NativeReturn {
            id: returned.id.clone(),
            span: if implicit { item.span } else { return_span },
            decisions: Vec::new(),
            implicit,
            reference_result: None,
        };
        let influences = effective_plan.map_or_else(Vec::new, |plan| {
            plan.returns
                .iter()
                .find(|candidate| candidate.id == returned.id)
                .map_or_else(Vec::new, |candidate| candidate.influences.clone())
        });
        let mut plan_return = receipt_return(returned, entry_module, influences)?;
        for decision in &returned.decisions {
            let mut site = checked_site(decision.node, &decision.calls)?;
            site.default_selection = matches!(
                decision.choice,
                DisclosureChoice::DefaultEvaluated | DisclosureChoice::DefaultProvided
            );
            let span = site.span;
            if native_return
                .decisions
                .iter()
                .any(|(seen, _)| recipe.decision_keys.get(&site) == Some(seen))
            {
                return None;
            }
            let kind = *sites.decisions.get(&site)?;
            let expected = match kind {
                NativeDecisionKind::ParameterDefault => decision.node.kind,
                NativeDecisionKind::OptionalInput(parameter) => {
                    let original = checked
                        .source_facts
                        .as_deref()?
                        .parameters
                        .iter()
                        .find(|input| input.parameter == parameter)?;
                    if decision.node != original.node || !decision.calls.is_empty() {
                        return None;
                    }
                    original.node.kind
                }
                NativeDecisionKind::If => SyntaxKind::If as u8,
                NativeDecisionKind::For => SyntaxKind::For as u8,
                NativeDecisionKind::Match => SyntaxKind::Match as u8,
                NativeDecisionKind::QuerySelection => SyntaxKind::Query as u8,
                _ => SyntaxKind::Binary as u8,
            };
            if decision.node.kind != expected {
                return None;
            }
            if !valid_choice(kind, &decision.choice, sites.matches.get(&site)) {
                return None;
            }
            if recipe
                .decisions
                .insert(site.clone(), kind)
                .is_some_and(|old| old != kind)
            {
                return None;
            }
            let key = if let Some(key) = recipe.decision_keys.get(&site) {
                key.clone()
            } else {
                // The checked opaque return identity already incorporates exact
                // declaring source bytes and canonical call-chain origins.
                let mut stamp = format!(
                    "receipt-choice:{}:{}:{}:{}",
                    returned.id, span.start, span.end, site.default_selection
                );
                for anchor in site.calls.iter().chain(std::iter::once(&span)) {
                    let owner = owning_module(ir, *anchor)?;
                    stamp.push_str(&format!(":{}:{}:{}", owner.name, anchor.start, anchor.end));
                }
                let key = sha256_hex(stamp.as_bytes());
                recipe.decision_keys.insert(site, key.clone());
                key
            };
            native_return.decisions.push((key, decision.choice.clone()));
        }

        for dependency in &returned.dependencies {
            let result_identity = match returned.model_result {
                Some(
                    DisclosureModelResult::Parameter { model, node, .. }
                    | DisclosureModelResult::Reference { model, node, .. },
                ) if dependency.node == node
                    && dependency.model == model
                    && dependency.field == model
                    && dependency.field_name == "id"
                    && dependency.role == DependencyRole::Data
                    && dependency.calls.is_empty()
                    && dependency.query_id.is_none() =>
                {
                    let IrStmt::Return {
                        value: Some(value), ..
                    } = result_statement_at(effects, node_span(returned.node))?
                    else {
                        return None;
                    };
                    if value.span != node_span(node) {
                        return None;
                    }
                    Some(value)
                }
                _ => None,
            };
            let is_transition = dependency.node.kind == SyntaxKind::Transition as u8;
            let parent_set = dependency.node.kind == SyntaxKind::Path as u8
                && dependency.calls.is_empty() && dependency.query_id.is_none()
                && dependency.role == DependencyRole::Data
                && dependency.field_name == "parent" && dependency.field == dependency.model
                && sites.members.get(&checked_site(dependency.node, &[])?)
                    .is_some_and(|expressions| matches!(expressions.as_slice(), [expression]
                        if db.is_some_and(|db| checked_set_parent_receiver(ir, item, expression, db).is_some())));
            if (result_identity.is_none()
                && !is_transition
                && !parent_set
                && dependency.node.kind != SyntaxKind::Member as u8)
                || dependency.id.is_empty()
                || intrinsic_ids.contains_key(&dependency.id)
                || !source_matches(ir, &dependency.source, node_span(dependency.node))
                || !direct_field_name(&dependency.field_name)
            {
                return None;
            }
            let source_key = (dependency.node.file, dependency.source.module.clone());
            if let Some(previous) = source_origins.get(&source_key) {
                if previous != &dependency.source {
                    return None;
                }
            } else {
                source_origins.insert(source_key, dependency.source.clone());
            }
            if dependency.calls.is_empty() && dependency.source != checked.source {
                return None;
            }
            if plan_return
                .dependencies
                .iter()
                .any(|read| read.id == dependency.id)
            {
                return None;
            }
            let site = checked_site(dependency.node, &dependency.calls)?;

            let profile_scalar_pair = profile_scalar_pairs.get(&site).and_then(|pairs| {
                pairs
                    .iter()
                    .copied()
                    .find(|(_, scalar)| *scalar == dependency)
            });
            let profile_source_pair = profile_source_pairs.get(&site).and_then(|pairs| {
                pairs
                    .iter()
                    .copied()
                    .find(|(reference, _)| *reference == dependency)
            });
            let captured_control = captured_reference_sources.contains(&site)
                && dependency.role == DependencyRole::Control
                && dependency.calls.is_empty() && dependency.query_id.is_none()
                && profile_source_pairs.get(&site).is_some_and(|pairs| pairs.iter().any(|(source,_)|
                    source.role == DependencyRole::Data && source.id != dependency.id
                        && source.node == dependency.node && source.calls == dependency.calls
                        && source.source == dependency.source && source.model == dependency.model
                        && source.field == dependency.field && source.model_name == dependency.model_name
                        && source.field_name == dependency.field_name && source.ty == dependency.ty
                        && source.type_id == dependency.type_id && source.query_id.is_none()))
                && db.is_some_and(|db| sites.members.get(&site).is_some_and(|expressions|
                    matches!(expressions.as_slice(),[expression] if
                        stored_reference_operand(ir,item,expression,db).is_some_and(|field|
                            field.owner == dependency.model && field.id == dependency.field && field.ty == dependency.ty)
                        || checked_parent_reference(ir,item,expression,db).is_some_and(|(child,parent)|
                            dependency.model == child.id && dependency.field == child.id && dependency.field_name == "parent"
                                && dependency.ty == ResolvedType::Record {symbol:parent.id,stored:true}))));
            if result_identity.is_none()
                && !captured_control
                && (profile_scalar_pairs.contains_key(&site) && profile_scalar_pair.is_none()
                    || profile_source_pairs.contains_key(&site) && profile_source_pair.is_none())
            {
                return None;
            }
            let source_dependency_id = profile_scalar_pair
                .map(|(reference, _)| reference.id.clone())
                .or_else(|| {
                    reminder_recipient.as_ref().and_then(|(source, leaf)| {
                        if dependency.id != *leaf {
                            return None;
                        }
                        let mut source_reads = returned.dependencies.iter().filter(|read| {
                            read.id == *source
                                && read.model_name == "appointments.Appointment"
                                && read.field_name == "contact"
                                && read.type_id == "customer.Contact"
                                && read.role == DependencyRole::Data
                                && read.calls.is_empty()
                                && read.query_id.is_none()
                                && read.source == dependency.source
                        });
                        let source_read = source_reads.next()?;
                        if source_reads.next().is_some()
                            || dependency.model_name != "customer.Contact"
                            || dependency.field_name != "email"
                            || dependency.role != DependencyRole::Data
                            || !dependency.calls.is_empty()
                            || dependency.query_id.is_some()
                            || returned
                                .dependencies
                                .iter()
                                .position(|read| read == source_read)?
                                >= returned
                                    .dependencies
                                    .iter()
                                    .position(|read| read == dependency)?
                        {
                            return None;
                        }
                        Some(source.clone())
                    })
                });
            let current_reference = current_sites.as_ref().is_some_and(|current| {
                [
                    current.presence_read.control,
                    current.published_read.control,
                    current.revision_read.control,
                    current
                        .revision_read
                        .data
                        .expect("checked original Let DATA"),
                ]
                .contains(&dependency)
            });
            let current_published = current_sites
                .as_ref()
                .is_some_and(|current| current.published.dependency == dependency);
            let current_digest_data = current_sites
                .as_ref()
                .is_some_and(|current| current.digest_data.dependency == dependency);
            let result_id_field = "id".to_string();
            let (base, field, transition) = if let Some(value) = result_identity {
                (value, &result_id_field, None)
            } else if is_transition {
                if !dependency.calls.is_empty() || dependency.role != DependencyRole::Control {
                    return None;
                }
                let statements = sites.transitions.get(&site)?;
                if statements.len() != 1 {
                    return None;
                }
                let IrStmt::Transition {
                    model,
                    record,
                    field,
                    from,
                    to,
                    ..
                } = statements[0]
                else {
                    return None;
                };
                if model != &dependency.model_name {
                    return None;
                }
                (record, field, Some((from, to)))
            } else {
                let expressions = sites.members.get(&site)?;
                if expressions.len() != 1 {
                    return None;
                }
                let IrExpr::Member { base, field } = &expressions[0].expr else {
                    return None;
                };
                (base.as_ref(), field, None)
            };
            let optional_selected = result_identity.is_none()
                && !is_transition
                && sites
                    .members
                    .get(&site)
                    .and_then(|expressions| expressions.first())
                    .and_then(|expression| {
                        db.and_then(|db| {
                            checked_first_optional_actor_member(ir, item, expression, db).or_else(
                                || {
                                    checked_optional_parameter_scalar(
                                        ir,
                                        item,
                                        expression,
                                        checked.source_facts.as_deref()?,
                                        db,
                                    )
                                    .map(|(_, _, field)| field)
                                },
                            )
                        })
                    })
                    .is_some_and(|field| {
                        field.id == dependency.field
                            && field.owner == dependency.model
                            && field.ty == dependency.ty
                            && dependency.role == DependencyRole::Data
                    });
            if field != &dependency.field_name
                || !current_published
                    && !optional_selected
                    && base.ty
                        != (ResolvedType::Record {
                            symbol: dependency.model,
                            stored: true,
                        })
            {
                return None;
            }
            let owner = ir.items.get(dependency.model.0 as usize)?;
            let IrItemKind::Model { fields, .. } = &owner.kind else {
                return None;
            };
            let id_read = field == "id" && dependency.field == dependency.model;
            let parent_read = field == "parent" && dependency.field == dependency.model;
            let selected_transcript = checked
                .source_facts
                .as_deref()
                .and_then(|source| source.transcripts.as_deref())
                .and_then(|facts| {
                    facts.iter().find_map(|fact| {
                        let index = fact
                            .dependencies
                            .iter()
                            .position(|read| read == dependency)?;
                        let query = fact.query_dependencies.get(index)?;
                        (transcript
                            && query.role == DependencyRole::Data
                            && query.id != dependency.id
                            && query.source == dependency.source
                            && query.node == dependency.node
                            && query.calls == dependency.calls
                            && query.model == dependency.model
                            && query.field == dependency.field
                            && query.ty == dependency.ty
                            && query.type_id == dependency.type_id)
                            .then_some(fact)
                    })
                });
            let selected_inline = checked
                .source_facts
                .as_deref()
                .and_then(|source| source.inline_selections.as_deref())
                .and_then(|facts| {
                    facts.iter().find(|fact| {
                        dependency == &fact.bound_dependency
                            || fact.dependencies.iter().any(|read| read == dependency)
                    })
                });
            if let Some(fact) = selected_inline {
                let expression = sites.members.get(&site)?.first()?;
                checked_inline_selection_member(ir, item, fact, dependency, expression, db?)?;
            }
            let selected_value = checked
                .source_facts
                .as_deref()?
                .query_values
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|value| {
                    dependency.query_id.as_deref() == Some(value.query.id.as_str())
                        && returned.source_values.contains(&value.statement)
                        && dependency.calls.is_empty()
                        && dependency.role == DependencyRole::Data
                        && dependency.model == value.query.model
                        && value.query.dependencies.iter().any(|original| {
                            original.node == dependency.node
                                && original.role == DependencyRole::Data
                                && original.field == dependency.field
                                && original.ty == dependency.ty
                                && source_context.is_some_and(|context| {
                                    super::source_let_data::same_query_capture_type(
                                        context, dependency, original,
                                    )
                                })
                        })
                });
            if let Some(value) = selected_value {
                let expression = *sites.members.get(&site)?.first()?;
                let IrExpr::Member { base, field } = &expression.expr else {
                    return None;
                };
                let source = context_query_alias_name(source_context?, value)?;
                if expression.span != node_span(dependency.node)
                    || expression.ty != dependency.ty
                    || field != &dependency.field_name
                    || base.ty
                        != (ResolvedType::Record {
                            symbol: value.query.model,
                            stored: true,
                        })
                    || !matches!(&base.expr,IrExpr::Name(name)if name==&source)
                {
                    return None;
                }
            }
            if dependency.query_id.is_some()
                && !parent_read
                && selected_transcript.is_none()
                && selected_inline.is_none()
                && selected_value.is_none()
            {
                return None;
            }
            let transport_type = if id_read {
                if transition.is_some()
                    || !dependency.calls.is_empty()
                    || dependency.ty != ResolvedType::Scalar(Scalar::Text)
                    || dependency.type_id != "text"
                {
                    return None;
                }
                let expression = match result_identity {
                    Some(value) => value,
                    None => *sites.members.get(&site)?.first()?,
                };
                let original = if matches!(
                    returned.model_result,
                    Some(DisclosureModelResult::Reference { .. })
                ) {
                    checked_reference_model_result(ir, item, expression, models, db?)?
                } else {
                    checked_parameter_row_id(ir, item, expression, models, db?)
                        .or_else(|| {
                            db.and_then(|db| {
                                checked_sealed_narrowed_parameter_id(
                                    ir,
                                    item,
                                    expression,
                                    models,
                                    db,
                                    sealed_created_tail,
                                )
                            })
                        })
                        .or_else(|| {
                            db.and_then(|db| {
                                checked_sealed_created_row_id(
                                    ir,
                                    item,
                                    expression,
                                    db,
                                    sealed_created_tail,
                                )
                            })
                        })?
                };
                if original.id != dependency.model || original.canonical != dependency.model_name {
                    return None;
                }
                "text".to_string()
            } else if parent_read {
                if transition.is_some() {
                    return None;
                }
                let expression = sites.members.get(&site)?.first()?;
                let (child, parent) = if !dependency.calls.is_empty() {
                    checked_helper_parent_reference(
                        source_context?,
                        item,
                        dependency,
                        expression,
                        checked.source_facts.as_deref()?,
                    )?
                } else if dependency.query_id.is_some() {
                    let (child, parent, query_id) = checked_candidate_parent_association(
                        ir, item, dependency, expression, db?,
                    )?;
                    if !recipe.plan.queries.iter().any(|query| query.id == query_id) {
                        return None;
                    }
                    (child, parent)
                } else {
                    checked_parent_reference(ir, item, expression, db?)?
                };
                let mut descriptors = models.iter().filter(|model| model.name == child.canonical);
                let descriptor = descriptors.next()?;
                if descriptors.next().is_some()
                    || child.id != dependency.model
                    || parent.canonical != dependency.type_id
                    || dependency.ty
                        != (ResolvedType::Record {
                            symbol: parent.id,
                            stored: true,
                        })
                    || descriptor.parent.as_deref() != Some(parent.canonical.as_str())
                    || descriptor.scope_app
                    || descriptor.fields.iter().any(|field| field.name == "parent")
                {
                    return None;
                }
                parent.canonical.clone()
            } else {
                let stored = ir.items.get(dependency.field.0 as usize)?;
                let IrItemKind::Field {
                    owner: field_owner,
                    ty: IrType::Known(ty),
                    required_array,
                    modifiers,
                    ..
                } = &stored.kind
                else {
                    return None;
                };
                if owner.id != dependency.model
                    || stored.id != dependency.field
                    || *field_owner != owner.id
                    || !fields.contains(&stored.id)
                    || owner.canonical != dependency.model_name
                    || stored.name != dependency.field_name
                    || ty != &dependency.ty && !current_reference && !current_digest_data
                {
                    return None;
                }
                let descriptors: Vec<_> = models
                    .iter()
                    .filter(|model| model.name == owner.canonical)
                    .collect();
                if descriptors.len() != 1 {
                    return None;
                }
                let declared: Vec<_> = descriptors[0]
                    .fields
                    .iter()
                    .filter(|field| field.name == stored.name)
                    .collect();
                if declared.len() != 1 {
                    return None;
                }
                if profile_scalar_pair.is_some() {
                    let mut expected_models = profile_descriptors
                        .as_ref()?
                        .iter()
                        .filter(|model| model.name == owner.canonical);
                    let expected_model = expected_models.next()?;
                    let mut expected_fields = expected_model
                        .fields
                        .iter()
                        .filter(|field| field.name == stored.name);
                    let expected = expected_fields.next()?;
                    if expected_models.next().is_some()
                        || expected_fields.next().is_some()
                        || serde_json::to_value(expected_model).ok()?
                            != serde_json::to_value(descriptors[0]).ok()?
                        || declared[0].nullable
                            && !(reference_operand_type_id(ir, &dependency.ty).is_some()
                                && profile_scalar_pair.is_some_and(|(reference, _)| {
                                    matches!(&reference.ty, ResolvedType::Nullable(_))
                                }))
                        || declared[0].server_only
                        || declared[0].array_required.is_some()
                        || declared[0].machine.is_some()
                        || !matches!(&stored.kind, IrItemKind::Field { server: None, .. })
                        || serde_json::to_value(expected).ok()?
                            != serde_json::to_value(declared[0]).ok()?
                    {
                        return None;
                    }
                }
                if !matches!(base.expr, IrExpr::Name(_)) {
                    if let Some((reference, scalar)) = profile_scalar_pair {
                        if (reference.ty != base.ty
                            && checked_narrowed_if_reference(ir, item, base, db?)
                                .map(|field| field.id)
                                != Some(reference.field))
                            || scalar.model != dependency.model
                        {
                            return None;
                        }
                    } else if checked_notice_event_row_path(ir, item, base, db?)
                        == Some(dependency.model)
                    {
                        let facts = checked.source_facts.as_deref()?;
                        let mut source_schemas = facts
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .filter(|schema| schema.model && schema.id == dependency.model);
                        let source_schema = source_schemas.next()?;
                        let mut source_fields = source_schema
                            .fields
                            .iter()
                            .filter(|field| field.id == dependency.field);
                        let source_field = source_fields.next()?;
                        if source_schemas.next().is_some()
                            || source_fields.next().is_some()
                            || source_field.name != dependency.field_name
                            || source_field.ty != dependency.ty
                        {
                            return None;
                        }
                        match_stored_contract_schema(ir, source_schema, db?)?;
                        match_stored_contract_field(ir, source_field, db?)?;
                    } else if checked_contract_parameter_path(ir, item, base, db).is_some() {
                        let schema = checked_contract_parameter_row(ir, item, base, models, db?)?;
                        let mut originals = schema.fields.iter().filter(|original| {
                            original.id == dependency.field
                                && original.name == dependency.field_name
                                && original.ty == dependency.ty
                        });
                        let original = originals.next()?;
                        if schema.id != dependency.model || originals.next().is_some() {
                            return None;
                        }
                        match_stored_contract_field(ir, original, db?)?;
                    } else if !dependency.calls.is_empty()
                        && source_context
                            .zip(checked.source_facts.as_deref())
                            .is_some_and(|(context, facts)| {
                                checked_helper_identity_reference(
                                    context,
                                    item,
                                    dependency,
                                    sites.members[&site][0],
                                    facts,
                                )
                                .is_some()
                            })
                    {
                        // Its original helper parent path is sealed together with the field below.
                    } else if !current_published {
                        let (_, parent) = checked_parent_reference(ir, item, base, db?)?;
                        if parent.id != dependency.model {
                            return None;
                        }
                    }
                } else if checked
                    .source_facts
                    .as_deref()
                    .and_then(|facts| facts.queries.as_deref())
                    .is_some_and(|queries| {
                        queries
                            .iter()
                            .any(|query| query.first.is_some() && query.model == dependency.model)
                    })
                    && !optional_selected
                    && !source_context
                        .zip(checked.source_facts.as_deref())
                        .is_some_and(|(context, facts)| {
                            checked_helper_identity_reference(
                                context,
                                item,
                                dependency,
                                sites.members[&site][0],
                                facts,
                            )
                            .is_some()
                        })
                    && checked_created_row_operand(
                        ir,
                        item,
                        base,
                        dependency.model,
                        db?,
                        recipe.plan.purchase_receive_all.is_some(),
                        sealed_created_tail,
                    )
                    .is_none()
                    && checked_first_query_row(ir, item, base, db?)?.id != dependency.model
                {
                    return None;
                }
                if let Some(fact) = selected_transcript {
                    let expression = sites.members.get(&site)?.first()?;
                    checked_transcript_selected_member(ir, item, fact, expression, db?)?;
                }
                let reference_type = reference_operand_type_id(ir, ty);
                if current_reference || current_digest_data {
                    if transition.is_some() || !dependency.calls.is_empty() {
                        return None;
                    }
                    let mut expected_models = profile_descriptors
                        .as_ref()?
                        .iter()
                        .filter(|model| model.name == owner.canonical);
                    let expected = expected_models.next()?;
                    if expected_models.next().is_some()
                        || serde_json::to_value(expected).ok()?
                            != serde_json::to_value(descriptors[0]).ok()?
                        || !declared[0].nullable
                        || declared[0].server_only
                        || declared[0].array_required.is_some()
                        || declared[0].machine.is_some()
                    {
                        return None;
                    }
                    dependency.type_id.clone()
                } else if let Some(reference_type) = reference_type {
                    if transition.is_some() {
                        return None;
                    }
                    let expression = sites.members.get(&site)?.first()?;
                    let original = if !dependency.calls.is_empty() {
                        checked_helper_identity_reference(
                            source_context?,
                            item,
                            dependency,
                            expression,
                            checked.source_facts.as_deref()?,
                        )?
                    } else if let Some((reference, _)) = profile_source_pair {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == reference.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == reference.field)?
                    } else {
                        stored_reference_operand(ir, item, expression, db?).or_else(|| {
                            checked_sealed_created_reference(
                                ir,
                                item,
                                expression,
                                db?,
                                sealed_created_tail,
                            )
                        })?
                    };
                    if original.id != stored.id
                        || reference_type != dependency.type_id
                        || !stored_reference_descriptor_matches(ir, original, declared[0])
                    {
                        return None;
                    }
                    reference_type
                } else if *ty == ResolvedType::Scalar(Scalar::File)
                    || matches!(ty, ResolvedType::Nullable(inner) if **inner == ResolvedType::Scalar(Scalar::File))
                {
                    // Preserve the exact opaque File dependency. Files/State
                    // still own receiving/currentness and byte consumption.
                    let nullable = matches!(ty, ResolvedType::Nullable(_));
                    let expected = if nullable { "file?" } else { "file" };
                    let descriptor = declared[0];
                    if transition.is_some()
                        || dependency.role != DependencyRole::Data
                        || dependency.type_id != expected
                        || !matches!(descriptor.field, JsModelFieldType::File)
                        || descriptor.value_type.as_deref() != Some(expected)
                        || descriptor.nullable != nullable
                        || descriptor.array_required.is_some()
                        || descriptor.machine.is_some()
                    {
                        return None;
                    }
                    expected.into()
                } else if matches!(ty, ResolvedType::Array { element, .. }
                    if **element == ResolvedType::Scalar(Scalar::File))
                {
                    if transition.is_some()
                        || (!dependency.calls.is_empty() && selected_transcript.is_none())
                        || dependency.role != DependencyRole::Data
                        || dependency.type_id != "file[]"
                    {
                        return None;
                    }
                    let expression = sites.members.get(&site)?.first()?;
                    let original = if let Some(fact) = selected_inline {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == fact.query.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == dependency.field)?
                    } else if let Some(fact) = selected_transcript {
                        checked
                            .source_facts
                            .as_deref()?
                            .stored_contracts
                            .as_deref()?
                            .iter()
                            .find(|schema| schema.id == fact.model && schema.model)?
                            .fields
                            .iter()
                            .find(|field| field.id == dependency.field)?
                    } else {
                        stored_file_array_operand(ir, item, expression, db?)
                            .or_else(|| {
                                checked_stored_file_array_create_operand(
                                    source_context?,
                                    ir,
                                    item,
                                    expression,
                                    db?,
                                )
                            })
                            .or_else(|| {
                                checked_created_file_array_send_operand(
                                    ir,
                                    item,
                                    expression,
                                    db?,
                                    sealed_created_tail,
                                )
                            })?
                    };
                    if original.id != stored.id
                        || !stored_file_array_descriptor_matches(ir, original, declared[0])
                    {
                        return None;
                    }
                    "file[]".into()
                } else if let Some(contract) = stored_contract_inventory_type(
                    ir,
                    value_types,
                    ty,
                    declared[0],
                    stored,
                    checked.source_facts.as_deref(),
                    db,
                    item.canonical == "agreements.notice"
                        && dependency.model_name == "agreements.Term"
                        && dependency.field_name == "snapshot"
                        && checked_notice_event_row_path(ir, item, base, db?)
                            == Some(dependency.model),
                ) {
                    if transition.is_some() || contract != dependency.type_id {
                        return None;
                    }
                    contract
                } else if *required_array {
                    return None;
                } else if let ResolvedType::Enum {
                    owner: Some(enum_owner),
                    cases,
                } = ty
                {
                    if !modifiers.machine {
                        // Plain (non-machine) enum data reads transport as the
                        // sealed `enum(a,b)` identity, mirroring the
                        // query-predicate enum convention. A reused enum
                        // (`I.role: C.role`) names its declaring field, so
                        // the nominal path pins through the enum owner item
                        // rather than the reading field. Machine fields keep
                        // their existing transition-recipe path/refusal below.
                        if transition.is_some() {
                            return None;
                        }
                        checked_plain_enum_data_transport(
                            ir,
                            &dependency.type_id,
                            cases,
                            *enum_owner,
                            declared[0],
                        )?
                    } else {
                        // This inventory adaptation belongs only to a real transition
                        // recipe. Standalone machine-field reads retain their refusal.
                        if sites.transitions.is_empty()
                            || *enum_owner != stored.id
                            || dependency.type_id != stored.canonical
                            || !modifiers.machine
                        {
                            return None;
                        }
                        let descriptor = declared[0];
                        let JsModelFieldType::Enum { values } = &descriptor.field else {
                            return None;
                        };
                        let machine = descriptor.machine.as_ref()?;
                        if descriptor.nullable
                            || descriptor.array_required.is_some()
                            || values != cases
                            || &machine.states != cases
                            || !cases.contains(&machine.initial)
                        {
                            return None;
                        }
                        if let Some((from, to)) = transition
                            && (!cases.contains(from)
                                || !cases.contains(to)
                                || !machine.transitions.iter().any(|edge| {
                                    edge.from == *from
                                        && edge.to == *to
                                        && edge.operation == item.canonical
                                }))
                        {
                            return None;
                        }
                        let inline = format!("enum({})", cases.join(","));
                        if inventory_type(descriptor)? != inline {
                            return None;
                        }
                        inline
                    }
                } else if let Some(prefix) = checked_transcript_prefix_inventory(
                    ir,
                    item,
                    dependency,
                    declared[0],
                    value_types,
                    db,
                ) {
                    if transition.is_some() || prefix != dependency.type_id {
                        return None;
                    }
                    prefix
                } else if let Some(prefix) = checked_inline_prefix_inventory(
                    ir,
                    item,
                    dependency,
                    declared[0],
                    value_types,
                    db,
                ) {
                    if transition.is_some() || prefix != dependency.type_id {
                        return None;
                    }
                    prefix
                } else {
                    if transition.is_some()
                        || !supported_type_id(&dependency.type_id)
                        || inventory_type(declared[0])?.as_str() != dependency.type_id
                    {
                        return None;
                    }
                    dependency.type_id.clone()
                }
            };
            let role = match dependency.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let identity = (
                site.clone(),
                dependency.model_name.clone(),
                dependency.field_name.clone(),
                transport_type.clone(),
                role,
            );
            if let Some(previous) = dependency_ids.get(&dependency.id) {
                if previous.0 != identity.0
                    || previous.1 != identity.1
                    || previous.2 != identity.2
                    || previous.3 != identity.3
                    || previous.4 != identity.4
                {
                    return None;
                }
            } else {
                dependency_ids.insert(dependency.id.clone(), identity);
                if dependency_ids.len() + intrinsic_ids.len() > 200 {
                    return None;
                }
            }
            let reference_result = result_identity.is_some()
                && (matches!(
                    returned.model_result,
                    Some(DisclosureModelResult::Reference { .. })
                ) || result_identity.is_some_and(|value| {
                    checked_contract_parameter_path(ir, item, value, db).is_some()
                }));
            if reference_result {
                if !matches!(
                    returned.model_result,
                    Some(DisclosureModelResult::Reference { .. })
                ) {
                    native_return.reference_result = Some(NativeDependency {
                        id: dependency.id.clone(),
                        model: dependency.model_name.clone(),
                        field: "id".into(),
                        source_dependency_id: None,
                        captured_reference: false,
                    });
                } else {
                    let Some(DisclosureModelResult::Reference {
                        node,
                        source_model,
                        field,
                        ..
                    }) = returned.model_result
                    else {
                        return None;
                    };
                    let mut reads = returned.dependencies.iter().filter(|read| {
                        read.node == node
                            && read.model == source_model
                            && read.field == field
                            && read.role == DependencyRole::Data
                            && read.calls.is_empty()
                            && read.query_id.is_none()
                    });
                    let read = reads.next()?;
                    if reads.next().is_some() || native_return.reference_result.is_some() {
                        return None;
                    }
                    native_return.reference_result = Some(NativeDependency {
                        id: dependency.id.clone(),
                        model: dependency.model_name.clone(),
                        field: "id".into(),
                        source_dependency_id: Some(read.id.clone()),
                        captured_reference: false,
                    });
                }
            } else {
                let captured_reference = captured_scalar_sites.contains(&site);
                let observed = recipe.dependencies.entry(site).or_default();
                if let Some(previous) = observed.iter().find(|read| read.id == dependency.id) {
                    if previous.source_dependency_id != source_dependency_id
                        || previous.captured_reference != captured_reference
                    {
                        return None;
                    }
                } else {
                    observed.push(NativeDependency {
                        id: dependency.id.clone(),
                        model: dependency.model_name.clone(),
                        field: dependency.field_name.clone(),
                        source_dependency_id,
                        captured_reference,
                    });
                }
            }
            plan_return.dependencies.push(ReceiptDependency {
                id: dependency.id.clone(),
                source: transport_source(&dependency.source, entry_module)?,
                role,
                model: dependency.model_name.clone(),
                field: dependency.field_name.clone(),
                type_id: transport_type,
                query_id: dependency.query_id.clone(),
            });
        }

        for intrinsic in &returned.intrinsics {
            if intrinsic.id.is_empty()
                || dependency_ids.contains_key(&intrinsic.id)
                || plan_return
                    .intrinsics
                    .iter()
                    .any(|value| value.id == intrinsic.id)
                || !source_matches(ir, &intrinsic.source, node_span(intrinsic.node))
                || (intrinsic.calls.is_empty() && intrinsic.source != checked.source)
            {
                return None;
            }
            let source_key = (intrinsic.node.file, intrinsic.source.module.clone());
            if let Some(previous) = source_origins.get(&source_key) {
                if previous != &intrinsic.source {
                    return None;
                }
            } else {
                source_origins.insert(source_key, intrinsic.source.clone());
            }
            let site = checked_site(intrinsic.node, &intrinsic.calls)?;
            let input = matches!(
                intrinsic.kind,
                DisclosureIntrinsicKind::AdmittedInput { .. }
            );
            if if input {
                intrinsic.node.kind != SyntaxKind::NameRef as u8
                    && intrinsic.node.kind != SyntaxKind::Path as u8
                    && intrinsic.node.kind != SyntaxKind::Name as u8
                    && intrinsic.node.kind != SyntaxKind::Member as u8
            } else {
                intrinsic.node.kind != SyntaxKind::Member as u8
            } {
                return None;
            }
            let expressions = if input && intrinsic.node.kind != SyntaxKind::Member as u8 {
                sites.names.get(&site)?
            } else {
                sites.members.get(&site)?
            };
            if expressions.len() != 1 {
                return None;
            }
            let expression = expressions[0];
            if expression.ty != intrinsic.ty {
                return None;
            }
            let kind = match &intrinsic.kind {
                DisclosureIntrinsicKind::OperationId => {
                    let IrExpr::Member { base, field } = &expression.expr else {
                        return None;
                    };
                    if field != "id"
                        || base.ty != ResolvedType::OperationContext
                        || !matches!(&base.expr, IrExpr::Member { base: context, field: operation }
                            if operation == "operation" && context.ty == ResolvedType::Unknown
                                && matches!(&context.expr, IrExpr::Name(name) if name == "c"))
                        || intrinsic.ty != ResolvedType::Scalar(Scalar::Text)
                        || intrinsic.type_id != "text"
                    {
                        return None;
                    }
                    NativeIntrinsicKind::OperationId
                }
                DisclosureIntrinsicKind::AdmittedInput {
                    parameter,
                    parameter_name,
                } => {
                    let nested = checked_contract_parameter_path(ir, item, expression, db);
                    let event_scalar = item.canonical == "events.attendee_notice"
                        && [("eventKind", "kind"), ("eventBody", "body")].iter().any(
                            |(slot, field)| {
                                parameter_name == slot
                                    && db.is_some_and(|db| {
                                        checked_notice_event_field(ir, item, expression, field, db)
                                            == Some(*parameter)
                                    })
                            },
                        );
                    let event_revision = parameter_name == "eventRevision"
                        && checked_notice_event_field(ir, item, expression, "revision", db?)
                            == Some(*parameter);
                    if !matches!(expression.expr, IrExpr::Name(_))
                        && nested.is_none()
                        && !event_revision
                        && !event_scalar
                    {
                        return None;
                    }
                    if let Some((root, path)) = &nested {
                        if root != parameter || path != parameter_name {
                            return None;
                        }
                    } else if !direct_field_name(parameter_name) {
                        return None;
                    }
                    if let ResolvedType::Scalar(scalar) = &intrinsic.ty {
                        if !crate::analysis::scenario_disclosure::primitive_type(&intrinsic.ty)
                            || intrinsic.type_id != scalar.as_str()
                        {
                            return None;
                        }
                    } else if event_scalar && parameter_name == "eventKind" {
                        let ResolvedType::Enum {
                            owner: Some(kind),
                            cases,
                        } = &intrinsic.ty
                        else {
                            return None;
                        };
                        if ir.items.get(kind.0 as usize)?.canonical != "events.Notice.kind"
                            || intrinsic.type_id != "enum(confirmation,change,cancellation)"
                            || cases != &["confirmation", "change", "cancellation"]
                            || expression.ty != intrinsic.ty
                        {
                            return None;
                        }
                    } else {
                        return None;
                    }
                    if !event_revision && !event_scalar {
                        let parameter_item = ir.items.get(parameter.0 as usize)?;
                        let IrItemKind::Param {
                            owner: parameter_owner,
                            index,
                            ty: IrType::Known(parameter_ty),
                            default,
                            ..
                        } = &parameter_item.kind
                        else {
                            return None;
                        };
                        if parameter_item.id != *parameter
                            || *parameter_owner != item.id
                            || params.get(*index) != Some(parameter)
                            || (nested.is_none()
                                && (parameter_item.name != *parameter_name
                                    || parameter_ty != &intrinsic.ty))
                            || default.is_some()
                        {
                            return None;
                        }
                    }
                    NativeIntrinsicKind::AdmittedInput {
                        parameter: parameter_name.clone(),
                    }
                }
                DisclosureIntrinsicKind::CreatedModelVersion {
                    create,
                    model,
                    model_name,
                } => {
                    let context = source_context?;
                    context.same_scenario(ir, item)?;
                    checked_created_model_result(ir, item)?;
                    let IrExpr::Member { base, field } = &expression.expr else {
                        return None;
                    };
                    let IrExpr::Name(name) = &base.expr else {
                        return None;
                    };
                    if field != "version"
                        || intrinsic.ty != ResolvedType::Scalar(Scalar::Int)
                        || intrinsic.type_id != "int"
                        || !intrinsic.calls.is_empty()
                        || base.ty
                            != (ResolvedType::Record {
                                symbol: *model,
                                stored: true,
                            })
                        || ir.items.get(model.0 as usize)?.canonical != *model_name
                    {
                        return None;
                    }
                    let binding = [SyntaxKind::NameRef, SyntaxKind::Name, SyntaxKind::Path]
                        .iter()
                        .find_map(|kind| {
                            context
                                .resolved()
                                .node_binding
                                .get(&crate::analysis::NodeKey {
                                    file: base.span.file,
                                    start: base.span.start,
                                    end: base.span.end,
                                    kind: *kind as u8,
                                })
                        })?;
                    if !matches!(binding,crate::analysis::resolve::Binding::CreateAs{node}if node==create)
                    {
                        return None;
                    }
                    let source =
                        serde_json::to_value(transport_source(&checked.source, entry_module)?)
                            .ok()?;
                    let roots = super::source_created_rows::collect(ir, item, context, &source)?;
                    let created = roots.into_iter().find(|root| {
                        root["node"]["start"] == create.start
                            && root["node"]["end"] == create.end
                            && root["binding"] == *name
                            && root["model"] == *model_name
                    })?;
                    NativeIntrinsicKind::CreatedModelVersion { created }
                }
                DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter,
                    parameter_name,
                    model,
                    model_name,
                } => {
                    let IrExpr::Member { base, field } = &expression.expr else {
                        return None;
                    };
                    let nested = checked_contract_parameter_path(ir, item, base, db);
                    let event_field = checked_delivery_event_row_name(item)
                        .and_then(|name| checked_notice_event_field(ir, item, base, name, db?));
                    let event_term =
                        parameter_name == "eventTerm" && event_field == Some(*parameter);
                    if let Some((root, path)) = &nested {
                        if root != parameter || path != parameter_name {
                            return None;
                        }
                        checked_contract_parameter_row(ir, item, base, models, db?)?;
                    }
                    if field != "version"
                        || (!matches!(base.expr, IrExpr::Name(_))
                            && nested.is_none()
                            && !event_term)
                        || base.ty
                            != (ResolvedType::Record {
                                symbol: *model,
                                stored: true,
                            })
                        || intrinsic.ty != ResolvedType::Scalar(Scalar::Int)
                        || intrinsic.type_id != "int"
                        || (nested.is_none() && !direct_field_name(parameter_name))
                    {
                        return None;
                    }
                    if !event_term {
                        let parameter_item = ir.items.get(parameter.0 as usize)?;
                        let IrItemKind::Param {
                            owner: parameter_owner,
                            index,
                            ty: IrType::Known(parameter_ty),
                            default,
                            ..
                        } = &parameter_item.kind
                        else {
                            return None;
                        };
                        if parameter_item.id != *parameter
                            || *parameter_owner != item.id
                            || params.get(*index) != Some(parameter)
                            || (nested.is_none()
                                && (parameter_item.name != *parameter_name
                                    || parameter_ty != &base.ty))
                            || default.is_some()
                        {
                            return None;
                        }
                    }
                    let model_item = ir.items.get(model.0 as usize)?;
                    if model_item.id != *model
                        || model_item.canonical != *model_name
                        || !matches!(model_item.kind, IrItemKind::Model { .. })
                        || models
                            .iter()
                            .filter(|value| value.name == *model_name)
                            .count()
                            != 1
                    {
                        return None;
                    }
                    NativeIntrinsicKind::AdmittedReferenceVersion {
                        parameter: parameter_name.clone(),
                        model: model_name.clone(),
                    }
                }
            };
            let role = match intrinsic.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let identity = (site.clone(), kind.clone(), intrinsic.type_id.clone(), role);
            if let Some(previous) = intrinsic_ids.get(&intrinsic.id) {
                if previous != &identity {
                    return None;
                }
            } else {
                intrinsic_ids.insert(intrinsic.id.clone(), identity);
                if dependency_ids.len() + intrinsic_ids.len() > 200 {
                    return None;
                }
            }
            let observed = recipe.intrinsics.entry(site).or_default();
            if !observed.iter().any(|value| value.id == intrinsic.id) {
                observed.push(NativeIntrinsic {
                    id: intrinsic.id.clone(),
                    kind: kind.clone(),
                });
            }
            plan_return.intrinsics.push(ReceiptIntrinsic {
                id: intrinsic.id.clone(),
                source: transport_source(&intrinsic.source, entry_module)?,
                role,
                type_id: intrinsic.type_id.clone(),
                kind,
            });
        }

        recipe.returns.push(native_return);
        recipe.plan.returns.push(plan_return);
    }
    if matched_returns != sites.returns {
        return None;
    }
    if transcript
        && serde_json::to_value(&recipe.plan).ok()? != serde_json::to_value(query_plan?).ok()?
    {
        return None;
    }

    Some(recipe)
}

/// A prepared first-query plan contributes only its original source domain
/// associations. Effects, row reads, decisions and the created result remain
/// owned by this collector rather than the query preparation's skeleton.
/// Existing native selectors admit only their individual source profile or
/// the authored first-then-contained-count composition on the same result.
pub(super) fn checked_any_query_ir<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    actual: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    if checked_scenario_query_influences(facts)?.len() != 24 {
        return None;
    }
    let [query, _, _, _] = facts.queries.as_deref()? else {
        return None;
    };
    let IrItemKind::Scenario { guards, params, .. } = &owner.kind else {
        return None;
    };
    let mut statements = guards.iter().filter_map(|statement| {
        let IrStmt::Require { cond, span } = statement else {
            return None;
        };
        let IrExpr::Unary {
            op: super::ir::IrUnOp::Not,
            operand,
        } = &cond.expr
        else {
            return None;
        };
        std::ptr::eq(operand.as_ref(), actual).then_some((cond, *span))
    });
    let (condition, statement) = statements.next()?;
    let (target, args, slots) = match &actual.expr {
        IrExpr::Call { target, args } => (target, args, None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args, Some(slots.as_slice())),
        _ => return None,
    };
    let [domain, predicate] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let IrExpr::Lambda { param, body } = &predicate.expr else {
        return None;
    };
    let checked = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let [alias] = checked.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind else {
        return None;
    };
    let [(receiver, parameter_id)] = query.inputs.as_slice() else {
        return None;
    };
    let parameter = ir.items.get(parameter_id.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: parent_id,
                stored: true,
            }),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let original_parameter = facts.parameters.get(*index)?;
    let parent = scan.parent.as_deref()?;
    let [dependency] = query.dependencies.as_slice() else {
        return None;
    };
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let model = ir.items.get(query.model.0 as usize)?;
    let IrExpr::Member { base, field } = &body.expr else {
        return None;
    };
    let sites = facts.decision_sites.as_deref()?;
    let mut original_calls =
        sites
            .iter()
            .filter(|site| {
                site.owner==owner.id
        && node_span(site.statement)==statement && node_span(site.node)==condition.span
        && site.stage==crate::analysis::scenario_disclosure::CheckedDecisionStage::LeadingRequire
        && site.source==facts.source
            })
            .flat_map(|site| &site.calls)
            .filter(|call| node_span(call.node) == actual.span);
    let original_call = original_calls.next()?;
    let census = facts.expression_types.as_deref()?;
    if statements.next().is_some()
        || original_calls.next().is_some()
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
        || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
        || actual.ty != boolean
        || condition.ty != boolean
        || predicate.ty != boolean
        || body.ty != boolean
        || collection.node != original_call.node
        || collection.builtin != "any"
        || collection.overload != 0
        || collection.model != query.model
        || collection.query != query.node
        || Some(collection.alias) != query.alias
        || collection.alias != alias.node
        || collection
            .predicate
            .as_ref()
            .is_none_or(|value| Some(value.node) != query.predicate || value.ty != boolean)
        || original_call.target
            != (crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin {
                id: "any".into(),
                overload: 0,
            })
        || original_call.arguments
            != vec![
                (query.node, array.clone()),
                (query.predicate?, boolean.clone()),
            ]
        || original_call.slots != [Some(0), Some(1)]
        || !original_call.defaults.is_empty()
        || !original_call.chain.is_empty()
        || original_call.source != facts.source
        || original_call.module != owner.module
        || checked.node != query.node
        || checked.domain != query.domain
        || checked.projection.is_some()
        || checked.domain_type != array
        || checked.result != array
        || domain.ty != array
        || domain.span != node_span(query.node)
        || body.span != node_span(query.predicate?)
        || param != name
        || param != "run"
        || field != "unfinished"
        || base.ty != record
        || !matches!(&base.expr,IrExpr::Name(value) if value==param)
        || scan.contract_collection_call.is_some()
        || scan.where_pred.is_some()
        || scan.where_async
        || scan.select.is_some()
        || scan.select_param.is_some()
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || !matches!(&scan.domain,super::ir::IrQueryDomain::Model(value) if value==&model.canonical)
        || *parameter_owner != owner.id
        || params.get(*index) != Some(parameter_id)
        || original_parameter.parameter != *parameter_id
        || original_parameter.default.is_some()
        || original_parameter.ty != parent.ty
        || parent.span != node_span(*receiver)
        || !matches!(&parent.expr,IrExpr::Name(value) if value==&parameter.name)
        || !matches!(&model.kind,IrItemKind::Model {owner:IrOwner::ChildOf(value),..} if value==parent_id)
        || dependency.role != DependencyRole::Control
        || dependency.ty != boolean
        || dependency.type_id != "bool"
        || dependency.model != query.model
        || dependency.model_name != model.canonical
        || dependency.node != query.predicate?
        || dependency.field_name != *field
        || !dependency.calls.is_empty()
        || dependency.query_id.is_some()
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == actual.span && ty == &actual.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == body.span && ty == &body.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == base.span && ty == &base.ty)
        || !census
            .iter()
            .any(|(node, ty)| node_span(*node) == parent.span && ty == &parent.ty)
    {
        return None;
    }
    let source_receiver = checked_effect_node(ir, owner, *receiver, db)?;
    let source_predicate = checked_effect_node(ir, owner, query.predicate?, db)?;
    let text = &db.get(receiver.file)?.text;
    let source_base = source_predicate
        .children
        .iter()
        .find(|part| matches!(part.kind, SyntaxKind::NameRef))?;
    let source_field = source_predicate
        .children
        .iter()
        .rev()
        .find(|part| part.kind == SyntaxKind::Name)?;
    if source_receiver.kind != SyntaxKind::NameRef
        || text.get(receiver.start as usize..receiver.end as usize)? != parameter.name
        || source_predicate.kind != SyntaxKind::Member
        || source_base.span != base.span
        || text.get(source_base.span.start as usize..source_base.span.end as usize)? != param
        || source_field.token()?.text(text) != "unfinished"
    {
        return None;
    }
    for id in [query.model, *parent_id] {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id && schema.model);
        let schema = schemas.next()?;
        if schemas.next().is_some() || schema.source != query.source {
            return None;
        }
        match_stored_contract_fields(ir, schema, db)?;
        if id == query.model
            && schema
                .fields
                .iter()
                .filter(|field| {
                    field.id == dependency.field
                        && field.name == dependency.field_name
                        && field.ty == boolean
                })
                .count()
                != 1
        {
            return None;
        }
    }
    Some(query)
}

/// Exact original leading `not any(...)` guard over a navigated parent
/// collection, joined with a same-scenario `first` selection: the two-query
/// `[any, first]` composition census. Mirrors the single-query any owner pin
/// for pin, but admits the navigated `param.parent` receiver (sealed through
/// the existing one-hop containment owner), one Control dependency per
/// authored `and` conjunct (field comparison or bare bool read), and a void
/// effect tail. Any other shape keeps the refusal.
/// Resolved one-hop containment parent for the direct leading-any
/// composition. The input model I (parameter declaration) stays distinct
/// from the resolved parent model P (navigated `param.parent` link): the
/// child collection is contained under P, never scanned under the input
/// row. Shared by the matcher and the emitted plan edge so the lineage
/// cannot drift between them.
fn any_parent_receiver_spelling(
    source_receiver: &SyntaxNode,
    text: &str,
    base: &SyntaxNode,
    field: &SyntaxNode,
    receiver: crate::analysis::NodeKey,
    parameter_name: &str,
) -> bool {
    source_receiver.kind == SyntaxKind::Member
        && text
            .get(base.span.start as usize..base.span.end as usize)
            .is_some_and(|got| got == parameter_name)
        && text
            .get(field.span.start as usize..field.span.end as usize)
            .is_some_and(|got| got == "parent")
        && text
            .get(receiver.start as usize..receiver.end as usize)
            .is_some_and(|got| got == format!("{parameter_name}.parent"))
}

fn any_parent_link_matches(
    parent_field: &str,
    parent_base_name: &str,
    parent_base: &TypedExpr,
    parameter_name: &str,
    base_span: Span,
    parent_span: Span,
    receiver_span: Span,
    expected_ty: &ResolvedType,
) -> bool {
    parent_field == "parent"
        && parent_base_name == parameter_name
        && parent_base.span == base_span
        && parent_base.ty == *expected_ty
        && parent_span == receiver_span
}

fn any_parent_models_valid(
    parameter_owner: &crate::analysis::SymbolId,
    owner_id: crate::analysis::SymbolId,
    params: &[crate::analysis::SymbolId],
    index: usize,
    parameter_id: &crate::analysis::SymbolId,
    original_parameter: &crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    parent_base_ty: &ResolvedType,
    input_parent: Option<crate::analysis::SymbolId>,
    parent_model: crate::analysis::SymbolId,
    model_is_child_of_parent: bool,
) -> bool {
    *parameter_owner == owner_id
        && params.get(index) == Some(parameter_id)
        && original_parameter.parameter == *parameter_id
        && original_parameter.default.is_none()
        && original_parameter.ty == *parent_base_ty
        && input_parent == Some(parent_model)
        && model_is_child_of_parent
}

pub(super) fn checked_any_first_parent<'a, 'b>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    any: &crate::analysis::scenario_disclosure::DisclosureQuery,
    actual: &'b TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a IrItem,
    crate::analysis::SymbolId,
    &'b TypedExpr,
    &'b TypedExpr,
    crate::analysis::SymbolId,
)> {
    // Returns (parameter item, input model I, parent expr, parent base
    // expr, resolved parent model P).
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let args = match &actual.expr {
        IrExpr::Call { args, .. } => args.as_slice(),
        IrExpr::BoundCall { args, .. } => args.as_slice(),
        _ => return None,
    };
    let [domain, _] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    let [(receiver, parameter_id)] = any.inputs.as_slice() else {
        return None;
    };
    let parameter = ir.items.get(parameter_id.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: input_id,
                stored: true,
            }),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let original_parameter = facts.parameters.get(*index)?;
    // Navigated collection: the scan parent is the `param.parent` link.
    // The decoded IR base must match the exact original NameRef child
    // occurrence and the declared input type, not just the parameter name.
    let source_receiver = checked_effect_node(ir, owner, *receiver, db)?;
    let text = &db.get(receiver.file)?.text;
    let mut bases = source_receiver
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::NameRef);
    let mut fields = source_receiver
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Name);
    let (Some(base), None) = (bases.next(), bases.next()) else {
        return None;
    };
    let (Some(field), None) = (fields.next(), fields.next()) else {
        return None;
    };
    if !any_parent_receiver_spelling(
        &source_receiver,
        text,
        base,
        field,
        *receiver,
        &parameter.name,
    ) {
        return None;
    }
    let parent = scan.parent.as_deref()?;
    let IrExpr::Member {
        base: parent_base,
        field: parent_field,
    } = &parent.expr
    else {
        return None;
    };
    let IrExpr::Name(parent_base_name) = &parent_base.expr else {
        return None;
    };
    if !any_parent_link_matches(
        parent_field,
        parent_base_name,
        parent_base,
        &parameter.name,
        base.span,
        parent.span,
        node_span(*receiver),
        &original_parameter.ty,
    ) {
        return None;
    }
    // The input model (I, from the parameter declaration) and the resolved
    // parent model (P, from the navigated link) stay distinct: the child
    // collection is contained under P, not under the input row.
    let ResolvedType::Record {
        symbol: parent_model,
        stored: true,
    } = parent.ty
    else {
        return None;
    };
    let model = ir.items.get(any.model.0 as usize)?;
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    // The navigation parent must be the input model's owning containment
    // parent, and the child collection must hang under the same parent.
    let contracts = facts.stored_contracts.as_deref()?;
    let input_schema = contracts
        .iter()
        .find(|schema| schema.model && schema.id == *input_id)?;
    let model_is_child_of_parent = matches!(&model.kind, IrItemKind::Model {owner:IrOwner::ChildOf(value),..} if *value==parent_model);
    if !any_parent_models_valid(
        parameter_owner,
        owner.id,
        params,
        *index,
        parameter_id,
        original_parameter,
        &parent_base.ty,
        input_schema.parent,
        parent_model,
        model_is_child_of_parent,
    ) {
        return None;
    }
    Some((parameter, *input_id, parent, parent_base, parent_model))
}

/// Traverse only AND joins, preserving authored left-to-right leaf order.
/// Callers retain their existing join-type and frontier limits: these options
/// describe a walk, never a supported query or an admitted source expression.
pub(super) fn predicate_conjuncts(
    root: &TypedExpr,
    boolean_joins: bool,
    frontier_limit: Option<usize>,
) -> Option<Vec<&TypedExpr>> {
    let mut pending = vec![root];
    let mut leaves = Vec::new();
    while let Some(node) = pending.pop() {
        if let IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } = &node.expr
        {
            if boolean_joins && node.ty != ResolvedType::Scalar(Scalar::Bool) {
                return None;
            }
            pending.push(right.as_ref());
            pending.push(left.as_ref());
        } else {
            leaves.push(node);
        }
        if frontier_limit.is_some_and(|limit| pending.len() + leaves.len() > limit) {
            return None;
        }
    }
    Some(leaves)
}

/// Structural predicate operand join shared by proof and emission. Source
/// spelling, receiver schema, dependency identities and operand provenance
/// remain independently checked by their owning consumers.
pub(super) struct PredicateMemberLeaf<'a> {
    pub member: &'a TypedExpr,
    pub receiver: &'a TypedExpr,
    pub field: &'a str,
    pub operand: Option<&'a TypedExpr>,
}

pub(super) fn predicate_member_leaf<'a>(
    leaf: &'a TypedExpr,
    alias: &str,
) -> Option<PredicateMemberLeaf<'a>> {
    let (member, operand) = match &leaf.expr {
        IrExpr::Binary {
            op: IrBinOp::Eq,
            left,
            right,
        } => (left.as_ref(), Some(right.as_ref())),
        IrExpr::Member { .. } => (leaf, None),
        _ => return None,
    };
    let IrExpr::Member {
        base: receiver,
        field,
    } = &member.expr
    else {
        return None;
    };
    if !matches!(&receiver.expr, IrExpr::Name(name) if name == alias)
        || leaf.ty != ResolvedType::Scalar(Scalar::Bool)
        || match operand {
            Some(value) => value.ty != member.ty,
            None => member.ty != ResolvedType::Scalar(Scalar::Bool),
        }
    {
        return None;
    }
    Some(PredicateMemberLeaf {
        member,
        receiver,
        field,
        operand,
    })
}

pub(super) fn checked_any_first_query_ir<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    actual: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    if checked_native_query_influences(facts.queries.as_deref()?)?.len() != 8 {
        return None;
    }
    let [any, first] = facts.queries.as_deref()? else {
        return None;
    };
    if any.first.is_some()
        || any.count.is_some()
        || any.projection.is_some()
        || any.cardinality_guard.is_some()
        || any.alias.is_none()
        || any.predicate.is_none()
        || first.first.is_none()
        || first.count.is_some()
    {
        return None;
    }
    let boolean = ResolvedType::Scalar(Scalar::Bool);
    let IrItemKind::Scenario { guards, params, .. } = &owner.kind else {
        return None;
    };
    // Exactly one leading `require any(...)` / `require not any(...)`
    // guard carries `actual`. The negated composition and its positive
    // dual share the same sealed narrow profile; polarity lives in the
    // emitted guard alone, never in the receipt plan.
    let mut statements = guards.iter().filter_map(|statement| {
        let IrStmt::Require { cond, span } = statement else {
            return None;
        };
        if let IrExpr::Unary {
            op: super::ir::IrUnOp::Not,
            operand,
        } = &cond.expr
        {
            return std::ptr::eq(operand.as_ref(), actual).then_some((cond, *span));
        }
        std::ptr::eq(cond, actual).then_some((cond, *span))
    });
    let (condition, statement) = statements.next()?;
    let (target, args, slots) = match &actual.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain, predicate] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let IrExpr::Lambda { param, body } = &predicate.expr else {
        return None;
    };
    let checked = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let [alias] = checked.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind else {
        return None;
    };
    if param != name {
        return None;
    }
    // Shared sealed one-hop lineage: input I, resolved parent P, child C
    // and the original base occurrence stay bound together here.
    let (_parameter, parent_id, parent, parent_base, _parent_model) =
        checked_any_first_parent(ir, owner, any, actual, db)?;
    let record = ResolvedType::Record {
        symbol: any.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let model = ir.items.get(any.model.0 as usize)?;
    // Flatten the authored `and` chain order-preserving; each leaf carries
    // exactly one recorded Control dependency, in order.
    let leaves = predicate_conjuncts(body, true, None)?;
    if leaves.len() != any.dependencies.len() || leaves.is_empty() {
        return None;
    }
    let text = &db.get(actual.span.file)?.text;
    let mut seen = std::collections::HashSet::new();
    let mut census: Vec<(&Span, &ResolvedType)> = vec![
        (&actual.span, &actual.ty),
        (&body.span, &body.ty),
        (&parent.span, &parent.ty),
        (&parent_base.span, &parent_base.ty),
    ];
    for (leaf, dependency) in leaves.iter().zip(any.dependencies.iter()) {
        let PredicateMemberLeaf {
            member,
            receiver,
            field: field_name,
            operand,
        } = predicate_member_leaf(leaf, param)?;
        let member_ty = &member.ty;
        if receiver.ty != record
            || dependency.ty != *member_ty
            || (operand.is_none() != (*member_ty == boolean))
        {
            return None;
        }
        // Decoded member spans may include surrounding trivia (e.g. the
        // space after `and`); trim ASCII whitespace for the spelling
        // comparison only. Node identity stays pinned by the exact
        // (span, type) census below.
        let member_text = text
            .get(member.span.start as usize..member.span.end as usize)
            .map(str::trim);
        if member_text != Some(format!("{param}.{field_name}").as_str()) {
            return None;
        }
        if let Some(operand) = operand {
            // Operand is the contextual actor read or a member read
            // off a real scenario parameter (the alias row itself is never
            // an operand base); anything else keeps the refusal. The base
            // spelling, member field bytes, and (span, type) census below
            // seal the exact authored expression.
            let IrExpr::Member {
                base,
                field: operand_field,
            } = &operand.expr
            else {
                return None;
            };
            let IrExpr::Name(operand_base) = &base.expr else {
                return None;
            };
            let operand_text = text
                .get(operand.span.start as usize..operand.span.end as usize)
                .map(str::trim)?;
            if operand_text == "actor" {
                // Contextual actor read: exact synthetic carrier identity
                // (base `c`, Unknown type, base span is the operand span),
                // mirroring the established first-query predicate owner.
                // Anything else under actor bytes keeps the refusal.
                if operand_field != "actor"
                    || !matches!(&base.expr, IrExpr::Name(name) if name == "c")
                    || base.ty != ResolvedType::Unknown
                    || base.span != operand.span
                    || operand.ty != ResolvedType::Scalar(Scalar::User)
                {
                    return None;
                }
            } else {
                let owner_param = params.iter().find_map(|id| {
                    let item = ir.items.get(id.0 as usize)?;
                    (item.name == *operand_base).then_some(item)
                });
                let owner_param = owner_param?;
                if operand_text != format!("{operand_base}.{operand_field}")
                    || owner_param.name == *param
                {
                    return None;
                }
            }
            census.push((&operand.span, &operand.ty));
        }
        if dependency.role != DependencyRole::Control
            || dependency.model != any.model
            || dependency.model_name != model.canonical
            || dependency.field_name != field_name
            || !dependency.calls.is_empty()
            || dependency.query_id.is_some()
            || dependency.id.is_empty()
            || !seen.insert(&dependency.id)
            || node_span(dependency.node) != member.span
        {
            return None;
        }
        census.push((&leaf.span, &leaf.ty));
        census.push((&member.span, &member.ty));
    }
    let sites = facts.decision_sites.as_deref()?;
    let mut original_calls =
        sites
            .iter()
            .filter(|site| {
                site.owner==owner.id
        && node_span(site.statement)==statement && node_span(site.node)==condition.span
        && site.stage==crate::analysis::scenario_disclosure::CheckedDecisionStage::LeadingRequire
        && site.source==facts.source
            })
            .flat_map(|site| &site.calls)
            .filter(|call| node_span(call.node) == actual.span);
    let original_call = original_calls.next()?;
    let expression_types = facts.expression_types.as_deref()?;
    if statements.next().is_some()
        || original_calls.next().is_some()
        || !matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
        || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
        || actual.ty != boolean
        || condition.ty != boolean
        || predicate.ty != boolean
        || body.ty != boolean
        || collection.node != original_call.node
        || collection.builtin != "any"
        || collection.overload != 0
        || collection.model != any.model
        || collection.query != any.node
        || Some(collection.alias) != any.alias
        || collection.alias != alias.node
        || collection
            .predicate
            .as_ref()
            .is_none_or(|value| Some(value.node) != any.predicate || value.ty != boolean)
        || original_call.target
            != (crate::analysis::scenario_disclosure::CheckedDecisionCallTarget::Builtin {
                id: "any".into(),
                overload: 0,
            })
        || original_call.arguments
            != vec![(any.node, array.clone()), (any.predicate?, boolean.clone())]
        || original_call.slots != [Some(0), Some(1)]
        || !original_call.defaults.is_empty()
        || !original_call.chain.is_empty()
        || original_call.source != facts.source
        || original_call.module != owner.module
        || checked.node != any.node
        || checked.domain != any.domain
        || checked.projection.is_some()
        || checked.domain_type != array
        || checked.result != array
        || domain.ty != array
        || domain.span != node_span(any.node)
        || scan.contract_collection_call.is_some()
        || scan.where_pred.is_some()
        || scan.where_async
        || scan.select.is_some()
        || scan.select_param.is_some()
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || !matches!(&scan.domain,super::ir::IrQueryDomain::Model(value) if value==&model.canonical)
        || !census.iter().all(|(span, ty)| {
            expression_types
                .iter()
                .any(|(node, actual_ty)| node_span(*node) == **span && *actual_ty == **ty)
        })
    {
        return None;
    }
    for id in [any.model, parent_id] {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id && schema.model);
        let schema = schemas.next()?;
        if schemas.next().is_some() || schema.source != any.source {
            return None;
        }
        match_stored_contract_fields(ir, schema, db)?;
        if id == any.model {
            for dependency in any.dependencies.iter() {
                if schema
                    .fields
                    .iter()
                    .filter(|field| {
                        field.id == dependency.field
                            && field.name == dependency.field_name
                            && field.ty == dependency.ty
                    })
                    .count()
                    != 1
                {
                    return None;
                }
            }
        }
    }
    Some(any)
}

/// Exact original leading helper call joined to its source-owned ANY census.
/// This source/IR proof does not install or execute a native query callback.
pub(super) fn checked_helper_any_query_ir<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    actual: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut queries = facts.queries.as_deref()?.iter().filter(|query| {
        query
            .dependencies
            .first()
            .is_some_and(|read| read.calls.len() == 1 && node_span(read.calls[0]) == actual.span)
    });
    let query = queries.next()?;
    if queries.next().is_some() {
        return None;
    }
    let original = facts.creates.as_deref()?.first()?;
    let call = query.dependencies.first()?.calls[0];
    super::scenario_create_sources::checked_create_expression(ir, original, actual, call, db)?;
    Some(query)
}

pub(super) fn checked_native_any_query_plan<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptQuery> {
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        return None;
    };
    let calls = guards.iter().filter_map(|statement| {
        let IrStmt::Require { cond, .. } = statement else {
            return None;
        };
        // The legacy direct shape keeps its negated guard; the composed
        // any/first shape additionally admits the positive dual (the
        // defining matcher seals the same narrow profile either way).
        let (operand, negated) = match &cond.expr {
            IrExpr::Unary {
                op: super::ir::IrUnOp::Not,
                operand,
            } => (operand.as_ref(), true),
            _ => (cond, false),
        };
        let legacy = negated && checked_any_query_ir(ir, owner, operand, db) == Some(query);
        let composition =
            !legacy && checked_any_first_query_ir(ir, owner, operand, db) == Some(query);
        (legacy || composition).then_some((operand, composition))
    });
    let matched = calls.collect::<Vec<_>>();
    let [(operand, composition)] = matched.as_slice() else {
        return None;
    };
    let operand = *operand;
    let composition = *composition;
    let [(_, parameter)] = query.inputs.as_slice() else {
        return None;
    };
    let parameter = ir.items.get(parameter.0 as usize)?;
    // The composed navigated edge resolves the parent model P through the
    // shared sealed lineage; the legacy direct shape keeps the parameter's
    // own declared model.
    let parent_model = if composition {
        let (_, _, _, _, resolved) = checked_any_first_parent(ir, owner, query, operand, db)?;
        resolved
    } else {
        let IrItemKind::Param {
            ty: IrType::Known(ResolvedType::Record { symbol: parent, .. }),
            ..
        } = &parameter.kind
        else {
            return None;
        };
        *parent
    };
    let parent = ReceiptQueryParent {
        source: transport_source(&query.source, entry)?,
        model: ir.items.get(parent_model.0 as usize)?.canonical.clone(),
        origin: ReceiptQueryParentOrigin::AdmittedReference {
            parameter: parameter.name.clone(),
        },
    };
    receipt_unordered_query(
        query,
        entry,
        Some(parent),
        receipt_query_dependencies(query, entry)?,
    )
}

/// Direct leading-`any` plan for the `[any, first]` composition: the checked
/// any fragment plus returns carrying exactly this query's four influences,
/// so the generic merge can join it with the first-query plan. Mirrors the
/// first-query plan's returns filter; anything else refuses.
/// Void effect tails carry no returned model: the scenario declares no
/// value result, its source facts declare none, and every checked return
/// has no model result. Query, influence and effect correspondence still
/// applies in full; created-model anchoring stays with the defining effect
/// prover, mirroring the admitted standalone-first void shape.
pub(super) fn checked_void_effect_tail(
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
) -> bool {
    if !matches!(&owner.kind, IrItemKind::Scenario { result: None, .. }) {
        return false;
    }
    let Some(facts) = checked.source_facts.as_deref() else {
        return false;
    };
    if facts.result.is_some() {
        return false;
    }
    if checked.returns.is_empty() {
        return false;
    }
    checked
        .returns
        .iter()
        .all(|returned| returned.model_result.is_none())
}

fn push_any_direct_influence<'a>(
    influence: &'a crate::analysis::scenario_disclosure::DisclosureInfluence,
    query: &'a crate::analysis::scenario_disclosure::DisclosureQuery,
    ids: &mut std::collections::HashSet<&'a String>,
    kinds: &mut std::collections::HashSet<&'a str>,
    influences: &mut Vec<ReceiptInfluence>,
) -> Option<()> {
    use crate::analysis::scenario_disclosure::InfluenceKind;
    let kind = match influence.kind {
        InfluenceKind::QueryExistence => "query-existence",
        InfluenceKind::QueryCardinality => "query-cardinality",
        InfluenceKind::QueryMembership => "query-membership",
        InfluenceKind::QueryOrder => "query-order",
        InfluenceKind::AbsentReference => return None,
    };
    if influence.id.is_empty()
        || !ids.insert(&influence.id)
        || !kinds.insert(kind)
        || influence.source != query.source
        || influence.node != query.node
        || influence.query_id.as_deref() != Some(query.id.as_str())
    {
        return None;
    }
    influences.push(receipt_influence(influence)?);
    Some(())
}

/// A plain boolean emptiness `any` recorded without first/count/projection
/// shape. The receipt walker admits exactly this cohort through the native
/// query path, so the guard plan below covers the same queries and no wider
/// surface.
fn plain_boolean_any_query(query: &crate::analysis::scenario_disclosure::DisclosureQuery) -> bool {
    query.first.is_none()
        && query.count.is_none()
        && query.projection.is_none()
        && query.cardinality_guard.is_none()
        && query.limit.is_none()
        && query.order.is_empty()
        && !query.archived
        && query.alias.is_some()
        && query.predicate.is_some()
}

/// One leaf of a require `and` chain: negated and bare calls alike stay
/// visible so the span match below decides, never the polarity.
fn guard_conjunct_calls<'a>(cond: &'a TypedExpr, out: &mut Vec<&'a TypedExpr>) {
    match &cond.expr {
        IrExpr::Binary {
            op: IrBinOp::And,
            left,
            right,
        } => {
            guard_conjunct_calls(left, out);
            guard_conjunct_calls(right, out);
        }
        _ => out.push(cond),
    }
}

/// The visited call invokes the recorded plain query: builtin `any` over the
/// fact's exact domain and predicate argument spans.
fn plain_any_call_matches(
    target: &IrCallTarget,
    args: &[TypedExpr],
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> bool {
    if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "any") {
        return false;
    }
    let [domain, predicate] = args else {
        return false;
    };
    (node_span(query.node) == domain.span || node_span(query.domain) == domain.span)
        && query
            .predicate
            .is_some_and(|node| node_span(node) == predicate.span)
}

/// The visited expression invokes the recorded plain query.
fn plain_any_expr_matches(
    call: &TypedExpr,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> bool {
    match &call.expr {
        IrExpr::Call { target, args } => plain_any_call_matches(target, args, query),
        IrExpr::BoundCall { target, args, .. } => plain_any_call_matches(target, args, query),
        _ => false,
    }
}

/// A direct guard `any` executes exactly once as a require conjunct of the
/// recorded query.
fn find_direct_guard_any(
    guards: &[IrStmt],
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    let mut matched = 0usize;
    for statement in guards {
        let IrStmt::Require { cond, .. } = statement else {
            continue;
        };
        let mut leaves = Vec::new();
        guard_conjunct_calls(cond, &mut leaves);
        for leaf in leaves {
            let operand = match &leaf.expr {
                IrExpr::Unary {
                    op: super::ir::IrUnOp::Not,
                    operand,
                } => operand.as_ref(),
                _ => leaf,
            };
            if plain_any_expr_matches(operand, query) {
                matched += 1;
            }
        }
    }
    (matched == 1).then_some(())
}

/// A derive-bodied `any` executes exactly once: its one outer derive call is
/// a require conjunct at the recorded site, and the callee body holds the
/// one matching inner `any`.
fn find_nested_guard_any(
    ir: &IrProgram,
    guards: &[IrStmt],
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    outer: crate::analysis::NodeKey,
) -> Option<()> {
    let mut outers = Vec::new();
    for statement in guards {
        let IrStmt::Require { cond, .. } = statement else {
            continue;
        };
        let mut leaves = Vec::new();
        guard_conjunct_calls(cond, &mut leaves);
        for leaf in leaves {
            let operand = match &leaf.expr {
                IrExpr::Unary {
                    op: super::ir::IrUnOp::Not,
                    operand,
                } => operand.as_ref(),
                _ => leaf,
            };
            let (target, _) = match &operand.expr {
                IrExpr::Call { target, args } => (target, args),
                IrExpr::BoundCall { target, args, .. } => (target, args),
                _ => continue,
            };
            if node_span(outer) == operand.span
                && let IrCallTarget::DeriveFn(canonical) = target
            {
                outers.push(canonical);
            }
        }
    }
    let [canonical] = outers.as_slice() else {
        return None;
    };
    let mut candidates = ir.items.iter().filter(|item| item.canonical == **canonical);
    let callee = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    let IrItemKind::DeriveFn {
        expr: Some(body), ..
    } = &callee.kind
    else {
        return None;
    };
    let mut matched = 0usize;
    let mut leaves = Vec::new();
    guard_conjunct_calls(body, &mut leaves);
    for leaf in &leaves {
        let operand = match &leaf.expr {
            IrExpr::Unary {
                op: super::ir::IrUnOp::Not,
                operand,
            } => operand.as_ref(),
            _ => leaf,
        };
        if plain_any_expr_matches(operand, query) {
            matched += 1;
        }
    }
    (matched == 1).then_some(())
}

/// One executable fragment for a recorded plain guard `any`: direct queries
/// anchor at their scenario parameter like the direct plan, derive-bodied
/// queries ride their outer call like the helper plan.
fn guard_any_fragment(
    ir: &IrProgram,
    guards: &[IrStmt],
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry: &str,
) -> Option<ReceiptQuery> {
    if query.dependencies.is_empty()
        || query
            .dependencies
            .iter()
            .any(|read| read.role != DependencyRole::Control)
    {
        return None;
    }
    let outer = query.dependencies.first()?.calls.as_slice();
    if query
        .dependencies
        .iter()
        .any(|read| read.calls.as_slice() != outer)
    {
        return None;
    }
    // Guard-any fragments claim no containment scope: a direct query may
    // iterate same-model rows (not children of its anchor), and
    // derive-bodied queries ride their outer call. Both shapes fail the
    // parented-model containment check, so the honest encoding is absent;
    // a future invocation unit can anchor true containments with execution
    // evidence.
    if outer.is_empty() {
        find_direct_guard_any(guards, query)?;
        let [(_, parameter)] = query.inputs.as_slice() else {
            return None;
        };
        let parameter = ir.items.get(parameter.0 as usize)?;
        if !matches!(
            parameter.kind,
            IrItemKind::Param {
                ty: IrType::Known(ResolvedType::Record { .. }),
                ..
            }
        ) {
            return None;
        }
    } else {
        let [outer] = outer else {
            return None;
        };
        find_nested_guard_any(ir, guards, query, *outer)?;
    }
    receipt_unordered_query(
        query,
        entry,
        None,
        receipt_query_dependencies(query, entry)?,
    )
}

/// A local executable plan for guard-only plain boolean `any` queries: one
/// fragment per recorded query, returns carrying exactly their own backed
/// influences. Every construction step re-proves the query against the
/// actual guard IR, so anything unproven keeps the refusal.
fn checked_guard_any_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let facts = checked.source_facts.as_deref()?;
    let queries = facts.queries.as_deref()?;
    if queries.is_empty() || !queries.iter().all(plain_boolean_any_query) {
        return None;
    }
    if !checked.returns.iter().any(|returned| {
        returned.influences.iter().any(|influence| {
            queries
                .iter()
                .any(|query| query.influences.iter().any(|own| own.id == influence.id))
        })
    }) {
        return None;
    }
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        return None;
    };
    let mut fragments = Vec::new();
    let mut backed: Vec<Vec<ReceiptInfluence>> = Vec::new();
    for query in queries {
        fragments.push(guard_any_fragment(ir, guards, query, entry)?);
        let mut ids = HashSet::new();
        let mut kinds = HashSet::new();
        let mut influences = Vec::new();
        for influence in &query.influences {
            push_any_direct_influence(influence, query, &mut ids, &mut kinds, &mut influences)?;
        }
        if kinds.len() != 4 {
            return None;
        }
        backed.push(influences);
    }
    let mut returns = Vec::new();
    for returned in &checked.returns {
        if returned.source != facts.source {
            return None;
        }
        let mut influences = Vec::new();
        for own in &backed {
            influences.extend(
                own.iter()
                    .filter(|value| {
                        returned
                            .influences
                            .iter()
                            .any(|original| original.id == value.id)
                    })
                    .cloned(),
            );
        }
        if !returned
            .influences
            .iter()
            .all(|original| influences.iter().any(|value| value.id == original.id))
        {
            return None;
        }
        returns.push(receipt_return(returned, entry, influences)?);
    }
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&facts.source, entry)?,
        queries: fragments,
        returns,
    })
}

pub(super) fn checked_native_any_direct_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    use crate::analysis::scenario_disclosure::ScenarioDisclosure;
    let fragment = checked_native_any_query_plan(ir, owner, query, db, entry)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let census = checked_native_query_influences(facts.queries.as_deref()?)?;
    if !facts
        .queries
        .as_deref()?
        .iter()
        .any(|fact| fact.id == query.id)
    {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if checked.returns.is_empty() {
        return None;
    }
    for returned in &checked.returns {
        if returned.source != query.source {
            return None;
        }
        for influence in &returned.influences {
            if !census.contains(influence) {
                return None;
            }
        }
    }
    let mut kinds = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut influences = Vec::new();
    for influence in &query.influences {
        push_any_direct_influence(influence, query, &mut ids, &mut kinds, &mut influences)?;
    }
    if kinds.len() != 4 {
        return None;
    }
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&query.source, entry)?,
        queries: vec![fragment],
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                let selected = influences
                    .iter()
                    .filter(|value| {
                        returned
                            .influences
                            .iter()
                            .any(|original| original.id == value.id)
                    })
                    .cloned()
                    .collect();
                receipt_return(returned, entry, selected)
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

fn checked_query_influence_shape(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    let mut ids = HashSet::new();
    let kinds = [
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ];
    if query.influences.len() != kinds.len() {
        return None;
    }
    for (influence, kind) in query.influences.iter().zip(kinds) {
        if influence.id.is_empty()
            || !ids.insert(&influence.id)
            || influence.kind != kind
            || influence.source != query.source
            || influence.node != query.node
            || influence.query_id.as_deref() != Some(query.id.as_str())
        {
            return None;
        }
    }
    Some(())
}

fn checked_query_influence_census(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    checked_query_influence_shape(query)?;
    Some(query.influences.clone())
}

/// One original leading helper ANY. This structural source census does not
/// grant a native query: the owning executable helper call must also join.
fn checked_helper_any_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let [query] = facts.queries.as_deref()? else {
        return None;
    };
    checked_helper_query_influences(facts, query, false)
}

fn checked_helper_query_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    compound: bool,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    use crate::analysis::scenario_disclosure::{CheckedDecisionCallTarget, CheckedDecisionStage};
    let [outer] = query.dependencies.first()?.calls.as_slice() else {
        return None;
    };
    if query.first.is_some()
        || query.count.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.alias.is_none()
        || query.predicate.is_none()
        || !query.order.is_empty()
        || query.limit.is_some()
        || query.archived
        || query.dependencies.first()?.ty != ResolvedType::Scalar(crate::analysis::Scalar::User)
        || query.dependencies.iter().any(|read| {
            read.role != DependencyRole::Control
                || read.calls.as_slice() != [*outer]
                || read.source != query.source
                || read.model != query.model
                || read.query_id.is_some()
        })
        || facts
            .transcripts
            .as_deref()
            .is_some_and(|values| !values.is_empty())
        || facts
            .inline_selections
            .as_deref()
            .is_some_and(|values| !values.is_empty())
    {
        return None;
    }
    let mut calls = facts.decision_sites.as_deref()?.iter().filter(|site|
        site.owner == facts.scenario && site.source == facts.source
            && (site.stage == CheckedDecisionStage::LeadingRequire
                || compound && site.stage == CheckedDecisionStage::BodyRequire)
            && (site.node == *outer || compound))
        .flat_map(|site| site.calls.iter()).filter(|call|
            matches!(&call.target, CheckedDecisionCallTarget::Builtin{id,overload} if id == "any" && *overload == 0)
            && call.source == query.source && call.chain.len() == 1
            && call.chain[0].node == *outer
            && call.arguments.first().is_some_and(|value| value.0 == query.node)
            && call.arguments.get(1).is_some_and(|value| Some(value.0) == query.predicate));
    calls.next()?;
    if calls.next().is_some() {
        return None;
    }
    checked_query_influence_census(query)
}

/// Closed purchase replay composition: one first lookup and one original
/// leading helper ANY. Every helper still owns its checked source/IR query.
pub(super) fn checked_purchase_helper_query_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let queries = facts.queries.as_deref()?;
    let [created] = facts.creates.as_deref()? else {
        return None;
    };
    if facts.source.module != "purchase" || queries.len() != 2 || created.binding != "receipt" {
        return None;
    }
    let mut first = queries.iter().filter(|query| query.first.is_some());
    let replay = first.next()?;
    if first.next().is_some()
        || replay.model_name != "purchase.Receipt"
        || created.model != replay.model
        || replay.count.is_some()
        || replay.projection.is_some()
        || replay.cardinality_guard.is_some()
    {
        return None;
    }
    let mut census = Vec::new();
    for query in queries {
        if query == replay {
            census.extend(checked_query_influence_census(query)?);
        } else {
            census.extend(checked_helper_query_influences(facts, query, true)?);
            let outer = query.dependencies.first()?.calls[0];
            let mut owners = facts.decision_sites.as_deref()?.iter().filter(|site|
                site.owner == facts.scenario && site.source == facts.source
                && site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::LeadingRequire
                && site.calls.iter().any(|call| call.source == query.source
                    && call.chain.len() == 1 && call.chain[0].node == outer
                    && call.arguments.first().is_some_and(|argument| argument.0 == query.node)
                    && call.arguments.get(1).is_some_and(|argument| Some(argument.0) == query.predicate)));
            owners.next()?;
            if owners.next().is_some() {
                return None;
            }
        }
    }
    if census
        .iter()
        .map(|value| &value.id)
        .collect::<HashSet<_>>()
        .len()
        != census.len()
    {
        return None;
    }
    Some(census)
}

/// The mixed cohort keeps helper occurrences distinct from the first lookup.
/// This is a source census, not a union of return influences.
pub(super) fn checked_mixed_helper_query_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    if let Some(census) = checked_purchase_helper_query_influences(facts) {
        return Some(census);
    }
    use crate::analysis::scenario_disclosure::{CheckedDecisionCallTarget, CheckedDecisionStage};
    let queries = facts.queries.as_deref()?;
    if queries.len() != 3 || facts.creates.as_deref()?.len() != 2 {
        return None;
    }
    let mut first = 0;
    let mut helpers = Vec::new();
    let mut stages = Vec::new();
    let mut all = Vec::new();
    for query in queries {
        if query.first.is_some()
            && query.count.is_none()
            && query.projection.is_none()
            && query.cardinality_guard.is_none()
        {
            first += 1;
            all.extend(checked_query_influence_census(query)?);
        } else {
            all.extend(checked_helper_query_influences(facts, query, true)?);
            let outer = query.dependencies.first()?.calls[0];
            let mut owners = facts.decision_sites.as_deref()?.iter().filter(|site|
                site.owner == facts.scenario && site.source == facts.source
                && matches!(site.stage, CheckedDecisionStage::LeadingRequire | CheckedDecisionStage::BodyRequire)
                && site.calls.iter().any(|call| call.source == query.source
                    && call.chain.len() == 1 && call.chain[0].node == outer
                    && matches!(&call.target, CheckedDecisionCallTarget::Builtin {id,overload} if id=="any" && *overload==0)
                    && call.arguments.first().is_some_and(|argument| argument.0==query.node)
                    && call.arguments.get(1).is_some_and(|argument| Some(argument.0)==query.predicate)));
            stages.push(owners.next()?.stage);
            if owners.next().is_some() {
                return None;
            }
            helpers.push(outer);
        }
    }
    if !mixed_helper_influences_valid(first, &helpers, &stages, &all) {
        return None;
    }
    Some(all)
}

fn mixed_helper_influences_valid(
    first: usize,
    helpers: &[crate::analysis::NodeKey],
    stages: &[crate::analysis::scenario_disclosure::CheckedDecisionStage],
    all: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
) -> bool {
    use crate::analysis::scenario_disclosure::CheckedDecisionStage;
    first == 1
        && helpers.len() == 2
        && stages.contains(&CheckedDecisionStage::LeadingRequire)
        && stages.contains(&CheckedDecisionStage::BodyRequire)
        && helpers[0] != helpers[1]
        && all
            .iter()
            .map(|value| &value.id)
            .collect::<HashSet<_>>()
            .len()
            == all.len()
}

/// Transport already checked query controls through one exact source/field codec.
/// Each profile retains its own source, census, role and execution-site admission.
fn receipt_query_dependencies(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry: &str,
) -> Option<Vec<ReceiptQueryDependency>> {
    query
        .dependencies
        .iter()
        .map(|read| {
            Some(ReceiptQueryDependency {
                id: read.id.clone(),
                source: transport_source(&read.source, entry)?,
                role: ReceiptRole::Control,
                field: read.field_name.clone(),
                type_id: read.type_id.clone(),
            })
        })
        .collect()
}

/// Wire layout shared by already checked ANY and COUNT fragments. The caller
/// still proves the execution site, dependencies and any admitted parent edge.
fn receipt_unordered_query(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry: &str,
    parent: Option<ReceiptQueryParent>,
    dependencies: Vec<ReceiptQueryDependency>,
) -> Option<ReceiptQuery> {
    Some(ReceiptQuery {
        id: query.id.clone(),
        source: transport_source(&query.source, entry)?,
        model: query.model_name.clone(),
        parent,
        order: Vec::new(),
        limit: None,
        archived: "exclude".into(),
        dependencies,
    })
}

/// Encode a return after its owning profile selected and checked the influences.
/// DATA reads, intrinsics and projections are attached by their defining collectors.
fn receipt_return(
    returned: &crate::analysis::scenario_disclosure::DisclosureReturn,
    entry: &str,
    influences: Vec<ReceiptInfluence>,
) -> Option<ReceiptReturn> {
    Some(ReceiptReturn {
        id: returned.id.clone(),
        source: transport_source(&returned.source, entry)?,
        influences,
        dependencies: Vec::new(),
        intrinsics: Vec::new(),
        projection: None,
    })
}

fn receipt_influence(
    value: &crate::analysis::scenario_disclosure::DisclosureInfluence,
) -> Option<ReceiptInfluence> {
    Some(ReceiptInfluence {
        id: value.id.clone(),
        query_id: value.query_id.clone(),
        kind: match value.kind {
            InfluenceKind::QueryExistence => "query-existence",
            InfluenceKind::QueryCardinality => "query-cardinality",
            InfluenceKind::QueryMembership => "query-membership",
            InfluenceKind::QueryOrder => "query-order",
            _ => return None,
        }
        .into(),
    })
}

fn condition_at(value: &TypedExpr, span: Span) -> Option<&TypedExpr> {
    if value.span == span {
        return Some(value);
    }
    match &value.expr {
        IrExpr::Binary { left, right, .. } => {
            condition_at(left, span).or_else(|| condition_at(right, span))
        }
        _ => None,
    }
}

fn require_at(statements: &[IrStmt], span: Span) -> Option<&TypedExpr> {
    statements.iter().find_map(|statement| match statement {
        IrStmt::Require { cond, .. } => condition_at(cond, span),
        IrStmt::If {
            then_branch,
            else_branch,
            ..
        } => require_at(then_branch, span).or_else(|| require_at(else_branch, span)),
        _ => None,
    })
}

fn push_mixed_helper_query(
    ir: &IrProgram,
    owner: &IrItem,
    guards: &[IrStmt],
    effects: &[IrStmt],
    plan: &mut ReceiptDisclosurePlan,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry: &str,
    db: &SourceDb,
) -> Option<()> {
    let outer = query.dependencies.first()?.calls[0];
    let actual =
        require_at(guards, node_span(outer)).or_else(|| require_at(effects, node_span(outer)))?;
    if checked_helper_any_query_ir(ir, owner, actual, db)? != query {
        return None;
    }
    plan.queries.push(receipt_unordered_query(
        query,
        entry,
        None,
        receipt_query_dependencies(query, entry)?,
    )?);
    Some(())
}

/// Compose authenticated query descriptors while retaining each original
/// source return's own influence vector, including its original order.
pub(super) fn checked_native_mixed_helper_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let census = checked_mixed_helper_query_influences(facts)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        guards,
        effects,
        read: false,
        trusted: false,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let queries = facts.queries.as_deref()?;
    let first = queries.iter().find(|query| query.first.is_some())?;
    let first_call = effects.iter().find_map(|statement| match statement {
        IrStmt::Let { value, span, .. } if *span == node_span(first.first.as_ref()?.binding) => {
            Some(value)
        }
        _ => None,
    })?;
    let original_create = facts.creates.as_deref()?.first()?;
    if checked_first_query_ir(
        ir,
        original_create,
        first_call,
        first.first.as_ref()?.call,
        db,
    )? != first
    {
        return None;
    }
    let mut plan = checked_native_first_query_source_plan(ir, owner, checked, first, entry, db)?;
    plan.queries.clear();
    for query in queries {
        if query.first.is_some() {
            plan.queries.extend(
                checked_native_first_query_source_plan(ir, owner, checked, query, entry, db)?
                    .queries,
            );
            continue;
        }
        push_mixed_helper_query(ir, owner, guards, effects, &mut plan, query, entry, db)?;
    }
    for (emitted, original) in plan.returns.iter_mut().zip(&checked.returns) {
        if original
            .influences
            .iter()
            .any(|value| !census.contains(value))
        {
            return None;
        }
        emitted.influences = original
            .influences
            .iter()
            .map(receipt_influence)
            .collect::<Option<Vec<_>>>()?;
    }
    Some(plan)
}

/// The finite native plan reuses the complete owning create/effect collector;
/// callback identity and runtime candidate authority remain host/State duties.
pub(super) fn checked_native_helper_any_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let influences = checked_helper_any_influences(facts)?;
    let [query] = facts.queries.as_deref()? else {
        return None;
    };
    let IrItemKind::Scenario {
        guards,
        read: false,
        trusted: false,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [IrStmt::Require { cond, .. }] = guards.as_slice() else {
        return None;
    };
    if checked_helper_any_query_ir(ir, owner, cond, db)? != query
        || checked_created_model_result(ir, owner).is_none()
    {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            returned.source != facts.source
                || returned.model_result.is_none()
                || returned.influences != influences
        })
    {
        return None;
    }
    let influences = influences
        .iter()
        .map(|value| ReceiptInfluence {
            id: value.id.clone(),
            query_id: value.query_id.clone(),
            kind: match value.kind {
                InfluenceKind::QueryExistence => "query-existence",
                InfluenceKind::QueryCardinality => "query-cardinality",
                InfluenceKind::QueryMembership => "query-membership",
                InfluenceKind::QueryOrder => "query-order",
                _ => unreachable!(),
            }
            .into(),
        })
        .collect::<Vec<_>>();
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&facts.source, entry)?,
        queries: vec![receipt_unordered_query(
            query,
            entry,
            None,
            receipt_query_dependencies(query, entry)?,
        )?],
        returns: checked
            .returns
            .iter()
            .map(|returned| receipt_return(returned, entry, influences.clone()))
            .collect::<Option<Vec<_>>>()?,
    })
}

fn single_query_shape_valid(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    if query.first.is_some() == query.count.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
    {
        return None;
    }
    Some(())
}

fn first_count_call_order_valid(
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    if first.first.as_ref()?.binding.file != count.count.as_ref()?.statement.file
        || first.first.as_ref()?.binding.end > count.count.as_ref()?.statement.start
    {
        return None;
    }
    Some(())
}

fn pair_query_shape_valid(
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    if first.first.is_none()
        || first.count.is_some()
        || count.first.is_some()
        || count.count.is_none()
        || first.projection.is_some()
        || first.cardinality_guard.is_some()
        || count.projection.is_some()
        || count.cardinality_guard.is_some()
        || first.source != count.source
        || first.return_node != count.return_node
        || first.id == count.id
        || first_count_call_order_valid(first, count).is_none()
        || count.count.as_ref()?.contained_parent.is_none()
        || !count.count.as_ref()?.parent_edges.is_empty()
    {
        return None;
    }
    Some(())
}

/// Original assign evaluates its active-Seat capacity Require before the
/// target FIRST Let. This pair keeps that exact source order and one Term
/// containment domain while granting no other COUNT/FIRST composition.
fn assign_count_first_shape_valid(
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    let capacity = count.count.as_ref()?;
    let target = first.first.as_ref()?;
    let (_, count_parameter) = capacity.contained_parent?;
    let (_, first_parameter) = target.contained_parent?;
    if count.first.is_some()
        || first.count.is_some()
        || count.model_name != "member_terms.Seat"
        || first.model_name != count.model_name
        || count.model != first.model
        || count.id == first.id
        || count.source != first.source
        || count.return_node != first.return_node
        || count_parameter != first_parameter
        || capacity.statement.kind != SyntaxKind::Require as u8
        || capacity.statement.end > target.binding.start
        || !capacity.parent_edges.is_empty()
        || count.alias.is_none()
        || count.predicate.is_none()
        || count.dependencies.len() != 1
        || count.dependencies[0].role != DependencyRole::Control
        || count.dependencies[0].field_name != "active"
        || first.order.len() != 1
        || first.order[0].field_name != "id"
        || first.dependencies.len() != 1
        || first.dependencies[0].field_name != "account"
        || !target.target_consumed
        || !target.guard_consumed
    {
        return None;
    }
    Some(())
}

fn assign_term_membership(
    value: &TypedExpr,
    term: crate::analysis::SymbolId,
    membership: crate::analysis::SymbolId,
) -> bool {
    value.ty
        == ResolvedType::Record {
            symbol: membership,
            stored: true,
        }
        && matches!(&value.expr, IrExpr::Member { base, field }
            if field == "parent"
                && base.ty == ResolvedType::Record { symbol: term, stored: true }
                && matches!(&base.expr, IrExpr::Name(name) if name == "term"))
}

/// The assign receipt owns a particular eligibility subject and revision
/// event. Generic source-Require admission proves the helper's hidden reads,
/// but it does not by itself prove that its Customer argument is the Term's
/// owner or that the final notification names this Membership and revision.
fn checked_assign_header_and_event(
    ir: &IrProgram,
    owner: &IrItem,
    guards: &[IrStmt],
    effects: &[IrStmt],
) -> Option<()> {
    let IrItemKind::Scenario { params, by, .. } = &owner.kind else {
        return None;
    };
    let [term_id, account_id] = params.as_slice() else {
        return None;
    };
    let term = ir.items.get(term_id.0 as usize)?;
    let account = ir.items.get(account_id.0 as usize)?;
    let IrItemKind::Param {
        owner: term_owner,
        index: 0,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: term_model,
                stored: true,
            }),
        array_bounds: None,
        default: None,
        default_node: None,
        default_copy_source: None,
        ..
    } = &term.kind
    else {
        return None;
    };
    let IrItemKind::Param {
        owner: account_owner,
        index: 1,
        ty: IrType::Known(ResolvedType::Scalar(Scalar::User)),
        array_bounds: None,
        default: None,
        default_node: None,
        default_copy_source: None,
        ..
    } = &account.kind
    else {
        return None;
    };
    let term_model_item = ir.items.get(term_model.0 as usize)?;
    let IrItemKind::Model {
        owner: IrOwner::ChildOf(membership_model),
        ..
    } = &term_model_item.kind
    else {
        return None;
    };
    let membership_item = ir.items.get(membership_model.0 as usize)?;
    let IrItemKind::Model {
        owner: IrOwner::ChildOf(customer_model),
        ..
    } = &membership_item.kind
    else {
        return None;
    };
    let customer_item = ir.items.get(customer_model.0 as usize)?;
    if term.name != "term"
        || account.name != "account"
        || *term_owner != owner.id
        || *account_owner != owner.id
        || term_model_item.canonical != "member_terms.Term"
        || membership_item.canonical != "member_terms.Membership"
        || customer_item.canonical != "customer.Customer"
        || !matches!(by.as_slice(), [IrGuard::Role(role)] if role == "authenticated")
    {
        return None;
    }
    let [_, IrStmt::Require { cond: eligible, .. }, _] = guards else {
        return None;
    };
    let (target, args, slots) = match &eligible.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [person, customer] = args else {
        return None;
    };
    let IrExpr::Member {
        base: membership,
        field,
    } = &customer.expr
    else {
        return None;
    };
    if eligible.ty != ResolvedType::Scalar(Scalar::Bool)
        || !matches!(target, IrCallTarget::DeriveFn(name) if name == "member_terms.eligible_account")
        || slots.is_some_and(|slots| slots != [Some(0), Some(1)])
        || person.ty != ResolvedType::Scalar(Scalar::User)
        || !matches!(&person.expr, IrExpr::Name(name) if name == "account")
        || customer.ty
            != (ResolvedType::Record {
                symbol: *customer_model,
                stored: true,
            })
        || field != "parent"
        || !assign_term_membership(membership, *term_model, *membership_model)
    {
        return None;
    }
    let [
        IrStmt::Let {
            value: selected, ..
        },
        IrStmt::If { .. },
        IrStmt::Emit { event, payload, .. },
    ] = effects
    else {
        return None;
    };
    let (target, args, slots) = match &selected.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    let predicate = scan.where_pred.as_deref()?;
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left,
        right,
    } = &predicate.expr
    else {
        return None;
    };
    if !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "first")
        || slots.is_some_and(|slots| slots != [Some(0)])
        || scan.where_param != "row"
        || left.ty != ResolvedType::Scalar(Scalar::User)
        || right.ty != ResolvedType::Scalar(Scalar::User)
        || !matches!(&left.expr, IrExpr::Member { base, field }
            if field == "account" && matches!(&base.expr, IrExpr::Name(name) if name == "row"))
        || !matches!(&right.expr, IrExpr::Name(name) if name == "account")
    {
        return None;
    }
    let IrExpr::Object(entries) = &payload.expr else {
        return None;
    };
    let [(membership_name, membership), (revision_name, revision)] = entries.as_slice() else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Add,
        left,
        right,
    } = &revision.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: revision_membership,
        field: revision_field,
    } = &left.expr
    else {
        return None;
    };
    if event != "member_terms.AccessChanged"
        || payload.ty != ResolvedType::Unknown
        || membership_name != "membership"
        || revision_name != "revision"
        || !assign_term_membership(membership, *term_model, *membership_model)
        || revision.ty != ResolvedType::Scalar(Scalar::Int)
        || left.ty != ResolvedType::Scalar(Scalar::Int)
        || right.ty != ResolvedType::Scalar(Scalar::Int)
        || revision_field != "access_revision"
        || !assign_term_membership(revision_membership, *term_model, *membership_model)
        || !matches!(right.expr, IrExpr::Int(1))
    {
        return None;
    }
    Some(())
}

pub(super) fn checked_assign_count_first_target_return_order(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
    expected: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
    returned: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
) -> bool {
    let [count, first] = queries else {
        return false;
    };
    assign_count_first_shape_valid(count, first).is_some()
        && count
            .influences
            .iter()
            .chain(&first.influences)
            .eq(expected.iter())
        && first
            .influences
            .iter()
            .chain(&count.influences)
            .eq(returned.iter())
}

fn ancestor_count_shape_valid(
    ancestor: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    if ancestor.first.is_some()
        || ancestor.count.is_none()
        || ancestor.projection.is_some()
        || ancestor.cardinality_guard.is_some()
        || ancestor.count.as_ref()?.contained_parent.is_some()
        || ancestor.count.as_ref()?.parent_edges.len() != 3
        || ancestor.count.as_ref()?.statement.kind != SyntaxKind::Require as u8
    {
        return None;
    }
    Some(())
}

fn triple_query_shape_valid(
    ancestor: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
    rest: &[crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<()> {
    ancestor_count_shape_valid(ancestor)?;
    checked_native_query_influences(rest)?;
    if ancestor.source != first.source
        || ancestor.return_node != first.return_node
        || ancestor.id == first.id
        || ancestor.id == count.id
        || ancestor.count.as_ref()?.statement.file != first.first.as_ref()?.binding.file
        || ancestor.count.as_ref()?.statement.end > first.first.as_ref()?.binding.start
        || ancestor.inputs.len() != 1
        || ancestor.inputs[0].1 != count.count.as_ref()?.contained_parent?.1
    {
        return None;
    }
    Some(())
}

fn any_first_shape_valid(
    any: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    if any.first.is_some()
        || any.count.is_some()
        || any.projection.is_some()
        || any.cardinality_guard.is_some()
        || any.alias.is_none()
        || any.predicate.is_none()
        || first.first.is_none()
        || first.count.is_some()
        || first.projection.is_some()
        || first.cardinality_guard.is_some()
        || any.source != first.source
        || any.return_node != first.return_node
        || any.model != first.model
        || any.inputs.len() != 1
        || first.inputs.len() != 1
        || any.inputs[0].1 != first.inputs[0].1
        || any.node.end > first.first.as_ref()?.binding.start
        || any.id == first.id
    {
        return None;
    }
    Some(())
}

fn any_ancestor_shape_valid(
    any: &crate::analysis::scenario_disclosure::DisclosureQuery,
    ancestor: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
    rest: &[crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<()> {
    if any.first.is_some()
        || any.count.is_some()
        || any.projection.is_some()
        || any.cardinality_guard.is_some()
        || any.alias.is_none()
        || any.predicate.is_none()
        || checked_native_query_influences(rest).is_none()
        || any.source != ancestor.source
        || any.return_node != ancestor.return_node
        || any.model != ancestor.model
        || any.inputs.len() != 1
        || any.inputs[0].1 != ancestor.inputs[0].1
        || any.node.file != ancestor.count.as_ref()?.statement.file
        || any.node.end > ancestor.count.as_ref()?.statement.start
        || any.id == ancestor.id
        || any.id == first.id
        || any.id == count.id
    {
        return None;
    }
    Some(())
}

fn collect_native_influences(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let mut ids = HashSet::new();
    let mut influences = Vec::new();
    for query in queries {
        if query.influences.len() != 4 {
            return None;
        }
        for influence in &query.influences {
            if influence.id.is_empty()
                || !ids.insert(&influence.id)
                || influence.source != query.source
                || influence.node != query.node
                || influence.query_id.as_deref() != Some(query.id.as_str())
            {
                return None;
            }
            influences.push(influence.clone());
        }
    }
    Some(influences)
}

pub(super) fn checked_native_query_influences(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    match queries {
        [query] => single_query_shape_valid(query)?,
        [first, count] if first.first.is_some() && count.count.is_some() => {
            pair_query_shape_valid(first, count)?
        }
        [count, first] if count.count.is_some() && first.first.is_some() => {
            assign_count_first_shape_valid(count, first)?
        }
        [ancestor, first, count] => {
            triple_query_shape_valid(ancestor, first, count, &queries[1..])?
        }
        [any, first] => any_first_shape_valid(any, first)?,
        [any, ancestor, first, count] => {
            any_ancestor_shape_valid(any, ancestor, first, count, &queries[1..])?
        }
        _ => return None,
    }
    collect_native_influences(queries)
}

/// Analysis records an implicit void return after visiting the first-target
/// branch, then its preceding leading ANY guard. Keep that exact two-block
/// order while the receipt inventory retains authored ANY-then-first order.
pub(super) fn checked_any_first_target_return_order(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
    expected: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
    returned: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
) -> bool {
    let [any, first] = queries else {
        return false;
    };
    first
        .first
        .as_ref()
        .is_some_and(|first| first.target_consumed)
        && any_first_shape_valid(any, first).is_some()
        && any
            .influences
            .iter()
            .chain(&first.influences)
            .eq(expected.iter())
        && first
            .influences
            .iter()
            .chain(&any.influences)
            .eq(returned.iter())
}

/// The original ask composes four ordinary selectors with two independent
/// transcript calls. This exact source cohort retains all six identities in
/// authored evaluation order, without granting a generic mixed-query surface.
fn single_inline_influences(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
    transcripts: &[crate::analysis::scenario_disclosure::CheckedTranscriptSource],
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let [query] = queries else {
        return None;
    };
    if query != &fact.query
        || !transcripts.is_empty()
        || query.influences.len() != 4
        || query.first.is_some()
        || query.count.is_some()
        || query.projection.is_some()
        || query.source != facts.source
        || query.return_node.file != facts.node.file
    {
        return None;
    }
    checked_query_influence_census(query)
}

fn transcript_influence_order_mismatch(
    early: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    later: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    any: &crate::analysis::scenario_disclosure::DisclosureQuery,
    ancestor: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
    branch: crate::analysis::SymbolId,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> bool {
    early.source != facts.source
        || later.source != facts.source
        || early.parameter != later.parameter
        || early.derive != later.derive
        || early.body != later.body
        || early.query != later.query
        || early.branch != later.branch
        || early.model != later.model
        || any.inputs[0].1 != branch
        || ancestor.inputs[0].1 != branch
        || count
            .count
            .as_ref()
            .and_then(|count| count.contained_parent.as_ref())
            .map(|(_, id)| *id)
            != Some(branch)
        || early.call.file != any.node.file
        || early.call.end > any.node.start
        || first
            .first
            .as_ref()
            .is_none_or(|first| first.call.end > later.call.start)
        || count
            .count
            .as_ref()
            .is_none_or(|count| later.call.end > count.call.start)
}

fn transcript_influence_model_mismatch(
    early: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    later: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    any: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureQuery,
    run: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    turn: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> bool {
    early.statement.kind != SyntaxKind::Require as u8
        || later.statement.kind != SyntaxKind::Let as u8
        || run.model != any.model
        || turn.model != count.model
        || turn.model != early.model
        || count
            .count
            .as_ref()
            .is_none_or(|count| count.statement != turn.node)
        || run.source != facts.source
        || turn.source != facts.source
        || run.definition.declaration.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(early.branch)
        || turn.definition.declaration.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(early.branch)
}

fn ordered_transcript_influences<'a>(
    early: &'a crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    later: &'a crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    queries: &'a [crate::analysis::scenario_disclosure::DisclosureQuery],
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<&'a [crate::analysis::scenario_disclosure::DisclosureInfluence]>> {
    if queries.is_empty() {
        return Some(vec![
            early.influences.as_slice(),
            later.influences.as_slice(),
        ]);
    }
    let [any, ancestor, first, count] = queries else {
        return None;
    };
    checked_native_query_influences(queries)?;
    let [run, turn] = facts.creates.as_deref()? else {
        return None;
    };
    let branch = early.parameter;
    if transcript_influence_order_mismatch(early, later, any, ancestor, first, count, branch, facts)
        || transcript_influence_model_mismatch(early, later, any, count, run, turn, facts)
    {
        return None;
    }
    Some(vec![
        early.influences.as_slice(),
        any.influences.as_slice(),
        ancestor.influences.as_slice(),
        first.influences.as_slice(),
        later.influences.as_slice(),
        count.influences.as_slice(),
    ])
}

fn ordered_group_influences(
    ordered: Vec<&[crate::analysis::scenario_disclosure::DisclosureInfluence]>,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let mut ids = HashSet::new();
    let mut query_ids = HashSet::new();
    let mut out = Vec::new();
    for group in ordered {
        if group.len() != 4 {
            return None;
        }
        let query = group[0].query_id.as_deref()?;
        if !query_ids.insert(query) {
            return None;
        }
        for (influence, kind) in group.iter().zip([
            InfluenceKind::QueryExistence,
            InfluenceKind::QueryCardinality,
            InfluenceKind::QueryMembership,
            InfluenceKind::QueryOrder,
        ]) {
            if influence.kind != kind
                || influence.source != facts.source
                || influence.id.is_empty()
                || !ids.insert(influence.id.as_str())
                || influence.query_id.as_deref() != Some(query)
            {
                return None;
            }
            out.push(influence.clone());
        }
    }
    Some(out)
}

/// Constructor counts may coexist with leading helper collections already
/// owned by exact source-Require observers. They are not a second query
/// execution: only COUNT influences may reach the implicit void return.
pub(super) fn constructor_count_queries(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<&crate::analysis::scenario_disclosure::DisclosureQuery>> {
    use crate::analysis::scenario_disclosure::CheckedDecisionStage;
    // This source census grants no query or result authority. A Model result
    // also needs the independently checked original CREATE/Return below.
    if let Some(result) = &facts.result {
        let ResolvedType::Record {
            symbol,
            stored: true,
        } = result
        else {
            return None;
        };
        if facts
            .creates
            .as_deref()?
            .iter()
            .filter(|created| created.model == *symbol)
            .count()
            != 1
        {
            return None;
        }
    }
    let queries = facts.queries.as_deref()?;
    let mut counts = Vec::new();
    for query in queries {
        if let Some(count) = &query.count {
            if count.contained_parent.is_none()
                || !count.parent_edges.is_empty()
                || query.first.is_some()
            {
                return None;
            }
            checked_query_influence_census(query)?;
            counts.push(query);
        } else {
            checked_helper_query_influences(facts, query, true)?;
            let outer = *query.dependencies.first()?.calls.first()?;
            let mut sites = facts.source_requires.as_deref()?.iter().filter(|site| {
                site.stage == CheckedDecisionStage::LeadingRequire
                    && site.owner == facts.scenario
                    && site.source == facts.source
                    && site.calls.iter().any(|call| {
                        call.source == query.source
                            && call.chain.len() == 1
                            && call.chain[0].node == outer
                            && call
                                .arguments
                                .first()
                                .is_some_and(|argument| argument.0 == query.node)
                            && call
                                .arguments
                                .get(1)
                                .is_some_and(|argument| Some(argument.0) == query.predicate)
                    })
            });
            sites.next()?;
            if sites.next().is_some() {
                return None;
            }
        }
    }
    if counts.is_empty() || counts.len() > 2 {
        return None;
    }
    Some(counts)
}
pub(super) fn constructor_count_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    Some(
        constructor_count_queries(facts)?
            .into_iter()
            .flat_map(|query| query.influences.clone())
            .collect(),
    )
}

pub(super) fn checked_scenario_query_influences(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>> {
    let queries = facts.queries.as_deref()?;
    if let Some(values) = facts
        .query_values
        .as_deref()
        .filter(|values| !values.is_empty())
    {
        if queries.len() > 200
            || queries.iter().any(|query| {
                query.count.is_none() && !values.iter().any(|value| &value.query == query)
            })
        {
            return None;
        }
        let mut output = Vec::new();
        for query in queries {
            checked_query_influence_census(query)?;
            output.extend(query.influences.clone());
        }
        return Some(output);
    }
    let transcripts = facts.transcripts.as_deref().unwrap_or_default();
    if let Some([fact]) = facts
        .inline_selections
        .as_deref()
        .filter(|facts| !facts.is_empty())
    {
        return single_inline_influences(queries, transcripts, facts, fact);
    }
    if facts
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return None;
    }
    if transcripts.is_empty() {
        return checked_helper_any_influences(facts)
            .or_else(|| checked_mixed_helper_query_influences(facts))
            .or_else(|| checked_native_query_influences(queries))
            .or_else(|| constructor_count_influences(facts));
    }
    let [early, later] = transcripts else {
        return None;
    };
    let ordered = if queries.is_empty() {
        vec![early.influences.as_slice(), later.influences.as_slice()]
    } else {
        ordered_transcript_influences(early, later, queries, facts)?
    };
    ordered_group_influences(ordered, facts)
}

/// Merge already checked individual selectors, retaining original query and
/// Return identity/order. Each individual plan contributes only its own four
/// influences; no complete recipe or ordinary observations are reconstructed.
fn merged_return_extendable(
    returned: &ReceiptReturn,
    counted: &ReceiptReturn,
    queries: &[ReceiptQuery],
    added: &ReceiptQuery,
) -> bool {
    fn subsets(influences: &[ReceiptInfluence], queries: &[ReceiptQuery]) -> bool {
        let mut ids = HashSet::new();
        if influences.iter().any(|influence| {
            !ids.insert(&influence.id)
                || !queries
                    .iter()
                    .any(|query| influence.query_id.as_deref() == Some(query.id.as_str()))
        }) {
            return false;
        }
        queries.iter().all(|query| {
            let selected: Vec<_> = influences
                .iter()
                .filter(|value| value.query_id.as_deref() == Some(query.id.as_str()))
                .collect();
            let kinds: HashSet<_> = selected.iter().map(|value| value.kind.as_str()).collect();
            selected.is_empty()
                || selected.len() == 4
                    && kinds
                        == HashSet::from([
                            "query-existence",
                            "query-cardinality",
                            "query-membership",
                            "query-order",
                        ])
        })
    }
    returned.id == counted.id
        && serde_json::to_value(&returned.source).ok() == serde_json::to_value(&counted.source).ok()
        && returned.dependencies.is_empty()
        && counted.dependencies.is_empty()
        && returned.intrinsics.is_empty()
        && counted.intrinsics.is_empty()
        && returned.projection.is_none()
        && counted.projection.is_none()
        && subsets(&returned.influences, queries)
        && subsets(&counted.influences, std::slice::from_ref(added))
        && !returned
            .influences
            .iter()
            .any(|value| counted.influences.iter().any(|other| other.id == value.id))
}

pub(super) fn merge_native_query_plans(
    mut first: ReceiptDisclosurePlan,
    count: ReceiptDisclosurePlan,
) -> Option<ReceiptDisclosurePlan> {
    if first.version != count.version
        || serde_json::to_value(&first.source).ok()? != serde_json::to_value(&count.source).ok()?
        || first.queries.is_empty()
        || first.queries.len() > 2
        || count.queries.len() != 1
        || first
            .queries
            .iter()
            .any(|query| query.id == count.queries[0].id)
        || first.returns.len() != count.returns.len()
    {
        return None;
    }
    for (returned, counted) in first.returns.iter_mut().zip(count.returns) {
        if !merged_return_extendable(returned, &counted, &first.queries, &count.queries[0]) {
            return None;
        }
        returned.influences.extend(counted.influences);
    }
    first.queries.extend(count.queries);
    Some(first)
}

fn mixed_helper_expected_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    db: Option<&SourceDb>,
    entry_module: &str,
    supplied: Option<&'a ReceiptDisclosurePlan>,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
) -> Option<Option<&'a ReceiptDisclosurePlan>> {
    let plan = supplied?;
    let mut expected = checked_native_mixed_helper_query_plan(ir, owner, db?, entry_module)?;
    project_plan_returns(&mut expected, returned_paths)?;
    (serde_json::to_value(plan).ok()? == serde_json::to_value(expected).ok()?).then_some(Some(plan))
}

fn helper_any_expected_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    db: Option<&SourceDb>,
    entry_module: &str,
    supplied: Option<&'a ReceiptDisclosurePlan>,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
) -> Option<Option<&'a ReceiptDisclosurePlan>> {
    let plan = supplied?;
    let mut expected = checked_native_helper_any_query_plan(ir, owner, db?, entry_module)?;
    project_plan_returns(&mut expected, returned_paths)?;
    (serde_json::to_value(plan).ok()? == serde_json::to_value(expected).ok()?).then_some(Some(plan))
}

enum PlainQueryOutcome<'a> {
    Continue,
    Done(Option<Option<&'a ReceiptDisclosurePlan>>),
}

fn plain_query_outcome<'a>(
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
    supplied: Option<&'a ReceiptDisclosurePlan>,
) -> PlainQueryOutcome<'a> {
    if queries
        .iter()
        .all(|query| query.first.is_none() && query.count.is_none())
    {
        if queries
            .iter()
            .any(|query| query.alias.is_none() || query.predicate.is_none())
        {
            return PlainQueryOutcome::Done(None);
        }
        return PlainQueryOutcome::Done(supplied.is_none().then_some(None));
    }
    PlainQueryOutcome::Continue
}

fn first_query_expected_plan(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    queries: &[crate::analysis::scenario_disclosure::DisclosureQuery],
    entry_module: &str,
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    if queries.len() == 2 && queries.iter().all(|query| query.count.is_some()) {
        let originals = constructor_count_queries(checked.source_facts.as_deref()?)?;
        if !originals.iter().copied().eq(queries.iter()) {
            return None;
        }
        let first = checked_native_count_query_plan(
            ir,
            owner,
            &queries[0],
            db,
            entry_module,
            source_context,
        )?;
        let second = checked_native_count_query_plan(
            ir,
            owner,
            &queries[1],
            db,
            entry_module,
            source_context,
        )?;
        return merge_native_query_plans(first, second);
    }
    match queries {
        [query] if query.count.is_some() => {
            checked_native_count_query_plan(ir, owner, query, db, entry_module, source_context)
        }
        [query] => {
            checked_native_first_query_source_plan(ir, owner, checked, query, entry_module, db)
        }
        [any, first] if any.first.is_none() && any.count.is_none() => {
            let any_plan = checked_native_any_direct_query_plan(ir, owner, any, db, entry_module);
            let first_plan =
                checked_native_first_query_source_plan(ir, owner, checked, first, entry_module, db);
            merge_native_query_plans(any_plan?, first_plan?)
        }
        [count, first] if count.count.is_some() && first.first.is_some() => {
            merge_native_query_plans(
                checked_native_assign_count_query_plan(
                    ir,
                    owner,
                    checked,
                    count,
                    db,
                    entry_module,
                )?,
                checked_native_first_query_source_plan(
                    ir,
                    owner,
                    checked,
                    first,
                    entry_module,
                    db,
                )?,
            )
        }
        [first, count] => merge_native_query_plans(
            checked_native_first_query_source_plan(ir, owner, checked, first, entry_module, db)?,
            checked_native_count_query_plan(ir, owner, count, db, entry_module, source_context)?,
        ),
        [ancestor, first, count] => merge_native_query_plans(
            merge_native_query_plans(
                checked_native_count_query_plan(
                    ir,
                    owner,
                    ancestor,
                    db,
                    entry_module,
                    source_context,
                )?,
                checked_native_first_query_source_plan(
                    ir,
                    owner,
                    checked,
                    first,
                    entry_module,
                    db,
                )?,
            )?,
            checked_native_count_query_plan(ir, owner, count, db, entry_module, source_context)?,
        ),
        _ => None,
    }
}

fn context_query_alias_name(
    context: &super::source_context::FreshSourceContext<'_>,
    value: &crate::analysis::scenario_disclosure::CheckedQueryValueSource,
) -> Option<String> {
    let query = context.original().types.checked_queries.get(&value.value)?;
    let clause = query.clauses.first()?;
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &clause.kind else {
        return None;
    };
    (clause.node == value.alias).then(|| name.clone())
}

/// A computed Values selection keeps its native candidate slots and DATA
/// obligations. Its separate, privately issued LET completion owns the value;
/// it cannot substitute an unobserved array for a native query result.
fn checked_native_value_query_plan(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;

    let facts = checked.source_facts.as_deref()?;
    let original = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    if original.query_values != facts.query_values || original.queries != facts.queries {
        return None;
    }

    let values = facts.query_values.as_deref()?;
    let queries = facts.queries.as_deref()?;
    let IrItemKind::Scenario {
        effects,
        result,
        read: false,
        trusted: false,
        hook: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if result.is_some() && checked_created_model_result(ir, owner).is_none() {
        return None;
    }
    if values.is_empty()
        || values.len() > 200
        || checked.returns.iter().any(|returned| {
            returned.source_values.is_empty()
                || returned
                    .source_values
                    .iter()
                    .any(|node| !values.iter().any(|value| value.statement == *node))
        })
    {
        return None;
    }

    let captures = super::source_let_data::collect_native_query_values(context, owner, entry)?;

    for site in facts.source_requires.as_deref().unwrap_or_default() {
        for (node, binding) in &context.resolved().node_binding {
            if node.file == site.node.file
                && site.node.start <= node.start
                && node.end <= site.node.end
                && let crate::analysis::resolve::Binding::Let { node: declaration } = binding
                && !captures.contains_key(&node_span(*declaration))
            {
                return None;
            }
        }
    }

    let census = checked_scenario_query_influences(facts)?;
    if checked.returns.iter().any(|returned| {
        returned
            .influences
            .iter()
            .any(|value| !census.contains(value))
    }) {
        return None;
    }

    let mut emitted = Vec::new();
    for query in queries {
        let Some(value) = values.iter().find(|value| &value.query == query) else {
            query.count.as_ref()?;
            emitted.extend(
                checked_native_count_query_plan(
                    ir,
                    owner,
                    query,
                    context.db(),
                    entry,
                    Some(context),
                )?
                .queries,
            );
            continue;
        };
        if !super::source_let_data::capture_plain_value(ir, &value.ty, 0) {
            return None;
        }
        let statement=effects.iter().find(|statement|matches!(statement,IrStmt::Let{span,..}if *span==node_span(value.statement)))?;
        let IrStmt::Let {
            name,
            value: expression,
            ..
        } = statement
        else {
            return None;
        };
        let IrExpr::Query(actual) = &expression.expr else {
            return None;
        };
        // Model predicates use the original lowering's normalized row name;
        // the authored As alias belongs to SELECT, not necessarily WHERE.
        // Compare the exact fresh query, alongside the whole-owner join above.
        let fresh_owner = context.fresh().items.get(owner.id.0 as usize)?;
        let IrItemKind::Scenario {
            effects: fresh_effects,
            ..
        } = &fresh_owner.kind
        else {
            return None;
        };
        let fresh_query = fresh_effects.iter().find_map(|statement| match statement {
            IrStmt::Let {
                value:
                    TypedExpr {
                        expr: IrExpr::Query(query),
                        ..
                    },
                span,
                ..
            } if *span == node_span(value.statement) => Some(query),
            _ => None,
        })?;
        let alias = context
            .original()
            .types
            .checked_queries
            .get(&value.value)?
            .clauses
            .first()?;
        let crate::analysis::types::CheckedQueryClauseKind::As { name: alias } = &alias.kind else {
            return None;
        };
        if name != &value.binding
            || expression.span != node_span(value.value)
            || expression.ty != value.ty
            || !matches!(&actual.domain,super::ir::IrQueryDomain::Model(name)if name==&query.model_name)
            || actual.source.as_ref()?.node != value.value
            || actual.source.as_ref()?.result != value.ty
            || actual.select.as_ref()?.span != node_span(value.selected)
            || actual.select_param.as_deref() != Some(alias)
            || actual.parent.as_ref()?.span != node_span(value.parent)
            || actual.parent.as_ref()?.ty
                != (ResolvedType::Record {
                    symbol: value.parent_model,
                    stored: true,
                })
            || actual.where_pred.as_ref().map(|value| value.span) != query.predicate.map(node_span)
            || actual.where_param != fresh_query.where_param
            || actual.value_order.is_some()
            || actual.limit.is_some()
            || actual.archived.is_some()
            || actual.order.len() != query.order.len()
            || !actual
                .order
                .iter()
                .zip(&query.order)
                .all(|(actual, original)| {
                    actual.field == original.field_name && actual.descending == original.descending
                })
        {
            return None;
        }

        let parameter = ir.items.get(value.parameter.0 as usize)?;
        let origin = if value.parent_depth == 0 {
            if !matches!(&actual.parent.as_ref()?.expr,IrExpr::Name(name)if name==&parameter.name) {
                return None;
            }
            ReceiptQueryParentOrigin::AdmittedReference {
                parameter: parameter.name.clone(),
            }
        } else {
            let dependency = checked
                .returns
                .iter()
                .flat_map(|returned| &returned.dependencies)
                .find(|dependency| {
                    dependency.node == value.parent
                        && dependency.calls.is_empty()
                        && dependency.query_id.is_none()
                        && dependency.role == DependencyRole::Data
                        && dependency.field_name == "parent"
                        && dependency.ty
                            == (ResolvedType::Record {
                                symbol: value.parent_model,
                                stored: true,
                            })
                })?;
            ReceiptQueryParentOrigin::StoredReference {
                dependency_id: dependency.id.clone(),
            }
        };
        emitted.push(ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry)?,
            model: query.model_name.clone(),
            parent: Some(ReceiptQueryParent {
                source: transport_source(&query.source, entry)?,
                model: ir
                    .items
                    .get(value.parent_model.0 as usize)?
                    .canonical
                    .clone(),
                origin,
            }),
            order: query
                .order
                .iter()
                .map(|order| ReceiptQueryOrder {
                    field: order.field_name.clone(),
                    direction: if order.descending { "desc" } else { "asc" }.into(),
                })
                .collect(),
            limit: None,
            archived: "exclude".into(),
            dependencies: query
                .dependencies
                .iter()
                .map(|dependency| {
                    Some(ReceiptQueryDependency {
                        id: dependency.id.clone(),
                        source: transport_source(&dependency.source, entry)?,
                        role: match dependency.role {
                            DependencyRole::Data => ReceiptRole::Data,
                            DependencyRole::Control => ReceiptRole::Control,
                        },
                        field: dependency.field_name.clone(),
                        type_id: dependency.type_id.clone(),
                    })
                })
                .collect::<Option<_>>()?,
        });
    }

    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&facts.source, entry)?,
        queries: emitted,
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                receipt_return(
                    returned,
                    entry,
                    returned
                        .influences
                        .iter()
                        .map(receipt_influence)
                        .collect::<Option<_>>()?,
                )
            })
            .collect::<Option<_>>()?,
    })
}

fn checked_native_first_query_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    supplied: Option<&'a ReceiptDisclosurePlan>,
    entry_module: &str,
    db: Option<&SourceDb>,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<Option<&'a ReceiptDisclosurePlan>> {
    let facts = checked.source_facts.as_deref()?;
    if facts
        .inline_selections
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_native_inline_selection_plan(
            ir,
            owner,
            checked,
            supplied?,
            entry_module,
            returned_paths,
            db?,
        )
        .map(Some);
    }
    if facts
        .transcripts
        .as_deref()
        .is_some_and(|facts| !facts.is_empty())
    {
        return checked_native_transcript_plan(
            ir,
            owner,
            checked,
            supplied?,
            entry_module,
            returned_paths,
            db?,
            source_context,
        )
        .map(Some);
    }
    let queries = facts.queries.as_deref().unwrap_or_default();
    if checked_mixed_helper_query_influences(facts).is_some() {
        return mixed_helper_expected_plan(ir, owner, db, entry_module, supplied, returned_paths);
    }
    if checked_helper_any_influences(facts).is_some() {
        return helper_any_expected_plan(ir, owner, db, entry_module, supplied, returned_paths);
    }
    match plain_query_outcome(queries, supplied) {
        PlainQueryOutcome::Continue => {}
        PlainQueryOutcome::Done(done) => return done,
    }
    let constructor = constructor_count_queries(facts);
    checked_native_query_influences(queries).or_else(|| constructor_count_influences(facts))?;
    let selected: Vec<_> = constructor
        .as_ref()
        .map(|queries| queries.iter().map(|query| (*query).clone()).collect())
        .unwrap_or_else(|| queries.to_vec());
    let queries = selected.as_slice();
    let plan = supplied?;
    let db = db?;
    let mut expected = first_query_expected_plan(
        ir,
        owner,
        checked,
        queries,
        entry_module,
        db,
        source_context,
    )?;
    project_plan_returns(&mut expected, returned_paths)?;
    (serde_json::to_value(plan).ok()? == serde_json::to_value(expected).ok()?).then_some(Some(plan))
}

/// The private source selection is authenticated against its actual complete
/// prefix Let using the existing owning Branch create expression seal. This
/// returns borrowed executable operands, never a reconstructed getter or row.
fn inline_selection_value(
    effects: &[IrStmt],
    statement: crate::analysis::NodeKey,
) -> Option<&TypedExpr> {
    let mut statements = effects
        .iter()
        .filter(|actual| matches!(actual,IrStmt::Let {span,..} if *span==node_span(statement)));
    let IrStmt::Let { value, .. } = statements.next()? else {
        return None;
    };
    if statements.next().is_some() {
        return None;
    }
    Some(value)
}

fn inline_selection_original(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    parent: crate::analysis::SymbolId,
    statement_end: u32,
) -> Option<&crate::analysis::scenario_disclosure::CheckedScenarioCreate> {
    let mut creates = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|created| created.model == parent && created.node.start >= statement_end);
    let original = creates.next()?;
    if creates.next().is_some() {
        return None;
    }
    Some(original)
}

fn inline_selection_facts_match(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
) -> Option<()> {
    let [original_fact] = facts.inline_selections.as_deref()? else {
        return None;
    };
    let [original_query] = facts.queries.as_deref()? else {
        return None;
    };
    if original_fact != fact
        || original_query != &fact.query
        || !facts.transcripts.as_deref()?.is_empty()
        || fact.query.source != facts.source
        || fact.parent.child != fact.query.model
        || fact.parent.parent != fact.prefix_parent.parent
        || fact.parent.child != fact.prefix_parent.child
        || fact.parent_dependency.node != fact.parent.node
        || fact.parent_dependency.model != fact.parent.child
        || fact.parent_dependency.field != fact.parent.child
        || fact.parent_dependency.field_name != "parent"
        || fact.parent_dependency.role != DependencyRole::Data
        || fact.parent_dependency.query_id.is_some()
        || !fact.parent_dependency.calls.is_empty()
    {
        return None;
    }
    Some(())
}

fn inline_selection_query_shape<'v>(
    value: &'v TypedExpr,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
) -> Option<&'v super::ir::IrQuery> {
    let IrExpr::Binary {
        op: IrBinOp::Add,
        left,
        right,
    } = &value.expr
    else {
        return None;
    };
    let IrExpr::Query(query) = &right.expr else {
        return None;
    };
    if left.span != node_span(fact.prefix_node)
        || right.span != node_span(fact.query.node)
        || value.ty != fact.ty
        || right.ty != fact.ty
        || query.source.as_deref() != Some(&fact.checked)
        || query.where_pred.as_deref()?.span != node_span(fact.query.predicate?)
        || query.parent.as_deref()?.span != node_span(fact.parent.node)
        || query.select.as_deref()?.span != node_span(fact.select)
    {
        return None;
    }
    Some(query)
}

fn inline_selection_query_options(
    query: &super::ir::IrQuery,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
) -> Option<()> {
    if query.value_order.is_some()
        || query.order.len() != 1
        || query.order[0].field != fact.order_dependency.field_name
        || query.order[0].descending
        || query.limit.is_some()
        || query.archived.is_some()
        || query.collection_call.is_some()
        || query.contract_collection_call.is_some()
    {
        return None;
    }
    Some(())
}

fn checked_inline_selection_ir<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    db: &SourceDb,
) -> Option<&'a super::ir::IrQuery> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        effects,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let value = inline_selection_value(effects, fact.statement)?;
    let original = inline_selection_original(facts, fact.parent.parent, fact.statement.end)?;
    inline_selection_facts_match(facts, fact)?;
    super::scenario_create_sources::checked_create_expression(ir, original, value, fact.value, db)?;
    let query = inline_selection_query_shape(value, fact)?;
    inline_selection_query_options(query, fact)?;
    Some(query)
}

fn checked_native_inline_selection_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    plan: &'a ReceiptDisclosurePlan,
    entry: &str,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
    db: &SourceDb,
) -> Option<&'a ReceiptDisclosurePlan> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let [fact] = facts.inline_selections.as_deref()? else {
        return None;
    };
    checked_inline_selection_ir(ir, owner, fact, db)?;
    let query = &fact.query;
    let [actual] = plan.queries.as_slice() else {
        return None;
    };
    let parent = ir.items.get(fact.parent.parent.0 as usize)?;
    let model = ir.items.get(query.model.0 as usize)?;
    let origin = actual.parent.as_ref()?;
    let ReceiptQueryParentOrigin::StoredReference { dependency_id } = &origin.origin else {
        return None;
    };
    let expected_influences = checked_scenario_query_influences(facts)?;
    // The producer deliberately gives query predicate/order/selection reads
    // different IDs from the ordinary receipt observations of the same fields.
    // Reconstruct those exact source-owned identities; all other fields still
    // compare as a complete dependency, and the returned observations stay unchanged.
    let identity = |kind: &str, node: crate::analysis::NodeKey, discriminator: &str| {
        sha256_hex(
            format!(
                "scenario-disclosure/v1:{kind}:{}:{}:{}:{}:{}:{discriminator}",
                query.source.path, query.source.sha256, query.source.module, node.start, node.end,
            )
            .as_bytes(),
        )
    };
    if query.id != identity("inline-selection-query", query.node, "")
        || plan.version != 1
        || plan.returns.len() != returned_paths.len()
        || returned_paths.is_empty()
        || !matches!(model.kind,IrItemKind::Model {owner:IrOwner::ChildOf(id),..} if id==parent.id)
        || query.dependencies.len() != 5
        || fact.dependencies.len() != 3
        || fact.fields.len() != 3
        || actual.id != query.id
        || actual.model != model.canonical
        || origin.model != parent.canonical
        || dependency_id != &fact.parent_dependency.id
        || actual.order.len() != 1
        || actual.order[0].field != fact.order_dependency.field_name
        || actual.order[0].direction != "asc"
        || actual.limit.is_some()
        || actual.archived != "exclude"
        || actual.dependencies.len() != query.dependencies.len()
        || serde_json::to_value(&plan.source).ok()?
            != serde_json::to_value(transport_source(&checked.source, entry)?).ok()?
        || serde_json::to_value(&actual.source).ok()?
            != serde_json::to_value(transport_source(&query.source, entry)?).ok()?
        || serde_json::to_value(&origin.source).ok()?
            != serde_json::to_value(&actual.source).ok()?
    {
        return None;
    }
    let mut ids = HashSet::new();
    for ((original, emitted), expected) in query.dependencies.iter().zip(&actual.dependencies).zip(
        std::iter::once(&fact.predicate_dependency)
            .chain(std::iter::once(&fact.order_dependency))
            .chain(&fact.dependencies),
    ) {
        let mut expected_query = expected.clone();
        expected_query.id = identity(
            if expected.role == DependencyRole::Data {
                "query-data"
            } else {
                "query-control"
            },
            expected.node,
            &query.id,
        );
        expected_query.query_id = None;
        let role = expected.role;
        let field = expected.field_name.as_str();
        let emitted_role = match role {
            DependencyRole::Data => ReceiptRole::Data,
            DependencyRole::Control => ReceiptRole::Control,
        };
        if original.id.is_empty()
            || !ids.insert(original.id.as_str())
            || original.model != query.model
            || original.source != query.source
            || original != &expected_query
            || original.role != role
            || original.field_name != field
            || !original.calls.is_empty()
            || original.query_id.is_some()
            || emitted.id != original.id
            || emitted.role != emitted_role
            || emitted.field != field
            || emitted.type_id != original.type_id
            || serde_json::to_value(&emitted.source).ok()?
                != serde_json::to_value(transport_source(&original.source, entry)?).ok()?
        {
            return None;
        }
    }
    for (returned, emitted) in returned_paths.iter().zip(&plan.returns) {
        if returned.source!=checked.source || returned.influences!=expected_influences
            || emitted.id!=returned.id || emitted.projection.is_some()
            || emitted.dependencies.len()!=returned.dependencies.len()
            || emitted.intrinsics.len()!=returned.intrinsics.len()
            || emitted.influences.len()!=returned.influences.len()
            || serde_json::to_value(&emitted.source).ok()?!=serde_json::to_value(transport_source(&returned.source,entry)?).ok()?
            || !fact.dependencies.iter().chain([&fact.bound_dependency,&fact.parent_dependency])
                .all(|required| returned.dependencies.iter().any(|read| read==required))
            // Candidate WHERE and engine ORDER controls belong to the genuine
            // query, not invented ordinary root/source getter observations.
            || returned.dependencies.iter().any(|read|
                read==&fact.predicate_dependency || read==&fact.order_dependency)
        {
            return None;
        }
        for (read, emitted) in returned.dependencies.iter().zip(&emitted.dependencies) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if emitted.id != read.id
                || emitted.model != read.model_name
                || emitted.field != read.field_name
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.query_id != read.query_id
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (read, emitted) in returned.intrinsics.iter().zip(&emitted.intrinsics) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            let kind = match &read.kind {
                DisclosureIntrinsicKind::CreatedModelVersion { .. } => return None,
                DisclosureIntrinsicKind::OperationId => NativeIntrinsicKind::OperationId,
                DisclosureIntrinsicKind::AdmittedInput { parameter_name, .. } => {
                    NativeIntrinsicKind::AdmittedInput {
                        parameter: parameter_name.clone(),
                    }
                }
                DisclosureIntrinsicKind::AdmittedReferenceVersion {
                    parameter_name,
                    model_name,
                    ..
                } => NativeIntrinsicKind::AdmittedReferenceVersion {
                    parameter: parameter_name.clone(),
                    model: model_name.clone(),
                },
            };
            if emitted.id != read.id
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.kind != kind
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (influence, emitted) in returned.influences.iter().zip(&emitted.influences) {
            let kind = match influence.kind {
                InfluenceKind::QueryExistence => "query-existence",
                InfluenceKind::QueryCardinality => "query-cardinality",
                InfluenceKind::QueryMembership => "query-membership",
                InfluenceKind::QueryOrder => "query-order",
                InfluenceKind::AbsentReference => return None,
            };
            if emitted.id != influence.id
                || emitted.query_id != influence.query_id
                || emitted.kind != kind
            {
                return None;
            }
        }
    }
    Some(plan)
}

/// Ordinary observations exist only for eager selected values and the real
/// supplied Turn.position WHERE-bound read. Candidate controls remain query-only.
fn inline_selection_actual<'a>(
    query: &'a super::ir::IrQuery,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> Option<&'a TypedExpr> {
    if read == &fact.bound_dependency {
        let IrExpr::Binary {
            op: IrBinOp::Lt,
            right,
            ..
        } = &query.where_pred.as_deref()?.expr
        else {
            return None;
        };
        Some(right.as_ref())
    } else {
        let field = fact
            .fields
            .iter()
            .zip(&fact.dependencies)
            .find_map(|(field, dependency)| (dependency == read).then_some(field))?;
        let IrExpr::Object(entries) = &query.select.as_deref()?.expr else {
            return None;
        };
        Some(
            &entries
                .iter()
                .find(|(name, actual)| {
                    name == &field.name && actual.span == node_span(field.value_node)
                })?
                .1,
        )
    }
}

fn single_model_contract_schema<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    model: crate::analysis::SymbolId,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == model);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    Some(schema)
}

fn checked_inline_selection_member(
    ir: &IrProgram,
    owner: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedInlineSelectionSource,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let query = checked_inline_selection_ir(ir, owner, fact, db)?;
    let actual = inline_selection_actual(query, fact, read)?;
    if !std::ptr::eq(actual, value)
        || value.span != node_span(read.node)
        || value.ty != read.ty
        || read.query_id.as_deref() != Some(fact.query.id.as_str())
        || !read.calls.is_empty()
        || read.source != fact.query.source
        || read.model != fact.query.model
    {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    if base.ty
        != (ResolvedType::Record {
            symbol: fact.query.model,
            stored: true,
        })
        || field != &read.field_name
    {
        return None;
    }
    let schema = single_model_contract_schema(ir, owner, read.model, db)?;
    let original = schema.fields.iter().find(|field| field.id == read.field)?;
    match_stored_contract_field(ir, original, db)?;
    (original.ty == read.ty && original.name == read.field_name && original.source == read.source)
        .then_some(())
}

fn checked_native_transcript_plan<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    plan: &'a ReceiptDisclosurePlan,
    entry: &str,
    returned_paths: &[&crate::analysis::scenario_disclosure::DisclosureReturn],
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<&'a ReceiptDisclosurePlan> {
    let facts = checked.source_facts.as_deref()?;
    let [first, later] = facts.transcripts.as_deref()? else {
        return None;
    };
    let mixed = !facts.queries.as_deref()?.is_empty();
    let expected_influences = checked_scenario_query_influences(facts)?;
    if mixed && expected_influences.len() != 24 {
        return None;
    }
    if checked_created_model_result(ir, owner).is_none()
        || first.id == later.id
        || first.call.end > later.call.start
        || first.parameter != later.parameter
        || first.derive != later.derive
        || first.query != later.query
        || first.source != checked.source
        || later.source != checked.source
        || plan.version != 1
        || plan.queries.len() != if mixed { 6 } else { 2 }
        || plan.returns.len() != returned_paths.len()
        || serde_json::to_value(&plan.source).ok()?
            != serde_json::to_value(transport_source(&checked.source, entry)?).ok()?
    {
        return None;
    }
    if mixed {
        let [any, ancestor, first, count] = facts.queries.as_deref()? else {
            return None;
        };
        let expected_any = checked_native_any_query_plan(ir, owner, any, db, entry)?;
        let expected_ancestor =
            checked_native_count_query_plan(ir, owner, ancestor, db, entry, source_context)?;
        let expected_first =
            checked_native_first_query_source_plan(ir, owner, checked, first, entry, db)?;
        let expected_count =
            checked_native_count_query_plan(ir, owner, count, db, entry, source_context)?;
        for (actual, expected) in [
            (1, &expected_any),
            (2, expected_ancestor.queries.first()?),
            (3, expected_first.queries.first()?),
            (5, expected_count.queries.first()?),
        ] {
            if serde_json::to_value(&plan.queries[actual]).ok()?
                != serde_json::to_value(expected).ok()?
            {
                return None;
            }
        }
    }
    let mut influences = Vec::new();
    for (fact, query) in [first, later]
        .into_iter()
        .zip([&plan.queries[0], &plan.queries[if mixed { 4 } else { 1 }]])
    {
        let model = ir.items.get(fact.model.0 as usize)?;
        let branch = ir.items.get(fact.branch.0 as usize)?;
        let parameter = ir.items.get(fact.parameter.0 as usize)?;
        let parent = query.parent.as_ref()?;
        let ReceiptQueryParentOrigin::AdmittedReference {
            parameter: selected,
        } = &parent.origin
        else {
            return None;
        };
        if query.id != fact.id
            || query.model != model.canonical
            || parent.model != branch.canonical
            || selected != &parameter.name
            || query.limit.is_some()
            || query.archived != "exclude"
            || query.order.len() != 1
            || query.order[0].field != fact.order_dependency.field_name
            || query.order[0].direction != "asc"
            || fact.query_dependencies.len() != 3
            || fact.dependencies.len() != 3
            || query.dependencies.len() != 4
            || fact.influences.len() != 4
            || serde_json::to_value(&query.source).ok()?
                != serde_json::to_value(transport_source(&fact.source, entry)?).ok()?
            || serde_json::to_value(&parent.source).ok()?
                != serde_json::to_value(&query.source).ok()?
        {
            return None;
        }
        for (original, actual) in std::iter::once(&fact.order_dependency)
            .chain(&fact.query_dependencies)
            .zip(&query.dependencies)
        {
            let role = match original.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if original.id != actual.id
                || original.field_name != actual.field
                || original.type_id != actual.type_id
                || role != actual.role
                || serde_json::to_value(&actual.source).ok()?
                    != serde_json::to_value(transport_source(&original.source, entry)?).ok()?
            {
                return None;
            }
        }
        influences.extend(fact.influences.iter().cloned());
    }
    if mixed {
        influences = expected_influences;
    }
    for (returned, actual) in returned_paths.iter().zip(&plan.returns) {
        if returned.influences != influences
            || actual.id != returned.id
            || actual.dependencies.len() != returned.dependencies.len()
            || actual.projection.is_some()
            || actual.influences.len() != influences.len()
            || serde_json::to_value(&actual.source).ok()?
                != serde_json::to_value(transport_source(&returned.source, entry)?).ok()?
        {
            return None;
        }
        for (read, emitted) in returned.dependencies.iter().zip(&actual.dependencies) {
            let role = match read.role {
                DependencyRole::Data => ReceiptRole::Data,
                DependencyRole::Control => ReceiptRole::Control,
            };
            if emitted.id != read.id
                || emitted.model != read.model_name
                || emitted.field != read.field_name
                || emitted.type_id != read.type_id
                || emitted.role != role
                || emitted.query_id != read.query_id
                || serde_json::to_value(&emitted.source).ok()?
                    != serde_json::to_value(transport_source(&read.source, entry)?).ok()?
            {
                return None;
            }
        }
        for (original, emitted) in influences.iter().zip(&actual.influences) {
            let kind = match original.kind {
                InfluenceKind::QueryExistence => "query-existence",
                InfluenceKind::QueryCardinality => "query-cardinality",
                InfluenceKind::QueryMembership => "query-membership",
                InfluenceKind::QueryOrder => "query-order",
                InfluenceKind::AbsentReference => return None,
            };
            if emitted.id != original.id
                || emitted.query_id != original.query_id
                || emitted.kind != kind
            {
                return None;
            }
        }
    }
    Some(plan)
}

fn first_query_shape_valid(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    scan: &super::ir::IrQuery,
) -> bool {
    !query.id.is_empty()
        && first.binding.kind == SyntaxKind::Let as u8
        && query.limit.is_none()
        && super::scenario_queries::archived_first_matches(query.archived, &scan.archived)
        && query.influences.len() == 4
}

fn first_query_dependencies_valid(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    model: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
) -> bool {
    use crate::analysis::scenario_disclosure::DependencyRole;
    let mut seen_dependency_ids = HashSet::new();
    for dependency in query.dependencies.iter() {
        if dependency.id.is_empty()
            || !seen_dependency_ids.insert(dependency.id.as_str())
            || dependency.source != query.source
            || dependency.model != query.model
            || dependency.model_name != query.model_name
            || dependency.role != DependencyRole::Control
            || !dependency.calls.is_empty()
            || !model.fields.iter().any(|field| {
                field.id == dependency.field
                    && field.name == dependency.field_name
                    && field.ty == dependency.ty
            })
        {
            return false;
        }
    }
    true
}

fn first_query_receipt_parent(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
    db: &SourceDb,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    entry_module: &str,
) -> Option<Option<ReceiptQueryParent>> {
    let Some(_) = first.contained_parent else {
        return Some(None);
    };
    let (parameter, parent_id) = checked_first_query_parent(ir, owner, query, scan, db)?;
    Some(Some(ReceiptQueryParent {
        source: transport_source(&query.source, entry_module)?,
        model: ir.items.get(parent_id.0 as usize)?.canonical.clone(),
        origin: ReceiptQueryParentOrigin::AdmittedReference {
            parameter: parameter.name.clone(),
        },
    }))
}

fn first_query_returns_valid(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    standalone_first: bool,
    void_tail: bool,
    expected_influences: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
    mixed: &Option<Vec<crate::analysis::scenario_disclosure::DisclosureInfluence>>,
    effects: &[IrStmt],
) -> bool {
    let target_pair = !standalone_first && checked.source_facts.as_deref()
        .and_then(|facts| facts.queries.as_deref())
        .is_some_and(|queries| matches!(queries, [any, first] if any.first.is_none() && any.count.is_none() && first == query &&
            first.first.as_ref().is_some_and(|first| first.target_consumed)));
    query.projection.is_none()
        && query.cardinality_guard.is_none()
        && query.source == checked.source
        && checked.returns.iter().all(|returned| {
            returned.source == checked.source
                && (standalone_first
                    || void_tail
                    || result_statement_at(effects, node_span(returned.node)).is_some())
                && (standalone_first || void_tail || returned.model_result.is_some())
                && if let Some(census) = mixed {
                    returned
                        .influences
                        .iter()
                        .all(|value| census.contains(value))
                } else if target_pair {
                    checked.source_facts.as_deref().and_then(|facts| facts.queries.as_deref())
                        .is_some_and(|queries| checked_any_first_target_return_order(
                            queries, expected_influences, &returned.influences))
                } else if void_tail && checked.source_facts.as_deref().and_then(|facts| facts.queries.as_deref())
                    .is_some_and(|queries| matches!(queries, [count, first] if count.count.is_some() && first == query)) {
                    checked.source_facts.as_deref().and_then(|facts| facts.queries.as_deref())
                        .is_some_and(|queries| checked_assign_count_first_target_return_order(
                            queries, expected_influences, &returned.influences))
                } else if standalone_first {
                    returned
                        .influences
                        .iter()
                        .all(|value| expected_influences.contains(value))
                } else {
                    returned.influences == expected_influences
                }
        })
}

fn checked_native_first_query_source_plan(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    entry_module: &str,
    db: &SourceDb,
) -> Option<ReceiptDisclosurePlan> {
    let facts = checked.source_facts.as_deref()?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    let mixed = checked_mixed_helper_query_influences(facts);
    if checked.returns.is_empty() {
        return None;
    }
    let first = query.first.as_ref()?;
    // An order-only first carries no predicate and no transported inputs,
    // so empty dependencies are its honest state; a where-query with no
    // dependencies is malformed and keeps the refusal.
    if query.dependencies.is_empty() && query.predicate.is_some() {
        return None;
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let call = effects.iter().find_map(|effect| match effect {
        IrStmt::Let { value, span, .. } if *span == node_span(first.binding) => Some(value),
        _ => None,
    })?;
    let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &call.expr else {
        return None;
    };
    let [domain] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    checked_first_query_order(query, scan)?;
    checked_first_query_predicate(ir, owner, query, scan)?;
    let standalone_first = facts
        .queries
        .as_ref()
        .is_some_and(|queries| queries.len() == 1 && queries[0].first.is_some())
        || checked_purchase_helper_query_influences(facts).is_some();
    let void_tail = !standalone_first && checked_void_effect_tail(owner, checked);
    if !first_query_returns_valid(
        query,
        checked,
        standalone_first,
        void_tail,
        &expected_influences,
        &mixed,
        effects,
    ) || !first_query_shape_valid(query, first, scan)
    {
        return None;
    }
    // Retain exact source and declaration membership even when the selected
    // row is not an original parameter or the model being returned. Every
    // recorded ordered conjunct dependency verifies like the former single
    // one: nonempty unique IDs, exact source/model/role/calls correspondence,
    // and schema field/type membership.
    let model = checked_first_query_schema(ir, owner, query, db)?;
    if !first_query_dependencies_valid(query, model) {
        return None;
    }
    let influences = receipt_query_influences(query)?;
    // A contained domain carries its admitted parent edge; unscoped first
    // queries keep no parent. Re-proves the disclosure receiver here, so a
    // mismatched parent keeps the source-plan refusal.
    let parent = first_query_receipt_parent(ir, owner, query, scan, db, first, entry_module)?;
    let expected = ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: checked_source_emissions(ir, owner, checked, entry_module),
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&checked.source, entry_module)?,
        queries: vec![ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry_module)?,
            model: query.model_name.clone(),
            parent,
            order: query
                .order
                .iter()
                .map(|order| ReceiptQueryOrder {
                    field: order.field_name.clone(),
                    direction: "asc".into(),
                })
                .collect(),
            limit: None,
            archived: if query.archived { "include" } else { "exclude" }.into(),
            dependencies: receipt_query_dependencies(query, entry_module)?,
        }],
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                let selected = influences
                    .iter()
                    .filter(|value| {
                        returned
                            .influences
                            .iter()
                            .any(|original| original.id == value.id)
                    })
                    .cloned()
                    .collect();
                receipt_return(returned, entry_module, selected)
            })
            .collect::<Option<Vec<_>>>()?,
    };
    Some(expected)
}

fn checked_first_query_schema<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == query.model);
    let schema = schemas.next()?;
    if schemas.next().is_some()
        || !schema.model
        || (schema.module != owner.module && !imported_schema_source(ir, owner, schema))
        || schema.canonical != query.model_name
        || (schema.source != query.source && !imported_source_corresponds(ir, owner, schema, query))
        || schema.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "id")
        })
    {
        return None;
    }
    match_stored_contract_fields(ir, schema, db)?;
    Some(schema)
}

/// A cross-package canonical must arrive through the owner's checked `use`:
/// it matches one imported provider member exactly. Mirrors the disclosure
/// import correspondence; aliasing never renames the source, so only the
/// provider-side spelling counts.
fn imported_canonical(ir: &IrProgram, owner: &IrItem, canonical: &str) -> bool {
    let Some(module) = ir.modules.get(owner.module.0 as usize) else {
        return false;
    };
    module.imports.iter().any(|import| {
        import.members.iter().any(|(name, _, _)| {
            import.provider.len() + 1 + name.len() == canonical.len()
                && canonical.starts_with(import.provider.as_str())
                && canonical.as_bytes().get(import.provider.len()) == Some(&b'.')
                && canonical[import.provider.len() + 1..] == *name
        })
    })
}

/// A cross-package stored schema must arrive through the owner's checked
/// `use`: the schema canonical matches one imported provider member
/// exactly. Mirrors the disclosure import correspondence; aliasing never
/// renames the source, so only the provider-side spelling counts.
fn imported_schema_source(
    ir: &IrProgram,
    owner: &IrItem,
    schema: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
) -> bool {
    imported_canonical(ir, owner, &schema.canonical)
}

/// Same-cohort sources across a proven import: the schema source module
/// names the canonical provider and the query source module is the
/// importing consumer. Cohort membership itself is established by the
/// single checked program both facts come from; the import edge plus the
/// exact canonical/module triple is the correspondence proof. Same-module
/// pairs keep their exact equality above and never reach here.
fn imported_source_corresponds(
    ir: &IrProgram,
    owner: &IrItem,
    schema: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> bool {
    imported_field_source_corresponds(ir, owner, &schema.canonical, &schema.source, &query.source)
}

/// Same-cohort field sources across a proven import: the field source
/// module names the model canonical provider and the read source module is
/// the importing consumer. Cohort membership itself is established by the
/// single checked program both facts come from.
fn imported_field_source_corresponds(
    ir: &IrProgram,
    owner: &IrItem,
    model_canonical: &str,
    field_source: &crate::analysis::scenario_disclosure::DisclosureSource,
    read_source: &crate::analysis::scenario_disclosure::DisclosureSource,
) -> bool {
    if field_source.module == read_source.module {
        return false;
    }
    let Some(dot) = model_canonical.rfind('.') else {
        return false;
    };
    if field_source.module != model_canonical[..dot] {
        return false;
    }
    let Some(consumer) = ir.modules.get(owner.module.0 as usize) else {
        return false;
    };
    if read_source.module != consumer.name {
        return false;
    }
    imported_canonical(ir, owner, model_canonical)
}

/// A contained FIRST domain scans the original required parent parameter's
/// children. The receiver names the same default-free scenario Model
/// parameter the disclosure proved, and the child stays ChildOf it. Mirrors
/// the count contained-parent proof; unscoped first queries have no
/// contained parent and never reach here.
/// Admitted contained-query parent: the declared parameter plus the
/// resolved parent model. Direct `p.C` resolves the model from the
/// parameter's own declared type; navigation `i.parent.C` resolves it
/// from the decoded one-hop containment value, sealed against the exact
/// authored `param.parent` path and the owning ChildOf lineage on both
/// the input model and the child model.
/// Direct receivers name the parameter; navigation receivers name the
/// exact one-hop containment path. Anything else keeps the refusal.
/// Authored parameter node plus the receiver slice it proves.
fn first_query_navigation(
    text: &str,
    source_receiver: &SyntaxNode,
    receiver_text: &str,
    parameter_name: &str,
) -> Option<(bool, Option<Span>)> {
    match source_receiver.kind {
        SyntaxKind::NameRef => Some((false, None)),
        SyntaxKind::Member => {
            // Exactly one NameRef base and one Name field; the dot and
            // any trivia carry no identity and are skipped by kind.
            let mut bases = source_receiver
                .children
                .iter()
                .filter(|part| part.kind == SyntaxKind::NameRef);
            let mut fields = source_receiver
                .children
                .iter()
                .filter(|part| part.kind == SyntaxKind::Name);
            let (Some(base), None) = (bases.next(), bases.next()) else {
                return None;
            };
            let (Some(field), None) = (fields.next(), fields.next()) else {
                return None;
            };
            let sealed = text.get(base.span.start as usize..base.span.end as usize)?
                == parameter_name
                && text.get(field.span.start as usize..field.span.end as usize)? == "parent"
                && receiver_text == format!("{parameter_name}.parent");
            Some((sealed, sealed.then_some(base.span)))
        }
        _ => None,
    }
}

/// The parent value decoded from the authored receiver carries the
/// resolved model: direct shapes read the parameter name, navigation
/// shapes read the exact `param.parent` member.
fn first_query_parent_model(
    parent_value: &TypedExpr,
    navigation: bool,
    nav_base: Option<Span>,
    parameter_name: &str,
    base_ty: &ResolvedType,
    input_id: &crate::analysis::SymbolId,
) -> Option<crate::analysis::SymbolId> {
    Some(match &parent_value.expr {
        IrExpr::Name(name) if !navigation && name == parameter_name => *input_id,
        IrExpr::Member { base, field }
            if navigation
                && field == "parent"
                && matches!(&base.expr, IrExpr::Name(name) if name == parameter_name)
                && nav_base.is_some_and(|span| base.span == span)
                && base.ty == *base_ty =>
        {
            match &parent_value.ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } => *symbol,
                _ => return None,
            }
        }
        _ => return None,
    })
}

/// A navigation parent must be the input model's owning containment
/// parent; the direct shape keeps the parameter's own declared model.
fn navigation_parent_valid(
    navigation: bool,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    input_id: &crate::analysis::SymbolId,
    parent_id: crate::analysis::SymbolId,
) -> bool {
    !navigation
        || facts.stored_contracts.as_deref().is_some_and(|schemas| {
            schemas
                .iter()
                .find(|schema| schema.model && schema.id == *input_id)
                .is_some_and(|schema| schema.parent == Some(parent_id))
        })
}

fn match_stored_contract_fields(
    ir: &IrProgram,
    parent: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    db: &SourceDb,
) -> Option<()> {
    match_stored_contract_schema(ir, parent, db)?;
    for field in &parent.fields {
        match_stored_contract_field(ir, field, db)?;
    }
    Some(())
}

/// Source and declaration ownership shared by contained FIRST and COUNT.
/// Construction proves the original required input and child schema; finishing
/// proves the selected parent, imported ownership and all declared fields.
/// The caller must independently prove its particular receiver occurrence.
struct ContainedParentSource<'ir, 'source> {
    ir: &'ir IrProgram,
    owner: &'source IrItem,
    query: &'source crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &'source SourceDb,
    facts: &'ir crate::analysis::scenario_disclosure::CheckedScenarioSource,
    parameter: &'ir IrItem,
    fact: &'ir crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    input_model: crate::analysis::SymbolId,
    child: &'ir crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    receiver: SyntaxNode,
    text: &'source str,
}

impl<'ir, 'source> ContainedParentSource<'ir, 'source> {
    fn checked(
        ir: &'ir IrProgram,
        owner: &'source IrItem,
        query: &'source crate::analysis::scenario_disclosure::DisclosureQuery,
        receiver: crate::analysis::NodeKey,
        parameter_id: crate::analysis::SymbolId,
        db: &'source SourceDb,
    ) -> Option<Self> {
        let facts = super::scenario_calls::checked_source(ir, owner, db)?;
        let parameter = ir.items.get(parameter_id.0 as usize)?;
        let IrItemKind::Scenario {
            params,
            read: false,
            ..
        } = &owner.kind
        else {
            return None;
        };
        let IrItemKind::Param {
            owner: parameter_owner,
            index,
            ty:
                IrType::Known(ResolvedType::Record {
                    symbol: input_model,
                    stored: true,
                }),
            array_bounds: None,
            default: None,
            default_node: None,
            default_copy_source: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let fact = facts.parameters.get(*index)?;
        let child = checked_first_query_schema(ir, owner, query, db)?;
        let receiver_node = checked_effect_node(ir, owner, receiver, db)?;
        let declaration = checked_effect_node(ir, owner, fact.node, db)?;
        let name = declaration
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        let text = db.get(receiver.file)?.text.as_str();
        if parameter.id != parameter_id
            || *parameter_owner != owner.id
            || params.get(*index) != Some(&parameter_id)
            || params.iter().filter(|id| **id == parameter_id).count() != 1
            || fact.parameter != parameter_id
            || fact.ty
                != (ResolvedType::Record {
                    symbol: *input_model,
                    stored: true,
                })
            || fact.default.is_some()
            || fact.constraints.is_some()
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || parameter.span != name.span
            || !name
                .token()
                .is_some_and(|token| token.text(text) == parameter.name)
        {
            return None;
        }
        Some(Self {
            ir,
            owner,
            query,
            db,
            facts,
            parameter,
            fact,
            input_model: *input_model,
            child,
            receiver: receiver_node,
            text,
        })
    }

    fn check_domain_parent(&self, parent_id: crate::analysis::SymbolId) -> Option<()> {
        let mut parents = self
            .facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.model && schema.id == parent_id);
        let parent = parents.next()?;
        if parents.next().is_some()
            || !contained_query_models_valid(
                self.ir, self.owner, self.query, self.child, &parent_id, parent,
            )
        {
            return None;
        }
        match_stored_contract_fields(self.ir, parent, self.db)
    }
}

pub(super) fn checked_first_query_parent<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
    db: &SourceDb,
) -> Option<(&'a IrItem, crate::analysis::SymbolId)> {
    let (receiver, parameter_id) = query.first.as_ref()?.contained_parent?;
    let source = ContainedParentSource::checked(ir, owner, query, receiver, parameter_id, db)?;
    let receiver_text = source
        .text
        .get(receiver.start as usize..receiver.end as usize)?;
    // FIRST retains its exact direct or one-hop authored path and decoded IR
    // base occurrence. The common declaration proof grants neither receiver.
    let (navigation, nav_base) = first_query_navigation(
        source.text,
        &source.receiver,
        receiver_text,
        &source.parameter.name,
    )?;
    let parent_value = scan.parent.as_deref()?;
    let parent_id = first_query_parent_model(
        parent_value,
        navigation,
        nav_base,
        &source.parameter.name,
        &source.fact.ty,
        &source.input_model,
    )?;
    if !navigation_parent_valid(navigation, source.facts, &source.input_model, parent_id)
        || (!navigation && receiver_text != source.parameter.name)
        || parent_value.span != node_span(receiver)
    {
        return None;
    }
    source.check_domain_parent(parent_id)?;
    Some((source.parameter, parent_id))
}

fn contained_query_models_valid(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    child: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    parent_id: &crate::analysis::SymbolId,
    parent: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
) -> bool {
    child.parent == Some(*parent_id)
        && child.owner == Some(crate::analysis::resolve::ModelOwner::ChildOf(*parent_id))
        && (parent.source == query.source || imported_source_corresponds(ir, owner, parent, query))
        && (parent.module == owner.module || imported_schema_source(ir, owner, parent))
        && !parent.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == ir.items[query.model.0 as usize].name)
        })
        && !child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
}

fn checked_count_query_parent<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<&'a IrItem> {
    let count = query.count.as_ref()?;
    let (receiver, parameter_id) = count.contained_parent?;
    let source = ContainedParentSource::checked(ir, owner, query, receiver, parameter_id, db)?;
    let facts = source.facts;
    let parameter = source.parameter;
    let parent_id = &source.input_model;
    let domain_parent = source.child.parent?;
    let source_receiver = &source.receiver;
    let created_receiver = if source_receiver.kind == SyntaxKind::Member {
        let IrItemKind::Scenario { effects, .. } = &owner.kind else {
            return None;
        };
        let (input, input_span) = native_count_create_input(effects, count.statement)?;
        let IrExpr::Object(entries) = &input.expr else {
            return None;
        };
        let original = native_count_original(facts, count.statement)?;
        let actual_parent = original
            .inputs
            .iter()
            .find(|input| input.name == "parent")?;
        let value = &entries.iter().find(|(name, _)| name == "parent")?.1;
        if input_span != node_span(original.node)
            || value.span != node_span(actual_parent.value_node)
        {
            return None;
        }
        checked_created_parent(ir, owner, value, db)
            .filter(|(_, parameter, _)| parameter.id == parameter_id)
    } else {
        None
    };
    let created_root = created_receiver.and_then(|(created, _, _)| {
        created
            .inputs
            .iter()
            .find(|input| input.name == "parent")
            .map(|input| input.value_node)
    });
    let created_root_node = created_root.and_then(|node| checked_effect_node(ir, owner, node, db));
    let receiver_root = if let Some(root) = &created_root_node {
        root
    } else if domain_parent == *parent_id && source_receiver.kind == SyntaxKind::NameRef {
        source_receiver
    } else {
        let root_schema = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.model && schema.id == *parent_id)?;
        if source_receiver.kind != SyntaxKind::Member
            || root_schema.parent != Some(domain_parent)
            || !facts.expression_types.as_deref()?.iter().any(|(node, ty)| {
                *node == receiver
                    && *ty
                        == ResolvedType::Record {
                            symbol: domain_parent,
                            stored: true,
                        }
            })
        {
            return None;
        }
        match_stored_contract_schema(ir, root_schema, db)?;
        let field = source_receiver
            .children
            .iter()
            .rev()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if field.token()?.text(&db.get(receiver.file)?.text) != "parent" {
            return None;
        }
        let mut roots = source_receiver
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::NameRef);
        let root = roots.next()?;
        if roots.next().is_some() {
            return None;
        }
        root
    };
    // COUNT retains its exact direct NameRef after its own created-parent or
    // one-hop root proof; this is intentionally narrower than FIRST's path.
    if receiver_root.kind != SyntaxKind::NameRef
        || source
            .text
            .get(receiver_root.span.start as usize..receiver_root.span.end as usize)
            != Some(parameter.name.as_str())
    {
        return None;
    }
    source.check_domain_parent(domain_parent)?;
    Some(parameter)
}

/// Match the actual original COUNT call to its true contained Member. The
/// synthetic IR Query deliberately has no fabricated alias, predicate or CST
/// Query fact; its original Member, parent binding and type census own it.
fn count_query_owner<'a>(
    ir: &'a IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<&'a IrItem> {
    let mut owners = ir.items.iter().filter(|owner| {
        matches!(owner.kind, IrItemKind::Scenario { .. })
            && ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| {
                    facts.source == original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates.iter().any(|created| created.node == original.node)
                        })
                })
    });
    let owner = owners.next()?;
    if owners.next().is_some() {
        return None;
    }
    Some(owner)
}

fn select_count_query(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    node: crate::analysis::NodeKey,
) -> Option<(
    &crate::analysis::scenario_disclosure::DisclosureQuery,
    &crate::analysis::scenario_disclosure::DisclosureCountQuery,
)> {
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries).or_else(|| constructor_count_influences(facts))?;
    let mut selected = queries
        .iter()
        .filter(|query| query.count.as_ref().is_some_and(|count| count.call == node));
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let count = query.count.as_ref()?;
    Some((query, count))
}

fn count_query_call_shape(
    actual: &TypedExpr,
) -> Option<(
    &IrCallTarget,
    &TypedExpr,
    &IrQuery,
    Option<&[Option<usize>]>,
)> {
    let (target, args, slots) = match &actual.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    Some((target, domain, scan, slots))
}

fn count_query_target_mismatch(
    target: &IrCallTarget,
    count: &crate::analysis::scenario_disclosure::DisclosureCountQuery,
    slots: Option<&[Option<usize>]>,
    node: crate::analysis::NodeKey,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    query_model: crate::analysis::SymbolId,
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> bool {
    !matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "count")
        || count.call != node
        || count.slots.as_slice() != [Some(0)]
        || slots.is_some_and(|slots| slots != count.slots.as_slice())
        || count.statement != original.node
        || original.model != query_model
        || (!matches!(&owner.kind, IrItemKind::Scenario { result: None, .. })
            && checked_created_model_result(ir, owner) != Some(original.model)
            && checked_created_pair(ir, owner, db).is_none_or(|pair| pair.1.node != original.node)
            && constructor_model_return_shape(ir, owner, db).is_none())
}

fn count_query_shape_mismatch(
    node: crate::analysis::NodeKey,
    actual: &TypedExpr,
    domain_ty: &ResolvedType,
    array: &ResolvedType,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> bool {
    actual.span != node_span(node)
        || actual.ty != ResolvedType::Scalar(Scalar::Int)
        || *domain_ty != *array
        || query.source != original.source
        || query.domain != query.node
        || query.node.kind != SyntaxKind::Member as u8
        || query.alias.is_some()
        || query.predicate.is_some()
        || query.first.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || query.archived
}

fn count_query_scan_mismatch(scan: &IrQuery, query_model_name: &str) -> bool {
    scan.source.is_some()
        || scan.collection_call.is_some()
        || scan.contract_collection_call.is_some()
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(name) if name == query_model_name)
        || scan.where_pred.is_some()
        || scan.where_async
        || !scan.order.is_empty()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.select.is_some()
        || scan.select_param.is_some()
}

fn count_query_parent_mismatch(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureCountQuery,
    contained: Option<(crate::analysis::NodeKey, crate::analysis::SymbolId)>,
    parent: &TypedExpr,
    receiver: crate::analysis::NodeKey,
    parent_type: &ResolvedType,
    parameter_name: &str,
) -> bool {
    !query.order.is_empty()
        || !query.dependencies.is_empty()
        || !count.parent_edges.is_empty()
        || contained.is_none_or(|parent| query.inputs.as_slice() != [parent])
        || parent.span != node_span(receiver)
        || parent.ty != *parent_type
        || !(matches!(&parent.expr, IrExpr::Name(name) if name == parameter_name)
            || matches!(&parent.expr,IrExpr::Member{base,field} if field=="parent"
                && matches!(&base.expr,IrExpr::Name(name) if name==parameter_name)))
}

fn strip_source_groups<'x>(
    census: &[(crate::analysis::NodeKey, ResolvedType)],
    domain_ty: &ResolvedType,
    mut source_domain: &'x SyntaxNode,
) -> Option<&'x SyntaxNode> {
    for _ in 0..=64 {
        if !census
            .iter()
            .any(|(at, ty)| *at == crate::analysis::NodeKey::of(source_domain) && ty == domain_ty)
        {
            return None;
        }
        if source_domain.kind != SyntaxKind::Group {
            break;
        }
        let mut grouped = source_domain
            .children
            .iter()
            .filter(|node| matches!(node.kind, SyntaxKind::Group | SyntaxKind::Member));
        source_domain = grouped.next()?;
        if grouped.next().is_some() {
            return None;
        }
    }
    Some(source_domain)
}

fn count_query_head(
    authored: &SyntaxNode,
    text: &str,
    source_domain: &SyntaxNode,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    receiver: crate::analysis::NodeKey,
    ir: &IrProgram,
) -> Option<()> {
    use crate::analysis::NodeKey;
    let mut heads = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::NameRef);
    let head = heads.next()?;
    let member_name = source_domain
        .children
        .iter()
        .rev()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let mut receivers = source_domain
        .children
        .iter()
        .filter(|node| matches!(node.kind, SyntaxKind::NameRef | SyntaxKind::Member));
    if heads.next().is_some()
        || text.get(head.span.start as usize..head.span.end as usize)? != "count"
        || NodeKey::of(source_domain) != query.node
        || member_name.token()?.text(text) != ir.items.get(query.model.0 as usize)?.name
        || NodeKey::of(receivers.next()?) != receiver
        || receivers.next().is_some()
    {
        return None;
    }
    Some(())
}

fn count_query_proven(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    ir: &IrProgram,
    owner: &IrItem,
    node: crate::analysis::NodeKey,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    receiver: crate::analysis::NodeKey,
    actual_ty: &ResolvedType,
    parent_ty: &ResolvedType,
    domain: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let census = facts.expression_types.as_deref()?;
    if !census.iter().any(|(at, ty)| *at == node && ty == actual_ty)
        || !census
            .iter()
            .any(|(at, ty)| *at == receiver && ty == parent_ty)
    {
        return None;
    }
    let authored = checked_effect_node(ir, owner, node, db)?;
    let text = &db.get(node.file)?.text;
    let mut arguments = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Argument);
    let argument = arguments.next()?;
    if arguments.next().is_some() {
        return None;
    }
    let mut values = argument
        .children
        .iter()
        .filter(|node| matches!(node.kind, SyntaxKind::Group | SyntaxKind::Member));
    let source_domain = values.next()?;
    if values.next().is_some() || source_domain.span != domain.span {
        return None;
    }
    let source_domain = strip_source_groups(census, &domain.ty, source_domain)?;
    count_query_head(&authored, text, source_domain, query, receiver, ir)
}

pub(super) fn checked_count_query_ir<'a>(
    ir: &'a IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let owner = count_query_owner(ir, original)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let (query, count) = select_count_query(facts, node)?;
    if count.contained_parent.is_none() {
        let (call, _, _) = checked_ancestor_count_query_operands(ir, owner, query, db)?;
        return (count.call == node && std::ptr::eq(call, actual)).then_some(query);
    }
    let (receiver, _) = count.contained_parent?;
    let (target, domain, scan, slots) = count_query_call_shape(actual)?;
    let parent = scan.parent.as_deref()?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let parent_type = ResolvedType::Record {
        symbol: checked_first_query_schema(ir, owner, query, db)?.parent?,
        stored: true,
    };
    let parent_name = if checked_created_parent(ir, owner, parent, db).is_some() {
        let IrExpr::Member { base, .. } = &parent.expr else {
            return None;
        };
        let IrExpr::Name(name) = &base.expr else {
            return None;
        };
        name
    } else {
        &parameter.name
    };
    let array = ResolvedType::Array {
        element: Box::new(ResolvedType::Record {
            symbol: query.model,
            stored: true,
        }),
        ordered: true,
        nonempty: false,
    };
    if count_query_target_mismatch(
        target,
        count,
        slots,
        node,
        original,
        query.model,
        ir,
        owner,
        db,
    ) || count_query_shape_mismatch(node, actual, &domain.ty, &array, query, original)
        || count_query_scan_mismatch(scan, &query.model_name)
        || count_query_parent_mismatch(
            query,
            count,
            count.contained_parent,
            parent,
            receiver,
            &parent_type,
            parent_name,
        )
    {
        return None;
    }
    count_query_proven(
        facts,
        ir,
        owner,
        node,
        query,
        receiver,
        &actual.ty,
        &parent_type,
        domain,
        db,
    )?;
    Some(query)
}

/// The source-owned ancestor count is the original leading Require. Its two
/// ordinary reads occur inside the actual predicate, never at the root stage.
fn ancestor_guard_comparison(
    guards: &[IrStmt],
    statement: crate::analysis::NodeKey,
) -> Option<(
    &Box<TypedExpr>,
    &Box<TypedExpr>,
    &TypedExpr,
    &super::ir::IrQuery,
    &Box<TypedExpr>,
    &Box<TypedExpr>,
)> {
    let mut matching = guards.iter().filter(
        |actual| matches!(actual, IrStmt::Require {span, ..} if *span == node_span(statement)),
    );
    let IrStmt::Require { cond, .. } = matching.next()? else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Lt,
        left: call,
        right: bound,
    } = &cond.expr
    else {
        return None;
    };
    let arguments = match &call.expr {
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => args,
        _ => return None,
    };
    let [domain] = arguments.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let predicate = scan.where_pred.as_deref()?;
    let IrExpr::Binary {
        op: IrBinOp::And,
        left: equality,
        ..
    } = &predicate.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: actual_candidate,
        right: actual_supplied,
    } = &equality.expr
    else {
        return None;
    };
    if matching.next().is_some() {
        return None;
    }
    Some((call, bound, cond, scan, actual_candidate, actual_supplied))
}

fn ancestor_query_identity(
    ir: &IrProgram,
    owner: &IrItem,
    owning: &crate::analysis::scenario_disclosure::DisclosureQuery,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    count: &crate::analysis::scenario_disclosure::DisclosureCountQuery,
    created: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    cond: &TypedExpr,
    bound: &TypedExpr,
    call: &TypedExpr,
) -> Option<()> {
    if owning != query
        || count.contained_parent.is_some()
        || count.statement.kind != SyntaxKind::Require as u8
        || count.statement.end > created.node.start
        || created.model != query.model
        || created.source != query.source
        || checked_created_model_result(ir, owner) != Some(created.model)
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
        || bound.ty != ResolvedType::Scalar(Scalar::Int)
        || !matches!(bound.expr, IrExpr::Int(10))
        || call.span != node_span(count.call)
    {
        return None;
    }
    Some(())
}

fn ancestor_edge_associations(
    ir: &IrProgram,
    owner: &IrItem,
    returned: &crate::analysis::scenario_disclosure::DisclosureReturn,
    candidate: &crate::analysis::scenario_disclosure::DisclosureQueryParentEdge,
    supplied: &crate::analysis::scenario_disclosure::DisclosureQueryParentEdge,
    actual_candidate: &TypedExpr,
    actual_supplied: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    for (edge, actual) in [(candidate, actual_candidate), (supplied, actual_supplied)] {
        let mut reads = returned
            .dependencies
            .iter()
            .filter(|read| read.node == edge.node);
        let read = reads.next()?;
        if reads.next().is_some() {
            return None;
        }
        checked_candidate_parent_association(ir, owner, read, actual, db)?;
    }
    Some(())
}

fn ancestor_census_valid(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    ir: &IrProgram,
    owner: &IrItem,
    count: &crate::analysis::scenario_disclosure::DisclosureCountQuery,
    cond: &TypedExpr,
    bound: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let census = facts.expression_types.as_deref()?;
    let authored_guard = checked_effect_node(ir, owner, count.statement, db)?;
    let source_condition = authored_guard
        .children
        .iter()
        .find(|node| matches!(node.kind, SyntaxKind::Binary | SyntaxKind::Group))?;
    if cond.span != source_condition.span
        || census
            .iter()
            .find(|(node, _)| node_span(*node) == cond.span)?
            .1
            != cond.ty
        || census
            .iter()
            .find(|(node, _)| node_span(*node) == bound.span)?
            .1
            != bound.ty
    {
        return None;
    }
    Some(())
}

fn ancestor_schemas_valid(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    ir: &IrProgram,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    candidate: &crate::analysis::scenario_disclosure::DisclosureQueryParentEdge,
    db: &SourceDb,
) -> Option<()> {
    for id in [query.model, candidate.child, candidate.parent] {
        let mut schemas = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.id == id);
        let schema = schemas.next()?;
        if schemas.next().is_some() || schema.source != query.source {
            return None;
        }
        match_stored_contract_fields(ir, schema, db)?;
    }
    Some(())
}

fn ancestor_owning_pair<'a>(
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    queries: &'a [crate::analysis::scenario_disclosure::DisclosureQuery],
) -> Option<(
    &'a crate::analysis::scenario_disclosure::DisclosureQuery,
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
)> {
    match queries {
        [owning] => {
            let [created] = facts.creates.as_deref()? else {
                return None;
            };
            Some((owning, created))
        }
        [owning, _, _] => Some((owning, checked_created_pair(ir, owner, db)?.0)),
        [_, owning, _, _] if facts.transcripts.as_deref()?.len() == 2 => {
            Some((owning, checked_created_pair(ir, owner, db)?.0))
        }
        _ => None,
    }
}

fn checked_ancestor_count_query_operands<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
) -> Option<(&'a TypedExpr, &'a TypedExpr, &'a TypedExpr)> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)?;
    let (owning, created) = ancestor_owning_pair(facts, ir, owner, db, queries)?;
    let count = query.count.as_ref()?;
    let [_, candidate, supplied] = count.parent_edges.as_slice() else {
        return None;
    };
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario { guards, .. } = &owner.kind else {
        return None;
    };
    let (call, bound, cond, _, actual_candidate, actual_supplied) =
        ancestor_guard_comparison(guards, count.statement)?;
    ancestor_query_identity(ir, owner, owning, query, count, created, cond, bound, call)?;
    checked_native_query_influences(facts.queries.as_deref()?)?;
    let returned = proof.returns.first()?;
    ancestor_edge_associations(
        ir,
        owner,
        returned,
        candidate,
        supplied,
        actual_candidate,
        actual_supplied,
        db,
    )?;
    ancestor_census_valid(facts, ir, owner, count, cond, bound, db)?;
    ancestor_schemas_valid(facts, ir, query, candidate, db)?;
    Some((
        call.as_ref(),
        actual_candidate.as_ref(),
        actual_supplied.as_ref(),
    ))
}

fn checked_native_ancestor_count_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    checked_ancestor_count_query_operands(ir, owner, query, db)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    if queries.len() == 1 {
        let [created] = facts.creates.as_deref()? else {
            return None;
        };
        let IrItemKind::Scenario { effects, .. } = &owner.kind else {
            return None;
        };
        let mut statements = effects.iter().filter(|statement|
            matches!(statement, IrStmt::Create {span,..} if *span == node_span(created.node)));
        let statement = statements.next()?;
        let mut creates = proof
            .effects
            .iter()
            .filter(|effect| effect.node == created.node);
        let create = creates.next()?;
        if statements.next().is_some() || creates.next().is_some() {
            return None;
        }
        let models = super::js::Emitter::source_models(ir, db)?;
        checked_scenario_create(
            ir,
            owner,
            &models,
            proof,
            create,
            statement,
            db,
            source_context,
        )?;
    }
    // In the triple, the owning contained-count plan and final effect
    // collector seal both constructors; ancestor operand validation does not
    // recurse into their complete query plan or repeat constructor admission.
    let kinds = [
        InfluenceKind::QueryExistence,
        InfluenceKind::QueryCardinality,
        InfluenceKind::QueryMembership,
        InfluenceKind::QueryOrder,
    ];
    let influences = query
        .influences
        .iter()
        .zip(kinds)
        .map(|(influence, kind)| {
            if influence.kind != kind {
                return None;
            }
            receipt_influence(influence)
        })
        .collect::<Option<Vec<_>>>()?;
    if proof.returns.is_empty()
        || proof.returns.iter().any(|returned| {
            returned.node != query.return_node
                || returned.source != query.source
                || returned.influences != expected_influences
                || returned.model_result.is_none()
        })
    {
        return None;
    }
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&query.source, entry)?,
        queries: vec![receipt_unordered_query(
            query,
            entry,
            None,
            receipt_query_dependencies(query, entry)?,
        )?],
        returns: proof
            .returns
            .iter()
            .map(|returned| receipt_return(returned, entry, influences.clone()))
            .collect::<Option<Vec<_>>>()?,
    })
}

/// A bounded contained COUNT+1 Create uses the same prepared-query skeleton as
/// first. No runtime handle or parent authority is issued by this source join.
fn native_count_create_input(
    effects: &[IrStmt],
    statement: crate::analysis::NodeKey,
) -> Option<(&TypedExpr, Span)> {
    fn visit<'a>(
        body: &'a [IrStmt],
        statement: Span,
        depth: usize,
        out: &mut Vec<(&'a TypedExpr, Span)>,
    ) -> Option<()> {
        if depth >= 64 {
            return None;
        }
        for actual in body {
            match actual {
                IrStmt::Create { input, span, .. } if *span == statement => {
                    out.push((input, *span))
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    visit(then_branch, statement, depth + 1, out)?;
                    visit(else_branch, statement, depth + 1, out)?;
                }
                _ => {}
            }
        }
        Some(())
    }
    let mut found = Vec::new();
    visit(effects, node_span(statement), 0, &mut found)?;
    (found.len() == 1).then(|| found[0])
}

fn native_count_original(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    statement: crate::analysis::NodeKey,
) -> Option<&crate::analysis::scenario_disclosure::CheckedScenarioCreate> {
    let originals = facts.creates.as_deref()?;
    let mut owning = originals.iter().filter(|created| created.node == statement);
    let original = owning.next()?;
    if owning.next().is_some()
        || originals.is_empty()
        || (originals.len() > 2
            && !(originals.len() <= 200 && constructor_count_queries(facts).is_some()))
        || facts.queries.as_deref()?.len() >= 2
            && originals.len() != 2
            && constructor_count_queries(facts).is_none()
    {
        return None;
    }
    Some(original)
}

fn native_count_pair_proofs(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    effects: &[IrStmt],
    originals: &[crate::analysis::scenario_disclosure::CheckedScenarioCreate],
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<()> {
    checked_created_pair(ir, owner, db)?;
    let models = super::js::Emitter::source_models(ir, db)?;
    for created in originals {
        let proof = checked
            .effects
            .iter()
            .find(|proof| proof.node == created.node)?;
        let statement = effects.iter().find(|statement|
            matches!(statement, IrStmt::Create {span, ..} if *span == node_span(created.node)))?;
        checked_scenario_create(
            ir,
            owner,
            &models,
            checked,
            proof,
            statement,
            db,
            source_context,
        )?;
    }
    Some(())
}

fn native_count_operand(input: &TypedExpr, call: crate::analysis::NodeKey) -> Option<&TypedExpr> {
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let mut operands = entries.iter().filter_map(|(_, value)| match &value.expr {
        IrExpr::Binary {
            op: IrBinOp::Add,
            left,
            right,
        } if matches!(right.expr, IrExpr::Int(1)) && left.span == node_span(call) => {
            Some(left.as_ref())
        }
        _ => None,
    });
    let operand = operands.next()?;
    if operands.next().is_some() {
        return None;
    }
    Some(operand)
}

fn native_count_result_matches(
    ir: &IrProgram,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    operand: &TypedExpr,
    span: Span,
    returned: Span,
    expected_influences: &[crate::analysis::scenario_disclosure::DisclosureInfluence],
    call: crate::analysis::NodeKey,
    db: &SourceDb,
    void_constructor: bool,
) -> Option<()> {
    let count = query.count.as_ref()?;
    if query.id.is_empty()
        || original.node != count.statement
        || span != node_span(count.statement)
        || returned != node_span(query.return_node)
        || checked.source != query.source
        || facts.source != query.source
        || checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            returned.node != query.return_node
                || returned.source != query.source
                || if void_constructor {
                    // Each genuine branch retains exactly its original reached
                    // query blocks; inactive COUNTs acquire no observation.
                    returned.model_result.is_some()
                        || !expected_influences
                            .iter()
                            .filter(|value| returned.influences.contains(value))
                            .eq(returned.influences.iter())
                        || {
                            let selected: Vec<_> = returned
                                .influences
                                .iter()
                                .filter(|value| {
                                    value.query_id.as_deref() == Some(query.id.as_str())
                                })
                                .collect();
                            !selected.is_empty()
                                && !selected.into_iter().eq(query.influences.iter())
                        }
                } else {
                    returned.model_result.is_none() || returned.influences != expected_influences
                }
        })
        || !checked.returns.iter().any(|returned| {
            query
                .influences
                .iter()
                .all(|value| returned.influences.contains(value))
        })
    {
        return None;
    }
    checked_count_query_ir(ir, original, operand, call, db)?;
    super::scenario_create_sources::checked_create_expression(ir, original, operand, call, db)?;
    Some(())
}

fn receipt_query_influences(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<Vec<ReceiptInfluence>> {
    checked_query_influence_shape(query)?;
    query.influences.iter().map(receipt_influence).collect()
}

fn native_count_plan(
    ir: &IrProgram,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    entry: &str,
    parameter: &IrItem,
    parent_id: crate::analysis::SymbolId,
    influences: Vec<ReceiptInfluence>,
) -> Option<ReceiptDisclosurePlan> {
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&query.source, entry)?,
        queries: vec![receipt_unordered_query(
            query,
            entry,
            Some(ReceiptQueryParent {
                source: transport_source(&query.source, entry)?,
                model: ir.items.get(parent_id.0 as usize)?.canonical.clone(),
                origin: ReceiptQueryParentOrigin::AdmittedReference {
                    parameter: parameter.name.clone(),
                },
            }),
            Vec::new(),
        )?],
        returns: checked
            .returns
            .iter()
            .map(|returned| {
                let selected = if returned
                    .influences
                    .iter()
                    .any(|value| value.query_id.as_deref() == Some(query.id.as_str()))
                {
                    influences.clone()
                } else {
                    Vec::new()
                };
                receipt_return(returned, entry, selected)
            })
            .collect::<Option<Vec<_>>>()?,
    })
}

/// Capacity COUNT for the original void assign, before its target FIRST.
/// Rejoin the checked source occurrence to the executable guard and scan;
/// the ordinary contained-count plan below is reserved for COUNT+1 Create.
pub(super) fn checked_native_assign_count_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
) -> Option<ReceiptDisclosurePlan> {
    use super::ir::IrQueryDomain;
    if owner.canonical != "member_terms.assign"
        || checked.scenario != owner.id
        || query.model_name != "member_terms.Seat"
        || checked.source != query.source
    {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    let [count_query, first_query] = queries else {
        return None;
    };
    assign_count_first_shape_valid(count_query, first_query)?;
    if count_query != query {
        return None;
    }
    let count = query.count.as_ref()?;
    let (receiver, _) = count.contained_parent?;
    let IrItemKind::Scenario {
        guards,
        effects,
        result: None,
        read: false,
        trusted: false,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [_, _, IrStmt::Require { cond, span }] = guards.as_slice() else {
        return None;
    };
    checked_assign_header_and_event(ir, owner, guards, effects)?;
    if *span != node_span(count.statement) || cond.ty != ResolvedType::Scalar(Scalar::Bool) {
        return None;
    }
    let IrExpr::Binary {
        op: IrBinOp::Lt,
        left,
        right,
    } = &cond.expr
    else {
        return None;
    };
    if left.span != node_span(count.call) || right.ty != ResolvedType::Scalar(Scalar::Int) {
        return None;
    }
    let (target, args, slots) = match &left.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    let parent = scan.parent.as_deref()?;
    let predicate = scan.where_pred.as_deref()?;
    let checked_scan = scan.source.as_deref()?;
    let checked_call = scan.collection_call.as_deref()?;
    let [active] = query.dependencies.as_slice() else {
        return None;
    };
    if !matches!(target, IrCallTarget::Builtin {id, ..} if id == "count")
        || slots.is_some_and(|actual| actual != count.slots.as_slice())
        || count.slots.as_slice() != [Some(0)]
        || left.ty != ResolvedType::Scalar(Scalar::Int)
        || domain.span != node_span(query.node)
        || checked_scan.node != query.node
        || checked_scan.domain != query.domain
        || checked_call.node != count.call
        || checked_call.query != query.node
        || !matches!(&scan.domain, IrQueryDomain::Model(model) if model == &query.model_name)
        || scan.where_param != "row"
        || scan.where_async
        || !scan.order.is_empty()
        || scan.value_order.is_some()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.select.is_some()
        || scan.select_param.is_some()
        || scan.contract_collection_call.is_some()
        || parent.span != node_span(receiver)
        || predicate.span != node_span(query.predicate?)
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || !matches!(&predicate.expr, IrExpr::Member {base,field}
            if field == "active" && matches!(&base.expr, IrExpr::Name(name) if name == "row"))
        || !matches!(&right.expr, IrExpr::Member {base,field}
            if field == "seats" && matches!(&base.expr, IrExpr::Name(name) if name == "term"))
        || !matches!(&parent.expr, IrExpr::Name(name) if name == "term")
        || active.model != query.model
        || active.field_name != "active"
        || active.ty != ResolvedType::Scalar(Scalar::Bool)
        || active.role != DependencyRole::Control
        || active.node != query.predicate?
        || checked.returns.is_empty()
        || !checked_void_effect_tail(owner, checked)
        || effects.first().is_none_or(|effect| {
            !matches!(effect, IrStmt::Let {span,..}
            if *span == node_span(first_query.first.as_ref().unwrap().binding))
        })
    {
        return None;
    }
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let parent_id = match &parameter.kind {
        IrItemKind::Param {
            ty:
                IrType::Known(ResolvedType::Record {
                    symbol,
                    stored: true,
                }),
            ..
        } => *symbol,
        _ => return None,
    };
    let schema = checked_first_query_schema(ir, owner, query, db)?;
    if !schema
        .fields
        .iter()
        .any(|field| field.id == active.field && field.name == "active" && field.ty == active.ty)
    {
        return None;
    }
    let influences = receipt_query_influences(query)?;
    let returns = checked
        .returns
        .iter()
        .map(|returned| {
            let selected = returned
                .influences
                .iter()
                .filter(|value| value.query_id.as_deref() == Some(query.id.as_str()))
                .collect::<Vec<_>>();
            if selected.len() != 4
                || selected
                    .iter()
                    .map(|value| value.id.as_str())
                    .ne(query.influences.iter().map(|value| value.id.as_str()))
            {
                return None;
            }
            receipt_return(returned, entry, influences.clone())
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ReceiptDisclosurePlan {
        retained_guarded_handler: None,
        source_loops: None,
        source_emissions: None,
        version: 1,
        event_decision: None,
        term_decision: None,
        leave_request_decision: None,
        leave_decide_decision: None,
        refer_reject_decision: None,
        member_retry_decision: None,
        rent_movement_refund_decision: None,
        invoice_collect_decision: None,
        rent_notice_decision: None,
        invoice_issue_decision: None,
        observe_venue_decision: None,
        success_renewal_decision: None,
        purchase_receive_all: None,
        event_notice_audit: None,
        source: transport_source(&query.source, entry)?,
        queries: vec![ReceiptQuery {
            id: query.id.clone(),
            source: transport_source(&query.source, entry)?,
            model: query.model_name.clone(),
            parent: Some(ReceiptQueryParent {
                source: transport_source(&query.source, entry)?,
                model: ir.items.get(parent_id.0 as usize)?.canonical.clone(),
                origin: ReceiptQueryParentOrigin::AdmittedReference {
                    parameter: parameter.name.clone(),
                },
            }),
            order: Vec::new(),
            limit: None,
            archived: "exclude".into(),
            dependencies: vec![ReceiptQueryDependency {
                id: active.id.clone(),
                source: transport_source(&active.source, entry)?,
                role: ReceiptRole::Control,
                field: "active".into(),
                type_id: active.type_id.clone(),
            }],
        }],
        returns,
    })
}

/// A result-bearing constructor COUNT keeps exactly the original primary
/// CREATE and every ReturnConsumer; auxiliary writes grant no result identity.
fn checked_constructor_model_return(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<()> {
    context.same_scenario(context.ir(), owner)?;
    constructor_model_return_shape(context.ir(), owner, context.db())
}

// Structural source correspondence is also needed by the ordinary CREATE
// matcher. It confers no authority; the publishing caller retains the fresh
// owner join above and the normal per-expression/schema/effect checks.
fn constructor_model_return_shape(ir: &IrProgram, owner: &IrItem, db: &SourceDb) -> Option<()> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = facts.result.as_ref()?
    else {
        return None;
    };
    let mut primary = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|created| created.model == *symbol);
    let original = primary.next()?;
    if primary.next().is_some() || checked_created_model_result(ir, owner) != Some(*symbol) {
        return None;
    }
    created_return_tail_shape(ir, owner, original, db)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let influences = constructor_count_influences(facts)?;
    if checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            returned.model_result
                != Some(DisclosureModelResult::Create {
                    model: *symbol,
                    node: original.node,
                })
                || returned.source != facts.source
                || returned.influences != influences
        })
    {
        return None;
    }
    Some(())
}

/// Seal a constructor COUNT to its original whole owner and one INT field.
/// This is a consumption association, never a read-policy grant.
fn constructor_count_source(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    transport: &ReceiptSource,
) -> Option<serde_json::Value> {
    let ir = context.ir();
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let count = query.count.as_ref()?;
    if !count.parent_edges.is_empty()
        || count.contained_parent.is_none()
        || !query.dependencies.is_empty()
    {
        return None;
    }
    let original = native_count_original(facts, count.statement)?;
    let ScenarioDisclosure::Complete(actual) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let ScenarioDisclosure::Complete(fresh) =
        context.fresh().scenario_disclosures.get(&owner.id)?
    else {
        return None;
    };
    if !super::scenario_feasibility::same_disclosure(actual, fresh) {
        return None;
    }
    if facts.result.is_none() {
        source_owned_void_create(context, owner, original)?;
    } else {
        checked_constructor_model_return(context, owner)?;
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    fn at_stage(
        body: &[IrStmt],
        target: crate::analysis::NodeKey,
        mut stage: usize,
        depth: usize,
    ) -> Option<(&TypedExpr, Span, usize)> {
        if depth >= 64 {
            return None;
        }
        for statement in body {
            if let IrStmt::Create {
                input,
                span,
                when: None,
                ..
            } = statement
                && *span == node_span(target)
            {
                return Some((input, *span, stage));
            }
            match statement {
                IrStmt::Let { .. }
                | IrStmt::Require { .. }
                | IrStmt::Cancel { .. }
                | IrStmt::Send { when: None, .. } => {}
                IrStmt::Set { when: None, .. } | IrStmt::Create { when: None, .. } => stage += 1,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    if native_count_create_input(then_branch, target).is_some() {
                        return at_stage(then_branch, target, stage, depth + 1);
                    }
                    if native_count_create_input(else_branch, target).is_some() {
                        return at_stage(else_branch, target, stage, depth + 1);
                    }
                    return None;
                }
                _ => return None,
            }
            if stage >= 200 {
                return None;
            }
        }
        None
    }
    let (input, span, stage) = at_stage(effects, count.statement, 0, 0)?;
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let parent = &entries.iter().find(|(field, _)| field == "parent")?.1;
    let receiver = count.contained_parent?.0;
    let text = &context.db().get(receiver.file)?.text;
    if parent.ty
        != (ResolvedType::Record {
            symbol: checked_first_query_schema(ir, owner, query, context.db())?.parent?,
            stored: true,
        })
        || text.get(parent.span.start as usize..parent.span.end as usize)?
            != text.get(receiver.start as usize..receiver.end as usize)?
    {
        return None;
    }
    let operand = native_count_operand(input, count.call)?;
    let (field,value)=entries.iter().find(|(_,value)|matches!(&value.expr,IrExpr::Binary{op:IrBinOp::Add,left,..} if left.span==operand.span))?;
    if value.ty != ResolvedType::Scalar(Scalar::Int) {
        return None;
    }
    let source = original.inputs.iter().find(|input| {
        input.name == *field && node_span(input.value_node) == value.span && input.ty == value.ty
    })?;
    let field_item = ir.items.get(source.field?.0 as usize)?;
    if !matches!(
        &field_item.kind,
        IrItemKind::Field {
            ty: IrType::Known(ResolvedType::Scalar(Scalar::Int)),
            ..
        }
    ) {
        return None;
    }
    checked_count_query_parent(ir, owner, query, context.db())?;
    let mut metadata = serde_json::json!({"owner":owner.canonical,"source":transport,"queryId":query.id,
        "stage":stage,"create":{"start":span.start,"end":span.end},"model":original.definition.canonical,"field":field});
    if let Some((created, parameter, created_stage)) =
        checked_created_parent(ir, owner, parent, context.db())
    {
        if created_stage >= stage {
            return None;
        }
        metadata["createdParent"] = serde_json::json!({"stage":created_stage,"model":created.definition.canonical,
            "create":{"start":created.node.start,"end":created.node.end},"parameter":parameter.name});
    }
    Some(metadata)
}

pub(super) fn constructor_counts(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    transport: &ReceiptSource,
) -> Option<serde_json::Value> {
    match &owner.kind {
        IrItemKind::Scenario { result: None, .. } => {}
        IrItemKind::Scenario {
            result: Some(_), ..
        } => {
            checked_constructor_model_return(context, owner)?;
        }
        _ => return None,
    }
    let facts = super::scenario_calls::checked_source(context.ir(), owner, context.db())?;
    let counts: Vec<_> = facts
        .queries
        .as_deref()?
        .iter()
        .filter(|query| query.count.is_some())
        .map(|query| constructor_count_source(context, owner, query, transport))
        .collect::<Option<_>>()?;
    (!counts.is_empty()).then_some(serde_json::Value::Array(counts))
}

pub(super) fn checked_native_count_query_plan(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    db: &SourceDb,
    entry: &str,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<ReceiptDisclosurePlan> {
    if owner.canonical == "member_terms.assign" {
        let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
            return None;
        };
        return checked_native_assign_count_query_plan(ir, owner, checked, query, db, entry);
    }
    let count = query.count.as_ref()?;
    if count.contained_parent.is_none() {
        return checked_native_ancestor_count_query_plan(
            ir,
            owner,
            query,
            db,
            entry,
            source_context,
        );
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let expected_influences = checked_scenario_query_influences(facts)?;
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        effects,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let (input, span) = native_count_create_input(effects, count.statement)?;
    let void_constructor = matches!(&owner.kind, IrItemKind::Scenario { result: None, .. });
    let returned_constructor = !void_constructor && constructor_count_queries(facts).is_some();
    if returned_constructor {
        constructor_count_source(
            source_context?,
            owner,
            query,
            &transport_source(&query.source, entry)?,
        )?;
    }
    let returned = if void_constructor {
        constructor_count_source(
            source_context?,
            owner,
            query,
            &transport_source(&query.source, entry)?,
        )?;
        node_span(facts.node)
    } else {
        let IrStmt::Return { span, .. } = effects.last()? else {
            return None;
        };
        *span
    };
    let original = native_count_original(facts, count.statement)?;
    if !void_constructor && !returned_constructor && facts.creates.as_deref()?.len() == 2 {
        native_count_pair_proofs(
            ir,
            owner,
            db,
            checked,
            effects,
            facts.creates.as_deref()?,
            source_context,
        )?;
    }
    let operand = native_count_operand(input, count.call)?;
    native_count_result_matches(
        ir,
        query,
        checked,
        facts,
        original,
        operand,
        span,
        returned,
        &expected_influences,
        count.call,
        db,
        void_constructor,
    )?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let parent_id = checked_first_query_schema(ir, owner, query, db)?.parent?;
    let influences = receipt_query_influences(query)?;
    native_count_plan(ir, query, checked, entry, parameter, parent_id, influences)
}

fn first_query_binding_spelling_matches(
    keyword: &SyntaxNode,
    source_binding: &SyntaxNode,
    text: &str,
    name: &str,
    binding: &str,
) -> bool {
    keyword
        .token()
        .is_some_and(|token| token.text(text) == "let")
        && source_binding
            .token()
            .is_some_and(|token| token.text(text) == name)
        && binding == name
}

fn first_query_expression_typed(
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    value: &TypedExpr,
) -> bool {
    facts.expression_types.as_deref().is_some_and(|types| {
        types.iter().any(|(node, ty)| {
            node_span(*node) == value.span
                && ty == &value.ty
                && (node.kind == SyntaxKind::Path as u8 || node.kind == SyntaxKind::NameRef as u8)
        })
    })
}

pub(super) fn checked_first_query_row<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    checked_native_query_influences(queries)
        .or_else(|| checked_mixed_helper_query_influences(facts))?;
    let mut selected = queries.iter().filter(|query| query.first.is_some());
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let first = query.first.as_ref()?;
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    let original = facts.creates.as_deref()?.first()?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let mut bindings = effects.iter().filter_map(|effect| match effect {
        IrStmt::Let {
            name: binding,
            value,
            span,
        } if *span == node_span(first.binding) => Some((binding, value)),
        _ => None,
    });
    let (binding, selected) = bindings.next()?;
    let authored = checked_effect_node(ir, owner, first.binding, db)?;
    let names: Vec<_> = authored
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .collect();
    let [keyword, source_binding] = names.as_slice() else {
        return None;
    };
    let text = &db.get(first.binding.file)?.text;
    if bindings.next().is_some()
        || !first_query_binding_spelling_matches(keyword, source_binding, text, name, binding)
        || first.binding.end > value.span.start
        || !first_query_expression_typed(facts, value)
    {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: query.model,
            stored: true,
        },
        name,
        value.span,
        db,
    )?;
    super::scenario_create_sources::checked_create_expression(
        ir, original, selected, first.call, db,
    )?;
    checked_first_query_schema(ir, owner, query, db)
}

/// Exact selected original first call; ordinary Query expressions stay outside
/// the native scalar visitor. The source operand matcher checks its CST too.
fn first_query_id_order_matches(
    original: &crate::analysis::scenario_disclosure::DisclosureQueryOrder,
    actual: &super::ir::IrOrder,
) -> bool {
    original.field.is_none()
        && original.field_name == "id"
        && !original.descending
        && actual.field == original.field_name
        && actual.descending == original.descending
}

pub(super) fn checked_first_query_order(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
) -> Option<()> {
    let source = scan.source.as_deref()?;
    if scan.value_order.is_some() {
        return None;
    }
    match (
        query.order.as_slice(),
        scan.order.as_slice(),
        source.clauses.as_slice(),
    ) {
        ([], [], [_, _]) => Some(()),
        ([], [], [archived, _, _])
            if matches!(
                archived.kind,
                crate::analysis::types::CheckedQueryClauseKind::Archived
            ) =>
        {
            Some(())
        }
        // Order-only first (no where predicate): the recorded id-order
        // and the scanned id-order re-verify exactly as in the where
        // arms; the vacuous predicate needs no clause join.
        ([original], [actual], [_, clause])
            if first_query_id_order_matches(original, actual)
                && clause.kind == crate::analysis::types::CheckedQueryClauseKind::Order
                && clause.expressions.as_slice() == [original.node] =>
        {
            Some(())
        }
        ([original], [actual], [archived, _, clause])
            if first_query_id_order_matches(original, actual)
                && matches!(
                    archived.kind,
                    crate::analysis::types::CheckedQueryClauseKind::Archived
                )
                && clause.kind == crate::analysis::types::CheckedQueryClauseKind::Order
                && clause.expressions.as_slice() == [original.node] =>
        {
            Some(())
        }
        ([original], [actual], [_, _, clause])
            if first_query_id_order_matches(original, actual)
                && clause.kind == crate::analysis::types::CheckedQueryClauseKind::Order
                && clause.expressions.as_slice() == [original.node] =>
        {
            Some(())
        }
        ([original], [actual], [archived, _, _, clause])
            if first_query_id_order_matches(original, actual)
                && matches!(
                    archived.kind,
                    crate::analysis::types::CheckedQueryClauseKind::Archived
                )
                && clause.kind == crate::analysis::types::CheckedQueryClauseKind::Order
                && clause.expressions.as_slice() == [original.node] =>
        {
            Some(())
        }
        _ => None,
    }
}

/// One original optional required-user getter consumed by a CREATE coalesce
/// with actor. Its source FIRST binding owns the genuine selected row; no
/// nullable row is promoted or read on the absent branch.
fn checked_first_optional_actor_member<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(binding) = &base.expr else {
        return None;
    };
    let ResolvedType::Nullable(inner) = &base.ty else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = inner.as_ref()
    else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let mut matching = facts.queries.as_deref()?.iter().filter(|query| {
        query.model == *model
            && query.first.as_ref().is_some_and(|first| {
                first.reference_predicate.is_some()
                    && effects.iter().any(|statement| {
                        matches!(statement,IrStmt::Let{name,span,..}
                if name==binding && *span==node_span(first.binding))
                    })
            })
    });
    let query = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    let first = query.first.as_ref()?;
    let initializer = effects.iter().find_map(|statement| match statement {
        IrStmt::Let { value, span, .. } if *span == node_span(first.binding) => Some(value),
        _ => None,
    })?;
    let selected = checked_owner_first_query_ir(ir, owner, initializer, first.call, db);
    selected?;
    let schema = checked_first_query_schema(ir, owner, query, db)?;
    let mut fields = schema
        .fields
        .iter()
        .filter(|original| original.name == *field);
    let original = fields.next()?;
    if fields.next().is_some()
        || original.ty != ResolvedType::Scalar(Scalar::User)
        || value.ty != ResolvedType::Nullable(Box::new(original.ty.clone()))
        || !facts
            .expression_types
            .as_deref()?
            .iter()
            .any(|(node, ty)| node_span(*node) == base.span && *ty == base.ty)
    {
        return None;
    }

    let receiver = reference_receiver_matches(ir, owner, value, base, field, db);
    receiver?;
    let mut consumers = Vec::new();
    for create in facts.creates.as_deref()? {
        let input = effects.iter().find_map(|statement| match statement {
            IrStmt::Create { input, span, .. } if *span == node_span(create.node) => Some(input),
            _ => None,
        });
        let Some(TypedExpr {
            expr: IrExpr::Object(entries),
            ..
        }) = input
        else {
            continue;
        };
        for (name, expression) in entries {
            let IrExpr::Binary {
                op: IrBinOp::Coalesce,
                left,
                right,
            } = &expression.expr
            else {
                continue;
            };
            if left.span != value.span {
                continue;
            }
            if expression.ty != original.ty
                || left.ty != value.ty
                || !matches!(&left.expr,IrExpr::Member{base:receiver,field:name} if name==field
                    && receiver.span==base.span && receiver.ty==base.ty
                    && matches!(&receiver.expr,IrExpr::Name(name) if name==binding))
                || right.ty != original.ty
                || predicate_actor_user(right).is_none()
                || !create.inputs.iter().any(|input| {
                    input.name == *name
                        && input.ty == original.ty
                        && node_span(input.value_node) == expression.span
                })
            {
                return None;
            }

            let input = create.inputs.iter().find(|input| input.name == *name)?;
            let source = checked_effect_node(ir, owner, input.value_node, db)?;
            let text = &db.get(input.value_node.file)?.text;
            let parts = source
                .children
                .iter()
                .filter(|node| matches!(node.kind, SyntaxKind::Member | SyntaxKind::NameRef))
                .collect::<Vec<_>>();

            let [source_member, actor] = parts.as_slice() else {
                return None;
            };
            let receiver = source_member
                .children
                .iter()
                .find(|node| node.kind == SyntaxKind::NameRef)?;
            let member_name = source_member
                .children
                .iter()
                .rev()
                .find(|node| node.kind == SyntaxKind::Name)?;
            if source.kind != SyntaxKind::Binary
                || source.span != expression.span
                || source_member.kind != SyntaxKind::Member
                || source_member.span != value.span
                || actor.kind != SyntaxKind::NameRef
                || actor.span != right.span
                || text
                    .get(actor.span.start as usize..actor.span.end as usize)
                    .map(str::trim)
                    != Some("actor")
                || receiver.span != base.span
                || text
                    .get(receiver.span.start as usize..receiver.span.end as usize)
                    .map(str::trim)
                    != Some(binding)
                || member_name.token()?.text(text) != field
                || !source
                    .children
                    .iter()
                    .any(|node| node.token().is_some_and(|token| token.text(text) == "??"))
                || !source_member
                    .children
                    .iter()
                    .any(|node| node.token().is_some_and(|token| token.text(text) == "?."))
            {
                return None;
            }
            consumers.push(expression);
        }
    }
    if consumers.len() != 1 {
        return None;
    }
    match_stored_contract_field(ir, original, db)?;
    Some(original)
}

fn checked_first_optional_actor_expression(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Binary {
        op: IrBinOp::Coalesce,
        left,
        right,
    } = &value.expr
    else {
        return None;
    };
    let field = checked_first_optional_actor_member(ir, owner, left, db)?;
    (value.ty == field.ty && right.ty == field.ty && predicate_actor_user(right).is_some())
        .then_some(())
}

fn predicate_dependency_types(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
) -> Option<()> {
    for dependency in query.dependencies.iter() {
        let type_ok = match &dependency.ty {
            ResolvedType::Scalar(scalar) => {
                matches!(
                    scalar,
                    Scalar::Bool
                        | Scalar::Int
                        | Scalar::Decimal
                        | Scalar::Text
                        | Scalar::Money
                        | Scalar::Date
                        | Scalar::Datetime
                        | Scalar::Duration
                        | Scalar::Currency
                        | Scalar::User
                ) && dependency.type_id == scalar.as_str()
            }
            ResolvedType::Enum { cases, .. } if !cases.is_empty() => {
                dependency.type_id == format!("enum({})", cases.join(","))
            }
            _ => false,
        };
        if !type_ok
            || dependency.role != DependencyRole::Control
            || dependency.source != query.source
            || dependency.model != query.model
            || dependency.model_name != query.model_name
            || !dependency.calls.is_empty()
        {
            return None;
        }
    }
    Some(())
}

fn flatten_predicate_conjuncts<'x>(
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &'x super::ir::IrQuery,
) -> Option<(Vec<&'x TypedExpr>, Vec<crate::analysis::NodeKey>)> {
    let predicate = scan.where_pred.as_deref()?;
    let conjuncts = predicate_conjuncts(predicate, false, None)?;
    if conjuncts.is_empty() || conjuncts.len() != query.dependencies.len() {
        return None;
    }
    let mut operand_nodes = vec![first.operand];
    operand_nodes.extend_from_slice(&first.extra_operands);
    if operand_nodes.len() != conjuncts.len() {
        return None;
    }
    let original_predicate = node_span(query.predicate?);
    if predicate.span.file != original_predicate.file
        || predicate.span.start < original_predicate.start
        || predicate.span.end > original_predicate.end
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    Some((conjuncts, operand_nodes))
}

fn predicate_actor_user(right: &TypedExpr) -> Option<()> {
    let IrExpr::Member { base, field } = &right.expr else {
        return None;
    };
    (field == "actor"
        && matches!(&base.expr, IrExpr::Name(name) if name == "c")
        && base.ty == ResolvedType::Unknown
        && base.span == right.span)
        .then_some(())
}

fn predicate_actor_text(
    ir: &IrProgram,
    owner: &IrItem,
    right: &TypedExpr,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> Option<()> {
    let IrExpr::Member {
        base,
        field: event_field,
    } = &right.expr
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol,
        stored: false,
    } = &base.ty
    else {
        return None;
    };
    let event = ir.items.get(symbol.0 as usize)?;
    let IrItemKind::Event { fields } = &event.kind else {
        return None;
    };
    let IrItemKind::Scenario { event_source, .. } = &owner.kind else {
        return None;
    };
    let super::ir::IrEventSource::Declared(canonical) = event_source.as_ref()? else {
        return None;
    };
    (event.canonical == *canonical
        && matches!(&base.expr, IrExpr::Name(name) if name == "event")
        && fields.iter().any(|field| {
            ir.items.get(field.0 as usize).is_some_and(|item| {
                item.name == *event_field
                    && matches!(&item.kind, IrItemKind::Field { ty: IrType::Known(ty), .. } if ty == &dependency.ty)
            })
        }))
    .then_some(())
}

fn predicate_actor_operand(
    ir: &IrProgram,
    owner: &IrItem,
    scalar: &Scalar,
    right: &TypedExpr,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> Option<()> {
    match scalar {
        Scalar::User => predicate_actor_user(right),
        Scalar::Text => predicate_actor_text(ir, owner, right, dependency),
        _ => None,
    }
}

fn predicate_operand<'d>(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scalar: Option<&Scalar>,
    right: &TypedExpr,
    index: usize,
    dependency: &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    operand_nodes: &[crate::analysis::NodeKey],
    param_conjuncts: &mut Vec<(
        usize,
        &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
    member_conjuncts: &mut Vec<(
        usize,
        &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
) -> Option<()> {
    match &right.expr {
        IrExpr::Member { .. }
            if query
                .inputs
                .iter()
                .any(|(node, _)| *node == operand_nodes[index]) =>
        {
            member_conjuncts.push((index, dependency));
            Some(())
        }
        IrExpr::Member { .. } => {
            if query
                .inputs
                .iter()
                .any(|(node, _)| *node == operand_nodes[index])
            {
                return None;
            }
            let scalar = scalar?;
            predicate_actor_operand(ir, owner, scalar, right, dependency)
        }
        IrExpr::Name(_) => {
            param_conjuncts.push((index, dependency));
            Some(())
        }
        IrExpr::Text(case) => {
            let ResolvedType::Enum { cases, .. } = &dependency.ty else {
                return None;
            };
            let authored = first
                .operand_texts
                .get(index)
                .and_then(|text| text.as_deref());
            if !cases.contains(case)
                || query
                    .inputs
                    .iter()
                    .any(|(node, _)| *node == operand_nodes[index])
                || authored != Some(case.as_str())
            {
                return None;
            }
            Some(())
        }
        _ => None,
    }
}

fn predicate_conjunct<'d>(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    index: usize,
    conjunct: &TypedExpr,
    operand_nodes: &[crate::analysis::NodeKey],
    unmatched: &mut Vec<&'d crate::analysis::scenario_disclosure::DisclosureDependency>,
    param_conjuncts: &mut Vec<(
        usize,
        &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
    member_conjuncts: &mut Vec<(
        usize,
        &'d crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
) -> Option<()> {
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left,
        right,
    } = &conjunct.expr
    else {
        return None;
    };
    let IrExpr::Member { base, field } = &left.expr else {
        return None;
    };
    let position = unmatched
        .iter()
        .position(|dependency| &dependency.field_name == field)?;
    let dependency = unmatched.remove(position);
    let scalar = match &dependency.ty {
        ResolvedType::Scalar(scalar) => Some(scalar),
        ResolvedType::Enum { .. } => None,
        _ => return None,
    };
    if left.span != node_span(dependency.node)
        || left.ty != dependency.ty
        || right.span != node_span(operand_nodes[index])
        || right.ty != dependency.ty
        || !matches!(&base.expr, IrExpr::Name(name) if name == &scan.where_param)
        || base.ty
            != (ResolvedType::Record {
                symbol: query.model,
                stored: true,
            })
    {
        return None;
    }
    predicate_operand(
        ir,
        owner,
        query,
        scalar,
        right,
        index,
        dependency,
        operand_nodes,
        param_conjuncts,
        member_conjuncts,
        first,
    )
}

fn predicate_param_cover(
    ir: &IrProgram,
    owner: &IrItem,
    _query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    params: &[crate::analysis::SymbolId],
    conjunct_index: usize,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
    conjuncts: &[&TypedExpr],
    parameter: &crate::analysis::SymbolId,
) -> Option<()> {
    let IrExpr::Binary { right, .. } = &conjuncts[conjunct_index].expr else {
        return None;
    };
    let actual = ir.items.get(parameter.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &actual.kind
    else {
        return None;
    };
    let original = facts.parameters.get(*index)?;
    if !(params.get(*index) == Some(parameter)
        && *parameter_owner == owner.id
        && actual.id == *parameter
        && actual.module == owner.module
        && actual.canonical == format!("{}.{}", owner.canonical, actual.name)
        && original.parameter == *parameter
        && original.default.is_none()
        && original.ty == dependency.ty
        && *ty == dependency.ty
        && matches!(&right.expr, IrExpr::Name(name) if name == &actual.name))
    {
        return None;
    }
    Some(())
}

fn member_cover_invalid(
    params: &[crate::analysis::SymbolId],
    index: usize,
    parameter: &crate::analysis::SymbolId,
    parameter_owner: &crate::analysis::SymbolId,
    owner: &IrItem,
    actual: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    ty: &ResolvedType,
    base: &TypedExpr,
    sealed_receiver: Option<crate::analysis::NodeKey>,
) -> bool {
    !(params.get(index) == Some(parameter)
        && *parameter_owner == owner.id
        && actual.id == *parameter
        && actual.module == owner.module
        && actual.canonical == format!("{}.{}", owner.canonical, actual.name)
        && original.parameter == *parameter
        && original.default.is_none()
        && original.ty == *ty
        && base.ty == *ty
        && sealed_receiver.is_some_and(|receiver| base.span == node_span(receiver))
        && matches!(&base.expr, IrExpr::Name(name) if name == &actual.name))
}

fn predicate_member_cover(
    ir: &IrProgram,
    owner: &IrItem,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    params: &[crate::analysis::SymbolId],
    conjunct_index: usize,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
    conjuncts: &[&TypedExpr],
    parameter: &crate::analysis::SymbolId,
) -> Option<()> {
    let IrExpr::Binary { right, .. } = &conjuncts[conjunct_index].expr else {
        return None;
    };
    let IrExpr::Member { base, field } = &right.expr else {
        return None;
    };
    let actual = ir.items.get(parameter.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &actual.kind
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: record,
        stored: true,
    } = ty
    else {
        return None;
    };
    let field_item = ir.items.iter().any(|item| {
        item.name == *field
            && matches!(&item.kind, IrItemKind::Field { owner, ty: IrType::Known(field_ty), .. } if owner == record && field_ty == &dependency.ty)
    });
    let original = facts.parameters.get(*index)?;
    let expected_member = format!("{}.{}", actual.name, field);
    let sealed_path = first
        .operand_texts
        .get(conjunct_index)
        .is_some_and(|sealed| sealed.as_deref() == Some(expected_member.as_str()));
    let sealed_receiver = first
        .operand_receivers
        .get(conjunct_index)
        .copied()
        .flatten();
    if !sealed_path
        || !field_item
        || member_cover_invalid(
            params,
            *index,
            parameter,
            parameter_owner,
            owner,
            actual,
            original,
            ty,
            base,
            sealed_receiver,
        )
    {
        return None;
    }
    Some(())
}

fn predicate_input_cover(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    params: &[crate::analysis::SymbolId],
    conjuncts: &[&TypedExpr],
    operand_nodes: &[crate::analysis::NodeKey],
    param_conjuncts: &mut Vec<(
        usize,
        &crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
    member_conjuncts: &mut Vec<(
        usize,
        &crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
    entry_operand: &crate::analysis::NodeKey,
    parameter: &crate::analysis::SymbolId,
) -> Option<()> {
    if let Some(position) = param_conjuncts
        .iter()
        .position(|(index, _)| operand_nodes[*index] == *entry_operand)
    {
        let (index, dependency) = param_conjuncts.remove(position);
        return predicate_param_cover(
            ir, owner, query, facts, params, index, dependency, conjuncts, parameter,
        );
    }
    let position = member_conjuncts
        .iter()
        .position(|(index, _)| operand_nodes[*index] == *entry_operand)?;
    let (conjunct_index, dependency) = member_conjuncts.remove(position);
    predicate_member_cover(
        ir,
        owner,
        first,
        facts,
        params,
        conjunct_index,
        dependency,
        conjuncts,
        parameter,
    )
}

fn checked_first_reference_predicate_ir(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
) -> Option<()> {
    let first = query.first.as_ref()?;
    let original = first.reference_predicate.as_ref()?;
    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let clauses = predicate_conjuncts(scan.where_pred.as_deref()?, false, Some(8))?;
    let [identity, reference, presence] = clauses.as_slice() else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: row,
        right: identity_operand,
    } = &identity.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: reference_member,
        right: reference_operand,
    } = &reference.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Ne,
        left: guard_operand,
        right: null_operand,
    } = &presence.expr
    else {
        return None;
    };
    let identity_parameter = ir.items.get(original.identity_parameter.0 as usize)?;
    let reference_parameter = ir.items.get(original.reference_parameter.0 as usize)?;
    let identity_field = ir.items.get(original.identity_field.0 as usize)?;
    let reference_field = ir.items.get(original.reference_field.0 as usize)?;
    let IrItemKind::Param {
        owner: identity_owner,
        index: identity_index,
        ty: IrType::Known(identity_ty),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &identity_parameter.kind
    else {
        return None;
    };
    let IrItemKind::Param {
        owner: reference_owner,
        index: reference_index,
        ty: IrType::Known(reference_ty),
        default,
        default_node,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &reference_parameter.kind
    else {
        return None;
    };
    let identity_fact = facts.parameters.get(*identity_index)?;
    let reference_fact = facts.parameters.get(*reference_index)?;
    let nullable_model = ResolvedType::Nullable(Box::new(ResolvedType::Record {
        symbol: query.model,
        stored: true,
    }));
    let ResolvedType::Record {
        symbol: identity_model,
        stored: true,
    } = identity_ty
    else {
        return None;
    };
    let ResolvedType::Nullable(inner) = reference_ty else {
        return None;
    };
    let ResolvedType::Record {
        symbol: target,
        stored: true,
    } = inner.as_ref()
    else {
        return None;
    };
    let target_model = ir.items.get(target.0 as usize)?;
    let IrItemKind::Field {
        owner: identity_field_owner,
        ty: IrType::Known(identity_field_ty),
        ..
    } = &identity_field.kind
    else {
        return None;
    };
    let IrItemKind::Field {
        owner: reference_field_owner,
        ty: IrType::Known(reference_field_ty),
        ..
    } = &reference_field.kind
    else {
        return None;
    };
    let default_ok = match (default, default_node, reference_fact.default) {
        (None, None, None) => true,
        (Some(IrDefault::Literal(value)), Some(node), Some(source)) => {
            *node == source
                && value.span == node_span(source)
                && value.ty == ResolvedType::Null
                && matches!(value.expr, IrExpr::Null)
        }
        _ => false,
    };
    let [dependency] = query.dependencies.as_slice() else {
        return None;
    };
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    // Model queries normalize their alias to row unless a genuine outer
    // row input is captured. Keep the original source alias in that case.
    let expected_alias = if original.identity_parameter_name == "row"
        || original.reference_parameter_name == "row"
    {
        original.alias_name.as_str()
    } else {
        "row"
    };
    if !default_ok
        || !matches!(target_model.kind, IrItemKind::Model { .. })
        || target_model.id != *target
        || scan.where_param != expected_alias
        || identity_parameter.name != original.identity_parameter_name
        || reference_parameter.name != original.reference_parameter_name
        || identity_field.name != original.identity_field_name
        || reference_field.name != original.reference_field_name
        || *identity_owner != owner.id
        || *reference_owner != owner.id
        || params.get(*identity_index) != Some(&identity_parameter.id)
        || params.get(*reference_index) != Some(&reference_parameter.id)
        || identity_fact.parameter != identity_parameter.id
        || reference_fact.parameter != reference_parameter.id
        || identity_fact.ty != *identity_ty
        || reference_fact.ty != *reference_ty
        || identity_fact.default.is_some()
        || identity_fact.constraints.is_some()
        || reference_fact.constraints.is_some()
        || identity_parameter.module != owner.module
        || reference_parameter.module != owner.module
        || identity_parameter.canonical
            != format!("{}.{}", owner.canonical, identity_parameter.name)
        || reference_parameter.canonical
            != format!("{}.{}", owner.canonical, reference_parameter.name)
        || *identity_field_owner != *identity_model
        || *identity_field_ty != nullable_model
        || *reference_field_owner != query.model
        || reference_field_ty != reference_ty
        || clauses
            .iter()
            .any(|node| node.ty != ResolvedType::Scalar(Scalar::Bool))
        || row.span != node_span(original.identity_row)
        || row.ty != record
        || !matches!(&row.expr,IrExpr::Name(name) if name==&scan.where_param)
        || identity_operand.span != node_span(original.identity_operand)
        || identity_operand.ty != nullable_model
        || !matches!(&identity_operand.expr,IrExpr::Member{base,field} if field==&identity_field.name
            && base.span==node_span(original.identity_receiver) && base.ty==*identity_ty
            && matches!(&base.expr,IrExpr::Name(name) if name==&identity_parameter.name))
        || reference_member.span != node_span(original.reference_member)
        || reference_member.ty != *reference_ty
        || !matches!(&reference_member.expr,IrExpr::Member{base,field} if field==&reference_field.name
            && base.ty==record && matches!(&base.expr,IrExpr::Name(name) if name==&scan.where_param))
        || reference_operand.span != node_span(original.reference_operand)
        || reference_operand.ty != *reference_ty
        || guard_operand.span != node_span(original.guard_operand)
        || guard_operand.ty != *reference_ty
        || !matches!(&reference_operand.expr,IrExpr::Name(name) if name==&reference_parameter.name)
        || !matches!(&guard_operand.expr,IrExpr::Name(name) if name==&reference_parameter.name)
        || null_operand.span != node_span(original.null_operand)
        || null_operand.ty != ResolvedType::Null
        || !matches!(null_operand.expr, IrExpr::Null)
        || dependency.node != original.reference_member
        || dependency.field != original.reference_field
        || dependency.field_name != original.reference_field_name
        || dependency.query_id.is_some()
        || dependency.model != query.model
        || dependency.model_name != query.model_name
        || dependency.ty != *reference_ty
        || dependency.type_id != reference_operand_type_id(ir, reference_ty)?
        || dependency.role != DependencyRole::Control
        || dependency.source != query.source
        || !dependency.calls.is_empty()
        || query.inputs
            != vec![
                (original.identity_operand, original.identity_parameter),
                (original.reference_operand, original.reference_parameter),
            ]
        || first.operand != original.reference_operand
        || !first.extra_operands.is_empty()
        || first.operand_texts != vec![None]
        || first.operand_receivers != vec![None]
    {
        return None;
    }
    Some(())
}

/// Check the actual alias-bound field and original equality operand. Parameter
/// identity comes from its owning declaration; actor remains its context value.
pub(super) fn checked_first_query_predicate(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &super::ir::IrQuery,
) -> Option<()> {
    let first = query.first.as_ref()?;
    if first.reference_predicate.is_some() {
        return checked_first_reference_predicate_ir(ir, owner, query, scan);
    }
    predicate_dependency_types(query)?;
    // Order-only first (no where predicate): no conjuncts, no
    // dependencies, no transported inputs. Vacuous truth — the authored
    // order re-verifies in checked_first_query_order. Anything recorded
    // refuses, keeping the admission fail-closed.
    if scan.where_pred.is_none() {
        return (query.dependencies.is_empty()
            && query.inputs.is_empty()
            && query.predicate.is_none())
        .then_some(());
    }
    // Flatten an `and` chain order-preserving; a lone `==` is one conjunct.
    let (conjuncts, operand_nodes) = flatten_predicate_conjuncts(first, query, scan)?;
    // Pair each conjunct with its field dependency; duplicate fields pair
    // in order. The field cross-check keeps the pairing honest.
    let mut unmatched: Vec<_> = query.dependencies.iter().collect();
    // Per-conjunct member/operand correspondence; operand classes resolve
    // below. Param-class conjuncts record their index for input cover, as
    // do transported member-read conjuncts for member cover.
    let mut param_conjuncts = Vec::new();
    let mut member_conjuncts = Vec::new();
    for (index, conjunct) in conjuncts.iter().enumerate() {
        predicate_conjunct(
            ir,
            owner,
            query,
            scan,
            first,
            index,
            conjunct,
            &operand_nodes,
            &mut unmatched,
            &mut param_conjuncts,
            &mut member_conjuncts,
        )?;
    }
    // Transported inputs cover exactly the param-class and member-class
    // conjuncts: each entry verifies against one recorded operand, and
    // every recorded conjunct of either class is covered exactly once.
    let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    for (entry_operand, parameter) in query.inputs.iter() {
        predicate_input_cover(
            ir,
            owner,
            query,
            first,
            facts,
            params,
            &conjuncts,
            &operand_nodes,
            &mut param_conjuncts,
            &mut member_conjuncts,
            entry_operand,
            parameter,
        )?;
    }
    if !param_conjuncts.is_empty() || !member_conjuncts.is_empty() {
        return None;
    }
    Some(())
}

pub(super) fn checked_first_query_ir<'a>(
    ir: &'a IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let mut owners = ir.items.iter().filter(|owner| {
        matches!(owner.kind, IrItemKind::Scenario { .. })
            && ir
                .scenario_disclosures
                .get(&owner.id)
                .and_then(|value| value.source_facts())
                .is_some_and(|facts| {
                    facts.source == original.source
                        && facts.creates.as_deref().is_some_and(|creates| {
                            creates.iter().any(|created| created.node == original.node)
                        })
                })
    });
    let owner = owners.next()?;
    if owners.next().is_some() {
        return None;
    }
    checked_owner_first_query_ir(ir, owner, actual, node, db)
}

fn select_owner_first_query<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::DisclosureQuery,
    &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
)> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let queries = facts.queries.as_deref()?;
    let mut selected = queries
        .iter()
        .filter(|query| query.first.as_ref().is_some_and(|first| first.call == node));
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    // Source authentication of this initializer is independent of whether
    // the complete mixed inventory has a native execution profile.
    checked_query_influence_census(query)?;
    Some((query, facts))
}

fn first_query_call_shape(actual: &TypedExpr) -> Option<(&str, &TypedExpr, &IrQuery)> {
    let IrExpr::Call {
        target: IrCallTarget::Builtin { id, awaited: false },
        args,
    } = &actual.expr
    else {
        return None;
    };
    let [domain] = args.as_slice() else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    Some((id, domain, scan))
}

fn first_query_clauses<'x>(
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &IrQuery,
    source: &'x crate::analysis::types::CheckedQuery,
) -> Option<&'x [crate::analysis::types::CheckedQueryClause]> {
    let clauses = source.clauses.as_slice();
    Some(match clauses {
        [archived, rest @ ..]
            if matches!(
                archived.kind,
                crate::analysis::types::CheckedQueryClauseKind::Archived
            ) =>
        {
            if !query.archived
                || !super::scenario_queries::archived_first_matches(query.archived, &scan.archived)
            {
                return None;
            }
            rest
        }
        _ if query.archived => return None,
        _ => clauses,
    })
}

fn first_query_parent_match(
    ir: &IrProgram,
    owner: &IrItem,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    scan: &IrQuery,
    db: &SourceDb,
    receiver: crate::analysis::NodeKey,
) -> Option<bool> {
    let (parameter, parent_id) = checked_first_query_parent(ir, owner, query, scan, db)?;
    let expected = ResolvedType::Record {
        symbol: parent_id,
        stored: true,
    };
    let parent = scan.parent.as_deref()?;
    Some(
        parent.span == node_span(receiver)
            && parent.ty == expected
            && match &parent.expr {
                IrExpr::Name(name) => name == &parameter.name,
                IrExpr::Member { base, field } => {
                    field == "parent"
                        && matches!(&base.expr, IrExpr::Name(name) if name == &parameter.name)
                }
                _ => false,
            },
    )
}

fn owner_first_query_call_mismatch(
    id: &str,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    node: crate::analysis::NodeKey,
    actual: &TypedExpr,
    record: &ResolvedType,
    array: &ResolvedType,
    domain_ty: &ResolvedType,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    scan: &IrQuery,
) -> bool {
    id != "first"
        || first.call != node
        || actual.span != node_span(node)
        || actual.ty != ResolvedType::Nullable(Box::new(record.clone()))
        || *domain_ty != *array
        || query.source != facts.source
        || query.count.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || !super::scenario_queries::archived_first_matches(query.archived, &scan.archived)
}

fn owner_first_query_source_mismatch(
    source: &crate::analysis::types::CheckedQuery,
    collection: &crate::analysis::types::CheckedCollectionCall,
    array: &ResolvedType,
    first: &crate::analysis::scenario_disclosure::DisclosureFirstQuery,
    query: &crate::analysis::scenario_disclosure::DisclosureQuery,
    source_alias: crate::analysis::NodeKey,
) -> bool {
    source.node != query.node
        || source.domain != query.domain
        || source.domain_type != *array
        || source.result != *array
        || source.projection.is_some()
        || collection.node != first.call
        || collection.builtin != "first"
        || collection.overload != first.overload
        || collection.query != query.node
        || collection.alias != source_alias
        || collection.model != query.model
        || collection.predicate.is_some()
}

fn owner_first_query_tail_mismatch(
    alias: &crate::analysis::types::CheckedQueryClause,
    predicate: &crate::analysis::types::CheckedQueryClause,
    source_alias: crate::analysis::NodeKey,
    source_predicate: Option<crate::analysis::NodeKey>,
    scan: &IrQuery,
    query_model_name: &str,
    first_parent: bool,
) -> bool {
    alias.node != source_alias
        || !matches!(&alias.kind, crate::analysis::types::CheckedQueryClauseKind::As { name } if !name.is_empty())
        || !alias.expressions.is_empty()
        || match source_predicate {
            Some(source_predicate) => {
                predicate.kind != crate::analysis::types::CheckedQueryClauseKind::Where
                    || predicate.expressions.as_slice() != [source_predicate]
            }
            // Order-only first: the second clause is the authored order,
            // whose correspondence re-verified in checked_first_query_order.
            None => predicate.kind != crate::analysis::types::CheckedQueryClauseKind::Order,
        }
        || !matches!(&scan.domain, super::ir::IrQueryDomain::Model(model) if model == query_model_name)
        || !first_parent
        || scan.where_async
        || scan.select.is_some()
        || scan.select_param.is_some()
        || scan.limit.is_some()
        || scan.contract_collection_call.is_some()
}

fn checked_owner_first_query_ir<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureQuery> {
    let (query, facts) = select_owner_first_query(ir, owner, node, db)?;
    let first = query.first.as_ref()?;
    let source_alias = query.alias?;
    let source_predicate = query.predicate;
    let (id, domain, scan) = first_query_call_shape(actual)?;
    let source = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    // A leading Archived clause pairs only with a disclosed include: the
    // valueless include drops from IR, so any other combination refuses.
    let clauses = first_query_clauses(query, scan, source)?;
    let [alias, predicate, ..] = clauses else {
        return None;
    };
    checked_first_query_order(query, scan)?;
    checked_first_query_predicate(ir, owner, query, scan)?;
    // A contained domain pairs the IR parent value with the admitted
    // receiver; unscoped scans keep no parent. Any other combination
    // refuses, keeping the owner-first join fail-closed.
    let first_parent = match first.contained_parent {
        None => scan.parent.is_none(),
        Some((receiver, _)) => first_query_parent_match(ir, owner, query, scan, db, receiver)?,
    };
    if owner_first_query_call_mismatch(
        id, first, node, actual, &record, &array, &domain.ty, query, facts, scan,
    ) || owner_first_query_source_mismatch(
        source,
        collection,
        &array,
        first,
        query,
        source_alias,
    ) || owner_first_query_tail_mismatch(
        alias,
        predicate,
        source_alias,
        source_predicate,
        scan,
        &query.model_name,
        first_parent,
    ) {
        return None;
    }
    checked_first_query_schema(ir, owner, query, db)?;
    Some(query)
}

pub(super) fn transport_source(
    source: &DisclosureSource,
    entry_module: &str,
) -> Option<ReceiptSource> {
    if source.path.is_empty()
        || source.sha256.len() != 64
        || !source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    Some(ReceiptSource {
        path: source.path.clone(),
        sha256: source.sha256.clone(),
        module: entry_module.to_string(),
    })
}

fn node_span(node: crate::analysis::NodeKey) -> Span {
    Span::new(node.file, node.start, node.end)
}

fn direct_field_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn native_result_type(ty: &ResolvedType) -> bool {
    let base = match ty {
        ResolvedType::Nullable(inner) => inner.as_ref(),
        ty => ty,
    };
    let primitive = |ty: &ResolvedType| {
        matches!(
            ty,
            ResolvedType::Scalar(
                Scalar::Int
                    | Scalar::Text
                    | Scalar::Bool
                    | Scalar::Decimal
                    | Scalar::Money
                    | Scalar::Date
                    | Scalar::Datetime
                    | Scalar::Duration
                    | Scalar::Currency
                    | Scalar::User
            )
        )
    };
    primitive(base)
        || matches!(base, ResolvedType::Enum { cases, .. } if !cases.is_empty())
        || matches!(base, ResolvedType::Array { element, .. } if primitive(element))
}

/// Exact first State scalar profile; nominal aliases never become text here.
/// Email is a supported dependency transport identity alongside the other
/// disclosed string-like scalars: the checked `email` type_id round-trips
/// through the native receipt and the Values wire codec, which native
/// dispatch (row 10) needs for record email inputs such as a mail recipient.
/// Any other unlisted scalar still fails closed here.
pub(super) fn supported_type_id(type_id: &str) -> bool {
    let base = type_id.strip_suffix('?').unwrap_or(type_id);
    let base = base.strip_suffix("[]").unwrap_or(base);
    matches!(
        base,
        "int"
            | "text"
            | "email"
            | "timezone"
            | "bool"
            | "decimal"
            | "money"
            | "date"
            | "datetime"
            | "duration"
            | "currency"
            | "user"
    ) || base
        .strip_prefix("enum(")
        .and_then(|body| body.strip_suffix(')'))
        .is_some_and(|body| {
            !body.is_empty()
                && body.split(',').all(direct_field_name)
                && body.split(',').collect::<HashSet<_>>().len() == body.split(',').count()
        })
}

fn inventory_type(field: &JsModelField) -> Option<String> {
    if field.array_required == Some(true) {
        return None;
    }
    // Use the identical valueType-first contract as State's binder. The
    // alternate primitive tag never rescues an unsupported nominal claim.
    if let Some(type_id) = &field.value_type {
        return supported_type_id(type_id).then(|| type_id.clone());
    }
    let base = match &field.field {
        JsModelFieldType::String => "text".to_string(),
        JsModelFieldType::Integer => "int".to_string(),
        JsModelFieldType::Boolean => "bool".to_string(),
        JsModelFieldType::Decimal => "decimal".to_string(),
        JsModelFieldType::Money => "money".to_string(),
        JsModelFieldType::Date => "date".to_string(),
        JsModelFieldType::Datetime => "datetime".to_string(),
        JsModelFieldType::Duration => "duration".to_string(),
        JsModelFieldType::User => "user".to_string(),
        JsModelFieldType::Enum { values } => format!("enum({})", values.join(",")),
        _ => return None,
    };
    let type_id = format!(
        "{base}{}{}",
        if field.array_required.is_some() {
            "[]"
        } else {
            ""
        },
        if field.nullable { "?" } else { "" }
    );
    supported_type_id(&type_id).then_some(type_id)
}

fn images_parameters(
    ir: &IrProgram,
    owner: &IrItem,
    params: &[crate::analysis::SymbolId],
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    nodes: &HashMap<crate::analysis::NodeKey, &SyntaxNode>,
    text: &str,
    names: &mut HashMap<String, ResolvedType>,
) -> Option<()> {
    for (position, (id, fact)) in params.iter().zip(&source.parameters).enumerate() {
        let parameter = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: parent,
            index,
            ty: IrType::Known(ty),
            array_bounds: None,
            default: None,
            default_node: None,
            default_copy_source: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let declaration = nodes.get(&fact.node)?;
        let name = declaration
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Name)?;
        if declaration.kind != SyntaxKind::Parameter
            || parameter.id != fact.parameter
            || *parent != owner.id
            || *index != position
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || parameter.span != name.span
            || name.token()?.text(text) != parameter.name
            || ty != &fact.ty
            || fact.default.is_some()
            || names.insert(parameter.name.clone(), ty.clone()).is_some()
        {
            return None;
        }
    }
    Some(())
}

fn images_let_statement(
    matcher: &ImagesSourceExpressions<'_>,
    name: &String,
    value: &TypedExpr,
    original: &SyntaxNode,
    text: &str,
) -> Option<()> {
    let mut bindings = original
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Name);
    if bindings.next()?.token()?.text(text) != "let"
        || bindings.next()?.token()?.text(text) != name
        || bindings.next().is_some()
    {
        return None;
    }
    let values = images_source_values(original);
    let [authored_value] = values.as_slice() else {
        return None;
    };
    matcher.expression(value, authored_value, 0)?;
    Some(())
}

fn images_send_head(
    matcher: &ImagesSourceExpressions<'_>,
    args: &TypedExpr,
    _operation: &String,
    binding: &String,
    span: &Span,
    original: &SyntaxNode,
    text: &str,
) -> Option<()> {
    let parts: Vec<_> = original
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Name)
        .collect();
    let [send, as_word, authored_binding] = parts.as_slice() else {
        return None;
    };
    if send.token()?.text(text) != "send"
        || as_word.token()?.text(text) != "as"
        || authored_binding.token()?.text(text) != binding
        || args.span != *span
        || args.ty != ResolvedType::Unknown
    {
        return None;
    }
    let mut objects = original
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Object);
    matcher.entries(args, objects.next()?, 0)?;
    if objects.next().is_some() {
        return None;
    }
    Some(())
}

fn images_send_delivery(
    census: &[(crate::analysis::NodeKey, ResolvedType)],
    nodes: &HashMap<crate::analysis::NodeKey, &SyntaxNode>,
    text: &str,
    operation: &String,
    binding: &str,
    names: &mut HashMap<String, ResolvedType>,
) -> Option<()> {
    let mut bindings = census.iter().filter(|(key, _)| {
        nodes.get(key).is_some_and(|node| {
            node.kind == SyntaxKind::NameRef && images_source_name(node, text) == Some(binding)
        })
    });
    let (_, delivery) = bindings.next()?;
    let ResolvedType::StdDelivery { capability, op } = delivery else {
        return None;
    };
    if *capability != "std.ImagesV1"
        || op.name != "submit"
        || *operation != format!("{capability}.{}", op.name)
        || bindings.any(|(_, ty)| ty != delivery)
        || names.insert(binding.to_owned(), delivery.clone()).is_some()
    {
        return None;
    }
    Some(())
}

fn images_set_statement(
    matcher: &ImagesSourceExpressions<'_>,
    record: &TypedExpr,
    changes: &TypedExpr,
    span: &Span,
    original: &SyntaxNode,
) -> Option<()> {
    let mut paths = original
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Path);
    matcher.expression(record, paths.next()?, 0)?;
    let mut objects = original
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Object);
    matcher.entries(changes, objects.next()?, 0)?;
    if paths.next().is_some()
        || objects.next().is_some()
        || changes.span != *span
        || changes.ty != ResolvedType::Unknown
    {
        return None;
    }
    Some(())
}

fn collect_images_nodes<'x>(
    tree: &'x SyntaxNode,
    nodes: &mut HashMap<crate::analysis::NodeKey, &'x SyntaxNode>,
) -> Option<()> {
    let mut pending = vec![tree];
    while let Some(node) = pending.pop() {
        if nodes.len() >= 200000
            || nodes
                .insert(crate::analysis::NodeKey::of(node), node)
                .is_some()
        {
            return None;
        }
        pending.extend(node.children.iter());
    }
    Some(())
}

fn images_authored_valid(authored: &SyntaxNode, has_guards: bool) -> bool {
    authored.kind == SyntaxKind::Scenario
        && !has_guards
        && !authored
            .children
            .iter()
            .any(|part| part.kind == SyntaxKind::Require)
}

fn images_by_matches(authored: &SyntaxNode, by: &[IrGuard], text: &str) -> Option<()> {
    match (crate::analysis::attribute_value(authored, "by", text), by) {
        (Some(node), [IrGuard::Role(role)])
            if node.kind == SyntaxKind::NameRef
                && matches!(
                    role.as_str(),
                    "members" | "owner" | "authenticated" | "public"
                )
                && images_source_name(node, text)? == role =>
        {
            Some(())
        }
        (None, []) => Some(()),
        _ => None,
    }
}

fn images_type_census<'x>(
    census: &'x [(crate::analysis::NodeKey, ResolvedType)],
    nodes: &HashMap<crate::analysis::NodeKey, &SyntaxNode>,
) -> Option<HashMap<crate::analysis::NodeKey, &'x ResolvedType>> {
    if census.len() > 16384 {
        return None;
    }
    let mut types = HashMap::new();
    for (node, ty) in census {
        if !nodes.contains_key(node) || types.insert(*node, ty).is_some() {
            return None;
        }
    }
    Some(types)
}

fn images_effect_statements<'x>(
    authored: &'x SyntaxNode,
    effects: &[IrStmt],
) -> Option<Vec<&'x SyntaxNode>> {
    let mut blocks = authored
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::DoBlock);
    let block = blocks.next()?;
    let statements: Vec<_> = block
        .children
        .iter()
        .filter(|part| {
            !matches!(
                part.kind,
                SyntaxKind::Trivia | SyntaxKind::Comment | SyntaxKind::Name | SyntaxKind::Punct
            )
        })
        .collect();
    if blocks.next().is_some()
        || statements.is_empty()
        || statements.len() > 200
        || statements.len() != effects.len()
    {
        return None;
    }
    Some(statements)
}

fn images_effects(
    effects: &[IrStmt],
    statements: Vec<&SyntaxNode>,
    text: &str,
    types: &HashMap<crate::analysis::NodeKey, &ResolvedType>,
    names: &mut HashMap<String, ResolvedType>,
    census: &[(crate::analysis::NodeKey, ResolvedType)],
    nodes: &HashMap<crate::analysis::NodeKey, &SyntaxNode>,
) -> Option<()> {
    for (actual, original) in effects.iter().zip(statements) {
        let matcher = ImagesSourceExpressions { text, types, names };
        match (actual, original.kind) {
            (IrStmt::Let { name, value, span }, SyntaxKind::Let) if *span == original.span => {
                images_let_statement(&matcher, name, value, original, text)?;
                if names.insert(name.clone(), value.ty.clone()).is_some() {
                    return None;
                }
            }
            (
                IrStmt::Send {
                    args,
                    operation,
                    binding: Some(binding),
                    when: None,
                    span,
                    ..
                },
                SyntaxKind::Send,
            ) if *span == original.span => {
                images_send_head(&matcher, args, operation, binding, span, original, text)?;
                images_send_delivery(census, nodes, text, operation, binding, names)?;
            }
            (
                IrStmt::Set {
                    record,
                    changes,
                    when: None,
                    span,
                },
                SyntaxKind::Set,
            ) if *span == original.span => {
                images_set_statement(&matcher, record, changes, span, original)?;
            }
            (IrStmt::Require { cond, span }, SyntaxKind::Require) if *span == original.span => {
                let values = images_source_values(original);
                let [value] = values.as_slice() else {
                    return None;
                };
                if cond.ty != ResolvedType::Scalar(Scalar::Bool) {
                    return None;
                }
                matcher.expression(cond, value, 0)?;
            }
            _ => return None,
        }
    }
    Some(())
}

fn checked_images_source(ir: &IrProgram, owner: &IrItem, db: &SourceDb) -> Option<()> {
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        by,
        guards,
        effects,
        result: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let file = db.get(source.node.file)?;
    let (tree, diagnostics) = crate::syntax::parse_source(source.node.file, &file.text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut nodes = HashMap::new();
    collect_images_nodes(&tree, &mut nodes)?;
    let authored = nodes.get(&source.node)?;
    if !images_authored_valid(authored, !guards.is_empty()) {
        return None;
    }
    images_by_matches(authored, by, &file.text)?;
    let census = source.expression_types.as_deref()?;
    let types = images_type_census(census, &nodes)?;
    let mut names = HashMap::new();
    images_parameters(ir, owner, params, source, &nodes, &file.text, &mut names)?;
    let statements = images_effect_statements(authored, effects)?;
    images_effects(
        effects, statements, &file.text, &types, &mut names, census, &nodes,
    )
}

struct ImagesSourceExpressions<'a> {
    text: &'a str,
    types: &'a HashMap<crate::analysis::NodeKey, &'a ResolvedType>,
    names: &'a HashMap<String, ResolvedType>,
}

impl ImagesSourceExpressions<'_> {
    fn match_leaf(&self, actual: &TypedExpr, original: &crate::syntax::SyntaxNode) -> Option<bool> {
        let _leaf = |kind| original.children.iter().find(|part| part.kind == kind);
        Some(match (&actual.expr, original.kind) {
            (IrExpr::Name(name), SyntaxKind::Name | SyntaxKind::NameRef | SyntaxKind::Path) => {
                images_source_name(original, self.text)? == name
                    && self.names.get(name) == Some(&actual.ty)
            }
            (
                IrExpr::Text(_)
                | IrExpr::Int(_)
                | IrExpr::Decimal(_)
                | IrExpr::Bool(_)
                | IrExpr::Null,
                SyntaxKind::Literal,
            ) => self.match_scalar(actual, original)?,
            (IrExpr::DurationMs(value), SyntaxKind::Literal) => {
                self.match_duration(actual, original, value)?
            }
            _ => false,
        })
    }

    fn match_text(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        value: &str,
    ) -> Option<bool> {
        let string = original
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::String)?;
        Some(
            actual.ty == ResolvedType::Scalar(Scalar::Text)
                && string.token()?.string_value.as_ref()? == value,
        )
    }

    fn match_int(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        value: &i128,
    ) -> Option<bool> {
        let integer = original
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Integer)?;
        Some(
            actual.ty == ResolvedType::Scalar(Scalar::Int)
                && integer.token()?.text(self.text).parse::<i128>().ok()? == *value,
        )
    }

    fn match_scalar(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
    ) -> Option<bool> {
        let leaf = |kind| original.children.iter().find(|part| part.kind == kind);
        Some(match (&actual.expr, original.kind) {
            (IrExpr::Text(value), SyntaxKind::Literal) => {
                self.match_text(actual, original, value)?
            }
            (IrExpr::Int(value), SyntaxKind::Literal) => self.match_int(actual, original, value)?,
            (IrExpr::Decimal(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Decimal)
                    && leaf(SyntaxKind::Decimal)?.token()?.text(self.text) == value
            }
            (IrExpr::Bool(value), SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Scalar(Scalar::Bool)
                    && leaf(SyntaxKind::Name)?.token()?.text(self.text)
                        == if *value { "true" } else { "false" }
            }
            (IrExpr::Null, SyntaxKind::Literal) => {
                actual.ty == ResolvedType::Null
                    && leaf(SyntaxKind::Name)?.token()?.text(self.text) == "null"
            }
            _ => return None,
        })
    }

    fn match_duration(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        value: &i128,
    ) -> Option<bool> {
        let spelling = original
            .children
            .iter()
            .find(|part| part.kind == SyntaxKind::Duration)?
            .token()?
            .text(self.text);
        let mut duration = None;
        for (unit, factor) in [
            ("ms", 1i128),
            ("s", 1000),
            ("m", 60000),
            ("h", 3600000),
            ("d", 86400000),
        ] {
            if let Some(digits) = spelling.strip_suffix(unit).filter(|digits| {
                !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
            }) {
                duration = digits.parse::<i128>().ok()?.checked_mul(factor);
                break;
            }
        }
        Some(actual.ty == ResolvedType::Scalar(Scalar::Duration) && duration == Some(*value))
    }

    fn match_member(
        &self,
        base: &TypedExpr,
        field: &str,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<bool> {
        let parts: Vec<_> = original
            .children
            .iter()
            .filter(|part| part.kind != SyntaxKind::Trivia)
            .collect();
        let [receiver, dot, member] = parts.as_slice() else {
            return None;
        };
        if dot.token()?.text(self.text) != "."
            || member.kind != SyntaxKind::Name
            || member.token()?.text(self.text) != field
        {
            return None;
        }
        self.expression(base, receiver, depth + 1)?;
        Some(true)
    }

    fn match_construct(
        &self,
        entries: &[(String, TypedExpr)],
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<bool> {
        let name = crate::analysis::types::checked_standard_nominal_name(&actual.ty)?;
        if !matches!(
            name,
            "WorkflowInput" | "WorkflowDefinition" | "ImageRequest"
        ) {
            return None;
        }
        let values = images_source_values(original);
        let [target, object] = values.as_slice() else {
            return None;
        };
        let ResolvedType::StdNominal { fields, .. } = &actual.ty else {
            return None;
        };
        if target.kind != SyntaxKind::NameRef
            || images_source_name(target, self.text)? != name
            || object.kind != SyntaxKind::Object
            || fields.len() != entries.len()
            || entries.iter().any(|(name, value)| {
                fields
                    .iter()
                    .find(|(field, _)| field == name)
                    .is_none_or(|(_, ty)| ty != &value.ty)
            })
        {
            return None;
        }
        self.entries(actual, object, depth + 1)?;
        Some(true)
    }

    fn expression(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<()> {
        use crate::analysis::NodeKey;
        if depth > 64
            || actual.span != original.span
            || self.types.get(&NodeKey::of(original)).copied()? != &actual.ty
            || matches!(actual.ty, ResolvedType::Unknown | ResolvedType::Error)
        {
            return None;
        }
        let mut original = original;
        for _ in depth..=64 {
            if original.kind != SyntaxKind::Group {
                break;
            }
            let values = images_source_values(original);
            let [value] = values.as_slice() else {
                return None;
            };
            if self.types.get(&NodeKey::of(value)).copied()? != &actual.ty {
                return None;
            }
            original = value;
        }
        let matched = match (&actual.expr, original.kind) {
            (IrExpr::Member { base, field }, SyntaxKind::Member) => {
                self.match_member(base, field, original, depth)?
            }
            (IrExpr::Object(entries), SyntaxKind::Construct) => {
                self.match_construct(entries, actual, original, depth)?
            }
            (IrExpr::Object(_), SyntaxKind::Object) => {
                if !matches!(actual.ty, ResolvedType::Object(_)) {
                    return None;
                }
                self.entries(actual, original, depth + 1)?;
                true
            }
            _ => self.match_leaf(actual, original)?,
        };
        matched.then_some(())
    }

    fn entries(
        &self,
        actual: &TypedExpr,
        original: &crate::syntax::SyntaxNode,
        depth: usize,
    ) -> Option<()> {
        let IrExpr::Object(entries) = &actual.expr else {
            return None;
        };
        let authored: Vec<_> = original
            .children
            .iter()
            .filter(|part| part.kind == SyntaxKind::ObjectEntry)
            .collect();
        if depth > 64
            || original.kind != SyntaxKind::Object
            || entries.len() > 200
            || entries.len() != authored.len()
        {
            return None;
        }
        let mut seen = HashSet::new();
        for ((name, value), entry) in entries.iter().zip(authored) {
            let key = entry
                .children
                .iter()
                .find(|part| part.kind == SyntaxKind::Name)?;
            if key.token()?.text(self.text) != name || !seen.insert(name) {
                return None;
            }
            let values = images_source_values(entry);
            match values.as_slice() {
                [] => self.expression(value, key, depth + 1)?,
                [original] => self.expression(value, original, depth + 1)?,
                _ => return None,
            }
        }
        Some(())
    }
}

fn images_source_name<'a>(node: &crate::syntax::SyntaxNode, text: &'a str) -> Option<&'a str> {
    if node.kind == SyntaxKind::Name {
        return Some(node.token()?.text(text));
    }
    if !matches!(node.kind, SyntaxKind::NameRef | SyntaxKind::Path) {
        return None;
    }
    let mut parts = node
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia);
    let name = parts.next()?;
    (name.kind == SyntaxKind::Name && parts.next().is_none())
        .then(|| name.token().map(|token| token.text(text)))
        .flatten()
}

fn images_source_values(node: &crate::syntax::SyntaxNode) -> Vec<&crate::syntax::SyntaxNode> {
    node.children
        .iter()
        .filter(|part| {
            matches!(
                part.kind,
                SyntaxKind::Literal
                    | SyntaxKind::NameRef
                    | SyntaxKind::Group
                    | SyntaxKind::Array
                    | SyntaxKind::Object
                    | SyntaxKind::Construct
                    | SyntaxKind::Member
                    | SyntaxKind::Call
                    | SyntaxKind::Unary
                    | SyntaxKind::Binary
                    | SyntaxKind::Query
                    | SyntaxKind::Path
                    | SyntaxKind::MessageValue
            )
        })
        .collect()
}

/// Resolve an original required Contract parameter path. Only declaration-owned
/// Contract fields extend the slot; stored Model fields remain observed reads.
fn contract_parameter_name_mismatch(
    ambiguous: bool,
    actual_owner: &crate::analysis::SymbolId,
    owner: &IrItem,
    params: &[crate::analysis::SymbolId],
    index: usize,
    parameter: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    ty: &ResolvedType,
    value_ty: &ResolvedType,
    name: &str,
    contract: &IrItem,
) -> bool {
    ambiguous
        || *actual_owner != owner.id
        || params.get(index) != Some(&parameter.id)
        || fact.parameter != parameter.id
        || fact.ty != *ty
        || *value_ty != *ty
        || fact.default.is_some()
        || fact.constraints.is_some()
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, name)
        || !matches!(contract.kind, IrItemKind::Contract { .. })
}

fn contract_parameter_source_proven(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    parameter: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    symbol: crate::analysis::SymbolId,
    name: &str,
) -> Option<()> {
    let text = &db.get(value.span.file)?.text;
    if text
        .get(value.span.start as usize..value.span.end as usize)?
        .trim()
        != name
    {
        return None;
    }
    let declaration = checked_effect_node(ir, owner, fact.node, db)?;
    let named = declaration
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let named_type = declaration
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::NamedType)?;
    let path = named_type
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    if named.span != parameter.span
        || named.token()?.text(text) != name
        || crate::analysis::NodeKey::of(named_type) != fact.type_node
    {
        return None;
    }
    super::scenario_create_sources::reference_name(
        ir,
        owner,
        symbol,
        direct_source_path_name(path, text)?,
        db,
    )?;
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| !schema.model && schema.id == symbol)?;
    match_stored_contract_schema(ir, schema, db)
}

fn contract_parameter_source_name(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: Option<&SourceDb>,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    params: &[crate::analysis::SymbolId],
    name: &str,
) -> Option<(crate::analysis::SymbolId, String)> {
    let mut parameters = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|param| param.name == name);
    let parameter = parameters.next()?;
    let IrItemKind::Param {
        owner: actual_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        default_copy_source: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let fact = facts.parameters.get(*index)?;
    let ResolvedType::Record { symbol, .. } = ty else {
        return None;
    };
    let contract = ir.items.get(symbol.0 as usize)?;
    let ambiguous = parameters.next().is_some();
    if contract_parameter_name_mismatch(
        ambiguous,
        actual_owner,
        owner,
        params,
        *index,
        parameter,
        fact,
        ty,
        &value.ty,
        name,
        contract,
    ) {
        return None;
    }
    if let Some(db) = db {
        contract_parameter_source_proven(
            ir, owner, value, db, facts, parameter, fact, *symbol, name,
        )?;
    }
    Some((parameter.id, name.to_string()))
}

fn contract_parameter_member_mismatch(
    duplicate: bool,
    field_owner: &crate::analysis::SymbolId,
    symbol: crate::analysis::SymbolId,
    ty: &ResolvedType,
    value_ty: &ResolvedType,
    field: &str,
) -> bool {
    duplicate
        || *field_owner != symbol
        || *ty != *value_ty
        || !matches!(ty, ResolvedType::Scalar(_) | ResolvedType::Record { .. })
        || !direct_field_name(field)
}

fn contract_parameter_member_proven(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    base_span: Span,
    field: &str,
    symbol: crate::analysis::SymbolId,
    declared_id: crate::analysis::SymbolId,
) -> Option<()> {
    let mut typed = facts
        .expression_types
        .as_deref()?
        .iter()
        .filter(|(node, _)| node_span(*node) == value.span);
    if !typed.any(|(_, ty)| ty == &value.ty) {
        return None;
    }
    let node = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: value.span.file,
            start: value.span.start,
            end: value.span.end,
            kind: SyntaxKind::Member as u8,
        },
        db,
    )?;
    let name = node
        .children
        .iter()
        .rev()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let mut receiver = node.children.iter().find(|node| {
        matches!(
            node.kind,
            SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group
        )
    })?;
    while receiver.kind == SyntaxKind::Group {
        receiver = receiver.children.iter().find(|node| {
            matches!(
                node.kind,
                SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group
            )
        })?;
    }
    if receiver.span != base_span || name.token()?.text(&db.get(value.span.file)?.text) != field {
        return None;
    }
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| !schema.model && schema.id == symbol)?;
    let original = schema
        .fields
        .iter()
        .find(|field| field.id == declared_id && field.ty == value.ty)?;
    match_stored_contract_schema(ir, schema, db)?;
    match_stored_contract_field(ir, original, db)
}

fn contract_parameter_source_member(
    parameter: crate::analysis::SymbolId,
    mut path: String,
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: Option<&SourceDb>,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    base: &TypedExpr,
    field: &str,
) -> Option<(crate::analysis::SymbolId, String)> {
    let ResolvedType::Record { symbol, .. } = base.ty else {
        return None;
    };
    let declaration = ir.items.get(symbol.0 as usize)?;
    let IrItemKind::Contract { fields, .. } = &declaration.kind else {
        return None;
    };
    let mut candidates = fields
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| item.name == field);
    let declared = candidates.next()?;
    let IrItemKind::Field {
        owner: field_owner,
        ty: IrType::Known(ty),
        default: None,
        server: None,
        required_array: false,
        ..
    } = &declared.kind
    else {
        return None;
    };
    let duplicate = candidates.next().is_some();
    if contract_parameter_member_mismatch(duplicate, field_owner, symbol, ty, &value.ty, field) {
        return None;
    }
    if let Some(db) = db {
        contract_parameter_member_proven(
            ir,
            owner,
            value,
            db,
            facts,
            base.span,
            field,
            symbol,
            declared.id,
        )?;
    }
    path.push('/');
    path.push_str(field);
    Some((parameter, path))
}

pub(super) fn checked_contract_parameter_source_path(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: Option<&SourceDb>,
) -> Option<(crate::analysis::SymbolId, String)> {
    fn contract_parameter_source_visit(
        ir: &IrProgram,
        owner: &IrItem,
        value: &TypedExpr,
        db: Option<&SourceDb>,
        depth: usize,
    ) -> Option<(crate::analysis::SymbolId, String)> {
        if depth >= 16 {
            return None;
        }
        let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
        let IrItemKind::Scenario {
            params,
            read: false,
            ..
        } = &owner.kind
        else {
            return None;
        };
        match &value.expr {
            IrExpr::Name(name) => {
                contract_parameter_source_name(ir, owner, value, db, facts, params, name)
            }
            IrExpr::Member { base, field } => {
                let (parameter, path) =
                    contract_parameter_source_visit(ir, owner, base, db, depth + 1)?;
                contract_parameter_source_member(
                    parameter, path, ir, owner, value, db, facts, base, field,
                )
            }
            _ => None,
        }
    }
    contract_parameter_source_visit(ir, owner, value, db, 0)
}

fn checked_contract_parameter_path(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: Option<&SourceDb>,
) -> Option<(crate::analysis::SymbolId, String)> {
    let result = checked_contract_parameter_source_path(ir, owner, value, db)?;
    result.1.contains('/').then_some(result)
}

fn checked_contract_parameter_row<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    checked_contract_parameter_path(ir, owner, value, Some(db))?;
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = value.ty
    else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let schema = schemas.next()?;
    if schemas.next().is_some() || schema.fields.iter().any(|field| field.name == "id") {
        return None;
    }
    match_stored_contract_fields(ir, schema, db)?;
    let expected = super::js::Emitter::source_models(ir, db)?;
    let mut generated = expected
        .iter()
        .filter(|model| model.name == schema.canonical);
    let mut actual = models.iter().filter(|model| model.name == schema.canonical);
    if serde_json::to_value(generated.next()?).ok()? != serde_json::to_value(actual.next()?).ok()?
        || generated.next().is_some()
        || actual.next().is_some()
    {
        return None;
    }
    Some(schema)
}

/// A field read after its original top-level create consumes that new row,
/// even when a same-model FIRST also supplies the earlier replay branch.
fn checked_created_row_operand(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    model: crate::analysis::SymbolId,
    db: &SourceDb,
    sealed_purchase: bool,
    sealed_created_tail: bool,
) -> Option<()> {
    let IrExpr::Name(binding) = &value.expr else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut creates = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|created| created.model == model && created.binding == *binding);
    let created = creates.next()?;
    if creates.next().is_some()
        || created.source != facts.source
        || created.node.file != value.span.file
        || created.node.end > value.span.start
    {
        return None;
    }
    let IrItemKind::Scenario {
        effects, params, ..
    } = &owner.kind
    else {
        return None;
    };
    if params.iter().any(|id| {
        ir.items
            .get(id.0 as usize)
            .is_none_or(|parameter| parameter.name == *binding)
    }) {
        return None;
    }
    let position = effects.iter().position(|statement| {
        matches!(statement,
        IrStmt::Create { binding: Some(name), span, .. }
            if name == binding && *span == node_span(created.node))
    })?;
    if sealed_created_tail {
        let mut pending = effects.iter().skip(position + 1).collect::<Vec<_>>();
        let mut steps = 0;
        let mut containing = None;
        while let Some(statement) = pending.pop() {
            steps += 1;
            if steps > 16384 {
                return None;
            }
            let span = match statement {
                IrStmt::Let { name, .. } if name == binding => return None,
                IrStmt::Create {
                    binding: Some(name),
                    ..
                }
                | IrStmt::Send {
                    binding: Some(name),
                    ..
                } if name == binding => return None,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    span,
                    ..
                } => {
                    pending.extend(then_branch);
                    pending.extend(else_branch);
                    *span
                }
                // A later loop cannot replace this earlier constructor operand.
                // Its own source/effect proof still owns every loop execution.
                IrStmt::For { span, .. }
                    if span.file == value.span.file && span.start > value.span.end =>
                {
                    *span
                }
                IrStmt::Require { span, .. }
                | IrStmt::Create { span, .. }
                | IrStmt::Send { span, .. }
                | IrStmt::Set { span, .. }
                | IrStmt::Emit { span, .. }
                | IrStmt::Schedule { span, .. }
                | IrStmt::Return { span, .. }
                | IrStmt::Let { span, .. } => *span,
                _ => return None,
            };
            if span.file == value.span.file
                && span.start <= value.span.start
                && value.span.end <= span.end
            {
                containing = Some(span);
            }
        }
        return created_record_name_matches(
            value,
            &ResolvedType::Record {
                symbol: model,
                stored: true,
            },
            binding,
            containing?,
            db,
        );
    }
    // No rebinding/control scope may replace this straight-line create handle.
    for statement in effects.iter().skip(position + 1) {
        let span = match statement {
            IrStmt::Require { span, .. }
            | IrStmt::Set { span, .. }
            | IrStmt::Return { span, .. } => *span,
            IrStmt::Send {
                binding: send,
                span,
                ..
            } if send.as_ref() != Some(binding) => *span,
            IrStmt::If { then_branch, .. } if sealed_purchase => {
                let Some(IrStmt::Send { span, .. }) = then_branch.first() else {
                    return None;
                };
                if span.file != value.span.file
                    || span.start > value.span.start
                    || value.span.end > span.end
                {
                    return None;
                }
                *span
            }
            _ => return None,
        };
        if span.file == value.span.file
            && span.start <= value.span.start
            && value.span.end <= span.end
        {
            return created_record_name_matches(
                value,
                &ResolvedType::Record {
                    symbol: model,
                    stored: true,
                },
                binding,
                span,
                db,
            );
        }
    }
    None
}

/// Observe the original required reference field of the genuine new row.
/// The complete owner seal preserves its authored consumer and evaluation order.
fn checked_sealed_created_reference<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    sealed: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    if !sealed || !matches!(value.ty, ResolvedType::Record { stored: true, .. }) {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = base.ty
    else {
        return None;
    };
    checked_created_row_operand(ir, owner, base, model, db, false, true)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == model)?;
    match_stored_contract_schema(ir, schema, db)?;
    reference_receiver_matches(ir, owner, value, base, field, db)?;
    reference_member_field(ir, owner, value, schema, field, db)
}

/// A reserved identity read remains attached to its one actual created row
/// inside the independently sealed complete original owner tail.
fn checked_sealed_created_row_id<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    sealed: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    if !sealed || value.ty != ResolvedType::Scalar(Scalar::Text) {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = base.ty
    else {
        return None;
    };
    if field != "id" {
        return None;
    }
    checked_created_row_operand(ir, owner, base, model, db, false, true)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == model)?;
    if schema.fields.iter().any(|field| field.name == "id") {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    Some(schema)
}

/// A source/IR-sealed created tail may read the reserved identity of its
/// genuine optional Model input at an original checked non-null occurrence.
fn checked_sealed_narrowed_parameter_id<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
    sealed: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    if !sealed || value.ty != ResolvedType::Scalar(Scalar::Text) {
        return None;
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol: model,
        stored: true,
    } = base.ty
    else {
        return None;
    };
    if field != "id" {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let mut parameters = params
        .iter()
        .enumerate()
        .filter_map(|(index, id)| Some((index, ir.items.get(id.0 as usize)?)))
        .filter(|(_, parameter)| parameter.name == *name);
    let (position, parameter) = parameters.next()?;
    if parameters.next().is_some() {
        return None;
    }
    let fact = facts.parameters.get(position)?;
    let IrItemKind::Param {
        owner: declared,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default,
        default_node,
        default_copy_source: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let expected = ResolvedType::Nullable(Box::new(base.ty.clone()));
    if *declared != owner.id
        || *index != position
        || fact.parameter != parameter.id
        || fact.ty != expected
        || *ty != expected
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, name)
        || !facts
            .expression_types
            .as_deref()?
            .iter()
            .any(|(node, ty)| node_span(*node) == base.span && *ty == base.ty)
        || !(default.is_none() && fact.default.is_none() && default_node.is_none()
            || matches!(default,Some(IrDefault::Literal(value)) if matches!(value.expr,IrExpr::Null) && value.ty==ResolvedType::Null && default_node.is_some_and(|node|Some(node)==fact.default && value.span==node_span(node))))
        || !reference_read_matches(ir, owner, value, model, model, "text")
    {
        return None;
    }
    parameter_row_receiver(
        ir,
        owner,
        value,
        false,
        base.span,
        &db.get(facts.node.file)?.text,
        db,
    )?;
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == model)?;
    if schema.fields.iter().any(|field| field.name == "id") {
        return None;
    }
    match_stored_contract_fields(ir, schema, db)?;
    let expected = super::js::Emitter::source_models(ir, db)?;
    let original = expected
        .iter()
        .find(|descriptor| descriptor.name == schema.canonical)?;
    let actual = models
        .iter()
        .find(|descriptor| descriptor.name == schema.canonical)?;
    if serde_json::to_value(original).ok()? != serde_json::to_value(actual).ok()? {
        return None;
    }
    Some(schema)
}

/// Reserved row IDs belong to the original required model parameter. They
/// are receipt dependencies, not authored fields or reconstructed references.
fn parameter_row_base(value: &TypedExpr) -> Option<&TypedExpr> {
    match &value.expr {
        IrExpr::Member { base, field }
            if field == "id"
                && value.ty == ResolvedType::Scalar(Scalar::Text)
                && matches!(base.expr, IrExpr::Member { .. }) =>
        {
            Some(base)
        }
        IrExpr::Member { .. } if matches!(value.ty, ResolvedType::Record { stored: true, .. }) => {
            Some(value)
        }
        _ => None,
    }
}

fn nested_parameter_row<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    nested: &TypedExpr,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    if let Some(schema) = checked_contract_parameter_row(ir, owner, nested, models, db) {
        return Some(schema);
    }
    if value.ty == ResolvedType::Scalar(Scalar::Text)
        && let Some((_, parent)) = checked_parent_reference(ir, owner, nested, db)
    {
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        if field != "id"
            || !std::ptr::eq(base.as_ref(), nested)
            || nested.ty
                != (ResolvedType::Record {
                    symbol: parent.id,
                    stored: true,
                })
            || parent.fields.iter().any(|field| field.name == "id")
            || !reference_read_matches(ir, owner, value, parent.id, parent.id, "text")
        {
            return None;
        }
        reference_receiver_matches(ir, owner, value, nested, "id", db)?;
        let expected = super::js::Emitter::source_models(ir, db)?;
        let original = expected
            .iter()
            .find(|model| model.name == parent.canonical)?;
        let actual = models.iter().find(|model| model.name == parent.canonical)?;
        if serde_json::to_value(original).ok()? != serde_json::to_value(actual).ok()? {
            return None;
        }
        return Some(parent);
    }
    if value.ty == ResolvedType::Scalar(Scalar::Text) {
        let field = stored_reference_operand(ir, owner, nested, db)?;
        let ResolvedType::Record {
            symbol,
            stored: true,
        } = field.ty
        else {
            return None;
        };
        let facts = super::scenario_calls::checked_source(ir, owner, db)?;
        let target = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.model && schema.id == symbol)?;
        match_stored_contract_schema(ir, target, db)?;
        if !reference_read_matches(ir, owner, value, target.id, target.id, "text") {
            return None;
        }
        return Some(target);
    }
    None
}

/// The original required Model input shared by row identity/results, File
/// arrays and paired scalar reads. This joins the unique named executable
/// slot to its checked declaration; receiver bytes and read authority remain
/// with each consumer rather than becoming properties of this lookup.
struct RequiredModelParameter<'a> {
    parameter: &'a IrItem,
    fact: &'a crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    model: crate::analysis::SymbolId,
}

impl<'a> RequiredModelParameter<'a> {
    fn checked(
        ir: &'a IrProgram,
        owner: &IrItem,
        params: &[crate::analysis::SymbolId],
        source: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
        name: &str,
    ) -> Option<Self> {
        let mut parameters = params
            .iter()
            .enumerate()
            .filter_map(|(position, id)| Some((position, ir.items.get(id.0 as usize)?)))
            .filter(|(_, parameter)| parameter.name == name);
        let (position, parameter) = parameters.next()?;
        let IrItemKind::Param {
            owner: declared_owner,
            index,
            ty:
                IrType::Known(
                    ty @ ResolvedType::Record {
                        symbol: model,
                        stored: true,
                    },
                ),
            array_bounds: None,
            default: None,
            default_node: None,
            default_copy_source: None,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let fact = source.parameters.get(position)?;
        if parameters.next().is_some()
            || *declared_owner != owner.id
            || *index != position
            || parameter.id != fact.parameter
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, name)
            || fact.ty != *ty
            || fact.default.is_some()
            || fact.constraints.is_some()
        {
            return None;
        }
        Some(Self {
            parameter,
            fact,
            model: *model,
        })
    }
}

fn parameter_row_receiver(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    model_return: bool,
    base_span: Span,
    text: &str,
    db: &SourceDb,
) -> Option<()> {
    let authored = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: value.span.file,
            start: value.span.start,
            end: value.span.end,
            kind: if model_return {
                SyntaxKind::NameRef as u8
            } else {
                SyntaxKind::Member as u8
            },
        },
        db,
    )?;
    let parts: Vec<_> = authored
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    if !model_return {
        let [receiver, dot, member] = parts.as_slice() else {
            return None;
        };
        if receiver.kind != SyntaxKind::NameRef
            || receiver.span != base_span
            || dot.token()?.text(text) != "."
            || member.kind != SyntaxKind::Name
            || member.token()?.text(text) != "id"
        {
            return None;
        }
    } else if authored.kind != SyntaxKind::NameRef || authored.span != base_span {
        return None;
    }
    Some(())
}

fn parameter_row_declaration(
    ir: &IrProgram,
    owner: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedScenarioParameter,
    parameter: &IrItem,
    name: &str,
    text: &str,
    base_span: Span,
    _model_return: bool,
    db: &SourceDb,
) -> Option<SyntaxNode> {
    let declaration = checked_effect_node(ir, owner, fact.node, db)?;
    let parameter_name = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::Name)?;
    let declared_type = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::NamedType)?;
    let mut paths = declared_type
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Path);
    let _type_path = paths.next()?;
    if text
        .get(base_span.start as usize..base_span.end as usize)
        .map(str::trim)
        != Some(name)
        || declaration.kind != SyntaxKind::Parameter
        || parameter_name.span != parameter.span
        || parameter_name.token()?.text(text) != name
        || crate::analysis::NodeKey::of(declared_type) != fact.type_node
        || paths.next().is_some()
    {
        return None;
    }
    Some(declaration)
}

fn parameter_row_schema<'a>(
    ir: &'a IrProgram,
    source: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    owner: &IrItem,
    symbol: crate::analysis::SymbolId,
    type_path: &SyntaxNode,
    text: &str,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let mut schemas = source
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let original = schemas.next()?;
    super::scenario_create_sources::reference_name(
        ir,
        owner,
        symbol,
        direct_source_path_name(type_path, text)?,
        db,
    )?;
    if schemas.next().is_some()
        || original.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "id")
        })
    {
        return None;
    }
    match_stored_contract_fields(ir, original, db)?;
    let generated = super::js::Emitter::source_models(ir, db)?;
    let mut expected = generated
        .iter()
        .filter(|model| model.name == original.canonical);
    let mut supplied = models
        .iter()
        .filter(|model| model.name == original.canonical);
    let expected_descriptor = expected.next()?;
    let descriptor = supplied.next()?;
    let expected_value = serde_json::to_value(expected_descriptor).ok()?;
    let descriptor_value = serde_json::to_value(descriptor).ok()?;
    if expected.next().is_some()
        || supplied.next().is_some()
        || descriptor.fields.iter().any(|field| field.name == "id")
        || expected_value != descriptor_value
    {
        return None;
    }
    Some(original)
}

fn checked_parameter_row_id<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    if let Some(nested) = parameter_row_base(value) {
        return nested_parameter_row(ir, owner, nested, value, models, db);
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let (base, model_return) = match &value.expr {
        IrExpr::Member { base, field }
            if field == "id" && value.ty == ResolvedType::Scalar(Scalar::Text) =>
        {
            (base.as_ref(), false)
        }
        IrExpr::Name(_) if matches!(value.ty, ResolvedType::Record { stored: true, .. }) => {
            (value, true)
        }
        _ => return None,
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let RequiredModelParameter {
        parameter,
        fact,
        model: symbol,
    } = RequiredModelParameter::checked(ir, owner, params, source, name)?;
    let module = ir.modules.get(owner.module.0 as usize)?;
    let text = &db.get(source.node.file)?.text;
    if owner.canonical != format!("{}.{}", module.name, owner.name)
        || text.get(owner.span.start as usize..owner.span.end as usize) != Some(owner.name.as_str())
        || base.ty != fact.ty
        || !model_return && !reference_read_matches(ir, owner, value, symbol, symbol, "text")
    {
        return None;
    }
    parameter_row_receiver(ir, owner, value, model_return, base.span, text, db)?;
    let declaration = parameter_row_declaration(
        ir,
        owner,
        fact,
        parameter,
        name,
        text,
        base.span,
        model_return,
        db,
    )?;
    let declared_type = declaration
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::NamedType)?;
    let type_path = declared_type
        .children
        .iter()
        .find(|part| part.kind == SyntaxKind::Path)?;
    parameter_row_schema(ir, source, owner, symbol, type_path, text, models, db)
}

/// The selected source operand follows at most two genuine containment edges
/// from its original required input. Each edge retains its own observed site.
/// The two ordinary Branch.parent reads inside the original unscoped Run
/// predicate are candidate-exclusive. This checks their real IR occurrences;
/// the optional association neither fabricates a read nor completes a query.
fn checked_candidate_parent_association<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    dependency: &crate::analysis::scenario_disclosure::DisclosureDependency,
    expression: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a str,
)> {
    use crate::analysis::types::CheckedQueryClauseKind;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let query_id = dependency.query_id.as_deref()?;
    let mut matching = facts
        .queries
        .as_deref()?
        .iter()
        .filter(|query| query.id == query_id);
    let query = matching.next()?;
    let count = query.count.as_ref()?;
    let [first, candidate, supplied] = count.parent_edges.as_slice() else {
        return None;
    };
    let [input] = query.inputs.as_slice() else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        guards,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut statements = guards.iter().filter(|statement|
        matches!(statement, IrStmt::Require {span,..} if *span == node_span(count.statement)));
    let IrStmt::Require { cond, .. } = statements.next()? else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Lt,
        left: call,
        right: bound,
    } = &cond.expr
    else {
        return None;
    };
    let (target, args, slots) = match &call.expr {
        IrExpr::Call { target, args } => (target, args.as_slice(), None),
        IrExpr::BoundCall {
            target,
            args,
            slots,
        } => (target, args.as_slice(), Some(slots.as_slice())),
        _ => return None,
    };
    let [domain] = args else {
        return None;
    };
    let IrExpr::Query(scan) = &domain.expr else {
        return None;
    };
    if scan.value_order.is_some() {
        return None;
    }
    let original = scan.source.as_deref()?;
    let collection = scan.collection_call.as_deref()?;
    let [alias, clause] = original.clauses.as_slice() else {
        return None;
    };
    let CheckedQueryClauseKind::As { name: source_alias } = &alias.kind else {
        return None;
    };
    let predicate = scan.where_pred.as_deref()?;
    let IrExpr::Binary {
        op: IrBinOp::And,
        left: equality,
        right: unfinished,
    } = &predicate.expr
    else {
        return None;
    };
    let IrExpr::Binary {
        op: IrBinOp::Eq,
        left: actual_candidate,
        right: actual_supplied,
    } = &equality.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: first_parent,
        field: candidate_field,
    } = &actual_candidate.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: row,
        field: first_field,
    } = &first_parent.expr
    else {
        return None;
    };
    let IrExpr::Name(row_name) = &row.expr else {
        return None;
    };
    let IrExpr::Member {
        base: parameter_expr,
        field: supplied_field,
    } = &actual_supplied.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: unfinished_row,
        field: unfinished_field,
    } = &unfinished.expr
    else {
        return None;
    };
    let parameter = ir.items.get(input.1.0 as usize)?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        ty: IrType::Known(parameter_type),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let record = ResolvedType::Record {
        symbol: query.model,
        stored: true,
    };
    let array = ResolvedType::Array {
        element: Box::new(record.clone()),
        ordered: true,
        nonempty: false,
    };
    let edge = if std::ptr::eq(expression, actual_candidate.as_ref()) {
        candidate
    } else if std::ptr::eq(expression, actual_supplied.as_ref()) {
        supplied
    } else {
        return None;
    };
    let [parent_control, unfinished_control] = query.dependencies.as_slice() else {
        return None;
    };
    let model_schema = checked_first_query_schema(ir, owner, query, db)?;
    let unfinished_schema = model_schema
        .fields
        .iter()
        .find(|field| field.name == "unfinished")?;
    let census = facts.expression_types.as_deref()?;
    let source_text = &db.get(query.node.file)?.text;
    let source_name = |expression: &TypedExpr, expected: &str| {
        source_text
            .get(expression.span.start as usize..expression.span.end as usize)
            .is_some_and(|text| text.trim() == expected)
    };
    if matching.next().is_some()
        || statements.next().is_some()
        || facts
            .queries
            .as_deref()?
            .iter()
            .filter(|other| {
                other.count.as_ref().is_some_and(|other| {
                    other.call == count.call || other.statement == count.statement
                })
            })
            .count()
            != 1
        || query_id.is_empty()
        || count.contained_parent.is_some()
        || query.first.is_some()
        || query.projection.is_some()
        || query.cardinality_guard.is_some()
        || query.limit.is_some()
        || query.archived
        || !query.order.is_empty()
        || query.source != proof.source
        || dependency.source != query.source
        || dependency.node != edge.node
        || dependency.field != edge.child
        || dependency.model != edge.child
        || dependency.field_name != "parent"
        || dependency.role != DependencyRole::Control
        || !dependency.calls.is_empty()
        || expression.span != node_span(edge.node)
        || first.child != query.model
        || first.parent != candidate.child
        || model_schema.parent != Some(first.parent)
        || parent_control.node != first.node
        || parent_control.model != first.child
        || parent_control.field != first.child
        || parent_control.field_name != "parent"
        || parent_control.model_name != query.model_name
        || parent_control.ty
            != (ResolvedType::Record {
                symbol: first.parent,
                stored: true,
            })
        || parent_control.type_id != ir.items.get(first.parent.0 as usize)?.canonical
        || unfinished_control.node
            != crate::analysis::NodeKey::of(&checked_effect_node(
                ir,
                owner,
                unfinished_control.node,
                db,
            )?)
        || node_span(unfinished_control.node) != unfinished.span
        || unfinished_control.model != query.model
        || unfinished_control.field != unfinished_schema.id
        || unfinished_control.field_name != "unfinished"
        || unfinished_control.model_name != query.model_name
        || unfinished_control.ty != ResolvedType::Scalar(Scalar::Bool)
        || unfinished_control.type_id != "bool"
        || [parent_control, unfinished_control].iter().any(|read| {
            read.id.is_empty()
                || read.source != query.source
                || !read.calls.is_empty()
                || read.role != DependencyRole::Control
                || read.query_id.is_some()
        })
        || supplied.child != candidate.child
        || supplied.parent != candidate.parent
        || first.node != candidate.receiver
        || supplied.receiver != input.0
        || candidate_field != "parent"
        || first_field != "parent"
        || supplied_field != "parent"
        || first_parent.span != node_span(first.node)
        || row.span != node_span(first.receiver)
        || actual_candidate.span != node_span(candidate.node)
        || actual_supplied.span != node_span(supplied.node)
        || parameter_expr.span != node_span(input.0)
        || *parameter_owner != owner.id
        || params.get(*index) != Some(&input.1)
        || parameter.id != input.1
        || parameter.module != owner.module
        || parameter_type != &first_parent.ty
        || parameter_expr.ty != *parameter_type
        || !matches!(&parameter_expr.expr,IrExpr::Name(name) if name == &parameter.name)
        || facts.parameters.get(*index)?.parameter != parameter.id
        || facts.parameters.get(*index)?.default.is_some()
        || !matches!(target,super::ir::IrCallTarget::Builtin {id,awaited:false} if id == "count")
        || count.slots != [Some(0)]
        || slots.is_some_and(|slots| slots != [Some(0)])
        || call.span != node_span(count.call)
        || call.ty != ResolvedType::Scalar(Scalar::Int)
        || !matches!(bound.expr, IrExpr::Int(10))
        || bound.ty != ResolvedType::Scalar(Scalar::Int)
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
        || domain.ty != array
        || domain.span != node_span(query.node)
        || original.node != query.node
        || original.domain != query.domain
        || original.domain_type != array
        || original.result != array
        || original.projection.is_some()
        || collection.node != count.call
        || collection.builtin != "count"
        || collection.overload != count.overload
        || collection.query != query.node
        || collection.model != query.model
        || Some(collection.alias) != query.alias
        || collection.predicate.is_some()
        || Some(alias.node) != query.alias
        || row_name != "row"
        || !alias.expressions.is_empty()
        || clause.kind != CheckedQueryClauseKind::Where
        || clause.expressions.as_slice() != [query.predicate?]
        || predicate.span != node_span(query.predicate?)
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || equality.ty != ResolvedType::Scalar(Scalar::Bool)
        || row.ty != record
        || unfinished_row.ty != record
        || !matches!(&unfinished_row.expr,IrExpr::Name(name) if name == row_name)
        || !source_name(row, source_alias)
        || !source_name(unfinished_row, source_alias)
        || !source_name(parameter_expr, &parameter.name)
        || unfinished_field != "unfinished"
        || unfinished.ty != ResolvedType::Scalar(Scalar::Bool)
        || scan.parent.is_some()
        || scan.limit.is_some()
        || scan.archived.is_some()
        || scan.select.is_some()
        || scan.select_param.is_some()
        || !scan.order.is_empty()
        || scan.contract_collection_call.is_some()
        || scan.where_async
        || !matches!(&scan.domain,super::ir::IrQueryDomain::Model(name) if name == &query.model_name)
        || proof.returns.is_empty()
        || proof.returns.iter().any(|returned| {
            returned.source != query.source
                || returned.node != query.return_node
                || query.influences.len() != 4
                || query.influences.iter().any(|influence| {
                    influence.query_id.as_deref() != Some(query_id)
                        || !returned.influences.contains(influence)
                })
                || !returned.dependencies.iter().any(|read| read == dependency)
        })
        || [
            call.as_ref(),
            domain,
            predicate,
            equality.as_ref(),
            actual_candidate.as_ref(),
            actual_supplied.as_ref(),
            first_parent.as_ref(),
            row.as_ref(),
            parameter_expr.as_ref(),
            unfinished.as_ref(),
            unfinished_row.as_ref(),
        ]
        .iter()
        .any(|expression| {
            !census
                .iter()
                .any(|(node, ty)| node_span(*node) == expression.span && ty == &expression.ty)
        })
    {
        return None;
    }
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == edge.child);
    let child = schemas.next()?;
    let mut parents = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.id == edge.parent);
    let parent = parents.next()?;
    if schemas.next().is_some()
        || parents.next().is_some()
        || child.parent != Some(parent.id)
        || child.owner != Some(crate::analysis::resolve::ModelOwner::ChildOf(parent.id))
        || child.canonical != dependency.model_name
        || parent.canonical != dependency.type_id
        || dependency.ty
            != (ResolvedType::Record {
                symbol: parent.id,
                stored: true,
            })
        || expression.ty != dependency.ty
        || child.source != query.source
        || parent.source != query.source
        || child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
    {
        return None;
    }
    match_stored_contract_schema(ir, child, db)?;
    match_stored_contract_schema(ir, parent, db)?;
    checked_effect_node(ir, owner, count.call, db)?;
    checked_effect_node(ir, owner, dependency.node, db)?;
    let authored_alias = checked_effect_node(ir, owner, alias.node, db)?;
    let alias_names = authored_alias
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .map(|node| node.token().map(|token| token.text(source_text)))
        .collect::<Option<Vec<_>>>()?;
    if alias_names != ["as", source_alias.as_str()] {
        return None;
    }
    Some((child, parent, query.id.as_str()))
}

/// Exact CreateAs.parent association to that CREATE's original required
/// parent input. The borrowed row remains a created row, never a parameter.
fn checked_created_parent<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    &'a IrItem,
    usize,
)> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(binding) = &base.expr else {
        return None;
    };
    if field != "parent" {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut sources = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|source| source.binding == *binding && source.source == facts.source);
    let created = sources.next()?;
    if sources.next().is_some() {
        return None;
    }
    checked_created_row_operand(ir, owner, base, created.model, db, false, true)?;
    let IrItemKind::Scenario {
        effects, params, ..
    } = &owner.kind
    else {
        return None;
    };
    let (position,statement)=effects.iter().enumerate().find(|(_,statement)|matches!(statement,IrStmt::Create{span,..} if *span==node_span(created.node)))?;
    let IrStmt::Create {
        input, when: None, ..
    } = statement
    else {
        return None;
    };
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let parent = &entries.iter().find(|(name, _)| name == "parent")?.1;
    let IrExpr::Name(name) = &parent.expr else {
        return None;
    };
    let original = created.inputs.iter().find(|input| {
        input.name == "parent"
            && input.field.is_none()
            && node_span(input.value_node) == parent.span
    })?;
    let models = super::js::Emitter::source_models(ir, db)?;
    let schema = checked_parameter_row_id(ir, owner, parent, &models, db)?;
    let child = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == created.model)?;
    match_stored_contract_schema(ir, child, db)?;
    if child.parent != Some(schema.id) {
        return None;
    }
    if value.ty != parent.ty
        || original.ty != parent.ty
        || created.definition.declaration.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(schema.id)
    {
        return None;
    }
    super::scenario_create_sources::checked_create_expression(
        ir,
        created,
        parent,
        original.value_node,
        db,
    )?;
    let parameter = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|parameter| parameter.name == *name)?;
    let stage = effects[..position]
        .iter()
        .try_fold(0, |stage, statement| match statement {
            IrStmt::Let { .. } | IrStmt::Require { .. } => Some(stage),
            IrStmt::Create { when: None, .. } | IrStmt::Set { when: None, .. } => Some(stage + 1),
            _ => None,
        })?;
    Some((created, parameter, stage))
}

pub(super) fn checked_parent_reference<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    checked_parent_reference_at(ir, owner, value, db, 2)
}

fn checked_delivery_event_row_name(owner: &IrItem) -> Option<&'static str> {
    match owner.canonical.as_str() {
        "agreements.notice" => Some("term"),
        "agreements.due" => Some("obligation"),
        "appointments.remind" => Some("appointment"),
        "events.attendee_notice" => Some("registration"),
        _ => None,
    }
}

/// The event's original declared field, retained as a flattened private
/// handler input. Only the exact delivery sources may root observations
/// in this row; an arbitrary event member or lexical copy cannot match.
fn checked_notice_event_field(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    field_name: &str,
    db: &SourceDb,
) -> Option<crate::analysis::SymbolId> {
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(source)),
        hook: None,
        cohort: None,
        params,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let (expected_event, row_name) = match owner.canonical.as_str() {
        "agreements.notice" => ("agreements.Notice", "term"),
        "agreements.due" => ("agreements.ObligationDue", "obligation"),
        "appointments.remind" => ("appointments.Reminder", "appointment"),
        "events.attendee_notice" => ("events.AttendeeNotice", "registration"),
        _ => return None,
    };
    if source != expected_event
        || !matches!(field_name, "revision")
            && field_name != row_name
            && !(owner.canonical == "events.attendee_notice"
                && matches!(field_name, "kind" | "body"))
        || !params.is_empty()
        || field != field_name
        || !matches!(&base.expr, IrExpr::Name(name) if name == "event")
        || db
            .get(value.span.file)?
            .text
            .get(value.span.start as usize..value.span.end as usize)?
            .trim()
            != format!("event.{field_name}")
    {
        return None;
    }
    let mut events = ir.items.iter().filter(|item| item.canonical == *source);
    let event = events.next()?;
    let IrItemKind::Event { fields } = &event.kind else {
        return None;
    };
    if events.next().is_some()
        || event.module != owner.module
        || fields.len()
            != if owner.canonical == "events.attendee_notice" {
                4
            } else {
                2
            }
    {
        return None;
    }
    let mut matched = fields
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| item.name == field_name);
    let item = matched.next()?;
    let IrItemKind::Field {
        owner: declared,
        ty: IrType::Known(ty),
        ..
    } = &item.kind
    else {
        return None;
    };
    if matched.next().is_some()
        || *declared != event.id
        || item.module != event.module
        || ty != &value.ty
    {
        return None;
    }
    Some(item.id)
}

fn checked_notice_event_row_path(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<crate::analysis::SymbolId> {
    if let Some(field) = checked_delivery_event_row_name(owner)
        .and_then(|name| checked_notice_event_field(ir, owner, value, name, db))
    {
        let IrItemKind::Field {
            ty:
                IrType::Known(ResolvedType::Record {
                    symbol,
                    stored: true,
                }),
            ..
        } = &ir.items.get(field.0 as usize)?.kind
        else {
            return None;
        };
        return Some(*symbol);
    }
    if owner.canonical == "appointments.remind" {
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        if field == "contact"
            && checked_notice_event_field(ir, owner, base, "appointment", db).is_some()
            && db
                .get(value.span.file)?
                .text
                .get(value.span.start as usize..value.span.end as usize)?
                == "event.appointment.contact"
        {
            let appointment = match base.ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } => symbol,
                _ => return None,
            };
            let contact = match value.ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } => symbol,
                _ => return None,
            };
            if ir.items.get(appointment.0 as usize)?.canonical != "appointments.Appointment"
                || ir.items.get(contact.0 as usize)?.canonical != "customer.Contact"
            {
                return None;
            }
            let IrItemKind::Model { fields, .. } = &ir.items.get(appointment.0 as usize)?.kind
            else {
                return None;
            };
            let mut matching = fields
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .filter(|item| item.name == "contact");
            let declared = matching.next()?;
            if matching.next().is_some()
                || !matches!(&declared.kind,
                IrItemKind::Field { owner: field_owner,
                    ty: IrType::Known(ResolvedType::Record {symbol, stored: true}), .. }
                    if *field_owner == appointment && *symbol == contact)
            {
                return None;
            }
            return Some(contact);
        }
    }
    let IrExpr::Member { field, .. } = &value.expr else {
        return None;
    };
    if field != "parent" {
        return None;
    }
    let (_, parent) = checked_parent_reference(ir, owner, value, db)?;
    Some(parent.id)
}

fn parent_member_head_valid(field: &str, base_span: Span, value_span: Span) -> bool {
    field == "parent"
        && base_span.file == value_span.file
        && base_span.start == value_span.start
        && base_span.end < value_span.end
}

fn parent_base_param_symbol<'p>(
    owner: &IrItem,
    db: &SourceDb,
    base: &TypedExpr,
    name: &str,
    symbol: crate::analysis::SymbolId,
    parameter_owner: &crate::analysis::SymbolId,
    parameters: &mut impl Iterator<Item = &'p IrItem>,
) -> Option<crate::analysis::SymbolId> {
    let file = db.get(base.span.file)?;
    if parameters.next().is_some()
        || *parameter_owner != owner.id
        || file
            .text
            .get(base.span.start as usize..base.span.end as usize)?
            .trim()
            != name
    {
        return None;
    }
    Some(symbol)
}

fn contract_parameter_symbol(
    ir: &IrProgram,
    owner: &IrItem,
    base: &TypedExpr,
    db: &SourceDb,
) -> Option<crate::analysis::SymbolId> {
    let models = super::js::Emitter::source_models(ir, db)?;
    Some(checked_contract_parameter_row(ir, owner, base, &models, db)?.id)
}

/// One original nullable scenario input at a checker-narrowed required
/// occurrence. The declaration, null default and exact source receiver are
/// retained; no same-typed local or copied row may acquire parent lineage.
fn checked_narrowed_parent_parameter(
    ir: &IrProgram,
    owner: &IrItem,
    base: &TypedExpr,
    db: &SourceDb,
) -> Option<crate::analysis::SymbolId> {
    checked_nullable_model_parameter(ir, owner, base, db, true).map(|(_, model, _)| model)
}

fn checked_nullable_model_parameter(
    ir: &IrProgram,
    owner: &IrItem,
    base: &TypedExpr,
    db: &SourceDb,
    narrowed: bool,
) -> Option<(
    crate::analysis::SymbolId,
    crate::analysis::SymbolId,
    crate::analysis::NodeKey,
)> {
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let expected_model = match (&base.ty, narrowed) {
        (ty @ ResolvedType::Record { stored: true, .. }, true) => ty,
        (ResolvedType::Nullable(inner), false) => inner.as_ref(),
        _ => return None,
    };
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = expected_model
    else {
        return None;
    };
    let symbol = *symbol;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut matches = params
        .iter()
        .enumerate()
        .filter_map(|(index, id)| Some((index, ir.items.get(id.0 as usize)?)))
        .filter(|(_, parameter)| parameter.name == *name);
    let (position, parameter) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let fact = facts.parameters.get(position)?;
    let IrItemKind::Param {
        owner: declared,
        index,
        ty: IrType::Known(ty),
        array_bounds: None,
        default,
        default_node,
        default_copy_source: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let expected = ResolvedType::Nullable(Box::new(ResolvedType::Record {
        symbol,
        stored: true,
    }));
    if *declared != owner.id
        || *index != position
        || fact.parameter != parameter.id
        || fact.ty != expected
        || *ty != expected
        || parameter.module != owner.module
        || parameter.canonical != format!("{}.{}", owner.canonical, name)
        || !facts
            .expression_types
            .as_deref()?
            .iter()
            .any(|(node, ty)| node_span(*node) == base.span && *ty == base.ty)
        || db
            .get(base.span.file)?
            .text
            .get(base.span.start as usize..base.span.end as usize)?
            .trim()
            != name
        || !(default.is_none() && fact.default.is_none() && default_node.is_none()
            || matches!(default,Some(IrDefault::Literal(value)) if matches!(value.expr,IrExpr::Null) && value.ty==ResolvedType::Null
                && default_node.is_some_and(|node|Some(node)==fact.default && value.span==node_span(node))))
    {
        return None;
    }
    Some((parameter.id, symbol, fact.node))
}

fn checked_optional_parameter_scalar<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    db: &SourceDb,
) -> Option<(
    crate::analysis::SymbolId,
    crate::analysis::NodeKey,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractField,
)> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let (parameter, model, presence) =
        checked_nullable_model_parameter(ir, owner, base, db, false)?;
    let text = db
        .get(value.span.file)?
        .text
        .get(base.span.end as usize..value.span.end as usize)?
        .trim();
    if value.span.file != base.span.file
        || value.span.start != base.span.start
        || text.strip_prefix("?.").map(str::trim) != Some(field.as_str())
    {
        return None;
    }
    let schema = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.model && schema.id == model)?;
    let declaration = schema
        .fields
        .iter()
        .find(|original| original.name == *field)?;
    if !crate::analysis::scenario_disclosure::primitive_type(&declaration.ty)
        || value.ty != ResolvedType::Nullable(Box::new(declaration.ty.clone()))
        || !facts
            .expression_types
            .as_deref()?
            .iter()
            .any(|(node, ty)| node_span(*node) == value.span && *ty == value.ty)
    {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    match_stored_contract_field(ir, declaration, db)?;
    Some((parameter, presence, declaration))
}

fn checked_parent_reference_at<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    remaining: usize,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    if remaining == 0 {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    if !parent_member_head_valid(field, base.span, value.span) {
        return None;
    }
    let selected_first = checked_first_query_row(ir, owner, base, db);
    let created = checked_created_parent(ir, owner, value, db);
    let symbol = match &base.expr {
        IrExpr::Name(_) if created.is_some() => created?.0.model,
        IrExpr::Name(_) if selected_first.is_some() => selected_first?.id,
        IrExpr::Name(_) if checked_narrowed_parent_parameter(ir, owner, base, db).is_some() => {
            checked_narrowed_parent_parameter(ir, owner, base, db)?
        }
        IrExpr::Name(name) => {
            let mut parameters = params
                .iter()
                .filter_map(|id| ir.items.get(id.0 as usize))
                .filter(|parameter| parameter.name == *name);
            let parameter = parameters.next()?;
            let IrItemKind::Param {
                owner: parameter_owner,
                ty:
                    IrType::Known(ResolvedType::Record {
                        symbol,
                        stored: true,
                    }),
                default: None,
                default_node: None,
                array_bounds: None,
                ..
            } = &parameter.kind
            else {
                return None;
            };
            parent_base_param_symbol(
                owner,
                db,
                base,
                name,
                *symbol,
                parameter_owner,
                &mut parameters,
            )?
        }
        IrExpr::Member { .. }
            if checked_delivery_event_row_name(owner)
                .and_then(|name| checked_notice_event_field(ir, owner, base, name, db))
                .is_some() =>
        {
            checked_notice_event_row_path(ir, owner, base, db)?
        }
        IrExpr::Member { .. }
            if checked_contract_parameter_path(ir, owner, base, Some(db)).is_some() =>
        {
            contract_parameter_symbol(ir, owner, base, db)?
        }
        IrExpr::Member { field, .. } if field == "parent" => {
            let (_, parent) = checked_parent_reference_at(ir, owner, base, db, remaining - 1)?;
            parent.id
        }
        _ => return None,
    };
    if base.ty
        != (ResolvedType::Record {
            symbol,
            stored: true,
        })
    {
        return None;
    }
    let (child, parent) = parent_reference_schemas(ir, owner, value, symbol, source)?;
    match_stored_contract_schema(ir, child, db)?;
    match_stored_contract_schema(ir, parent, db)?;
    Some((child, parent))
}

fn parent_reference_schemas<'a>(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    symbol: crate::analysis::SymbolId,
    source: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    let inventory = source.stored_contracts.as_deref()?;
    let mut children = inventory
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let child = children.next()?;
    let mut parents = inventory
        .iter()
        .filter(|schema| schema.model && Some(schema.id) == child.parent);
    let parent = parents.next()?;
    if children.next().is_some()
        || parents.next().is_some()
        || value.ty
            != (ResolvedType::Record {
                symbol: parent.id,
                stored: true,
            })
        || child.field_order.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|field| field.name == "parent")
        })
        || !reference_read_matches(ir, owner, value, child.id, child.id, &parent.canonical)
    {
        return None;
    }
    Some((child, parent))
}

fn reference_read_matches(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    model: crate::analysis::resolve::SymbolId,
    field: crate::analysis::resolve::SymbolId,
    type_id: &str,
) -> bool {
    let Some(ScenarioDisclosure::Complete(checked)) = ir.scenario_disclosures.get(&owner.id) else {
        return false;
    };
    checked
        .returns
        .iter()
        .flat_map(|returned| &returned.dependencies)
        .any(|read| {
            read.model == model
                && read.field == field
                && read.ty == value.ty
                && read.type_id == type_id
                && read.calls.is_empty()
                && read.source == checked.source
                && node_span(read.node) == value.span
        })
}

/// The original attachment CALL reads an ordinary owning File array once.
/// This joins source/dependency identity only; Files supplies live authority.
fn file_array_receiver(
    value: &TypedExpr,
) -> Option<(&String, &String, crate::analysis::SymbolId, &TypedExpr)> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = &base.ty
    else {
        return None;
    };
    if !matches!(&value.ty, ResolvedType::Array { element, ordered: true, nonempty: false }
        if **element == ResolvedType::Scalar(Scalar::File))
    {
        return None;
    }
    Some((name, field, *symbol, base))
}

fn file_array_authored_matches(
    ir: &IrProgram,
    owner: &IrItem,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    value: &TypedExpr,
    base: &TypedExpr,
    field: &str,
    text: &str,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::NodeKey;
    let key = NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: SyntaxKind::Member as u8,
    };
    let authored = checked_effect_node(ir, owner, key, db)?;
    let parts: Vec<_> = authored
        .children
        .iter()
        .filter(|part| part.kind != SyntaxKind::Trivia)
        .collect();
    let [receiver, dot, member] = parts.as_slice() else {
        return None;
    };
    let census = source.expression_types.as_deref()?;
    if receiver.kind != SyntaxKind::NameRef
        || receiver.span != base.span
        || dot.token()?.text(text) != "."
        || member.kind != SyntaxKind::Name
        || member.token()?.text(text) != field
        || census.iter().find(|(node, _)| *node == key)?.1 != value.ty
        || census
            .iter()
            .find(|(node, _)| *node == NodeKey::of(receiver))?
            .1
            != base.ty
    {
        return None;
    }
    Some(())
}

fn file_array_field_valid(
    ir: &IrProgram,
    owner: &IrItem,
    declaration: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    symbol: crate::analysis::SymbolId,
    value: &TypedExpr,
    schema_id: crate::analysis::SymbolId,
    db: &SourceDb,
    call_bounds: bool,
) -> Option<()> {
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &declaration.kind
    else {
        return None;
    };
    if original.owner != symbol
        || original.ty != value.ty
        || original.declared != "file[]"
        || original.required_array
        || original.reuse.is_some()
        || original.trim
        || call_bounds
            && (original.min.is_some() || original.max.as_ref().map(|(_, max, _)| *max) != Some(8))
        || original
            .constraints
            .as_ref()
            .is_some_and(|constraints| constraints.alias.is_some())
        || modifiers.machine
        || modifiers.unique
        || !reference_read_matches(ir, owner, value, schema_id, original.id, "file[]")
    {
        return None;
    }
    match_stored_contract_field(ir, original, db)
}

fn file_array_schema_field<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    source: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
    symbol: crate::analysis::SymbolId,
    field: &str,
    value: &TypedExpr,
    db: &SourceDb,
    call_bounds: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let mut schemas = source
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, schema, db)?;
    let mut fields = schema
        .fields
        .iter()
        .filter(|original| original.name == field);
    let original = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    let declaration = ir.items.get(original.id.0 as usize)?;
    file_array_field_valid(
        ir,
        owner,
        declaration,
        original,
        symbol,
        value,
        schema.id,
        db,
        call_bounds,
    )?;
    Some(original)
}

fn stored_file_array_parameter_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    call_bounds: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let (name, field, symbol, base) = file_array_receiver(value)?;
    let IrItemKind::Scenario {
        params,
        read: false,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let RequiredModelParameter {
        parameter, fact, ..
    } = RequiredModelParameter::checked(ir, owner, params, source, name)?;
    let module = ir.modules.get(owner.module.0 as usize)?;
    let text = &db.get(source.node.file)?.text;
    if owner.canonical != format!("{}.{}", module.name, owner.name)
        || fact.ty != base.ty
        || text.get(base.span.start as usize..base.span.end as usize)? != name
        || text.get(parameter.span.start as usize..parameter.span.end as usize)? != name
    {
        return None;
    }
    file_array_authored_matches(ir, owner, source, value, base, field, text, db)?;
    file_array_schema_field(ir, owner, source, symbol, field, value, db, call_bounds)
}

pub(super) fn stored_file_array_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    stored_file_array_parameter_operand(ir, owner, value, db, true)
}

/// The original required input's File array may be copied only into this
/// exact CREATE field. The receiving schema and live File checks still own it.
fn checked_stored_file_array_create_operand<'a>(
    context: &super::source_context::FreshSourceContext<'_>,
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    context.same_scenario(ir, owner)?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let mut matches = facts.creates.as_deref()?.iter().filter(|created| {
        effects.iter().any(|statement| {
            let IrStmt::Create { input, span, .. } = statement else {
                return false;
            };
            let IrExpr::Object(entries) = &input.expr else {
                return false;
            };
            *span == node_span(created.node)
                && entries.iter().any(|(name, argument)| {
                    std::ptr::eq(argument, value)
                        && created.inputs.iter().any(|input| {
                            input.name == *name
                                && input.field.is_some()
                                && input.ty == value.ty
                                && node_span(input.value_node) == value.span
                                && created.definition.fields.iter().any(|field| {
                                    Some(field.field) == input.field && field.ty == value.ty
                                })
                        })
                })
        })
    });
    matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    stored_file_array_parameter_operand(ir, owner, value, db, false)
}

/// A newly created File-array member is data only at its exact checked
/// standard SEND slot. The complete owner seal retains the original CREATE,
/// receiver, consumer and order; Files/State still supply all live authority.
fn checked_created_file_array_send_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    sealed: bool,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    if !sealed {
        return None;
    }
    let (_, field, model, base) = file_array_receiver(value)?;
    checked_created_row_operand(ir, owner, base, model, db, false, true)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let mut consumers = effects.iter().filter_map(|statement| {
        let IrStmt::Send {
            operation, args, ..
        } = statement
        else {
            return None;
        };
        let IrExpr::Object(entries) = &args.expr else {
            return None;
        };
        let (capability, operation) = operation.rsplit_once('.')?;
        let signature = crate::analysis::catalog::std_operation(capability, operation)?;
        entries
            .iter()
            .any(|(name, argument)| {
                std::ptr::eq(argument, value)
                    && signature
                        .inputs
                        .iter()
                        .any(|(slot, ty)| *slot == name && *ty == "file[]")
            })
            .then_some(())
    });
    consumers.next()?;
    if consumers.next().is_some() {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let text = &db.get(facts.node.file)?.text;
    file_array_authored_matches(ir, owner, facts, value, base, field, text, db)?;
    file_array_schema_field(ir, owner, facts, model, field, value, db, false)
}

pub(super) fn stored_file_array_descriptor_matches(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    descriptor: &JsModelField,
) -> bool {
    let Some(owner) = ir.items.get(original.owner.0 as usize) else {
        return false;
    };
    let generated = super::js::Emitter::new(ir).collect_models();
    let mut models = generated
        .iter()
        .filter(|model| model.name == owner.canonical);
    let Some(model) = models.next() else {
        return false;
    };
    let mut fields = model
        .fields
        .iter()
        .filter(|field| field.name == original.name);
    let Some(expected) = fields.next() else {
        return false;
    };
    models.next().is_none()
        && fields.next().is_none()
        && matches!(descriptor.field, JsModelFieldType::File)
        && descriptor.value_type.as_deref() == Some("file[]")
        && descriptor.array_required == Some(false)
        && !descriptor.nullable
        && !descriptor.server_only
        && descriptor.machine.is_none()
        && serde_json::to_value(expected)
            .ok()
            .is_some_and(|expected| serde_json::to_value(descriptor).ok() == Some(expected))
}

/// Borrow the exact required Profile pairs or the leading Turn.run unfinished
/// guard pair. A Profile Let consumed by guard and result retains both roles.
/// This correspondence neither promotes a reference nor emits a recipe.
pub(super) fn checked_profile_scalar_pairs<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    leaf: &TypedExpr,
    db: &SourceDb,
) -> Option<
    Vec<(
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
> {
    use crate::analysis::NodeKey;
    if !std::ptr::eq(ir.items.get(owner.id.0 as usize)?, owner) {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        params,
        read: false,
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let IrExpr::Member {
        base: reference,
        field: scalar_name,
    } = &leaf.expr
    else {
        return None;
    };
    let IrExpr::Member {
        base: receiver,
        field,
    } = &reference.expr
    else {
        return None;
    };
    let IrExpr::Name(binding) = &receiver.expr else {
        return None;
    };
    let constructor_scalar = source.creates.as_deref().is_some_and(|creates| {
        creates.iter().any(|create| {
            create
                .inputs
                .iter()
                .any(|input| node_span(input.value_node) == leaf.span && input.ty == leaf.ty)
        })
    });
    let run_guard = field == "run" && scalar_name == "unfinished";
    let (reference_name, expected) = if run_guard {
        ("run", Scalar::Bool)
    } else if field == "profile" {
        let expected = match scalar_name.as_str() {
            "active" => Scalar::Bool,
            "system_prompt" | "provider_key" | "policy_revision" => Scalar::Text,
            "input_tokens" | "output_tokens" => Scalar::Int,
            "duration" => Scalar::Duration,
            _ => return None,
        };
        ("profile", expected)
    } else if constructor_scalar {
        let ResolvedType::Scalar(expected) = leaf.ty else {
            return None;
        };
        if matches!(expected, Scalar::File) {
            return None;
        }
        (field.as_str(), expected)
    } else {
        return None;
    };
    let ResolvedType::Record {
        symbol: branch_id,
        stored: true,
    } = receiver.ty
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: profile_id,
        stored: true,
    } = reference.ty
    else {
        return None;
    };
    if field != reference_name
        || leaf.ty != ResolvedType::Scalar(expected)
        || proof.scenario != owner.id
        || proof.node != source.node
        || proof.source != source.source
        || proof.returns.is_empty()
    {
        return None;
    }
    // This consumer takes the actual owning IR occurrence, not a detached
    // expression copy carrying otherwise identical source spans and types.
    let IrItemKind::Scenario {
        guards, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let mut expressions = Vec::new();
    for statement in guards.iter().chain(effects) {
        match statement {
            IrStmt::Require { cond, .. } => expressions.push(cond),
            IrStmt::Let { value, .. } => expressions.push(value),
            IrStmt::Create { input, .. } => expressions.push(input),
            _ => {}
        }
    }
    let mut visited = 0usize;
    let mut occurrences = 0usize;
    while let Some(expression) = expressions.pop() {
        visited += 1;
        if visited > 16384 {
            return None;
        }
        if std::ptr::eq(expression, leaf) {
            occurrences += 1;
        }
        match &expression.expr {
            IrExpr::Member { base, .. } => expressions.push(base),
            IrExpr::Binary { left, right, .. } => {
                expressions.extend([left.as_ref(), right.as_ref()])
            }
            IrExpr::Unary { operand, .. } => expressions.push(operand),
            IrExpr::Array(values) => expressions.extend(values),
            IrExpr::Object(entries) => expressions.extend(entries.iter().map(|(_, value)| value)),
            IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => expressions.extend(args),
            _ => {}
        }
    }
    if occurrences != 1 {
        return None;
    }
    let inventory = source.stored_contracts.as_deref()?;
    let unique_schema = |id| {
        let mut candidates = inventory
            .iter()
            .filter(|schema| schema.id == id && schema.model);
        let schema = candidates.next()?;
        candidates.next().is_none().then_some(schema)
    };
    let branch = unique_schema(branch_id)?;
    let profile = unique_schema(profile_id)?;
    let branch_item = ir.items.get(branch_id.0 as usize)?;
    let profile_item = ir.items.get(profile_id.0 as usize)?;
    if !matches!(branch_item.kind, IrItemKind::Model { .. })
        || !matches!(profile_item.kind, IrItemKind::Model { .. })
        || branch.module != owner.module
        || !constructor_scalar && profile.module != owner.module
        || branch.source != source.source
        || !constructor_scalar && profile.source != source.source
    {
        return None;
    }
    match_stored_contract_schema(ir, branch, db)?;
    match_stored_contract_fields(ir, profile, db)?;
    let mut references = branch
        .fields
        .iter()
        .filter(|candidate| candidate.name == reference_name);
    let reference_field = references.next()?;
    let mut scalars = profile
        .fields
        .iter()
        .filter(|candidate| candidate.name == *scalar_name);
    let scalar_field = scalars.next()?;
    if references.next().is_some()
        || scalars.next().is_some()
        || reference_field.owner != branch.id
        || reference_field.ty != reference.ty
        || scalar_field.owner != profile.id
        || scalar_field.ty != leaf.ty
        || reference_field.reuse.is_some()
        || scalar_field.reuse.is_some()
        || reference_field.source != source.source
        || scalar_field.source != profile.source
        || ir.items.get(reference_field.id.0 as usize)?.module != branch.module
        || ir.items.get(scalar_field.id.0 as usize)?.module != profile.module
        || !branch.field_order.contains(&reference_field.id)
        || !profile.field_order.contains(&scalar_field.id)
    {
        return None;
    }
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &ir.items.get(reference_field.id.0 as usize)?.kind
    else {
        return None;
    };
    if modifiers.machine || reference_field.required_array {
        return None;
    }
    match_stored_contract_field(ir, reference_field, db)?;
    let RequiredModelParameter {
        parameter,
        fact: original_parameter,
        ..
    } = RequiredModelParameter::checked(ir, owner, params, source, binding)?;
    let authored_parameter = checked_effect_node(ir, owner, original_parameter.node, db)?;
    let parameter_name = authored_parameter
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    let text = &db.get(source.node.file)?.text;
    if parameter.span != parameter_name.span
        || parameter_name.token()?.text(text) != binding
        || original_parameter.ty != receiver.ty
        || text
            .get(
                original_parameter.type_node.start as usize
                    ..original_parameter.type_node.end as usize,
            )?
            .trim()
            != branch_item.name
    {
        return None;
    }
    let key = |value: &TypedExpr, kind| NodeKey {
        file: value.span.file,
        start: value.span.start,
        end: value.span.end,
        kind: kind as u8,
    };
    let reference_key = key(reference, SyntaxKind::Member);
    let leaf_key = key(leaf, SyntaxKind::Member);
    let receiver_key = key(receiver, SyntaxKind::NameRef);
    let census = source.expression_types.as_deref()?;
    for (node, ty) in [
        (reference_key, &reference.ty),
        (leaf_key, &leaf.ty),
        (receiver_key, &receiver.ty),
    ] {
        let mut typed = census.iter().filter(|(at, _)| *at == node);
        if typed.next()?.1 != *ty || typed.next().is_some() {
            return None;
        }
    }
    let authored_leaf = checked_effect_node(ir, owner, leaf_key, db)?;
    let leaf_parts: Vec<_> = authored_leaf
        .children
        .iter()
        .filter(|node| node.kind != SyntaxKind::Trivia)
        .collect();
    let [authored_reference, dot, authored_field] = leaf_parts.as_slice() else {
        return None;
    };
    let reference_parts: Vec<_> = authored_reference
        .children
        .iter()
        .filter(|node| node.kind != SyntaxKind::Trivia)
        .collect();
    let [authored_receiver, reference_dot, authored_reference_field] = reference_parts.as_slice()
    else {
        return None;
    };
    if NodeKey::of(authored_reference) != reference_key
        || NodeKey::of(authored_receiver) != receiver_key
        || authored_field.kind != SyntaxKind::Name
        || authored_field.token()?.text(text) != scalar_name
        || dot.token()?.text(text) != "."
        || reference_dot.token()?.text(text) != "."
        || authored_reference_field.token()?.text(text) != reference_name
        || images_source_name(authored_receiver, text)? != binding
    {
        return None;
    }
    let scenario = checked_effect_node(ir, owner, source.node, db)?;
    let contains = |node: &crate::syntax::SyntaxNode| {
        node.span.file == leaf.span.file
            && node.span.start <= leaf.span.start
            && leaf.span.end <= node.span.end
    };
    let role = if scenario
        .children
        .iter()
        .any(|node| node.kind == SyntaxKind::Require && contains(node))
    {
        DependencyRole::Control
    } else {
        let mut blocks = scenario
            .children
            .iter()
            .filter(|node| node.kind == SyntaxKind::DoBlock);
        let block = blocks.next()?;
        if blocks.next().is_some()
            || !block.children.iter().any(|node| {
                (node.kind == SyntaxKind::Create
                    || !constructor_scalar && node.kind == SyntaxKind::Let)
                    && contains(node)
            })
        {
            return None;
        }
        DependencyRole::Data
    };
    if constructor_scalar && role != DependencyRole::Data {
        return None;
    }
    if run_guard {
        if role != DependencyRole::Control
            || branch.parent.is_none()
            || branch.parent != profile.parent
        {
            return None;
        }
        // The second exact scope is only the original leading NOT guard.
        // Both the borrowed executable operand and original typed CST must
        // own the same Unary occurrence; a copied read gains no permission.
        let mut pending: Vec<_> = guards
            .iter()
            .filter_map(|statement| {
                if let IrStmt::Require { cond, .. } = statement {
                    Some(cond)
                } else {
                    None
                }
            })
            .collect();
        let mut unary = None;
        while let Some(value) = pending.pop() {
            match &value.expr {
                IrExpr::Unary { op, operand } => {
                    if std::ptr::eq(operand.as_ref(), leaf) {
                        if unary.is_some()
                            || *op != super::ir::IrUnOp::Not
                            || value.ty != ResolvedType::Scalar(Scalar::Bool)
                        {
                            return None;
                        }
                        unary = Some(value);
                    }
                    pending.push(operand);
                }
                IrExpr::Binary { left, right, .. } => {
                    pending.extend([left.as_ref(), right.as_ref()])
                }
                _ => {}
            }
        }
        let unary = unary?;
        let unary_key = key(unary, SyntaxKind::Unary);
        let mut typed = census.iter().filter(|(at, _)| *at == unary_key);
        if typed.next()?.1 != unary.ty || typed.next().is_some() {
            return None;
        }
        let authored_unary = checked_effect_node(ir, owner, unary_key, db)?;
        let parts: Vec<_> = authored_unary
            .children
            .iter()
            .filter(|node| node.kind != SyntaxKind::Trivia)
            .collect();
        let [operator, operand] = parts.as_slice() else {
            return None;
        };
        if operator.token()?.text(text) != "not" || NodeKey::of(operand) != leaf_key {
            return None;
        }
    }
    let multiple_roles = role == DependencyRole::Data
        && checked_scenario_query_influences(source)
            .is_some_and(|influences| influences.len() == 24);
    let read_identity = |node: NodeKey, role: DependencyRole| {
        let kind = match role {
            DependencyRole::Data => "read-data",
            DependencyRole::Control => "read-control",
        };
        sha256_hex(
            format!(
                "scenario-disclosure/v1:{kind}:{}:{}:{}:{}:{}:",
                source.source.path,
                source.source.sha256,
                source.source.module,
                node.start,
                node.end
            )
            .as_bytes(),
        )
    };
    let mut result = None;
    for returned in &proof.returns {
        if returned.source != source.source {
            return None;
        }
        let references: Vec<_> = returned
            .dependencies
            .iter()
            .enumerate()
            .filter(|(_, read)| read.node == reference_key)
            .collect();
        let leaves: Vec<_> = returned
            .dependencies
            .iter()
            .enumerate()
            .filter(|(_, read)| read.node == leaf_key)
            .collect();
        if references.is_empty() && leaves.is_empty() {
            continue;
        }
        if references.len() != leaves.len()
            || references.is_empty()
            || references.len() > if multiple_roles { 2 } else { 1 }
        {
            return None;
        }
        let expected_roles: &[DependencyRole] = if references.len() == 2 {
            &[DependencyRole::Control, DependencyRole::Data]
        } else {
            std::slice::from_ref(&role)
        };
        let mut pairs = Vec::new();
        let mut identities = HashSet::new();
        for (((source_index, reference_read), (leaf_index, scalar_read)), expected_role) in
            references.iter().zip(&leaves).zip(expected_roles)
        {
            if source_index >= leaf_index
                || reference_read.id != read_identity(reference_key, *expected_role)
                || scalar_read.id != read_identity(leaf_key, *expected_role)
                || reference_read.id == scalar_read.id
                || !identities.insert(&reference_read.id)
                || !identities.insert(&scalar_read.id)
                || reference_read.source != source.source
                || scalar_read.source != source.source
                || !reference_read.calls.is_empty()
                || !scalar_read.calls.is_empty()
                || reference_read.query_id.is_some()
                || scalar_read.query_id.is_some()
                || reference_read.role != *expected_role
                || scalar_read.role != *expected_role
                || reference_read.model != branch.id
                || reference_read.field != reference_field.id
                || reference_read.model_name != branch.canonical
                || reference_read.field_name != reference_name
                || reference_read.ty != reference.ty
                || reference_read.type_id != profile.canonical
                || scalar_read.model != profile.id
                || scalar_read.field != scalar_field.id
                || scalar_read.model_name != profile.canonical
                || scalar_read.field_name != *scalar_name
                || scalar_read.ty != leaf.ty
                || scalar_read.type_id != expected.as_str()
            {
                return None;
            }
            pairs.push((*reference_read, *scalar_read));
        }
        if result.as_ref().is_some_and(|previous| previous != &pairs) {
            return None;
        }
        result = Some(pairs);
    }
    result
}

/// A stored scalar reached through an original pure helper's required reference.
/// The fresh whole-owner disclosure seals the actual/formal path and both DATA
/// obligations; matching wire values cannot substitute either source field.
fn checked_helper_reference_scalar_pairs<'a>(
    context: &'a super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    leaf: &TypedExpr,
) -> Option<
    Vec<(
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let ScenarioDisclosure::Complete(fresh) =
        context.fresh().scenario_disclosures.get(&owner.id)?
    else {
        return None;
    };
    if !super::scenario_feasibility::same_disclosure(proof, fresh) {
        return None;
    }
    let facts = proof.source_facts.as_deref()?;
    let IrExpr::Member { base, field } = &leaf.expr else {
        return None;
    };
    if !(matches!(leaf.ty, ResolvedType::Scalar(_)) && native_result_type(&leaf.ty)
        || leaf.ty == ResolvedType::Scalar(Scalar::Timezone))
    {
        return None;
    }
    let ResolvedType::Record {
        symbol: target,
        stored: true,
    } = base.ty
    else {
        return None;
    };
    let schemas = facts.stored_contracts.as_deref()?;
    let schema = schemas
        .iter()
        .find(|schema| schema.model && schema.id == target)?;
    let original = schema
        .fields
        .iter()
        .find(|item| item.name == *field && item.ty == leaf.ty)?;
    match_stored_contract_schema(ir, schema, context.db())?;
    match_stored_contract_field(ir, original, context.db())?;
    let mut pairs = Vec::new();
    for returned in &proof.returns {
        for read in returned.dependencies.iter().filter(|read| {
            node_span(read.node) == leaf.span
                && read.ty == leaf.ty
                && read.model == target
                && read.field == original.id
                && read.field_name == *field
                && read.role == DependencyRole::Data
                && read.calls.len() == 1
                && read.query_id.is_none()
        }) {
            let mut sources = returned.dependencies.iter().filter(|source| {
                node_span(source.node) == base.span
                    && source.ty == base.ty
                    && source.role == read.role
                    && source.source == read.source
                    && source.calls == read.calls
                    && source.query_id.is_none()
            });
            let source = sources.next()?;
            if sources.next().is_some() || source.id == read.id {
                return None;
            }
            let reference = checked_helper_identity_reference(context, owner, source, base, facts)?;
            if reference.ty != base.ty {
                return None;
            }
            if !pairs.contains(&(source, read)) {
                pairs.push((source, read));
            }
        }
    }
    (!pairs.is_empty()).then_some(pairs)
}

/// Two original required reference fields in one authored Member chain. The
/// receiving target row stays issued by State; this only pairs the checked
/// source marker with the subsequent target getter at its original position.
/// Resolve one captured required-reference receiver to its original getter.
/// The immutable declaration, use, source spelling and checked types must all
/// agree; a copied alias, nullable receiver or shadowed binding stays refused.
fn checked_reference_alias_initializer<'a>(
    ir: &'a IrProgram,
    owner: &'a IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a TypedExpr> {
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    let IrItemKind::Scenario {
        trusted: false,
        read: false,
        event_source: None,
        hook: None,
        cohort: None,
        params,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    if params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .any(|parameter| parameter.name == *name)
    {
        return None;
    }
    let mut pending = effects.iter().collect::<Vec<_>>();
    let mut bindings = 0usize;
    let mut visits = 0usize;
    while let Some(statement) = pending.pop() {
        visits += 1;
        if visits > 16384 {
            return None;
        }
        match statement {
            IrStmt::Let { name: bound, .. } | IrStmt::For { item: bound, .. } if bound == name => {
                bindings += 1
            }
            IrStmt::Create {
                binding: Some(bound),
                ..
            }
            | IrStmt::Call {
                binding: Some(bound),
                ..
            }
            | IrStmt::Send {
                binding: Some(bound),
                ..
            } if bound == name => bindings += 1,
            _ => {}
        }
        match statement {
            IrStmt::If {
                then_branch,
                else_branch,
                ..
            } => pending.extend(then_branch.iter().chain(else_branch)),
            IrStmt::For { body, .. } => pending.extend(body),
            IrStmt::Match { arms, .. } => {
                for arm in arms {
                    pending.extend(&arm.body);
                }
            }
            _ => {}
        }
    }
    if bindings != 1 {
        return None;
    }
    let (initializer, span) = effects.iter().find_map(|statement| match statement {
        IrStmt::Let {
            name: bound,
            value: initializer,
            span,
        } if bound == name => Some((initializer, *span)),
        _ => None,
    })?;
    if span.file != value.span.file
        || span.end > value.span.start
        || initializer.ty != value.ty
        || !matches!(initializer.expr, IrExpr::Member { .. })
        || !matches!(value.ty, ResolvedType::Record { stored: true, .. })
    {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let text = &db.get(value.span.file)?.text;
    if text
        .get(value.span.start as usize..value.span.end as usize)?
        .trim()
        != name
        || !source
            .expression_types
            .as_deref()?
            .iter()
            .any(|(node, ty)| node_span(*node) == value.span && ty == &value.ty)
    {
        return None;
    }
    let syntax = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: span.file,
            start: span.start,
            end: span.end,
            kind: SyntaxKind::Let as u8,
        },
        db,
    )?;
    let names = syntax
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Name)
        .collect::<Vec<_>>();
    let [keyword, binding] = names.as_slice() else {
        return None;
    };
    if keyword.token()?.text(text) != "let" {
        return None;
    }
    let authored = syntax
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Member)?;
    if binding.token()?.text(text) != name || authored.span != initializer.span {
        return None;
    }
    super::scenario_calls::checked_original_expression(ir, owner, initializer, db)?;
    let original = stored_reference_operand_inner(ir, owner, initializer, db, 1)?;
    (original.ty == value.ty).then_some(initializer)
}

fn checked_reference_receiver_pairs<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    leaf: &TypedExpr,
    db: &SourceDb,
) -> Option<
    Vec<(
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
        &'a crate::analysis::scenario_disclosure::DisclosureDependency,
    )>,
> {
    let IrExpr::Member { base, field } = &leaf.expr else {
        return None;
    };
    let source_receiver = checked_reference_alias_initializer(ir, owner, base, db).unwrap_or(base);
    let (source_owner, source_id, source_name, source_type, target, guarded) =
        if let Some(source_field) = stored_reference_operand(ir, owner, source_receiver, db) {
            let guarded = checked_narrowed_if_reference(ir, owner, base, db).map(|field| field.id)
                == Some(source_field.id);
            let target = match &source_field.ty {
                ResolvedType::Record {
                    symbol,
                    stored: true,
                } => *symbol,
                ResolvedType::Nullable(inner) if guarded => match inner.as_ref() {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => *symbol,
                    _ => return None,
                },
                _ => return None,
            };
            (
                source_field.owner,
                source_field.id,
                source_field.name.as_str(),
                &source_field.ty,
                target,
                guarded,
            )
        } else {
            // Implicit containment uses the same issued reference bridge as a
            // declared stored field. The original parent getter, schema edge
            // and paired DATA observations must all remain source-owned.
            let (child, parent) = checked_parent_reference(ir, owner, source_receiver, db)?;
            (
                child.id,
                child.id,
                "parent",
                &source_receiver.ty,
                parent.id,
                false,
            )
        };
    let identity_leaf = field == "id" && leaf.ty == ResolvedType::Scalar(Scalar::Text);
    let leaf_field = if identity_leaf {
        let models = super::js::Emitter::source_models(ir, db)?;
        let schema = checked_parameter_row_id(ir, owner, leaf, &models, db)?;
        if schema.id != target || schema.fields.iter().any(|field| field.name == "id") {
            return None;
        }
        target
    } else if guarded
        || matches!(leaf.ty, ResolvedType::Scalar(_))
            && (native_result_type(&leaf.ty) || leaf.ty == ResolvedType::Scalar(Scalar::Timezone))
    {
        let facts = super::scenario_calls::checked_source(ir, owner, db)?;
        let schema = facts
            .stored_contracts
            .as_deref()?
            .iter()
            .find(|schema| schema.model && schema.id == target)?;
        let original = schema
            .fields
            .iter()
            .find(|original| original.name == *field && original.ty == leaf.ty)?;
        reference_receiver_matches(ir, owner, leaf, base, field, db)?;
        match_stored_contract_schema(ir, schema, db)?;
        match_stored_contract_field(ir, original, db)?;
        original.id
    } else {
        let leaf_field = stored_reference_operand(ir, owner, leaf, db)?;
        if leaf_field.owner != target
            || !matches!(leaf_field.ty, ResolvedType::Record { stored: true, .. })
        {
            return None;
        }
        leaf_field.id
    };
    let ScenarioDisclosure::Complete(proof) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let mut pairs = Vec::new();
    for returned in &proof.returns {
        let targets: Vec<_> = returned
            .dependencies
            .iter()
            .filter(|read| {
                node_span(read.node) == leaf.span
                    && read.model == target
                    && read.field == leaf_field
                    && (!identity_leaf
                        || read.role == DependencyRole::Data
                            && read.field_name == "id"
                            && read.type_id == "text")
                    && read.ty == leaf.ty
                    && read.calls.is_empty()
                    && read.query_id.is_none()
            })
            .collect();
        for read in targets {
            let mut sources = returned.dependencies.iter().filter(|source| {
                node_span(source.node) == source_receiver.span
                    && source.model == source_owner
                    && source.field == source_id
                    && source.field_name == source_name
                    && &source.ty == source_type
                    && source.role == read.role
                    && source.source == read.source
                    && source.calls.is_empty()
                    && source.query_id.is_none()
            });
            let source = sources.next()?;
            if sources.next().is_some() || source.id == read.id {
                return None;
            }
            let pair = (source, read);
            if !pairs.contains(&pair) {
                pairs.push(pair);
            }
        }
    }
    (!pairs.is_empty()).then_some(pairs)
}

pub(super) fn stored_reference_operand<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    stored_reference_operand_inner(ir, owner, value, db, 0)
}

fn reference_parent_schema<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    base: &TypedExpr,
    db: &SourceDb,
    depth: usize,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    if matches!(base.expr, IrExpr::Name(_)) {
        let models = super::js::Emitter::source_models(ir, db)?;
        checked_parameter_row_id(ir, owner, base, &models, db)
            .or_else(|| checked_first_query_row(ir, owner, base, db))
    } else if checked_contract_parameter_path(ir, owner, base, Some(db)).is_some() {
        let models = super::js::Emitter::source_models(ir, db)?;
        Some(checked_contract_parameter_row(
            ir, owner, base, &models, db,
        )?)
    } else if owner.canonical == "appointments.remind"
        && let Some(model) = checked_notice_event_row_path(ir, owner, base, db)
    {
        let source = super::scenario_calls::checked_source(ir, owner, db)?;
        let mut schemas = source
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.model && schema.id == model);
        let schema = schemas.next()?;
        if schemas.next().is_some() {
            return None;
        }
        match_stored_contract_schema(ir, schema, db)?;
        Some(schema)
    } else if let Some((_, parent)) = checked_parent_reference(ir, owner, base, db) {
        Some(parent)
    } else {
        let previous = stored_reference_operand_inner(ir, owner, base, db, depth + 1)?;
        let symbol = match &previous.ty {
            ResolvedType::Record {
                symbol,
                stored: true,
            } => *symbol,
            ResolvedType::Nullable(inner)
                if checked_narrowed_if_reference(ir, owner, base, db).map(|field| field.id)
                    == Some(previous.id) =>
            {
                match inner.as_ref() {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => *symbol,
                    _ => return None,
                }
            }
            _ => return None,
        };
        let source = super::scenario_calls::checked_source(ir, owner, db)?;
        let mut targets = source
            .stored_contracts
            .as_deref()?
            .iter()
            .filter(|schema| schema.model && schema.id == symbol);
        let target = targets.next()?;
        if targets.next().is_some() {
            return None;
        }
        match_stored_contract_schema(ir, target, db)?;
        Some(target)
    }
}

fn reference_receiver_matches(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    base: &TypedExpr,
    field: &str,
    db: &SourceDb,
) -> Option<()> {
    // Join the exact original member and receiver, including erased grouping.
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let node = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: value.span.file,
            start: value.span.start,
            end: value.span.end,
            kind: SyntaxKind::Member as u8,
        },
        db,
    )?;
    let mut receiver = node.children.iter().find(|node| {
        matches!(
            node.kind,
            SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group
        )
    })?;
    while receiver.kind == SyntaxKind::Group {
        let children: Vec<_> = receiver
            .children
            .iter()
            .filter(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef | SyntaxKind::Member | SyntaxKind::Group
                )
            })
            .collect();
        let [inner] = children.as_slice() else {
            return None;
        };
        receiver = inner;
    }
    if receiver.span != base.span {
        return None;
    }
    let name = node
        .children
        .iter()
        .rev()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if name.token()?.text(&db.get(value.span.file)?.text) != field
        || !source
            .expression_types
            .as_deref()?
            .iter()
            .any(|(at, ty)| node_span(*at) == value.span && ty == &value.ty)
    {
        return None;
    }
    Some(())
}

/// A direct nullable field at an original flow-narrowed IF occurrence.
/// The source condition, actual arm and declared nullable dependency remain
/// independently checked; only the taken getter receives its target row.
fn checked_narrowed_if_reference<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(root) = &base.expr else {
        return None;
    };
    if !matches!(value.ty, ResolvedType::Record { stored: true, .. }) {
        return None;
    }
    let models = super::js::Emitter::source_models(ir, db)?;
    let parent = checked_parameter_row_id(ir, owner, base, &models, db)?;
    let original = parent
        .fields
        .iter()
        .find(|original| original.name == *field)?;
    if original.ty != ResolvedType::Nullable(Box::new(value.ty.clone())) {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };

    let mut pending = effects.iter().collect::<Vec<_>>();
    let mut steps = 0;
    while let Some(statement) = pending.pop() {
        steps += 1;
        if steps > 16384 {
            return None;
        }
        let IrStmt::If {
            cond,
            then_branch,
            else_branch,
            ..
        } = statement
        else {
            continue;
        };
        pending.extend(then_branch);
        pending.extend(else_branch);
        let (presence, right) = match &cond.expr {
            IrExpr::Binary {
                op: IrBinOp::And,
                left,
                right,
            } => (left.as_ref(), Some(right.as_ref())),
            _ => (cond, None),
        };
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left,
            right: null,
        } = &presence.expr
        else {
            continue;
        };
        if !matches!(null.expr, IrExpr::Null)
            || left.ty != original.ty
            || !matches!(&left.expr,IrExpr::Member{base:receiver,field:member} if member==field && receiver.ty==base.ty && matches!(&receiver.expr,IrExpr::Name(name) if name==root))
        {
            continue;
        }
        let within = |span: Span| {
            span.file == value.span.file
                && span.start <= value.span.start
                && value.span.end <= span.end
        };
        if !right.is_some_and(|right| within(right.span))
            && !then_branch.iter().any(|statement| match statement {
                IrStmt::Require { span, .. }
                | IrStmt::Send { span, .. }
                | IrStmt::Set { span, .. }
                | IrStmt::If { span, .. }
                | IrStmt::Create { span, .. }
                | IrStmt::Return { span, .. }
                | IrStmt::Emit { span, .. } => within(*span),
                _ => false,
            })
        {
            continue;
        }
        if !facts.decision_sites.as_deref()?.iter().any(|site| {
            site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::BodyCondition
                && node_span(site.node) == cond.span
        }) {
            continue;
        }

        super::scenario_calls::checked_original_expression(ir, owner, cond, db)?;
        super::scenario_calls::checked_original_expression(ir, owner, value, db)?;
        match_stored_contract_field(ir, original, db)?;
        return Some(original);
    }
    None
}

/// The checked non-null occurrence belongs to one original direct-field CALL
/// in its source IF arm. Keep the nullable field as the observed dependency;
/// only the actual taken CALL consumes the non-null row reference.
pub(super) fn checked_narrowed_call_reference<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let IrExpr::Name(root) = &base.expr else {
        return None;
    };
    let ResolvedType::Record { stored: true, .. } = value.ty else {
        return None;
    };
    let models = super::js::Emitter::source_models(ir, db)?;
    let parent = checked_parameter_row_id(ir, owner, base, &models, db)?;
    let mut fields = parent
        .fields
        .iter()
        .filter(|original| original.name == *field);
    let original = fields.next()?;
    if fields.next().is_some() || original.ty != ResolvedType::Nullable(Box::new(value.ty.clone()))
    {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    for (position, statement) in effects.iter().enumerate() {
        let IrStmt::If {
            cond, then_branch, ..
        } = statement
        else {
            continue;
        };
        let IrExpr::Binary {
            op: IrBinOp::Ne,
            left,
            right,
        } = &cond.expr
        else {
            continue;
        };
        if !matches!(right.expr, IrExpr::Null)
            || left.ty != original.ty
            || !matches!(&left.expr, IrExpr::Member { base, field: member } if member == field && matches!(&base.expr, IrExpr::Name(name) if name == root))
        {
            continue;
        }
        let [IrStmt::Require { .. }, IrStmt::Call { inputs, span, .. }] = then_branch.as_slice()
        else {
            continue;
        };
        let IrExpr::Object(entries) = &inputs.expr else {
            continue;
        };
        if !entries.iter().any(|(_, input)| input.span == value.span && input.ty == value.ty && matches!(&input.expr, IrExpr::Member { base: receiver, field: member } if member == field && receiver.ty == base.ty && matches!(&receiver.expr, IrExpr::Name(name) if name == root))) { continue; }
        if !source.calls.iter().any(|call| {
            node_span(call.node) == *span
                && call
                    .inputs
                    .iter()
                    .any(|input| node_span(input.node) == value.span && input.ty == value.ty)
        }) || !source.decision_sites.as_deref()?.iter().any(|site| {
            site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::BodyCondition
                && site.position.as_slice()
                    == [
                        crate::analysis::scenario_disclosure::CheckedDecisionPosition::Body(
                            position,
                        ),
                    ]
                && node_span(site.node) == cond.span
        }) {
            continue;
        }
        super::scenario_calls::checked_original_expression(ir, owner, cond, db)?;
        match_stored_contract_field(ir, original, db)?;
        return Some(original);
    }
    None
}

fn reference_member_field<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    parent: &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    field: &str,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let mut fields = parent
        .fields
        .iter()
        .filter(|original| original.name == field);
    let original = fields.next()?;
    let member = ir.items.get(original.id.0 as usize)?;
    let IrItemKind::Field {
        default: None,
        server: None,
        modifiers,
        ..
    } = &member.kind
    else {
        return None;
    };
    let type_id = reference_operand_type_id(ir, &original.ty)?;
    let narrowed = original.ty != value.ty
        && checked_narrowed_call_reference(ir, owner, value, db)
            .or_else(|| checked_narrowed_if_reference(ir, owner, value, db))
            .map(|field| field.id)
            == Some(original.id);
    let declared_value = TypedExpr {
        ty: original.ty.clone(),
        ..value.clone()
    };
    if fields.next().is_some()
        || original.owner != parent.id
        || original.ty != value.ty && !narrowed
        || modifiers.machine
        || !reference_read_matches(
            ir,
            owner,
            if narrowed { &declared_value } else { value },
            parent.id,
            original.id,
            &type_id,
        )
    {
        return None;
    }
    match_stored_contract_field(ir, original, db)?;
    Some(original)
}

fn reference_direct_body(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    base: &TypedExpr,
    db: &SourceDb,
    depth: usize,
) -> Option<bool> {
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    Some(
        depth == 0
            && source
                .source_requires
                .as_deref()
                .is_some_and(|sites| !sites.is_empty())
            && matches!(&owner.kind, IrItemKind::Scenario { effects, params, .. }
            if effects.iter().any(|effect| { let at=match effect {IrStmt::Let{span,..}|IrStmt::If{span,..}|IrStmt::Create{span,..}|IrStmt::Set{span,..}=>*span,_=>return false}; at.file==value.span.file && at.start<=value.span.start && value.span.end<=at.end })
                && params.iter().any(|id| ir.items.get(id.0 as usize).is_some_and(|parameter|
                    matches!(&base.expr,IrExpr::Name(name) if name==&parameter.name)
                        && matches!(&parameter.kind,IrItemKind::Param {owner: declared,default:None,..} if *declared==owner.id)))),
    )
}

fn reference_reused_scope(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    inventory: &[crate::analysis::scenario_disclosure::CheckedStoredContractSchema],
    db: &SourceDb,
) -> Option<()> {
    let reused = original.reuse?;
    let mut scopes = inventory.iter().filter(|schema| {
        !schema.model
            && schema
                .fields
                .iter()
                .any(|field| field.id == reused && field.ty == original.ty)
    });
    let scope = scopes.next()?;
    if scopes.next().is_some() {
        return None;
    }
    match_stored_contract_fields(ir, scope, db)?;
    let (min, max) = (original.min.as_ref()?.1, original.max.as_ref()?.1);
    let reused = scope.fields.iter().find(|field| field.id == reused)?;
    if !(1..=200).contains(&min)
        || max < min
        || max > 200
        || reused.min.as_ref()?.1 != min
        || reused.max.as_ref()?.1 != max
    {
        return None;
    }
    Some(())
}

fn reference_reused_bounds(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    base: &TypedExpr,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    db: &SourceDb,
    depth: usize,
) -> Option<()> {
    // Reused array bounds retain the actual Scope declaration. Target models
    // are checked nominal identities; they do not become recursive row views.
    if !matches!(original.ty, ResolvedType::Array { .. }) {
        return Some(());
    }
    if reference_direct_body(ir, owner, value, base, db, depth)? {
        // A whole declared reference array is copied as data. Its source
        // field authority and canonical type are checked above; it is not
        // the bounded Scope iteration consumer below.
        return Some(());
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let inventory = source.stored_contracts.as_deref()?;
    reference_reused_scope(ir, original, inventory, db)
}

/// A helper guard may consume an already retained DATA getter as CONTROL.
/// Reuse its real companion occurrence; no role is rewritten or synthesized.
fn checked_helper_control_data<'a>(
    context: &'a super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> Option<&'a crate::analysis::scenario_disclosure::DisclosureDependency> {
    if read.role != DependencyRole::Control || read.calls.len() != 1 || read.query_id.is_some() {
        return None;
    }
    context.same_scenario(context.ir(), owner)?;
    let ScenarioDisclosure::Complete(actual) = context.ir().scenario_disclosures.get(&owner.id)?
    else {
        return None;
    };
    let ScenarioDisclosure::Complete(fresh) =
        context.fresh().scenario_disclosures.get(&owner.id)?
    else {
        return None;
    };
    if !super::scenario_feasibility::same_disclosure(actual, fresh) {
        return None;
    }
    let mut companion = None;
    for returned in actual
        .returns
        .iter()
        .filter(|returned| returned.dependencies.contains(read))
    {
        let mut candidates = returned.dependencies.iter().filter(|data| {
            data.role == DependencyRole::Data
                && data.id != read.id
                && data.node == read.node
                && data.calls == read.calls
                && data.source == read.source
                && data.model == read.model
                && data.field == read.field
                && data.model_name == read.model_name
                && data.field_name == read.field_name
                && data.ty == read.ty
                && data.type_id == read.type_id
                && data.query_id == read.query_id
        });
        let data = candidates.next()?;
        if candidates.next().is_some() || companion.is_some_and(|previous| previous != data) {
            return None;
        }
        companion = Some(data);
    }
    companion
}

fn helper_control_scalar(ty: &ResolvedType) -> bool {
    let scalar = match ty {
        ResolvedType::Nullable(inner) => matches!(inner.as_ref(), ResolvedType::Scalar(_)),
        ty => matches!(ty, ResolvedType::Scalar(_) | ResolvedType::Enum { .. }),
    };
    scalar && native_result_type(ty)
}

/// Only a direct checked scalar guard leaf may borrow the retained parent
/// getter's separate CONTROL occurrence. Other Model CONTROL navigation stays
/// outside this profile, even if another DATA path names the same model.
fn helper_control_parent_consumed(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
) -> bool {
    let ResolvedType::Record {
        symbol: parent,
        stored: true,
    } = read.ty
    else {
        return false;
    };
    let Some(ScenarioDisclosure::Complete(proof)) =
        context.ir().scenario_disclosures.get(&owner.id)
    else {
        return false;
    };
    let Some((_, tree)) = context
        .trees()
        .iter()
        .find(|(file, _)| *file == read.node.file)
    else {
        return false;
    };
    proof
        .returns
        .iter()
        .filter(|returned| returned.dependencies.contains(read))
        .all(|returned| {
            returned.dependencies.iter().any(|leaf| {
                if leaf.role != DependencyRole::Control
                    || leaf.model != parent
                    || leaf.calls != read.calls
                    || leaf.source != read.source
                    || leaf.query_id.is_some()
                    || !helper_control_scalar(&leaf.ty)
                    || checked_helper_control_data(context, owner, leaf).is_none()
                {
                    return false;
                }
                let mut pending = vec![tree];
                let mut visits = 0;
                while let Some(node) = pending.pop() {
                    visits += 1;
                    if visits > 16384 {
                        return false;
                    }
                    if node.span.start > leaf.node.start || node.span.end < leaf.node.end {
                        continue;
                    }
                    if NodeKey::of(node) == leaf.node {
                        return node.kind == SyntaxKind::Member
                            && node
                                .children
                                .iter()
                                .find(|part| {
                                    matches!(
                                        part.kind,
                                        SyntaxKind::NameRef
                                            | SyntaxKind::Member
                                            | SyntaxKind::Group
                                    )
                                })
                                .is_some_and(|receiver| NodeKey::of(receiver) == read.node);
                    }
                    pending.extend(node.children.iter().rev());
                }
                false
            })
        })
}

/// The same original helper substitution may observe its stored ChildOf
/// parent. Both original schema owners and the exact parent metadata survive
/// the source/fresh join; the ordinary parent getter retains its authority.
fn checked_helper_parent_reference<'a>(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    value: &TypedExpr,
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
)> {
    let [_] = read.calls.as_slice() else {
        return None;
    };
    context.same_scenario(context.ir(), owner)?;
    if read.role == DependencyRole::Control {
        let data = checked_helper_control_data(context, owner, read)?;
        if !helper_control_parent_consumed(context, owner, read) {
            return None;
        }
        return checked_helper_parent_reference(context, owner, data, value, facts);
    }
    if read.query_id.is_some()
        || read.role != DependencyRole::Data
        || read.field != read.model
        || read.field_name != "parent"
        || value.span != node_span(read.node)
        || value.ty != read.ty
        || !matches!(&value.expr,IrExpr::Member{base,field} if field=="parent" &&
            base.ty==ResolvedType::Record{symbol:read.model,stored:true})
    {
        return None;
    }
    let schemas = facts.stored_contracts.as_deref()?;
    let child = schemas
        .iter()
        .find(|schema| schema.model && schema.id == read.model)?;
    let parent = schemas
        .iter()
        .find(|schema| schema.model && Some(schema.id) == child.parent)?;
    if child.canonical != read.model_name
        || parent.canonical != read.type_id
        || read.ty
            != (ResolvedType::Record {
                symbol: parent.id,
                stored: true,
            })
    {
        return None;
    }
    match_stored_contract_schema(context.ir(), child, context.db())?;
    match_stored_contract_schema(context.ir(), parent, context.db())?;
    Some((child, parent))
}

/// Whole-owner source re-lowering seals the helper call, formal substitution
/// and its identity-only consumer. The retained owning schema still proves
/// the actual stored reference field and target; no copied receiver is added.
fn checked_helper_identity_reference<'a>(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    value: &TypedExpr,
    facts: &'a crate::analysis::scenario_disclosure::CheckedScenarioSource,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    let [_] = read.calls.as_slice() else {
        return None;
    };
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let paired_control = read.role == DependencyRole::Control
        && helper_control_scalar(&read.ty)
        && checked_helper_control_data(context, owner, read).is_some();
    if read.query_id.is_some()
        || read.role != DependencyRole::Data && !paired_control
        || value.span != node_span(read.node)
        || value.ty != read.ty
        || !matches!(&value.expr,IrExpr::Member{base,field}
            if (matches!(base.expr,IrExpr::Name(_)) || matches!(&base.expr,IrExpr::Member{field,..} if field=="parent")) && field==&read.field_name
                && base.ty==ResolvedType::Record{symbol:read.model,stored:true})
    {
        return None;
    }
    let mut schemas = facts
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == read.model);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, schema, context.db())?;
    let mut fields = schema.fields.iter().filter(|field| {
        field.id == read.field && field.ty == read.ty && field.name == read.field_name
    });
    let field = fields.next()?;
    if fields.next().is_some() {
        return None;
    }
    match_stored_contract_field(ir, field, context.db())?;
    Some(field)
}

fn stored_reference_operand_inner<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
    depth: usize,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractField> {
    if depth >= 16 {
        return None;
    }
    if matches!(value.expr, IrExpr::Name(_)) {
        let original = checked_reference_alias_initializer(ir, owner, value, db)?;
        return stored_reference_operand_inner(ir, owner, original, db, depth + 1);
    }
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let parent = reference_parent_schema(ir, owner, base, db, depth)?;
    reference_receiver_matches(ir, owner, value, base, field, db)?;
    let original = reference_member_field(ir, owner, value, parent, field, db)?;
    reference_reused_bounds(ir, owner, value, base, original, db, depth)?;
    Some(original)
}

fn checked_reference_model_result<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    models: &[JsModel],
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let field = stored_reference_operand(ir, owner, value, db)?;
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = field.ty
    else {
        return None;
    };
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let mut schemas = source
        .stored_contracts
        .as_deref()?
        .iter()
        .filter(|schema| schema.model && schema.id == symbol);
    let target = schemas.next()?;
    if schemas.next().is_some() || target.fields.iter().any(|field| field.name == "id") {
        return None;
    }
    match_stored_contract_fields(ir, target, db)?;
    let generated = super::js::Emitter::source_models(ir, db)?;
    let mut expected = generated
        .iter()
        .filter(|model| model.name == target.canonical);
    let mut actual = models.iter().filter(|model| model.name == target.canonical);
    let (expected_descriptor, descriptor) = (expected.next()?, actual.next()?);
    if expected.next().is_some()
        || actual.next().is_some()
        || descriptor.fields.iter().any(|field| field.name == "id")
        || serde_json::to_value(expected_descriptor).ok()?
            != serde_json::to_value(descriptor).ok()?
    {
        return None;
    }
    Some(target)
}

fn reference_operand_type_id(ir: &IrProgram, ty: &ResolvedType) -> Option<String> {
    let (base, array, nullable) = match ty {
        ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } => (element.as_ref(), true, false),
        ResolvedType::Nullable(inner) => (inner.as_ref(), false, true),
        ty => (ty, false, false),
    };
    let ResolvedType::Record {
        symbol,
        stored: true,
    } = base
    else {
        return None;
    };
    let model = ir.items.get(symbol.0 as usize)?;
    (model.id == *symbol && matches!(model.kind, IrItemKind::Model { .. })).then(|| {
        format!(
            "{}{}{}",
            model.canonical,
            if array { "[]" } else { "" },
            if nullable { "?" } else { "" }
        )
    })
}

fn stored_reference_descriptor_matches(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    field: &JsModelField,
) -> bool {
    let Some(type_id) = reference_operand_type_id(ir, &original.ty) else {
        return false;
    };
    let array = matches!(original.ty, ResolvedType::Array { .. });
    let nullable = matches!(original.ty, ResolvedType::Nullable(_));
    let bare = type_id.strip_suffix("[]").unwrap_or(&type_id);
    let base = bare.strip_suffix("?").unwrap_or(bare);
    let bound = |value: &Option<(crate::analysis::NodeKey, i64, DisclosureSource)>| {
        value
            .as_ref()
            .map(|(_, value, _)| serde_json::Value::from(*value))
    };
    // `required` implies non-nullable, so a nullable reference is never
    // create-required; its nullability agreement above carries the check.
    let required = if nullable && !array {
        !field.required
    } else {
        field.required == (!array || original.required_array)
    };
    field.name == original.name
        && matches!(&field.field, JsModelFieldType::Ref { model } if model == base)
        && field.value_type.as_deref() == Some(type_id.as_str())
        && field.nullable == nullable
        && required
        && !field.server_only
        && field.default.is_none()
        && field.machine.is_none()
        && field.array_required == array.then_some(original.required_array)
        && field.trim == original.trim.then_some(true)
        && field.min == bound(&original.min)
        && field.max == bound(&original.max)
}

fn checked_transcript_selected_member(
    ir: &IrProgram,
    owner: &IrItem,
    fact: &crate::analysis::scenario_disclosure::CheckedTranscriptSource,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let IrExpr::Member { base, field } = &value.expr else {
        return None;
    };
    let original = fact
        .fields
        .iter()
        .find(|original| node_span(original.value_node) == value.span)?;
    if ir.items.get(original.source_field.0 as usize)?.name != *field
        || original.ty != value.ty
        || !matches!(&base.expr, IrExpr::Name(name)
            if fact.query.clauses.iter().any(|clause| matches!(&clause.kind,
                crate::analysis::types::CheckedQueryClauseKind::As {name: alias} if alias == name)))
        || base.ty
            != (ResolvedType::Record {
                symbol: fact.model,
                stored: true,
            })
    {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let schema = source
        .stored_contracts
        .as_deref()?
        .iter()
        .find(|schema| schema.id == fact.model && schema.model)?;
    match_stored_contract_schema(ir, schema, db)?;
    let field = schema
        .fields
        .iter()
        .find(|field| field.id == original.source_field)?;
    match_stored_contract_field(ir, field, db)?;
    (field.ty == value.ty && field.source == fact.source).then_some(())
}

fn checked_transcript_prefix_inventory(
    ir: &IrProgram,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: Option<&SourceDb>,
) -> Option<String> {
    let db = db?;
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let fact = source.transcripts.as_deref()?.iter().find(|fact| {
        read.calls == [fact.call]
            && read.node == fact.prefix_node
            && read.model == fact.branch
            && read.field == fact.prefix
            && read.ty == fact.ty
            && read.type_id == "TextMessage[]"
            && read.source == fact.source
            && read.query_id.is_none()
    })?;
    checked_message_prefix_inventory(
        ir,
        descriptor,
        value_types,
        db,
        (fact.branch, fact.prefix, &fact.ty, fact.prefix_max),
    )
}

fn checked_inline_prefix_inventory(
    ir: &IrProgram,
    owner: &IrItem,
    read: &crate::analysis::scenario_disclosure::DisclosureDependency,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: Option<&SourceDb>,
) -> Option<String> {
    let db = db?;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let fact = facts.inline_selections.as_deref()?.iter().find(|fact| {
        read.calls.is_empty()
            && read.node == fact.prefix_node
            && read.model == fact.parent.parent
            && read.field == fact.prefix
            && read.ty == fact.ty
            && read.type_id == "TextMessage[]"
            && read.role == DependencyRole::Data
            && read.source == fact.query.source
            && read.query_id.is_none()
    })?;
    checked_inline_selection_ir(ir, owner, fact, db)?;
    checked_message_prefix_inventory(
        ir,
        descriptor,
        value_types,
        db,
        (fact.parent.parent, fact.prefix, &fact.ty, fact.prefix_max),
    )
}

fn message_prefix_field_valid(
    field: &IrItem,
    prefix_id: crate::analysis::SymbolId,
    branch: &IrItem,
    branch_id: crate::analysis::SymbolId,
    field_owner: &crate::analysis::SymbolId,
    ty: &ResolvedType,
    prefix_ty: &ResolvedType,
    max: &TypedExpr,
    prefix_max: crate::analysis::NodeKey,
    modifiers: &super::ir::IrModifiers,
    descriptor: &JsModelField,
) -> bool {
    field.id == prefix_id
        && field.module == branch.module
        && field_owner == &branch_id
        && field.canonical == format!("{}.{}", branch.canonical, field.name)
        && ty == prefix_ty
        && max.span == node_span(prefix_max)
        && matches!(max.expr, IrExpr::Int(bound) if bound > 0)
        && max.ty == ResolvedType::Scalar(Scalar::Int)
        && modifiers.min.is_none()
        && !modifiers.trim
        && !modifiers.machine
        && descriptor.value_type.as_deref() == Some("TextMessage[]")
        && matches!(&descriptor.field, JsModelFieldType::Nominal { name } if name == "TextMessage")
        && descriptor.array_required == Some(false)
        && !descriptor.nullable
        && !descriptor.server_only
}

fn checked_message_prefix_inventory(
    ir: &IrProgram,
    descriptor: &JsModelField,
    value_types: Option<&JsValueTypes>,
    db: &SourceDb,
    prefix: (
        crate::analysis::SymbolId,
        crate::analysis::SymbolId,
        &ResolvedType,
        crate::analysis::NodeKey,
    ),
) -> Option<String> {
    let (branch_id, prefix_id, prefix_ty, prefix_max) = prefix;
    let branch = ir.items.get(branch_id.0 as usize)?;
    let field = ir.items.get(prefix_id.0 as usize)?;
    let IrItemKind::Field {
        owner: field_owner,
        ty: IrType::Known(ty),
        required_array: false,
        default: None,
        server: None,
        modifiers,
        ..
    } = &field.kind
    else {
        return None;
    };
    let max = modifiers.max.as_ref()?;
    if !message_prefix_field_valid(
        field,
        prefix_id,
        branch,
        branch_id,
        field_owner,
        ty,
        prefix_ty,
        max,
        prefix_max,
        modifiers,
        descriptor,
    ) {
        return None;
    }
    let generated = super::js::Emitter::source_models(ir, db)?;
    let expected = generated
        .iter()
        .find(|model| model.name == branch.canonical)?
        .fields
        .iter()
        .find(|candidate| candidate.name == field.name)?;
    if serde_json::to_value(expected).ok()? != serde_json::to_value(descriptor).ok()? {
        return None;
    }
    let mut emitter = super::js::Emitter::new(ir);
    let expected = emitter.collect_standard_value_inventory(db)?;
    let message = expected
        .contracts
        .iter()
        .find(|contract| contract.name == "TextMessage")?;
    let supplied = value_types?
        .contracts
        .iter()
        .filter(|contract| contract.name == "TextMessage")
        .collect::<Vec<_>>();
    let [supplied] = supplied.as_slice() else {
        return None;
    };
    if serde_json::to_value(message).ok()? != serde_json::to_value(supplied).ok()? {
        return None;
    }
    Some("TextMessage[]".into())
}

/// Only an owning whole stored contract dependency uses this codec. Its local
/// members are already canonical values; neither nominal results nor stored
/// reference views gain admission here.
fn stored_contract_declaration<'i>(
    ir: &'i IrProgram,
    ty: &ResolvedType,
    field: &JsModelField,
    stored: &IrItem,
) -> Option<(&'i IrItem, crate::analysis::SymbolId, bool, bool)> {
    let (ty, nullable) = match ty {
        ResolvedType::Nullable(inner) => (inner.as_ref(), true),
        ty => (ty, false),
    };
    let (ty, array) = match ty {
        ResolvedType::Array {
            element,
            ordered: true,
            nonempty: false,
        } => (element.as_ref(), true),
        ty => (ty, false),
    };
    let IrItemKind::Field {
        required_array: required,
        ..
    } = &stored.kind
    else {
        return None;
    };
    let required = *required;
    let ResolvedType::Record { symbol, .. } = ty else {
        return None;
    };
    let declaration = ir.items.get(symbol.0 as usize)?;
    let IrItemKind::Contract { fields, .. } = &declaration.kind else {
        return None;
    };
    let JsModelFieldType::Nominal { name } = &field.field else {
        return None;
    };
    if declaration.id != *symbol
        || name != &declaration.canonical
        || field.value_type.as_deref()
            != Some(
                format!(
                    "{}{}{}",
                    declaration.canonical,
                    if required {
                        "[]!"
                    } else if array {
                        "[]"
                    } else {
                        ""
                    },
                    if nullable { "?" } else { "" }
                )
                .as_str(),
            )
        || field.nullable != nullable
        || !array && required
        || field.array_required != if array { Some(required) } else { None }
        || field.machine.is_some()
        || fields.is_empty()
        || fields.len() > 200
    {
        return None;
    }
    Some((declaration, *symbol, nullable, array))
}

fn stored_contract_root_schema<'s>(
    ir: &IrProgram,
    source: Option<&'s crate::analysis::scenario_disclosure::CheckedScenarioSource>,
    stored: &IrItem,
    ty: &ResolvedType,
    db: Option<&SourceDb>,
) -> Option<&'s crate::analysis::scenario_disclosure::CheckedStoredContractSchema> {
    let db = db?;
    let inventory = source?.stored_contracts.as_deref()?;
    let mut roots = inventory
        .iter()
        .filter(|schema| schema.model && schema.fields.iter().any(|field| field.id == stored.id));
    let root = roots.next()?;
    if roots.next().is_some() {
        return None;
    }
    match_stored_contract_schema(ir, root, db)?;
    let original = root.fields.iter().find(|field| field.id == stored.id)?;
    match_stored_contract_field(ir, original, db)?;
    if original.ty != *ty {
        return None;
    }
    Some(root)
}

fn stored_contract_leaf_nested(
    ir: &IrProgram,
    inventory: &[crate::analysis::scenario_disclosure::CheckedStoredContractSchema],
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    leaf_value: serde_json::Value,
    db: &SourceDb,
) -> Option<Option<crate::analysis::SymbolId>> {
    match_stored_contract_field(ir, original, db)?;
    let mut constraints = original.constraints.as_ref().map_or_else(
        super::js::JsValueConstraints::default,
        super::js::JsValueConstraints::from,
    );
    if original.trim {
        constraints.trim = Some(true);
    }
    if original.constraints.is_none() {
        let mut base = &original.ty;
        while let ResolvedType::Nullable(inner) = base {
            base = inner;
        }
        let length = matches!(base, ResolvedType::Array { .. })
            || matches!(base, ResolvedType::Scalar(scalar) if scalar.is_string_like());
        let bound = |value: i64| {
            if length {
                serde_json::Value::from(value)
            } else {
                serde_json::Value::String(value.to_string())
            }
        };
        constraints.min = original.min.as_ref().map(|(_, value, _)| bound(*value));
        constraints.max = original.max.as_ref().map(|(_, value, _)| bound(*value));
    }
    let expected = super::js::JsNominalLeaf {
        name: original.name.clone(),
        declared: original.declared.clone(),
        constraints,
    };
    if leaf_value != serde_json::to_value(&expected).ok()? {
        return None;
    }
    let mut base = &original.ty;
    let mut depth = 0;
    while let ResolvedType::Nullable(inner) | ResolvedType::Array { element: inner, .. } = base {
        depth += 1;
        if depth > 64 {
            return None;
        }
        base = inner;
    }
    if let ResolvedType::Record { symbol, .. } = base
        && (inventory
            .iter()
            .any(|schema| !schema.model && schema.id == *symbol)
            || matches!(
                ir.items.get(symbol.0 as usize)?.kind,
                IrItemKind::Contract { .. }
            ))
    {
        return Some(Some(*symbol));
    }
    Some(None)
}

fn stored_contract_schema_for<'s, 'v>(
    inventory: &'s [crate::analysis::scenario_disclosure::CheckedStoredContractSchema],
    value_types: &'v JsValueTypes,
    id: crate::analysis::SymbolId,
) -> Option<(
    &'s crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    &'v super::js::JsNominalResult,
)> {
    let mut schemas = inventory
        .iter()
        .filter(|schema| !schema.model && schema.id == id);
    let schema = schemas.next()?;
    if schemas.next().is_some() {
        return None;
    }
    let mut contracts = value_types
        .contracts
        .iter()
        .filter(|contract| contract.name == schema.canonical);
    let contract = contracts.next()?;
    if contracts.next().is_some() || contract.fields.len() != schema.fields.len() {
        return None;
    }
    Some((schema, contract))
}

fn stored_contract_inventory_type(
    ir: &IrProgram,
    value_types: Option<&JsValueTypes>,
    ty: &ResolvedType,
    field: &JsModelField,
    stored: &IrItem,
    source: Option<&crate::analysis::scenario_disclosure::CheckedScenarioSource>,
    db: Option<&SourceDb>,
    nullable_notice_snapshot: bool,
) -> Option<String> {
    let (declaration, symbol, nullable, array) =
        stored_contract_declaration(ir, ty, field, stored)?;
    if nullable
        && (!nullable_notice_snapshot
            || stored.canonical != "agreements.Term.snapshot"
            || declaration.canonical != "agreements.ExecutedParties")
    {
        return None;
    }
    stored_contract_root_schema(ir, source, stored, ty, db)?;
    let db = db?;
    let inventory = source?.stored_contracts.as_deref()?;
    let value_types = value_types?;
    let mut pending = vec![symbol];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > 200 {
            return None;
        }
        let (schema, contract) = stored_contract_schema_for(inventory, value_types, id)?;
        match_stored_contract_schema(ir, schema, db)?;
        for (original, leaf) in schema.fields.iter().zip(&contract.fields) {
            let leaf_value = serde_json::to_value(leaf).ok()?;
            if let Some(nested) =
                stored_contract_leaf_nested(ir, inventory, original, leaf_value, db)?
            {
                pending.push(nested);
                if pending.len() > 4096 {
                    return None;
                }
            }
        }
    }
    Some(format!(
        "{}{}{}",
        declaration.canonical,
        if array && field.array_required == Some(true) {
            "[]!"
        } else if array {
            "[]"
        } else {
            ""
        },
        if nullable { "?" } else { "" }
    ))
}

fn stored_contract_owner_matches(
    owner: &IrOwner,
    schema: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
) -> bool {
    match owner {
        IrOwner::ChildOf(parent) => {
            schema.parent == Some(*parent)
                && schema.owner == Some(crate::analysis::resolve::ModelOwner::ChildOf(*parent))
        }
        IrOwner::Team => {
            schema.parent.is_none()
                && schema.owner == Some(crate::analysis::resolve::ModelOwner::Team)
        }
        IrOwner::App => {
            schema.parent.is_none()
                && schema.owner == Some(crate::analysis::resolve::ModelOwner::App)
        }
    }
}

pub(super) fn match_stored_contract_schema(
    ir: &IrProgram,
    schema: &crate::analysis::scenario_disclosure::CheckedStoredContractSchema,
    db: &SourceDb,
) -> Option<()> {
    let item = ir.items.get(schema.id.0 as usize)?;
    let fields = match &item.kind {
        IrItemKind::Model { fields, owner, .. }
            if schema.model && stored_contract_owner_matches(owner, schema) =>
        {
            fields
        }
        IrItemKind::Contract { fields, .. }
            if !schema.model && schema.parent.is_none() && schema.owner.is_none() =>
        {
            fields
        }
        _ => return None,
    };
    if item.id != schema.id
        || item.canonical != schema.canonical
        || item.module != schema.module
        || item.span != schema.span
        || fields != &schema.field_order
        || (!schema.model
            && schema
                .fields
                .iter()
                .map(|field| field.id)
                .collect::<Vec<_>>()
                != *fields)
    {
        return None;
    }
    match_stored_contract_source(ir, &schema.source, item.span, db)
}

fn match_contributed_contract_field(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    contributed: &crate::analysis::scenario_disclosure::CheckedScenarioContributedField,
    db: &SourceDb,
) -> Option<()> {
    if contributed.field != original.id
        || contributed.canonical != original.canonical
        || contributed.span != original.span
        || contributed.source != original.source
        || contributed.ty != original.ty
        || contributed.constraints != original.constraints
        || original.required_array
        || original.reuse.is_some()
        || original.min.is_some()
        || original.max.is_some()
    {
        return None;
    }
    super::scenario_create_sources::checked_contributed_field(
        ir,
        ir.items.get(original.owner.0 as usize)?,
        contributed,
        db,
    )
}

pub(super) fn match_stored_contract_field(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    db: &SourceDb,
) -> Option<()> {
    let member = ir.items.get(original.id.0 as usize)?;
    let IrItemKind::Field {
        owner,
        ty: IrType::Known(ty),
        required_array,
        modifiers,
        ..
    } = &member.kind
    else {
        return None;
    };
    if member.id != original.id
        || member.canonical != original.canonical
        || member.name != original.name
        || member.span != original.span
        || *owner != original.owner
        || ty != &original.ty
        || *required_array != original.required_array
        || ir.value_constraints.get(&member.id) != original.constraints.as_ref()
        || modifiers.trim != original.trim
    {
        return None;
    }
    if let Some(contributed) = &original.contributed {
        return match_contributed_contract_field(ir, original, contributed, db);
    }
    if super::scenario_create_sources::checked_stored_field_trait_modifiers(
        ir, original, modifiers, db,
    )? {
        return match_stored_contract_source(ir, &original.source, member.span, db);
    }
    match_contract_field_bounds(ir, modifiers, original, db)?;
    match_stored_contract_source(ir, &original.source, member.span, db)
}

fn match_contract_field_bounds(
    ir: &IrProgram,
    modifiers: &super::ir::IrModifiers,
    original: &crate::analysis::scenario_disclosure::CheckedStoredContractField,
    db: &SourceDb,
) -> Option<()> {
    for (actual, expected) in [
        (&modifiers.min, original.min.as_ref()),
        (&modifiers.max, original.max.as_ref()),
    ] {
        match (actual, expected) {
            (None, None) => {}
            (Some(actual), Some((node, value, source)))
                if actual.span == node_span(*node)
                    && matches!(actual.expr, IrExpr::Int(actual) if actual == i128::from(*value)) =>
            {
                match_stored_contract_source(ir, source, actual.span, db)?;
            }
            _ => return None,
        }
    }
    Some(())
}

fn match_stored_contract_source(
    ir: &IrProgram,
    source: &DisclosureSource,
    span: Span,
    db: &SourceDb,
) -> Option<()> {
    let module = owning_module(ir, span)?;
    let file = db.get(module.file)?;
    (module.name == source.module
        && file.path == source.path
        && file.sha256 == source.sha256
        && file.sha256 == sha256_hex(file.text.as_bytes())
        && span.end as usize <= file.text.len()
        && db
            .iter()
            .filter(|(_, file)| file.path == source.path)
            .count()
            == 1)
        .then_some(())
}

fn valid_choice(
    kind: NativeDecisionKind,
    choice: &DisclosureChoice,
    cases: Option<&HashSet<String>>,
) -> bool {
    match (kind, choice) {
        (
            NativeDecisionKind::ParameterDefault,
            DisclosureChoice::DefaultEvaluated | DisclosureChoice::DefaultProvided,
        ) => true,
        (
            NativeDecisionKind::If
            | NativeDecisionKind::For
            | NativeDecisionKind::QuerySelection
            | NativeDecisionKind::OptionalInput(_),
            DisclosureChoice::Then | DisclosureChoice::Else,
        ) => true,
        (NativeDecisionKind::Match, DisclosureChoice::Match(case)) => {
            cases.is_some_and(|cases| cases.contains(case))
        }
        (
            NativeDecisionKind::And | NativeDecisionKind::Or | NativeDecisionKind::Coalesce,
            DisclosureChoice::RhsEvaluated | DisclosureChoice::RhsSkipped,
        ) => true,
        _ => false,
    }
}

/// The authored mutation Path and the immutable IR must name the same original
/// required input's one parent hop. Parent identity is observed by the receipt;
/// the runtime's existing containment navigation supplies the live bound row.
fn checked_set_parent_receiver(
    ir: &IrProgram,
    owner: &IrItem,
    value: &TypedExpr,
    db: &SourceDb,
) -> Option<()> {
    let path = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: value.span.file,
            start: value.span.start,
            end: value.span.end,
            kind: SyntaxKind::Path as u8,
        },
        db,
    )?;
    let text = &db.get(value.span.file)?.text;
    let names = path
        .children
        .iter()
        .filter(|part| part.kind == SyntaxKind::Name)
        .collect::<Vec<_>>();
    let (root, parents) = names.split_first()?;
    if parents.is_empty() || parents.len() > 2 {
        return None;
    }
    let mut base = value;
    for parent in parents.iter().rev() {
        let IrExpr::Member { base: inner, field } = &base.expr else {
            return None;
        };
        if parent.token()?.text(text) != "parent"
            || field != "parent"
            || base.span != Span::new(path.span.file, path.span.start, parent.span.end)
        {
            return None;
        }
        checked_parent_reference(ir, owner, base, db)?;
        base = inner;
    }
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    if root.token()?.text(text) != name
        || base.span != Span::new(path.span.file, path.span.start, root.span.end)
    {
        return None;
    }
    let source = super::scenario_calls::checked_source(ir, owner, db)?;
    let ResolvedType::Record {
        symbol: child,
        stored: true,
    } = base.ty
    else {
        return None;
    };
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    let mut parameters = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|parameter| parameter.name == *name);
    let parameter = parameters.next()?;
    let IrItemKind::Param {
        owner: parameter_owner,
        index,
        default: None,
        ty: IrType::Known(ty),
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let original = source.parameters.get(*index)?;
    if parameters.next().is_some()
        || *parameter_owner != owner.id
        || original.parameter != parameter.id
        || original.default.is_some()
        || original.ty != *ty
        || base.ty != *ty
        || *ty
            != (ResolvedType::Record {
                symbol: child,
                stored: true,
            })
    {
        return None;
    }
    Some(())
}

/// Every admitted mutation/external site needs one source-checked proof;
/// neither an unused proof nor an unproved executable effect is harmless.
fn match_effect_proofs(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    sites: &Sites<'_>,
    db: Option<&SourceDb>,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<()> {
    if checked.effects.len() > 200 || checked.effects.len() != sites.effects.len() {
        return None;
    }
    let mut matched = HashSet::new();
    for proof in &checked.effects {
        let site = checked_site(proof.node, &[])?;
        if !matched.insert(site.clone())
            || proof.source != checked.source
            || !source_matches(ir, &proof.source, site.span)
            || owning_module(ir, site.span)?.id != owner.module
        {
            return None;
        }
        match (&proof.kind, *sites.effects.get(&site)?) {
            (
                DisclosureEffectKind::Create {
                    model,
                    crud,
                    binding: checked_binding,
                    defaults,
                    inputs: checked_inputs,
                },
                IrStmt::Create {
                    model: actual_model,
                    input,
                    when: None,
                    binding: Some(binding),
                    ..
                },
            ) => {
                let db = db?;
                if crud.is_none() {
                    checked_scenario_create(
                        ir,
                        owner,
                        models,
                        checked,
                        proof,
                        *sites.effects.get(&site)?,
                        db,
                        source_context,
                    )?;
                    continue;
                }
                if !checked_inputs.is_empty() {
                    return None;
                }
                let (model_item, descriptor) =
                    root_effect_model(ir, owner, models, *model, (*crud)?, true)?;
                if checked_created_model_result(ir, owner).is_some() {
                    ordered_created_model_effects(
                        ir,
                        owner,
                        proof.node,
                        *model,
                        checked_binding,
                        db,
                    )?;
                } else {
                    ordered_root_effects(owner, proof.node, *model, checked_binding, db)?;
                }
                let IrItemKind::Model { fields, .. } = &model_item.kind else {
                    return None;
                };
                let authored = checked_effect_node(ir, owner, proof.node, db)?;
                let text = &db.get(proof.node.file)?.text;
                let target = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Path)?;
                let object = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Object)?;
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .filter_map(|node| node.token().map(|token| token.text(text)))
                    .collect();
                if proof.node.kind != SyntaxKind::Create as u8
                    || actual_model != &model_item.canonical
                    || !direct_field_name(binding)
                    || binding != checked_binding
                    || names.as_slice() != ["create", "as", binding.as_str()]
                    || direct_source_path_name(target, text)? != model_item.name
                    || object
                        .children
                        .iter()
                        .any(|node| node.kind == SyntaxKind::ObjectEntry)
                    || input.span != site.span
                    || !matches!(&input.expr, IrExpr::Object(entries) if entries.is_empty())
                    || fields.len() != defaults.len()
                    || descriptor.fields.len() != defaults.len()
                    || defaults.is_empty()
                {
                    return None;
                }
                let mut seen = HashSet::new();
                for ((id, original), emitted) in fields.iter().zip(defaults).zip(&descriptor.fields)
                {
                    let field = ir.items.get(id.0 as usize)?;
                    let IrItemKind::Field {
                        owner: field_owner,
                        ty: IrType::Known(ty),
                        required_array: false,
                        default: Some(IrDefault::Literal(default)),
                        server: None,
                        modifiers,
                        ..
                    } = &field.kind
                    else {
                        return None;
                    };
                    let wire_value = serde_json::to_string(&original.value.to_string()).ok()?;
                    if *id != original.field
                        || field.id != *id
                        || !seen.insert(*id)
                        || field.module != owner.module
                        || *field_owner != *model
                        || field.canonical != format!("{}.{}", model_item.canonical, field.name)
                        || *ty != ResolvedType::Scalar(Scalar::Int)
                        || default.ty != *ty
                        || default.span != node_span(original.default)
                        || original.default.kind != SyntaxKind::Literal as u8
                        || !matches!(default.expr, IrExpr::Int(value) if value == original.value)
                        || modifiers.trim
                        || modifiers.min.is_some()
                        || modifiers.max.is_some()
                        || modifiers.unique
                        || modifiers.machine
                        || emitted.name != field.name
                        || !matches!(emitted.field, JsModelFieldType::Integer)
                        || inventory_type(emitted).as_deref() != Some("int")
                        || emitted.array_required.is_some()
                        || emitted.nullable
                        || emitted.server_only
                        || emitted.required
                        || emitted.machine.is_some()
                        || emitted.trim.is_some()
                        || emitted.min.is_some()
                        || emitted.max.is_some()
                        || !matches!(&emitted.default, Some(JsFieldDefault::Literal(value)) if value == &wire_value)
                    {
                        return None;
                    }
                    match_stored_contract_source(ir, &proof.source, field.span, db)?;
                    match_stored_contract_source(ir, &proof.source, default.span, db)?;
                    if text.get(field.span.start as usize..field.span.end as usize)? != field.name
                        || text
                            .get(default.span.start as usize..default.span.end as usize)?
                            .parse::<i128>()
                            .ok()?
                            != original.value
                    {
                        return None;
                    }
                }
            }
            (
                DisclosureEffectKind::Delete {
                    model,
                    crud,
                    receiver,
                },
                IrStmt::Delete {
                    record,
                    mode: IrDeleteMode::Archive,
                    ..
                },
            ) => {
                let db = db?;
                let (model_item, _) = root_effect_model(ir, owner, models, *model, *crud, false)?;
                let IrItemKind::Scenario {
                    params,
                    effects,
                    result: None,
                    ..
                } = &owner.kind
                else {
                    return None;
                };
                if effects.len() != 1 {
                    return None;
                }
                let authored = checked_effect_node(ir, owner, proof.node, db)?;
                let target = authored
                    .children
                    .iter()
                    .find(|node| node.kind == SyntaxKind::Path)?;
                let IrExpr::Name(name) = &record.expr else {
                    return None;
                };
                if proof.node.kind != SyntaxKind::Delete as u8
                    || receiver.kind != SyntaxKind::Path as u8
                    || crate::analysis::NodeKey::of(target) != *receiver
                    || record.span != node_span(*receiver)
                    || record.ty
                        != (ResolvedType::Record {
                            symbol: model_item.id,
                            stored: true,
                        })
                    || !direct_field_name(name)
                    || direct_source_path_name(target, &db.get(receiver.file)?.text)? != name
                {
                    return None;
                }
                let mut parameters = params.iter().filter_map(|id| {
                    ir.items
                        .get(id.0 as usize)
                        .filter(|parameter| parameter.name == *name)
                });
                let parameter = parameters.next()?;
                let IrItemKind::Param {
                    owner: parameter_owner,
                    index,
                    ty: IrType::Known(ty),
                    default: None,
                    default_node: None,
                    array_bounds: None,
                    ..
                } = &parameter.kind
                else {
                    return None;
                };
                if parameters.next().is_some()
                    || *parameter_owner != owner.id
                    || parameter.module != owner.module
                    || params.get(*index) != Some(&parameter.id)
                    || *ty != record.ty
                    || db
                        .get(parameter.span.file)?
                        .text
                        .get(parameter.span.start as usize..parameter.span.end as usize)?
                        != name
                {
                    return None;
                }
            }
            (
                DisclosureEffectKind::For {
                    domain: checked_domain,
                    limit: checked_limit,
                    maximum,
                    item: checked_item,
                    parameter,
                    model,
                    body: checked_body,
                },
                IrStmt::For {
                    item,
                    domain,
                    limit: Some(limit),
                    body,
                    ..
                },
            ) => {
                let parameter_item = ir.items.get(parameter.0 as usize)?;
                let IrItemKind::Param {
                    owner: parameter_owner,
                    index,
                    ty: IrType::Known(parameter_type),
                    default: None,
                    ..
                } = &parameter_item.kind
                else {
                    return None;
                };
                let IrItemKind::Scenario { params, .. } = &owner.kind else {
                    return None;
                };
                let ResolvedType::Array { element, .. } = parameter_type else {
                    return None;
                };
                let expected_record = ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                };
                let model_item = ir.items.get(model.0 as usize)?;
                if proof.node.kind != SyntaxKind::For as u8
                    || !direct_field_name(item)
                    || item != checked_item
                    || *maximum == 0
                    || *maximum > 200
                    || parameter_item.id != *parameter
                    || *parameter_owner != owner.id
                    || params.get(*index) != Some(parameter)
                    || element.as_ref() != &expected_record
                    || domain.ty != *parameter_type
                    || !matches!(&domain.expr, IrExpr::Name(name) if name == &parameter_item.name)
                    || domain.span != node_span(*checked_domain)
                    || limit.span != node_span(*checked_limit)
                    || limit.ty != ResolvedType::Scalar(Scalar::Int)
                    || !matches!(limit.expr, IrExpr::Int(value) if value == i128::from(*maximum))
                    || model_item.id != *model
                    || model_item.module != owner.module
                    || !matches!(model_item.kind, IrItemKind::Model { .. })
                    || body.is_empty()
                    || body.len() != checked_body.len()
                {
                    return None;
                }
                for (statement, node) in body.iter().zip(checked_body) {
                    let IrStmt::Set {
                        record,
                        changes,
                        when: None,
                        span,
                    } = statement
                    else {
                        return None;
                    };
                    if *span != node_span(*node)
                        || node.kind != SyntaxKind::Set as u8
                        || record.ty != expected_record
                        || !matches!(&record.expr, IrExpr::Name(name) if name == item)
                        || !closed_loop_changes(changes, item, &expected_record, &[])
                    {
                        return None;
                    }
                }
            }
            (
                DisclosureEffectKind::Call {
                    operation,
                    input_keys,
                },
                IrStmt::Call {
                    target:
                        IrEffectCallTarget::Operation {
                            source,
                            operation: actual,
                        },
                    inputs,
                    binding,
                    result,
                    ..
                },
            ) => {
                let target = ir.items.get(operation.0 as usize)?;
                let IrItemKind::Scenario {
                    trusted: false,
                    event_source: None,
                    hook: None,
                    cohort: None,
                    read,
                    expose_excluded: false,
                    result: declared_result,
                    ..
                } = &target.kind
                else {
                    return None;
                };
                let ScenarioDisclosure::Complete(child) = ir.scenario_disclosures.get(operation)?
                else {
                    return None;
                };
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                let query_child =
                    *read && super::scenario_calls::complete_read_query_child(ir, target).is_some();
                let model_child = checked_created_model_result(ir, target).is_some();
                let source_call = checked
                    .source_facts
                    .as_deref()?
                    .calls
                    .iter()
                    .find(|call| call.node == proof.node)?;
                if proof.node.kind != SyntaxKind::Call as u8
                    || operation != actual
                    || target.id != *operation
                    || target.id == owner.id
                    || child.scenario != *operation
                    || result != declared_result
                    || (!query_child
                        && (*read
                            || (binding.is_some() && !model_child)
                            || (!declared_result.as_ref().is_none_or(native_result_type)
                                && !model_child)))
                    || source_call.operation != *operation
                    || source_call.binding != *binding
                    || source_call.result != *result
                    || source_call.inputs.len() != entries.len()
                    || source_call
                        .inputs
                        .iter()
                        .zip(entries)
                        .any(|(fact, (name, value))| {
                            fact.name != *name
                                || fact.ty != value.ty
                                || fact.node.file != value.span.file
                                || fact.node.start != value.span.start
                                || fact.node.end != value.span.end
                        })
                    || source.file != site.span.file
                    || source.start < site.span.start
                    || source.end > site.span.end
                    || owning_module(ir, *source)?.id != owner.module
                    || entries.len() != input_keys.len()
                    || entries
                        .iter()
                        .zip(input_keys)
                        .any(|((key, _), expected)| key != expected)
                    || entries
                        .iter()
                        .map(|(key, _)| key)
                        .collect::<HashSet<_>>()
                        .len()
                        != entries.len()
                {
                    return None;
                }
            }
            (
                DisclosureEffectKind::Set {
                    model,
                    fields,
                    file_inputs,
                },
                IrStmt::Set {
                    record,
                    changes,
                    when: None,
                    ..
                },
            ) => {
                if proof.node.kind != SyntaxKind::Set as u8
                    || !(matches!(record.expr, IrExpr::Name(_))
                        || checked_set_parent_receiver(ir, owner, record, db?).is_some())
                    || record.ty
                        != (ResolvedType::Record {
                            symbol: *model,
                            stored: true,
                        })
                {
                    return None;
                }
                let model_item = ir.items.get(model.0 as usize)?;
                let IrItemKind::Model {
                    fields: own_fields, ..
                } = &model_item.kind
                else {
                    return None;
                };
                if model_item.id != *model || model_item.module != owner.module {
                    return None;
                }
                let IrExpr::Object(entries) = &changes.expr else {
                    return None;
                };
                if entries.len() != fields.len() || fields.is_empty() {
                    return None;
                }
                let mut descriptors = models.iter().filter(|m| m.name == model_item.canonical);
                let descriptor = descriptors.next()?;
                if descriptors.next().is_some() {
                    return None;
                }
                let mut seen_fields = HashSet::new();
                let mut matched_files = HashSet::new();
                for ((name, value), id) in entries.iter().zip(fields) {
                    let field = ir.items.get(id.0 as usize)?;
                    let IrItemKind::Field {
                        owner: field_owner,
                        ty: IrType::Known(ty),
                        required_array,
                        modifiers,
                        ..
                    } = &field.kind
                    else {
                        return None;
                    };
                    if field.id != *id
                        || *field_owner != *model
                        || !own_fields.contains(id)
                        || field.name != *name
                        || !seen_fields.insert(*id)
                        || *required_array
                        || modifiers.machine
                    {
                        return None;
                    }
                    if let Some(schema) = checked
                        .source_facts
                        .as_deref()
                        .and_then(|facts| facts.stored_contracts.as_deref())
                        .and_then(|schemas| schemas.iter().find(|schema| schema.id == *model))
                        && let Some(original) = schema
                            .fields
                            .iter()
                            .find(|field| field.id == *id && field.contributed.is_some())
                    {
                        match_stored_contract_schema(ir, schema, db?)?;
                        match_stored_contract_field(ir, original, db?)?;
                    }
                    let mut declared = descriptor.fields.iter().filter(|f| f.name == *name);
                    let emitted = declared.next()?;
                    let computed_values = source_context.is_some_and(|context| {
                        checked_query_value_assignment(
                            context, owner, model_item, ty, emitted, value, proof.node, db,
                        )
                        .is_some()
                    });
                    if declared.next().is_some()
                        || !(computed_values
                            || assignment_inventory_matches(ir, ty, emitted)
                            || source_context.is_some_and(|context| {
                                checked_declared_delivery_assignment(
                                    context, model_item, ty, emitted, db,
                                )
                                .is_some()
                            }))
                    {
                        return None;
                    }
                    let compatible = computed_values
                        || value.ty == *ty
                        || matches!(ty, ResolvedType::Nullable(inner) if value.ty == **inner || value.ty == ResolvedType::Null);
                    if !compatible {
                        return None;
                    }
                    let base = match ty {
                        ResolvedType::Nullable(inner) => inner.as_ref(),
                        ty => ty,
                    };
                    if *base == ResolvedType::Scalar(Scalar::File) {
                        let mut inputs = file_inputs.iter().filter(|input| input.field == *id);
                        let input = inputs.next()?;
                        if inputs.next().is_some() || !matched_files.insert(input.field) {
                            return None;
                        }
                        file_assignment_input_matches(
                            ir, owner, checked, input, value, proof.node, db?,
                        )?;
                    }
                }
                if matched_files.len() != file_inputs.len() {
                    return None;
                }
            }
            (DisclosureEffectKind::Send { .. }, statement @ IrStmt::Send { .. }) => {
                checked_send_guard(ir, owner, proof, statement, send_guards)?;
            }
            (
                DisclosureEffectKind::ForMember {
                    domain: checked_domain,
                    limit: checked_limit,
                    maximum,
                    item: checked_item,
                    parameter,
                    model,
                    body: checked_body,
                },
                IrStmt::For {
                    item,
                    domain,
                    limit: Some(limit),
                    body,
                    ..
                },
            ) => {
                if source_context
                    .and_then(|context| source_owned_body_loop(context, owner))
                    .is_some_and(|plan| {
                        plan["loops"].as_array().is_some_and(|loops| {
                            loops.iter().any(|entry| {
                                entry["node"]["start"] == proof.node.start
                                    && entry["node"]["end"] == proof.node.end
                            })
                        })
                    })
                {
                    if domain.span!=node_span(*checked_domain)||limit.span!=node_span(*checked_limit)||!matches!(limit.expr,IrExpr::Int(value)if value==i128::from(*maximum))
                        ||item!=checked_item||body.len()!=checked_body.len()||body.iter().zip(checked_body).any(|(stmt,node)|!matches!(stmt,IrStmt::Create{span,..}|IrStmt::If{span,..}|IrStmt::Set{span,..}|IrStmt::Send{span,..}|IrStmt::Cancel{span,..}if *span==node_span(*node))){return None;}
                    continue;
                }
                let sealed_owner = source_context.is_some_and(|context| {
                    checked
                        .source_facts
                        .as_deref()
                        .and_then(|facts| facts.creates.as_deref())
                        .is_some_and(|creates| {
                            creates.len() == 1
                                && source_owned_updated_model_create(context, owner, &creates[0])
                                    .is_some()
                        })
                        || source_owned_void_member_loops(context, owner).is_some()
                });
                let parameter_item = ir.items.get(parameter.0 as usize)?;
                let IrItemKind::Param {
                    owner: parameter_owner,
                    index,
                    ty: IrType::Known(parameter_type),
                    default: None,
                    ..
                } = &parameter_item.kind
                else {
                    return None;
                };
                let IrItemKind::Scenario { params, .. } = &owner.kind else {
                    return None;
                };
                let ResolvedType::Record {
                    symbol: root,
                    stored: true,
                } = parameter_type
                else {
                    return None;
                };
                let expected_record = ResolvedType::Record {
                    symbol: *model,
                    stored: true,
                };
                let expected_domain = ResolvedType::Array {
                    element: Box::new(expected_record.clone()),
                    ordered: true,
                    nonempty: false,
                };
                let root_item = ir.items.get(root.0 as usize)?;
                let model_item = ir.items.get(model.0 as usize)?;
                // Member domains lower to a whole-collection contained scan:
                // the model domain with the root parameter as parent and no
                // filter, order, limit or projection of its own.
                let IrExpr::Query(query) = &domain.expr else {
                    return None;
                };
                let parent = query.parent.as_deref()?;
                let IrExpr::Name(base_name) = &parent.expr else {
                    return None;
                };
                if proof.node.kind != SyntaxKind::For as u8
                    || !direct_field_name(item)
                    || item != checked_item
                    || *maximum == 0
                    || *maximum
                        > if body
                            .iter()
                            .all(|statement| matches!(statement, IrStmt::Emit { .. }))
                        {
                            500
                        } else {
                            200
                        }
                    || parameter_item.id != *parameter
                    || *parameter_owner != owner.id
                    || params.get(*index) != Some(parameter)
                    || parameter_item.module != owner.module
                    || root_item.id != *root
                    || !matches!(root_item.kind, IrItemKind::Model { .. })
                    || base_name != &parameter_item.name
                    || parent.ty
                        != (ResolvedType::Record {
                            symbol: *root,
                            stored: true,
                        })
                    || parent.span.file != domain.span.file
                    || parent.span.start < domain.span.start
                    || parent.span.end > domain.span.end
                    || domain.ty != expected_domain
                    || limit.span != node_span(*checked_limit)
                    || limit.ty != ResolvedType::Scalar(Scalar::Int)
                    || !matches!(limit.expr, IrExpr::Int(value) if value == i128::from(*maximum))
                    || model_item.id != *model
                    || model_item.module != owner.module
                    || !matches!(model_item.kind, IrItemKind::Model { .. })
                    || domain.span != node_span(*checked_domain)
                    || body.is_empty()
                    || body.len() != checked_body.len()
                {
                    return None;
                }
                let super::ir::IrQueryDomain::Model(name) = &query.domain else {
                    return None;
                };
                if name != &model_item.canonical
                    || !(member_scan_query_is_plain(query)
                        && query.source.as_deref().is_none_or(|source|matches!(source.clauses.as_slice(),[clause]
                            if matches!(&clause.kind,crate::analysis::types::CheckedQueryClauseKind::As {name} if name==item)))
                        || sealed_owner && finite_member_filter(query))
                    || query.collection_call.is_some()
                    || query.contract_collection_call.is_some()
                    || query.where_pred.is_some() && !(sealed_owner && finite_member_filter(query))
                    || query.where_async
                    || !query.order.is_empty()
                    || query.value_order.is_some()
                    || query.limit.is_some()
                    || query.archived.is_some()
                    || query.select.is_some()
                    || query.select_param.is_some()
                {
                    return None;
                }
                if source_context
                    .and_then(|context| source_owned_copy_loop(context, owner))
                    .is_some()
                    && matches!(body.as_slice(),[IrStmt::Create{span,..}] if checked_body.len()==1 && *span==node_span(checked_body[0]))
                {
                    continue;
                }
                // Only value-typed owner parameters are element-constant;
                // stored rows keep their per-element refusal above.
                let constants: Vec<String> = params
                    .iter()
                    .filter_map(|id| ir.items.get(id.0 as usize))
                    .filter(|param| {
                        !matches!(
                            &param.kind,
                            IrItemKind::Param {
                                ty: IrType::Known(
                                    ResolvedType::Record { stored: true, .. }
                                        | ResolvedType::Nullable(_)
                                ),
                                ..
                            }
                        )
                    })
                    .map(|param| param.name.clone())
                    .collect();
                for (original_statement, node) in body.iter().zip(checked_body) {
                    let statement = match original_statement {
                        IrStmt::If {
                            then_branch,
                            else_branch,
                            span,
                            ..
                        } if sealed_owner
                            && *span == node_span(*node)
                            && else_branch.is_empty()
                            && then_branch.len() == 1 =>
                        {
                            &then_branch[0]
                        }
                        statement => statement,
                    };
                    if let IrStmt::Emit { payload, span, .. } = statement {
                        let IrExpr::Object(fields) = &payload.expr else {
                            return None;
                        };
                        if *span != node_span(*node)
                            || node.kind != SyntaxKind::Emit as u8
                            || fields.is_empty()
                            || fields.iter().any(|(_, value)| {
                                value.ty != expected_record
                                    || !matches!(&value.expr,IrExpr::Name(name) if name==item)
                            })
                        {
                            return None;
                        }
                        continue;
                    }
                    let IrStmt::Set {
                        record,
                        changes,
                        when: None,
                        span,
                    } = statement
                    else {
                        return None;
                    };
                    if (!sealed_owner || !matches!(original_statement, IrStmt::If { .. }))
                        && (*span != node_span(*node) || node.kind != SyntaxKind::Set as u8)
                        || record.ty != expected_record
                        || !matches!(&record.expr, IrExpr::Name(name) if name == item)
                        || !closed_loop_changes(changes, item, &expected_record, &constants)
                    {
                        return None;
                    }
                }
            }
            (
                DisclosureEffectKind::Emit { event },
                IrStmt::Emit {
                    event: actual,
                    span,
                    ..
                },
            ) => {
                let event_item = ir.items.get(event.0 as usize)?;
                if proof.node.kind != SyntaxKind::Emit as u8
                    || !matches!(event_item.kind, IrItemKind::Event { .. })
                    || event_item.id != *event
                    || event_item.module != owner.module
                    || actual != &event_item.canonical
                {
                    return None;
                }
                let _ = span;
            }
            (
                DisclosureEffectKind::Schedule { event },
                IrStmt::Schedule {
                    event: actual,
                    span,
                    ..
                },
            ) => {
                let event_item = ir.items.get(event.0 as usize)?;
                if proof.node.kind != SyntaxKind::Schedule as u8
                    || !matches!(event_item.kind, IrItemKind::Event { .. })
                    || event_item.id != *event
                    || event_item.module != owner.module
                    || actual != &event_item.canonical
                {
                    return None;
                }
                let _ = span;
            }
            (DisclosureEffectKind::Cancel {}, IrStmt::Cancel { .. }) => {
                if proof.node.kind != SyntaxKind::Cancel as u8 {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(())
}

enum SendGuardHeader<'a> {
    Absent,
    Present(crate::analysis::NodeKey, &'a TypedExpr, Span),
    Mismatch,
}

fn send_guard_header<'s>(
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &'s IrStmt,
) -> SendGuardHeader<'s> {
    let DisclosureEffectKind::Send {
        operation,
        deployment_binding,
        when: original_when,
    } = &proof.kind
    else {
        return SendGuardHeader::Mismatch;
    };
    let IrStmt::Send {
        operation: actual,
        deployment_binding: binding,
        when,
        span,
        ..
    } = statement
    else {
        return SendGuardHeader::Mismatch;
    };
    if proof.node.kind != SyntaxKind::Send as u8
        || node_span(proof.node) != *span
        || operation != actual
        || deployment_binding != binding
        || binding.as_ref().is_none_or(|b| b.is_empty())
    {
        return SendGuardHeader::Mismatch;
    }
    match (original_when, when) {
        (None, None) => SendGuardHeader::Absent,
        (Some(node), Some(predicate)) => SendGuardHeader::Present(*node, predicate, *span),
        _ => SendGuardHeader::Mismatch,
    }
}

fn send_guard_source_matches(
    ir: &IrProgram,
    owner: &IrItem,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    node: crate::analysis::NodeKey,
    predicate: &TypedExpr,
    span: Span,
) -> Option<()> {
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let facts = checked.source_facts.as_deref()?;
    let module = owning_module(ir, span)?;
    if checked.scenario != owner.id
        || facts.scenario != owner.id
        || facts.node != checked.node
        || facts.source != checked.source
        || proof.source != checked.source
        || module.id != owner.module
        || owner.canonical != format!("{}.{}", module.name, owner.name)
        || !source_matches(ir, &proof.source, span)
        || node.file != proof.node.file
        || node.start < proof.node.start
        || node.end > proof.node.end
        || predicate.span.file != node.file
        || predicate.span.start < node.start
        || predicate.span.end > node.end
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    Some(())
}

fn send_guard_site_matches(
    ir: &IrProgram,
    owner: &IrItem,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    node: crate::analysis::NodeKey,
) -> Option<()> {
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let facts = checked.source_facts.as_deref()?;
    let mut original_sites = facts.decision_sites.as_ref()?.iter().filter(|site| {
        site.stage == crate::analysis::scenario_disclosure::CheckedDecisionStage::SendDispatch
            && site.statement == proof.node
    });
    let original = original_sites.next()?;
    if original_sites.next().is_some()
        || original.owner != owner.id
        || original.source != proof.source
        || original.node != node
    {
        return None;
    }
    Some(())
}

fn send_guard_descriptor_matches(
    owner: &IrItem,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    node: crate::analysis::NodeKey,
    span: Span,
    predicate: &TypedExpr,
    statement: &IrStmt,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
) -> Option<()> {
    let IrStmt::Send {
        operation,
        deployment_binding: binding,
        binding: source_binding,
        ..
    } = statement
    else {
        return None;
    };
    let guard = send_guards?.get(&span)?;
    let expected_rule = format!(
        "{}.sendWhen.{}.{}.{}",
        owner.canonical, proof.source.sha256, node.start, node.end
    );
    let descriptor = &guard.descriptor;
    if guard.rule != expected_rule
        || format!("{:?}", guard.predicate) != format!("{predicate:?}")
        || descriptor["rule"] != expected_rule
        || descriptor["owner"] != owner.canonical
        || descriptor["source"]
            != serde_json::json!({
                "path": proof.source.path,
                "sha256": proof.source.sha256,
                "module": proof.source.module,
            })
        || descriptor["node"] != serde_json::json!({"start": node.start, "end": node.end})
        || descriptor["statement"] != serde_json::json!({"start": span.start, "end": span.end})
        || descriptor["target"] != *operation
        || descriptor["binding"] != serde_json::json!(binding)
        || descriptor["sourceBinding"] != serde_json::json!(source_binding)
    {
        return None;
    }
    Some(())
}

fn checked_send_guard(
    ir: &IrProgram,
    owner: &IrItem,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &IrStmt,
    send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
) -> Option<()> {
    let (node, predicate, span) = match send_guard_header(proof, statement) {
        SendGuardHeader::Absent => return Some(()),
        SendGuardHeader::Mismatch => return None,
        SendGuardHeader::Present(node, predicate, span) => (node, predicate, span),
    };
    send_guard_source_matches(ir, owner, proof, node, predicate, span)?;
    send_guard_site_matches(ir, owner, proof, node)?;
    send_guard_descriptor_matches(owner, proof, node, span, predicate, statement, send_guards)
}

/// These two effect proofs admit only the existing root-model constructor and
/// archive operation. Neither containment nor hard removal inherits them.
fn root_effect_identity_valid(
    ir: &IrProgram,
    item: &IrItem,
    model: crate::analysis::SymbolId,
    owner: &IrItem,
    module_name: &str,
    invariants: &[String],
    locks: &[String],
    uniques: &[super::ir::IrUnique],
    actual_crud: &crate::analysis::SymbolId,
    crud: crate::analysis::SymbolId,
    declaration: &IrItem,
    declared_model: &crate::analysis::SymbolId,
    creating: bool,
    create: &bool,
    delete: &bool,
) -> bool {
    item.id == model
        && item.module == owner.module
        && direct_field_name(&item.name)
        && item.canonical == format!("{module_name}.{}", item.name)
        && invariants.is_empty()
        && locks.is_empty()
        && uniques.is_empty()
        && !ir.items.iter().any(|candidate| {
            matches!(&candidate.kind, IrItemKind::Scenario { hook: Some(hook), .. }
                if hook.model == model)
        })
        && *actual_crud == crud
        && declaration.id == crud
        && declaration.module == owner.module
        && declaration.canonical == format!("{}.crud", item.canonical)
        && *declared_model == model
        && (if creating { *create } else { *delete })
        && !ir.crud_when.iter().any(|guard| guard.name == item.name)
}

fn root_effect_model<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    models: &'a [JsModel],
    model: crate::analysis::SymbolId,
    crud: crate::analysis::SymbolId,
    creating: bool,
) -> Option<(&'a IrItem, &'a JsModel)> {
    let item = ir.items.get(model.0 as usize)?;
    let declaration = ir.items.get(crud.0 as usize)?;
    let IrItemKind::Model {
        owner: IrOwner::Team,
        crud: Some(actual_crud),
        invariants,
        locks,
        uniques,
        retain: None,
        ..
    } = &item.kind
    else {
        return None;
    };
    let IrItemKind::Crud {
        model: declared_model,
        create,
        delete,
        ..
    } = &declaration.kind
    else {
        return None;
    };
    let module = ir.modules.get(owner.module.0 as usize)?;
    if !root_effect_identity_valid(
        ir,
        item,
        model,
        owner,
        &module.name,
        invariants,
        locks,
        uniques,
        actual_crud,
        crud,
        declaration,
        declared_model,
        creating,
        create,
        delete,
    ) {
        return None;
    }
    let operation = if creating {
        crate::analysis::resolve::CrudOp::Create
    } else {
        crate::analysis::resolve::CrudOp::Delete
    };
    let mut operations = ir.items.iter().filter(|candidate| {
        matches!(&candidate.kind, IrItemKind::CrudOp { model: target, op, .. }
            if *target == model && *op == operation)
    });
    let operation_item = operations.next()?;
    let IrItemKind::CrudOp {
        has_when: false,
        delete_mode,
        ..
    } = &operation_item.kind
    else {
        return None;
    };
    if operations.next().is_some()
        || operation_item.module != owner.module
        || (!creating && *delete_mode != IrDeleteMode::Archive)
    {
        return None;
    }
    let mut descriptors = models
        .iter()
        .filter(|descriptor| descriptor.name == item.canonical);
    let descriptor = descriptors.next()?;
    if descriptors.next().is_some()
        || descriptor.parent.is_some()
        || descriptor.scope_app
        || !descriptor.unique_keys.is_empty()
        || (!creating && descriptor.delete_mode != "archive")
    {
        return None;
    }
    Some((item, descriptor))
}

/// Match this scenario's original populated/contained constructor. The owning
/// schema supplies defaults and server fields; source supplies explicit operands.
fn scenario_create_identity<'f, 's, 'p>(
    proof: &'p crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &'s IrStmt,
    facts: &'f crate::analysis::scenario_disclosure::CheckedScenarioSource,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
) -> Option<(
    &'f crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    &'s TypedExpr,
    Span,
    &'p String,
    &'p crate::analysis::SymbolId,
)> {
    let DisclosureEffectKind::Create {
        model,
        crud: None,
        binding,
        defaults,
        inputs,
    } = &proof.kind
    else {
        return None;
    };
    let IrStmt::Create {
        model: target,
        input,
        binding: Some(actual),
        when: None,
        span,
    } = statement
    else {
        return None;
    };
    let mut sources = facts
        .creates
        .as_deref()?
        .iter()
        .filter(|source| source.node == proof.node);
    let original = sources.next()?;
    if sources.next().is_some()
        || !defaults.is_empty()
        || original.source != checked.source
        || proof.source != checked.source
        || original.model != *model
        || original.binding != *binding
        || original.inputs != *inputs
        || actual != binding
        || *span != node_span(proof.node)
        || input.span != *span
        || target != &original.definition.canonical
        || !direct_field_name(binding)
    {
        return None;
    }
    Some((original, input, *span, binding, model))
}

/// The complete original target-only FIRST branch has an independently
/// sealed source/fresh closure. Its contained-loop suffix cannot transport
/// the selected row; each effect still passes the ordinary schema/site gate.
fn checked_first_target_branch_create(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let [query] = checked.source_facts.as_deref()?.queries.as_deref()? else {
        return None;
    };
    if !query.first.as_ref()?.target_consumed {
        return None;
    }
    let IrItemKind::Scenario {
        effects,
        result: None,
        read: false,
        trusted: false,
        event_source: None,
        hook: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Let { span: binding, .. },
        IrStmt::If {
            then_branch,
            else_branch,
            ..
        },
        suffix @ ..,
    ] = effects.as_slice()
    else {
        return None;
    };
    let [IrStmt::Create { span, .. }] = then_branch.as_slice() else {
        return None;
    };
    if *binding != node_span(query.first.as_ref()?.binding)
        || *span != node_span(original.node)
        || !matches!(else_branch.as_slice(), [IrStmt::Set { when: None, .. }])
        || suffix.iter().any(|statement| {
            !matches!(statement,IrStmt::For {body,..}
            if matches!(body.as_slice(),[IrStmt::Emit {..}]))
        })
    {
        return None;
    }
    Some(())
}

/// One terminal enum-input branch may create a row and immediately link it
/// to the original admitted input. The complete original owner is compared
/// against a fresh lowering; the independent effect/schema checks still
/// validate every SET, CANCEL and CREATE. This supplies no query authority.
fn conditional_parameter_create_link(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        params,
        guards,
        effects,
        result: None,
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [IrStmt::Require { .. }] = guards.as_slice() else {
        return None;
    };
    let [
        IrStmt::Set { record: first, .. },
        IrStmt::Cancel { key, .. },
        IrStmt::If {
            cond,
            then_branch,
            else_branch,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Create {
            binding: Some(created),
            span,
            ..
        },
        IrStmt::Set {
            record: linked,
            changes,
            when: None,
            ..
        },
    ] = then_branch.as_slice()
    else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    // Both references come from this same immutable checked-source table:
    // fresh lowering above proves semantics, never allocation identity.
    let [created_fact] = facts.creates.as_deref()? else {
        return None;
    };
    if !else_branch.is_empty()
        || *span != node_span(original.node)
        || !std::ptr::eq(created_fact, original)
        || *created != original.binding
        || facts.source_requires.as_deref()?.len() != 1
    {
        return None;
    }
    let IrExpr::Name(root_name) = &first.expr else {
        return None;
    };
    let IrExpr::Name(linked_name) = &linked.expr else {
        return None;
    };
    let IrExpr::Member {
        base: cancelled,
        field,
    } = &key.expr
    else {
        return None;
    };
    if root_name != linked_name
        || first.ty != linked.ty
        || field != "id"
        || !matches!(&cancelled.expr, IrExpr::Name(name) if name == root_name)
        || cancelled.ty != first.ty
    {
        return None;
    }
    let root = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|item| item.name == *root_name)?;
    if !matches!(&root.kind, IrItemKind::Param { owner: id, ty: IrType::Known(ty), default: None, .. }
        if *id == owner.id && *ty == first.ty && matches!(ty, ResolvedType::Record { stored: true, .. }))
    {
        return None;
    }
    let IrExpr::Binary {
        op: IrBinOp::In,
        left,
        right,
    } = &cond.expr
    else {
        return None;
    };
    let IrExpr::Name(input) = &left.expr else {
        return None;
    };
    let ResolvedType::Enum { cases, .. } = &left.ty else {
        return None;
    };
    let IrExpr::Array(values) = &right.expr else {
        return None;
    };
    let parameter = params
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .find(|item| item.name == *input)?;
    if values.is_empty() || values.len() > cases.len()
        || !matches!(&parameter.kind, IrItemKind::Param { owner: id, ty: IrType::Known(ty), default: None, .. }
            if *id == owner.id && *ty == left.ty)
        || values.iter().any(|value| value.ty != left.ty ||
            !matches!(&value.expr, IrExpr::Text(name) | IrExpr::Name(name) if cases.contains(name))) {
        return None;
    }
    let IrExpr::Object(entries) = &changes.expr else {
        return None;
    };
    let [(field, value)] = entries.as_slice() else {
        return None;
    };
    if !matches!(&value.expr, IrExpr::Name(name) if name == created)
        || value.ty
            != (ResolvedType::Record {
                symbol: original.model,
                stored: true,
            })
    {
        return None;
    }
    let ResolvedType::Record {
        symbol: target,
        stored: true,
    } = linked.ty
    else {
        return None;
    };
    let IrItemKind::Model { fields, .. } = &ir.items.get(target.0 as usize)?.kind else {
        return None;
    };
    if !fields.iter().any(|id| {
        ir.items.get(id.0 as usize).is_some_and(|item| {
            item.name == *field
                && matches!(&item.kind, IrItemKind::Field { ty: IrType::Known(ty), .. }
            if *ty == ResolvedType::Nullable(Box::new(value.ty.clone())))
        })
    }) {
        return None;
    }
    Some(())
}

/// A private original-source loop seal for contained sibling constructors.
/// Every selected reference and ordinary CREATE keeps its own runtime authority.
fn source_owned_sibling_loop(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<serde_json::Value> {
    let plan = source_owned_body_loop(context, owner)?;
    plan["loops"]
        .as_array()?
        .iter()
        .all(|entry| entry["sends"] == 0)
        .then_some(plan)
}

/// Shared fresh-source seal for finite constructors or original SEND/Work bodies.
fn source_owned_body_loop(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<serde_json::Value> {
    let checked = super::scenario_calls::checked_source(context.ir(), owner, context.db())?;
    let source = serde_json::json!({"path":checked.source.path,"sha256":checked.source.sha256});
    super::source_loops::collect_native(context.ir(), owner, context, &source, "")
}

/// Exact source-owned same-model copy loop after a completed Model child.
/// Ordinary schema/rule/lock staging remains mandatory for each CREATE.
fn source_owned_copy_loop(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<serde_json::Value> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        result: None,
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Call {
            target: super::ir::IrEffectCallTarget::Operation { operation, .. },
            binding: Some(result),
            result: Some(result_type),
            span: call,
            ..
        },
        IrStmt::Set { .. },
        IrStmt::For {
            item,
            domain,
            limit: Some(limit),
            body,
            span,
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Create {
            model,
            input,
            binding: Some(_),
            when: None,
            span: created,
            ..
        },
    ] = body.as_slice()
    else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let [original] = facts.creates.as_deref()? else {
        return None;
    };
    if node_span(original.node) != *created
        || ir.items.get(original.model.0 as usize)?.canonical != *model
    {
        return None;
    }
    let parameter = contained_member_scan_parent(ir, owner, domain, *span, false)?;
    if &parameter.ty != result_type {
        return None;
    }
    let IrExpr::Object(inputs) = &input.expr else {
        return None;
    };
    let [(parent_name, parent), fields @ ..] = inputs.as_slice() else {
        return None;
    };
    if parent_name != "parent"
        || parent.ty != *result_type
        || !matches!(&parent.expr,IrExpr::Name(name)if name==result)
        || fields.is_empty()
        || fields.len() > 200
        || fields.len() + 1 != original.inputs.len()
    {
        return None;
    }
    let mut copied = Vec::new();
    for ((name, value), source) in fields.iter().zip(&original.inputs[1..]) {
        let IrExpr::Member { base, field } = &value.expr else {
            return None;
        };
        let ResolvedType::Scalar(scalar) = value.ty else {
            return None;
        };
        if !supported_type_id(scalar.as_str())
            || scalar == Scalar::User
            || name != field
            || name != &source.name
            || source.ty != value.ty
            || base.ty
                != (ResolvedType::Record {
                    symbol: original.model,
                    stored: true,
                })
            || !matches!(&base.expr,IrExpr::Name(name)if name==item)
        {
            return None;
        }
        copied.push(serde_json::json!({"name":name,"type":scalar.as_str(),
            "node":{"start":source.value_node.start,"end":source.value_node.end}}));
    }
    let IrExpr::Int(maximum) = limit.expr else {
        return None;
    };
    if !(1..=200).contains(&maximum) {
        return None;
    }
    Some(
        serde_json::json!({"node":{"start":created.start,"end":created.end},
        "call":{"start":call.start,"end":call.end},"parent":result,"model":model,
        "target":ir.items.get(operation.0 as usize)?.canonical,"fields":copied}),
    )
}

/// A finite contained update prefix may precede its own created Model result.
/// Fresh source correspondence seals control flow and every operand; individual
/// loop, assignment, constructor schema and return checks remain mandatory.
fn source_owned_updated_model_create(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        result:
            Some(ResolvedType::Record {
                symbol: model,
                stored: true,
            }),
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::For { .. },
        IrStmt::Let { .. },
        IrStmt::Set { .. },
        IrStmt::Create {
            span,
            binding: Some(binding),
            when: None,
            ..
        },
        IrStmt::Return {
            value: Some(value), ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    if *model != original.model
        || *span != node_span(original.node)
        || binding != &original.binding
        || value.ty
            != (ResolvedType::Record {
                symbol: *model,
                stored: true,
            })
        || !matches!(&value.expr, IrExpr::Name(name) if name == binding)
    {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let [created] = facts.creates.as_deref()? else {
        return None;
    };
    (std::ptr::eq(created, original)).then_some(())
}

/// A source-owned report constructor may follow one nullable-field child
/// CALL and precede its original completion effects. The fresh whole-owner
/// join seals surrounding operands; each effect, schema and File input still
/// needs its independent native proof below.
fn source_owned_after_call_create(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        result: None,
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::If {
            then_branch,
            else_branch,
            ..
        },
        IrStmt::Create {
            span,
            binding: Some(binding),
            when: None,
            ..
        },
        IrStmt::Set { .. },
        IrStmt::Emit { .. },
        IrStmt::Send {
            when: None,
            binding: Some(_),
            ..
        },
        IrStmt::Set { .. },
        IrStmt::Send {
            when: Some(_),
            binding: Some(_),
            ..
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [IrStmt::Require { .. }, IrStmt::Call { inputs, .. }] = then_branch.as_slice() else {
        return None;
    };
    if !matches!(else_branch.as_slice(), [IrStmt::Require { .. }])
        || *span != node_span(original.node)
        || binding != &original.binding
    {
        return None;
    }
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let [created] = facts.creates.as_deref()? else {
        return None;
    };
    if !std::ptr::eq(created, original) || facts.source_requires.as_deref()?.len() != 1 {
        return None;
    }
    let IrExpr::Object(entries) = &inputs.expr else {
        return None;
    };
    entries
        .iter()
        .any(|(_, value)| checked_narrowed_call_reference(ir, owner, value, context.db()).is_some())
        .then_some(())
}

/// Original void parent mutations may retain the same bounded sibling-loop
/// port as an updated-model result. This source seal grants no collection or
/// field authority; each loop, effect and schema keeps its independent join.
fn source_owned_void_member_loops(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        result: None,
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let mut loops = 0;
    for effect in effects {
        match effect {
            IrStmt::Set { when: None, .. } | IrStmt::Cancel { .. } => {}
            IrStmt::For { body, span, .. } => {
                let ScenarioDisclosure::Complete(checked) =
                    ir.scenario_disclosures.get(&owner.id)?
                else {
                    return None;
                };
                if !checked.effects.iter().any(|effect| {
                    node_span(effect.node) == *span
                        && matches!(effect.kind, DisclosureEffectKind::ForMember { .. })
                }) {
                    return None;
                }
                loops += 1;
                if body.is_empty()
                    || !body.iter().all(|statement| match statement {
                        IrStmt::Set { when: None, .. } => true,
                        IrStmt::If {
                            then_branch,
                            else_branch,
                            ..
                        } => {
                            else_branch.is_empty()
                                && matches!(
                                    then_branch.as_slice(),
                                    [IrStmt::Set { when: None, .. }]
                                )
                        }
                        _ => false,
                    })
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    (loops > 0).then_some(())
}

/// A private constructor input is a once-only original DATA occurrence, never
/// a viewer field grant. Its scalar can only enter the first authored CREATE;
/// State seals the observed required path against that actual staged field.
pub(super) fn constructor_inputs(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    transport: &ReceiptSource,
) -> Option<serde_json::Value> {
    let ir = context.ir();
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let created = facts.creates.as_deref()?.first()?;
    source_owned_void_create(context, owner, created)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    let position = effects
        .iter()
        .position(|statement| matches!(statement, IrStmt::Create { .. }))?;
    if !effects[..position]
        .iter()
        .all(|statement| matches!(statement, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    let IrStmt::Create { input, span, .. } = &effects[position] else {
        return None;
    };
    if *span != node_span(created.node) {
        return None;
    }
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let models = super::js::Emitter::source_models(ir, context.db())?;
    let mut inputs = Vec::new();
    for (sink, leaf) in entries {
        let IrExpr::Member {
            base: reference,
            field: leaf_name,
        } = &leaf.expr
        else {
            continue;
        };
        if !matches!(leaf.ty, ResolvedType::Scalar(_)) || !native_result_type(&leaf.ty) {
            continue;
        }
        let IrExpr::Member {
            base: receiver,
            field: reference_name,
        } = &reference.expr
        else {
            continue;
        };
        let mut root = receiver.as_ref();
        let mut parents = Vec::new();
        while let IrExpr::Member { base, field } = &root.expr {
            if field != "parent" || parents.len() >= 2 {
                break;
            }
            let ResolvedType::Record {
                symbol,
                stored: true,
            } = &root.ty
            else {
                break;
            };
            parents.push(ir.items.get(symbol.0 as usize)?.canonical.clone());
            root = base;
        }
        let IrExpr::Name(parameter) = &root.expr else {
            continue;
        };
        let Some(root_schema) = checked_parameter_row_id(ir, owner, root, &models, context.db())
        else {
            continue;
        };
        let Some((_, source_schema)) = checked_parent_reference(ir, owner, receiver, context.db())
            .or_else(|| (receiver.span == root.span).then_some((root_schema, root_schema)))
        else {
            continue;
        };
        let Some(source_field) = stored_reference_operand(ir, owner, reference, context.db())
        else {
            continue;
        };
        let ResolvedType::Record {
            symbol: target,
            stored: true,
        } = &source_field.ty
        else {
            continue;
        };
        if source_field.owner != source_schema.id {
            continue;
        }
        let Some(pairs) = checked_reference_receiver_pairs(ir, owner, leaf, context.db()) else {
            continue;
        };
        let Some(original) = created.inputs.iter().find(|value| {
            value.name == *sink && node_span(value.value_node) == leaf.span && value.ty == leaf.ty
        }) else {
            continue;
        };
        if original.field.is_none() {
            continue;
        }
        parents.reverse();
        for (source, scalar) in pairs {
            if source.role != DependencyRole::Data || scalar.role != DependencyRole::Data {
                continue;
            }
            inputs.push(serde_json::json!({"owner":owner.canonical,"source":transport,
                "parameter":parameter,"rootModel":root_schema.canonical,"parents":parents,
                "sourceDependencyId":source.id,"sourceModel":source_schema.canonical,"sourceField":reference_name,
                "leafDependencyId":scalar.id,"leafModel":ir.items.get(target.0 as usize)?.canonical,
                "leafField":leaf_name,"type":scalar.type_id,
                "create":{"start":span.start,"end":span.end},"model":created.definition.canonical,"field":sink}));
        }
    }
    inputs.sort_by_key(|value| {
        value["sourceDependencyId"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    });
    inputs.dedup();
    (!inputs.is_empty()).then_some(serde_json::Value::Array(inputs))
}

/// A complete public void owner may construct its original rows before a
/// finite SEND/SET/SCHEDULE tail. The fresh whole-owner join seals every
/// original operand and branch, including schedule owner, key, instant and
/// payload. The effect census and declared-event checks remain independent;
/// this shape proof grants no query, row or scheduling authority.
fn source_owned_void_create(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrItemKind::Scenario {
        result: None,
        trusted: false,
        read: false,
        hook: None,
        event_source: None,
        cohort: None,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let creates = facts.creates.as_deref()?;
    if creates.is_empty()
        || creates.len() > 200
        || !creates.iter().any(|value| std::ptr::eq(value, original))
    {
        return None;
    }
    fn create_sites<'a>(
        body: &'a [IrStmt],
        depth: usize,
        sites: &mut Vec<(Span, &'a String)>,
    ) -> Option<()> {
        if depth >= 64 {
            return None;
        }
        for statement in body {
            match statement {
                IrStmt::Create {
                    span,
                    binding: Some(binding),
                    when: None,
                    ..
                } => sites.push((*span, binding)),
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    create_sites(then_branch, depth + 1, sites)?;
                    create_sites(else_branch, depth + 1, sites)?;
                }
                _ => {}
            }
        }
        Some(())
    }
    let mut top = Vec::new();
    create_sites(effects, 0, &mut top)?;
    if source_owned_sibling_loop(context, owner).is_some() {
        let IrStmt::For { body, .. } = effects.last()? else {
            return None;
        };
        let body = match body.as_slice() {
            [
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                },
            ] if else_branch.is_empty() => then_branch.as_slice(),
            body => body,
        };
        let [
            IrStmt::Create {
                span,
                binding: Some(binding),
                when: None,
                ..
            },
        ] = body
        else {
            return None;
        };
        let mut census = top.clone();
        census.push((*span, binding));
        if census.len() != creates.len()
            || !census.iter().zip(creates).all(|((span, binding), source)| {
                *span == node_span(source.node) && **binding == source.binding
            })
        {
            return None;
        }
        return Some(());
    }
    if top.len() != creates.len()
        || !top.iter().zip(creates).all(|((span, binding), source)| {
            *span == node_span(source.node) && **binding == source.binding
        })
    {
        return None;
    }
    fn closed(body: &[IrStmt], depth: usize) -> bool {
        depth < 64
            && body.iter().all(|statement| match statement {
                IrStmt::Let { .. }
                | IrStmt::Require { .. }
                | IrStmt::Set { when: None, .. }
                | IrStmt::Send {
                    binding: Some(_), ..
                }
                | IrStmt::Emit { .. }
                | IrStmt::Cancel { .. }
                | IrStmt::Schedule { .. } => true,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => closed(then_branch, depth + 1) && closed(else_branch, depth + 1),
                IrStmt::Create {
                    binding: Some(_),
                    when: None,
                    ..
                } => true,
                _ => false,
            })
    }
    closed(effects, 0).then_some(())
}

/// A complete source-owned single-creation result may retain its finite
/// conditional SEND/SET/EMIT tail. Re-lowering the entire original owner seals
/// every ordered condition and operand; this grants no query or row authority.
fn source_owned_created_return_tail(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> Option<()> {
    context.same_scenario(context.ir(), owner)?;
    created_return_tail_shape(context.ir(), owner, original, context.db())
}

fn created_return_tail_shape(
    ir: &IrProgram,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<()> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let creates = facts.creates.as_deref()?;
    if creates.len() > 1 {
        return created_return_branches_shape(ir, owner, original, db);
    }
    let [created] = creates else {
        return None;
    };
    if !std::ptr::eq(created, original)
        || checked_created_model_result(ir, owner) != Some(original.model)
    {
        return None;
    }
    ordered_created_model_effects(
        ir,
        owner,
        original.node,
        original.model,
        &original.binding,
        db,
    )
}

/// Returned constructors retain one actual result identity on every branch.
/// Auxiliary constructors of other Models leave that identity unchanged. This
/// proves topology only; ordinary schema, operand and effect checks still run.
fn created_return_branches_shape(
    ir: &IrProgram,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::scenario_disclosure::CheckedScenarioDisclosure;
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let creates = facts.creates.as_deref()?;
    let result_model = checked_created_model_result(ir, owner)?;
    let result_creates = creates
        .iter()
        .filter(|source| source.model == result_model)
        .collect::<Vec<_>>();
    if !(2..=200).contains(&creates.len())
        || !creates.iter().any(|source| std::ptr::eq(source, original))
        || result_creates.is_empty()
    {
        return None;
    }
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let returned = checked
        .returns
        .iter()
        .filter_map(|returned| match returned.model_result {
            Some(DisclosureModelResult::Create { model, node }) if model == result_model => {
                Some(node)
            }
            _ => None,
        })
        .collect::<HashSet<_>>();
    if returned.len() != result_creates.len()
        || result_creates
            .iter()
            .any(|source| !returned.contains(&source.node))
    {
        return None;
    }
    fn walk(
        statements: &[IrStmt],
        mut states: Vec<Option<crate::analysis::NodeKey>>,
        checked: &CheckedScenarioDisclosure,
        creates: &[crate::analysis::scenario_disclosure::CheckedScenarioCreate],
        result_model: crate::analysis::SymbolId,
        depth: usize,
        steps: &mut usize,
    ) -> Option<Vec<Option<crate::analysis::NodeKey>>> {
        if depth > 64 {
            return None;
        }
        for statement in statements {
            *steps += 1;
            if *steps > 16384 || states.len() > 1024 {
                return None;
            }
            match statement {
                IrStmt::Let { .. }
                | IrStmt::Require { .. }
                | IrStmt::Set { .. }
                | IrStmt::Send { .. }
                | IrStmt::Emit { .. }
                | IrStmt::Schedule { .. } => {}
                IrStmt::Create { span, .. } => {
                    let source = creates
                        .iter()
                        .find(|source| node_span(source.node) == *span)?;
                    if source.model != result_model {
                        continue;
                    }
                    if states.iter().any(Option::is_some) {
                        return None;
                    }
                    states.fill(Some(source.node));
                }
                IrStmt::Return {
                    value: Some(_),
                    span,
                } => {
                    for state in &states {
                        let selected = (*state)?;
                        if !checked.returns.iter().any(|returned|node_span(returned.node)==*span
                            && matches!(returned.model_result,Some(DisclosureModelResult::Create {node,..}) if node==selected)) {return None;}
                    }
                    states.clear();
                }
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => {
                    let mut next = walk(
                        then_branch,
                        states.clone(),
                        checked,
                        creates,
                        result_model,
                        depth + 1,
                        steps,
                    )?;
                    for state in walk(
                        else_branch,
                        states,
                        checked,
                        creates,
                        result_model,
                        depth + 1,
                        steps,
                    )? {
                        if !next.contains(&state) {
                            next.push(state);
                        }
                    }
                    states = next;
                }
                _ => return None,
            }
        }
        Some(states)
    }
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    walk(
        effects,
        vec![None],
        checked,
        creates,
        result_model,
        0,
        &mut 0,
    )?
    .is_empty()
    .then_some(())
}

fn scenario_create_nesting(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    facts: &crate::analysis::scenario_disclosure::CheckedScenarioSource,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    binding: &str,
    model: &crate::analysis::SymbolId,
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<()> {
    let checked_schema = super::scenario_create_sources::checked_created_schema(
        ir,
        owner,
        models,
        original,
        db,
        source_context,
    );
    checked_schema?;
    if source_context.is_some_and(|context| {
        source_owned_void_create(context, owner, original).is_some()
            || source_owned_created_return_tail(context, owner, original).is_some()
    }) {
        return Some(());
    }
    if source_context.is_some_and(|context| {
        super::event_notice_audit::checked(context, owner, "checked-create").is_some()
    }) {
        return Some(());
    }
    if source_context.is_some_and(|context| {
        super::purchase_all::checked(context, owner, "checked-create").is_some()
    }) {
        // The exact original replay/create/posting/parent/ALL sequence has a
        // complete independent fresh-source seal, including its create stage.
        return Some(());
    }
    if source_context
        .and_then(|context| source_owned_copy_loop(context, owner))
        .is_some_and(|copy| {
            copy["node"]["start"] == proof.node.start && copy["node"]["end"] == proof.node.end
        })
    {
        return Some(());
    }
    if !is_top_level_create(owner, proof.node) {
        // Arm-nested creates admit only through the captured conditional
        // rule — including void scenarios (no free pass): every other nesting
        // keeps its loud refusal (no receipt).
        if event_notice_branch_create_tail(ir, owner, checked, original, proof.node, binding, db)
            .is_none()
            && source_context
                .and_then(|context| conditional_parameter_create_link(context, owner, original))
                .is_none()
            && source_context
                .and_then(|context| {
                    checked_first_target_branch_create(context, owner, checked, original)
                })
                .is_none()
        {
            conditional_branch_create_tail(ir, owner, checked, proof.node, binding)?;
        }
    } else if matches!(&owner.kind, IrItemKind::Scenario { result: None, .. }) {
        // Every void create keeps its own ordered effect/schema/source proof;
        // no created-model result pair is consumed by this owner.
        if owner.canonical == "appointments.remind" {
            event_reminder_create_tail(ir, owner, checked, original, proof.node, binding, db)?;
        }
    } else if facts.creates.as_deref()?.len() == 2 {
        let (first, second) = checked_created_pair(ir, owner, db)?;
        if proof.node != first.node && proof.node != second.node {
            return None;
        }
        ordered_created_model_effects(ir, owner, first.node, first.model, &first.binding, db)?;
    } else if checked_created_model_result(ir, owner) == Some(*model) {
        if ordered_created_model_effects(ir, owner, proof.node, *model, binding, db).is_none()
            && source_context
                .and_then(|context| source_owned_updated_model_create(context, owner, original))
                .is_none()
        {
            return None;
        }
    } else if terminal_create_then_literal_return(owner, proof.node) {
        // No model result, non-void result, terminal create directly
        // followed by one plain scalar-constant return: the same terminal
        // side-effect justification as the void arm. The rule is purely
        // positional — any other tail (calls, lets, branches, further
        // effects) keeps the intermediate-call linkage or its loud refusal
        // below. No use/alias inventory is attempted, so alias escapes
        // through objects, branches or rebindings cannot slip through as
        // unlinked side effects.
    } else {
        ordered_intermediate_call_create(ir, owner, checked, proof.node, *model, binding, db)?;
    }
    Some(())
}

/// Immutable contract inputs may be ordered by one original scalar member;
/// element aliases carry Values data only, never a stored Model view.
fn constructor_values_order_domain<'a>(
    ir: &IrProgram,
    query: &'a super::ir::IrQuery,
) -> Option<&'a TypedExpr> {
    let source = query.source.as_ref()?;
    let [alias_clause, order_clause] = source.clauses.as_slice() else {
        return None;
    };
    let super::ir::IrQueryDomain::Value { base, alias } = &query.domain else {
        return None;
    };
    let ResolvedType::Array {
        element,
        ordered: true,
        nonempty: false,
    } = &base.ty
    else {
        return None;
    };
    let ResolvedType::Record { symbol, .. } = element.as_ref() else {
        return None;
    };
    let IrItemKind::Contract { fields, .. } = &ir.items.get(symbol.0 as usize)?.kind else {
        return None;
    };
    let order = query.value_order.as_ref()?;
    let IrExpr::Member {
        base: receiver,
        field,
    } = &order.key.expr
    else {
        return None;
    };
    if !matches!(&receiver.expr,IrExpr::Name(name) if name == alias) || receiver.ty != **element
        || !matches!(order.key.ty,ResolvedType::Scalar(scalar) if scalar != Scalar::File)
        || !fields.iter().filter_map(|id|ir.items.get(id.0 as usize)).any(|item|
            item.name == *field && matches!(&item.kind,IrItemKind::Field{ty:IrType::Known(ty),..} if *ty == order.key.ty))
        || !matches!(&alias_clause.kind,crate::analysis::types::CheckedQueryClauseKind::As{name} if name == alias)
        || order_clause.kind != crate::analysis::types::CheckedQueryClauseKind::Order
        || order_clause.expressions.len()!=1 || node_span(order_clause.expressions[0])!=order.key.span
        || source.result != base.ty || source.domain_type != base.ty || source.projection.is_some()
        || node_span(source.domain) != base.span || query.parent.is_some() || query.where_pred.is_some()
        || query.where_async || !query.order.is_empty() || query.limit.is_some() || query.archived.is_some()
        || query.select.is_some() || query.select_param.is_some() || query.collection_call.is_some()
        || query.contract_collection_call.is_some() || order.descending { return None; }
    Some(base)
}

fn scenario_create_entry_matches(
    ir: &IrProgram,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    name: &String,
    value: &TypedExpr,
    source: &crate::analysis::scenario_disclosure::CheckedScenarioCreateInput,
    authored: &crate::syntax::SyntaxNode,
    text: &str,
    db: &SourceDb,
    sealed_source_create: bool,
) -> Option<()> {
    let key = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Name)?;
    if name != &source.name
        || crate::analysis::NodeKey::of(key) != source.key_node
        || key.token()?.text(text) != name
        || value.ty != source.ty
        || value.span != node_span(source.value_node)
    {
        return None;
    }
    if let Some(field) = source.field {
        let declared = original
            .definition
            .fields
            .iter()
            .find(|declared| declared.field == field)?;
        if declared.name != *name {
            return None;
        }
    } else if name != "parent"
        || !matches!(original.definition.declaration.owner,
        crate::analysis::resolve::ModelOwner::ChildOf(parent) if source.ty == ResolvedType::Record {symbol:parent,stored:true})
    {
        return None;
    }
    if sealed_source_create {
        return Some(());
    }
    super::scenario_create_sources::checked_create_operand(
        ir,
        original,
        value,
        source.value_node,
        db,
    )
    .or_else(|| checked_first_optional_actor_expression(ir, owner, value, db))
}

fn scenario_create_entries(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    input: &TypedExpr,
    span: Span,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
    purchase_all: bool,
) -> Option<()> {
    if !purchase_all
        && checked_created_statements(ir, owner, checked, original, db, source_context).is_none()
        && source_context
            .and_then(|context| {
                conditional_parameter_create_link(context, owner, original)
                    .or_else(|| source_owned_after_call_create(context, owner, original))
                    .or_else(|| source_owned_void_create(context, owner, original))
                    .or_else(|| source_owned_created_return_tail(context, owner, original))
                    .or_else(|| source_owned_updated_model_create(context, owner, original))
                    .or_else(|| {
                        checked_first_target_branch_create(context, owner, checked, original)
                    })
                    .or_else(|| source_owned_copy_loop(context, owner).map(|_| ()))
            })
            .is_none()
    {
        return None;
    }
    let authored = checked_effect_node(ir, owner, proof.node, db)?;
    let text = &db.get(span.file)?.text;
    let target_node = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Path)?;
    let object = authored
        .children
        .iter()
        .find(|node| node.kind == SyntaxKind::Object)?;
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let DisclosureEffectKind::Create { inputs, .. } = &proof.kind else {
        return None;
    };
    let authored_entries: Vec<_> = object
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::ObjectEntry)
        .collect();
    let model_item = ir.items.get(original.model.0 as usize)?;
    if crate::analysis::NodeKey::of(target_node) != original.target_node
        || direct_source_path_name(target_node, text)? != model_item.name
        || entries.len() != inputs.len()
        || entries.len() != authored_entries.len()
    {
        return None;
    }
    for (((name, value), source), authored) in entries.iter().zip(inputs).zip(authored_entries) {
        let sealed_source_create = source_context.is_some_and(|context| {
            source_owned_updated_model_create(context, owner, original)
                .or_else(|| source_owned_void_create(context, owner, original))
                .or_else(|| source_owned_created_return_tail(context, owner, original))
                .is_some()
                || source_owned_copy_loop(context, owner).is_some()
        });
        scenario_create_entry_matches(
            ir,
            owner,
            original,
            name,
            value,
            source,
            authored,
            text,
            db,
            sealed_source_create,
        )?;
    }
    Some(())
}

fn checked_scenario_create(
    ir: &IrProgram,
    owner: &IrItem,
    models: &[JsModel],
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    proof: &crate::analysis::scenario_disclosure::DisclosureEffect,
    statement: &IrStmt,
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<()> {
    let facts = checked.source_facts.as_deref()?;
    let (original, input, span, binding, model) =
        scenario_create_identity(proof, statement, facts, checked)?;
    let nested = scenario_create_nesting(
        ir,
        owner,
        models,
        checked,
        facts,
        proof,
        original,
        binding,
        model,
        db,
        source_context,
    );
    nested?;
    let purchase_all = source_context.is_some_and(|context| {
        super::purchase_all::checked(context, owner, "checked-create").is_some()
            || super::event_notice_audit::checked(context, owner, "checked-create").is_some()
    });

    scenario_create_entries(
        ir,
        owner,
        checked,
        original,
        input,
        span,
        proof,
        db,
        source_context,
        purchase_all,
    )
}

/// Model results consume their checked pair's result origin. Void owners
/// instead validate each individual creation without manufacturing a result.
fn checked_created_statement_origin<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    original: &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    db: &SourceDb,
) -> Option<&'a crate::analysis::scenario_disclosure::CheckedScenarioCreate> {
    if matches!(&owner.kind, IrItemKind::Scenario { result: None, .. }) {
        return Some(original);
    }
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    if facts.creates.as_deref()?.len() == 2 {
        Some(checked_created_pair(ir, owner, db)?.0)
    } else {
        Some(original)
    }
}

/// A void constructor can accompany a SET of the original required input.
/// This joins its declared slot and authored receiver rather than borrowing a
/// created-result or selected-row proof from another source occurrence.
fn checked_required_model_parameter_value(
    ir: &IrProgram,
    owner: &IrItem,
    record: &TypedExpr,
    statement: Span,
    db: &SourceDb,
) -> Option<()> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let IrExpr::Name(name) = &record.expr else {
        return None;
    };
    let parameter = facts.parameters.iter().find(|parameter| {
        ir.items
            .get(parameter.parameter.0 as usize)
            .is_some_and(|item| item.name == *name)
    })?;
    let item = ir.items.get(parameter.parameter.0 as usize)?;
    if parameter.default.is_some()
        || parameter.ty != record.ty
        || !matches!(&item.kind, IrItemKind::Param { owner: id, ty: IrType::Known(ty), default: None, default_node: None, default_copy_source: None, array_bounds: None, .. }
            if *id == owner.id && *ty == record.ty)
        || !matches!(record.ty, ResolvedType::Record { stored: true, .. })
    {
        return None;
    }
    created_record_name_matches(record, &parameter.ty, name, statement, db)
}

/// Admit the declaration of one original stored scalar default. Evaluation
/// and its DATA observation remain with the normal omitted-input producer.
pub(super) fn checked_stored_scalar_parameter_default(
    context: &super::source_context::FreshSourceContext<'_>,
    ir: &IrProgram,
    owner: &IrItem,
    parameter: crate::analysis::SymbolId,
) -> Option<()> {
    context.same_scenario(ir, owner)?;
    let facts = super::scenario_calls::checked_source(ir, owner, context.db())?;
    let checked = facts
        .parameters
        .iter()
        .find(|value| value.parameter == parameter)?;
    let item = ir.items.get(parameter.0 as usize)?;
    let IrItemKind::Param {
        owner: declared_owner,
        index,
        ty: IrType::Known(ty),
        default: Some(IrDefault::Computed { expr, .. }),
        default_node: Some(node),
        default_copy_source: None,
        ..
    } = &item.kind
    else {
        return None;
    };
    let IrItemKind::Scenario { params, .. } = &owner.kind else {
        return None;
    };
    if *declared_owner != owner.id
        || params.get(*index) != Some(&parameter)
        || checked.default != Some(*node)
        || node.kind != SyntaxKind::Member as u8
        || checked.ty != *ty
        || !crate::analysis::scenario_disclosure::primitive_type(ty)
        || expr.ty != *ty
        || expr.span != node_span(*node)
        || ir.value_constraints.get(&parameter) != checked.constraints.as_ref()
        || context
            .original()
            .types
            .param_default_copy_sources
            .contains_key(&parameter)
    {
        return None;
    }
    let IrExpr::Member { base, field } = &expr.expr else {
        return None;
    };
    let IrExpr::Name(seed_name) = &base.expr else {
        return None;
    };
    let mut seeds = params[..*index]
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| item.name == *seed_name);
    let seed = seeds.next()?;
    if seeds.next().is_some() {
        return None;
    }
    let IrItemKind::Param {
        owner: seed_owner,
        index: seed_index,
        ty:
            IrType::Known(ResolvedType::Record {
                symbol: model,
                stored: true,
            }),
        default: None,
        default_node: None,
        default_copy_source: None,
        ..
    } = &seed.kind
    else {
        return None;
    };
    if *seed_owner != owner.id
        || seed_index >= index
        || seed.module != owner.module
        || base.ty
            != (ResolvedType::Record {
                symbol: *model,
                stored: true,
            })
        || context.original().types.node_types.get(node) != Some(ty)
    {
        return None;
    }
    let target = ir.items.get(model.0 as usize)?;
    let IrItemKind::Model { fields, .. } = &target.kind else {
        return None;
    };
    let mut matching = fields
        .iter()
        .filter_map(|id| ir.items.get(id.0 as usize))
        .filter(|item| item.name == *field);
    let member = matching.next()?;
    if matching.next().is_some()
        || !matches!(&member.kind, IrItemKind::Field {owner,ty:IrType::Known(actual),..}
            if owner == model && actual == ty)
        || member.module != target.module
        || member.canonical != format!("{}.{}", target.canonical, field)
        || context.original().types.symbol_types.get(&member.id) != Some(ty)
        || format!("{member:?}")
            != format!("{:?}", context.fresh().items.get(member.id.0 as usize)?)
        || format!("{item:?}") != format!("{:?}", context.fresh().items.get(item.id.0 as usize)?)
    {
        return None;
    }
    let fresh_owner = context.fresh().items.get(owner.id.0 as usize)?;
    let IrItemKind::Scenario {
        params: fresh_params,
        ..
    } = &fresh_owner.kind
    else {
        return None;
    };
    if fresh_params.get(*index) != Some(&parameter) {
        return None;
    }
    Some(())
}

fn checked_created_statements(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    db: &SourceDb,
    source_context: Option<&super::source_context::FreshSourceContext<'_>>,
) -> Option<()> {
    use crate::analysis::NodeKey;
    let facts = checked.source_facts.as_deref()?;
    let scenario = checked_effect_node(ir, owner, facts.node, db)?;
    let text = &db.get(facts.node.file)?.text;
    let IrItemKind::Scenario {
        params,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    match (
        crate::analysis::attribute_value(&scenario, "by", text),
        by.as_slice(),
    ) {
        (None, []) => {}
        (Some(node), [IrGuard::Role(role)])
            if node.kind == SyntaxKind::NameRef
                && (matches!(
                    role.as_str(),
                    "members" | "owner" | "authenticated" | "public"
                ) && text.get(node.span.start as usize..node.span.end as usize)
                    == Some(role.as_str())
                    || facts.by_role.as_ref().is_some_and(|(at, id, canonical)| {
                        *at == NodeKey::of(node)
                            && canonical == role
                            && ir.items.get(id.0 as usize).is_some_and(|item| {
                                item.id == *id
                                    && item.canonical == *canonical
                                    && matches!(item.kind, IrItemKind::Role { .. })
                            })
                    })) => {}
        _ => return None,
    }
    for (position, (id, fact)) in params.iter().zip(&facts.parameters).enumerate() {
        let parameter = ir.items.get(id.0 as usize)?;
        let IrItemKind::Param {
            owner: parent,
            index,
            default,
            ..
        } = &parameter.kind
        else {
            return None;
        };
        let authored = checked_effect_node(ir, owner, fact.node, db)?;
        let name = authored
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if *parent != owner.id
            || *index != position
            || parameter.module != owner.module
            || parameter.canonical != format!("{}.{}", owner.canonical, parameter.name)
            || parameter.span != name.span
            || name.token()?.text(text) != parameter.name
        {
            return None;
        }
        match (default, fact.default) {
            (None, None) => {}
            (Some(super::ir::IrDefault::Literal(value)), Some(node)) => {
                super::scenario_create_sources::checked_create_expression(
                    ir, original, value, node, db,
                )?;
            }
            (Some(IrDefault::Computed { .. }), Some(_)) => {
                checked_stored_scalar_parameter_default(source_context?, ir, owner, *id)?;
            }
            _ => return None,
        }
    }
    let authored_guards: Vec<_> = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Require)
        .collect();
    let mut blocks = scenario
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::DoBlock);
    let block = blocks.next()?;
    if blocks.next().is_some() {
        return None;
    }
    let authored_effects: Vec<_> = block
        .children
        .iter()
        .filter(|node| {
            !matches!(
                node.kind,
                SyntaxKind::Name | SyntaxKind::Trivia | SyntaxKind::Comment
            )
        })
        .collect();
    if authored_guards.len() != guards.len() || authored_effects.len() != effects.len() {
        return None;
    }
    let result_original = checked_created_statement_origin(ir, owner, original, db)?;
    let model_created = checked_created_model_result(ir, owner) == Some(result_original.model);
    // Void scenarios own no result row; a set on their individually checked
    // created row executes terminally in the same transaction in source
    // order, so no guarded-send linkage applies.
    let void_owner = matches!(&owner.kind, IrItemKind::Scenario { result: None, .. });
    for (statement, authored) in guards
        .iter()
        .zip(authored_guards)
        .chain(effects.iter().zip(authored_effects))
    {
        let (kind, at, value) = match statement {
            IrStmt::Let { name, value, span } => {
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .collect();
                let [keyword, binding] = names.as_slice() else {
                    return None;
                };
                if keyword.token()?.text(text) != "let" || binding.token()?.text(text) != name {
                    return None;
                }
                (SyntaxKind::Let, *span, Some(value))
            }
            IrStmt::Require { cond, span } => {
                let source_owned = facts.source_requires.as_deref().is_some_and(|sites| {
                    sites.iter().any(|site| {
                        node_span(site.statement) == *span && node_span(site.node) == cond.span
                    })
                });
                (SyntaxKind::Require, *span, (!source_owned).then_some(cond))
            }
            IrStmt::If { span, .. } => {
                let prefix_ok = super::scenario_create_sources::checked_create_prefix_if(
                    ir,
                    owner,
                    original,
                    statement,
                    NodeKey::of(authored),
                    db,
                )
                .is_some()
                    || event_notice_branch_create_tail(
                        ir,
                        owner,
                        checked,
                        original,
                        original.node,
                        &original.binding,
                        db,
                    )
                    .is_some();
                if !prefix_ok {
                    return None;
                }
                (SyntaxKind::If, *span, None)
            }
            IrStmt::Create { span, .. } => (SyntaxKind::Create, *span, None),
            IrStmt::Set {
                record,
                changes,
                when: None,
                span,
            } if model_created
                || void_owner
                || (!is_top_level_create(owner, original.node)
                    && conditional_branch_create_tail(
                        ir,
                        owner,
                        checked,
                        original.node,
                        &original.binding,
                    )
                    .is_some()) =>
            {
                let mut paths = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Path);
                let receiver = paths.next()?;
                if paths.next().is_some()
                    || record.span != receiver.span
                    || original
                        .expression_types
                        .iter()
                        .find(|(node, _)| *node == NodeKey::of(receiver))
                        .is_none_or(|(_, ty)| ty != &record.ty)
                {
                    return None;
                }
                let parent_receiver = checked_set_parent_receiver(ir, owner, record, db).is_some();
                let binding = if parent_receiver {
                    ""
                } else {
                    direct_source_path_name(receiver, text)?
                };
                if parent_receiver {
                    // The complete original required-input parent path was joined above.
                } else if binding == result_original.binding {
                    created_record_name_matches(
                        record,
                        &ResolvedType::Record {
                            symbol: result_original.model,
                            stored: true,
                        },
                        &result_original.binding,
                        *span,
                        db,
                    )?;
                } else if !is_top_level_create(owner, original.node)
                    && conditional_branch_create_tail(
                        ir,
                        owner,
                        checked,
                        original.node,
                        &original.binding,
                    )
                    .is_some()
                {
                    // Conditional tails may set pre-bound rows (params or
                    // earlier lets): the receiver name must be bound before
                    // the branch, and the conditional rule has already
                    // excluded leaks of the arm binding into this statement.
                    // 0551: the actual receiver must also BE that authored
                    // name; class membership alone admits a same-span/type
                    // row swap.
                    let IrExpr::Name(actual) = &record.expr else {
                        return None;
                    };
                    if actual.as_str() != binding {
                        return None;
                    }
                    let IrItemKind::Scenario {
                        effects: owner_effects,
                        params: owner_params,
                        ..
                    } = &owner.kind
                    else {
                        return None;
                    };
                    let mut prebound = false;
                    for id in owner_params.iter() {
                        if ir
                            .items
                            .get(id.0 as usize)
                            .is_some_and(|item| item.name == binding)
                        {
                            prebound = true;
                        }
                    }
                    for effect in owner_effects.iter() {
                        if matches!(effect, IrStmt::Let { name, .. } if name == binding) {
                            prebound = true;
                        }
                    }
                    if !prebound || !matches!(&record.ty, ResolvedType::Record { stored: true, .. })
                    {
                        return None;
                    }
                } else if (void_owner || model_created)
                    && checked_required_model_parameter_value(ir, owner, record, *span, db)
                        .is_some()
                {
                    // Required source input, independently matched to this
                    // owner's original parameter and authored SET receiver.
                } else {
                    let selected = checked_first_query_row(ir, owner, record, db)?;
                    if record.ty
                        != (ResolvedType::Record {
                            symbol: selected.id,
                            stored: true,
                        })
                    {
                        return None;
                    }
                }
                checked_created_object_entries(ir, original, changes, authored, *span, db)?;
                (SyntaxKind::Set, *span, None)
            }
            IrStmt::Send {
                args,
                when: None,
                binding: Some(binding),
                span,
                ..
            } if model_created => {
                let names = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .map(|node| Some(node.token()?.text(text)))
                    .collect::<Option<Vec<_>>>()?;
                if names.as_slice() != ["send", "as", binding.as_str()] {
                    return None;
                }
                let mut proofs = checked
                    .effects
                    .iter()
                    .filter(|proof| node_span(proof.node) == *span);
                let proof = proofs.next()?;
                if proofs.next().is_some() || proof.source != checked.source {
                    return None;
                }
                // The original effect owns the canonical capability operation
                // and deployment binding, including an imported local provider.
                checked_send_guard(ir, owner, proof, statement, None)?;
                checked_created_object_entries(ir, original, args, authored, *span, db)?;
                (SyntaxKind::Send, *span, None)
            }
            IrStmt::Send {
                args,
                operation,
                when: Some(_),
                binding: Some(binding),
                span,
                ..
            } if model_created || void_owner => {
                let names: Vec<_> = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Name)
                    .collect();
                let [send, when, as_word, source_binding] = names.as_slice() else {
                    return None;
                };
                if !operation.starts_with("std.")
                    || send.token()?.text(text) != "send"
                    || when.token()?.text(text) != "when"
                    || as_word.token()?.text(text) != "as"
                    || source_binding.token()?.text(text) != binding
                {
                    return None;
                }
                // Existing effect/Sites joins require the exact original
                // prepared Rule. Its predicate is not a parent expression.
                checked_created_object_entries(ir, original, args, authored, *span, db)?;
                (SyntaxKind::Send, *span, None)
            }
            IrStmt::Call { inputs, span, .. } => {
                let source_calls =
                    super::scenario_calls::collect_scenario_source_calls(ir, owner, db)?;
                let mut sources = source_calls.iter().filter(|call| call.span == *span);
                let source = sources.next()?;
                let IrExpr::Object(entries) = &inputs.expr else {
                    return None;
                };
                let mut objects = authored
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::Object);
                let object = objects.next()?;
                let authored_entries: Vec<_> = object
                    .children
                    .iter()
                    .filter(|node| node.kind == SyntaxKind::ObjectEntry)
                    .collect();
                if sources.next().is_some()
                    || objects.next().is_some()
                    || inputs.span != *span
                    || entries.len() != source.inputs.len()
                    || entries.len() != authored_entries.len()
                {
                    return None;
                }
                for (((name, value), fact), entry) in
                    entries.iter().zip(&source.inputs).zip(authored_entries)
                {
                    let key = entry
                        .children
                        .iter()
                        .find(|node| node.kind == SyntaxKind::Name)?;
                    if key.token()?.text(text) != name || fact.name != *name {
                        return None;
                    }
                    let authored_value = entry
                        .children
                        .iter()
                        .find(|node| {
                            matches!(
                                node.kind,
                                SyntaxKind::NameRef
                                    | SyntaxKind::Literal
                                    | SyntaxKind::Group
                                    | SyntaxKind::Array
                                    | SyntaxKind::Member
                                    | SyntaxKind::Unary
                                    | SyntaxKind::Binary
                                    | SyntaxKind::Call
                            )
                        })
                        .unwrap_or(key);
                    if fact.source != authored_value.span {
                        return None;
                    }
                    super::scenario_create_sources::checked_create_expression(
                        ir,
                        original,
                        value,
                        NodeKey::of(authored_value),
                        db,
                    )?;
                }
                (SyntaxKind::Call, *span, None)
            }
            IrStmt::Cancel { key, span, .. } if void_owner => {
                (SyntaxKind::Cancel, *span, Some(key))
            }
            IrStmt::Emit {
                event,
                payload,
                span,
            } if void_owner => {
                let mut proofs = checked
                    .effects
                    .iter()
                    .filter(|proof| node_span(proof.node) == *span);
                let proof = proofs.next()?;
                let DisclosureEffectKind::Emit {
                    event: original_event,
                } = proof.kind
                else {
                    return None;
                };
                let event_item = ir.items.get(original_event.0 as usize)?;
                if proofs.next().is_some()
                    || event_item.module != owner.module
                    || event_item.canonical != *event
                    || !matches!(event_item.kind, IrItemKind::Event { .. })
                {
                    return None;
                }
                checked_created_object_entries(ir, original, payload, authored, *span, db)?;
                (SyntaxKind::Emit, *span, None)
            }
            IrStmt::Return { span, .. } => (SyntaxKind::Return, *span, None),
            _ => return None,
        };
        if authored.kind != kind || authored.span != at {
            return None;
        }
        if let Some(value) = value {
            if owner.canonical == "member_terms.assign"
                && matches!(statement, IrStmt::Require { .. })
                && let Some([count, first]) = facts.queries.as_deref()
                && count.count.as_ref().is_some_and(|capacity| {
                    capacity.statement == crate::analysis::NodeKey::of(authored)
                })
                && first.first.is_some()
            {
                checked_native_assign_count_query_plan(
                    ir,
                    owner,
                    checked,
                    count,
                    db,
                    &checked.source.module,
                )?;
                continue;
            }
            let node = authored.children.iter().find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef
                        | SyntaxKind::Literal
                        | SyntaxKind::Group
                        | SyntaxKind::Array
                        | SyntaxKind::Construct
                        | SyntaxKind::Member
                        | SyntaxKind::Unary
                        | SyntaxKind::Binary
                        | SyntaxKind::Call
                )
            })?;
            let ok = super::scenario_create_sources::checked_create_expression(
                ir,
                original,
                value,
                NodeKey::of(node),
                db,
            )
            .is_some();
            if !ok {
                return None;
            }
        }
    }
    Some(())
}

/// Effect containers are synthetic Unknown objects spanning the statement.
/// Seal each authored ordered entry through its original typed operand instead.
pub(super) fn checked_created_object_entries(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    statement: &crate::syntax::SyntaxNode,
    at: Span,
    db: &SourceDb,
) -> Option<()> {
    use crate::analysis::NodeKey;
    if actual.span != at || actual.ty != ResolvedType::Unknown {
        return None;
    }
    let IrExpr::Object(entries) = &actual.expr else {
        return None;
    };
    let mut objects = statement
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::Object);
    let object = objects.next()?;
    if objects.next().is_some() {
        return None;
    }
    let authored: Vec<_> = object
        .children
        .iter()
        .filter(|node| node.kind == SyntaxKind::ObjectEntry)
        .collect();
    if entries.len() != authored.len() || entries.len() > 200 {
        return None;
    }
    let text = &db.get(at.file)?.text;
    let mut seen = HashSet::new();
    for ((name, value), entry) in entries.iter().zip(authored) {
        let key = entry
            .children
            .iter()
            .find(|node| node.kind == SyntaxKind::Name)?;
        if !seen.insert(name) || key.token()?.text(text) != name {
            return None;
        }
        let operand = entry
            .children
            .iter()
            .find(|node| {
                matches!(
                    node.kind,
                    SyntaxKind::NameRef
                        | SyntaxKind::Literal
                        | SyntaxKind::Group
                        | SyntaxKind::Array
                        | SyntaxKind::Member
                        | SyntaxKind::Unary
                        | SyntaxKind::Binary
                        | SyntaxKind::Call
                        | SyntaxKind::Construct
                        | SyntaxKind::Object
                )
            })
            .unwrap_or(key);
        super::scenario_create_sources::checked_create_expression(
            ir,
            original,
            value,
            NodeKey::of(operand),
            db,
        )?;
    }
    Some(())
}

/// A terminal side-effect create is the last effectful statement: it is
/// immediately followed by exactly one plain scalar-constant return and
/// nothing else. The rule is deliberately positional rather than a
/// use/alias inventory — any other tail keeps the intermediate-call
/// linkage or its loud refusal, so alias escapes through objects,
/// branches or rebindings cannot slip through as unlinked side effects.
fn terminal_create_then_literal_return(owner: &IrItem, create: crate::analysis::NodeKey) -> bool {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return false;
    };
    let Some(index) = effects.iter().position(
        |effect| matches!(effect, IrStmt::Create { span, .. } if *span == node_span(create)),
    ) else {
        return false;
    };
    let [IrStmt::Return { value, .. }] = &effects[index + 1..] else {
        return false;
    };
    matches!(
        value.as_ref().map(|returned| &returned.expr),
        Some(
            IrExpr::Int(_) | IrExpr::Decimal(_) | IrExpr::Text(_) | IrExpr::Bool(_) | IrExpr::Null
        )
    )
}

/// Collect every bare `Name` in an expression, descending into all child
/// positions exhaustively (no wildcard arm: a new variant breaks compilation
/// here so it cannot silently hide a use). Used only to prove a conditional
/// binding does not leak outside its arm — a missed position would be a
/// soundness hole, an extra hit only a loud refusal.
fn conditional_binding_names(value: &TypedExpr, out: &mut Vec<String>) {
    match &value.expr {
        IrExpr::Name(name) => out.push(name.clone()),
        IrExpr::Member { base, .. } => conditional_binding_names(base, out),
        IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. } => {
            for arg in args {
                conditional_binding_names(arg, out);
            }
        }
        IrExpr::Binary { left, right, .. } => {
            conditional_binding_names(left, out);
            conditional_binding_names(right, out);
        }
        IrExpr::Unary { operand, .. } => conditional_binding_names(operand, out),
        IrExpr::Array(items) => {
            for item in items {
                conditional_binding_names(item, out);
            }
        }
        IrExpr::Object(entries) => {
            for (_, item) in entries {
                conditional_binding_names(item, out);
            }
        }
        IrExpr::Query(query) => {
            if let super::ir::IrQueryDomain::Value { base, .. } = &query.domain {
                conditional_binding_names(base, out);
            }
            for part in query
                .parent
                .iter()
                .chain(query.where_pred.iter())
                .chain(query.limit.iter())
                .chain(query.archived.iter())
                .chain(query.select.iter())
            {
                conditional_binding_names(part, out);
            }
            if let Some(order) = &query.value_order {
                conditional_binding_names(&order.key, out);
            }
        }
        IrExpr::DeliveryRead { .. }
        | IrExpr::Message(_)
        | IrExpr::MessageCall { .. }
        | IrExpr::Format { .. }
        | IrExpr::HasRole { .. }
        | IrExpr::Lambda { .. }
        | IrExpr::JudgmentSpecification { .. }
        | IrExpr::PageTimePredicate(_)
        | IrExpr::Unsupported { .. }
        | IrExpr::Int(_)
        | IrExpr::Decimal(_)
        | IrExpr::Text(_)
        | IrExpr::Bool(_)
        | IrExpr::Null
        | IrExpr::Money { .. }
        | IrExpr::DurationMs(_)
        | IrExpr::Date(_)
        | IrExpr::Datetime(_) => conditional_binding_names_rest(&value.expr, out),
    }
}

fn conditional_binding_names_rest(expr: &IrExpr, out: &mut Vec<String>) {
    match expr {
        IrExpr::DeliveryRead { record, .. } => conditional_binding_names(record, out),
        IrExpr::Message(message) => {
            for param in &message.params {
                conditional_binding_names(&param.value, out);
            }
        }
        IrExpr::MessageCall { args, params, .. } => {
            for arg in args {
                conditional_binding_names(arg, out);
            }
            for param in params {
                if let Some(default) = &param.default {
                    conditional_binding_names(default, out);
                }
            }
        }
        IrExpr::Format { args, .. } => {
            for arg in args {
                conditional_binding_names(arg, out);
            }
        }
        IrExpr::HasRole { person, .. } => {
            for value in person.iter() {
                conditional_binding_names(value, out);
            }
        }
        IrExpr::Lambda { body, .. } => conditional_binding_names(body, out),
        IrExpr::JudgmentSpecification { options, .. } => {
            for value in options.iter() {
                conditional_binding_names(value, out);
            }
        }
        _ => {}
    }
}

/// True when a statement's expressions mention a binding name. Statements
/// outside the admitted conditional vocabularies count as uses (fail-closed)
/// so a future vocabulary extension cannot silently leak a binding.
fn conditional_binding_used(statement: &IrStmt, binding: &str) -> bool {
    let mut exprs: Vec<&TypedExpr> = Vec::new();
    match statement {
        IrStmt::Let { value, .. } => exprs.push(value),
        IrStmt::Create { input, .. } => exprs.push(input),
        IrStmt::Set {
            record, changes, ..
        } => {
            exprs.push(record);
            exprs.push(changes);
        }
        IrStmt::Require { cond, .. } => exprs.push(cond),
        IrStmt::Return { value, .. } => exprs.extend(value.iter()),
        IrStmt::If { cond, .. } => exprs.push(cond),
        IrStmt::Emit { payload, .. } => exprs.push(payload),
        IrStmt::Call { inputs, .. } => exprs.push(inputs),
        _ => return true,
    }
    let mut names = Vec::new();
    for expr in exprs {
        conditional_binding_names(expr, &mut names);
    }
    names.iter().any(|name| name == binding)
}

/// A conditional (branch-arm) create admits only through this captured rule:
/// exactly one nested create under a single top-level null-check branch in a
/// first-query scenario, with captured arms and a captured tail. The arm
/// binding must not leak: arm/trailing lets are refused (no laundering, no
/// shadowing), and the binding name must not occur in the condition, the
/// sibling arm, or any trailing statement. Exactly one top-level branch
/// construct is allowed, so coverage below is region-precise; every other
/// nesting keeps its loud refusal (no receipt). The taken arm executes
/// through normal per-effect authorization; the receipt observes the proven
/// statements, it does not pre-register which arm runs.
fn branch_binders<'o>(
    ir: &IrProgram,
    owner: &'o IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    binding: &str,
) -> Option<(std::collections::HashSet<String>, &'o Vec<IrStmt>)> {
    // Conditional-create receipts exist only for first-query scenarios;
    // other scenarios keep their existing plain path (no behavior change).
    let first_query = checked
        .source_facts
        .as_deref()?
        .queries
        .as_deref()?
        .iter()
        .any(|query| query.first.is_some());
    if !first_query {
        return None;
    }
    let IrItemKind::Scenario {
        effects, params, ..
    } = &owner.kind
    else {
        return None;
    };
    // Exactly one top-level branch construct and no loops/matches: every
    // nested statement then necessarily lives under the admitted If below.
    let mut branches = 0;
    for effect in effects.iter() {
        match effect {
            IrStmt::If { .. } => branches += 1,
            IrStmt::Match { .. } | IrStmt::For { .. } => return None,
            _ => {}
        }
    }
    if branches != 1 {
        return None;
    }
    // All possible binders in scope. Arm/trailing lets are refused below, so
    // no shadowing can hide the conditional binding behind the same name.
    let mut binders = std::collections::HashSet::new();
    for id in params {
        binders.insert(ir.items.get(id.0 as usize)?.name.clone());
    }
    for effect in effects.iter() {
        if let IrStmt::Let { name, .. } = effect {
            binders.insert(name.clone());
        }
    }
    if binders.contains(binding) {
        return None;
    }
    Some((binders, effects))
}

fn branch_enclosing_if(
    effects: &[IrStmt],
    create: crate::analysis::NodeKey,
) -> Option<(usize, &TypedExpr, &[IrStmt], &[IrStmt])> {
    // The create must be a direct child of exactly one arm of the single
    // top-level If; deeper nesting stays refused.
    let mut enclosing: Option<(usize, &TypedExpr, &[IrStmt], &[IrStmt])> = None;
    for (index, effect) in effects.iter().enumerate() {
        if let IrStmt::If {
            cond,
            then_branch,
            else_branch,
            ..
        } = effect
        {
            let hit = then_branch
                .iter()
                .chain(else_branch.iter())
                .any(|statement| {
                    matches!(statement, IrStmt::Create { span, .. } if *span == node_span(create))
                });
            if hit {
                if enclosing.is_some() {
                    return None;
                }
                enclosing = Some((index, cond, then_branch.as_slice(), else_branch.as_slice()));
            }
        }
    }
    enclosing
}

fn branch_single_create(
    then_branch: &[IrStmt],
    else_branch: &[IrStmt],
    create: crate::analysis::NodeKey,
) -> Option<()> {
    // Exactly one create lives under the branch (the checked one).
    let mut nested = 0;
    for statement in then_branch.iter().chain(else_branch.iter()) {
        if let IrStmt::Create { span, .. } = statement {
            if *span != node_span(create) {
                return None;
            }
            nested += 1;
        }
    }
    if nested != 1 {
        return None;
    }
    Some(())
}

fn branch_condition_name(cond: &TypedExpr) -> Option<String> {
    // Slice condition: a null check on a pre-bound name. The check reads no
    // stored fields, so no field disclosure rides on the branch choice.
    match &cond.expr {
        IrExpr::Binary {
            op: super::ir::IrBinOp::Eq | super::ir::IrBinOp::Ne,
            left,
            right,
        } => match (&left.expr, &right.expr) {
            (IrExpr::Name(name), IrExpr::Null) | (IrExpr::Null, IrExpr::Name(name)) => {
                Some(name.clone())
            }
            _ => None,
        },
        _ => None,
    }
}

fn branch_arm_vocabulary(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    then_branch: &[IrStmt],
    else_branch: &[IrStmt],
    create: crate::analysis::NodeKey,
) -> Option<()> {
    // Arm vocabulary: requires, the single checked create, and proven sets.
    // Lets (laundering), calls (opaque consumption), nested branches, loops
    // and sends keep their loud refusal. Every arm set must carry its
    // analysis proof, else the receipt cannot observe it.
    for arm in [then_branch, else_branch] {
        for statement in arm.iter() {
            match statement {
                IrStmt::Require { .. } => {}
                IrStmt::Create { span, .. } if *span == node_span(create) => {}
                IrStmt::Set { span, .. } => {
                    if !checked
                        .effects
                        .iter()
                        .any(|proof| node_span(proof.node) == *span)
                    {
                        return None;
                    }
                }
                _ => return None,
            }
        }
    }
    Some(())
}

fn branch_trailing_vocabulary(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    effects: &[IrStmt],
    position: usize,
) -> Option<()> {
    // Trailing vocabulary after the branch: requires, literal returns,
    // proven sets and proven emits. Calls, lets and further branches keep
    // their loud refusal.
    for effect in effects.iter().skip(position + 1) {
        match effect {
            IrStmt::Require { .. } => {}
            IrStmt::Return { value, .. } => {
                if !matches!(
                    value.as_ref().map(|returned| &returned.expr),
                    Some(
                        IrExpr::Int(_)
                            | IrExpr::Decimal(_)
                            | IrExpr::Text(_)
                            | IrExpr::Bool(_)
                            | IrExpr::Null
                    )
                ) {
                    return None;
                }
            }
            IrStmt::Set { span, .. } | IrStmt::Emit { span, .. } => {
                if !checked
                    .effects
                    .iter()
                    .any(|proof| node_span(proof.node) == *span)
                {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(())
}

fn branch_binding_contained(
    cond: &TypedExpr,
    then_branch: &[IrStmt],
    else_branch: &[IrStmt],
    effects: &[IrStmt],
    position: usize,
    binding: &str,
) -> Option<()> {
    // The conditional binding must not leak outside its own create: the
    // condition, the sibling arm and every trailing statement are scanned.
    // (Pre-branch uses cannot resolve through the postdominator env reset.)
    let mut scoped = Vec::new();
    conditional_binding_names(cond, &mut scoped);
    if scoped.iter().any(|name| name == binding) {
        return None;
    }
    for arm in [then_branch, else_branch] {
        for statement in arm.iter() {
            if conditional_binding_used(statement, binding) {
                return None;
            }
        }
    }
    for effect in effects.iter().skip(position + 1) {
        if conditional_binding_used(effect, binding) {
            return None;
        }
    }
    Some(())
}

fn conditional_branch_create_tail(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    create: crate::analysis::NodeKey,
    binding: &str,
) -> Option<()> {
    let (binders, effects) = branch_binders(ir, owner, checked, binding)?;
    let (position, cond, then_branch, else_branch) = branch_enclosing_if(effects, create)?;
    branch_single_create(then_branch, else_branch, create)?;
    let condition_name = branch_condition_name(cond)?;
    if !binders.contains(&condition_name) || condition_name == binding {
        return None;
    }
    branch_arm_vocabulary(checked, then_branch, else_branch, create)?;
    branch_trailing_vocabulary(checked, effects, position)?;
    branch_binding_contained(cond, then_branch, else_branch, effects, position, binding)
}

/// The reminder's flat SEND result is consumed by its immediately following
/// Notice. This is the only event handler admitted to this top-level shape.
fn event_reminder_create_tail(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    create: crate::analysis::NodeKey,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(event)),
        hook: None,
        cohort: None,
        read: false,
        result: None,
        params,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::Require {
            cond,
            span: require_span,
        },
    ] = guards.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Send {
            operation,
            when: Some(when),
            binding: Some(delivery),
            span: send_span,
            ..
        },
        IrStmt::Create {
            model,
            input,
            binding: Some(created),
            when: None,
            span: create_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [send_proof, create_proof] = checked.effects.as_slice() else {
        return None;
    };
    let facts = checked.source_facts.as_deref()?;
    let [source_create] = facts.creates.as_deref()? else {
        return None;
    };
    let source_require = checked_effect_node(
        ir,
        owner,
        crate::analysis::NodeKey {
            file: require_span.file,
            start: require_span.start,
            end: require_span.end,
            kind: SyntaxKind::Require as u8,
        },
        db,
    )?;
    let source_cond = source_require.children.iter().find(|child| {
        matches!(
            child.kind,
            SyntaxKind::NameRef
                | SyntaxKind::Member
                | SyntaxKind::Binary
                | SyntaxKind::Unary
                | SyntaxKind::Group
                | SyntaxKind::Call
        )
    })?;
    if owner.canonical != "appointments.remind"
        || event != "appointments.Reminder"
        || model != "appointments.Notice"
        || operation != "std.EmailV1.send"
        || !params.is_empty()
        || !by.is_empty()
        || delivery != "delivery"
        || created != "notice"
        || binding != "notice"
        || create != original.node
        || source_create.node != create
        || *create_span != node_span(create)
        || *send_span != node_span(send_proof.node)
        || source_require.kind != SyntaxKind::Require
        || source_require.span != *require_span
        || cond.span != source_cond.span
        || !matches!(&send_proof.kind, DisclosureEffectKind::Send {when: Some(node), ..}
            if when.span == node_span(*node))
        || !matches!(&create_proof.kind, DisclosureEffectKind::Create {model: id, ..}
            if *id == original.model)
        || create_proof.node != create
        || source_create.model != original.model
    {
        return None;
    }
    let text = &db.get(cond.span.file)?.text;
    if text
        .get(cond.span.start as usize..cond.span.end as usize)?
        .trim()
        != text
            .get(when.span.start as usize..when.span.end as usize)?
            .trim()
        || when.ty != ResolvedType::Scalar(Scalar::Bool)
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
    {
        return None;
    }
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let [
        (parent_name, parent),
        (kind_name, kind),
        (source_name, source),
        (delivery_name, delivery_value),
    ] = entries.as_slice()
    else {
        return None;
    };
    let ResolvedType::Record {
        symbol: appointment,
        stored: true,
    } = parent.ty
    else {
        return None;
    };
    if parent_name != "parent"
        || kind_name != "kind"
        || source_name != "source"
        || delivery_name != "delivery"
        || original.definition.declaration.owner
            != crate::analysis::resolve::ModelOwner::ChildOf(appointment)
        || checked_notice_event_field(ir, owner, parent, "appointment", db).is_none()
        || !matches!(&kind.expr, IrExpr::Text(name) if name == "reminder")
        || db
            .get(kind.span.file)?
            .text
            .get(kind.span.start as usize..kind.span.end as usize)?
            != "reminder"
        || !matches!(&source.expr, IrExpr::Member {base,field}
            if field == "active_source"
                && checked_notice_event_field(ir, owner, base, "appointment", db).is_some())
        || db
            .get(source.span.file)?
            .text
            .get(source.span.start as usize..source.span.end as usize)?
            != "event.appointment.active_source"
        || !matches!(&delivery_value.expr, IrExpr::Name(name) if name == delivery)
        || db
            .get(delivery_value.span.file)?
            .text
            .get(delivery_value.span.start as usize..delivery_value.span.end as usize)?
            != delivery
    {
        return None;
    }
    Some(())
}

/// A trusted declared agreement delivery has one transaction arm: the original guarded
/// Mail.send result is stored by the immediately following child CREATE.
/// Prove its complete source/IR branch and event operand identities before
/// allowing a nested constructor; no general conditional-create rule changes.
fn event_notice_branch_create_tail(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    create: crate::analysis::NodeKey,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let (expected_event, row_name, due) = match owner.canonical.as_str() {
        "agreements.notice" => ("agreements.Notice", "term", false),
        "agreements.due" => ("agreements.ObligationDue", "obligation", true),
        _ => return None,
    };
    let IrItemKind::Scenario {
        trusted: true,
        event_source: Some(super::ir::IrEventSource::Declared(event)),
        hook: None,
        cohort: None,
        read: false,
        result: None,
        params,
        by,
        guards,
        effects,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let [
        IrStmt::If {
            cond,
            then_branch,
            else_branch,
            span: branch_span,
        },
    ] = effects.as_slice()
    else {
        return None;
    };
    let [
        IrStmt::Send {
            operation,
            when: Some(_),
            binding: Some(delivery),
            span: send_span,
            args,
            ..
        },
        IrStmt::Create {
            model,
            input,
            binding: Some(created),
            when: None,
            span: create_span,
        },
    ] = then_branch.as_slice()
    else {
        return None;
    };
    if event != expected_event
        || model != "agreements.NoticeDelivery"
        || operation != "std.EmailV1.send"
        || !params.is_empty()
        || !by.is_empty()
        || !guards.is_empty()
        || !else_branch.is_empty()
        || *create_span != node_span(create)
        || created != binding
        || delivery != "delivery"
        || binding != "notice"
        || checked.effects.len() != 2
        || checked.returns.is_empty()
        || checked
            .returns
            .iter()
            .any(|returned| returned.model_result.is_some())
        || !matches!(
            &checked.effects[0].kind,
            DisclosureEffectKind::Send { when: Some(_), .. }
        )
        || node_span(checked.effects[0].node) != *send_span
        || !matches!(&checked.effects[1].kind, DisclosureEffectKind::Create {model: id, ..} if
            ir.items.get(id.0 as usize).is_some_and(|item| item.canonical == *model))
        || checked.effects[1].node != create
        || original.node != create
    {
        return None;
    }
    let facts = checked.source_facts.as_deref()?;
    if facts
        .creates
        .as_deref()
        .is_none_or(|creates| creates.len() != 1 || creates[0].node != create)
        || checked.node != facts.node
        || checked.source != facts.source
    {
        return None;
    }
    let source_if = crate::analysis::NodeKey {
        file: branch_span.file,
        start: branch_span.start,
        end: branch_span.end,
        kind: SyntaxKind::If as u8,
    };
    let authored_if = checked_effect_node(ir, owner, source_if, db)?;
    let source_cond = authored_if.children.iter().find(|child| {
        matches!(
            child.kind,
            SyntaxKind::NameRef
                | SyntaxKind::Member
                | SyntaxKind::Binary
                | SyntaxKind::Unary
                | SyntaxKind::Group
                | SyntaxKind::Call
        )
    })?;
    if authored_if.kind != SyntaxKind::If
        || authored_if.span != *branch_span
        || source_cond.span != cond.span
        || cond.ty != ResolvedType::Scalar(Scalar::Bool)
        || super::scenario_create_sources::checked_create_expression(
            ir,
            original,
            cond,
            crate::analysis::NodeKey::of(source_cond),
            db,
        )
        .is_none()
    {
        return None;
    }
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let (parent, obligation, revision, delivery_entry) = if due {
        let [parent, obligation, revision, delivery] = entries.as_slice() else {
            return None;
        };
        (parent, Some(obligation), revision, delivery)
    } else {
        let [parent, revision, delivery] = entries.as_slice() else {
            return None;
        };
        (parent, None, revision, delivery)
    };
    let crate::analysis::resolve::ModelOwner::ChildOf(term_model) =
        original.definition.declaration.owner
    else {
        return None;
    };
    let checked_row =
        |value: &TypedExpr| checked_notice_event_field(ir, owner, value, row_name, db);
    let parent_row = if due {
        let IrExpr::Member { base, field } = &parent.1.expr else {
            return None;
        };
        field == "parent"
            && checked_row(base).is_some()
            && checked_parent_reference(ir, owner, &parent.1, db).is_some_and(
                |(child, parent_model)| {
                    child.canonical == "agreements.Obligation" && parent_model.id == term_model
                },
            )
    } else {
        checked_row(&parent.1).is_some()
    };
    if parent.0 != "parent"
        || !parent_row
        || obligation
            .is_some_and(|entry| entry.0 != "obligation" || checked_row(&entry.1).is_none())
        || revision.0 != "revision"
        || checked_notice_event_field(ir, owner, &revision.1, "revision", db).is_none()
        || delivery_entry.0 != "delivery"
        || !matches!(&delivery_entry.1.expr, IrExpr::Name(name) if name == delivery)
        || parent.1.ty
            != (ResolvedType::Record {
                symbol: term_model,
                stored: true,
            })
        || revision.1.ty != ResolvedType::Scalar(Scalar::Int)
    {
        return None;
    }
    let IrExpr::Object(send_entries) = &args.expr else {
        return None;
    };
    if send_entries.len() != 3
        || send_entries
            .iter()
            .map(|(name, _)| name.as_str())
            .ne(["to", "subject", "body"])
    {
        return None;
    }
    Some(())
}

/// A create directly in the scenario body keeps the existing positional
/// rules; arm-nested creates take only the conditional branch rule.
fn is_top_level_create(owner: &IrItem, create: crate::analysis::NodeKey) -> bool {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return false;
    };
    effects
        .iter()
        .any(|effect| matches!(effect, IrStmt::Create { span, .. } if *span == node_span(create)))
}

/// An original intermediate Create is consumed only by the immediately
/// following checked CALL, whose direct returned model owns the result.
fn ordered_intermediate_call_create(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let result_model = checked_created_model_result(ir, owner)?;
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 3
        || effects[..effects.len() - 3]
            .iter()
            .any(|effect| !matches!(effect, IrStmt::Let { .. } | IrStmt::Require { .. }))
    {
        return None;
    }
    let [
        IrStmt::Create { span: created, .. },
        IrStmt::Call {
            target: IrEffectCallTarget::Operation { operation, .. },
            inputs,
            binding: Some(call_binding),
            span: called,
            ..
        },
        IrStmt::Return {
            value: Some(value),
            span: returned,
        },
    ] = &effects[effects.len() - 3..]
    else {
        return None;
    };
    let child = ir.items.get(operation.0 as usize)?;
    if *created != node_span(create)
        || created.end > called.start
        || called.end > returned.start
        || created.file != called.file
        || called.file != returned.file
        || child.id != *operation
        || checked_created_model_result(ir, child)? != result_model
    {
        return None;
    }
    let IrExpr::Object(entries) = &inputs.expr else {
        return None;
    };
    let created_ty = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    if entries
        .iter()
        .filter(|(_, input)| {
            matches!(&input.expr, IrExpr::Name(name)
        if name == binding)
                && input.ty == created_ty
        })
        .count()
        != 1
    {
        return None;
    }
    let mut proofs = checked
        .effects
        .iter()
        .filter(|proof| node_span(proof.node) == *called);
    let proof = proofs.next()?;
    if proofs.next().is_some()
        || proof.source != checked.source
        || !matches!(&proof.kind, DisclosureEffectKind::Call { operation: actual, input_keys }
            if actual == operation && input_keys == &entries.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>())
        || checked.returns.is_empty()
        || checked.returns.iter().any(|returned| {
            !matches!(returned.model_result,
            Some(DisclosureModelResult::Call { model, node, operation: actual })
                if model == result_model && node_span(node) == *called && actual == *operation)
        })
    {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: result_model,
            stored: true,
        },
        call_binding,
        *returned,
        db,
    )
}

/// The original pair stores the first created row in the second row and
/// returns that same first binding. Every constructor remains individually
/// source/schema checked by the owning effect matcher.
fn created_pair_parent(
    first: crate::analysis::resolve::ModelOwner,
    second: crate::analysis::resolve::ModelOwner,
) -> Option<Option<crate::analysis::SymbolId>> {
    match (first, second) {
        (
            crate::analysis::resolve::ModelOwner::Team,
            crate::analysis::resolve::ModelOwner::Team,
        ) => Some(None),
        (
            crate::analysis::resolve::ModelOwner::ChildOf(first),
            crate::analysis::resolve::ModelOwner::ChildOf(second),
        ) if first == second => Some(Some(first)),
        _ => None,
    }
}

fn created_pair_header_mismatch(
    ir: &IrProgram,
    owner: &IrItem,
    first: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    second: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    parent_id: Option<crate::analysis::SymbolId>,
) -> bool {
    first.source != checked.source
        || second.source != checked.source
        || first.model == second.model
        || first.binding == second.binding
        || !direct_field_name(&first.binding)
        || !direct_field_name(&second.binding)
        || first.node.file != second.node.file
        || first.node.end > second.node.start
        || checked_created_model_result(ir, owner) != Some(first.model)
        || checked
            .returns
            .iter()
            .any(|returned| match returned.model_result {
                Some(DisclosureModelResult::Create { model, node }) => {
                    model != first.model || node != first.node
                }
                Some(DisclosureModelResult::Reference { model, .. }) if parent_id.is_none() => {
                    model != first.model || returned.node.end > first.node.start
                }
                _ => true,
            })
}

fn created_pair_statements_mismatch(
    duplicate: bool,
    second_position: usize,
    position: usize,
    effects: &[IrStmt],
    params: &[crate::analysis::SymbolId],
    ir: &IrProgram,
    parent_none: bool,
    first: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    second: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
) -> bool {
    duplicate
        || second_position != position + 1
        || effects[..position].iter().any(|statement| {
            if parent_none {
                !model_result_prefix(statement)
            } else {
                !matches!(statement, IrStmt::Let { .. } | IrStmt::Require { .. })
            }
        })
        || params.iter().any(|id| {
            ir.items
                .get(id.0 as usize)
                .is_none_or(|item| item.name == first.binding || item.name == second.binding)
        })
        || effects[..position].iter().any(|statement| {
            matches!(statement, IrStmt::Let { name, .. }
                if name == &first.binding || name == &second.binding)
        })
}

fn created_pair_parent_context<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    queries: &'a [crate::analysis::scenario_disclosure::DisclosureQuery],
    second: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    parent_id: crate::analysis::SymbolId,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::DisclosureCountQuery,
    &'a IrItem,
    ResolvedType,
)> {
    let mut selected = queries.iter().filter(|query| {
        query
            .count
            .as_ref()
            .is_some_and(|count| count.statement == second.node)
    });
    let query = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    let count = query.count.as_ref()?;
    let parameter = checked_count_query_parent(ir, owner, query, db)?;
    let parent_type = ResolvedType::Record {
        symbol: parent_id,
        stored: true,
    };
    if query.model != second.model
        || count.statement != second.node
        || !matches!(&parameter.kind, IrItemKind::Param { ty: IrType::Known(ty), .. } if ty == &parent_type)
    {
        return None;
    }
    Some((count, parameter, parent_type))
}

fn created_pair_proof_mismatch(
    duplicate: bool,
    proof: &DisclosureEffect,
    checked_source: &DisclosureSource,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    model: &String,
    binding: &String,
    span: Span,
    input_span: Span,
    entries: &[(String, TypedExpr)],
) -> bool {
    duplicate
        || proof.source != *checked_source
        || !matches!(&proof.kind, DisclosureEffectKind::Create {
            model, crud: None, binding, defaults, inputs
        } if *model == original.model && binding == &original.binding
            && defaults.is_empty() && inputs == &original.inputs)
        || *model != original.definition.canonical
        || *binding != original.binding
        || span != node_span(original.node)
        || input_span != span
        || entries.len() != original.inputs.len()
        || entries.is_empty()
}

fn created_pair_field_entry(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    name: &String,
    value: &TypedExpr,
    input: &crate::analysis::scenario_disclosure::CheckedScenarioCreateInput,
    second_node: crate::analysis::NodeKey,
    reference_value_node: crate::analysis::NodeKey,
    result_type: &ResolvedType,
    first_binding: &str,
    span: Span,
    db: &SourceDb,
) -> Option<()> {
    let field = original
        .definition
        .fields
        .iter()
        .find(|field| Some(field.field) == input.field)?;
    let actual = ir.items.get(field.field.0 as usize)?;
    if field.name != *name
        || (field.ty != input.ty
            && field.ty.nullable_inner() != Some(&input.ty)
            && !(input.ty == ResolvedType::Null && field.ty.nullable_inner().is_some()))
        || actual.id != field.field
        || actual.canonical != field.canonical
        || actual.name != field.name
        || !matches!(&actual.kind, IrItemKind::Field { owner, ty: IrType::Known(ty), .. }
            if *owner == original.model && ty == &field.ty)
    {
        return None;
    }
    if original.node == second_node && input.value_node == reference_value_node {
        created_record_name_matches(value, result_type, first_binding, span, db)?;
        super::scenario_create_sources::checked_create_expression(
            ir,
            original,
            value,
            input.value_node,
            db,
        )?;
    }
    Some(())
}

fn created_pair_entry<'n>(
    ir: &IrProgram,
    owner: &IrItem,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    name: &'n String,
    value: &TypedExpr,
    input: &crate::analysis::scenario_disclosure::CheckedScenarioCreateInput,
    names: &mut HashSet<&'n String>,
    parent_found: &mut bool,
    parent_context: Option<&(
        &crate::analysis::scenario_disclosure::DisclosureCountQuery,
        &IrItem,
        ResolvedType,
    )>,
    second_node: crate::analysis::NodeKey,
    reference_value_node: crate::analysis::NodeKey,
    result_type: &ResolvedType,
    first_binding: &str,
    span: Span,
    db: &SourceDb,
) -> Option<()> {
    if !names.insert(name)
        || name != &input.name
        || value.ty != input.ty
        || value.span != node_span(input.value_node)
        || original
            .expression_types
            .iter()
            .find(|(at, _)| *at == input.value_node)
            .is_none_or(|(_, ty)| ty != &value.ty)
    {
        return None;
    }
    if input.field.is_none() {
        if *parent_found || name != "parent" {
            return None;
        }
        if original.node == second_node
            && original.definition.declaration.owner
                == crate::analysis::resolve::ModelOwner::ChildOf(match result_type {
                    ResolvedType::Record {
                        symbol,
                        stored: true,
                    } => *symbol,
                    _ => return None,
                })
            && input.value_node == reference_value_node
            && &input.ty == result_type
        {
            created_record_name_matches(value, result_type, first_binding, span, db)?;
        } else if let Some((_, parameter, parent_type)) = parent_context {
            if &input.ty != parent_type {
                return None;
            }
            created_record_name_matches(value, parent_type, &parameter.name, span, db)?;
        } else {
            let crate::analysis::resolve::ModelOwner::ChildOf(parent) =
                original.definition.declaration.owner
            else {
                return None;
            };
            if input.ty
                != (ResolvedType::Record {
                    symbol: parent,
                    stored: true,
                })
            {
                return None;
            }
            checked_required_model_parameter_value(ir, owner, value, span, db)?;
        }
        *parent_found = true;
        super::scenario_create_sources::checked_create_expression(
            ir,
            original,
            value,
            input.value_node,
            db,
        )?;
    } else {
        created_pair_field_entry(
            ir,
            original,
            name,
            value,
            input,
            second_node,
            reference_value_node,
            result_type,
            first_binding,
            span,
            db,
        )?;
    }
    Some(())
}

fn created_pair_statement(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    statement: &IrStmt,
    parent_context: Option<&(
        &crate::analysis::scenario_disclosure::DisclosureCountQuery,
        &IrItem,
        ResolvedType,
    )>,
    second_node: crate::analysis::NodeKey,
    reference_value_node: crate::analysis::NodeKey,
    result_type: &ResolvedType,
    first_binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrStmt::Create {
        model,
        input,
        binding: Some(binding),
        when: None,
        span,
    } = statement
    else {
        return None;
    };
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let mut proofs = checked
        .effects
        .iter()
        .filter(|proof| proof.node == original.node);
    let proof = proofs.next()?;
    if created_pair_proof_mismatch(
        proofs.next().is_some(),
        proof,
        &checked.source,
        original,
        model,
        binding,
        *span,
        input.span,
        entries,
    ) {
        return None;
    }
    let mut names = HashSet::new();
    let mut parent_found = false;
    for ((name, value), input) in entries.iter().zip(&original.inputs) {
        created_pair_entry(
            ir,
            owner,
            original,
            name,
            value,
            input,
            &mut names,
            &mut parent_found,
            parent_context,
            second_node,
            reference_value_node,
            result_type,
            first_binding,
            *span,
            db,
        )?;
    }
    if parent_found
        != matches!(
            original.definition.declaration.owner,
            crate::analysis::resolve::ModelOwner::ChildOf(_)
        )
    {
        return None;
    }
    Some(())
}

fn created_pair_counted(
    second_statement: &IrStmt,
    second: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    count: &crate::analysis::scenario_disclosure::DisclosureCountQuery,
) -> Option<()> {
    let IrStmt::Create { input, .. } = second_statement else {
        return None;
    };
    let IrExpr::Object(entries) = &input.expr else {
        return None;
    };
    let mut counted = entries.iter().filter(|(_, value)| {
        matches!(&value.expr, IrExpr::Binary { op: IrBinOp::Add, left, right }
            if left.span == node_span(count.call)
                && left.ty == ResolvedType::Scalar(Scalar::Int)
                && right.ty == ResolvedType::Scalar(Scalar::Int)
                && matches!(right.expr, IrExpr::Int(1)))
    });
    let (_, increment) = counted.next()?;
    if counted.next().is_some()
        || increment.ty != ResolvedType::Scalar(Scalar::Int)
        || !second.inputs.iter().any(|input| {
            input.field.is_some()
                && node_span(input.value_node) == increment.span
                && input.ty == ResolvedType::Scalar(Scalar::Int)
        })
    {
        return None;
    }
    Some(())
}

fn checked_created_pair<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    db: &SourceDb,
) -> Option<(
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    &'a crate::analysis::scenario_disclosure::CheckedScenarioCreate,
)> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    let [first, second] = facts.creates.as_deref()? else {
        return None;
    };
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let IrItemKind::Scenario {
        params, effects, ..
    } = &owner.kind
    else {
        return None;
    };
    let contained_child = second.definition.declaration.owner
        == crate::analysis::resolve::ModelOwner::ChildOf(first.model);
    let parent_id = if contained_child {
        // The new child names the earlier created row, not a sibling's
        // existing parent or its count context.
        None
    } else {
        created_pair_parent(
            first.definition.declaration.owner,
            second.definition.declaration.owner,
        )?
    };
    if created_pair_header_mismatch(ir, owner, first, second, checked, parent_id) {
        return None;
    }
    let mut creates = effects
        .iter()
        .enumerate()
        .filter(|(_, statement)| matches!(statement, IrStmt::Create { .. }));
    let (position, first_statement) = creates.next()?;
    let (second_position, second_statement) = creates.next()?;
    let duplicate = creates.next().is_some();
    if created_pair_statements_mismatch(
        duplicate,
        second_position,
        position,
        effects,
        params,
        ir,
        parent_id.is_none(),
        first,
        second,
    ) {
        return None;
    }
    let queries = facts.queries.as_deref()?;
    if !queries.is_empty() {
        checked_native_query_influences(queries)
            .or_else(|| checked_mixed_helper_query_influences(facts))?;
    }
    let parent_context = if let Some(parent_id) = parent_id {
        Some(created_pair_parent_context(
            ir, owner, queries, second, parent_id, db,
        )?)
    } else {
        None
    };
    let result_type = ResolvedType::Record {
        symbol: first.model,
        stored: true,
    };
    let mut reference_inputs = second.inputs.iter().filter(|input| input.ty == result_type);
    let reference = reference_inputs.next()?;
    if reference_inputs.next().is_some()
        || if contained_child {
            reference.field.is_some() || reference.name != "parent"
        } else {
            reference.field.is_none()
        }
    {
        return None;
    }
    for (original, statement) in [(first, first_statement), (second, second_statement)] {
        created_pair_statement(
            ir,
            owner,
            checked,
            original,
            statement,
            parent_context.as_ref(),
            second.node,
            reference.value_node,
            &result_type,
            &first.binding,
            db,
        )?;
    }
    let Some((count, _, _)) = parent_context else {
        return Some((first, second));
    };
    created_pair_counted(second_statement, second, count)?;
    Some((first, second))
}

/// A second constructor's first-model operand must still name the original
/// earlier CreateAs, never a same-type parameter or alias substituted in IR.
pub(super) fn checked_created_reference_operand(
    ir: &IrProgram,
    original: &crate::analysis::scenario_disclosure::CheckedScenarioCreate,
    actual: &TypedExpr,
    node: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<()> {
    if !matches!(actual.ty, ResolvedType::Record { stored: true, .. }) {
        return Some(());
    }
    let mut owners = ir.items.iter().filter(|owner| {
        ir.scenario_disclosures
            .get(&owner.id)
            .and_then(|disclosure| disclosure.source_facts())
            .and_then(|facts| facts.creates.as_deref())
            .is_some_and(|creates| {
                creates.len() == 2
                    && creates.iter().any(|created| {
                        created.node == original.node && created.source == original.source
                    })
            })
    });
    let Some(owner) = owners.next() else {
        return Some(());
    };
    if owners.next().is_some() {
        return None;
    }
    if matches!(&owner.kind, IrItemKind::Scenario { result: None, .. }) {
        // Void inputs retain their own typed original occurrence; no result
        // pair is borrowed. Earlier CreateAs values keep their actual binding.
        let facts = super::scenario_calls::checked_source(ir, owner, db)?;
        for created in facts.creates.as_deref()? {
            if created.node.end <= original.node.start
                && actual.ty
                    == (ResolvedType::Record {
                        symbol: created.model,
                        stored: true,
                    })
                && matches!(&actual.expr, IrExpr::Name(name) if name == &created.binding)
            {
                return created_record_name_matches(
                    actual,
                    &actual.ty,
                    &created.binding,
                    node_span(original.node),
                    db,
                );
            }
        }
        return checked_required_model_parameter_value(
            ir,
            owner,
            actual,
            node_span(original.node),
            db,
        );
    }
    let (first, second) = checked_created_pair(ir, owner, db)?;
    if original.node == second.node
        && actual.ty
            == (ResolvedType::Record {
                symbol: first.model,
                stored: true,
            })
    {
        if !second.inputs.iter().any(|input| {
            input.value_node == node
                && input.ty == actual.ty
                && (input.field.is_some()
                    || input.name == "parent"
                        && second.definition.declaration.owner
                            == crate::analysis::resolve::ModelOwner::ChildOf(first.model))
        }) {
            return None;
        }
        created_record_name_matches(
            actual,
            &actual.ty,
            &first.binding,
            node_span(second.node),
            db,
        )?;
    }
    Some(())
}

fn model_result_prefix(statement: &IrStmt) -> bool {
    fn branch(statements: &[IrStmt], depth: usize) -> bool {
        depth <= 16
            && statements.iter().all(|statement| match statement {
                IrStmt::Require { .. } | IrStmt::Return { value: Some(_), .. } => true,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    ..
                } => branch(then_branch, depth + 1) && branch(else_branch, depth + 1),
                _ => false,
            })
    }
    match statement {
        IrStmt::Let { .. } | IrStmt::Require { .. } => true,
        IrStmt::If {
            then_branch,
            else_branch,
            ..
        } => branch(then_branch, 0) && branch(else_branch, 0),
        _ => false,
    }
}

/// A finite original created-row tail may branch and emit its original event.
/// This checks effect order only; source correspondence, event fields, created
/// reference identity and every native effect remain independently checked.
fn created_effects_ordered_tail(
    effects: &[IrStmt],
    file: crate::source::SourceId,
    previous: u32,
    until: u32,
) -> bool {
    let mut pending = vec![(effects, previous, until)];
    let mut visits = 0usize;
    while let Some((effects, mut previous, until)) = pending.pop() {
        for effect in effects {
            visits += 1;
            if visits > 16384 {
                return false;
            }
            let at = match effect {
                IrStmt::Let { span, .. }
                | IrStmt::Require { span, .. }
                | IrStmt::Set {
                    when: None, span, ..
                }
                | IrStmt::Send {
                    binding: Some(_),
                    span,
                    ..
                }
                | IrStmt::Emit { span, .. }
                | IrStmt::Schedule { span, .. } => *span,
                IrStmt::If {
                    then_branch,
                    else_branch,
                    span,
                    ..
                } => {
                    pending.push((then_branch.as_slice(), span.start, span.end));
                    pending.push((else_branch.as_slice(), span.start, span.end));
                    *span
                }
                _ => return false,
            };
            if at.file != file || at.start < previous || at.end > until {
                return false;
            }
            previous = at.end;
        }
    }
    true
}

fn created_pair_nodes(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
) -> Option<Option<crate::analysis::NodeKey>> {
    let facts = super::scenario_calls::checked_source(ir, owner, db)?;
    if facts
        .creates
        .as_deref()
        .is_some_and(|creates| creates.len() == 2)
    {
        let (first, second) = checked_created_pair(ir, owner, db)?;
        if first.node != create || first.model != model || first.binding != binding {
            return None;
        }
        Some(Some(second.node))
    } else {
        Some(None)
    }
}

fn created_direct_sequence(
    effects: &[IrStmt],
    create: crate::analysis::NodeKey,
    paired: Option<crate::analysis::NodeKey>,
    last_create: crate::analysis::NodeKey,
) -> bool {
    let direct = matches!(effects.get(effects.len() - 2),
        Some(IrStmt::Create {span, ..}) if *span == node_span(create))
        && effects[..effects.len() - 2].iter().all(model_result_prefix);
    let direct = direct
        || paired.is_some()
            && matches!(
        effects.get(effects.len() - 2), Some(IrStmt::Create {span, ..})
            if *span == node_span(last_create));
    // A late requirement has the same shared-owner rollback semantics without
    // needing the unrelated guarded-send sequence below. Its exact condition
    // and source position remain checked by checked_created_statements.
    direct
        || effects.iter().enumerate().any(|(position, effect)| {
            let after = position + 1 + usize::from(paired.is_some());
            after < effects.len()
                && matches!(effect, IrStmt::Create { span, .. } if *span == node_span(create))
                && effects[..position].iter().all(model_result_prefix)
                && matches!(effects.last(), Some(IrStmt::Return { span, .. })
                    if created_effects_ordered_tail(&effects[after..effects.len() - 1], create.file,
                        paired.unwrap_or(create).end, span.start))
        })
}

fn find_created_positions(
    effects: &[IrStmt],
    paired: Option<crate::analysis::NodeKey>,
    create: crate::analysis::NodeKey,
) -> Option<(usize, &IrStmt, usize)> {
    let mut creates = effects
        .iter()
        .enumerate()
        .filter(|(_, effect)| matches!(effect, IrStmt::Create { .. }));
    let (position, statement) = creates.next()?;
    let last_position = if let Some(second) = paired {
        let (second_position, second_statement) = creates.next()?;
        if second_position != position + 1
            || !matches!(second_statement, IrStmt::Create {span, ..}
                if *span == node_span(second))
        {
            return None;
        }
        second_position
    } else {
        position
    };
    if creates.next().is_some()
        || effects[..position]
            .iter()
            .any(|effect| !model_result_prefix(effect))
        || !matches!(statement, IrStmt::Create {input, span, ..}
            if *span == node_span(create) && matches!(&input.expr,
                IrExpr::Object(entries) if !entries.is_empty()))
    {
        return None;
    }
    Some((position, statement, last_position))
}

fn created_guarded_sequence(
    ir: &IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    effects: &[IrStmt],
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    last_create: crate::analysis::NodeKey,
    last_position: usize,
) -> Option<()> {
    {
        let [
            _,
            IrStmt::Set {
                record: before,
                when: None,
                span: before_at,
                ..
            },
            IrStmt::Send {
                operation,
                when: Some(_),
                binding: Some(sent),
                span: send_at,
                ..
            },
            IrStmt::Set {
                record: after,
                changes,
                when: None,
                span: after_at,
            },
            tail @ ..,
        ] = &effects[last_position..]
        else {
            return None;
        };
        if !operation.starts_with("std.")
            || sent.is_empty()
            || tail.is_empty()
            || tail[..tail.len() - 1]
                .iter()
                .any(|effect| !matches!(effect, IrStmt::Require { .. }))
        {
            return None;
        }
        let record = ResolvedType::Record {
            symbol: model,
            stored: true,
        };
        if matches!(&before.expr, IrExpr::Name(name) if name == binding) {
            created_record_name_matches(before, &record, binding, *before_at, db)?;
        } else {
            checked_first_query_row(ir, owner, before, db)?;
        }
        created_record_name_matches(after, &record, binding, *after_at, db)?;
        let IrExpr::Object(entries) = &changes.expr else {
            return None;
        };
        let [(_, delivery)] = entries.as_slice() else {
            return None;
        };
        let ResolvedType::StdDelivery { capability, op } = &delivery.ty else {
            return None;
        };
        if !matches!(&delivery.expr, IrExpr::Name(name) if name == sent)
            || operation != &format!("{capability}.{}", op.name)
            || last_create.end > before_at.start
            || before_at.end > send_at.start
            || send_at.end > after_at.start
        {
            return None;
        }
        let mut previous = last_create.end;
        for effect in &effects[last_position + 1..] {
            let at = match effect {
                IrStmt::Set { span, .. }
                | IrStmt::Send { span, .. }
                | IrStmt::Require { span, .. }
                | IrStmt::Return { span, .. } => *span,
                _ => return None,
            };
            if at.file != create.file || at.start < previous {
                return None;
            }
            previous = at.end;
        }
        Some(())
    }
}

fn ordered_created_model_effects(
    ir: &IrProgram,
    owner: &IrItem,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 2 {
        return None;
    }
    let paired = created_pair_nodes(ir, owner, db, create, model, binding)?;
    let last_create = paired.unwrap_or(create);
    if !created_direct_sequence(effects, create, paired, last_create) {
        let (_, _, last_position) = find_created_positions(effects, paired, create)?;
        created_guarded_sequence(
            ir,
            owner,
            db,
            effects,
            create,
            model,
            binding,
            last_create,
            last_position,
        )?;
    }
    let IrStmt::Return {
        value: Some(value),
        span,
    } = effects.last()?
    else {
        return None;
    };
    if span.file != create.file || create.end > span.start {
        return None;
    }
    created_record_name_matches(
        value,
        &ResolvedType::Record {
            symbol: model,
            stored: true,
        },
        binding,
        *span,
        db,
    )
}

fn root_effect_changes_closed(
    entries: &[(String, TypedExpr)],
    record_type: &ResolvedType,
    binding: &str,
    set_span: Span,
    db: &SourceDb,
) -> Option<()> {
    let mut pending: Vec<_> = entries.iter().map(|(_, value)| value).collect();
    let mut visited = 0usize;
    while let Some(value) = pending.pop() {
        visited += 1;
        if visited > 16384
            || value.span.file != set_span.file
            || value.span.start < set_span.start
            || value.span.end > set_span.end
        {
            return None;
        }
        match &value.expr {
            IrExpr::Member { base, .. } => {
                created_record_name_matches(base, record_type, binding, value.span, db)?;
            }
            IrExpr::Binary { left, right, .. } => {
                pending.push(left);
                pending.push(right);
            }
            IrExpr::Unary { operand, .. } => pending.push(operand),
            _ => {}
        }
    }
    Some(())
}

fn ordered_root_effects(
    owner: &IrItem,
    create: crate::analysis::NodeKey,
    model: crate::analysis::SymbolId,
    binding: &str,
    db: &SourceDb,
) -> Option<()> {
    let IrItemKind::Scenario { effects, .. } = &owner.kind else {
        return None;
    };
    if effects.len() < 3
        || !matches!(effects.first(), Some(IrStmt::Create { .. }))
        || !matches!(effects.get(1), Some(IrStmt::Set { .. }))
        || !matches!(effects.last(), Some(IrStmt::Return { .. }))
        || effects[2..effects.len() - 1]
            .iter()
            .any(|effect| !matches!(effect, IrStmt::Require { .. }))
    {
        return None;
    }
    let record_type = ResolvedType::Record {
        symbol: model,
        stored: true,
    };
    let IrStmt::Set {
        record,
        changes,
        when: None,
        span: set_span,
    } = &effects[1]
    else {
        return None;
    };
    created_record_name_matches(record, &record_type, binding, *set_span, db)?;
    if !closed_loop_changes(changes, binding, &record_type, &[]) {
        return None;
    }
    let IrExpr::Object(entries) = &changes.expr else {
        return None;
    };
    root_effect_changes_closed(entries, &record_type, binding, *set_span, db)?;
    let IrStmt::Return {
        value: Some(value),
        span: return_span,
    } = effects.last()?
    else {
        return None;
    };
    let IrExpr::Member { base, .. } = &value.expr else {
        return None;
    };
    if value.span.file != return_span.file
        || value.span.start < return_span.start
        || value.span.end > return_span.end
    {
        return None;
    }
    created_record_name_matches(base, &record_type, binding, value.span, db)?;
    let mut previous_end = 0;
    let mut found = false;
    for effect in effects {
        let span = match effect {
            IrStmt::Create { span, .. }
            | IrStmt::Set { span, .. }
            | IrStmt::Require { span, .. }
            | IrStmt::Return { span, .. } => *span,
            _ => return None,
        };
        if span.file != create.file || span.start < previous_end {
            return None;
        }
        previous_end = span.end;
        found |= span == node_span(create) && matches!(effect, IrStmt::Create { .. });
    }
    found.then_some(())
}

/// A created binding is the current owner-session row, never another same-type
/// local or admitted input whose copied Member site happens to match the proof.
pub(super) fn created_record_name_matches(
    value: &TypedExpr,
    record: &ResolvedType,
    binding: &str,
    containing: Span,
    db: &SourceDb,
) -> Option<()> {
    if value.ty != *record
        || !matches!(&value.expr, IrExpr::Name(name) if name == binding)
        || value.span.file != containing.file
        || value.span.start < containing.start
        || value.span.end > containing.end
        || db
            .get(value.span.file)?
            .text
            .get(value.span.start as usize..value.span.end as usize)?
            .trim()
            != binding
    {
        return None;
    }
    Some(())
}

fn checked_effect_node(
    ir: &IrProgram,
    owner: &IrItem,
    key: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<crate::syntax::SyntaxNode> {
    let original = super::scenario_calls::checked_source(ir, owner, db)?;
    if key.file != original.node.file
        || key.start < original.node.start
        || key.end > original.node.end
    {
        return None;
    }
    let file = db.get(key.file)?;
    let (tree, diagnostics) = crate::syntax::parse_source(key.file, &file.text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut steps = 0usize;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if crate::analysis::NodeKey::of(node) == key {
            return Some(node.clone());
        }
        pending.extend(node.children.iter().rev());
    }
    None
}

/// CST path spans own their leading trivia. Match the sole actual name token
/// while preserving the original whole-path span used by the checked proof.
pub(super) fn direct_source_path_name<'a>(
    node: &crate::syntax::SyntaxNode,
    text: &'a str,
) -> Option<&'a str> {
    if node.kind != SyntaxKind::Path {
        return None;
    }
    let mut parts = node
        .children
        .iter()
        .filter(|child| child.kind != SyntaxKind::Trivia);
    let name = parts.next()?;
    if name.kind != SyntaxKind::Name || parts.next().is_some() {
        return None;
    }
    Some(name.token()?.text(text))
}

/// The initial loop profile reads only its current element through direct
/// fields and eager scalar expressions. A different receiver or helper cannot
/// inherit the source loop's per-element provenance by sharing a record type.
/// `constants` names owner parameters whose value is fixed for every loop
/// element (the disclosure proves the matching constant intrinsic). Other
/// bare names keep their refusal: only the loop item reads per-element rows.
fn closed_loop_changes(
    changes: &TypedExpr,
    item: &str,
    record: &ResolvedType,
    constants: &[String],
) -> bool {
    let IrExpr::Object(entries) = &changes.expr else {
        return false;
    };
    let mut pending: Vec<_> = entries.iter().map(|(_, value)| value).collect();
    let mut visited = 0usize;
    while let Some(value) = pending.pop() {
        visited += 1;
        if visited > 16384 {
            return false;
        }
        match &value.expr {
            IrExpr::Name(name) => {
                if !constants.iter().any(|constant| constant == name) {
                    return false;
                }
            }
            IrExpr::Member { base, .. } => {
                if base.ty != *record || !matches!(&base.expr, IrExpr::Name(name) if name == item) {
                    return false;
                }
            }
            IrExpr::Binary { op, left, right } => {
                if matches!(op, IrBinOp::And | IrBinOp::Or | IrBinOp::Coalesce) {
                    return false;
                }
                pending.push(left);
                pending.push(right);
            }
            IrExpr::Unary { operand, .. } => pending.push(operand),
            IrExpr::Int(_)
            | IrExpr::Decimal(_)
            | IrExpr::Text(_)
            | IrExpr::Bool(_)
            | IrExpr::Null
            | IrExpr::Money { .. }
            | IrExpr::DurationMs(_)
            | IrExpr::Date(_)
            | IrExpr::Datetime(_) => {}
            _ => return false,
        }
    }
    true
}

/// Stored references use their canonical declaring Model descriptor. Arrays
/// retain the original required, non-null reference-array inventory separately.
fn assignment_reference_inventory_matches(
    ir: &IrProgram,
    base: &ResolvedType,
    nullable: bool,
    field: &JsModelField,
) -> Option<bool> {
    let (element, array) = match base {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        ty => (ty, false),
    };
    if !matches!(element, ResolvedType::Record { stored: true, .. }) {
        return None;
    }
    let Some(model) = reference_operand_type_id(ir, element) else {
        return Some(false);
    };
    let expected = format!("{model}[]");
    Some(
        matches!(&field.field, JsModelFieldType::Ref { model: actual } if actual == &model)
            && field.nullable == nullable
            && field.machine.is_none()
            && if array {
                !nullable
                    && reference_operand_type_id(ir, base).as_ref() == Some(&expected)
                    && field.value_type.as_ref() == Some(&expected)
                    && field.array_required.is_some()
            } else {
                field.value_type.as_deref()
                    == Some(format!("{model}{}", if nullable { "?" } else { "" }).as_str())
                    && field.array_required.is_none()
            },
    )
}

/// A declared provider slot uses the exact fresh model descriptor and operation.
/// The SEND producer and original ordered assignment are checked separately.
/// A computed array assignment consumes the exact original query LET, not
/// a stored wire or an arbitrary same-shaped local. Its field inventory is
/// independently reconstructed from the fresh owning declaration.
#[allow(clippy::too_many_arguments)]
fn checked_query_value_assignment(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    model: &IrItem,
    ty: &ResolvedType,
    field: &JsModelField,
    value: &TypedExpr,
    statement: NodeKey,
    db: Option<&SourceDb>,
) -> Option<()> {
    let ir = context.ir();
    if !matches!(
        ty,
        ResolvedType::Array {
            ordered: true,
            nonempty: false,
            ..
        }
    ) || !matches!(
        value.ty,
        ResolvedType::Array {
            ordered: true,
            nonempty: false,
            ..
        }
    ) || !super::source_let_data::capture_plain_value(ir, ty, 0)
        || !super::source_let_data::capture_plain_value(ir, &value.ty, 0)
    {
        return None;
    }
    context.same_scenario(ir, owner)?;
    let IrExpr::Name(name) = &value.expr else {
        return None;
    };
    let binding = [SyntaxKind::NameRef, SyntaxKind::Name, SyntaxKind::Path]
        .iter()
        .find_map(|kind| {
            context.resolved().node_binding.get(&NodeKey {
                file: value.span.file,
                start: value.span.start,
                end: value.span.end,
                kind: *kind as u8,
            })
        })?;
    let crate::analysis::resolve::Binding::Let { node } = binding else {
        return None;
    };
    let facts = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    let source = facts.query_values.as_deref()?.iter().find(|source| {
        source.statement == *node && source.binding == *name && source.ty == value.ty
    })?;
    if source.statement.file != statement.file
        || source.statement.end > statement.start
        || super::scenario_decisions::serial_type(ty, context.original(), ir, 0)?
            != super::scenario_decisions::serial_type(&value.ty, context.original(), ir, 0)?
    {
        return None;
    }
    let models = super::js::Emitter::source_models(context.fresh(), db?)?;
    let mut expected = models
        .iter()
        .filter(|candidate| candidate.name == model.canonical);
    let model = expected.next()?;
    if expected.next().is_some() {
        return None;
    }
    let mut fields = model
        .fields
        .iter()
        .filter(|candidate| candidate.name == field.name);
    let expected = fields.next()?;
    (fields.next().is_none()
        && serde_json::to_value(expected).ok()? == serde_json::to_value(field).ok()?)
    .then_some(())
}

fn checked_declared_delivery_assignment(
    context: &super::source_context::FreshSourceContext<'_>,
    model: &IrItem,
    ty: &ResolvedType,
    field: &JsModelField,
    db: Option<&SourceDb>,
) -> Option<()> {
    let base = match ty {
        ResolvedType::Nullable(inner) => inner.as_ref(),
        ty => ty,
    };
    let ResolvedType::Delivery { op } = base else {
        return None;
    };
    super::source_correspondence::same_capability_operation(context, *op)?;
    if !matches!(field.field, JsModelFieldType::Delivery(_)) {
        return None;
    }
    let models = super::js::Emitter::source_models(context.fresh(), db?)?;
    let mut models = models.iter().filter(|item| item.name == model.canonical);
    let expected = models.next()?;
    if models.next().is_some() {
        return None;
    }
    let mut fields = expected
        .fields
        .iter()
        .filter(|item| item.name == field.name);
    let expected = fields.next()?;
    (fields.next().is_none()
        && serde_json::to_value(expected).ok()? == serde_json::to_value(field).ok()?)
    .then_some(())
}

fn delivery_assignment_inventory_match(
    capability: &str,
    op: &crate::analysis::catalog::StdOperation,
    nullable: bool,
    field: &JsModelField,
) -> bool {
    let Some(expected) = super::js::delivery_descriptor(capability, op) else {
        return false;
    };
    matches!(&field.field, JsModelFieldType::Delivery(delivery)
        if delivery.capability == expected.capability
            && delivery.operation == expected.operation
            && delivery.version == expected.version
            && delivery.result.to_json() == expected.result.to_json())
        && field.nullable == nullable
        && field.array_required.is_none()
        && field.machine.is_none()
        && field.value_type.is_none()
}

fn assignment_inventory_matches(ir: &IrProgram, ty: &ResolvedType, field: &JsModelField) -> bool {
    let (base, nullable) = match ty {
        ResolvedType::Nullable(inner) => (inner.as_ref(), true),
        ty => (ty, false),
    };
    if *base == ResolvedType::Scalar(Scalar::File) {
        // Assignment lifetime belongs to Files/State. This does not admit
        // File through the scalar result or dependency observation codecs.
        return matches!(field.field, JsModelFieldType::File)
            && field.value_type.as_deref() == Some(if nullable { "file?" } else { "file" })
            && field.nullable == nullable
            && field.array_required.is_none()
            && field.machine.is_none();
    }
    if let ResolvedType::StdDelivery { capability, op } = base {
        return delivery_assignment_inventory_match(capability, op, nullable, field);
    }
    if let Some(matches) = assignment_reference_inventory_matches(ir, base, nullable, field) {
        return matches;
    }
    let (element, array) = match base {
        ResolvedType::Array { element, .. } => (element.as_ref(), true),
        ty => (ty, false),
    };
    if let ResolvedType::Enum { cases, owner } = element {
        // Plain stored-enum assignment through the identical enum(...)
        // inventory as the declared field. Machine lifecycle enums keep
        // their transition-recipe refusal, and arrays never gain this
        // profile; the checked literal already guarantees case membership.
        if array || cases.is_empty() || field.machine.is_some() {
            return false;
        }
        match &field.field {
            JsModelFieldType::Enum { values } if values == cases => {}
            JsModelFieldType::Nominal { name }
                if owner.is_some_and(|owner| {
                    ir.items.get(owner.0 as usize).is_some_and(|declaration| {
                        name == &declaration.canonical
                            && field.value_type.as_deref() == Some(name.as_str())
                    })
                }) => {}
            _ => return false,
        }
        let expected = format!(
            "enum({}){}",
            cases.join(","),
            if nullable { "?" } else { "" }
        );
        return native_result_type(ty)
            && (inventory_type(field).as_deref() == Some(expected.as_str())
                || !nullable && owner.is_some_and(|owner|
                    ir.items.get(owner.0 as usize).is_some_and(|declaration|
                        field.value_type.as_deref()==Some(declaration.canonical.as_str())
                        && matches!(&declaration.kind, IrItemKind::Field {ty:IrType::Known(ResolvedType::Enum {cases:original,owner:Some(original_owner)}),..}
                            if *original_owner==owner && original==cases))));
    }
    let ResolvedType::Scalar(scalar) = element else {
        return false;
    };
    let expected = format!(
        "{}{}{}",
        scalar.as_str(),
        if array { "[]" } else { "" },
        if nullable { "?" } else { "" }
    );
    native_result_type(ty) && inventory_type(field).as_deref() == Some(expected.as_str())
}

fn file_assignment_signature<'i, 'c>(
    ir: &'i IrProgram,
    owner: &IrItem,
    checked: &'c crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    input: &crate::analysis::scenario_disclosure::DisclosureFileInput,
) -> Option<(
    &'i IrItem,
    usize,
    &'c crate::analysis::scenario_disclosure::CheckedScenarioParameter,
)> {
    let IrItemKind::Scenario {
        params,
        trusted: false,
        read: false,
        event_source: None,
        hook: None,
        cohort: None,
        ..
    } = &owner.kind
    else {
        return None;
    };
    let parameter = ir.items.get(input.parameter.0 as usize)?;
    let IrItemKind::Param {
        owner: declared_owner,
        index,
        ty: IrType::Known(ty),
        default: None,
        default_node: None,
        array_bounds: None,
        ..
    } = &parameter.kind
    else {
        return None;
    };
    let file = ResolvedType::Scalar(Scalar::File);
    let source = checked
        .source_facts
        .as_ref()?
        .parameters
        .iter()
        .find(|parameter| parameter.parameter == input.parameter)?;
    if parameter.id != input.parameter
        || *declared_owner != owner.id
        || params.get(*index) != Some(&input.parameter)
        || parameter.module != owner.module
        || *ty != file
        || source.ty != file
        || source.default.is_some()
    {
        return None;
    }
    Some((parameter, *index, source))
}

fn file_assignment_value_matches(
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    input: &crate::analysis::scenario_disclosure::DisclosureFileInput,
    value: &TypedExpr,
    statement: crate::analysis::NodeKey,
    parameter_name: &str,
) -> bool {
    let file = ResolvedType::Scalar(Scalar::File);
    if value.ty != file
        || value.span != node_span(input.value)
        || input.value.kind != SyntaxKind::NameRef as u8
        || !matches!(&value.expr,IrExpr::Name(name) if name == parameter_name)
        || input.value.file != checked.node.file
        || input.value.start < checked.node.start
        || input.value.end > checked.node.end
        || input.value.file != statement.file
        || input.value.start < statement.start
        || input.value.end > statement.end
    {
        return false;
    }
    true
}

fn file_assignment_source<'i>(
    ir: &'i IrProgram,
    owner: &IrItem,
    db: &SourceDb,
    input: &crate::analysis::scenario_disclosure::DisclosureFileInput,
    parameter_name: &str,
) -> Option<&'i crate::analysis::scenario_disclosure::CheckedScenarioSource> {
    // Both the proof and executable IR are mutable carriers. Join the actual
    // name to the original value and parameter declaration in verified source
    // bytes, so changing both carriers to another valid File input cannot pass.
    let original = super::scenario_calls::checked_source(ir, owner, db)?;
    let authored = db.get(input.value.file)?;
    if authored
        .text
        .get(input.value.start as usize..input.value.end as usize)?
        != parameter_name
    {
        return None;
    }
    Some(original)
}

fn file_assignment_tree_matches(
    value: crate::analysis::NodeKey,
    declaration_node: crate::analysis::NodeKey,
    parameter_span: Span,
    parameter_name: &str,
    authored_text: &str,
) -> Option<()> {
    let (tree, diagnostics) = crate::syntax::parse_source(value.file, authored_text);
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == crate::diagnostic::Severity::Error)
    {
        return None;
    }
    let mut pending = vec![&tree];
    let mut steps = 0usize;
    let mut matched_declaration = false;
    let mut matched_value = false;
    while let Some(node) = pending.pop() {
        steps += 1;
        if steps > 200000 {
            return None;
        }
        if crate::analysis::NodeKey::of(node) == declaration_node {
            let name = node
                .children
                .iter()
                .find(|child| child.kind == SyntaxKind::Name)?;
            if node.kind != SyntaxKind::Parameter
                || name.span != parameter_span
                || name.token()?.text(authored_text) != parameter_name
            {
                return None;
            }
            matched_declaration = true;
        }
        if crate::analysis::NodeKey::of(node) == value {
            matched_value = node.kind == SyntaxKind::NameRef;
        }
        if matched_declaration && matched_value {
            return Some(());
        }
        pending.extend(node.children.iter().rev());
    }
    None
}

fn file_assignment_input_matches(
    ir: &IrProgram,
    owner: &IrItem,
    checked: &crate::analysis::scenario_disclosure::CheckedScenarioDisclosure,
    input: &crate::analysis::scenario_disclosure::DisclosureFileInput,
    value: &TypedExpr,
    statement: crate::analysis::NodeKey,
    db: &SourceDb,
) -> Option<()> {
    let (parameter, index, source) = file_assignment_signature(ir, owner, checked, input)?;
    if !file_assignment_value_matches(checked, input, value, statement, &parameter.name) {
        return None;
    }
    let original = file_assignment_source(ir, owner, db, input, &parameter.name)?;
    let declaration = original.parameters.get(index)?;
    if declaration.parameter != input.parameter || declaration.node != source.node {
        return None;
    }
    let authored = db.get(input.value.file)?;
    file_assignment_tree_matches(
        input.value,
        declaration.node,
        parameter.span,
        &parameter.name,
        &authored.text,
    )
}

/// This IR profile is immutable Values filtering, never records().
fn literal_enum_values_query(
    query: &super::ir::IrQuery,
) -> Option<(
    crate::analysis::SymbolId,
    Vec<String>,
    &TypedExpr,
    &TypedExpr,
)> {
    let super::ir::IrQueryDomain::Value { base, .. } = &query.domain else {
        return None;
    };
    let ResolvedType::Array {
        element,
        ordered: true,
        nonempty: true,
    } = &base.ty
    else {
        return None;
    };
    let ResolvedType::Enum {
        owner: Some(owner),
        cases,
    } = element.as_ref()
    else {
        return None;
    };
    let IrExpr::Array(entries) = &base.expr else {
        return None;
    };
    let predicate = query.where_pred.as_ref()?;
    let IrExpr::Binary {
        op: super::ir::IrBinOp::Eq,
        left,
        right,
    } = &predicate.expr
    else {
        return None;
    };
    if left.ty != right.ty
        || !matches!(&left.ty,ResolvedType::Enum{owner:Some(_),cases} if !cases.is_empty())
        || !(matches!(
            (&left.expr, &right.expr),
            (IrExpr::Name(_), IrExpr::Text(_)) | (IrExpr::Text(_), IrExpr::Name(_))
        ))
    {
        return None;
    }
    if cases.is_empty()
        || entries.is_empty()
        || entries.len() > 200
        || predicate.ty != ResolvedType::Scalar(Scalar::Bool)
        || query.parent.is_some()
        || query.select.is_some()
        || query.select_param.is_some()
        || query.where_async
        || query.limit.is_some()
        || query.archived.is_some()
        || !query.order.is_empty()
        || query.value_order.is_some()
        || query.collection_call.is_some()
        || query.contract_collection_call.is_some()
        || entries.iter().any(|entry| {
            entry.ty != **element
                || !matches!(&entry.expr,IrExpr::Text(value) if cases.contains(value))
        })
    {
        return None;
    }
    Some((*owner, cases.clone(), base, predicate))
}

/// Redeem one source-checked map over an already captured plain Values LET.
/// This visits ordinary projection DATA, never a second stored-row query.
fn checked_captured_value_map<'a>(
    context: &super::source_context::FreshSourceContext<'_>,
    owner: &IrItem,
    expression: &'a TypedExpr,
) -> Option<(&'a TypedExpr, &'a TypedExpr)> {
    let ir = context.ir();
    context.same_scenario(ir, owner)?;
    let IrExpr::Query(query) = &expression.expr else {
        return None;
    };
    let source = query.source.as_deref()?;
    let original = context.original().types.checked_queries.get(&source.node)?;
    let [binding, selected] = original.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name: alias } = &binding.kind else {
        return None;
    };
    if source != original
        || selected.kind != crate::analysis::types::CheckedQueryClauseKind::Select
        || selected.expressions.len() != 1
        || expression.span != node_span(original.node)
        || expression.ty != original.result
        || query.collection_call.is_some()
        || query.contract_collection_call.is_some()
        || query.parent.is_some()
        || query.where_pred.is_some()
        || !query.order.is_empty()
        || query.value_order.is_some()
        || query.limit.is_some()
        || query.archived.is_some()
        || query.select_param.as_ref() != Some(alias)
        || !super::source_let_data::capture_plain_value(ir, &original.domain_type, 0)
        || !super::source_let_data::capture_plain_value(ir, &original.result, 0)
    {
        return None;
    }
    let super::ir::IrQueryDomain::Value {
        base,
        alias: actual_alias,
    } = &query.domain
    else {
        return None;
    };
    let IrExpr::Name(name) = &base.expr else {
        return None;
    };
    let crate::analysis::resolve::Binding::Let { node } =
        context.resolved().node_binding.get(&original.domain)?
    else {
        return None;
    };
    let facts = context
        .original()
        .scenario_disclosures()
        .get(&owner.id)?
        .source_facts()?;
    let captured = facts.query_values.as_deref()?.iter().find(|value| {
        value.statement == *node && value.binding == *name && value.ty == original.domain_type
    })?;
    let value = query.select.as_deref()?;
    if actual_alias != alias
        || base.ty != captured.ty
        || base.span != node_span(original.domain)
        || node.file != original.node.file
        || node.end > original.node.start
        || value.span != node_span(selected.expressions[0])
        || context
            .original()
            .types
            .node_types
            .get(&selected.expressions[0])
            != Some(&value.ty)
        || !matches!(
            &original.domain_type,
            ResolvedType::Array {
                ordered: true,
                nonempty: false,
                ..
            }
        )
        || !matches!(
            &original.result,
            ResolvedType::Array {
                ordered: true,
                nonempty: false,
                ..
            }
        )
    {
        return None;
    }
    Some((base, value))
}

#[derive(Default)]
struct Sites<'a> {
    enum_values: HashMap<crate::analysis::SymbolId, Vec<String>>,
    members: HashMap<NativeSite, Vec<&'a TypedExpr>>,
    names: HashMap<NativeSite, Vec<&'a TypedExpr>>,
    transitions: HashMap<NativeSite, Vec<&'a IrStmt>>,
    effects: HashMap<NativeSite, &'a IrStmt>,
    decisions: HashMap<NativeSite, NativeDecisionKind>,
    matches: HashMap<NativeSite, HashSet<String>>,
    calls: HashMap<NativeSite, String>,
    returns: HashSet<Span>,
}

enum Visit<'a> {
    Statement(&'a IrStmt),
    Expression(&'a TypedExpr),
    Guard(&'a IrGuard),
}

impl<'a> Sites<'a> {
    fn collect(
        ir: &'a IrProgram,
        owner: &'a IrItem,
        send_guards: Option<&HashMap<Span, PreparedSendGuard>>,
        db: Option<&SourceDb>,
        purchase_all: Option<&serde_json::Value>,
        event_notice: Option<&serde_json::Value>,
        updated_model_owner: bool,
        copy_loop: Option<&serde_json::Value>,
        sibling_loop: Option<&serde_json::Value>,
        source_context: Option<&super::source_context::FreshSourceContext<'_>>,
    ) -> Option<Self> {
        let IrItemKind::Scenario {
            params,
            by,
            guards,
            effects,
            ..
        } = &owner.kind
        else {
            return None;
        };
        let mut out = Self::default();
        let mut pending = Vec::new();
        for (index, id) in params.iter().enumerate() {
            let param = ir.items.get(id.0 as usize)?;
            let IrItemKind::Param {
                owner: declared_owner,
                index: declared_index,
                default,
                default_node,
                ..
            } = &param.kind
            else {
                return None;
            };
            if param.id != *id || *declared_owner != owner.id || *declared_index != index {
                return None;
            }
            if let Some(IrDefault::Literal(expr) | IrDefault::Computed { expr, .. }) = default {
                if owning_module(ir, expr.span)?.id != owner.module {
                    return None;
                }
                let node = (*default_node)?;
                if node.file != expr.span.file
                    || node.start > expr.span.start
                    || node.end < expr.span.end
                {
                    return None;
                }
                let mut site = Walk::default().site(node_span(node));
                site.default_selection = true;
                if out
                    .decisions
                    .insert(site, NativeDecisionKind::ParameterDefault)
                    .is_some()
                {
                    return None;
                }
                pending.push((Visit::Expression(expr), Walk::default()));
            }
        }
        pending.extend(
            by.iter()
                .map(|guard| (Visit::Guard(guard), Walk::default())),
        );
        pending.extend(
            guards
                .iter()
                .chain(effects)
                .map(|statement| (Visit::Statement(statement), Walk::default())),
        );
        let mut visited = 0;
        while let Some((site, context)) = pending.pop() {
            visited += 1;
            let child = context.descend(visited, pending.len())?;
            macro_rules! push {
                ($site:expr) => {
                    pending.push(($site, child.clone()))
                };
            }
            macro_rules! extend {
                ($sites:expr) => {
                    pending.extend($sites.map(|site| (site, child.clone())))
                };
            }
            match site {
                Visit::Guard(guard) => match guard {
                    IrGuard::Role(_) => {}
                    IrGuard::Subject { person, .. } => push!(Visit::Expression(person)),
                    IrGuard::Expr(expr) => push!(Visit::Expression(expr)),
                    IrGuard::And(guards) | IrGuard::Or(guards) => {
                        extend!(guards.iter().map(Visit::Guard))
                    }
                    IrGuard::Not(guard) => push!(Visit::Guard(guard)),
                },
                Visit::Statement(statement) => match statement {
                    IrStmt::Create {
                        input,
                        when: None,
                        binding: Some(_),
                        span,
                        ..
                    } if matches!(&input.expr, IrExpr::Object(_)) => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        if !copy_loop.is_some_and(|copy|copy["node"]["start"]==span.start && copy["node"]["end"]==span.end){
                            push!(Visit::Expression(input));
                        }
                    }
                    IrStmt::Delete {
                        record,
                        mode: IrDeleteMode::Archive,
                        span,
                    } if matches!(record.expr, IrExpr::Name(_)) => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(record));
                    }
                    IrStmt::For {
                        domain,
                        limit: Some(limit),
                        body,
                        span,
                        ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some()
                            || out
                                .decisions
                                .insert(context.site(*span), NativeDecisionKind::For)
                                .is_some()
                        {
                            return None;
                        }
                        if sibling_loop.is_some_and(|plan|plan["loops"].as_array().is_some_and(|loops|loops.iter().any(|entry|entry["node"]["start"]==span.start&&entry["node"]["end"]==span.end))){
                            let IrExpr::Query(query)=&domain.expr else{return None;};push!(Visit::Expression(query.parent.as_deref()?));
                            push!(Visit::Expression(limit));
                            let mut original_body:Vec<_>=body.iter().collect();
                            while let Some(statement)=original_body.pop(){
                                let span=match statement{
                                    IrStmt::Create{span,..}|IrStmt::Set{span,..}|IrStmt::Send{span,..}|IrStmt::Cancel{span,..}=>*span,
                                    IrStmt::If{then_branch,else_branch,span,..}if else_branch.is_empty()=>{
                                        if out.decisions.insert(context.site(*span),NativeDecisionKind::If).is_some(){return None;}
                                        original_body.extend(then_branch);continue;
                                    },
                                    _=>return None,
                                };
                                if out.effects.insert(context.site(span),statement).is_some(){return None;}
                            }
                            continue;
                        }
                        // A proven member domain scans the whole contained
                        // collection: visit only its root parameter. Other
                        // queries keep the strict collection-query walk below.
                        if let Some(parent) =
                            contained_member_scan_parent(ir, owner, domain, *span, updated_model_owner)
                        {
                            push!(Visit::Expression(parent));
                        } else {
                            push!(Visit::Expression(domain));
                        }
                        push!(Visit::Expression(limit));
                        extend!(body.iter().map(Visit::Statement));
                    }
                    IrStmt::Call {
                        target: IrEffectCallTarget::Operation { operation, .. },
                        inputs,
                        binding,
                        span,
                        ..
                    } => {
                        if binding.is_some()
                            && super::scenario_calls::complete_read_query_child(
                                ir,
                                ir.items.get(operation.0 as usize)?,
                            )
                            .is_none()
                            && checked_created_model_result(ir, ir.items.get(operation.0 as usize)?)
                                .is_none()
                        {
                            return None;
                        }
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(inputs));
                    }
                    IrStmt::Set {
                        record,
                        changes,
                        span,
                        ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(record));
                        push!(Visit::Expression(changes));
                    }
                    IrStmt::Send {
                        args, when, span, ..
                    } => {
                        if when.is_some() {
                            let ScenarioDisclosure::Complete(checked) =
                                ir.scenario_disclosures.get(&owner.id)?
                            else {
                                return None;
                            };
                            let mut proofs = checked
                                .effects
                                .iter()
                                .filter(|proof| node_span(proof.node) == *span);
                            let proof = proofs.next()?;
                            if proofs.next().is_some() {
                                return None;
                            }
                            checked_send_guard(ir, owner, proof, statement, send_guards)?;
                        }
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        // Only request expressions belong to the parent capture.
                        // The sealed Rule evaluates its predicate at dispatch.
                        push!(Visit::Expression(args));
                    }
                    IrStmt::Transition { record, span, .. } => {
                        out.transitions
                            .entry(context.site(*span))
                            .or_default()
                            .push(statement);
                        push!(Visit::Expression(record));
                    }
                    IrStmt::Emit { payload, span, .. } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(payload));
                    }
                    IrStmt::Schedule {
                        key, at, payload, span, ..
                    } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(key));
                        push!(Visit::Expression(at));
                        push!(Visit::Expression(payload));
                    }
                    IrStmt::Cancel { key, span, .. } => {
                        if out.effects.insert(context.site(*span), statement).is_some() {
                            return None;
                        }
                        push!(Visit::Expression(key));
                    }
                    IrStmt::Let { value, .. } => push!(Visit::Expression(value)),
                    IrStmt::Require { cond, span } => {
                        let source_owned = context.calls.is_empty()
                            && ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                                .and_then(|facts| facts.source_requires.as_deref())
                                .is_some_and(|sites| {
                                    sites.iter().any(|site| {
                                        node_span(site.statement) == *span
                                            && node_span(site.node) == cond.span
                                    })
                                });
                        // The emitted source observer independently seals this whole
                        // guard and owns repeated lazy query/read lifetimes. It must
                        // not become once-per-parent static receipt observations.
                        if !source_owned {
                            push!(Visit::Expression(cond));
                        }
                    }
                    IrStmt::Return { value, span } => {
                        if !out.returns.insert(*span) {
                            return None;
                        }
                        extend!(value.iter().map(Visit::Expression));
                    }
                    IrStmt::If {
                        cond,
                        then_branch,
                        else_branch,
                        span,
                    } => {
                        if out
                            .decisions
                            .insert(context.site(*span), NativeDecisionKind::If)
                            .is_some()
                        {
                            return None;
                        }
                        push!(Visit::Expression(cond));
                        extend!(then_branch.iter().chain(else_branch).map(Visit::Statement));
                    }
                    IrStmt::Match {
                        subject,
                        arms,
                        span,
                    } => {
                        if out
                            .decisions
                            .insert(context.site(*span), NativeDecisionKind::Match)
                            .is_some()
                        {
                            return None;
                        }
                        let cases: HashSet<_> = arms.iter().map(|arm| arm.case.clone()).collect();
                        if cases.len() != arms.len() {
                            return None;
                        }
                        out.matches.insert(context.site(*span), cases);
                        push!(Visit::Expression(subject));
                        for arm in arms {
                            extend!(arm.body.iter().map(Visit::Statement));
                        }
                    }
                    _ => return None,
                },
                Visit::Expression(expression) if event_notice.is_some() && effects.iter().take(2).any(|stmt| matches!(stmt,IrStmt::Let{value,..} if std::ptr::eq(value,expression))) => {},
                Visit::Expression(expression) => match &expression.expr {
                    IrExpr::Query(query) if literal_enum_values_query(query).is_some() => {
                        let (owner,cases,base,predicate)=literal_enum_values_query(query)?;
                        if out.enum_values.insert(owner,cases.clone()).is_some_and(|previous|previous!=cases){return None;}
                        let IrExpr::Binary{left,..}=&predicate.expr else{return None;};
                        let ResolvedType::Enum{owner:Some(owner),cases}=&left.ty else{return None;};
                        if out.enum_values.insert(*owner,cases.clone()).is_some_and(|previous|previous!=*cases){return None;}
                        push!(Visit::Expression(base));push!(Visit::Expression(predicate));
                    }
                    IrExpr::Query(query) if updated_model_owner && constructor_values_order_domain(ir, query).is_some() => {
                        push!(Visit::Expression(constructor_values_order_domain(ir, query)?));
                    }
                    IrExpr::Query(query) => {
                        if context.calls.is_empty()
                            && let Some((base,selected))=source_context.and_then(|source|checked_captured_value_map(source,owner,expression)) {
                            push!(Visit::Expression(base));push!(Visit::Expression(selected));
                            continue;
                        }
                        let facts = super::scenario_calls::checked_source(ir, owner, db?)?;
                        if let Some(fact)=facts.query_values.as_deref().and_then(|values|values.iter().find(|value|expression.span==node_span(value.value)&&context.calls.is_empty())) {
                            if query.source.as_ref()?.node!=fact.value || expression.ty!=fact.ty {return None;}
                            if out.decisions.insert(context.site(expression.span),NativeDecisionKind::QuerySelection).is_some(){return None;}
                            push!(Visit::Expression(query.parent.as_ref()?));
                            if let Some(predicate)=query.where_pred.as_ref(){push!(Visit::Expression(predicate));}
                            push!(Visit::Expression(query.select.as_ref()?));
                            continue;
                        }
                        if let Some(fact) = facts.inline_selections.as_deref().and_then(|facts| {
                            facts.iter().find(|fact| {
                                context.calls.is_empty()
                                    && expression.span == node_span(fact.query.node)
                            })
                        }) {
                            let actual = checked_inline_selection_ir(ir, owner, fact, db?)?;
                            if !std::ptr::eq(actual, query) {
                                return None;
                            }
                            push!(Visit::Expression(query.parent.as_ref()?));
                            push!(Visit::Expression(query.where_pred.as_ref()?));
                            push!(Visit::Expression(query.select.as_ref()?));
                            // IrQuery.order has no executable TypedExpr. Its
                            // exact query-control source/field is captured by State.
                            continue;
                        }
                        let fact = facts.transcripts.as_deref()?.iter().find(|fact| {
                            context.calls.as_slice() == [node_span(fact.call)]
                                && query
                                    .source
                                    .as_ref()
                                    .is_some_and(|source| source.node == fact.query.node)
                        })?;
                        let IrItemKind::DeriveFn {
                            expr: Some(body), ..
                        } = &ir.items.get(fact.derive.0 as usize)?.kind
                        else {
                            return None;
                        };
                        let original = facts.creates.as_deref()?.iter().find(|created| {
                            checked_created_model_result(ir, owner) == Some(created.model)
                        })?;
                        super::scenario_create_sources::checked_create_expression(
                            ir, original, body, fact.body, db?,
                        )?;
                        push!(Visit::Expression(query.parent.as_ref()?));
                        push!(Visit::Expression(query.select.as_ref()?));
                    }
                    IrExpr::Member { base, .. } => {
                        if context.calls.is_empty()
                            && matches!(&base.ty,ResolvedType::Nullable(inner) if matches!(inner.as_ref(),ResolvedType::Record{stored:true,..}))
                            && let Some(db)=db
                            && let Some(facts)=super::scenario_calls::checked_source(ir,owner,db)
                            && let Some((parameter,presence,_))=checked_optional_parameter_scalar(ir,owner,expression,facts,db) {
                            let kind=NativeDecisionKind::OptionalInput(parameter);
                            if out.decisions.insert(context.site(node_span(presence)),kind).is_some_and(|old|old!=kind){return None;}
                        }
                        out.members
                            .entry(context.site(expression.span))
                            .or_default()
                            .push(expression);
                        push!(Visit::Expression(base));
                    }
                    IrExpr::Binary { op, left, right } => {
                        let kind = match op {
                            IrBinOp::And => Some(NativeDecisionKind::And),
                            IrBinOp::Or => Some(NativeDecisionKind::Or),
                            IrBinOp::Coalesce => Some(NativeDecisionKind::Coalesce),
                            _ => None,
                        };
                        if let Some(kind) = kind
                            && out
                                .decisions
                                .insert(context.site(expression.span), kind)
                                .is_some()
                        {
                            return None;
                        }
                        push!(Visit::Expression(left));
                        push!(Visit::Expression(right));
                    }
                    IrExpr::Array(items) | IrExpr::Format { args: items, .. } => {
                        extend!(items.iter().map(Visit::Expression))
                    }
                    IrExpr::Object(entries) => {
                        let mut names = HashSet::new();
                        if entries
                            .iter()
                            .any(|(name, _)| !direct_field_name(name) || !names.insert(name))
                        {
                            return None;
                        }
                        extend!(entries.iter().map(|(_, value)| Visit::Expression(value)));
                    }
                    IrExpr::Unary { operand, .. } => push!(Visit::Expression(operand)),
                    IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. } => {
                        if matches!(target, IrCallTarget::Builtin { id, awaited: false } if id == "all")
                            && purchase_all.is_some_and(|plan| super::purchase_all::at(plan, expression.span))
                        { continue; }
                        if matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
                            && checked_any_first_query_ir(ir, owner, expression, db?).is_some()
                        {
                            // Direct leading `require not any(...)` guard over
                            // the composed any/first shape: its predicate reads
                            // travel the native query observation path (like
                            // first above), never ordinary parent row reads.
                            continue;
                        }
                        if matches!(target,IrCallTarget::Builtin {id,awaited:false} if id=="any")
                            && ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|source| source.source_facts())
                                .is_some_and(|source| {
                                    source
                                        .transcripts
                                        .as_deref()
                                        .is_some_and(|facts| facts.len() == 2)
                                        && source
                                            .queries
                                            .as_deref()
                                            .is_some_and(|queries| queries.len() == 4)
                                })
                        {
                            checked_any_query_ir(ir, owner, expression, db?)?;
                            // The external unfinished predicate is evaluated in
                            // the genuine active candidate slot by its facade.
                            // Neither its leaf nor its Lambda is a root site.
                            continue;
                        }
                        if matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "count")
                            && let Some(facts) = ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                            && let Some(query) = facts.queries.as_deref().and_then(|queries| {
                                queries.iter().find(|query| {
                                    query.count.as_ref().is_some_and(|count| {
                                        node_span(count.call) == expression.span
                                    })
                                })
                            })
                        {
                            if query.count.as_ref()?.contained_parent.is_none() {
                                let (call, candidate, supplied) =
                                    checked_ancestor_count_query_operands(ir, owner, query, db?)?;
                                if !std::ptr::eq(call, expression) {
                                    return None;
                                }
                                for actual in [candidate, supplied] {
                                    out.members
                                        .entry(context.site(actual.span))
                                        .or_default()
                                        .push(actual);
                                }
                                continue;
                            }
                            if owner.canonical == "member_terms.assign" {
                                let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else { return None; };
                                checked_native_assign_count_query_plan(
                                    ir, owner, checked, query, db?, &query.source.module,
                                )?;
                                // This guard consumes a source-authenticated
                                // query at its original Require stage. Its
                                // candidate's active bit belongs to the query
                                // plan, not a root receipt Member site.
                                continue;
                            }
                            let original = facts.creates.as_deref()?.iter().find(|created| {
                                query
                                    .count
                                    .as_ref()
                                    .is_some_and(|count| count.statement == created.node)
                            })?;
                            let call = query.count.as_ref()?.call;
                            checked_count_query_ir(ir, original, expression, call, db?)?;
                            super::scenario_create_sources::checked_create_expression(
                                ir, original, expression, call, db?,
                            )?;
                            // This true contained domain is owned by its query
                            // producer, never ordinary parent field observations.
                            continue;
                        }
                        if matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "any")
                            && let [_, predicate] = args.as_slice()
                            && let Some(facts) = ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                            && let Some(_plain) = facts.queries.as_deref().and_then(|queries| {
                                queries.iter().find(|query| {
                                    plain_boolean_any_query(query)
                                        && plain_any_expr_matches(expression, query)
                                })
                            })
                        {
                            // A recorded plain boolean emptiness query observes
                            // its domain through the native query path, but its
                            // predicate member reads are ordinary per-candidate
                            // control observations at this call site: verify the
                            // lambda and record its body under the current
                            // context so query-scoped reads keep their site.
                            let IrExpr::Lambda { body, .. } = &predicate.expr else {
                                return None;
                            };
                            if predicate.ty != ResolvedType::Scalar(Scalar::Bool)
                                || body.ty != ResolvedType::Scalar(Scalar::Bool)
                            {
                                return None;
                            }
                            push!(Visit::Expression(body));
                            continue;
                        }
                        if matches!(target, IrCallTarget::Builtin {id,awaited:false} if id == "first")
                            && let Some(facts) = ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|value| value.source_facts())
                            && let Some(query) = facts.queries.as_deref().and_then(|queries| {
                                queries.iter().find(|query| {
                                    query.first.as_ref().is_some_and(|first| {
                                        node_span(first.call) == expression.span
                                    })
                                })
                            })
                        {
                            checked_owner_first_query_ir(
                                ir,
                                owner,
                                expression,
                                query.first.as_ref()?.call,
                                db?,
                            )?;
                            // Query candidate fields have their separate query
                            // observation path, not ordinary parent row reads.
                            continue;
                        }
                        // A checked bound-child predicate reads only the
                        // retained projection. Its element-local decisions
                        // belong to Values, not once-per-parent observations.
                        if let Some(domain) = retained_contract_predicate(expression, target, args)
                        {
                            // The domain is evaluated once outside the callback.
                            // Stored contract domains capture their real root
                            // field here; nested alias leaves create no sites.
                            push!(Visit::Expression(domain));
                            continue;
                        }
                        extend!(args.iter().map(Visit::Expression));
                        if let IrCallTarget::DeriveFn(canonical) = target {
                            if context.owners.contains(canonical) || context.calls.len() >= 64 {
                                return None;
                            }
                            let mut candidates =
                                ir.items.iter().filter(|item| item.canonical == *canonical);
                            let callee = candidates.next()?;
                            if candidates.next().is_some() {
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
                            if params.len() > 256 {
                                return None;
                            }
                            let slots = match &expression.expr {
                                IrExpr::BoundCall { slots, .. } => slots.clone(),
                                _ => (0..args.len()).map(Some).collect(),
                            };
                            if slots.len() != params.len()
                                || slots.iter().flatten().any(|index| *index >= args.len())
                                || (0..args.len()).any(|index| {
                                    slots.iter().filter(|slot| **slot == Some(index)).count() != 1
                                })
                            {
                                return None;
                            }
                            let call_site = context.site(expression.span);
                            if out.calls.insert(call_site, canonical.clone()).is_some() {
                                return None;
                            }
                            if db.is_some_and(|db| {
                                checked_helper_any_query_ir(ir, owner, expression, db).is_some()
                            }) && ir
                                .scenario_disclosures
                                .get(&owner.id)
                                .and_then(|source| source.source_facts())
                                .and_then(|facts| {
                                    checked_helper_any_influences(facts)
                                        .or_else(|| checked_mixed_helper_query_influences(facts))
                                        .or_else(||constructor_count_influences(facts))
                                })
                                .is_some()
                            {
                                // Preserve this original derive call and explicit argument
                                // order. Candidate fields/decisions belong to the query
                                // callback, never once-per-parent receipt observations.
                                continue;
                            }
                            let mut nested = child.clone();
                            nested.calls.push(expression.span);
                            nested.owners.push(canonical.clone());
                            if owning_module(ir, body.span)?.id != callee.module {
                                return None;
                            }
                            pending.push((Visit::Expression(body), nested.clone()));
                            for (id, slot) in params.iter().zip(slots) {
                                let param = ir.items.get(id.0 as usize)?;
                                let IrItemKind::Param { owner, default, .. } = &param.kind else {
                                    return None;
                                };
                                if param.id != *id || *owner != callee.id {
                                    return None;
                                }
                                if slot.is_none() {
                                    let default = match default.as_ref()? {
                                        IrDefault::Literal(expr)
                                        | IrDefault::Computed { expr, .. } => expr,
                                    };
                                    if owning_module(ir, default.span)?.id != callee.module {
                                        return None;
                                    }
                                    pending.push((Visit::Expression(default), nested.clone()));
                                }
                            }
                        }
                    }
                    IrExpr::Int(_)
                    | IrExpr::Decimal(_)
                    | IrExpr::Text(_)
                    | IrExpr::Bool(_)
                    | IrExpr::Null
                    | IrExpr::Money { .. }
                    | IrExpr::DurationMs(_)
                    | IrExpr::Date(_)
                    | IrExpr::Datetime(_)
                    | IrExpr::Message(_) => checked_receipt_literal(ir, owner, expression, db)?,
                    IrExpr::Name(_) => {
                        out.names
                            .entry(context.site(expression.span))
                            .or_default()
                            .push(expression);
                    }
                    IrExpr::HasRole { person, .. } => {
                        extend!(person.iter().map(|person| Visit::Expression(person)))
                    }
                    _ => return None,
                },
            }
        }
        Some(out)
    }
}

/// Literal descriptors contain no evaluated arguments. Their wording, source
/// language and variants are joined to the exact source by SourceExpressions.
fn checked_receipt_literal(
    ir: &IrProgram,
    owner: &IrItem,
    expression: &TypedExpr,
    db: Option<&SourceDb>,
) -> Option<()> {
    match &expression.expr {
        IrExpr::Message(message) if expression.ty == ResolvedType::InlineMessage => {
            message.params.is_empty().then_some(())
        }
        IrExpr::Message(_) => {
            let facts = ir.scenario_disclosures.get(&owner.id)?.source_facts()?;
            if !facts
                .expression_types
                .as_ref()?
                .iter()
                .any(|(node, ty)| node_span(*node) == expression.span && ty == &expression.ty)
            {
                return None;
            }
            super::scenario_create_sources::checked_static_named_message(
                ir,
                owner.module,
                expression,
                db?,
            )
        }
        _ => Some(()),
    }
}

/// The root parameter of a proven member-loop domain: a whole-collection
/// contained scan (`Model` domain with the root parameter as parent and no
/// filter, order, limit or projection). Anything else keeps the strict
/// collection-query walk, so filtered/projected scans never borrow this path.
/// A whole-collection contained scan carries no filter, order, limit or
/// projection; anything else keeps the strict collection-query walk.
fn member_scan_query_is_plain(query: &super::ir::IrQuery) -> bool {
    query.source.as_deref().is_none_or(|source| source.projection.is_none()
            && source.domain_type==source.result
            && matches!(source.clauses.as_slice(),[clause]
                if matches!(&clause.kind,crate::analysis::types::CheckedQueryClauseKind::As {..}) && clause.expressions.is_empty()))
        && query.collection_call.is_none()
        && query.contract_collection_call.is_none()
        && query.where_pred.is_none()
        && !query.where_async
        && query.order.is_empty()
        && query.value_order.is_none()
        && query.limit.is_none()
        && query.archived.is_none()
        && query.select.is_none()
        && query.select_param.is_none()
}

fn finite_member_filter(query: &super::ir::IrQuery) -> bool {
    let Some(source) = &query.source else {
        return false;
    };
    let [alias, filter] = source.clauses.as_slice() else {
        return false;
    };
    let Some(predicate) = &query.where_pred else {
        return false;
    };
    matches!(
        alias.kind,
        crate::analysis::types::CheckedQueryClauseKind::As { .. }
    ) && filter.kind == crate::analysis::types::CheckedQueryClauseKind::Where
        && filter.expressions.len() == 1
        && node_span(filter.expressions[0]) == predicate.span
        && predicate.ty == ResolvedType::Scalar(Scalar::Bool)
        && source.result == source.domain_type
        && source.projection.is_none()
        && query.collection_call.is_none()
        && query.contract_collection_call.is_none()
        && !query.where_async
        && query.order.is_empty()
        && query.value_order.is_none()
        && query.limit.is_none()
        && query.archived.is_none()
        && query.select.is_none()
        && query.select_param.is_none()
}

fn contained_member_scan_parent<'a>(
    ir: &'a IrProgram,
    owner: &IrItem,
    domain: &'a TypedExpr,
    span: Span,
    updated_model_owner: bool,
) -> Option<&'a TypedExpr> {
    let ScenarioDisclosure::Complete(checked) = ir.scenario_disclosures.get(&owner.id)? else {
        return None;
    };
    let proof = checked.effects.iter().find(|proof| {
        node_span(proof.node) == span
            && matches!(&proof.kind, DisclosureEffectKind::ForMember { .. })
    })?;
    let DisclosureEffectKind::ForMember {
        domain: checked_domain,
        parameter,
        model,
        ..
    } = &proof.kind
    else {
        return None;
    };
    if node_span(*checked_domain) != domain.span {
        return None;
    }
    let parameter_item = ir.items.get(parameter.0 as usize)?;
    let model_item = ir.items.get(model.0 as usize)?;
    let IrExpr::Query(query) = &domain.expr else {
        return None;
    };
    if !member_scan_query_is_plain(query) && !(updated_model_owner && finite_member_filter(query)) {
        return None;
    }
    let super::ir::IrQueryDomain::Model(name) = &query.domain else {
        return None;
    };
    if name != &model_item.canonical || model_item.id != *model {
        return None;
    }
    let parent = query.parent.as_deref()?;
    let IrExpr::Name(base) = &parent.expr else {
        return None;
    };
    if base != &parameter_item.name || parameter_item.id != *parameter {
        return None;
    }
    Some(parent)
}

fn retained_query_candidate<'q>(
    target: &IrCallTarget,
    args: &'q [TypedExpr],
    expression: &TypedExpr,
) -> Option<(
    &'q super::ir::IrQuery,
    &'q crate::analysis::types::CheckedContractCollectionCall,
)> {
    let IrCallTarget::Builtin { id, awaited: false } = target else {
        return None;
    };
    if !matches!(id.as_str(), "any" | "all") || args.len() != 2 {
        return None;
    }
    let mut candidates = args.iter().filter_map(|argument| match &argument.expr {
        IrExpr::Query(query) => query
            .contract_collection_call
            .as_deref()
            .map(|fact| (query, fact)),
        _ => None,
    });
    let (query, fact) = candidates.next()?;
    if candidates.next().is_some()
        || fact.builtin != *id
        || node_span(fact.node) != expression.span
        || expression.ty != ResolvedType::Scalar(Scalar::Bool)
        || fact.arguments.len() != 2
        || fact.slots[0] == fact.slots[1]
    {
        return None;
    }
    Some((query, fact))
}

fn retained_source_matches(
    source: &crate::analysis::types::CheckedQuery,
    fact: &crate::analysis::types::CheckedContractCollectionCall,
    alias: &crate::analysis::types::CheckedQueryClause,
    name: &String,
    actual_alias: &String,
    param: &String,
) -> bool {
    source.node == fact.query
        && source.domain == fact.domain
        && alias.node == fact.alias
        && name == actual_alias
        && name == param
        && source.projection.is_none()
        && alias.expressions.is_empty()
        && source.domain_type == source.result
}

fn retained_query_options_closed(query: &super::ir::IrQuery) -> bool {
    query.collection_call.is_none()
        && query.parent.is_none()
        && query.where_pred.is_none()
        && !query.where_async
        && query.value_order.is_none()
        && query.order.is_empty()
        && query.limit.is_none()
        && query.archived.is_none()
        && query.select.is_none()
        && query.select_param.is_none()
}

fn retained_domain_matches(
    query: &super::ir::IrQuery,
    source: &crate::analysis::types::CheckedQuery,
    base: &TypedExpr,
    domain: &TypedExpr,
    body: &TypedExpr,
    args: &[TypedExpr],
    fact: &crate::analysis::types::CheckedContractCollectionCall,
    expression: &TypedExpr,
) -> Option<()> {
    if !matches!(&domain.expr, IrExpr::Query(actual) if std::ptr::eq(actual,query))
        || domain.ty != source.result
        || base.ty != source.domain_type
        || base.span.file != fact.domain.file
        || base.span.start < fact.domain.start
        || base.span.end > fact.domain.end
        || !matches!(base.expr, IrExpr::Name(_) | IrExpr::Member { .. })
        || body.ty != fact.predicate.ty
        || args.get(fact.slots[1])?.ty != fact.predicate.ty
        || fact.predicate.ty != expression.ty
        || fact.arguments.get(fact.slots[1]) != Some(&fact.predicate.node)
        || args.iter().zip(&fact.arguments).any(|(arg, node)| {
            arg.span.file != node.file || arg.span.start < node.start || arg.span.end > node.end
        })
    {
        return None;
    }
    Some(())
}

fn retained_contract_predicate<'a>(
    expression: &TypedExpr,
    target: &IrCallTarget,
    args: &'a [TypedExpr],
) -> Option<&'a TypedExpr> {
    let (query, fact) = retained_query_candidate(target, args, expression)?;
    let source = query.source.as_deref()?;
    let [alias] = source.clauses.as_slice() else {
        return None;
    };
    let crate::analysis::types::CheckedQueryClauseKind::As { name } = &alias.kind else {
        return None;
    };
    let super::ir::IrQueryDomain::Value {
        base,
        alias: actual_alias,
    } = &query.domain
    else {
        return None;
    };
    let IrExpr::Lambda { param, body } = &args.get(fact.slots[1])?.expr else {
        return None;
    };
    let domain = args.get(fact.slots[0])?;
    if !retained_source_matches(source, fact, alias, name, actual_alias, param)
        || !retained_query_options_closed(query)
    {
        return None;
    }
    retained_domain_matches(query, source, base, domain, body, args, fact, expression)?;
    let slots = match &expression.expr {
        IrExpr::BoundCall { slots, .. } => slots.clone(),
        _ => (0..args.len()).map(Some).collect(),
    };
    (slots.as_slice() == [Some(fact.slots[0]), Some(fact.slots[1])]).then_some(base.as_ref())
}

#[derive(Clone, Default)]
struct Walk {
    calls: Vec<Span>,
    owners: Vec<String>,
    depth: usize,
}
impl Walk {
    fn descend(&self, visited: usize, pending: usize) -> Option<Self> {
        if visited > 16384 || pending > 16384 || self.depth >= 64 {
            return None;
        }
        let mut child = self.clone();
        child.depth += 1;
        Some(child)
    }

    fn site(&self, span: Span) -> NativeSite {
        NativeSite {
            calls: self.calls.clone(),
            span,
            default_selection: false,
        }
    }
}
fn checked_site(
    node: crate::analysis::NodeKey,
    calls: &[crate::analysis::NodeKey],
) -> Option<NativeSite> {
    if calls.len() > 64 || calls.iter().any(|call| call.kind != SyntaxKind::Call as u8) {
        return None;
    }
    Some(NativeSite {
        calls: calls.iter().copied().map(node_span).collect(),
        span: node_span(node),
        default_selection: false,
    })
}
fn owning_module(ir: &IrProgram, span: Span) -> Option<&super::ir::IrModule> {
    let mut candidates = ir.modules.iter().filter(|module| {
        module.file == span.file && module.span.start <= span.start && span.end <= module.span.end
    });
    let owner = candidates.next()?;
    candidates.next().is_none().then_some(owner)
}
fn source_matches(ir: &IrProgram, source: &DisclosureSource, span: Span) -> bool {
    owning_module(ir, span).is_some_and(|module| module.name == source.module)
        && !source.path.is_empty()
        && source.sha256.len() == 64
        && source
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
