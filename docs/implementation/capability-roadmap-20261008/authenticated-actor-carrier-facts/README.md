# Authenticated actor carrier facts

**Factual preparation only.** DESIGN permits email facts on the current authenticated actor and denies a user/email directory. Generic public `UserRef` remains id-only. No enriched carrier, accessor, getter, branding or authority design is adopted.

Frozen public Values controls show `isUserRef` accepts an ordinary tagged user with enumerable extra facts; `same` compares id only. `makeMemberRef` copies those extras. Typed user/member encoding strips them; typed user decoding refuses extra wire properties. Standard `structuredClone` and raw JSON retain the extras.

| Boundary | Known result | Remaining qualification |
|---|---|---|
| User constructor | Frozen kind/id only | Authenticated facts require separate verified ownership |
| User recognition/equality | Extra keys accepted; equality remains id-based | Neither verifies email provenance |
| Member copy/alias | Public wrapper copies enumerable extras | No confinement/erasure guarantee from freeze |
| Typed user/member codec | Encode id-only; decode extras refuses | Prove actual consumers use type-directed codec |
| State field clone/store | General structuredClone/raw JSON paths | Conditional escape risk; no successful mutation claim |
| Return/replay/HTTP/MCP | Frozen result paths carry generic result to raw JSON | Actual enriched actor return/disclosure not executed |

Source `Principal` and `buildContext` already retain resolved authenticated email/emailVerified, while trusted context forces actor=null. This does not identify a safe public actor carrier. If enumerable facts reach a generic field/result, raw cloning/storage/serialization does not strip them merely because the typed user codec would.

The source map records boundary facts, uncertainty, and owner handoff. `control-results.json` records public Values and standard JavaScript observations; `control.mjs` is the narrow reusable control. The active live runtime/context writer was not read.

No product writes, State mutation, build, broad tests, JEV, Git mutation, decision/filetree changes or accepted policy. The authenticated-caller-only fact restriction remains an open qualification requirement.

Current committed observation is `b5f3f61c`; State pipeline differs from frozen source. Pipeline behavior statements here describe frozen paths and do not freshly qualify the current repair.
