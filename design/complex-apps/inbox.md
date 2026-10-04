# CanInbox — departmental intake, typed judgment and reviewed replies

2026-10-04. Owner: Astra. Actual app triplet ownership released by root. Root owns adoption into DESIGN/GRAMMAR and the standard catalog. Root accepted the focused judgment/type/lowering and MailboxV1 contracts for this draft round. The sections below are accepted draft contracts; app review and all compiler/runtime implementation remain outstanding.

## Product decision

Receive provider-authenticated mailbox events into a configured intake queue. Preserve immutable message evidence, bounded finalized attachments and explicit incomplete-content flags. A classification run freezes a minimized subject/body-only state and its complete question specification. It asks three independent questions: whether a reply is requested (NOUL), the responsible department (choice), and urgency against ordered criteria (score). Store all probabilities and the exact model/specification/usage, not merely the winner.

Classification prepares an attributed review; it does not change read grants. Authorized intake staff choose the destination from that mailbox's explicitly allowed queues, record their urgency/reply decision and explanation, and can later correct it without rewriting the original model result. Queue assignment changes visibility, so current source-queue routing permission is rechecked at each move. No universal confidence cutoff or claim of calibrated automation is introduced. Staff can still route/respond manually when classification is unavailable, malformed or pending; a late result cannot undo their decision.

Reply drafting is separate from sending. An authorized queue member writes/reviews the exact recipient, subject, body and permitted attachments before an explicit submit. Sending freezes them. Mail provider acceptance is not recipient delivery. Failed transport and uncertain provider outcomes remain unresolved until authoritative reconciliation; no new send is hidden behind a “retry” label. A proven not-sent reply may be resubmitted with its original logical source and frozen payload. Inbound content and model text cannot authorize mutations, alter policy or execute instructions.

## Source comparison and accepted judgment construct

The ordinary-contract alternative needs shared `JudgmentSpec` arrays, explicit IDs, option objects, answer lookups and nullable narrowing. Its result choices are text unless the app authors another enum and validates/converts it. [The same-content source comparison](../jev/complex-inbox-20261004/authoring-comparison.md) uses the **actual Inbox English instructions and every criterion verbatim** in both alternatives, excluding Dutch presentation variants symmetrically: the compact declaration is 863 UTF-8 bytes; the generic specification literal is 1159 (296 fewer, 25.5%). These are bytes, not measured model tokens. The generic count excludes its additional Queue/Review enums, result lookups/narrowing and content-revision/interface plumbing, so it understates that alternative's total authoring cost.

Select the following focused declaration because it removes repeated option/rubric structures **and** retains literal types. It is not selected merely to avoid or prefer new grammar:

```can
package inbox
 use inbox {Triage as Judge} from=deployment.judgment
 Given
  export judgment Triage version=1
   reply noul "Does the sender request a reply or action?" yes="A response or action is requested" no="Informational mail with no requested response or action"
   route choice "Which department owns the request?" {purchasing="Supplier orders, invoices or procurement",support="Existing service problems or assistance",sales="Prospective purchases, pricing or proposals",other="Unrelated, ambiguous or multiple departments"}
   urgency score "How urgently is action required?" [routine="Routine follow-up",today="Same-day action",immediate="Immediate operational disruption"]
  Queue { name:text, kind:Triage.route.choice }
  Assessment { input:text, specification:JudgmentSpec, result:Triage?, request:delivery(Judge.evaluate)? }
 When
  ## Inside an ordinary authorized scenario's do:
  ## create Assessment {input=state,specification=Triage.specification} as assessment
  ## send Judge.evaluate {state} as request
  ## set assessment {request}
 Then
```

This is the accepted new declaration for the draft round, not a claim of current parser support. Real source will localize user-facing strings inline. The instruction descriptors above are source-owned model instructions; ordinary attached `#` prose remains documentation and is never silently sent to the model.

### Accepted minimal declaration/typing contract

`[export] judgment NAME version=INTEGER` is a Given declaration with a nonempty suite. Each child has a unique name and exactly one shape: `NAME noul caption [yes=caption no=caption]`, `NAME choice caption {NAME=caption,...}`, or `NAME score caption [NAME=caption,...]`. NOUL criteria are both present or both omitted. `caption` is the existing static string/message descriptor form, including inline locale variants or a resolved zero-parameter message. Score entries form an ordered named list, not a map; insertion order is semantic. Duplicate question/option/level names and empty captions fail checking. Nested questions, runtime spec edits, arbitrary JSON or executable model callbacks are absent.

