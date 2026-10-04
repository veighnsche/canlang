# Capability completion error clarification — 2026-10-04

This is the focused clarification applied to DESIGN §8, not runtime implementation. The document already defined the closed two-field DeliveryError schema; the missing detail was its consistency with completion status and its interpretation. No new spelling or provider-specific payload is needed. No JEV consultation was needed: preserving the already specified shape resolves the demonstrated fixture gap without a consequential notation choice.

## Verified evidence

- DESIGN §8 already defines `DeliveryError` as non-null `code:text` and safe non-null `message:text`, and requires a typed safe error on failure. Completion has `{delivery_id,status,result:R?,error:DeliveryError?}`.
- CanCheck notification_result and CanCatch notification_result store `event.error?.message`; CanStats and CanInvoice do likewise for failed/unknown outcomes. No inspected consumer requires provider details, retry flags, stack traces or nested error data.
- CanCheck uses `{code="provider",message="Delivery rejected"}`; CanDesk uses `{code="rejected",message="Recipient rejected"}`; CanDo and CanCatch use `code="unavailable"`. Thus code is text, not a closed enum inferred from one provider.
- CanGrant, CanApprove and CanDesk already witness unknown/null/null; CanGrant also witnesses skipped/null/null. Success examples provide the declared result and null error.
- DESIGN §6 distinguishes skipped undispatched/superseded work from failed authored guards. §8 distinguishes transport acceptance, owner commit and business result state; invalid result schemas yield typed failed completions, while uncertain commit evidence is unknown. These distinctions must survive the clarification.

## Exact proposed contract paragraphs

`DeliveryError` is the single closed standard error payload `{code:text,message:text}`. Both fields are required and non-null. `code` is a stable safe machine classification supplied by the versioned adapter mapping; it is text, not a provider-specific enum or an arbitrary raw provider error. `message` is a safe human-readable explanation, never machine control flow. The adapter must redact both fields before admitting the completion: no credentials, tokens, request/response bodies, stack traces or confidential provider/account data may be copied into them. If no safe specific explanation is available, emit a generic classification and explanation. Ordinary owning record/field disclosure still applies if the application stores or displays the error. No `details`, `retryable`, provider-response or other extra fields are part of this standard type.

The runtime validates completion status and payload together before invoking its handler. `succeeded` carries the declared result value and `error=null`; `failed` carries `result=null` and a non-null `DeliveryError`; `unknown` carries `result=null` and either a safe diagnostic `DeliveryError` or null; `skipped` carries `result=null,error=null`. A pending receipt is not a completion occurrence. An inconsistent envelope is invalid input, including in fixtures; it cannot satisfy an authored business-error expectation. A nullable or no-result operation follows its declared result type rather than fabricating a value. Success is delivery/typed-operation success, not an invented domain outcome: a valid result may itself describe pending or unavailable business work.

Neither an error code nor its message grants retry authority or proves that remote effects did not occur. `unknown` means acceptance or commit cannot be established, including a timeout after a possible remote commit; it is not a failed business operation or a safe invitation to issue a new attempt. `failed` identifies a definite delivery/typed-result failure, including an adapter rejection or invalid result schema, and does not by itself prove the absence of remote side effects. Reconciliation, retry eligibility and idempotent replay remain governed by the existing operation identity, adapter and owning business contracts. A retry of the same delivery retains its identity; an error payload cannot create a new business operation or clear uncertainty. `skipped` retains its existing undispatched/superseded/ineligible-work meaning and is not substituted for an authored guard failure.

## Failed-completion witness for Grant

Replace/add a row in the existing `notice_result` examples; this uses the existing fixture and actual handler, not a fabricated provider schema:

```can
examples seed=[submitted] event={delivery_id="delivery",status=failed,result=null,error={code="rejected",message="Notification rejected"}}
 submitted.notice_delivery,submitted.notice_state -> submitted.notice_state,submitted.state
 "delivery",pending -> failed,submitted
```

The saved delivery matches the event, so the handler records failed notice delivery while preserving submitted application state. This asserts notification transport failure, not application rejection. The failure fields are synthetic safe fixture data under the canonical standard shape; they make no claim about a particular real provider's error codes.

## Existing violations for coordinator follow-up

- `draft/CanReport.can:65`: failed completion with `error=null` conflicts with the existing requirement that failure carries a typed safe error.
- `draft/CanRent.can:1166` and `draft/CanRent.mjs:8935` (locations at inspection): failed completion uses raw string `"Owner rejected consumption"` instead of the two-field error object. These should preserve the expected business outcomes and change only the completion fixture shape.

The coordinator applied these consistency rules and corrected Report's null failure and Rent's string failure to the existing typed error shape, preserving unknown/null and all business outcomes. Grant's matching/mismatched failed-notice cases preserve approved award evidence. Source/result consumers were inspected; no delivery adapter, fixture runner, provider execution or runtime schema validation was implemented or tested.
