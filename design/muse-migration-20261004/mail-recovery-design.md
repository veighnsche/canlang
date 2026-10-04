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

## Coordinator-completed witness (user-authorized 2026-10-04; Codex review pending)

Adopted policy: **acknowledged_resend**. Scope: this witness only. No email reconcile/retry operation is adopted (`std.EmailV1` still declares send only); `retry_fee` stays billing-only and is not reused; `deployment.mail` stays required. No compiler/stdlib/infrastructure design. Nothing here is applied to `draft/CanMail.can`, `draft/CanMail.mjs` or `draft/CanMail.md`; Codex reviews after.

### JEV disagreement, investigated

| Request | Advice | Confidence | P(ack_resend) | P(runtime_only) | P(evidenced) |
| --- | --- | --- | --- | --- | --- |
| 1 | acknowledged_resend | 0.30 | 0.53 | 0.45 | 0.02 |
| 2 | runtime_only | 0.46 | 0.34 | 0.64 | 0.02 |
| 3 | acknowledged_resend | 0.58 | 0.71 | 0.27 | 0.02 |

All three agree on the settled facts and shared safeguards, and unanimously reject `evidenced_resend` (P≈0.02 each): a staff attestation of provider nonacceptance cannot become trusted transport proof, so gating on it adds manual work without adding truth. The remaining split is risk framing, not fact: request 2 weights duplicate-avoidance and authoring simplicity; requests 1 and 3 weight giving staff an actionable recovery once bounded same-identity runtime retries are exhausted. Request 1 is near-tie weak (0.53 vs 0.45); request 3 is the strongest single signal (0.71, confidence 0.58).

Rationale for adopting acknowledged_resend: majority (2 of 3), highest single confidence (0.58), highest top-probability (0.71), and it is the only option that leaves exhausted/ambiguous deliveries recoverable from the business app. This is advice, not proof: confidences are low overall, so the witness keeps the policy bounded — explicit possible-duplicate acknowledgement, nonblank reason, frozen-request reuse, old receipt preserved unchanged, and refusal of pending/succeeded as failure-recovery inputs.

### Delivery-identity rule

Same-delivery-identity runtime retry (existing bounded policy, frozen request, same receipt id) is the only true retry and needs no new source. Every `send Mail.send` in this witness admits a **new send intent** with a new delivery identity; it is labelled **Send another notice**, never "retry" or "reconcile", and makes no claim about the predecessor transport.

### Can witness (proposed, not applied)

```can
## Immutable staff-only notice history; one row per admitted notice intent.
Notice in Item { account:user label="Frozen account", address:text label="Frozen address", subject:text, body:text, receipt:delivery(Mail.send)? label="Notice receipt", kind:enum(initial,reminder,additional), number:int, predecessor:Notice?, reason:text?, acknowledged:bool=false label="Possible duplicate accepted", author:user server=actor label="Author" } label="Notice attempt"
policy Notice read=mail_staff and can_work(actor,row.parent.location)
lock Notice fields=account,address,subject,body,receipt,kind,number,predecessor,reason,acknowledged,author
```

Item gains a staff-only current pointer alongside the existing recipient-visible `notification` association (recipient grant unchanged: latest status only; frozen address/content and staff evidence stay private):

```can
## Item.notice:Notice? — staff-only current attempt; Item.notification keeps the existing status-only recipient projection.
policy Item read=mail_staff and can_work(actor,row.location)
```

Receive/match/remind capture each original frozen request into a Notice row (account, address, rendered subject/body, receipt association, kind/number) in the same atomic commit as the send and the Item pointer updates; staff recovery reuses that retained row and never manufactures a historical payload from today's templates or contact data. Manual additional notices do not reset or consume the scheduled reminder number.

