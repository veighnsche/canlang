# Associated typed deliveries — 2026-10-04

The subsequent [status-only disclosure review](delivery-leaf-grants-20261004.md) refines this association proposal: explicit leaf grants and one record/field/selected-property observation helper replace the original handle-only lookup. The initial consultation requests remain unchanged as historical evidence. Current shared contracts and app targets use the refined form.

## Decision

Add one opaque target-indexed value type, `delivery(Operation)`, using the existing `action(Operation)` notation as precedent. Store the result of `send` in an ordinary nullable field. Observe the existing persistent runtime receipt through it instead of copying transport state into domain columns. Keep explicit completion handlers wherever business state or attachments change. Do not add `send into`, implicit completion hooks, generated shadow columns, or a new deployment manifest.

This is a proposed contract change, not an implemented API. It changes the current statement that send returns only DeliveryResult: send produces the typed association, while external mutation receipt envelopes may retain the existing id/status projection. No deployed compiler compatibility is assumed.

## Verified current cases

| Source | Existing authority/effects | Repeated tracking versus necessary reaction |
| --- | --- | --- |
| CanGrant decide / notice_result | by reviewer; assigned reviewer differs from applicant, submitted state, can_work, nonempty reason and remaining-budget check before approval. Decision commits before Mail.send. | notice_delivery + pending state + current-ID lookup + copying event.status is pure transport tracking. Application approval/rejection remains the decide operation's work. |
| CanPropose send_offer / notice_result | by salesperson; can_work, draft, nonempty items, unexpired offer; freezes total and sent state, then sends frozen notice. | Current mail ID/status and succeeded→delivered mapping can become receipt observation/presentation. It is not recipient acceptance. |
| CanPropose document / document_result | by salesperson or authenticated; existing sent/accepted/declined and staff/addressed-verified-recipient guard. Sends frozen snapshot. | PDF callback validates current request ID, source and revision before attaching the finalized file and marking ready. This is business validation, not removable tracking. |
| CanMail receive / notice_result | by mail_staff; current work scope, unique source, valid storage and live matching service. Guarded send; reminders may replace current notice ID. | Receipt state/reference copies can disappear. Matching success conditionally changing received to notified must remain explicit. Late old notices cannot advance current item state. |

Inspected current sources and corresponding desired JS; the runtime already owns durable outbox identity, frozen localized payload, retries, status/results/errors, and provider idempotency. DESIGN §§7–8 require current disclosure/lifetime, at least seven days of ordinary receipt retention, explicit reconciliation for uncertainty and no transport-to-domain success inference. There is no delivery runtime execution or measured source-token benefit here.

## Exact proposed contract text

`delivery(Operation)` is an opaque reference to one durable delivery of an explicitly named local bound capability operation or bound exported user operation. Operation identity includes the resolved canonical declaration and binding; aliases do not create new identities. One target is named, not an arbitrary string or runtime-discovered type. Its result schema is derived from that existing operation. The type supports the ordinary nullable suffix and storage in an owning model; an unassociated field is null. Null is not pending, failed or unknown. There is no production structural constructor, raw-ID cast, global delivery enumeration, or new callable privilege.

`send Target {arguments} [when=predicate] as attempt` returns `delivery(Target)`. Its originating owner/app/team, immutable ID, arguments and frozen final text/locale/release are fixed by the existing outbox contract. An ordinary `set row {notice=attempt}` associates it atomically with the domain transaction. Assignment accepts only a compatible target and the same originating storage owner/app/team; an opaque value copied from another principal's response is not assignable authority. In production a new association is made from the current operation's send result, or by preserving an existing same-owner associated value already authorized for that mutation, never from a caller-submitted forged receipt. Association does not make dispatch synchronous. Replacing the field selects a new current attempt; it neither cancels the previous delivery nor erases its retained history. Grant's existing one-shot association lock can remain a lock on the new field identity.

