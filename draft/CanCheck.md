# CanCheck requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanCheck.can](CanCheck.can).

## Purpose and Adoption Goal

Help the workspace operator detect missed check-ins from scheduled booking reconciliation, invoice reminders, reporting imports, and maintenance jobs. Adoption depends on distinguishing a missed job heartbeat from a successful business outcome.

## Users and Permissions

Authorized operations members view scoped check health/history and perform permitted pause/resume actions in the normal monitoring view. Developers provision checks and maintain period/grace, alert destinations, retention and token rotation through trusted developer maintenance outside the product UI, using canonical owner admission and model create/update hooks rather than raw SQL. Jobs use a check's unique ping token without interactive login.

## Data and Ownership

Check stores team, name, positive period, non-negative grace, enabled state, token, and alert URL. Persist receipt time, deadline revision, state transitions, and delivery outcomes. Keep 90 days of history by default; token rotation invalidates the old URL.

Record job purpose, owning application, responsible team/member, and optional location scope. A check remains a heartbeat monitor; the name of a job cannot prove that its records were correctly processed.

## Workflows and Business Rules

Creation arms a first deadline at creation plus period and grace; the page shows new until a ping or that deadline. A missed first deadline becomes down. Thereafter a ping makes it up, period expiry makes it late, and period plus grace makes it down. Use server receipt time, including a durable paused receipt without rearming monitoring. Late/down recovery creates one correlated recovery notice; a first successful ping is an up transition without claiming business-job success. Pausing suppresses deadlines/alerts; resuming starts a fresh period.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). The declared Job health (`/job-health`) page supplies the operations sidebar entry; check detail/history and application/location filtering stay contextual. Use daisyUI. Check provisioning, period/grace, retention, alert destinations, copied secret ping URLs and token rotation remain developer maintenance outside product forms/tools/settings.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Job health | Application/location/state Select filters above a Table/List grouped by application and location, with job name/purpose, responsible owner, health, enabled/paused Badge, last durable ping and upcoming deadline. | Authorized operations members read their scoped configured checks; health is evidence of received heartbeats, not successful processing of business records. |
| Check detail | Purpose/application/location Card and separate Stat cards for last ping and next deadline; configured period/grace displayed as read-only context. | Show new/never-pinged, up, late, down and paused clearly using authoritative receipt time and current deadline revision. |
| Transition and recovery history | Bounded date-ordered Table/List of previous/new states and occurrence times; history Collapse for earlier entries. | Display retained transitions, including first missing ping and recovery, without implying precise-second timer execution or unlimited history. |
| Operational controls and delivery | Pause/resume Buttons beside enabled state; Alert/List for each available logical notification/delivery outcome. | Use only existing authorized pause/resume operations. Pausing suppresses deadlines/alerts; resuming starts a fresh period. Failed alert delivery does not change heartbeat health. |

Make the last durable ping and deadline visible together, with explicit never-pinged text. Distinguish no configured checks, no filter matches and unavailable health/history. Pending pause/resume disables duplicate actions and retains the server result; a racing ping/deadline or stale state causes an Alert and refreshed authoritative deadline, never a local guess. Preserve selected filters through refresh. On mobile render labeled check Cards and collapse history after the latest transition while keeping health, pause state, owner and deadline visible. Read-only configuration explains health without exposing tokens or technical editing.

## Personal Configuration

Inherit shared base settings through the own-user dialog. Remember application/location/health filters and row density. Presentation defaults remain within current read scope and cannot alter deadline arithmetic, enabled state, alert destinations, tokens or retention. No technical/admin area is required.

## Interfaces and Integrations

Use one D1 owner for authoritative configuration, receipt time, deadlines, health, transitions and notification records. The shared durable due-work dispatcher delivers scheduled deadlines. The earlier split between D1 configuration/history and per-check Durable Objects was an assistant-created draft assumption: it would separate the current employee-location authorization from the mutation owner. This draft preserves that authorization and does not add a cross-owner grant snapshot. GET or POST /ping/{token} records a check-in without caching. Tokens authorize check-ins only. Alert destinations are configured public HTTPS URLs.

Configuration and token provisioning/rotation remain developer maintenance outside the product UI/MCP. The normal end-user operation set is authorized health/history reads and pause/resume; those actions preserve the documented deadline/revision behavior. The proposed, unimplemented maintenance transport must authenticate the developer/source, establish the configured team, accept a canonical create/update candidate and expected version, and run the owner fence, hooks, invariants, receipt/history and outbox in the same commit. It may provision or rotate the protected token under that trusted contract, but cannot grant product users that authority or bypass rules with raw SQL. The source declares no user CRUD or configuration capability because this transport reuses the owning model schema; it is not an existing API. Creation arms its first deadline before commit. Period/grace/enabled changes increment the deadline revision and, when enabled, begin a fresh period; pausing cancels the pending occurrence. Other actual configuration changes retain health/anchor, replace any pending deadline under a new revision, and create one correlated configuration notice when enabled. Ping/state effects do not invoke the update hook. Every notice retains its delivery receipt and outcome separately from health. A later healthy ping does not cancel a pending recovery notice. Dispatch rechecks enabled state and the relevant up/down state, without comparing the heartbeat revision. A configuration notice is historical evidence of a committed change and may arrive after a later edit; its rendered text remains frozen, and a pause suppresses undispatched alerts.

## Background Actions

Persist timer revisions. When a timer fires, re-read enabled state and the latest deadline so an old alarm cannot mark a recently pinged or paused check down. Create one logical notification per transition; delivery retries keep its identity.

## Error Handling

Reject invalid configuration or unknown tokens. A response acknowledging a ping must follow durable acceptance. Failed alert delivery stays visible without resetting health state. A delayed timer can detect a missed deadline, but exact-second alerts are not guaranteed.

## Scope and Completion

Complete when the first missing ping, a later missed ping, recovery, pause/resume, and a ping racing a deadline have defined outcomes.

Operations can detect and recover a missed payment-reconciliation heartbeat without presenting a healthy ping as proof that every payment was reconciled.

Frontend completion additionally requires these journeys:

- Operations sees a new check that has never pinged become down at its missed first deadline, then reads the durable recovery transition without interpreting the ping as proof of payment reconciliation.
- A permitted pause suppresses monitoring; resume shows a fresh period. A concurrent ping/deadline refresh and failed alert delivery leave authoritative health and notification outcome separately visible.

## Composition and Ownership

Recommended placement: Digital heartbeat module. Own job ping deadlines and health transitions. Sharing an operations dashboard with CanCatch does not make a ping proof of successful data processing or payment reconciliation. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft validation boundary

Hook behavior is specified in source; faithful precommit-candidate examples remain tied to the future maintenance/CRUD hook runner rather than fabricated record snapshots. The `.can` and `.mjs` are desired source and handwritten translation targets. Typed token ingress must resolve the configured check/site namespace, reject unknown or mismatched tokens, avoid caching, and acknowledge only the committed ping receipt. Public HTTPS alert destinations require the installed alert adapter's bounded egress validation. D1 fencing, due dispatch, maintenance admission, token ingress, adapters, frontend and the example runner remain unimplemented. Inline examples describe business expectations, including first/later misses, recovery, pause/resume, unknown tokens, stale deadline revisions and delivery failure; parser and JavaScript syntax checks do not execute them or measure dispatcher latency/contention.
