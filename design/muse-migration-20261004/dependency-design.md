# C3 dependency investigation — preserved at priority change

Status: **paused by the user's new priority; not an accepted or complete application handoff.** No draft app, shared language document, tracker, inbox or Git index was edited. The active assignment moved to CanInbox before the planned Can/JS/BDD witnesses were written. These findings preserve useful work without adopting a new composition contract.

## Current, verified boundary

DESIGN §1 includes the complete executable owner for a plain production import; only fixture-only/message-only groups and bound interfaces have their specified narrower inclusion. There is no adopted static-role/value-only exemption, optional binding declaration, `available(Service)` builtin or scenario `when` attribute. Business `Service.billing=false` and `Service.term=null` do not alter deployment requirements. The earlier [optional dependency proposal](../optional-dependency-closure-20261004.md) remains unadopted.

The earlier closure counts are now stale. A read-only structural scan on 2026-10-04 found:

| Selection | Executable owners | Bound deployment keys |
| --- | --- | --- |
| Customer | affiliate, customer, employee, invoice, propose, refer, rent_catalog, rent_reservations, report, sales_attribution | billing, billing_ingress, commissions, documents, mail, membership, payments, qualified_sales, reports, rooms, sales_ingress |
| Mail | the Customer set plus mailroom, member_plans, member_terms | the Customer set plus membership_ingress |

This is source tracing, not implemented compiler output. `customer → invoice.finance` still includes Invoice. Invoice now imports `rent_reservations.{LegacyBooking,retain_legacy,...}`, which includes its complete owner and reaches Propose and Report. Mail also directly imports `invoice.Charge`. Fixture members were excluded when deciding whether a mixed import retained production symbols. Imported dependency pages/all tools do not automatically become selected product pages/tools.

## Safe, not yet applied correction

In Mail, replace its two Invoice imports with the already supported grouped bound import:

```can
 use invoice {BillingV1 as Billing,Charge} from=deployment.billing
```

Its desired-JS counterpart is the existing CanRent convention:

```js
import { Charge } from "./deployment.billing.mjs";
```

Replace Mail's `./invoice.mjs` Charge import; keep the existing `mailroom.Billing` binding descriptor unchanged. This removes only Mail's direct accidental executable edge. Customer's finance-role import still reaches Invoice, so it makes **no present deployment-key reduction**. Do not copy Charge or relocate/rename the canonical `invoice.finance` role. Customer's finance approvals retain their actual role, employee/location checks and attributed decisions.

## Application rules already specified

- A compatible configured provider's outage is a delivery lifecycle concern, not missing installation, service expiry or automatic skip. All presently referenced bindings remain required for deployment. Unknown implementations fail installation under DESIGN §8.
- Core `deployment.mail` stays required. A failed or uncertain notice neither resolves physical custody nor proves that nothing was sent. Runtime recovery reuses the same delivery identity; a fresh `send` is a new intent. C5 owns additional notice/reconciliation design.
- `Service.active` is the operator's business enable switch, not provider health. `live` also checks the current customer/contact/location, period, and actual linked paid membership/seat authority. A denied linked term cannot fall back to manual paid evidence.
- Standalone `term=null` with reviewed nonblank paid evidence is already valid. `billing=false` records an optional handling fee without an invoice request. With billing enabled, only a positive same-currency fee creates a frozen Charge. Zero/null fees create no Charge.
- Disabling/expiring entitlement stops new linked receipt, matching and new forwarding. It does not erase held items or cancel prepared dispatches or invoice work. Current authorized collection, evidenced return, incident recording and confirmation of an already prepared dispatch remain governed by their existing guards. A current recipient/delegate identity check still applies; historical identity alone is insufficient.
- Billing settlement cannot prove physical dispatch. Billing failed/unknown/pending does not prevent recording actual dispatch evidence. Existing fee recovery reconciles the original source before a possible resend of its frozen Charge; provider failure never mints a fresh logical charge.
- Staff queues and My mail must remain reachable under their existing grants despite an outage or disabled service. Keep custody, notice outcome and fee-invoice outcome separate. Do not add a guessed provider-health predicate or hide local resolution because a provider call failed. The recipient receives its existing safe notice-state projection, not provider payloads.
- Removing a still-required binding is not a supported runtime optional state. Source/configuration changes must pass the real deployment contract. DESIGN §11 separately requires outstanding work to drain/reconcile, retain a compatible pinned contract, or have an explicitly supported disposition before activation. In-flight/provider-accepted/uncertain work cannot be relabeled cancelled. Older retained releases and missing inventory evidence matter; completed receipts preserve historical identity/schema and retention. No runtime/deployer implementation is claimed.

## Remaining intended bounded work

If resumed, finish exact requirements replacement text for `draft/CanMail.md` and its misleading claim that standalone Mail does not include booking flow; similarly clarify `draft/CanCustomer.md` standalone interface versus executable closure. Produce full changed-section Can/JS witnesses and isolated BDD for manual versus automatic fees, deactivation preserving pending/unknown fee and physical state, and confirmation of a prepared dispatch after deactivation. Keep existing causal custody examples and C5 notice work. Useful minimal presentation changes are staff `row.billing`, recipient `row.active`, and labeling Service.active as “Service enabled”; this is a recommendation, not yet accepted/applied source.

Full actual optional-provider omission and the proposed static-role/value-only inference remain separate unresolved shared-language decisions. Do not mark C3/A05 completed from the safe import cleanup or substitute cached membership facts for current authority. The enlarged graph makes the old optional-key/count witness insufficient even if its proposal were later adopted.

## Consultation boundary

The original detailed-project third JEV request was automatically rejected for insufficient authorization to export nonpublic architecture/workflow context. The [saved rejection](../jev/optional-dependency-closure-20261004/3.rejection.md) remains authoritative. Its later abstract hypothetical was explicitly nonequivalent and does not complete the required three equivalent consultations. Root confirmed that no later specific user approval covers the rejected export. No JEV request was made during this C3 assignment, and none was resent/reworded around that rejection. This is advice/approval evidence, not proof of any alternative's semantics.

On handoff, `/root/astra_progress_handoff` was informed that Mail stays required, outage does not alter entitlement, and existing pending work requires its actual compatible contract. No C5 recovery API or receipt field was introduced here.
