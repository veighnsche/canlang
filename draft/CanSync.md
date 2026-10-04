# CanSync

## Purpose and Adoption Goal

A sales-operations department keeps selected **existing Salesforce Account** details accurate without adopting a general integration platform. Staff review corrections to account name, phone and website; the app protects unrelated remote edits and retains the evidence for every attempted write. One linked account is independently usable even when another account needs investigation. This replaces a bounded departmental synchronization workflow, not the whole CRM or an unrestricted ETL service.

## Users and Permissions

Operators link accounts, set refresh intervals, prepare corrections and pause/resume. Reviewers inspect the same team records, refresh, approve, rebase and close proposals. The person who submitted a correction cannot approve or close it, even with both roles. Dispatch rechecks the submitter's operator role, approving reviewer's role, enabled link and selected proposal. Imported remote records do not grant membership or roles. Browser and MCP invoke the same canonical operations.

A recurring read runs under the original link owner's continuing operator authority; losing it stops subsequent recurrence. An enabled link whose owner loses authority can still be inspected and paused. It cannot resume until that owner again has the role. Reassigning ownership and bulk population management are outside this bounded workflow; deleting/recreating the same remote ID cannot evade unresolved writes.

## Data and Ownership

The provider owns account identity/existence and the opaque conditional-write revision. A Link owns enabled state, interval, timer epoch, current/latest read references and at most one pending Proposal. Unique remote identity is scoped to the current team and configured provider binding. A ReadAttempt retains its protected delivery and complete successful observation. Proposal freezes the provider baseline, complete desired projection and submitting person; its approval and explanations remain attributed. A WriteAttempt freezes the exact baseline/value used for each conditional mutation. No generic model CRUD edits or deletes this evidence.

The company's intended delta consists only of fields differing between the frozen baseline and desired values. Null explicitly clears phone or website. The provider never receives an inferred omission or an arbitrary field map. Bound Account IDs are data, not URLs or authorization tokens. The adapter pins tenant, credentials, object and permitted fields.

## Workflows and Business Rules

1. An operator links a remote ID. A keyed immediate read starts its recurring schedule. Each next tick schedules one successor for that link; no loop scans all accounts. Staff may request an additional read explicitly. Failed reads leave the last successful observation intact and visibly dated.
2. An operator prepares a nonempty correction from the latest present observation. The app freezes its baseline and input and selects that proposal. Only one may be outstanding per link.
3. A different reviewer approves. One typed `replace` intent uses the frozen revision. Dispatch-time guards recheck current authority and selection. A provider conflict, missing account or rejection is a domain result, never an unconditional-write fallback.
4. After a definitive conflict, refresh and review the current values. The original reviewer may rebase the same approved delta at most twice (three total writes). Company-unchanged fields retain the current remote value. Company-changed fields must still equal their original baseline or desired value. An overlapping change, unchanged revision, no-op delta, revoked authority or exhausted bound rejects. Staff then closes a definitively ended attempt and prepares a newly reviewed proposal if appropriate.
5. A successful write receipt proves that conditional request was acknowledged, not that the remote values can never change again. Fresh reads remain separate observations. Reviewers close ended work with a reason, preserving the original outcome and every attempt.
6. An unknown write is never retried automatically. Staff refreshes and may record that the approved delta is now observed. That observation does not claim our request caused it and does not release the mutation hold. A pending, failed-with-ambiguous-effect or unknown attempt cannot be closed as though it definitely ended. If the provider cannot recover definitive evidence, keep the hold and read or pause; other links continue normally. There is no fabricated exactly-once guarantee or unsafe “retry” button.
7. Pause increments the timer epoch, cancels the scheduled successor and suppresses undispatched writes. It does not cancel a possibly accepted provider write or remove its evidence. Resume requires the original owner's current authority, advances the epoch and schedules a fresh read. Old timers are harmless; older successful reads remain history but cannot replace a newer selected read.

## Pages and Interactions

The inherited shell supplies navigation, account menu, localization and personal settings. The CRM synchronization page polls every five seconds to reread stored evidence only; polling does not contact Salesforce. It has breadcrumbs, a link form, an active/paused view selector, an active/paused account table with explicit empty state and pagination, interval edit, refresh/pause/resume actions and a shared drawer for each account.

