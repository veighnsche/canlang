# CanGrant requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanGrant.can](CanGrant.can).

## Purpose and Adoption Goal

Optionally help a workspace operator run a funded startup or community program that awards monetary support to selected applicants. Adoption depends on private intake and a budget that cannot be overcommitted.

## Users and Permissions

Applicants submit and view their own applications. Coordinators manage grants/budgets; eligible assigned reviewers see their review queue and cannot review their own application. Other applicants and ordinary team members cannot read private submissions.

## Data and Ownership

Grant stores name, budget/currency, and closing time; applications include project title and description. Applications store applicant account/contact, frozen program terms, selection criteria and keyed question definitions, typed keyed text answers, a correction link where applicable, authoritative receipt time, requested amount/currency, reviewer, and decision evidence. Grant closing time includes a timezone. Submitted intake, including its amount, remains locked through approval and withdrawal, preserving the approved amount. Decision fields remain locked after decision; withdrawals append attributable immutable evidence and retain the original reason. Reviewer recovery records previous/new assignee, normalized reason, acting coordinator and server time as immutable child evidence. Decision-notice delivery is tracked separately from award state, with its correlation identity locked once recorded.

Record sponsoring location/program, eligibility questions and recorded answers, selection criteria, reviewer comments, and applicant decision reason. Published program terms state what the award funds and its deadlines.

## Workflows and Business Rules

Applicants begin their own private draft through `apply`, fill or update answers incrementally, and edit until submission. `Question` carries a stable key and prompt; `Answer` carries that key and normalized nonempty text. Every frozen question must have exactly one matching answer at submission; missing, duplicate and foreign keys fail. Coordinators enter externally received applications through `intake` for the actual applicant, which calls the canonical `external` receipt operation. Assignment and submission require a different account with the actual current reviewer role and current workplace eligibility; deciding enforces current role and eligibility again. An Employee work-role label does not confer the grant reviewer role. Reviewers decide a frozen submitted revision. Online deadline eligibility uses server receipt time. A coordinator recording an externally received application retains its actual receipt evidence and any late-entry override reason. Before the deadline, the applicant may create one private correction draft from a submitted or rejected revision. It copies the earlier frozen terms, criteria, questions and intake values. Successful fresh submission atomically supersedes a still-submitted predecessor and records a new server receipt; rejected decisions stay unchanged. Starting a draft does not retire the pending original. A decision reached before correction submission prevents superseding an approved predecessor. No applicant correction or resubmission bypasses the deadline.

If the assigned reviewer loses current role or workplace eligibility while an application is submitted, a scoped coordinator may restore review before or after the deadline. `recover` requires a different eligible real reviewer and a nonblank reason. It appends immutable reassignment evidence and changes only the assignee: receipt time, external evidence/override, applicant, frozen content and amount stay intact. The reviewer lock evaluates the old state and permits replacement only on an unavailable submitted assignment; it remains absolute after approval, rejection, withdrawal or supersession. Recovery does not admit new late content or reserve funds, and a repeated unchanged recovery fails. Applicant correction still requires the ordinary deadline.

Private reviewer comments remain visible only to the assigned eligible reviewer during review and scoped coordinators. Approval atomically reserves the grant budget; authorized award withdrawal releases that commitment once.

Keep this as a cash-award commitment workflow. Free desks, booking credits, and rent discounts are not treated as monetary awards or allocated from this budget; they require separately specified inventory and billing behavior.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as Funded programs, then Award review for eligible reviewers/coordinators. Published discovery is public; intake and status require the applicant's own authenticated access. Application details are contextual links from these indexes, not sidebar entries. Coordinator budget work is a normal grant workflow, with no additional administration console.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| Funded programs — published index | Cards with location, eligibility, complete terms, questions, selection criteria and closing time with timezone; Select filters. Inline apply controls (email/title/description; amount/assignee stay generated); saved-default state filter; program-list empty state. | Open an eligible program and its applicant intake; other applicants' submissions never appear |
| My application — contextual intake/status | Fieldset with required answer Inputs and amount/currency; state Badge and reasoned decision Alert. State badge + notice-delivery status (delivery outcomes never alter awards); frozen-terms visibility kept; recovery/withdrawal tables gain empty states. | Create/edit the own draft, submit or create a linked correction against server receipt time and read its recorded result; every submitted revision stays frozen |
| Award review — assigned review queue | Table of authorized submissions, requested amount, receipt, reviewer and state; contextual comments and evidence. Title search; decide/external/recover/withdraw/comment open dialogs; reviewer comments render as attributed chat entries; recovery/withdrawal evidence grouped in an accordion. | Decide only the assigned submitted revision without self-review; reject unaffordable approval without losing entered reason |
| Program budget — coordinator view within review | Stat totals separating requested, approved commitments, withdrawn commitments and remaining funds; deadline override evidence and award-export Button. Committed-vs-budget progress joins the stat totals; paged award export; same-currency invariant noted. Export button = shared toolbar control, not an authored button. | Maintain grant/budget records, record evidenced external receipt or late override, restore an unavailable pending reviewer with attributable evidence, and withdraw an approved award through existing operations |