The name simultaneously owns a versioned *derived evaluation interface* and its generated structural result type. A bound import aliases the interface exactly like a capability. The sole generated operation is `evaluate(state:text)->NAME`; state is bounded to 40,000 Unicode scalars. The bound declaration has a provider-independent specification fixed by source. Invocation uses ordinary `send`/`delivery`/completion, with no new effect. `NAME.specification` is the one generated immutable `std.JudgmentSpec` constant; it is a pure source asset, not a provider request. `NAME.<choice-question>.choice` names the generated literal enum. `NAME.<score-question>.level` names the generated ordered level enum for human review fields. These associated enum names are explicit checker-generated type paths; score results do not claim to have a selected-level field.

Generated result: `{specification_revision:text,model:text,input_tokens:int,output_tokens:int,<question-name>:answer,...}`. NOUL answer is `{probability:decimal[0,1]}`. Choice answer is `{choice:<literal enum>,probabilities:{option:<same enum>,probability:decimal[0,1]}[]!,confidence:decimal[0,1]}`. Score answer is `{score:decimal[0,N-1],levels:{level:<ordered enum>,index:int[0,N-1],description:text,probability:decimal[0,1]}[]!,confidence:decimal[0,1]}`. There is no NOUL confidence, rounded score, invented automatic winner for score, or generic text category.

`std.JudgmentSpec` is the shared retained normalized specification, not something each app declares:

```can
contract JudgmentOption { id:text, description:text }
contract NoulQuestion { id:text, instructions:text, yes:text?, no:text? }
contract ChoiceQuestion { id:text, instructions:text, options:JudgmentOption[]! }
contract ScoreQuestion { id:text, instructions:text, levels:JudgmentOption[]! }
contract JudgmentSpec { declaration:text, version:int, revision:text, language:locale, noul:NoulQuestion[]!, choice:ChoiceQuestion[]!, score:ScoreQuestion[]! }
```

These are catalog shape witnesses, not app-authored duplicate declarations. The compiler derives `revision` from canonical declaration identity/version, question kinds, source-language rendered instruction/criteria values and ordered IDs. Default model instructions freeze the owning source language; display localization does not alter inference. The serialized source-language specification is available without executing `format` on provider data. No model name is baked into the rubric; the binding selects an actual compatible provider/model and the result records what ran.

Portable v1 bounds: 1–32 total questions; 2–26 choice options; 2–10 score levels; at most 2,000 scalars per instruction/criterion and at most 24,000 combined specification scalars. These are Can's accepted pinned adapter-profile limits within the documented common provider subset, not vendor universal maxima. Names are ordinary source identifiers. Context plus specification must fit the configured model budget; fail before provider invocation when it does not. Larger vendor-specific capacity requires an explicitly revised interface; never truncate a question, criterion or state silently.

At admission/finalization, require every requested question once and no extras, exact kinds and option/level identities, finite decimal values within range, nonnegative integer usage, and a nonempty actual model identity. Parse wire decimal lexemes with exact decimal conversion; reject more precision/range than the canonical decimal representation rather than rounding meaning silently. Each distribution sum and score expectation may differ by at most decimal `0.000001` from 1/the weighted zero-based index. The selected choice must be one of the maxima within that same tolerance; preserve a vendor's valid tied choice. Every score index/order/description must match the causal frozen spec. Store normalized source descriptions, not model-invented legends. Validate confidence range, preserve its provider-reported value and identify the actual model; do not claim confidence is calibrated or interchangeable between models.

The adapter copies `specification_revision` from its actual frozen request only after validating the answer against it. A caller-provided revision cannot validate a mismatched result. Missing/invalid/partial answers make the delivery failed, retaining safe diagnostics; they are not successful empty judgments. No app callback runs with an invalid result. The actual provider may be TypeSafe or a compatible configured Ollama decision model; absence of the required feature or capacity fails binding validation. A chat endpoint is not silently substituted.

