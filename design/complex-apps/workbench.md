# CanWorkbench — exact approved business invocations

The concrete first workflow is a staff member's bounded task-triage/follow-up session at one workplace. The worker selects at most ten readable `todo.Task` records and a named purpose, requests one AI suggestion at a time, sees the complete proposed update/completion and either approves, rejects or stops. The owning Task operations remain authoritative. This draft intentionally uses real user-driven continue/approve calls; a trusted model callback cannot become the saved worker or perform a business mutation.

## Verified boundaries

`CanDo.can` exports Task. Generated Task.update admits members with `staff(actor)` and current `can_work` for the candidate's location; fields are location/title/description/due/priority/assignee. `complete(task)` admits members with the same work guards and not-done condition; its only effect sets done/completed_by/completed_at. The coordinator is adding only its export modifier, with no signature/body change. Workbench imports `use todo {Task,complete}` and never writes Task directly. It uses its own small read scenario to return currently viewer-readable, selected tasks; this is a business context projection, not a copied mutation input schema.

DESIGN §2.1 action values currently bind records but leave nonrecord inputs for later forms and reject conversion from model JSON. They cannot by themselves represent an immutable complete heterogeneous proposal. Existing typed capability sends, associated deliveries, read scenarios, locks, exact versions and same-principal local call remain the rest of the solution.