The drawer displays the observed values and time, typed correction form, a before/desired comparison, baseline revision, submitting and approving identities, decision and outcome badges, and observed-match reference. Closing a correction opens a catalog modal with a typed reason control. Attempt tables expose request status, safe result/error and immutable baselines. Read history distinguishes stale retained data from the current read's failure. Invalid, missing, pending and unknown states remain inspectable; no empty placeholder is presented as a successful synchronization. Forms derive permissions/typed inputs from their owning operations. All rendering uses shared daisyUI/HTMX components, with no app HTML or client business state.

## Personal Configuration

The active/paused view preference filters the Link table. It changes presentation only. The shared Language/Appearance/Account/Security settings remain inherited. Refresh interval is team-owned Link configuration, not a personal preference; it is bounded from 15 minutes to seven days and takes effect when the next tick schedules its successor.

## Interfaces and Integrations

The source owns `AccountsV1` version 1 with `read(id)->Observation` and `replace(id,expected,value)->WriteResult`. Binding selects an adapter satisfying the [documented Salesforce Account conditional PATCH semantics](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-retrieve-patch.html). This Account behavior is not asserted for arbitrary Salesforce objects or other providers. `If-Match` must be atomic; read-then-unconditional PATCH does not implement this contract.

A present read must contain the matching Account ID, complete bounded values and opaque revision; a missing read must contain no snapshot. Only definite authorized absence is `missing`; access denial, uncertain 404, throttling and malformed responses fail the delivery. `applied` proves acknowledged conditional application; `conflict`, `missing` and `rejected` prove that attempt ended without applying its requested mutation. Invalid/absent acknowledgments preserve uncertainty. The adapter must not automatically retry an uncertain mutation and then call the later conflict proof that the earlier attempt did nothing. Rate-limit handling and safe transport metadata are shared delivery concerns. Credentials and destination settings never become application fields.

## Background Actions

Link creation and each current RefreshDue schedule per-record work. Successful read callbacks retain matching evidence once and update latest only for the currently selected attempt. Domain reads are monotonic by selected request identity, not by arrival order. Provider write receipts already retain their outcome; no app callback copies their entire transport state machine into business fields. The proposal's derived outcome reads the associated receipt.

## Error Handling

Invalid input, unauthorized caller, stale expected versions and company-rule failure roll back the complete local action. Provider failure does not erase earlier observations or unfreeze a reviewed proposal. Concurrent local approvals use ordinary admission/version fencing; the provider revision separately fences remote writes. A repeated callback cannot create another domain observation. Sensitive raw provider bodies and secrets never enter safe errors. Retryable reads and unresolved writes have different controls. The app never treats eventual observed equality as proof of causation or a stopped in-flight request.

## Scope and Completion

The triplet specifies a bounded account-correction product with permissions, recovery, recurring work, shared UI, inline translations and meaningful business examples. It intentionally excludes arbitrary field mapping, bulk remote discovery, bidirectional deletion, dependency synchronization, an offline client, automatic overlapping-field conflict resolution and irreversible financial operations.

Inline examples cover successful preparation/approval, role and self-approval rejection, paused or missing baselines, nonconflicting field preservation, conflicting/stale rebase rejection, uncertain convergence retaining its hold, refusal to close an uncertain write, and pause/resume epochs. They are desired behavior specifications. The JavaScript is handwritten proposed output; imports, provider adapter and example runner are not implemented. `node --check` passed. The existing prototype cannot parse associated delivery types, page polling or example sequences; a temporary in-memory projection removing only those unsupported forms parsed the remaining source. That is bounded syntax evidence, not full source conformance or executed behavior.

## Composition and Ownership

`CanSync` selects one owning `sync` package. It neither duplicates CanCRM's customer/business workflows nor writes their models directly. A future company deployment can combine both bounded apps but must deliberately choose their business ownership policy; this draft does not silently turn an external Account into a local Customer. The export is a provider interface, not universal access to a CRM.
