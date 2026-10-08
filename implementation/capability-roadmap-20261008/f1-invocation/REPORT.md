# SEQ-009 bounded qualification, before repair

**Partial qualification only; SEQ-009 and parent F1 remain open.** The recorded run exercised 35 runtime vectors and 42 checks: 38 passed, with four failures tied to nullable-reference creation and dependent success replay. Separate controls exposed a public-facade import failure and two arithmetic-control preload failures. The unchanged `Bounded` CLI artifact and a complete `MemberControl` control were run through production assembly, invoker, State admission, generated CRUD/scenario paths, and local persisted Miniflare D1. CRUD used actual generated descriptors and executor; emitted scenario handlers executed ordered transitions and the late guard. Identity resolution was real, backed by a test memory identity store. D1 dispose/reopen recreated the invoker but kept the host process alive.

The bounded route passed scalar defaults, supplied versioned references, authorized update, ordered machine transitions, duplicate replay, stale-reference and wrong-model controls, anonymous/wrong-team denials, late-failure rollback, managed-state bypass checks, and persisted D1 replay. A read-only check returned the known Job projection without changing SQL state. These results do not establish deployed identity, cross-owner storage routing, host-crash recovery, source-declared selector/secrecy variants, or whole original-app behavior.

## Recorded failures and open functionality

- The public stdlib façade lacks `create`, `set`, and `deleteRecord` imported by the unchanged artifact; preload fails before mutation.
- Nullable `account` creation fills null but pipeline ref checking rejects it. Explicit null also fails closed ref admission. This produced the four failed checks, including dependent success replay.
- The numeric control compiles `job.count + 1` to an `int64` expression but cannot preload with either tested peer surface. Expected arithmetic result 2 is unqualified. In the bounded CRUD result, `count` remains wire string `"1"`; typed integer arithmetic and validation are not established.
- Wrong-owner storage selection, emitted containment scope, generated hooks/locks/invariants, broader actor/time/trusted-context lowering, duration metadata, and complete original apps remain open.
- Void result replay representation, durable production database, installed/provider behavior, and broader SEQ-008 metadata behavior are not qualified here.

Package builds for the selected frozen identity, UI, stdlib, and Cloudflare module closure succeeded with their owning-package dependencies. Earlier broad build attempts failed from missing package-local dependencies and an overly broad include; they were not treated as package regressions. No repair or JEV decision was made in this slice.
