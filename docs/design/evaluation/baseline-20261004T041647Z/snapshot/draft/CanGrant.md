# CanGrant requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanGrant.can](CanGrant.can).

## Purpose and Adoption Goal

Optionally help a workspace operator run a funded startup or community program that awards monetary support to selected applicants. Adoption depends on private intake and a budget that cannot be overcommitted.

## Users and Permissions

Applicants submit and view their own applications. Coordinators manage grants/budgets; eligible assigned reviewers see their review queue and cannot review their own application. Other applicants and ordinary team members cannot read private submissions.

## Data and Ownership

Grant stores name, budget/currency, and closing time; applications include project title and description. Applications store applicant account/contact, a frozen snapshot of keyed question definitions, typed keyed text answers, a correction link where applicable, authoritative receipt time, requested amount/currency, reviewer, and decision evidence. Grant closing time includes a timezone. Submitted intake, including its amount, remains locked through approval and withdrawal, preserving the approved amount. Decision fields remain locked after decision; withdrawals append attributable immutable evidence and retain the original reason.

Record sponsoring location/program, eligibility questions and recorded answers, selection criteria, reviewer comments, and applicant decision reason. Published program terms state what the award funds and its deadlines.

## Workflows and Business Rules

Applicants begin their own private draft through `apply`, fill or update answers incrementally, and edit until submission. `Question` carries a stable key and prompt; `Answer` carries that key and normalized nonempty text. Every frozen question must have exactly one matching answer at submission; missing, duplicate and foreign keys fail. Coordinators enter externally received applications through `intake` for the actual applicant, which calls the canonical `external` receipt operation. Prospective reviewer assignment requires a different account with current workplace eligibility; the actual reviewer role and current eligibility are enforced again when deciding. Reviewers decide a frozen submitted revision. Online deadline eligibility uses server receipt time. A coordinator recording an externally received application retains its actual receipt evidence and any late-entry override reason. Before the deadline, the applicant may create one private correction draft from a submitted or rejected revision. It copies the earlier frozen questions and values. Successful fresh submission atomically supersedes a still-submitted predecessor and records a new server receipt; rejected decisions stay unchanged. Starting a draft does not retire the pending original. A decision reached before correction submission prevents superseding an approved predecessor. No applicant correction or resubmission bypasses the deadline.

Private reviewer comments remain visible only to the assigned eligible reviewer during review and scoped coordinators. Approval atomically reserves the grant budget; authorized award withdrawal releases that commitment once.

Keep this as a cash-award commitment workflow. Free desks, booking credits, and rent discounts are not treated as monetary awards or allocated from this budget; they require separately specified inventory and billing behavior.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as Funded programs, then Award review for eligible reviewers/coordinators. Published discovery is public; intake and status require the applicant's own authenticated access. Application details are contextual links from these indexes, not sidebar entries. Coordinator budget work is a normal grant workflow, with no additional administration console.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| Funded programs — published index | Cards with location, eligibility, complete terms, questions, selection criteria and closing time with timezone; Select filters | Open an eligible program and its applicant intake; other applicants' submissions never appear |
| My application — contextual intake/status | Fieldset with required answer Inputs and amount/currency; state Badge and reasoned decision Alert | Create/edit the own draft, submit or create a linked correction against server receipt time and read its recorded result; every submitted revision stays frozen |
| Award review — assigned review queue | Table of authorized submissions, requested amount, receipt, reviewer and state; contextual comments and evidence | Decide only the assigned submitted revision without self-review; reject unaffordable approval without losing entered reason |
| Program budget — coordinator view within review | Stat totals separating requested, approved commitments, withdrawn commitments and remaining funds; deadline override evidence and award-export Button | Maintain grant/budget records, record evidenced external receipt or late override and authorized award withdrawal through existing operations |

Keep mobile intake linear with readable required-answer labels and deadline. Loading reveals no private placeholders; distinguish an empty assigned queue from filtered-empty. Preserve unsaved answers and reasons across validation failures and preference changes. Refresh affordability after a stale/concurrent decision and show the committed outcome rather than optimistic approved state. Show decision-notice delivery separately from the award. Budget/export views retain currency and authorized scope, and an approved award remains a monetary commitment rather than a disbursement or workspace credit.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Applicants may remember program/location discovery filters; reviewers may remember an authorized location and pending-review default. These are display choices with a clear/reset control, never deadline overrides, assigned reviewer changes, budget limits or eligibility grants. Missing or newly inaccessible saved filters fall back to an accessible default. Keep the program's business timezone and amount/currency interpretation independent of interface language.

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

The source and handwritten JavaScript now include private incremental intake, typed complete-answer validation, linked corrections/resubmission, external applicant intake and evidenced deadline overrides, frozen decisions, private review comments, immutable withdrawal evidence, budget totals and a typed `award_export` read result. Requested totals show retained submitted/decided requests, including rejected revisions; approved commitments and withdrawn commitments are separate sums. The export contains only currently approved monetary commitments, with record reference, title, exact amount/currency and decision time. It returns typed rows through the canonical form; no CSV/file sink or fund payment is implied.

The eight inline example tables cover 29 cases: draft editing/blank-answer validation, intake self-review/deadlines, correction privacy, complete answers and duplicate/foreign keys, predecessor decision races and fresh receipt, external receipt overrides, award affordability and withdrawal preservation. Their target fixture recipes and table callbacks defer record access through `async(c,s)` and keep row dependencies separate. These are authored expected behaviors, not executed BDD results.

Three fresh [saved consultations](../design/jev/grant-completion/) compared linked correction records with reopening one Application and archiving the old evidence. All selected linked records: confidence 0.97/0.93/0.81, probabilities linked 0.98/0.96/0.91 and reopen 0.02/0.04/0.09. The contexts, instructions and option descriptions were rewritten and checked for equivalent facts before sending. Their varying uncertainty supplies no guarantee of wording independence. No selection disagreed; the requests were rechecked without finding a factual reversal. JEV supplied no rationale. The final external-intake ownership assignment and private-comment/export details were added after the consultation and were not separately judged.

`python3 tools/can_parser.py draft/CanGrant.can` and `node --check draft/CanGrant.mjs` passed. The parser establishes syntax only. The proposed stdlib/UI imports, semantic checking, auth/storage admission, atomic concurrent budgets, rendering, provider delivery and example runner remain unimplemented. No runtime claim follows from these checks or JEV agreement.