Compatible wording edits retain old saved specs/results. Changes to choice IDs, ordered level identity/order or generated schema need normal interface/schema migration and outstanding-work checks. The construct grants no new read authority and does not install the provider's executable owner.

### Accepted desired JS lowering

`appDefinition.judgments["inbox.Triage"]` holds `{version:1n,questions:[...]}` in source question order. Each question has `{name,kind,instructions}`; `instructions` and criteria use existing `message(...)` descriptors. NOUL optionally has `{yes,no}`; choice has `options:[{id,description}]`; score has `levels:[{id,description}]`. The compiler/linker derives generated schemas, retained specification and evaluate signature from this **single descriptor**. Do not hand-author a second per-option schema in `.mjs`.

`appDefinition.bindings["inbox.Judge"] = {judgment:"inbox.Triage",from:"deployment.judgment"}` distinguishes the derived interface from an arbitrary capability. All stored/input/result schema type references are canonical strings, including `"inbox.Triage"`, `"inbox.Triage.route.choice"`, `"inbox.Triage.urgency.level"`, `"std.JudgmentSpec"`, and existing delivery metadata. The ordinary send lowering is `send(c,"inbox.Judge.evaluate",{state})`. One accepted draft pure standard helper, `judgmentSpecification(c,"inbox.Triage")`, returns the immutable normalized specification for the invocation's pinned source contract. It performs no network/record read, mutation, dynamic compilation or language-string interpretation and must agree with the send's pinned contract. Its output is detached immutable value data suitable for storing; it grants no privilege. This helper is the exact lowering of the generated source constant, not an app-specific wrapper. Generated structural element schema IDs use the canonical derived paths `inbox.Triage.route.probabilities.item` and `inbox.Triage.urgency.levels.item`. They come from the same descriptor, never parallel authored schemas. The shared UI collection-value props are `items` plus optional `contract` for typed arrays across table/list/gallery; Inbox uses `table({items,contract,columns})` and `list({items,model,renderRow})` for its permitted Queue references. Root intentionally consolidated this convention while normalizing earlier Feedback targets.

## Accepted Mailbox interface

Reuse ordinary capabilities; no mail grammar is needed. One accepted draft standard interface supplies normalized inbound events and recoverable reviewed replies:

```can
contract IncomingEmail { mailbox:text min=1 max=200, source:text min=1 max=1000, thread:text? max=1000, sender:email, reply_to:email?, subject:text max=300, body:text max=30000, body_complete:bool, attachments:file[]!, attachment_count:int min=0, attachments_complete:bool, received:datetime }
contract MailReply { source:text min=1 max=1000, mailbox:IncomingEmail.mailbox, message:IncomingEmail.source, to:email, subject:text max=300, body:text max=30000, attachments:file[]! }
contract MailReplyOutcome { source:MailReply.source, state:enum(accepted,not_sent,unknown), reference:text?, detail:text? }
capability MailboxV1 version=1
 reply(value:MailReply) -> MailReplyOutcome
 reconcile(source:MailReply.source) -> MailReplyOutcome
 event received { value:IncomingEmail }
```

The deployment maps exact mailbox keys to the receiving app/team and authorized sender account. Incoming `source` is stable per mailbox across duplicate notifications and moves; preserve provider immutable IDs when supported. `thread` is advisory correlation, never authorization or automatic merging. Sender/from/reply-to are message evidence, not authenticated customer/account claims. Normalize one reply address or null; outgoing replies remain pinned to the inbound message and its reviewed normalized address. No caller-controlled SMTP server, sender credential, destination URL or mailbox-account substitution is permitted.

Parse MIME/sanitize to plain text in the shared adapter; never execute HTML, follow remote image URLs or give attachment text instructions authority. App file policy is 5 MiB each, PDF/PNG/JPEG/plain text, at most eight attached files (thus at most 40 MiB retained payload per message/reply). Validate bytes and finalize files under DESIGN §8 before admitting them. Record the original attachment count and completeness when unsupported/excess/unavailable attachments are withheld; do not pretend classification read them. Long bodies can be explicitly bounded only with `body_complete=false`; exact event identity/digest must remain stable. A provider file URL is not a file value. Provider event auth/dedupe/finalization failures remain visible operator ingress failures, not successful empty mail.

