# W01.4 — Supported-profile ledger: retained paths, limits, and non-narrowing rules

Task: W01.4 (lane `work-contracts`, wave 1, after `W01.1`, `W01.2`,
`W01.3`, `C05.ready`). Head: `2071631` (main tip at authoring).
Planning record only; no implementation authorized.

Companions: `workloads.json` (frozen workload shapes),
`budgets.json` (pre-registered dimensions + unratified cutoffs +
ratification rule).

## Retained in TS (not ported in W01–W08)

- **Unknown-object / arbitrary-object shells.** Public APIs that
  accept arbitrary objects keep legacy TS evaluation shells
  (eager spreads, wholesale serialization, and early
  getter/proxy walks are forbidden in the port path; freeze is
  not provenance). Work JSON-safety-traversal-then-clone and
  state clone-only row replacement stay distinct profiles.
- **Callback / demand loops.** Grant, content, evidence, guard,
  and provider callbacks keep their TS demand shells: facts are
  prepared only where already demanded, in original order,
  stopping on the same first exception. Where extraction cannot
  preserve behavior economically, the complete callback path
  stays in TS during initial rollout; a data-only port may
  still cover matching transition functions without claiming
  the callback API migrated.
- **Host hashing.** Identity-byte preparation and hashing stay
  host-owned (Node crypto today) until a byte-parity fixture
  proves the Rust counterpart; hashing is not a prerequisite
  for the main pilot. `encodeURIComponent` identity encoding
  (with its lone-surrogate exception) stays separate from
  recurrence-digest UTF-8 replacement behavior: different
  profiles, never merged.
- **Recurrence hash translation.** Optional; translates only
  with its own byte proof, otherwise retained.
- **Canonical admission hashing.** `stableStringify`, getters/
  `toJSON`, defaults, and raw-input hashing stay in the owning
  TS host; the unknown-input canonicalizer is never ported by
  this plan. Receipt replay stays before age/auth/normalization.
- **Request/resume orchestration.** The scheduler is the
  separately gated W09 project, not W01–W08. Completing W08
  does not mean the scheduler migrated.

## New operation resource limits

New bounds (batch facts, payload/ref allocation, plan caches)
must derive from real callers and documented resource policy
(see `budgets.json` dimensions). Exhausting a new bound
surfaces an explicit fault; it never silently truncates
membership, completion, or evidence. Limits are ratified from
measured runs (W07.2/W07.3), not invented here.

## Non-narrowing rules (frozen)

- No legacy input domain is silently narrowed: retained paths
  keep their full accepted inputs, error orders, and trace
  shapes; any domain restriction is a separately versioned
  design decision with its own proof.
- Rust output is a proposed batch, never a storage authority:
  `expectedRevision` acquisition, freshness, grants, fenced
  atomic commits, and caller-owned retry/exhaustion stay host
  behavior; every commit seam stays single-shot.
- Shadow comparison (if used) consumes frozen closed facts and
  never duplicates getters, RNG, guards, grants, evidence, or
  providers.

## Owner review status

Required (recorded, not assumed): work owner (retained
shell/decision split), state owner (mirror/staging/transact
scope), cloudflare owner (F7/orchestration scope), C04 delivery
owner (vendor/binary scope), C05 harness owner (workload/
budget procedure). W02 extraction must not start until these
reviews land.