Keep mobile intake linear with readable required-answer labels and deadline. Loading reveals no private placeholders; distinguish an empty assigned queue from filtered-empty. Preserve unsaved answers and reasons across validation failures and preference changes. Refresh affordability after a stale/concurrent decision and show the committed outcome rather than optimistic approved state. Show decision-notice delivery separately from the award. Pending, succeeded, failed, unknown and skipped delivery outcomes never alter the recorded award. A successful mail-provider acceptance is not evidence that the applicant read the notice. Budget/export views retain currency and authorized scope, and an approved award remains a monetary commitment rather than a disbursement or workspace credit.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Applicants may remember program/location discovery filters; reviewers may remember an authorized location and pending-review default. State-filter memory is editable in context. These are display choices with a clear/reset control, never deadline overrides, assigned reviewer changes, budget limits or eligibility grants. Missing or newly inaccessible saved filters fall back to an accessible default. Keep the program's business timezone and amount/currency interpretation independent of interface language.

## Interfaces and Integrations

Use D1 for records and EmailService for final decision notices.

## Background Actions

Email the applicant when their application becomes approved or rejected.

## Error Handling

Reject private-data access, self-review, and unaffordable concurrent awards. Changed submissions need a fresh review. Reject forged client receipt times; a recorded deadline override must remain visible to coordinators.

## Scope and Completion

Complete when applicants can use the actual intake flow, reviewers see only authorized submissions, and deadline/withdrawal/concurrent-award outcomes preserve budget and history. Award decisions are not fund disbursements.

Use this app only if the operator funds such a program. An eligible startup can apply, obtain a recorded award decision, and be counted in committed funds; fund disbursement remains outside this app.

Frontend journey: an applicant reads a timezone-labeled deadline, completes every required answer, corrects inline validation without losing input and sees the submitted revision and authoritative receipt outcome.

Frontend journey: an assigned reviewer enters a reason while another award consumes remaining funds; rejection explains affordability and retains the reason. A coordinator sees an evidenced withdrawal release the commitment once, with history retained and no claim of fund payment.

## Composition and Ownership

Recommended placement: Optional funded-program module. Own applicant privacy, cash-award commitments and decisions. A shared approval interface cannot bypass award budget checks; awards are neither paid workspace allowance nor fund disbursement. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft completion and evidence

The source and handwritten desired JavaScript correspond on private incremental intake, exact keyed-answer completeness, before-deadline linked correction, external applicant ownership and evidenced receipt overrides, frozen terms/criteria/questions and submitted intake, current real reviewer authority, reason-bearing post-deadline reviewer recovery, decisions and attributable immutable withdrawal. Recovery uses the existing pre-state conditional-lock contract and normal `create`/`set`; it introduces no privileged lock bypass. The original receipt and budget identity remain on the same Application. Rejected decisions remain locked when a separate correction is submitted.

Requested totals retain submitted/decided requests, including rejection and withdrawal; approved and withdrawn commitments remain separate currency-qualified sums. The typed `award_export` projects only currently approved commitments through canonical bounded `collect`, retaining exact currency and decision time. An empty export and empty committed sum are valid: zero is `money(0,"EUR")`, not a conversion from minor units. Award export, approval and withdrawal never claim payment, desk allocation or booking credit.

Decision notices retain one typed `delivery(Mail.send)?` association. The read-only `notice_state` derives its nullable transport status; no completion handler or stored status mirror is needed. Both pages show status, with null representing no request. Receipt progress changes neither application version nor award evidence. The desired UI now retains source order for edit/answers and metrics/export, includes the external-intake form, shows recovery evidence, and restricts discovery to published programs for every viewer. Limited public/reviewer Grant projections include the publication flag for that readable discovery predicate, without budget fields. Page captions and admission have one canonical `appDefinition.pages` descriptor per source page.

Eleven isolated example tables contain 56 authored cases: incremental editing and blank answers; actual noncaller reviewer role, self-review, wrong currency and zero request; complete/duplicate/foreign answers; deadline and predecessor decision races; external evidence/late override; decision affordability and stale versions; current coordinator/assignee authority and recovery reason/history; immutable decided evidence during withdrawal; completion correlation/status; and authorized empty export. Named reviewer/coordinator/replacement/ordinary/HR user recipes are distinct current-team accounts with immutable grants. The ordinary worker's `role="Reviewer"` text deliberately does not grant review authority. Historical fixture snapshots establish isolated initial state and do not claim executed earlier transitions.

