# Narrow nullable singular-reference repair

Four State sources now carry checked singular-reference nullability through loader association and current/prepared admission. Pipeline checking accepts null only for an own top-level explicitly nullable singular field. Contracts, the Values stamp, `state-generated/v1`, compiler/artifact, version checks, reference arrays, and generic default policy are unchanged.

The private State build/typecheck and seven owning suites passed **97/97**. The actual unchanged `Bounded` artifact ran through production assembly, invoker, canonical State, Cloudflare runtime peer, and local Miniflare D1. The final run passed **30/31** checks: all nullable create, clear, replay, and reopen controls passed. Identity resolution was real, with a test memory identity store. It confirmed omitted-null defaults, explicit-null handling, ref preservation/clearing, ordered transitions, safe public read projection, matching retries, and same-directory D1 dispose/reopen replay.

The sole remaining failed check is void-result replay representation: the immediate result is `undefined`, while persisted replay returns `null`. This predates the repair. The first after-run read assertion also expected flattened fields and string versions; the final check uses the actual numeric version and `StoredRow.data` shape. Persisted `count` remains string `"1"`; typed integer semantics remain unqualified.

Other open areas include public stdlib import linkage, duration metadata, selectors/secrecy, generated hooks/locks/invariants, installed identity, owner storage routing, external process restart, and complete original apps. This bounded repair does not close SEQ-008, SEQ-009, or parent F1.
