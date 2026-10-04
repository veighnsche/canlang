# CanChat

CanChat gives company members a private, retained assistant conversation. The `.can` file is the application contract; `.mjs` is handwritten desired JavaScript under DESIGN §13. The compiler, standard adapters, renderer and BDD runner are not implemented. Syntax checks do not establish working inference.

## Complete member workflow

An AI administrator creates immutable model/policy profiles and one token allowance per member. Profiles specify a configured provider key, system policy revision, input/output token ceilings and maximum duration. The administrator can disable a profile or allowance and adjust the allowance ceiling/concurrency, but cannot read a member's conversations through the administrator role. Changing model policy means creating another profile, preserving old run evidence.

A member opens a titled conversation and its original branch, writes a message and optionally attaches up to eight finalized readable files through the shared upload flow. Sending freezes the complete ordered branch prefix and turns, system policy, profile, attachments and limits. History is never silently truncated. A branch can have one unresolved execution at a time; fewer than 120 prior messages enter a new request, and shared request/input-token limits also apply. Unsupported attachment kinds/model features fail explicitly at the binding.

The ordinary outbox submission returns an admitted business run with a pending receipt. Its generation state stays null until a verified progress snapshot exists; it does not guess that the provider queued the work. The page polls an authorized retained snapshot every second and displays escaped cumulative text and distinct generation/delivery states. Reopening the page reads that same run; it never resubmits. Browser disconnection is neither cancellation nor evidence of completion. Private model reasoning is excluded from the display contract.

Generation protocol identity, sequence checks and the current snapshot belong to the first-class `delivery(LLM.generate).progress`. One `LLM.generate.progressed` callback owns only allowance settlement, concurrency release and the unique final assistant turn. A failed callback rolls back those business writes while verified progress stays observable. Technical failures use durable retry; a business-rule failure remains visible, and an explicit successful reconcile can notify the same current snapshot again after the cause is resolved. Reconciliation does not require a fabricated new provider sequence.

A stop action sends a targeted external cancellation command and shows its receipt independently. Requested stop, confirmed cancellation, a failure and an unknown outcome are different facts. A success racing stop remains successful. The member can reconcile the same retained source/revision; reconciliation cannot create a replacement inference. Only an authoritative skipped, never-dispatched generation receipt permits local zero-usage release.

Regenerating a completed/failed/cancelled user turn creates a separate branch containing the preceding frozen prefix, then calls the same canonical send operation with the selected prompt. It cannot overwrite an original turn or silently retry an uncertain invocation. Branches remain visible independently; a late result belongs only to its own branch. Completed assistant turns are appended once per run and remain immutable.

## Access, revocation and resource accounting

Conversation ownership and current team membership gate branches, message content, attachments and partial output. Another account cannot use an ID as a grant. A conversation revoke immediately removes those readable projections and rechecks pending dispatch; it also requests cancellation for the bounded currently active runs. Membership removal triggers the same targeted stop requests, rechecking current membership so a delayed removal event cannot cancel newly authorized work after rejoining. Already-running external work may still complete; trusted callbacks can settle accounting while content stays unreadable.

The allowance tracks `spent`, `held` and `running`. Admission atomically reserves `input_tokens + output_tokens` and a concurrency slot before creating an outbox send. The owner revision fence serializes racing admissions. Authoritative total usage settles the full hold once; terminal execution releases its concurrency slot once. A terminal cancellation without authoritative usage retains the hold. Unknown runs keep both resources until execution evidence changes. The shared progress layer ignores duplicate/older observations and rejects identity/payload conflicts and terminal regressions. Nonterminal snapshots have null usage; only a later previously-null usage settlement may amend a terminal snapshot.

These are enforceable resource caps, not invented currency prices. A native/provider binding must enforce the declared token and duration limits or reject before starting. A hard monetary ceiling needs a separate supported pricing contract. The owner can see safe unresolved status/usage after conversation revocation; they cannot read revoked transcript content through recovery. Provider diagnostics must omit private prompt/file content.

The maximum of ten simultaneous runs is an explicit app concurrency policy and the proof for the cancellation loops' bound. There is no truncation of an unbounded population, arbitrary cohort cap or dependency on the unresolved C1 fanout proposal. Long-term history is subject to the shared work/query limits and fails visibly when exceeded.

## Pages and composition

- Conversations: new-conversation form, private conversation/branch drawers, ordered plain-text turns, finalized attachments, live partial status, send/regenerate/stop/reconcile controls and allowance summary.
- Unresolved usage: safe run status and recovery controls, including after transcript revocation.
- AI access and limits: immutable profile creation, activation and per-member resource allowance administration.

All forms invoke the canonical operations under current authority. The shared UI owns shell, accessibility, focus/draft preservation, loading/error states, file authorization and polling. Captions use inline English/Dutch localization and shared field defaults.

`CanChat` selects `[chat]`. It exports only the declarations required by composition, including `Conversation`, `Branch`, `Turn`, `can_use`, `transcript` and `ask`. `CanCreative` adds explicit user-requested image generation from readable turns. The model does not invoke arbitrary tools or confer authorization. CanGallery can separately publish reviewed image attachments without exposing chat history.

## Behavior evidence

Inline `.can` examples and corresponding `.mjs` fixture recipes cover exact-budget admission, over-budget rejection, concurrency, another account, an actual send→stop→revoke sequence, succeeded/running/unknown/cancelled/failed observations, one-time usage settlement, unrelated original receipts, delayed terminal usage settlement, separate branch creation and current membership after a delayed removal event. The sequence reloads a run after mutation; immutable earlier result bindings are not treated as live records.

Required shared-runtime/provider acceptance cases remain explicit:

| Trigger | Required result |
|---|---|
| Two admissions race at the final allowance units | One commits; the other observes the new balance and rejects, with no orphan send. |
| Browser disconnects during NDJSON generation | Controller continues/reconciles independently; reconnect reads the same retained identity. |
| Mid-stream HTTP-200 error | Retain partial text as incomplete; do not create a completed assistant turn. |
| Stop races final success | Preserve authenticated final success and usage; no forced cancelled overwrite. |
| Same event or operation is retried | No duplicate assistant turn, reservation or settlement. |
| Revoked member requests page, partial response or original file | Deny or withhold current content; old URLs grant no access. |
| Final business callback fails, then its cause is repaired and reconcile returns the same sequence | Retained progress remains visible; re-notification commits one final turn and one settlement. |
| Delayed removal event arrives after the account rejoins | Current membership prevents cancellation of newly authorized runs. |
| Provider restart loses unobserved output | Report unknown; do not claim token-resume support or invent a fresh inference. |
| Finalized foreign/unreadable file or unsupported attachment | Reject attachment/admission or return the explicit supported binding failure; never send a raw URL. |

These are requirements, not claims of executed tests. The shared lifecycle decision and both complete three-call JEV rounds are recorded in [chat-media design](../design/complex-apps/chat-media.md).
