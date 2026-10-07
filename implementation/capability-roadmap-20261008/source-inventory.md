# Source inventory (SEQ-001) and ownership signals (SEQ-002)

Captured at committed `HEAD c718517a5aae8481a8b548a7eb299b8c5377dee6` (`fix(compiler): adapt card titles and transient tabs`); branch `main` is 25 commits ahead of `origin/main`. `git status --short --branch` reports dirty compiler analysis/tests, decisions, completion README/bookkeeping, package file/interface/UI sources and tests, plus untracked compiler facts, proposal, roadmap, owner-lease and completion evidence. These working-tree candidates are not treated as accepted or committed. The full status and exact baseline are also in `source-inventory.json`.

## Explicit bounded receipts

| Area | Evidence state | Pinned evidence and scope |
|---|---|---|
| Selected calls, defaults, plain format | Independently accepted bounded; committed | `implementation/compiler-completion/selected-calls/independent-review/report.md`; source implementation commit recorded in `owner-lease-status.json` as `3403dc71`. Covers winning overload/declaration facts, declaration defaults and two-argument plain format; localized formatting, BDD facts and canonical scenario state-read join remain open. |
| Compiler UI Card title / transient Tabs | Independent review says accepted bounded; committed in current HEAD | `implementation/compiler-completion/ui-ownership/independent-review/review.json` and `review.md`; `c718517a`. Static literal Card title and legal unbound static Tabs only. Query/bound/order/profile workflows remain open. |
| OAuth grant consumption | Independent review receipt committed | `implementation/package-maintenance-repair/runs/codex-go-20261007/oauth-consume-independent-review.json`; commit `33f12d62`. Receipt's own bounded outcomes/limitations govern; commit presence alone is not broader workflow acceptance. |
| Cloudflare bundle entry cleanup | Independent review receipt committed | `implementation/package-maintenance-repair/runs/codex-go-20261007/entry-cleanup-independent-review.json`; commit `2b750a6e`. Narrow failed-write cleanup. |
| Installed WASM/browser asset bundle | Implementation committed, no accepted independent review located in this bounded inspection | `b24108ed`; tests/source are committed. Do not infer complete installed/deployed worker acceptance from the implementation commit. |
| Cloudflare fanout retry freshness | Independent review receipt committed | `implementation/package-maintenance-repair/runs/codex-go-20261007/fanout-freshness-independent-review.json`; commit `c7c98b71`. |
| Stdlib synchronous guard exports | Independent review accepted at bounded scope; committed | `implementation/compiler-completion/runtime-export-join/independent-review/assessment.md`; `b7e18b9b`. Actual canonical memory mutation/revocation control qualifies this narrow route; read-scenario, subject-scoped and deployed gaps remain. |
| Owned JSON derivatives | Independent review receipt committed | `implementation/package-maintenance-repair/runs/codex-go-20261007/owned-content-independent-review.json`; commit `d4b041fb`. |
| File finalization byte count | Independent review receipt committed | `implementation/package-maintenance-repair/runs/codex-go-20261007/finalized-size-independent-review.json`; commit `d450130f`. Dirty `packages/files/test/completion-byte-count.test.ts` is a separate uncommitted candidate and gets no acceptance credit. |

OAuth, bundle, fanout, owned JSON and finalization receipts were located by mapping the cited committed change to its package-maintenance review artifact. This is a source inventory, not a new review or whole-roadmap acceptance.

## Ownership signals for handoff discussion (no contested owner assigned)

| Path group | Current signal | Handoff status |
|---|---|---|
| `compiler/src/analysis/{types,resolve}.rs`, `compiler/tests/bdd_checked_facts.rs`, one `tests/codegen.rs` function | `owner-lease-status.json`: compiler completion root holds BDD fact writer through frozen independent review. Analysis files and BDD test are dirty/untracked. | Busy lease; root/coordinator must establish exact release and pin. |
| `compiler/src/codegen/{ir,js}.rs`, `compiler/tests/ui_adapter.rs` | Lease record says UI literal Card/unbound Tabs leaf frozen for independent review; current HEAD includes the scoped adapter commit. | Review exists for bounded adapter; broader enum/query/ordered/profile ownership is unresolved. |
| State guard, Cloudflare runtime/stdlib and stdlib assembly test | Lease record says scoped exports accepted at `b7e18b9b`, paths released; broader package invocation owner remains foreign. | Scoped paths released per record; broader invocation ownership remains unresolved. |
| `packages/files/src/upload/index.ts`, `packages/files/test/finalize-byte-count.test.ts`; `packages/interfaces/src/docs/reference.ts` and tests; `packages/ui/src/browser/{bootstrap,polling}.ts` | Dirty working-tree edits, with no ownership/review disposition established by this bounded source. | Candidate only; owner/lease and acceptance unresolved. |
| `docs/specification/DECISIONS.md`, `implementation/compiler-completion/README.md`, bookkeeping and shared Git | Dirty; roadmap state names existing package coordinator as shared Git/bookkeeping owner pending explicit handoff. | Preserve coordinator ownership; no handoff inferred. |

`owner-lease-status.json` reports pending UI final review at its update date while the later committed UI review receipt says bounded static adapter accepted. Preserve both as dated artifacts; root should reconcile their chronology/scope during ownership acceptance. Compiler README has later integrated status prose but explicitly says existing receipts precede later leaf edits and do not qualify future source. No owner conflict is resolved here.

## Draft source provenance

The captured outer `HEAD` tree contains `160000 commit a55a0f700f07f6f972d9d6091b0fdbceee399eb9 draft`; `.gitmodules` maps `draft` to `https://github.com/veighnsche/canlang-drafts.git`. `git ls-tree HEAD draft` supplies the gitlink evidence (`git show HEAD:draft` fails because gitlinks are not blobs). `git submodule status -- draft` prints `-a55a0f700f07f6f972d9d6091b0fdbceee399eb9 draft`, while the present nested checkout is on `main` at that same commit, tracks `origin/main`, and has clean status. Thus the current checkout has exact committed submodule provenance; Oct 7 evaluation wording describing draft as ignored-local is historical and should not be projected onto current state. This is an observation only; root owns classification and acceptance.

## Follow-up source pins and scoped receipts

At final follow-up capture, outer HEAD was `db57c3794d386fcd27f17f54b199272d58106a81`. The JSON records SHA256 for every then-dirty relevant compiler analysis/test, interfaces, and UI browser product file at that capture. These are current working-byte fingerprints only; each is explicitly marked candidate/non-accepted.

Additional package receipts located: `implementation/package-maintenance-repair/runs/codex-go-20261007/services-selected-independent-review.json` accepts the finite provider request byte-limit and cancel-identity actual caller scope (commit `a73df865`); `pkce-issuance-independent-review.json` reports PASS for the selected OAuth S256 issuance domain (commit `1eeedb6d`); and `loadability-terminators-independent-review.json` records a finite line-comment terminator review with a root disposition accepting exact lexical correctness only. None closes broader provider/OAuth/deployment workflows.
