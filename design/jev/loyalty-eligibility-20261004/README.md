# Loyalty eligibility consultation

<a id="source-assessment"></a>

## assessment.md

### Loyalty eligibility and workflow completion

Three fresh `choice` consultations considered deliberate enrollment with configured product/location criteria, excluding all commercially attributed sales, and expanding the common capture protocol to mutually exclusive loyalty/cash routing. [Wording check](README.md#source-wording-check) records semantic equivalence and changed prose before dispatch. The first sandboxed request could not connect; the authorized network invocation then succeeded. No response was fabricated or automatically retried.

| Request / response | Selection | Returned confidence | Returned probabilities |
| --- | --- | --- | --- |
| [1 request](request-1.json) / [1 response](response-1.json) | enrollment | 0.79 | enrollment 0.86; unattributed 0.12; exclusive_capture 0.02 |
| [2 request](request-2.json) / [2 response](response-2.json) | enrollment | 1.0 | enrollment 1.0; unattributed 0.0; exclusive_capture 0.0 |
| [3 request](request-3.json) / [3 response](response-3.json) | enrollment | 1.0 | enrollment 1.0; unattributed 0.0; exclusive_capture 0.0 |

All responses identify `jev-1.13.0`. Usage totals: 2261 input tokens and 144 output tokens. Selections agree, but A retains 0.12 probability for the unattributed-only option and lower confidence. The classifier supplies no rationale. Rechecked full wording and supplied evidence: all three retain the same ownership, repeat-customer requirements, real producer routing, alternatives and disadvantages. This does not establish why uncertainty changed or remove framing bias. No approval threshold or averaging was used; recommendation is advice rather than authorization or proof.

#### Independent source evidence and decision

[CanLoyalty requirements](../../../draft/CanLoyalty.md) require repeat financially qualified completed sales and intentional reward ownership. [PORTFOLIO line 54](../../../draft/PORTFOLIO.md:54) bars unintended rewards from shared source-sale attribution and separates points/perks, cash rewards and member allowances. [Invoice](../../../draft/CanInvoice.can:50) owns `Qualification` and `SalesV1.qualification`; its publishing workflow checks matching invoice/customer/location/currency/amount, actual received/refunded money and review/pending state. Rent's `commercial_check` emits paid/completed/reversed booking lifecycle with snapshotted product and attribution; actual `Resource.kind` is `desk`, `office`, `meeting` or `event_space`. Member's `commercial_check` emits those stages for membership terms and product `membership`. Neither lifecycle owner can substitute a booking/term declaration for Invoice's financial evidence. Actual capture identities are null or `refer.Program:<id>` / `affiliate.Partner:<id>`, never raw Loyalty `Program.id`.

Explicit staff `Account` enrollment is therefore the loyalty offer, narrowed by Program locations/products. Referral/affiliate cash attribution does not create or select that enrollment. Several deliberately created matching loyalty enrollments are intentional rewards under their terms, rather than an incidental fanout from capture. The catalog fixture states that combined offer. Excluding all cash-attributed sales or inventing a shared loyalty capture would impose a restriction absent from current requirements. No shared owner was changed. The example configuration uses real producer products `meeting` and `membership`; `first_customer=false` / `history_known=false` deliberately demonstrates repeat-customer eligibility.

#### Draft changes and limits

Can and the handwritten desired JavaScript now retain per-account source revision/qualification evidence, immutable source routing assertions, same-revision equality, stale-event protection, first-completed eligibility decisions and sticky reversal tombstones. Reversals occur once even after program deactivation and after spending, preserving owed balances. Staff ledger adjustments carry reasons/authors and explicitly choose whether they correct tier earning; reversals preserve that classification and cannot reverse another reversal. Redemption freezes cost, name, instructions, catalog locations and chosen location; fulfillment/cancellation use that chosen scope, recorded authors and evidence. Contact account equality plus verified linkage controls all own ledger/redemption reads. Public program fields include earning terms/criteria; owner/staff grants retain their written scopes. Earned tier points, highest threshold, next tier and interval progress are distinct from available points. A terminal tier has zero span/progress without division.

A correlated email completion updates only notification state. User/staff tables display that separate typed state and neutral explanatory text. The existing bounded catalog has no conditional Alert or graphical Progress primitive; the draft uses declared metrics/text/table controls and does not manufacture syntax. The source exposes guarded workflow actions and canonical record bindings, while shared runtime owns conflict/replay/concurrent admission and provider failures.

[CanLoyalty.can](../../../draft/CanLoyalty.can), [CanLoyalty.mjs](../../../draft/CanLoyalty.mjs), and its requirements are the only application files changed. The target follows DESIGN §13: one registry without metadata spread, proposed owner imports, exact BigInt arithmetic and typed scalar/reference/structural equality, one-object shared UI factories, and deferred fixture recipes/row callbacks. It adds no compiler, runtime, renderer, adapter, runner, configuration or copied owner model. Syntax checks and case-preservation inspection are the actual verification; inline examples and deployment integrations remain unexecuted. Source/type/permission analysis and runtime behavior still await implementation.

The pre-change enrollment admission was exactly `crud Account by=reward_staff fields=customer,contact update=none delete=none`, with `require Account: row.contact.parent==row.customer`; it did not contain a staff-location guard. Consultations described deliberate staff enrollment as the business offer and scoped enrollment as a required proposal, not an existing guard. The final source adds `when=all(row.parent.locations as location,can_work(actor,location))` explicitly. No classifier judgment grants that permission.

Final focused checks: the syntax parser accepted the one Can source; `node --check draft/CanLoyalty.mjs` accepted JavaScript syntax; the existing `oxfmt` formatted that target alone. Source and target each retain 17 example tables and 52 cases, with 12 local fixture recipes. A temporary metadata inspection verified deferred common/row callback shapes and counts without invoking handlers, recipes, row callbacks, providers or proposed imports. Saved request/response payloads match authored JSON plus `model=jev-latest`. These are preservation/shape checks, not executable BDD or permission/concurrency verification.

<a id="source-wording-check"></a>

## wording-check.md

Before dispatch, compared all three full requests. Every instruction, evidence paragraph, selection question and alternative description is freshly worded; technical identifiers remain fixed. Each preserves repeat paid/completed loyalty, actual Invoice financial ownership and Rent/Member producers, null/refer/affiliate routing, deliberate staff enrollment, configurable products/locations, no prohibition on intentional multiple enrollment, portfolio separation/unintended-award requirement, revisions/idempotency/tombstones and inactive-program reversals. All alternatives retain concrete benefits and costs; enrollment is not assumed safe merely because proposed. JEV is advisory, with probabilities preserved and no automatic threshold.

