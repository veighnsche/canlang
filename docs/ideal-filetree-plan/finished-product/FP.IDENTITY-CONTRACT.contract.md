# FP.IDENTITY-CONTRACT — Typed identity conditional outcome/context/fence contract

Status: **PROPOSED** for the broad mutation fence below. The bounded read
producer in the current-source addendum is implemented; downstream consumption
and whole J2 acceptance remain open. Author: Lane E session 01a10fab-d0e7-7ab2-aadc-901f4712454f. Base: main
`f6d5fb4`-era lane tip (post-N1 `b84b0e0` merge of main `04d5806`). Task row: `tasks.md` FP.IDENTITY-CONTRACT (deps T04; gates FP.IDENTITY).

## Current-source addendum — 2026-10-10 bounded membership observation

**18 October continuation boundary:** the older absence claims below are not a
new lifecycle queue. Current Identity `storage/d1.ts` implements
`acceptInvitationWithMembership`, `recoverAccountWithToken`,
`removeMemberWithOccurrence` and conditional last-owner writes. Preserve their
accepted results. The next Identity/State design unit enumerates only remaining
ordinary-removal cascades/lifecycle variants, identifies each actual table and
whether a business-State mutation is required, and chooses the transaction owner. Compare an Identity-local conditional batch against any demonstrated cross-owner
participation using the existing consultation requirement. Do not force accepted
local commands through a new shared fence or assert cross-database atomicity. That precise participant decision releases one remaining variant's D1 race,
rollback/replay consumer; it is an engineering decision, not an account gate.

The human-authorized TECH-I01 reconciliation supersedes the historical shared
database premise for this read prerequisite. Production Identity uses global
`env.DB`; concrete team State uses `STATE_DB` or owner-routed databases. The
singular methods, wall-clock `updated_at`, and State fence do not supply a
coherent conjunction of multiple membership reads or a shared revision. OAuth authorization-code consumption already has the explicit one-winner
consumed/unavailable correction (`33f12d62`); it is not a remaining void-return
gap. Recovery cascades, last-owner guards and broad J2 remain unimplemented.

Identity now defines `findMembershipsSnapshot(team_id, user_ids)` returning
Contracts `MembershipSnapshot`: one team and ordered `{user_id, membership}`
entries for 1–99 requested positions, preserving duplicates, explicit absence,
removed status, owner flags and full role provenance. One captured request
becomes one bound primary D1 SELECT with a LEFT JOIN, never per-user reads or
chunks. The limit leaves one of D1's 100 bound parameters for the team. Memory
collects and detaches the complete observation synchronously, without awaiting
or executing supplied getters. Both producers freeze the returned facts and
refuse malformed requests, corrupt facts and incomplete/skewed correspondence. This observation can precede Promise settlement; it is not a reusable token,
revision, latest-at-return assertion or cross-database transaction.

For §4's four questions, the bounded read needs no shared database/fence bump,
mutation count guard or statement-list execution boundary; Memory needs one
synchronous detached capture rather than simulated fence aborts. These answers
resolve only the read prerequisite. The broader mutation choices still require
placement, guard, batch ownership and native/Memory semantics reconciliation. State/Capability must use this one observation for every distinct caller/subject
membership in the decision, while retaining its owning row/revision, policy
evaluation order and authority lifetime checks. Dev owns the runtime mirror,
adapter and real native consumer qualification. Until these are connected and
qualified, multi-member saved-result admission remains withheld.

Three approved current-source Choice requests compare bounded read, a fully
owned revision covering all writers, a colocated shared mutation fence and
deferral. JEV `jev-1.13.0` selects bounded read three times: probabilities
.99/.97/.97, confidence .99/.96/.96, residual deferral .01/.03/.03. Raw requests
and responses live in the existing `state.json` TECH-I01 record. No disagreement
arose; advice does not prove SQL/native concurrency or downstream authority. The exact payloads were explicitly approved by the human after automatic
approval review rejected generic preauthorization. No earlier State payload
approval was reused.

