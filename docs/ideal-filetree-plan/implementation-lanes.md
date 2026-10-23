# Parallel lanes and dependency critical path

Capacity available to the audit was coordinator plus three workers. These are **future implementation roles**, not running jobs or a scheduler. Use actual available capacity when work is selected. Each original physical file has one active writer; reviewers may inspect any file.

| Lane | First independent ready packet | Next released packet / reservations |
| --- | --- | --- |
| A — language | LANG-01 grammar/prototype/editor contract alignment | LANG-03 codegen proof context; LANG-02 CLI command split can be another released lane if no shared source writer; LANG-05 only after currency error contract |
| B — State | RT-M2 closed query ordering or RT-M1 closed plan codec | RT-M3 independent invocation projection, but release `invocation/index.ts` through coordinator. RT-C1 cannot touch scenario-receipt concurrently with M1. |
| C — platform/UI | P-CI ordinary regression discovery or P-UI neutral helper | P-ERRORS only with exclusive invoke.ts; P-CODEC/P-RETIRE remain gated; ROOT-POLICY requires mapped actual lifecycle subjects before guard activation. |
| Coordinator | Shared inventory/contracts/import/export/distribution integration and small handoffs | Own root manifests/locks, codegen/mod.rs coordination, State index, PINNED_RUNTIME_FILES, common fixtures, package/TS includes, build/install selectors. No independent copying of owners or parallel edits to the same file. |

## Required output DAG

- LANG-01 and P-CI have no global source-extraction prerequisite.
- RT-M1 emits one plan codec → its native source-plan/actual handler verification; only its actual file release permits RT-C1 on that monolith. RT-M2 is independent. RT-M3 needs an exclusive short index-export handoff, not completion of M1's entire verification campaign.
- LANG-03 needs the complete existing constructor/comparison/import closure and one codegen root writer; no LANG-02 dependency. CLI and dev worker extractions are distinct crates/owners.
- ROOT-POLICY: map legacy markers and real subject coverage → actual lifecycle integration/meaningful retention → retire forbidden source placement → enable shared dev-server/build.rs guard → normal build/discovery. The hook is not activated against an unresolved legacy tree. LANG-04 and this packet share owner.rs; release it rather than edit separate hunks concurrently.
- P-ERRORS and any future RT-C1/P-CODEC/P-RETIRE host edits share invoke.ts and pinned/installed payload ownership. Native claim/guard/source-definition closure remains indivisible until an actual compatible private handoff is specified.
- Unreviewed provider/migration/browser/draft branches gate only their dependent correctness/retirement assertions, not all ready packets. No artificial repository-wide refactor barrier.

## Verification progression and resources

M: preserve current functions and public identity. C: name the exact corrected requirement and negative case. V: start with actual bounded owner behavior and forged/stale/error cases; close imports/type/module/fixture and source checks; then affected integrated graph and installed payload; finally actual native/Worker/browser/provider journeys where authorized and relevant. Do not broaden or repeat merely because files moved.

Give compiler/catalog generation, package dist writes and heavyweight native/browser fixtures one resource operator per checkout/cache. Never rebuild dist while its Node-backed native runtime checks are consuming it. Reuse compatible caches and unchanged evidence; installed/native claims need their real matching bytes and bindings. Unit tests remain banned; use existing meaningful integration/e2e subjects, not tests that mirror moved helpers. No elapsed-time promise derives from path/line counts.