The association exposes read-only `id:text`, `status:DeliveryResult.status`, `result:R?` and `error:DeliveryError?`. These are observations of the persistent runtime receipt, not copied business fields. Completion envelope consistency follows §8, including pending having no completed result/error; a read may additionally withhold an expired or unauthorized result/error without changing retained status, as existing receipt replay already permits. Callers may not set nested status/result/error or invent provider observations. Reading a stored association requires the containing record/field grant; revealing its result/error additionally obeys the existing operation-result, safe-error and file/lifetime disclosure rules. Rendering the field defaults to the standard localized delivery status, never automatic expansion of recipient, outbound body, provider identifiers, result or error. Explicit source projection is required for result content; a string ID alone grants no lookup authority.

Observation uses the current authorized read checkpoint. Receipt bookkeeping remains a runtime writer participating in the existing owner consistency fence. It does not itself modify the referring domain row's version, run its CRUD hooks, unlock it, or claim a business transition. Assigning/replacing the reference is an ordinary domain write with ordinary version/lock checks. A consumer that depends on receipt state must reread it under the operation's current admission/checkpoint, not rely on a stale UI value. There is no cross-owner atomicity or background mutation of every referencing row.

A retained association keeps only its safe identity/status summary available for as long as the reference is legally retained, and at least the existing replay/retry horizon. It does not extend retention of secrets, frozen outbound content, provider payloads, error details or file bytes beyond their declared rules. Expired/withheld results remain null and are never reconstructed or redelivered merely because a field references the receipt. Removing/replacing an association does not shorten outstanding provider/replay obligations. File-valued results still require canonical receiving-app finalization, and actual domain attachment remains an explicit authorized effect. Associations cannot silently retain otherwise expired visitor or document content.

Completion handlers remain ordinary explicitly authored `on=Target.completed` handlers. A handler reacting to the current attempt compares its association's ID with `event.delivery_id` and keeps all existing source/revision/state checks. An old delivery updates its own retained receipt only; after replacement it cannot affect the newly associated attempt or domain effects whose current-ID check fails. Runtime receipt success is independent of successful execution of an application callback: callback failure leaves a business reaction unresolved rather than rewriting provider success. `failed`, `unknown`, `skipped` and provider/business result states retain their existing meanings. Association adds no implicit retries, reconciliation action, approval, payment, notification-read proof, record update or business success.

## Minimal source witnesses and mapping

Grant changes just the tracking field and associated assignment, keeping all decide guards/business effects:

```can
## Inside Application's existing schema:
notice:delivery(Mail.send)? label="Decision notice delivery"
## Existing one-shot lock becomes:
lock Application fields=notice when=row.notice!=null
## Inside the existing decide do body, after the unchanged decision writes:
send Mail.send {to=application.email,subject=format("Award decision"@{nl="Besluit over aanvraag"},locale=null),body=reason} as notice
set application {notice}
```

The Grant notice_result handler is removed because it performs only the redundant copy. The Application decision/state/amount evidence remains unchanged. The UI displays `notice`; explicit observations use `application.notice?.status`. An unsent null association renders the standard not-requested state; do not add `none` to delivery status merely for presentation.

Mail can use `notification:delivery(Mail.send)?`; each existing send stores `notification=notice`. Its necessary reaction remains:

```can
scenario notice_result on=Mail.send.completed
 do
  for item in Item as row where row.notification?.id==event.delivery_id limit=1
   if event.status==succeeded and event.result!=null and item.state==received
    set item {state=notified}
```

Provider reference is available only through explicit authorized `notification.result?.reference` projection. Removing a standalone notice_reference copy is appropriate only if the application does not need independently retained business evidence beyond receipt-result lifetime. Current Mail uses it as transport evidence; the note does not redefine custody/history retention. The notification association's readable field grants must be explicitly carried from current notice-status presentation; this cannot broaden Item's other fields.

Propose mail mirrors can likewise become `notice:delivery(Mail.send)?`. Its existing delivered caption may be a display label for succeeded, not another stored outcome. By contrast, `document:delivery(Documents.quote)?` does **not** replace pdf/document_state business validation. Keep the document completion handler, compare `row.document?.id`, verify result.source and result.revision, and explicitly attach pdf / mark ready. The same distinction keeps booking/hold/version/invoice/financial outcomes authored; they are not migrated simply because their fields contain the word delivery.

