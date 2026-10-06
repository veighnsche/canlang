# Inputs, baselines and evidence policy

This is a planning audit of `/Users/vince/Projects/canlang`, branch `codex/challenge-audit-implementation`, on 2026-10-06 (Europe/Brussels). The similarly named `/Users/vince/Projects/can-lang` was checked for existence and was absent; no substitute source was used.

| Baseline | Identity and scope |
| --- | --- |
| Permanent initial review | `e93adebb3397ef2545efee82006d8227bc361518`, 1,881 parent paths |
| Previous complete reconciliation | `8249342707d3280e88e39e8c911b7e457828f31f`, 1,897 parent paths |
| Current structural/catalog pin | `350163ad661e61b667809a5f78b608c23812a5f0`, 2,155 parent paths |
| Committed delta from previous reconciliation | 391 paths: 258 additions, 133 modifications, no deletions |
| Independently owned draft | Parent gitlink `draft`; checkout/pin `2d673127e03e8b8bc369a7a34858165c034df131`, 148 paths; unchanged and clean at capture |
| Initial nonignored additions | Three description-reference review/evidence files; catalogued separately from committed source |
| Review baseline | Path-level evidence in the three [reviews](slices.md); unchanged evidence reused from the previous review at its original scope |

[inventory.json](inventory.json) records every parent input with committed blobs, working SHA-256, size, line count, slice, change and dirty status. A gitlink is not a parent-owned directory of source. Draft contents are enumerated separately in the desired tree. Catalog construction read source bytes and Git objects; that mechanical operation does not establish semantic review.

The checkout is shared with an active implementation run. At capture, four tracked files were dirty: challenge monitor, description tasks, Cloudflare invocation and the state mutation barrel. More compiler/contracts/state/work edits appeared during inspection. [verification.json](verification.json) records final drift. Dirty evidence is an overlay, never a committed checkpoint or proof that an active writer has released a file. This audit changes only the living plan and its supporting documents. It does not modify the running checklists, source, manifests, CI, submodule or Git history.

Governing authority is the user-supplied/root `AGENTS.md`, then `REQUIREMENTS.md`, `DESIGN.md`, `GRAMMAR.md`, `DECISIONS.md` and owning implementation contracts. Older README/scaffold wording conflicts with current implemented commands and is documentation debt. Draft `.mjs` files remain desired-output witnesses; they are neither compiler output nor proof of executable libraries. Operational checklists are evidence and reservations, not new authorization for this planning turn.

The installed [skill](../../../../.codex/skills/ideal-filetree-audit/SKILL.md) contains the supplied eight-step method. Its `references/procedure.md`, `references/records.md`, `references/scheduling.md` and `scripts/check_artifacts.py` are absent. Read-only searches of the installed skills/plugins and `.codex` tree found no replacements. The supplied main procedure was followed; missing templates and prescribed checker remain an explicit method limitation. Local checks below are independently described, not attributed to that missing script.

## Evidence levels

Source observations establish declarations, callers, state transitions and apparent gaps. Reviewers independently challenged selected consequential findings and ownership boundaries. Existing JSON/transcripts preserve earlier executed evidence at their recorded revision; this invocation did not run product tests, builds, installation, services or provider calls. No test count, documentation size, generated tree or reviewer agreement certifies a complete workflow.

Ignored dependencies/build outputs/private inputs are excluded. Tracked snapshots, experiments, binary media and generated evidence remain allocated for provenance; byte identity or structural decoding is separate from behavior. Existing historical references are not rewritten to simulate current ownership.

## Update rule

After every merge, its handler compares all accumulated source changes since the last reconciled checkpoint, including guidance drift and gitlinks. Refresh inventory, mixed duties, affected reviews, findings, owners, allocations, retirements, tasks and lanes together. Advance the complete reconciliation checkpoint only when review is complete; open defects may remain, but unreviewed duties and moving overlays must stay visible. Bookkeeping requires no recursive self-update and authorizes no implementation.

Final structural capture also records `c300d467b3863fd096d81e8666152859ab36f028`, which landed T32 Cloudflare integration and two tests after the primary/T25 review. Those additions are allocated with deep review pending. The complete reconciliation checkpoint remains `8249342`; no late integration closure is inferred.

Later planning-only drift through `b82c0de` adds the T34 slice plan and coordinator adjudication/handoff record. The source was inspected as planning evidence: durable per-child direction is incorporated in that run, while actual fanout membership/checkpoint/recovery implementation and verification remain outstanding. Original-pinned checklist states in backlog.json are not relabeled as current.
