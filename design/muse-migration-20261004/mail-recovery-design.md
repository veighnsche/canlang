# C5 / A06 — Mail notice recovery, paused handoff

2026-10-04. Work was interrupted by the user's priority change to the nine complex apps. **No application/shared-contract changes were made and no recovery policy is adopted.** This file preserves the completed investigation and advisory evidence so another bounded design task can finish the source/target witness.

## Verified current boundary

Read `draft/CanMail.can`, `draft/CanMail.mjs`, `draft/CanMail.md`, current MIGRATION C5, DESIGN §§4–8.1 and §13, and the older `design/jev/mail-completion-20261004/` evidence. Existing Mail has initial receive/match notice sends, bounded keyed reminders and a current-association success callback; it has no user-callable notice retry. `retry_fee` belongs to billing and must not be reused as email behavior.

- `std.EmailV1` declares send only. There is no adopted source-level email reconcile/retry operation. A runtime retry preserves the same delivery identity and frozen request; another `send` creates another intent.
- Receipts expose id/status/result/error, not a request accessor. `unknown` can follow remote acceptance. `failed` can include malformed typed results after remote side effects. Error code/message cannot establish safe repetition.
- Current Item.notification selects the latest delivery. The correlated successful callback alone advances received to notified; it never establishes reading, physical collection or forwarding. Old receipt outcomes must remain distinct from a replacement's result.
- An expired physical-mail Service does not by itself prevent notice/collection resolution for already held property. Collection, forward preparation and return make a collection notice ineligible.
- Existing dispatch checks validate the current recipient but do not compare its current account/email against an explicitly retained frozen account/address. A future resend witness needs both comparisons to avoid sending an old frozen destination after the contact was changed and reverified.
- C3 coordination confirmed that deployment.mail stays required, runtime outage is normal delivery failure/uncertainty, and existing unresolved/in-flight/unknown work needs its compatible binding retained or removal blocked. No service-presence predicate or optional-binding syntax is adopted. C3 owns separate billing import, visibility and entitlement examples and does not edit notice recovery.

## Completed JEV round

All three independent, equivalent choice requests were sent successfully using `jev-1.13.0`. They concern this new bounded Mail recovery policy only; neither the blocked population request nor the blocked dependency payload was retried or rephrased.

| Request | Selected advice | Confidence | P(runtime_only) | P(evidenced_resend) | P(acknowledged_resend) |
| --- | --- | --- | --- | --- | --- |
| [1](../jev/muse-mail-recovery-20261004/1.request.json) | acknowledged_resend | 0.30 | 0.45 | 0.02 | 0.53 |
| [2](../jev/muse-mail-recovery-20261004/2.request.json) | runtime_only | 0.46 | 0.64 | 0.02 | 0.34 |
| [3](../jev/muse-mail-recovery-20261004/3.request.json) | acknowledged_resend | 0.58 | 0.27 | 0.02 | 0.71 |

Raw result files are saved alongside each request. No mean, vote or confidence threshold is an adoption decision. The choices disagree; classifier responses provide no rationale. Manual wording review found the same settled facts, common safeguards and alternatives in each request. The substantive tension is useful in-app staff recovery versus deliberately permitting a possibly duplicate email when no provider reconciliation operation exists. Further investigation/review of that tradeoff remains open; it was not resolved before the priority change.

Alternatives compared fairly: (1) existing identity-preserving runtime recovery only, leaving exhausted/ambiguous cases without an app recovery action; (2) fresh send after staff-attested provider nonacceptance, acknowledging that a human assertion does not itself become trusted transport proof; (3) explicitly acknowledged additional send with new identity after failed/unknown, retaining the old uncertain outcome, or after skipped with a reason. Each new-send option has the same current authority, frozen request, attribution and replay safeguards.

## Candidate under investigation, not selected

The direction being worked through was a staff action labelled **Send another notice**, distinct from retrying or reconciling its predecessor. Require a nonblank reason and possible-duplicate acknowledgement for failed/unknown; a currently skipped undispatched attempt requires a reason. Refuse pending/succeeded as failure recovery. Preserve the old receipt unchanged. New user operation identity deduplicates replays of this additional request.

A small immutable Notice child could retain destination/contact/account, rendered subject/body, receipt association, kind/reminder number, predecessor, staff reason and duplicate acknowledgement. Item.notification would remain the existing status-only recipient projection; a staff-only current Notice pointer would correlate the frozen request/history. This duplicates an association for two distinct projections, not receipt status. The design had not yet proved that this is the simplest representation.

Important obligations for the unfinished witness:

1. Receive, match and automatic remind must capture each original frozen request before staff recovery can reuse it; do not manufacture a historical payload from today's templates or contact data. The send, Notice completion and Item current pointers commit atomically. Use existing locks/invariants, not a new primitive.
2. Admission and dispatch recheck held-item state, latest Notice, exact current verified contact/account/email and any explicitly retained staff authorization. A superseded unclaimed send is skipped; previously claimed/unknown effects may still complete and remain visible.
3. Manual additional notices do not reset or consume the scheduled reminder number. Preserve current reminder cadence, custody operations, forwarding/billing and retention. The Notice child inherits the Item lifetime; retained replay metadata does not retain expired request content indefinitely.
4. A separate existing-syntax action can repair received→notified from the **current authoritative succeeded receipt** if its callback failed. It must not call this a provider status query, turn unknown/failed into success, or recover expired result content. Whether status alone suffices versus retained non-null result must be made explicit against the existing callback contract.
5. Staff history must show predecessor and replacement outcomes independently, including a late old success. Recipient permissions remain the existing latest status-only grant; frozen email/content and staff evidence remain private. Derived fields still require readable dependencies—never treat a grant on a derive as automatic declassification.
6. Required examples include wrong role/location, stale association/version, pending/succeeded refusal, unknown without acknowledgement, failed-with-possible-effect acknowledgement, skipped recovery, frozen payload after template/contact changes, completed custody, expired Service with held item, repeated user identity, old callback after replacement, current-success callback repair, and field disclosure.
7. Actual installed rows lacking a retained frozen request cannot be backfilled by guessing. This is a draft corpus with no implemented engine; any later installed-data migration needs real owner/binding/request evidence.

No complete Can/JS witness, requirement replacement or executable checks were produced before interruption. Request JSON structure and independently worded choice fields were checked; the three consultations completed. No providers, runtime or BDD examples executed. The exact eventual application paths are `draft/CanMail.can`, `draft/CanMail.mjs` and `draft/CanMail.md`; root must settle the policy before assigning Muse A06.

Writer released from this paused C5 design. Remaining work is a focused business-policy decision, complete source/desired-target/BDD witness and coordinator acceptance—not a missing permission to run the already completed JEV round.