## Desired JS witness

The new field schema derives the result from the already bound operation, without duplicating its result contract:

```js
notice: { type: "delivery", operation: "grant.Mail.send", nullable: true }
```

The ordinary send/set helpers retain their roles:

```js
const notice = await send(c, "grant.Mail.send", {
  to: application.email,
  subject: format(c, message("Award decision", { nl: "Besluit over aanvraag" }), { locale: null }),
  body: reason,
});
await set(c, application, { notice });
```

Source property projections lower through the canonical receipt read helper specified below, not a provider SDK call, mutable JavaScript handle or arbitrary network getter. The external operation envelope may serialize its existing `{id,status}` summary; schema-aware typed association serialization retains protected provenance and never accepts that summary as a forgeable constructor. Mail's explicit current-correlation predicate is `async row => (await delivery(c,{record:row,field:"notification"},["id"]))?.id === event.delivery_id`; the real Item state change still uses `set`. These are desired standard-library contracts, not existing implemented exports.

## Fixture and migration obligations

No old text ID can be guessed into a valid typed association. A reviewed migration must correlate original owner/binding/delivery evidence; missing evidence blocks conversion or requires an explicit preserved legacy field, never a fabricated success. Snapshot fixtures need runtime-provisioned typed associations with the same completion-envelope checks. The fixture uses the existing `fixture name=path {fields}` grammar, with the path resolved to the bound operation rather than a model: `fixture failed_notice=Mail.send {request={to="recipient@example.test",subject="Decision",body="Recorded decision"},status=failed,result=null,error={code="rejected",message="Delivery rejected"}}`. It is test-only like finalized-file recipes: runtime generates owner/team/ID, validates operation result/error shape and allows no credentials, raw provider identity or arbitrary cross-owner association. Omitted status defaults pending with null result/error. A model snapshot can reference failed_notice; structural production assignment stays forbidden. Existing selector patches cannot mutate runtime observation subfields. Real user-call sequences observe newly queued pending associations; provider-result/handler fixtures remain isolated observations unless a future runner explicitly executes the trusted lifecycle. Do not claim an end-to-end provider test from these fixtures.

This is one type used by field/send forms, with an operation-resolved fixture recipe using the existing fixture grammar, not another app delivery model. Its parser/checker/runtime/migration/fixture support remains unimplemented. Existing authored examples are not silently deleted during eventual migration: translate pure notice-state assertions, retain all application-decision and late-current-ID assertions, and retain domain callback examples wherever reactions remain.

## Alternatives, consultation and uncertainty

Three equally developed choices were consulted: typed persistent receipt association; send-into/field-scoped completion sugar generating tracking slots; or retain explicit mirror fields/callbacks and only share UI/error rendering. The second removes more handwritten correlation but needs extra effects/hooks plus implicit storage/version semantics. The third minimizes language change and preserves explicit domain version updates, but continues duplicating authoritative transport state and can regress its current-attempt matching. The selected type avoids the second syntax family while removing only actual duplication; its cost is explicit type, lifetime, disclosure, observation and fixture rules.

Full independently rewritten requests/results are in `design/jev/delivery-association-20261004/`. All state/question/alternative prose was independently rewritten with the same facts and required outcomes; only code and choice identities are reused.

| Request | Typed association | Associated effect syntax | Explicit mirrors | Confidence |
| --- | ---: | ---: | ---: | ---: |
| 1 | .98 | .00 | .02 | .96 |
| 2 | .88 | .02 | .10 | .81 |
| 3 | .96 | .02 | .02 | .94 |

There is no winner disagreement. The second request gives retaining mirrors materially more probability; inspection confirms that explicit domain version changes and bespoke retention can matter. The decision therefore does not erase independently meaningful business evidence or callback effects and makes safe-summary retention explicit rather than assuming a seven-day receipt is sufficient forever. JEV supplies distributions without prose rationale; these explanations are our source-based analysis, not invented model quotes. No threshold authorizes the decision. Adoption/token improvements remain plausible, unmeasured; no runtime, provider test or compiler was implemented.


## Precise observation, fencing and test lowering