Four proposed shared-state sequences contain 114 steps and 53 explicit canonical calls. They cover two actual applicants competing for one budget and a single attributable withdrawal; rejection, private comment visibility, correction and separate fresh review retaining original evidence; genuine `employee.deactivate` after program close, denied decision/correction, reasoned coordinator recovery, stale/fresh/repeated recovery and replacement review; and actual coordinator `intake` calling `external`, including future/late receipt failures, rollback of the created Application and recorded override. They use normal operations and current caller grants; no direct test-state writes, fabricated void results or duplicated fixtures solely to vary state. Record bindings pin versions; later mutations requery changed rows. These sequences demonstrate authored causal correspondence, not executed business journeys or simultaneous transaction races. Static user recipes cannot demonstrate an executed reviewer-role revocation; a real teams role-revocation operation has no specified canonical signature here. The HR eligibility-loss transition is explicit.

Three new [saved recovery consultations](../design/jev/grant-review-recovery/) compare immutable assignment history with an unavailable-reviewer conditional lock against a copied submitted recovery revision. All choose assignment: confidence 0.92/0.94/0.48; assignment probabilities 0.96/0.97/0.74 and revision probabilities 0.04/0.03/0.26. Independently rewritten requests preserve equivalent outcomes, verified ordinary field-lock semantics and balanced costs. Selections agree but uncertainty varies; JEV provides no rationale and no correctness guarantee. The selected approach preserves a stable intake/receipt/budget identity and records reviewer history without copying a submitted Application. Initial sandbox network calls failed; automatic approval review rejected one escalated payload. Verification found only generic draft contracts/options and no identifying/customer/secret material; the explicitly authorized same-payload retry was approved and saved successfully.

The prior [correction consultations](../design/jev/grant-completion/) remain historical advice for linked applicant revisions rather than reopening decided intake. They do not establish the subsequent recovery or delivery implementation.

Checks: `node --check draft/CanGrant.mjs` and focused whitespace checks pass. A temporary compatibility projection replaces the new delivery field type and removes the four sequence blocks; the unchanged syntax parser accepts the surrounding production declarations and all 11 table blocks. Full-source parsing now rejects the proposed delivery type before the also-unsupported sequence grammar; no full parse is claimed. The original surrounding table/declaration check used a temporary type/sequence compatibility projection. All 56 source row inputs, typed expected values and exact error codes match target callbacks. A descriptor-only factory inspection constructs four sequences/114 steps/53 call descriptors, with every call matched against source operation identity, actor, normalized input, result binding, version envelope and expected error. It invokes no fixture callback, operation, stdlib, renderer or provider.

The admitted `award_export` receipt-snapshot witnesses include succeeded, unknown, skipped, failed, pending and no-request associations. Every row preserves approval, decision reason/author/time, exact amount, export count and remaining budget. Separately identified detached failed and succeeded attempts are seeded beside the selected attempt, including current pending and no-request cases; neither outcome can replace the current association. Failed receipts use the closed safe `DeliveryError {code:text,message:text}` shape and `result=null`. Every recipe contains the complete frozen `Mail.send` request and runtime-owned isolated identity; no provider is invoked. These snapshots specify association independence and retained evidence, not executed late callbacks. The actual decision sequences still enqueue a send and observe pending through the canonical typed lookup in the desired target. Neither errors nor status authorize retry.

Remaining implementation dependencies are the proposed compiler/semantic checks, sequence parser/runner, auth/storage and current-team role admission, typed snapshot/lock/version/replay enforcement, atomic concurrent budgets, private query/rendering/default-form behavior, and verified outbox/provider completion delivery. Shared unsaved-input preservation, localized form/validation rendering, stale-affordability refresh and outcome reporting remain UI/runtime contracts; no browser implementation or executed provider result is claimed. The associated-delivery contract is proposed; no infrastructure implementation is introduced.


## Initial delivery recipe normalization

Five repeated Mail recipes are now three: `attempt` varies only its initial whole status/result/error cells, while `detached_notice` and `detached_success` retain independently required failed and succeeded identities beside the selected association. All three keep the same complete frozen request. Unchanged pending/null/null attributes are omitted; detached attempts retain their nondefault status and safe error or successful result. The combined envelope is validated before isolated provisioning, never patched onto a published receipt. All ten receipt rows and their independent award/decision/budget observations remain unchanged, as do all 56 table expectations and four sequences.

Normalization changes Can source from 43,453 to 43,411 UTF-8 bytes (42 bytes fewer). Explicit initial-selector columns and independently required receipt identities offset the eliminated declarations; no model-token reduction is claimed. Production Can after erasing tests and the desired JavaScript production prefix compare byte-for-byte with the captured pre-normalization source. Node syntax, all 56 source/target input/expected/error tuples and descriptor dependency/selector closure checks pass. These are static correspondence checks; no planner, provider or business runner executes.
