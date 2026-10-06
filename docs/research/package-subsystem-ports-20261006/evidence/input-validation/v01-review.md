# V01 — Caller and ownership contracts review

Gate: V01 "Caller and ownership contracts reviewed" (lane `V-evidence`,
after V01.1–V01.4). Review produced 2026-10-06T08:43:58Z by lane F
session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9. Review record only; gate
release belongs to the coordinator.

- Head cited by all children: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Method: full re-read of all six evidence files below; every claim
  below was checked against at least two of them.

## Completion ledger

| Child | Files | Bytes | Status |
| --- | --- | --- | --- |
| V01.1 caller contracts + workload registry | `contracts.md` | 6969 | accepted, integrated identical |
| V01.1 (cont.) | `caller-inventory.json` (valid JSON) | 5198 | accepted, integrated identical |
| V01.1 (cont.) | `current-ts.json` (valid JSON) | 1827 | accepted, integrated identical |
| V01.2 bounded HTTP adoption join | `http-adoption-gate.md` | 4797 | accepted, integrated identical |
| V01.3 state sequencing + bridge | `state-contract.md` | 4702 | accepted, integrated identical |
| V01.4 owner-plan + shared-file handoffs | `plan-contract.md` | 5689 | accepted, integrated identical |
| **Total reviewed** | 6 files | **29182** | |

## Per-child verdicts

- **V01.1 PASS**: five profiles carry admitted domains plus
  error/order/identity obligations; caller inventory covers the five
  public entries, interfaces helpers, and state admission with
  dispositions; baseline pins three tree hashes plus frozen surfaces;
  no-full-port-claim and public-unknown-stays-legacy are explicit in
  all three files. Modes (deployed MCP / HTTP 501 / forms / handle)
  are distinguished with file evidence.
- **V01.2 PASS**: handler-real/seam-absent verdict is sourced
  (`createHttpHandler`, `handleOperationRequest`, ten test suites;
  `AssemblyDeps` without `http?`); bounded join names exact handler,
  seam, and owning files with no new HTTP feature; fixture-proof vs
  deployed-adoption gates are separately testable; 501 fallback kept.
- **V01.3 PASS**: seven-step admit sequence matches the verified call
  order with replay/hash/digest invariants; read auth-first verified;
  bridge contract (dual `OperationInvoker`, `buildInvoker`) carries
  protected-graph, injected-invoker, and no-inference rules; legacy
  retainers are explicit scope boundaries.
- **V01.4 PASS**: factory provenance, copied-metadata, revision,
  default-ref, and plan-handle agreements are complete; the
  no-second-authority rule is explicit; V-integrator shared-file
  ownership after A03.foundation/C03 handoff is exact (file lists +
  queueing rule); filetree reconciliation records decisions without
  advancing any checkpoint.

## Mutual-consistency checks (all pass)

1. Same head hash in all six files; values/interfaces byte-identical
   to checkpoint and state authorization-only delta stated
   identically in V01.1 and reused (never contradicted) by V01.2–V01.4.
2. No-full-port-claim + legacy retainers agree across contracts.md,
   caller-inventory.json flags, current-ts.json obligations, and the
   state-contract legacy list.
3. HTTP gap story agrees: interim dispatcher + absent seam + retained
   501s in contracts.md modes, caller-inventory `http_501`, and the
   adoption gate (which adds the bounded join, changing no premise).
4. Replay/hash freeze agrees: state profile (contracts.md), baseline
   obligations (current-ts.json), and frozen sequence (state-contract).
5. Provenance rule agrees: freeze/shape-insufficient (plan-contract),
   legacy-ts exclusions (contracts.md), no-inference (state-contract).
6. No file invents a second currency/Decimal/wire/catalog authority or
   a compiler change; V-integrator exclusivity contradicts no lane
   ownership row.

## V01 acceptance

"Five profile/input domains, workloads, baseline and HTTP/source
ownership gap agreed":

- Five domains: values/v1, http-input/v1, mcp-ordinary/v1,
  state-generated/v1, legacy-ts — defined with obligations. MET.
- Workloads: five-item registry (HTTP whole calls, values whole
  calls, MCP traces, state traces, negative corpus). MET.
- Baseline: hashes + frozen surfaces + obligations. MET.
- HTTP/source ownership gap: handler/seam verdict + bounded join +
  caller inventory + per-file owner assignments. MET as contract
  content.

## Gate verdict: CONDITIONAL PASS

Content is complete, mutually consistent, and meets every V01
acceptance element above. The condition: every child records owner
reviews as **required, not assumed** (values, validation,
interfaces, state, cloudflare, C04, exact-values integrator, C03 —
named per file). "Agreed" is therefore not yet fully earned. V02
preparation may proceed on these contracts, but no V02 extraction
leaf may start until its named owners have reviewed and approved
the contract it consumes. Release of this gate is the coordinator's
decision on receipt of those approvals.

## Observation (non-blocking)

contracts.md says workload budgets are "ratified at V01.2+"; V01.2
assessed the join, not budgets. current-ts.json correctly places
measurement at V03 and fixing at V07 (V-evidence backlog: V11.1
precommitted budgets). No correction needed — future tasks should
cite current-ts.json, not the V01.1 shorthand, for the budget plan.