Reply outcomes are transport/business facts: `accepted` means provider accepted the exact message for sending, with a nonnull stable reference; it does not promise delivery/read. `not_sent` requires authoritative evidence that this logical source has not been sent and that an earlier uncertain request cannot later send. `unknown` has no such proof. A failed delivery result, missing message or timed-out Graph call is not `not_sent`. Adapter retains the frozen source/body/recipient/attachments and rejects changed payload reuse. Its reconcile never resends. A resend after proven `not_sent` uses the same logical source and frozen request; `accepted` is idempotently returned once observed. Unsupported provider certainty remains unknown, requiring operator resolution outside automatic resend.

Graph's documented create-reply draft plus explicit send provides a concrete possible adapter mechanism, but HTTP 202 is acceptance only and does not prove recipient delivery or close every crash boundary. Persist exact draft/immutable message correlation before sending; a lost response remains unknown until authoritative evidence resolves it. This is an accepted draft adapter contract, not an assertion that Graph or SMTP provides end-to-end exactly-once delivery.

## Research and consultation evidence

Verified official sources: [TypeSafe API](https://docs.typesafe.ai/api), [NOUL](https://docs.typesafe.ai/primitives/noul), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [confidence](https://docs.typesafe.ai/confidence), [Ollama System One](https://docs.ollama.com/api/systemone), [Ollama decisions](https://docs.ollama.com/capabilities/decision), [Graph createReply](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0), [Graph send](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0), and [postal-mime](https://github.com/postalsys/postal-mime). These establish provider slices, not our implementation or installed model availability.

Three independently reworded equivalent generic design requests were approved and completed, saved in [the evidence directory](../jev/complex-inbox-20261004/). All supplied the same public API facts, general typed-language capabilities, three-question workflow, privacy boundary and lack of calibration. No private code, project names, dependency graph or actual email was sent. This was a new judgment-design comparison, not a resend or rewording of the previously rejected C3 dependency export. The latter remains blocked.

| Question | Request 1 | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Derived declaration | 0.87 (confidence 0.81) | 0.93 (0.90) | 0.83 (0.74) |
| Standard generic arrays | 0.02 | 0.02 | 0.01 |
| Bespoke repeated schemas | 0.11 | 0.05 | 0.16 |
| Reviewed visibility transfer | 1.00 | 1.00 | 1.00 |
| Threshold-driven visibility transfer | 0.00 | 0.00 | 0.00 |

All responses used `jev-1.13.0`. This is advice on the balanced abstract tradeoff, **not proof of the exact proposed grammar, generated types or app's correctness**. The lower third confidence and 0.16 bespoke-schema probability preserve implementation-cost uncertainty; source witnesses and root review settle the concrete boundary. JEV was not used as a researcher or a substitute for vendor documentation.

## Completed app draft and focused checks

The complete [requirements](../../draft/CanInbox.md), [Can source](../../draft/CanInbox.can) and [desired JavaScript](../../draft/CanInbox.mjs) now implement the bounded design: ten models, thirteen scenarios, two pages, twenty-one isolated fixtures, forty-two table rows and one three-call shared-state transfer/correction sequence. Actual source uses `general` for the residual department case, avoiding collision with the built-in `other` test account. Result schemas remain generated from the one descriptor.

The focused source/target review corrected trusted handler envelopes, canonical sequence metadata, explicit role-array metadata, full source descriptions, safe nullable observations, typed-array `items` UI props and limited mailbox context for already-held work after future destination changes. Review covered queue transfer authority, late assessments, attachment admission, quota reservation, frozen reply identity, terminal recovery facts and disabled-provider continuity. [Verification](../jev/complex-inbox-20261004/verification.md) preserves commands, actual results, static scope counts and hashes.

`node --check` passes. Ordinary Can syntax passes an explicit projection that excludes the unsupported judgment declaration, replaces typed delivery fields only for syntax, removes the sequence block and omits page polling. Full source intentionally stops at the new judgment declaration in the current parser. No checker, BDD runner, UI/provider/adapter execution or production implementation is claimed. The source examples remain the intended behavior contract; protected receipt fixtures cannot prove real provider certainty or concurrency. Root owns final acceptance and shared integration. No remaining new app policy decision is delegated to Muse.