```can
# Send one additional frozen notice after a failed, uncertain or skipped attempt, keeping the old outcome. @{nl="Verzend één extra bevroren melding na een mislukte, onzekere of overgeslagen poging, met behoud van de oude uitkomst."}
scenario send_another_notice(item:Item, reason:text, acknowledged:bool=false) by=mail_staff label="Send another notice"@{nl="Nog een melding verzenden"}
 require can_work(actor,item.location) and item.service!=null and item.state in [received,notified,collection_ready] and item.notice!=null and trim(reason)!=""
 require item.notice.receipt!=null and item.notice.receipt.status in [failed,unknown,skipped]
 require item.notice.receipt.status==skipped or acknowledged
 require recipient(item.service.recipient.account,item.service)
 ## Both frozen comparisons: account AND address must still match current verified contact.
 require item.notice.account==item.service.recipient.account and item.notice.address==item.service.recipient.email
 do
  send Mail.send {to=item.notice.address,subject=item.notice.subject,body=item.notice.body} when=item.state in [received,notified,collection_ready] and recipient(item.service.recipient.account,item.service) as delivery
  create Notice {parent=item,account=item.notice.account,address=item.notice.address,subject=item.notice.subject,body=item.notice.body,receipt=delivery,kind=additional,number=item.notice.number,predecessor=item.notice,reason,acknowledged} as next
  set item {notification=delivery,notice=next}
```

Admission and dispatch recheck held-item state, latest Notice, exact current verified contact/account/email and staff authorization; a superseded unclaimed send is skipped while previously claimed/unknown effects may still complete and remain visible. Collection, forward preparation and return make a collection notice ineligible (states collected, forward_pending, forwarded, returned are excluded above). An expired Service with a held item stays eligible: no `live(service)` gate, only current verified recipient/account/address.

Receipt/outcome semantics: observe `id/status/result/error` only. `unknown` (uncertain acceptance, may already have sent) and `failed` (definite delivery/typed-result failure, possibly after remote side effects) stay distinct; error code/message never establishes safe repetition. The predecessor receipt row is never mutated; the replacement's result is a new association, and staff history shows predecessor and replacement outcomes independently, including a late old success. Replaying the same user operation identity returns its receipt without sending again.

A separate existing-syntax repair (no provider contact) may apply the **current authoritative succeeded receipt** when its callback was missed:

```can
# Reapply the current accepted notice outcome when its callback was missed. @{nl="Pas de huidige geaccepteerde meldingsuitkomst opnieuw toe als de callback is gemist."}
scenario apply_notice_success(item:Item) by=mail_staff label="Apply accepted notice"@{nl="Geaccepteerde melding toepassen"}
 require can_work(actor,item.location) and item.state==received and item.notice!=null and item.notice.receipt!=null and item.notice.receipt.status==succeeded and item.notice.receipt.result!=null
 do
  set item {state=notified}
```

This must not convert unknown/failed into success, call itself a provider status query, or recover expired result content (null result rejects).

### Desired JavaScript witness (proposed, not applied)

```js
"mailroom.send_another_notice": {
  handler: "sendAnotherNotice",
  by: "mailroom.mail_staff",
  read: false,
  label: message("Send another notice", { nl: "Nog een melding verzenden" }),
  inputs: {
    item: { type: "mailroom.Item" },
    reason: { type: "text" },
    acknowledged: { type: "bool", default: false },
  },
},
// handler (desired):
// check(canWork(c, item.location), "forbidden") via by-guard; then:
// check(item.service != null && ["received","notified","collection_ready"].includes(item.state), "rule_failed");
// const current = await notice(c, item); // staff-only current Notice pointer
// check(current != null && current.receipt != null, "rule_failed");
// check(["failed","unknown","skipped"].includes(current.receipt.status), "rule_failed");
// check(current.receipt.status === "skipped" || acknowledged === true, "rule_failed");
// check(trim(reason) !== "", "rule_failed");
// const contact = item.service.recipient; // exact current verified contact
// check(recipient(contact.account, item.service), "rule_failed");
// check(same(current.account, contact.account) && current.address === contact.email, "rule_failed");
// const delivery = await send(c, "mailroom.Mail.send",
//   { to: current.address, subject: current.subject, body: current.body },
//   { when: item.state in [received,notified,collection_ready] and recipient(...) });
// const next = await create(c, "mailroom.Notice", { parent: item, account: current.account,
//   address: current.address, subject: current.subject, body: current.body, receipt: delivery,
//   kind: "additional", number: current.number, predecessor: current, reason, acknowledged });
// await set(c, item, { notification: delivery, notice: next }); // atomic with send+create
```

### BDD acceptance and failure examples (proposed)

