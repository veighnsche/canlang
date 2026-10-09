# Synchronous guard export outcome

Commit `b7e18b9b` moves the original synchronous `require` and `hasRole` bodies to the supported `@canlang/state/effects/guards` subpath. Cloudflare compatibility exports and the stdlib facade expose the same function objects through the existing acyclic dependencies. The structural readonly handler context preserves existing callers. The asynchronous role API remains separate at `@canlang/state/policy/roles`; the State root exports `MembershipReader` as a type, not a runtime `hasRole` value.

The owning source and behavior checks remain in `packages/state/src/effects/guards.ts`, `packages/state/test/effects/guards.test.ts`, `packages/stdlib/test/assembly.test.ts`, and `compiler/tests/selected_calls.rs` with `compiler/tests/fixtures/selected-call-consumer.mjs`. No build, test or runtime entry point uses the removed historical packet.

At acceptance, the focused guard/facade checks passed 8/8, and the generated mutation consumer passed through canonical memory admission: member commit/replay, handler `rule_failed` rejection/replay and live membership removal. Admission denial is reevaluated: restoring membership can admit the same previously admission-denied operation ID. An immediate repeated admission denial did not establish a permanently stored rejection receipt. These are historical outcomes, not a new run or a durable deployment result.

The earlier control exposed a read-scenario admission restriction and two legacy model-policy fixture failures; it did not qualify those profiles. Defined-subject synchronous role tests retain their explicit unsupported error. Wider durable/deployed application coverage was outside this export change. A separate UI control located the former card failure at the missing `CardProps.title`, downstream of an undefined title; it did not warrant a message-factory change.

The selected-call consumer already moved into permanent compiler fixtures. Historical selected-call checks accepted selected/alias/same-arity and awaited scenario calls, refused impure derives with E3010, missing/malformed format and arity/slot errors with E3005, and unresolved names with E2001. The then-unjoined named localized format reported E6008; this cleanup makes no current formatter claim.

Three original advisory requests and responses remain in `../guard-policy`, with uncertainty in `assessment.json`: all favored the State subpath, confidence .70/.97/.95, with no returned rationale. Earlier wording incorrectly suggested a State-root async export; the supported subpath correction above is authoritative. Advice did not qualify authentication or receipt mapping.

The redundant nested review/recheck trees, generated snapshots, repeated logs, copied patches, verification scripts, receipt copies and hash-pin chains were removed. Existing behavior results were reused; no tests or replacement verification packet were created for this documentation cleanup.
