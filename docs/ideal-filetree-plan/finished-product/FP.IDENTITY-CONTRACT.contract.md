# FP.IDENTITY-CONTRACT — Typed identity conditional outcome/context/fence contract

Status: **PROPOSED** (draft for owner review; no implementation authorized).
Author: Lane E session 01a10fab-d0e7-7ab2-aadc-901f4712454f. Base: main
`f6d5fb4`-era lane tip (post-N1 `b84b0e0` merge of main `04d5806`).
Task row: `tasks.md` FP.IDENTITY-CONTRACT (deps T04; gates FP.IDENTITY).

## 1. Scope (observations, not inference)

Verified by reading sources (all paths below at base):

- Contexts (STABLE, already implemented): `resolveIdentity` admits
  exactly three binding kinds — `none` (anonymous), `session`,
  `mcp_grant` (`packages/identity/src/authentication/context.ts`).
  Interfaces consume them incl. commit-time fences (B4
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
  proven pattern (`checkWriteVersions`, `state/src/storage/d1.ts`).
  D1 has no interactive read/branch/write transaction.
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
source code attached, file:line anchors only; no PII or secrets).
Full request payloads are embedded below; responses saved verbatim.

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
