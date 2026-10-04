# CanSync: reviewed CRM account synchronization

Design in progress for the active complex-app goal. Root owns this app triplet; H007 transfer from the existing draft coordinator is explicitly released. No provider/library implementation is claimed.

## Company outcome and source evidence

A sales-operations department links selected existing external CRM accounts, reads their current name/telephone/website, prepares a correction and has a reviewer approve the exact change. External edits are preserved through conditional writes; a response lost after a possible write is investigated without issuing another mutation blindly. The app includes recurring refresh of each linked account, pause/resume, conflict/rebase, explicit reconciliation and retained decision evidence. It is not a universal ETL or arbitrary two-way mapping engine.

The representative adapter targets Salesforce **Account**, not arbitrary Salesforce objects. Official [sObject PATCH documentation](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-retrieve-patch.html) documents Account ETags and `If-Match`; that conditional behavior is not claimed for every object/provider. The deployment binding pins tenant, Account object, field allowlist and credentials. A user-supplied Account ID cannot replace its destination, tenant, headers or authorization. Other adapters must provide equivalent atomic conditional-write semantics or report the contract unsupported. Do not implement a read-then-unconditional-write substitute.

## Ownership and business policy

- Team-scoped operator and reviewer roles. An operator links accounts, prepares changes, refreshes and pauses; a different currently authorized reviewer approves a proposal or explicitly accepts observed reconciliation. Roles and team membership are rechecked on each canonical action.
- The provider owns account identity, existence and its observed revision. Can owns link enabled state, immutable proposed changes, decisions and recovery evidence. The UI calls the imported provider snapshot a latest observation, never an always-current truth.
- A change proposes the complete bounded name/phone/website projection against one retained provider revision. Other provider fields are never written. Local edits are proposals, not successful remote writes.
- Frozen proposal, baseline, submitter and approval remain inspectable. No delete/update CRUD permits changing an approved proposal behind its receipt. A rejected/conflicting proposal can be replaced by a new proposal against a fresh read, requiring fresh review.
- The adopted policy reviews the complete frozen before/after projection, then permits at most two reviewer-triggered rebases of that same approved delta. Fields not changed by the company keep the current remote value; a company-changed field must still equal its baseline or desired value. Other overlaps require closing a definitively ended attempt and preparing a new reviewed proposal. Nothing silently chooses which conflicting value wins.

## Minimal provider contract

The owning package declares one exported capability and structural values, then binds that interface through the existing `use ... from=deployment.crm` form. No new fetch keyword, user-authored URL, secret input or business JSON parser.

`AccountSnapshot` has `id:text`, `revision:text`, `name:text`, `phone:text?`, `website:url?`. Adapter normalization preserves exact opaque ID/revision. `read(id:text)` returns an explicit present/missing observation; missing is distinct from access denied, rate limiting and timeout. A successful present read requires a complete snapshot. Only a provider-authorized definite absence maps to missing; ambiguous 403/404 mapping fails rather than asserting deletion.

`replace(id:text,expected:text,name:text,phone:text?,website:url?)` returns a closed domain result `applied | conflict | missing | rejected`. A definitive `applied` means the bounded conditional PATCH was acknowledged. Optional observed current data after that result is a separate later observation, not proof the write's exact snapshot persisted unchanged. Lost response or ambiguous transport remains the ordinary delivery `unknown`, with no invented applied result. Invalid response schema likewise cannot prove no effect.

Standard delivery machinery owns provider request identity, bounded transport/decoding, safe errors and supported rate-limit scheduling. Repeated delivery cannot issue a second unsafe write: conditional mismatch after a retry does not erase uncertainty about the earlier dispatch. Retain uncertainty until the adapter can prove the first outcome; the adapter may refuse automatic mutation retry. App-level retry is allowed only after definitive no-effect evidence or explicit current-state review under a new conditional baseline.

Reconciliation uses the **same read** operation, then an explicit company decision. Equal current name/phone/website can establish that the desired state is observed; it cannot prove which request caused it. The app records `observed_match` separately from `applied`. If values differ, staff either abandons that desired change or prepares a new proposal from the new baseline. Unknown original outcome remains visible in its original receipt. No magical provider receipt journal is assumed.

## Source/target design boundaries

Use normal models for Link, immutable Proposal and its review/reconciliation evidence; typed associated deliveries for reads/writes; keyed per-Link scheduling for recurring read refresh; one shared callback per declared operation only when a business projection/decision must change. A nullable association means not requested; transport status stays on the delivery. Do not mirror its entire lifecycle in each business model.

Pause increments a Link epoch, cancels its keyed future refresh, and prevents undispatched writes through dispatch-time guards. It cannot recall an accepted remote write. A later completion still updates retained delivery evidence; applying a new observation or deriving an active proposal never revives a paused link. Resume establishes a new epoch/read and schedule. Old deadlines and superseded read callbacks cannot overwrite a newer observation.

One outstanding business proposal per Link prevents two reviewers dispatching incompatible approved changes concurrently. Local expected versions and final invariants fence proposal selection; remote expected revision fences provider changes. Bound read timeouts are recoverable reads, not mutation consent. Recurrence schedules one next occurrence per linked record; no population loop or `limit` pretending to be a cursor.

## Acceptance cases to encode

1. Link/read, freeze a correction, independent reviewer approves, conditional write acknowledged, fresh read displays its actual observed state.
2. Wrong role, same-person approval, paused link, changed local selection or revoked reviewer rejects or suppresses dispatch without partial local effects.
3. Provider revision changed: conflict; old proposal remains immutable and no unconditional overwrite occurs. A new proposal uses fresh observation and fresh approval.
4. Write timeout followed by matching read: explicit observed-match reconciliation; original receipt remains unknown. Mismatching read never becomes successful synchronization.
5. A duplicate completion or older read cannot apply twice/replace a newer snapshot. Pause/resume invalidates old timer/read generations without claiming remote cancellation.
6. Rate limit and unavailable source remain visible; previous observation is labeled stale. Missing requires definite provider evidence and does not delete retained decisions.
7. Omitted phone versus explicit null retains the typed full-projection meaning; URL/text normalization and invalid inputs use their schema, never provider strings as executable paths.
8. Browser and MCP use identical operations/grants; UI displays observed revision/time, proposed diff, approval, transport outcome and reconciliation decision separately.

Remaining work: finish the three-way-versus-whole-projection comparison, exact source and target, meaningful inline examples and bounded consistency checks. This document is not a completed app or an adopted new shared primitive.

## Accepted comparison and uncertainty

Three independently reworded balanced JEV requests favored field-wise preservation over restarting the whole projection: 0.96/0.04, 0.95/0.05 and 0.57/0.43; the third confidence was only 0.13. This is directionally consistent advice, not performance proof or a universal policy. The app therefore exposes the exact approved delta and an explicit reviewer-triggered, three-attempt maximum rebase; overlapping edits fail visibly. Evidence is in `design/jev/complex-sync-20261004/`.

An observed match after an unknown write records convergence but deliberately does not release the mutation hold. A read alone cannot prove an older request will never execute. Only definitive ordinary receipt evidence releases that hold. If the provider cannot resolve it, staff can keep reading or pause the link; this adapter limitation is explicit rather than a fake safe retry. Other accounts continue independently. No local compensation pretends to undo an external write.