Defining validation: clean Contracts and Identity emission and all 109 owning
Identity tests pass, including real SQLite one-query SQL/correspondence,
equal-clock mutation after observation, maximum bind count and corrupt result
refusals, plus detached Memory facts and zero accessor execution. This is not
native D1/State join acceptance. D1 primary-query and binding limits are defined
in the [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The original sections below describe their historical base and retain their
proposal status; their shared-database assumptions are not current guarantees.

## 1. Scope (observations, not inference)

Verified by reading sources (all paths below at base):

- Contexts (STABLE, already implemented): `resolveIdentity` admits
  exactly three binding kinds — `none` (anonymous), `session`,
  `mcp_grant` (`packages/identity/src/authentication/context.ts`). Interfaces consume them incl. commit-time fences (B4
  `assertCredentialLive`). The contract RETAINS these kinds unchanged.
- Conditional gaps (all check-then-act across store calls, no
  atomicity): `removeMember` last-owner count guard
  (`teams/membership.ts`); `recoverAccount` 5-write cascade behind a
  consume check (`accounts/recovery.ts`); `acceptInvitation`
  consume-plus-membership-write (`teams/invitations.ts`); email-token
  verification consume (`accounts/registration.ts`); OAuth
  authorization-code redeem consume (`authentication/oauth.ts`);
  membership re-admission (`acceptInvitation` reactivate path).
- Store facts: D1 identity methods are one statement each with UNIQUE
  guards on `email_lc`, token hashes, and `(team_id, user_id)`
  (`storage/d1.ts`); identity tables share the database with state
  tables under disjoint names. The memory double is single-threaded
  and proves no concurrency semantics (`testing.ts`, `ports.ts`).
- Recorded intent: `ports.ts` states production atomicity "comes from
  the lane-03 revision fence executing each feature operation's steps
  as one batch (join J2)"; `d1.ts` labels the gap a loud FENCE
  LIMITATION. State D1 commits are one `db.batch()` opened by a dense
  `fence_log` revision insert; pre-reads plus fence abort is the
  proven pattern (`checkWriteVersions`, `state/src/storage/d1.ts`). D1 has no interactive read/branch/write transaction.
- Live guarantee today: the MCP path rechecks current facts per call,
  which is exactly what the unfenced store guarantees.

## 2. Proposed contract (recommendation)

**Mechanism: shared-fence join (J2 as recorded).** Each identity
feature operation's steps execute inside one lane-03 fenced batch;
guards stay as pre-reads and any interleaving commit aborts the batch
via the shared dense revision. Adopted as PROPOSED following
unanimous triple-JEV advice (§5) concurring with the recorded intent;
final selection awaits B (state/J2 owner) reconciliation on §4.

- Table/owner transaction participants: the fenced batch for an
  identity feature op comprises its `identity_*` statements plus the
  shared `fence_log` insert. Owner = the invoking actor/team scope
  that the pre-reads validated; the batch carries no second authority.
- Typed conditional outcomes: every conditional op returns one of
  `committed | contended | replayed` (names PROPOSED): `committed`
  the batch landed; `contended` the fence aborted on a concurrent
  bump (safe retry signal, never an error); `replayed` an idempotent
  re-submission matched an already-committed outcome (one-use winner
  reporting). One-use tokens: the first committer wins; losers get
  `replayed` (same token, same effect already applied) or
  `contended`, never a second effect.
- Last-owner/role/recovery atomicity: count guards and cascades are
  pre-reads inside the J2 batch window; the fence makes the
  read→write sequence atomic against concurrent commits. Recovery's
  5-write cascade lands or aborts as one batch.
- Replay/rollback and origin binding: fence revisions order commits;
  rollback = compensating forward operation (no history rewrite);
  origin binding = the batch's actor/team scope recorded with the
  outcome. System registration alone is insufficient (row requirement):
  registration proves the mechanism exists, not that any op used it —
  each op's outcome type is the proof.
- Contexts: unchanged (`none`/`session`/`mcp_grant`); the contract
  adds outcomes, not principals.

## 3. Explicit non-goals

- No new identity principals, roles, or session kinds.
- No second fence protocol or separate identity revision domain (JEV
  rejected; see §5). If B's reconciliation requires separation, this
  draft returns to PROPOSED-review, not silent edit.
- No memory-double fence simulation unless B requires it (§4 Q4).

## 4. Open questions (blocking dependents, relayed to B via coordinator)

1. J2 shape: same `db.batch()` as records/`fence_log` (shared bumps
   on identity-only ops) or a separate identity revision domain?
2. Are pre-read + fence-abort guards acceptable for count guards, or
   must guards be in-batch SQL assertions? (Abort rate under contention?)
3. Batch-assembly boundary: identity lane emits statement lists and
   state executes, or state owns both?
4. Must the memory double simulate fence aborts for tests?

## 5. JEV consultation record (advice, not proof)

Difficult mechanism choice consulted per AGENTS.md with
`tools/jev.py` (endpoint `https://api.typesafe.ai/v1/systemone`,
model `jev-1.13.0`), question type `choice`, three independently
worded equivalent requests (verified state + balanced criteria; no
source code attached, file:line anchors only; no PII or secrets). Full request payloads are embedded below; responses saved verbatim.

| # | Winner (equivalent) | Confidence | P(winner) | P(others) |
| --- | --- | --- | --- | --- |
| 1 | shared-fence | 0.95 | 0.97 | separate 0.01, typed-outcomes 0.02 |
| 2 | fenced-together | 0.96 | 0.97 | apart 0.01, outcomes-only 0.02 |
| 3 | shared-fence-join | 0.92 | 0.95 | own-domain 0.01, no-fence 0.04 |

Disagreement: NONE (3/3 for the shared-fence join; no investigation
triggered). Uncertainty: residual 0.03–0.05 spread across the two
losing options, stable across wordings. Treatment: advice concurring
with the recorded J2 intent; the draft adopts it as PROPOSED and
still gates final selection on B-owner reconciliation (§4).

### Request 1 (question `mechanism`)

State: identity D1 one-statement methods + UNIQUE guards + shared DB;
six check-then-act sites enumerated with race mechanics; memory
double single-threaded; state D1 one-batch + dense-revision fence +
checkWriteVersions precedent; ports.ts J2 intent + loud FENCE
LIMITATION; MCP per-call recheck guarantee. Judged on concurrent
correctness, D1 fit, blast radius, reversibility, test-provability;
no performance numbers assumed.

Criteria: shared-fence (J2 steps in lane-03 batches, pre-reads +
fence abort; costs: shared revision traffic, cross-package batch
seam) / separate-domain (own dense-revision fence; costs: second
protocol to build/review/operate, cross-domain composition an open
problem) / typed-outcomes (UNIQUE markers + winner/loser/replayed
types + documented windows, no atomicity; costs: races persist as
risk, per-feature safety cases, tests pin shapes not exclusion).

Response: `{"mechanism": {"type": "choice", "choice":
"shared-fence", "confidence": 0.95, "probabilities":
{"shared-fence": 0.97, "separate-domain": 0.01, "typed-outcomes":
0.02}}}` (usage 1010/50).

### Request 2 (question `selection`; independent wording)

Same verified facts reworded; same three mechanisms reworded
(fenced-together / fenced-apart / outcomes-only) with equivalent
trade-offs; judged on the same five dimensions as unmeasured.

Response: `{"selection": {"type": "choice", "choice":
"fenced-together", "confidence": 0.96, "probabilities":
{"fenced-apart": 0.01, "fenced-together": 0.97, "outcomes-only":
0.02}}}` (usage 927/51).

### Request 3 (question `approach`; independent wording)

Same verified facts reworded; same three mechanisms reworded
(shared-fence-join / own-fence-domain / contract-without-fence)
with equivalent downsides; no latency/throughput data for any option.

Response: `{"approach": {"type": "choice", "choice":
"shared-fence-join", "confidence": 0.92, "probabilities":
{"shared-fence-join": 0.95, "own-fence-domain": 0.01,
"contract-without-fence": 0.04}}}` (usage 923/56).

## 6. Evidence limits

- JEV advice consulted the mechanism only; it proves no runtime
  behavior and was not shown source code.
- The draft's race mechanics were verified by reading feature code,
  not by executing concurrent probes (no implementation authorized).
- B-owner answers (§4) may overturn §2; the PROPOSED mark stands
  until reconciled and owner-accepted.
