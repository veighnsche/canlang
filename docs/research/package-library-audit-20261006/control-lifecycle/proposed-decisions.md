# Proposed lifecycle repair constraints

This audit accepts no new product/security policy or implementation mechanism.
Existing contracts and deliberate negative witnesses remain authoritative at their
recorded stage. The shared `docs/specification/DECISIONS.md` is untouched because
no new project mechanism has been selected, and the concurrent compiler writer is
preserved. Choices below remain proposals; an accepted mechanism must be recorded
there when the affected contract is actually released.

- Keep one existing owner per effect/lease. Fix the smallest owner boundary;
  avoid a generic retry adapter, global resource registry or second scheduler.
- Resolve conditional single-use consumption before downstream credential mint;
  choose losing-request and lost-bearer outcomes against the real persisted policy.
  Recovery password/session/grant cascades need one atomic or recoverable owner,
  not merely more sequential wrapper checks.
- Preserve source order/first failure and exact operation/input identity. Failure
  after an effect is an uncertain/partial outcome, not an automatic retry license.
- Preserve successful content-reference lifetime through plan retirement. Failed
  construction rollback and legitimate retained content/owner bounds are separate.
- Keep logical result cancellation distinct from physical transport cancellation
  and remote effect reversal. Use an actual supported host/SDK signal/deadline
  owner where required; do not assume arbitrary awaited callbacks terminate.
- File retry protocol, jointly persisted blob/count/finalization recovery, already
  fenced revocation, owner/default retention and raw cache-key budgets have
  unresolved mechanisms. A new consequential design choice requires repository
  evidence and three equivalent independently worded JEV questions; this factual
  audit does not repeat completed consultations or pick a design prematurely.
- Native preparation/publication remains held. Recorded scaffold/absent-owner
  scenarios do not authorize adoption, new implementations, deletion of TS,
  production deployment or broad installed acceptance.

The [proposed queue](fix-queue.json) groups findings under existing owner/task
references. Audit IDs are not additional canonical backlog obligations. Release
contracts separately and review actual consumer changes before deleting donors.
