# Optional dependency closure — 2026-10-04

**Proposal status:** neither the value-only closure revision nor optional binding/availability semantics has been adopted in shared specifications. The third full-context JEV rewrite was rejected by automatic approval review; the separately approved abstract exercise does not replace it. The recommendation below is reviewable advice with a narrower first milestone, not a completed consultation or deployment result.

Recommend the narrow value/role import correction as the independent first milestone. It removes four accidental commercial binding keys from both Mail and standalone Customer without new source syntax. The remaining manual-Mail optionality decision is unresolved: the reviewable candidate below uses app-declared binding absence plus explicit canonical availability, preserving live membership owners/rules. It would permit omission of the remaining four commercial implementations, but its services/available/when additions and actual app availability application are not settled or adopted. Keep current required-binding semantics until that shared decision is made. No automatic workflow or declaration pruning is selected.

This is the bounded [MIGRATION task 16](../draft/MIGRATION.md), against [L4](evaluation/evidence/language/findings.md#l4--optional-business-connections-are-mandatory-in-current-package-closures), [R3](evaluation/evidence/adoption/consolidation.md) and the [prior alternatives](evaluation/evidence/language/alternatives.md#3-optional-connections-and-executable-closure-l4--a-r3). No app/shared files change here. Standalone witnesses are source/desired-output evidence, not compiler, provider or runtime implementations. The optionality/availability syntax below is a proposal; present DESIGN does not support it.

## Actual dependency trace

Production owner inclusion follows DESIGN §§1/13, not runtime false branches. The [trace](optional-dependency-closure-20261004/closure.json) records exact inspected source hashes, declaration/import sites and the two candidate graphs. It excludes fixture-only groups from production and ignores bound provider execution, retaining bound schema requirements.

| Selected source | Current executable owners | Current binding keys | Proposed value-only owners | Proposed value-only keys |
| --- | --- | --- | --- | --- |
| CanCustomer/customer | customer, employee, rent_catalog, invoice | mail, payments, billing_ingress, documents, sales_ingress | customer, employee, rent_catalog | mail |
| CanMail/mailroom | mailroom, customer, employee, rent_catalog, invoice, member_plans, member_terms, sales_attribution, refer, affiliate | mail, billing, payments, billing_ingress, documents, sales_ingress, membership_ingress, qualified_sales, commissions | Same nine owners except invoice | mail, billing, membership_ingress, qualified_sales, commissions |

Every key in the table has the `deployment.` prefix. These are logical interface binding names, not a count of accounts, vendors, subscriptions, separate deployments or physical Cloudflare resources. No tariff/support saving is asserted. All core runtime/auth/team/database/file defaults and included owner storage remain.

The exact accidental edges are `customer -> invoice.finance` (CanCustomer.can:11) and `mailroom -> invoice.Charge` (CanMail.can:8). Invoice declares the exported role at :73 and structural Charge at :42; Charge reaches DocumentLine, scalar values and localization assets, not Customer records. Retaining its canonical finance-role metadata/grants does not require Invoice execution. Customer's scoped finance read policies (:40–42), `approve_account` (:96–103) and billing approval page (:249) must still test **invoice.finance**, current work locations and the original reason/evidence rules. They do not call an Invoice operation or provider. Removing only Charge's direct edge under existing bound-schema rules is useful authoring cleanup but leaves the role edge, so the current executable/binding closure does not change.

The necessary live edge is `mailroom -> member_terms {Term,eligible_term}` (:7). `eligible_term` (CanMember.can:129–130) queries current Customer contacts/company grants, term/membership archived/paused/revoked/paid state, interval and Seat records. Membership imports sales_attribution and refer (:52–53); Capture references Advocate/Partner, bringing affiliate. These are live ownership/read dependencies, not value assets. Source file relocation does not change this graph. Mail does not select CanMember's seven-package app assembly just because it imports member_terms.

## First contract: bounded asset inference

A plain import group containing only exported structural contracts, static role identities and messages includes their owning canonical schema/role/assets and reachable dependencies, without including that provider's executable package. Preserve owner-qualified identity, resolved types/constraints/default semantics, labels/descriptions and qualified grant metadata. A group containing a stored model, record-backed derive, operation or business event keeps ordinary whole-owner inclusion. Treat all exported derives as ordinary executable imports in this milestone; do not infer arbitrary functions harmless. Fixture-only groups remain test-only. Bound interface extraction stays unchanged.

A contract-held **model reference** adds that model's real executable owner, read/admission routing and whole owner behavior. A reused scalar/enum field value type includes its declared type/constraints/assets, not a live record read. Any schema dependency that actually needs executable state adds its owner; fail checking if an extraction cannot preserve semantics. This is finite checked declaration/type dependency classification, not guard satisfiability or branch pruning. Mixed groups cannot suppress their business dependencies. A selected owner still contributes its whole body.

Customer's `use invoice {finance}` therefore stays exactly as authored, while generated predicates remain `hasRole(c,"invoice.finance")`. No Invoice handler module is imported only to obtain a role constant. Role grants keep that canonical identity, current team/account checks and the existing absence of owner implication; no duplicate customer.finance or credential authority is created. Compiler-extracted owning schema/role metadata is ordinary generated output, not an authored registry/manifest or copied schema.

Mail may additionally use the already supported concise spelling:

```can
 use invoice {BillingV1 as Billing,Charge} from=deployment.billing
```

That removes its separate local Charge group by using the same owning schema already reached by BillingV1. It does **not** configure an adapter, connect a local Invoice owner automatically, make a remote call atomic or remove the necessary live Term import.

The [value witness](optional-dependency-closure-20261004/value-witness.can) uses canonical finance/Charge directly, three literal result/error cases and a separate contract-held Customer reference. Its [partial JS](optional-dependency-closure-20261004/value-witness.mjs) checks invoice.finance and references invoice.Charge without an Invoice executable import. Under current rules ValuesOnly includes value_probe plus Invoice/Customer/Employee/Location execution and five binding keys. Under this asset rule it includes only value_probe execution and canonical extracted assets, with zero bound providers. LiveValues still includes the real Customer/Employee/Location owners and mail binding through CustomerLink.customer; no serialized record snapshot substitutes for the live reference.

## Real manual and fee paths

| Current Mail path | What actually executes | Optionality consequence |
| --- | --- | --- |
| Configure manual entitlement (:75–78) | Current staff/location/customer/contact checks; nonblank paid_evidence when term=null; create locked Service | No membership or billing send. Term remains null, billing defaults false |
| Receive/match (:109–119, :157–168) | `live(service)` reads Customer/Location/Contact and the manual evidence arm; queues Mail.send and keyed reminder | The term arm short-circuits before eligible_term. Core email still required; no commercial provider |
| Instructions/delegate/collection/return/incident | Current company/recipient/delegate authority, versioned instructions and immutable handling evidence | No commercial sends; expiry does not erase or auto-return held items |
| Forward (:194–204) with billing=false | Freeze destination/instruction/fee/source in Dispatch, update Item, cancel reminder; fee_charge returns null | No Billing send, even when a positive fee is recorded for manual handling. Physical dispatch evidence remains separate |
| Forward with billing=true and positive same-currency fee | Freeze the exact same Charge/source, send Billing.charge, record pending correlation | Requires configured Billing; no false invoice or physical-forwarded outcome |
| Dispatched/uncertain (:212–230) | Current attempt/revision and evidence checks; append handling; update physical custody only | Independent of invoice success, and still usable after uncertain billing |
| Retry/completion (:253–288) | Reconcile frozen source; correlate current receipt/source/amount; reuse the frozen charge only after authoritative no-invoice result | Must retain configured Billing while this work is unresolved; cannot treat absence as failed/skipped or reissue a fresh logical charge |
| Reminder (:290 onward) | Current item/recipient guards, bounded reminder count and Mail.send | Core email remains required; no membership or invoice call |

These are exact source-path traces, not executed journeys. The existing Mail causal sequence beginning :126 already configures term=null with manual evidence and default billing=false; it then receives, nominates/revokes through Customer and resolves retained custody. Its example dependency seeds are not a production reason to install providers.

Bootstrap/discovery also matters. Customer created/updated/contact/company-grant handlers (:186–221) emit CompanyAccessChanged. Member's company_changed and addressed CompanyAccessStep/AllocationAccessStep/WatchAccessStep (:642–685) remain installed and perform local current-access review; they do not send Billing, Requests, Sales or Commissions. Fresh manual setup has no membership/watch rows, so those addressed queries end normally. Existing member rows can still receive local authority review. This is not license to skip hooks or infer all included work absent from a currently empty table. Member `term`/renewal generation (:204–282), consent enabling (:481–488), payment checks and affiliate settlement schedules genuinely create commercial work and need the explicit availability/removal boundary below.

Dependency pages and all their tools are not automatically published. Mail's selected pages publish its canonical controls and bounded model lookups. Imported Term pickers retain readable live rows and authority; Invoice/member/referral administration pages are not silently mounted. Core Mail page admission must remain available for authorized staff/recipients when commercial bindings are absent.

## Remaining contract: declared binding presence and canonical availability

This is an exact bounded candidate for comparison, not an adopted shared contract. It adds three related language surfaces (services, available and scenario when), a material cost beyond the safe asset correction. Without their agreed admission/UI/configuration semantics and owning app conditions, atomic send rejection alone does not close optional Mail. After the asset rule, the candidate existing app declaration is:

```can
app CanMail uses=[mailroom]
context
 services optional=[deployment.billing,deployment.membership_ingress,deployment.qualified_sales,deployment.commissions]
```

`services optional=[...]` is a new closed context declaration naming only bound-service deployment keys actually present in the derived closure. Unknown/duplicate keys are checked errors. Omission requires every binding. It permits, rather than forces, absence. Composition unions explicit permissions by key under normal source-derived context merging; it does not configure providers, change owner identities or hide required product outcomes. The generated plan must show each absent interface and the unavailable/conditional business actions. An integrated installation supplies the providers its required paid/fee outcomes need; mere successful installation is not a full-workflow acceptance claim.

Schemas, owning roles/models/rules/hooks and declaration contracts are resolved even when a listed implementation is absent. Configured incompatible/unknown implementations still fail deployment; they cannot be disguised as optional absence. Absent ingress has no authenticated source to admit new envelopes. Its typed handler declarations remain known; user calls cannot impersonate them. Core mail is unlisted and stays required. No payment/document provider is implicitly created, and no default storage/auth/file binding becomes optional.

Add one pure `available(Service)` expression for a statically resolved bound alias. It observes compatible implementation presence at the operation's pinned deployment/configuration revision, not provider health, payment success, delegated rights or credentials. Target lowering is `available(c,"mailroom.Billing")`. No text/raw credential lookup or runtime-selected service exists. Presence and effect admission share the configuration fence; a concurrent incompatible switch cannot commit an intent against an unadmitted namespace.

Add a canonical scenario `when=predicate`, using the same read-only guard as admission and bound control availability. Normalize/resolve inputs and apply existing caller/record/team/version checks; evaluate by, then when, then existing require/body order. False returns rule_failed with no effects. The generated UI evaluates it only with normal authorized bindings/known inputs, shows safe unavailable feedback and removes/disables that submit. MCP with an input-independent false presence condition withholds that unusable operation; input-dependent cases retain the one canonical operation and conditional feedback/validation. Do not partially evaluate arbitrary guards, hide an entire manual form because one optional input might need Billing, or add separate manual/paid operation identities. Business guards/readonly inputs are not replaced by this condition; invocation always rechecks it. Source predicates remain the sole authored authority, with callable target metadata rather than a Can-string interpreter.

Exact affected Mail headers retain existing signatures/by/labels and add only these conditions:

```can
## Configure still permits the required manual billing=false choice.
scenario configure(...) by=mail_staff when=not billing or available(Billing)
## A fee may be recorded without automatic invoicing; zero never needs Billing.
scenario forward(item:Item,fee:money?,destination_verified:bool) by=mail_staff when=not (item.service?.billing==true and fee!=null and fee.minor>0) or available(Billing)
scenario retry_fee(dispatch:Dispatch) by=mail_staff when=available(Billing)
```

The ellipsis is a review abbreviation only, not proposed grammar; copy configure's complete existing signature in an application. `fee_charge`/dispatch/completion bodies stay unchanged. After this condition, an absent Billing cannot produce an enabled impossible retry control or accept configuration of a new automatically billed Service. A billing-enabled historical service still permits zero-fee/manual custody resolution; positive automatic-fee forwarding is unavailable until its provider is restored. Caller grant/stale failures retain canonical admission; frontend presence never supplies permission.

The same condition must protect **new** commercial admissions in any selected member/affiliate UI: member term/retry_renewal/retry_collection/refund require Billing; consent uses `not enabled or available(Billing)` so disabling consent remains possible; affiliate settle/onboard/refresh admissions require Commissions. Member/referral ingress absence prevents incoming commercial requests. These dependency-only controls are not exposed by current Mail, but an internal call still rechecks the same canonical when. Never block local contact/seat revocation or physical custody resolution merely because a provider is missing. The owner hooks and current eligibility reads stay installed. Full paid installations, with these bindings present, preserve the original charge/refund/renewal logic and frozen commercial evidence.

Every send independently rejects an absent implementation atomically as rule_failed, without domain writes/events/schedules/intents/attachments committed by that transaction. This defense does not turn provider acceptance into a skipped receipt, cancel an older attempt, make an automatically scheduled action feasible or replace the authored availability conditions. Backend outage with a configured binding follows the existing failed/unknown/reconciliation semantics.

Proposed target boundary: appDefinition.context.optionalBindings carries the four key strings; existing binding entries still reference the one owning capability/from key. A scenario stores `when:"canonical.when_id"`; the single canApp registry contains its read-only `when` function and the existing handler uses the same function after by checks. Renderers/MCP consult that canonical predicate, not a second permission/schema registry. The [optional witness](optional-dependency-closure-20261004/witness.can) and [desired JS](optional-dependency-closure-20261004/witness.mjs) pin this boundary, five literal manual/error cases and nine installation acceptance specifications. They queue intents only; they do not demonstrate remote invoice approval, real customer mapping or provider dispatch.

## Changed closure and failure boundaries

| Configuration | Executable closure | Schema/binding names | Mandatory implementations |
| --- | --- | --- | --- |
| Current manual Mail | 10 owners | 9 | All 9, despite the manual branches |
| Value inference only | 9 owners | 5 | All 5; four accidental keys removed |
| Proposed manual Mail, fresh install | Same 9 owners | Same 5 | Core mail; the four listed commercial bindings may be absent |
| Proposed full paid/fee Mail | Same 9 owners plus whatever actual provider deployment explicitly selects | Same 5 consumer bindings; provider owns its own closure | Billing and ingress/sales/commission services for chosen full outcomes are configured; no resource pruning is claimed |
| Standalone Customer after value inference | customer/employee/rent_catalog | Core mail | Core mail, without an optional context |

The list does not remove Member models, query authority or source context. If full Invoice is explicitly selected, its complete body and payments/billing_ingress/documents/sales_ingress bindings remain mandatory; the static role import does not suppress a selected owner. Bound Billing still needs an actual versioned implementation and delegated mapping, even if Invoice co-locates.

| Case | Required result |
| --- | --- |
| Missing unlisted core mail | Installation fails; manual Mail cannot claim notification coverage |
| Missing listed Billing, manual/null-term/billing=false path | Core receive/notify/collect/forward/evidenced dispatch/return remains available; no commercial intent |
| Missing Billing, requested positive automatic fee | Source when is false; unavailable control and canonical rule_failed; no partial Dispatch/Item mutation or intent |
| Missing Billing, zero fee | Manual forwarding remains available and no invoice is requested |
| Present compatible Billing | Same frozen source/currency/fee, current correlation and reconciliation; provider result still cannot certify physical dispatch |
| Missing listed ingress/sales/commission implementation | No fabricated authenticated events or qualification/commission outcome; unavailable chosen integration is shown truthfully |
| Existing pending fee reconcile, accepted/unknown charge, Member payment-check/renewal or affiliate settlement work | Binding removal/activation fails until pinned old work is reconciled/drained or a compatible original binding contract is retained |
| Completed receipt | Retain original identity/schema/safe outcome and replay/lifetime rules; absence does not re-execute it |
| Changed value closure removes an installed Invoice owner containing records/locks/history/work | Existing schema/owner-removal gates apply; inspect actual inventory and preserve required history or block. No empty-owner assumption or silent drop |
| Contract holds Customer record, or derive reads live Term | Include the live owner/routing/policies/hooks; no schema-only record read |
| File moved or another product selects the same owner | Same canonical role/model/operation/schema identity; no second instance or automatic provider |

Old-work gates cover admitted/in-flight/uncertain delivery identities, internal events/hooks and schedules which can create provider work, including older retained releases. Conservatively follow their finite source/effect/hook dependency contracts; do not assume a future data guard false or convert uncertainty into no work. An unimplemented/incomplete inventory blocks removal. Completed historical owner records/files/grants also retain normal migration/privacy/lifetime rules. This applies to fresh config-only removal as well as schema changes under DESIGN §11. No general unsatisfiable-guard solver is introduced.

## Alternatives and advice

| Alternative | Demonstrated benefit | Equal-outcome cost/limit |
| --- | --- | --- |
| Current whole-owner rule plus honest installation plan | Keeps owner behavior, simplest present semantics | Manual Mail still needs nine binding keys; Customer needs five |
| Bounded value/role inference | Customer 4→3 owners and 5→1 bindings; Mail 10→9 and 9→5; canonical grant/type identity retained | Live model references/derives still include their owner. Four remaining commercial Mail bindings remain required without another contract |
| Explicit workflow separation using existing packages | Could omit real optional processes without binding absence semantics; packages can share a file/deployment | Core owns its models. Moving its send/callback text elsewhere cannot write them; leaving a core call to the integration keeps that integration in closure. A real split needs admitted owner handoffs and hook/event recovery. No complete split preserving the existing identities/admission/effect order is supplied; cached membership evidence is not equivalent to live eligibility |
| Declared optional bindings plus canonical availability | Core manual outcomes omit four remaining commercial implementations without removing live owners/hooks/types | Adds services/available/when contracts, conditional UI/MCP and config/old-work fences. Does not reduce owner source context or make an absent integrated workflow complete |
| General used-declaration pruning | Possible automatic resource/source reductions | Cannot assume owner policies/invariants/hooks or scheduled work safely unused; no proven analysis. Not selected |

JEV endpoint/question signatures were verified in tools/jev.py. [Requests/results](jev/optional-dependency-closure-20261004/) retain full distributions, model jev-1.13.0 and uncertainty. No prior votes were supplied:

| Advisory | whole | values | partition | optional | Chosen/confidence |
| --- | --- | --- | --- | --- | --- |
| 1, full source facts | 0.00 | 0.13 | 0.01 | 0.86 | optional / 0.81 |
| 2, independent full rewrite | 0.05 | 0.39 | 0.07 | 0.49 | optional / 0.32 |
| 3, reduced hypothetical comparison | 0.01 | 0.45 | 0.23 | 0.31 | values / 0.27 |

There is disagreement and no forced consensus. Actual closure investigation confirms the substantive value/role saving rather than dismissing it as partial. The full facts also show why it cannot remove live membership commerce. Optional-send rejection alone is insufficient: explicit source availability and the Member consent/renewal/schedule boundary are necessary. That is why the recommendation separates the safe asset milestone from the additional, fully named presence/availability proposal. JEV supplies probabilities, no explanatory rationale; none is attributed to it. The optionality sketch presented to JEV did not yet specify the detailed when contract, so the exact availability design remains this source-based recommendation rather than a separately consulted winner.

The first sandbox network call failed, then identical requests 1/2 succeeded through approved escalation. Automatic approval review rejected original full-context request 3 for nonpublic architecture export. That payload was not resent or routed indirectly; it remains [saved](jev/optional-dependency-closure-20261004/3.rejected.request.json) with [the rejection and provenance limit](jev/optional-dependency-closure-20261004/3.rejection.md). A separately approved hypothetical comparison omitted actual app names, counts, binding keys and source-specific workflow facts. It was motivated by the investigation, and is **not** a full third semantically equivalent source-context rewrite. The full third consultation remains unexecuted; the coordinator must address exact authorization if it is required before adoption.

## Verification and stage

The value witness uses current syntax and parses; both desired JS witnesses pass node --check. The optional witness is intentionally rejected at the new services declaration; compatibility projections identify its unsupported delivery type and scenario when independently, and surrounding source/five table rows parse after removing only those proposed pieces. Lexical source/target case correspondence, role/type IDs, standard checked money constructors, ordered guards/effects, locator-only stored delivery observations and exact owner/binding graphs were reviewed. Fixture factories construct descriptors only; no callback, invocation, provider, rendering, test runner, configuration fence, deployment/inventory or privacy enforcement is executed. The nine installation cases are acceptance specifications, not a new authored manifest or implemented harness. No speed, billed cost or subscription cancellation result is claimed.