Official [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) shows generated names/arguments handled by the host and results supplied in a later turn. [Structured output](https://docs.ollama.com/capabilities/structured-outputs) supplies constrained schemas and still requires validation. Neither mechanism confers Can authority. No live inference or provider behavior has been tested.

## Comparison and advice

Three independently reworded complete briefs/replies are saved in [complex-workbench evidence](../jev/complex-workbench-20261004). A first ordinary sandbox connection failed without sending a successful request; the subsequent normal reviewed endpoint call and the two other calls succeeded. No previously rejected private payload was used.

| Request | Explicit variants/dispatch | Full invocation value | Toolset/lifecycle declaration | Confidence |
| --- | ---: | ---: | ---: | ---: |
| 1 | .06 | .79 | .15 | .68 |
| 2 | .07 | .87 | .06 | .81 |
| 3 | .03 | .93 | .04 | .89 |

All selected invocation, but these are advisory probabilities, not a correctness test. The broader toolset remained strongest alternative in one wording; investigate its actual benefit: it can absorb repeated continuation/persistence, whereas this one-at-a-time user-driven app already needs explicit company approval and current context refresh. It would add a larger lifecycle without eliminating the company's choices. Explicit variants remain viable for a single fixed operation, but duplicating update's changes schema and a second completion branch is precisely the avoidable correspondence burden here. No measured token/performance advantage is claimed.

## Full invocation contract

`invocation(Operation,...)` is a closed structural value type over statically declared local enabled user mutations. A complete value contains one canonical target/interface revision, all normalized business arguments and every protected record identity/expected version, including references nested in structured arguments. It is not code, an action form with missing inputs, approval or authority. Read operations, trusted handlers, arbitrary names and remote targets are excluded in this initial boundary; ordinary existing read scenarios supply context.

`invocation(Operation,{arguments})` constructs a singleton value from the owner's complete input schema. Required arguments must exist, unknown fields reject, ordinary defaults resolve once and every record reference captures its expected version. Omission of an optional update field stays omission; explicit null remains a change. No partial-input editing, string/JSON cast or mutable target/argument property is exposed. A new proposal creates a new value. Scalar constraints, exact numeric values, file provenance and recursive reference validity are inherited from the owner declaration; no input DTO is copied into the consumer.

A declared capability result may contain this type. The shared adapter derives its finite provider schema from the type's owning operations. Before publishing a successful typed result it validates the selected target, full normalized arguments and every protected record/user/file reference against **the originating request's frozen authorized reference set**. For records, identity and expected version must match that request exactly; nesting does not evade this check. User/file references must likewise have appeared as authorized typed references in that request. Raw matching text is not a reference. No output may invent a record, upgrade a version, attach an unprovided file or introduce another principal. An incompatible interface revision, missing required input, unknown tool, unauthorized reference or malformed/truncated result fails typed completion rather than becoming an invocable value. This grants no provider permission to read additional data. A deployment adapter translates opaque request-local reference tokens; arbitrary provider IDs are never trusted Can references.

The authorized reference set is frozen by the normal send admission from the actual request's typed inputs and current disclosure/file checks. It does not grant ongoing delegation, and the callback remains a trusted completion handler with no human actor. The exact originating request association and schema revision supply provenance; app-authored requester fields cannot forge it. Local constructors/isolated fixtures use their own real admission/test context, never a fake successful provider call.

`call value {}` consumes a full invocation without additional or replaced arguments through the existing canonical registry, current caller/team, ownership/lifetime/version, file, by/when/invariant/lock and transaction rules. It inherits the **actual calling operation's actor**, never the user named in a stored run. A callback with no human actor cannot turn an invocation into that person's call. The target can return its ordinary result when a statically compatible result type is available; a heterogeneous invocation may discard its result by omitting `as`. The workbench records applied only after the local owning mutation and approval record commit atomically. A failure leaves proposal/approval domain state unchanged and exposes the ordinary safe operation receipt; retry does not silently substitute current versions.

Generic typed field presentation renders the canonical operation caption plus every effective argument and frozen reference version as escaped read-only data. Omitted versus null update fields are distinguished. It adds no execute control: the app's approve scenario owns that control. Current disclosure still applies; if a complete preview cannot be shown, the generated approval form is unavailable. Browser and MCP return the same structured value and invoke the same approve operation; neither can replace its arguments. There is no automatically privileged or background tool executor.

Desired metadata is `{type:"invocation",operations:["todo.Task.update","todo.complete"]}`. A local constructor lowers to `invocation(c,"todo.Task.update",{record,changes})`; ordinary invocation lowers to `call(c,storedValue,{})`. Capability schema extraction/normalization uses that one descriptor, not per-app decode switches. The canonical exported owner operation remains an identity constant. The new helper/type/renderer validation are proposed shared contracts, not implemented here.

## Minimal source witness

```can
use todo {Task,complete}
contract Proposal {summary:text,call:invocation(Task.update,complete)?}
Step in Run {proposal:Proposal?,applied:bool=false}
lock Step fields=proposal when=row.proposal!=null
scenario approve(step:Step) by=members
 require step.parent.account==actor and not step.parent.stopped and not step.applied
 require step.proposal!=null and step.proposal.call!=null
 do
  ## Actual app additionally refreshes authorized context and compares each frozen version.
  call step.proposal.call {}
  set step {applied=true}
```

The full app must freeze at most ten readable facts and their explicit versions, impose one outstanding model attempt and at most eight steps/2,000 output tokens each, refresh those facts through a read scenario on approval, and retain stopped/failed/late attempts. It cannot execute from the completion callback. A canceled in-flight request may still cost resources; no provider cancellation/refund is inferred. Retained receipts support reconnect without resending. A stale/failed proposal can be rejected, followed by a fresh user-requested step under current authority. Prior effects stay committed; stopping is not compensation.

## Required fixture/BDD semantics

An isolated successful planner receipt uses the ordinary typed request recipe and a result constructed with `invocation(Task.update,{record=task,changes={...}})`. The fixture must include that same task/version in its frozen authorized request. Unknown targets, mismatched versions, unprovided records/files, callback/receipt mismatch and mixed-principal references are invalid setup, not successful error assertions. The recipe does not prove a provider ran or a user approved.

A connected user sequence can seed a pending proposal value, call approve as its worker, verify Task's actual owner effect and approval evidence, and deny a second new approval. Another sequence calls real Task.update after proposal creation and then expects conflict or the app's explicit stale-context rejection from approve; it must not patch fixture versions. Revoked work eligibility is tested with an actual imported Employee deactivate when available, or honestly as isolated admission snapshots. Scope loss must also withhold cached copied task context, not merely hide the apply button. No BDD result is execution evidence until an actual runner exists.

## Applied app and focused checks

The accepted boundary is exercised in [CanWorkbench.can](../../draft/CanWorkbench.can), [requirements](../../draft/CanWorkbench.md) and [desired JavaScript](../../draft/CanWorkbench.mjs). Only the canonical Task.update and exported todo.complete are allowed. Full owner schemas remain derived; Fact is a deliberately smaller readable context projection, not a copied mutation DTO. Input freezes source-owned planning instructions, ten bounded task facts, current worker/workplace references, prior step summaries, 32,768 input-token and 2,000 output-token ceilings. There is no file input or other-user reference in this first scope.

The production path creates proposals only through validated typed planner completions. Approve refreshes the entire authorized task projection, checks all captured Task versions and the workplace version, verifies current worker/work eligibility, and calls the stored invocation with the real caller. A post-call workplace condition makes a generic location-moving update roll back atomically in this narrower named workflow. The app's cached-context policy is deliberately stricter than ordinary Task history: any moved/archived selected task or revoked workplace eligibility withholds full old context/proposals. Safe owner status remains readable for stop/reconnect.

Focused checks: node --check passes; static metadata inspection finds every user operation's handler and matching source/target stored field names and user-operation identities. Seven isolated tables contain fourteen rows, and seven connected sequences cover actual owner update/completion, duplicate approval, a real intervening Task update, Employee deactivation plus a denied context read, reject→next→stop, stop-before-approval, and stop after an actual Task move denies context/next/approval. A valid location-moving proposal additionally specifies full transaction rollback. The fixture graph contains no simultaneously seeded ordinal-1 sibling conflicts; each example seeds only its own recipe closure. These are authored expectations, not executed BDD results.

The full source reaches unsupported invocation types in the initial parser. A temporary projection replacing invocation/delivery types and invocation constructor expressions, removing unsupported poll metadata and omitting sequence suites parses successfully. That projection checks only remaining syntax, not full grammar/type semantics or original business behavior. No compiler, stdlib, provider, renderer, canonical module linker, BDD runner or concurrency test was implemented or executed. In particular there is no existing CanDo.mjs implementation behind the proposed ./todo.mjs import.

Negative setup obligations remain explicit: unknown or disabled target, incompatible interface revision, changed/unprovided record or user, unprovided file, missing argument, altered frozen version, and inconsistent receipt/result must fail normalization/setup, never pass as an app error example. Model output cannot populate arbitrary IDs or a caller field. Runtime tests must still establish reference-set validation, full-preview withholding in browser/MCP, atomic cross-owner rollback, authority/version fencing, late completion and replay. Inspection assertions after deactivation prove only desired unchanged domain state; the separately denied canonical context read is the actual authored access check.

Independent final correspondence review corrected the missing `std.DeliveryResult` source import, model-local `derived` metadata plus the callable `derives` registry, `requiredArray` markers, complete result descriptors, canonical action spelling, and explicit seeds folded into the one `dependencies` field. Page children use the shared deferred builder. The redundant viewer-mode eligibility card guard was removed: its evaluation could demand hidden Run location/targets after scope loss, defeating safe-status recovery. Existing field grants now withhold private cells directly while canonical operation guards retain current authority. This introduces no privileged display helper or new shared primitive. The extra connected sequence specifies business recovery after a real scope change; renderer withholding remains a runtime verification obligation.

[Final static evidence](../jev/complex-workbench-20261004/final-verification.json) records passing JavaScript syntax, twenty resolved handler/rule references, matching source/target inventories, and passing supported-syntax projection. The full source remains unsupported by the unchanged prototype at `invocation(...)`. The [descriptor inspection](../jev/complex-workbench-20261004/final-descriptor-review.cjs) is repeatable and executes no business body or example.
