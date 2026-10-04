# Owner-wide reconciliation beyond one atomic batch

Investigation, 2026-10-04. No new syntax or runtime contract is adopted here. This is the remaining population-coverage part of MIGRATION task 3, exposed by the Shift review; Book and Propose's record-addressed corrections remain valid.

## Demonstrated gap

CanShift's employee, member, location and availability handlers scan affected commitments and swaps with `limit=500`. DESIGN's ordinary loop limit rejects the whole transaction on excess. At 501 matching records, neither the domain writes nor follow-up events commit. A higher constant postpones the same failure. Current eligibility still denies new ineligible work; this does not deliver required reconciliation to all existing owners.

CanBook's `Attempt.created` handler locates one attempt by its committed identity and admits record-addressed progress. CanMail's reminders use a keyed record-bound schedule and its successor. These are successful continuation mechanisms, but an employee/location event supplies no list of affected commitment identities. Shift's new `recover_commitment` supplies explicit authorized recovery for one selected record; it does not establish automatic population coverage.

## Alternatives to compare

1. **Authored continuation.** Store an owning reconciliation record with source identity/revision, phase and cursor. A step selects the next record, admits its review, stores progress and schedules its successor. The target uses existing `first(records(...))`, `set`, `emit` and `schedule`. This offers explicit application control and preserves current syntax, but repeats traversal/recovery state across apps. The contract must still establish bounded indexed traversal and coverage under concurrent changes; opaque IDs alone are not a creation watermark. A cursor sketch is not proof of complete progress.
2. **Existing per-record schedules.** Admit a keyed eligibility review from each record's creation and reschedule while needed. Each transaction remains small and uses existing identities. This adds recurring work on unchanged records and detection lag, and still needs complete initialization for already-installed records. Creation events do not seed old rows; maintenance backfills cannot emit schedules. Without an initialization contract, this is incomplete rather than an equivalent finished solution.
3. **Shared per-record event enumeration.** A proposed declaration could resemble `scenario review on=EmployeeChanged each commitment in Commitment where=...`, retaining the ordinary body. A separate declaration handles swaps. Desired metadata could resemble `{on:EmployeeChanged,each:{model:"shift.Commitment",predicate:"affected_commitment"},handler:"review"}`. Both spellings are unadopted. Applications own selection and effects; shared execution owns durable bounded enumeration. This avoids repeated application checkpoints but requires a substantial completeness, owner-routing and recovery contract. It does not change atomic `for limit` into partial execution.

## Semantics still to settle

- Keep enumeration and each mutation within the resolved authoritative owner; an eventual Durable Object directory cannot prove complete owner coverage.
- Derive stable child occurrence identities from the source occurrence and record identity. Duplicate source delivery must not duplicate business effects.
- Reload current record state and authority for each child; preserve historical source facts only when explicitly captured.
- Make durable child admission and checkpoint progress crash-safe. Successive bounded transactions must handle 499, 500, 501 and 1,000 affected records.
- Define the covered population and concurrent insert/update/remove rules. Repeated current queries alone specify neither completeness nor termination.
- State supersession behavior without discarding already-admitted effects. Revocation denies new business actions immediately; reconciliation must not silently release retained reservations.
- Preserve failed children for recovery while independent work can progress. A local body that exceeds its own atomic bound remains invalid; enumeration cannot repair it.

A possible reference exercise is an employee becoming ineligible while commitments are created, moved or cancelled, followed by restoration, duplicate source delivery and one rejected child. Expected outcomes must distinguish eventual current-state review from a historical snapshot of the source event. Do not promise both without specifying how.

## Consultation preparation

Use a balanced `choice` question about allocation of traversal responsibility. Supply the exact source witnesses, all three alternatives, their concrete costs/benefits, and the absence of any implemented execution engine. Preserve the same workloads and failure cases across three completely rewritten requests. Separate specific completeness properties into `noul` questions only where needed; an ordered adoption/implementation rubric may use `score`. Retain probabilities and disagreement without an approval threshold.

This report is preparation, not a JEV consultation or decision. Proposed fanout semantics remain open. A selected approach needs a complete Can/desired-JS witness and independent expected outcomes before broad application. The new AI research/search drafts will exert the same pressure through paginated sources and multi-stage work, so this contract should be evaluated once rather than reinvented in every app.

Sources: [DESIGN effects/events/storage](../DESIGN.md), [CanShift](../draft/CanShift.can), [CanBook](../draft/CanBook.can), [CanMail](../draft/CanMail.can), [harder-app investigation](AI-AND-SERVICE-DRAFTS.md).