An association is an immutable handle to an immutable delivery identity, not a mutable JavaScript object whose status can change underneath an evaluation. Each read obtains one immutable observation `{id,status,result,error}` at the current owner checkpoint; a later checkpoint may see newer runtime evidence. Safe error values are complete validated objects or null, never a partly populated object. Incoming provider observations remain ordered/idempotent under the adapter contract; associating a reference does not define a new provider revision protocol. Pending/unknown/success distinctions remain transport observations, while any business acceptance/retry decision stays authored.

Every status/result/error read used by a guard, lock, query, invariant or business effect enrolls that receipt's runtime observation revision in the same owning transaction/read fence, even though the referring row.version does not change. An intervening receipt update invalidates/retries that evaluation under ordinary conflict rules. Snapshot receipt reads cannot silently authorize a commit based on superseded evidence. Pure display reads get the same consistent checkpoint semantics. Reading immutable id alone needs no mutable-status precondition. There is no universal domain-row write, hook or domain-version increment on delivery progress.

After result/error content expires, the handle and safe identity/status summary remain available for an associated retained row and replay obligations, but observation returns `result=null,error=null` for withheld contents. A succeeded summary can therefore remain succeeded without its old result. That is read-time redaction, not a schema-invalid incoming completion. UI must distinguish “succeeded; result unavailable” from pending or failed, without disclosing whether privacy or expiry caused withholding. Never reconstruct a PDF, reveal an old message, resend, or run a business callback simply to refill the observation. Retained result bytes and authorized existing domain attachments follow their own independently declared lifetime.

The current canonical desired JS read helper is `delivery(c, {record,field}, selectedProperties)`: it resolves the stored association from its protected owning record and static field, checks every selected property grant, returns an immutable selected observation (or an authorized null association) and registers mutable receipt revision dependencies. Possession of a detached handle is no alternate lookup authority. It is not a string-ID lookup, constructor, directory or provider call. A null-safe source projection lowers to a null check followed by this helper; `reference.id` remains the immutable correlation ID. For example:

```js
const notice = await delivery(c, {record: application, field: "notice"}, ["status"]);
const status = notice?.status ?? null;
```

The exact field metadata remains `{type:"delivery",operation:"grant.Mail.send",nullable:true}`; the operation key resolves to the already declared bound target and its result schema. It does not duplicate input/result fields. A collection predicate using mutable receipt status lowers through the same helper/owner query semantics, not untracked property access. `renderPage`/standard field presentation and MCP projections reuse this read/disclosure contract.

### Genuine isolated fixture witness

Operation-resolved fixture recipes provision runtime test receipts, not fictitious `DeliveryResult` values. The runner binds each recipe to the current isolated app/team/storage owner and declared adapter target, assigns stable identity/observation revision, and validates completion consistency. It never sends a network request or fabricates authorization for real file results; any file-valued test result must separately meet the existing finalized-file fixture provenance rules. Unknown fields, caller-supplied IDs/owners/revisions, invalid result schemas and inconsistent failed/null-error recipes are setup errors. Fixtures cannot cross owners through a matching text ID. The admitted test completion and recipe snapshot describe the same target; actual provider/handler execution is not inferred from recipe creation.

```can
fixture accepted_notice=Mail.send {request={to="recipient@example.test",subject="Mail received",body="Item available"},status=succeeded,result={reference="accepted-mail"},error=null}
fixture pending_notice=Mail.send {request={to="recipient@example.test",subject="Mail reminder",body="Item still available"}}
## Attached to Mail's explicit notice_result handler:
examples event={delivery_id=accepted_notice.id,status=succeeded,result={reference="accepted-mail"},error=null}
 parcel.notification,parcel.state -> parcel.state,parcel.notification.status
 accepted_notice,received -> notified,succeeded
 pending_notice,received -> received,pending
```

These are isolated callback cases: the first performs the real explicit received→notified handler effect against its current association; the second proves an old accepted attempt does not change the currently selected pending attempt. They do not claim a network send ran. A genuine user-call sequence exercising receive/decide additionally observes that its freshly produced association is pending and its business operation has committed; trusted completion cannot be inserted as an unauthorized user call.

