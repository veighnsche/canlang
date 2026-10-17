# Later-change attempt notes — Variant C

Same instructed subject: gpt-6.1-sol, medium. Read the pinned changes brief and the original C artifacts only; no other-variant artifacts, evaluation findings, JEV, delegates, live application source, compiler or platform edits. Parent feedback: no mandatory initial repair; retain ambiguity around fixture server-field overrides and exact validation catalogue. Original initial source and metadata remain unchanged. These are successive drafts and one later-change attempt with ordinary self-check, not a post-review repair.

## Change 1

Touched Request title caption, new nullable normalized archive_reason, archive evidence invariant/lock, archive operation/examples and request detail/action presentation. Title remains the same stored identity and max200; its generated input/output caption becomes “Request”. Existing CRUD fields stay title/note, so archive_reason cannot be supplied through ordinary CRUD or CSV.

`archive(request,reason)` requires the current owner of an open request and a nonempty trimmed reason, then sets the reason and calls the existing `Request.delete` in the same transaction. That canonical operation rechecks the original enabled assignment and ownership conditions. Archive still uses canonical metadata, receipts and stale version checking. One transaction reserves only one version increment despite set+call.

The cross-path final invariant requires every archived request to have a reason, and a conditional lock makes stored reason immutable once established. The generated default delete remains callable by the runtime registry but cannot successfully archive a normal open request on its own: it has no writable reason input and the final invariant rejects a reasonless archive. Browser binds the reason-bearing action; MCP exposes that same canonical scenario. No competing path can bypass the evidence rule. Disabling CRUD delete would also disable its documented delete effect/internal call, so no unsupported private-delete mode was invented.

Added expected trimmed-reason success/evidence/version, blank-reason rule failure, stale conflict, other-owner denial and direct reasonless delete denial. Fixture/example and final-invariant rejection codes remain shared-contract uncertainties. Existing archive records without reasons, if any, require explicit verified historical disposition before upgrade; no installed population or fabricated reason is assumed.

## Change 2

Touched Request stored schema, CRUD allowlist, duplicate-review signature, create/update examples, list/search/detail selectors and data transition notes. Added nullable max40 cost_centre; note becomes details everywhere while retaining its original optional/untrimmed semantics; title max becomes120. Added proposed overlong title/cost-centre rejection expectations. Existing readonly archive reason and original privacy remain.

`change-2/transition.md` is tied to the exact change-1 source hash. It distinguishes additive candidate, preserving rename and constraint narrowing, shows the supported migration directive with an explicitly unbound snapshot placeholder, and specifies complete-state validation. There is no executable migration declaration with a counterfeit compiler snapshot. Old open titles can be explicitly corrected under max200 before activation; an overlong archived title remains a blocker because the old contract offers no archive edit. This is a precise unresolved business/runtime boundary, not silent truncation.

## Change 3

Added only the canonical `steward` team role, ReviewGrant stored evidence/policy/locks/invariant, grant/revoke scenarios, their administrative page, and a read-policy clause restricted to department A. No broad request administrative right is granted by owner/steward or by grant management. Existing Employee administration remains owner-only. No broad reviewer role directly grants request access; effective permission comes from a current nonrevoked grant and now < until inside the same Request policy.

Granting requires owner or steward, a current team member and an explicit future expiry. Identity/expiry/grantor/time are locked; revocation stores actor/time and locks those once revoked. Multiple grants are historical records: revoking one does not revoke another still-effective grant. The scope must cease by revoking every effective grant or by their expiry. This is a reasonable explicit policy assumption; no permanent role grant, grant extension/update or unrecorded renewal was introduced. The revoke page lists individual grants, preserving attribution.

All browser lists/search/details, `browse`, duplicate review, generated model/scenario exports and MCP retain the single Request read policy. Current `members` admission plus active membership checks on issue prevents a departed reviewer from receiving new reads, without a historic active-member invariant that would invalidate evidence after departure. Grants remain historical evidence on removal; rejoining before expiry would reactivate an unrevoked grant, so revoke if that should not occur. No source-specific cached grant or UI/MCP policy copy was authored.

Added proposed before-expiry, exact-expiry, after-expiry, revoked and other-department read expectations, plus reviewer update/archive denial and owner/steward revocation attribution. Test expressions use the existing `now` contextual instant rather than inventing an envelope clock override. Availability of that contextual clock in seeded example-cell evaluation is not explicitly confirmed by a runner; preserve this as a shared fixture-runner uncertainty. Independent expected outcomes are: at expiry, the temporary grant contributes zero scope; revoked grants contribute zero scope; department B never enters this grant; own/manager scopes remain independently effective.

Revocation takes effect on every new admission. Already admitted reads may complete under the pinned admission/fence contract. Shared browser grant rechecks must remove now-unreadable private content rather than retain it as unsaved state. No execution or instantaneous cancellation of an already-authorized operation is claimed.

## Checks and limits

Existing syntax prototype invoked once for all three successive sources; each stops at the already-documented unsupported `import=csv` form attribute (change1 line78, change2 line83, change3 line116). No attempt was made to remove normative CSV functionality to gain a parse result. Full semantic/example/UI/MCP/CSV/migration/scale/security execution remains unavailable and unclaimed. The parser stops before the final administrative pages, so their syntax is not established by that invocation.

The initial feedback uncertainties are retained: fixture overrides of server-owned values, structured validation catalogue versus exact example codes, normalized query constraints and test result/clock semantics need the shared semantic checker/runner. Final archive-invariant rejection is expected as safe business `rule_failed`, but its exact code is not separately specified by the frozen invariant contract. These draft expectations expose that uncertainty instead of implementing a substitute validator.

No real installed snapshot, predecessor population, migration activation, role assignment, reviewer clock, grant revocation or hosted system was fabricated. Source/context byte hashes and observed timings are evidence; hidden token usage and missing billing totals remain null.