```gherkin
Feature: bounded mail notice recovery (acknowledged resend)

  Background:
    Given a held item in state "received" with a current frozen Notice
    And current location mail staff authority

  Scenario: failed notice recovered with acknowledgement
    Given the current receipt status is "failed" with error { code: "provider" }
    When staff send another notice with reason "Customer reports no email" and possible-duplicate accepted
    Then a new delivery is admitted with the frozen address, subject and body
    And the old receipt still reads status "failed" with its error
    And the scheduled reminder number is unchanged

  Scenario: unknown notice recovered with acknowledgement
    Given the current receipt status is "unknown" with result null
    When staff send another notice with a reason and possible-duplicate accepted
    Then a new delivery is admitted and the old "unknown" outcome stays visible

  Scenario: unknown without acknowledgement is refused
    Given the current receipt status is "unknown"
    When staff send another notice with a reason but without accepting possible duplication
    Then the operation rejects with rule_failed and no delivery is admitted

  Scenario: skipped notice needs only a reason
    Given the current receipt status is "skipped"
    When staff send another notice with reason "Superseded before dispatch" and no acknowledgement
    Then a new delivery is admitted

  Scenario: pending and succeeded are refused as failure recovery
    Given the current receipt status is "pending"
    When staff send another notice
    Then the operation rejects with rule_failed
    Given the current receipt status changes to "succeeded"
    When staff send another notice
    Then the operation rejects with rule_failed

  Scenario: stale destination is never sent after contact change and reverify
    Given the verified contact email changed to "new@example.test" and was reverified
    So that the frozen address no longer equals the current address
    When staff send another notice for the old frozen Notice
    Then the operation rejects with rule_failed and nothing is sent to the old address
    Given instead the frozen account no longer equals the current account
    When staff send another notice
    Then the operation rejects with rule_failed

  Scenario: custody completion makes collection notices ineligible
    Given the item state is "collected"
    When staff send another notice
    Then the operation rejects with rule_failed
    Given the item state is "forward_pending" after forward preparation
    When staff send another notice
    Then the operation rejects with rule_failed
    Given the item state is "returned"
    When staff send another notice
    Then the operation rejects with rule_failed

  Scenario: expired service with held item stays recoverable
    Given the service expired but the item is held and the recipient is currently verified
    And the current receipt status is "failed"
    When staff send another notice with a reason and possible-duplicate accepted
    Then a new delivery is admitted

  Scenario: replay of the same user operation sends nothing twice
    Given a committed send-another-notice operation identity
    When the same user operation is replayed
    Then the original receipt is returned and no second delivery is admitted

  Scenario: old callback after replacement stays distinct
    Given a replacement notice was admitted while the predecessor was "unknown"
    When the predecessor completion arrives late with status "succeeded"
    Then staff history shows the predecessor success and the replacement result independently
    And the Item current pointer still selects the replacement

  Scenario: current-success callback repair
    Given the item state is "received" and the current receipt is "succeeded" with a non-null result
    When staff apply the accepted notice
    Then the item state becomes "notified" with no provider contact
    Given instead the current receipt is "unknown"
    When staff apply the accepted notice
    Then the operation rejects with rule_failed

  Scenario: authority and disclosure
    Given the caller lacks the mail_staff role
    When staff send another notice
    Then the operation rejects with forbidden
    Given the caller is mail staff at another location
    When staff send another notice
    Then the operation rejects with rule_failed
    Given a verified recipient reads the item
    Then only the latest notice status is visible
    And the frozen address, content, reason and acknowledgement stay private
```

Checks run: full read of this file (48 lines pre-append) and all six JEV evidence files; `draft/CanMail.can` (355 lines), `draft/CanMail.md`, `draft/CanMail.mjs` (target head/contract); `draft/MIGRATION.md` C5/R1/task rows; DESIGN delivery/receipt semantics (§8: send/when/receipt, `DeliveryResult`/`DeliveryError`, same-identity retry vs new intent). No providers, runtime or BDD examples executed — draft corpus, no implemented engine. Append-only edit verified by re-reading the file tail; no existing content altered; `inbox.md`, `monitor.md`, `tasks.md`, `review.md` and git untouched. File released for Codex review.