Desired test target recipe metadata is `{delivery:"mailroom.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Mail received",body:"Item available"},status:"succeeded",result:{reference:"accepted-mail"},error:null})}` and `{delivery:"mailroom.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Mail reminder",body:"Item still available"}})}`. `delivery` is the test recipe discriminator, mutually exclusive with existing `model`/`user`/`file` recipe kinds; its value is the canonical resolved target, not an extra operation schema. Runner-provisioned `s.accepted_notice` is the typed handle. The completion input uses `s.accepted_notice.id`; observations read `await delivery(c,{record:s.parcel,field:"notification"},["status"])` under the same test inspection/checkpoint rules as other observations. Nothing here permits arbitrary production objects or test overrides of receipt internals.

The new type/read helper and operation-resolved fixture semantics are proposed together. Grammar additions are needed only for the `delivery(path)` type; the fixture spelling already fits `fixture name=path {fields}`. The existing syntax prototype does not implement the new type/checker and cannot execute this BDD contract. No runtime support or app migration is claimed.


Every delivery recipe requires `request={...}` with the named operation's complete normalized input shape (ordinary declared defaults may apply). There is no generic guessed request or universal empty Mail sample. Only request/status/result/error are authored recipe attributes. The runner validates request types, constraints and reference ownership against the exact pinned operation, provisions frozen final request content and its immutable digest, and derives the delivery owner from that isolated operation context. The request can contain only valid scoped fixture references; the recipe cannot set originating principal, grants, binding, owner, delivery ID or revision. It does not execute the application's send scenario or prove its business guards passed. A model association must belong to this same isolated storage owner, and every linked occurrence/request/result must match the configured capability target. In the Mail witness the explicit safe to/subject/body inputs are already final text, and the fixture runtime records the pinned app locale/release rather than fabricating another person's preferences. Status/result consistency and finalized file provenance are checked after request validation. This is genuine runtime test provisioning with a complete typed frozen request, not a status-only phantom send.


## Grant and Mail application witness

The draft application applies the shared association contract to Grant's `notice` and Mail's `notification`. Both preserve their existing notice-status UI columns through a read-only nullable `DeliveryResult.status` derive, not a stored transport mirror. Mail's existing recipient grant still names only that status projection; it does not gain association/result/error access. Grant's callback disappears; Mail retains only the current association ID plus successful non-null completion and received-state check before its explicit notified transition. No-request is null; no synthetic none delivery status is introduced.

Complete isolated Mail.send request recipes cover pending, succeeded, failed, unknown and skipped observations. Grant's admitted award_export tables preserve submitted state or approved evidence, exact amount, export count and budget while a detached accepted/failed attempt cannot replace the current pending association. Mail's handler tables preserve current-versus-stale correlation, no association and collected custody. These fixture snapshots do not prove that an earlier provider call occurred. Existing genuine business sequences enqueue normally and inspect the pending typed receipt via the canonical record/field/selected-property lookup.

Focused checks: both desired targets pass node --check and whitespace checks. Source scenario-body comparison isolates Grant decide/callback removal and Mail receive/match/remind/completion; other business bodies remain unchanged. The initial parser rejects delivery(Target), and sequences remain unsupported. A temporary compatibility projection replacing delivery types with text and removing four Grant/one Mail sequences parses after replacing the new enum-derived structured caption with a scalar caption; this checks only surrounding table/declaration syntax, not the proposed types or runtime behavior. Preserving Mail's existing per-case labels requires enum-derived fields to accept the same structured caption/value presentation as stored enum fields; this narrow shared grammar clarification is handed to the coordinator. No compiler/library/provider/provisioning implementation or workflow execution is claimed.

Current Mail recipient policy explicitly includes `notification.status` as the readable dependency of its separately granted status derive. It grants no handle identity/result/error. Derived enum/bool fields reuse the existing checked caption/value label map; the older scalar-only prototype is disclosed rather than used to drop authored status captions. The refined locator helper also handles stored ID correlation, while provisioned receipt IDs remain usable in isolated trusted callback input setup.
