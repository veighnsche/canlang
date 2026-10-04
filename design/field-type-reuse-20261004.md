# Qualified field-type reuse — 2026-10-04

The twelve skipped stored-field occurrences are valid checked owner-schema links under current DESIGN §§2/13. None requires a source or target correction. The direct metadata scan cannot establish this by counting local array/nullable tokens: it must first resolve the owning field's **value type**. Its temporary JSON and script are inspection aids, not evidence of an implemented checker. Current Approve attached CRUD examples exceed that projection script; its two occurrences were read directly from source/target.

## Exact resolution clarification

In field metadata, `{type:"owner.Declaration.field", ...}` links the declared field's value schema, not its whole field metadata and not an automatically new nominal type. Resolve the path through canonical imports/owner schemas, including model, contract, event and computed fields; recursively resolve value-type reuse and diagnose unresolved paths or type cycles. Preserve the underlying scalar/model/contract identity or the original owning enum identity/cases, any array/nullability shape, normalization and value bounds. Then apply the receiving declaration's explicit type suffixes and compatible value constraints. In the compact target descriptor `array:true` and `nullable:true` on a field-schema link denote the receiving type modifiers; do not silently overwrite an inherited shape or treat repeated suffixes as idempotent. The source rules still reject array-on-array/nullable and redundant nullable modifiers. The checker's resolved value schema has the final effective shape.

The linked value schema does not supply default, server initialization, requiredArray, uniqueness, containment/ownership or permission. Only the receiving declaration supplies those field-level behaviors. Labels are resolved separately under the existing caption/value-label inheritance rules; do not clone the referenced field's label metadata as part of type resolution or bypass a receiving caption override. Enum value-label reuse is presentation, not permission or default inheritance. A valid field link therefore remains compact even when its owner has unrelated creation behavior.

This is distinct from sequence assertion `types` and `equalValue` canonical value-type IDs: these name a **resolved** value type. An alias to an int field uses `int` there; an alias to a nominal owning enum uses that owning enum ID (plus resolved nullable/array shape). Do not replace every valid schema link merely because scalar field paths are invalid as invented nominal assertion types.

## Resolved inventory

Locations are current at inspection; only stored-model fields in the requested skipped set are counted.

| Source field | Target location | Effective value type | Receiving behavior |
| --- | --- | --- | --- |
| approve.Notice.assignment (`Submission.assignment`) | draft/CanApprove.mjs:208 | int, nonnull | **No** inherited default 1 or Assignment revision caption |
| approve.Notice.state (`DeliveryResult.status`) | draft/CanApprove.mjs:217 | std.DeliveryResult.status enum | Explicit pending default |
| check.Transition.from (`Check.state`) | draft/CanCheck.mjs:188 | check.Check.state enum: new/up/late/down/paused | Explicit From caption; no inherited new default |
| check.Transition.to (`Check.state`) | draft/CanCheck.mjs:189 | Same owning enum | Explicit To caption; no inherited new default |
| check.Notice.outcome (`DeliveryResult.status`) | draft/CanCheck.mjs:205 | std.DeliveryResult.status enum | Explicit pending default/caption |
| hire.Candidate.previous_stage (`Candidate.stage?`) | draft/CanHire.mjs:266 | nullable hire.Candidate.stage enum: applied/interview/offer/hired/rejected/withdrawn | Nullable suffix retained; no applied default |
| loyalty.Redemption.notification (`DeliveryResult.status`) | draft/CanLoyalty.mjs:298 | std.DeliveryResult.status enum | Explicit pending default/caption |
| onboard.Step.category (`TemplateStep.category`) | draft/CanOnboard.mjs:199 | onboard.TemplateStep.category enum: equipment/induction/account/training | **No** inherited induction default |
| purchase.Return.posting (`Receipt.posting`) | draft/CanPurchase.mjs:385 | purchase.Receipt.posting enum: pending/confirmed/failed/unknown | Explicit pending default |
| purchase.Payable.posting (`Receipt.posting`) | draft/CanPurchase.mjs:403 | Same owning enum | Explicit pending default |
| rent_reservations.CommercialSale.phase (`SaleMilestone.milestone?`) | draft/CanRent.mjs:1027 | nullable invoice.SaleMilestone.milestone enum: paid/completed/cancellation_passed/reversed | Nullable suffix; explicit null in target is equivalent nullable baseline |
| shift.Notice.kind (`DutyNotice.kind`) | draft/CanShift.mjs:421 | shift.DutyNotice.kind event-owned enum: published/changed/cancelled/swap_request/swap_accepted/swap_rejected | Required nonnull; no default |

The shared DeliveryResult status cases are pending/succeeded/failed/unknown/skipped. All referenced source fields in this set are initially nonnullable and nonarray. Only the two noted receiving declarations add nullable. No array/requiredArray or inherited normalization/numeric bound mismatch is demonstrated in these twelve; do not claim this set tests such edge cases. SaleMilestone resolves through the actual invoice import, and DutyNotice through the actual local event schema, not an assumed model table.

## Minimal action

No app owner needs a patch for these twelve links. Root may insert the value-only resolution clarification into the desired-target contract; do not bulk flatten/copy metadata, add defaults, or change historical enum identities. The remaining gap is implementing/checking this already required resolution, outside this draft-only task. No JEV consultation is needed for this direct reconciliation of settled field-reuse and assertion-ID rules. No application, shared contract, parser or runtime files were edited, and no behavioral execution is claimed.
