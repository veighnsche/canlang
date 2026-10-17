# Selected mechanics retirement review

One remaining private mode was deleted in `eb9f91b`. Other accepted replacements already removed their superseded mechanics. No replay or blanket deletion was needed.

| Unit | Actual retirement | What remains and why |
| --- | --- | --- |
| N02 | already removed — Values finite number formatting; `a34aa16` | Can nonfinite/negative-zero spelling, carrier/domain/error checks |
| N03 | already removed — Four work number formatter copies; `bcaa5db; assembly5a4e827` | String versus JSON nonfinite policy, replay/order/UTF-16 decisions; allow(dead_code) is leaf-harness compatibility |
| N04 | already removed — Values concrete Rust-str escape loop; `36df46e` | UTF-16 truncation/unpaired-surrogate A04.5 remains partial; alias uses shared formatter |
| D02/D04 | already removed except mode — Regex import collection/rewrite/link scanning; `324d624` | Trusted producer mapping, authored import policy, real CommonJS loadability scanner |
| R02-cleanup | removed this step — Unused keepStrings=true link scan mode; `eb9f91b` | Active strings/comments blanking and CommonJS wrapper screening stay |
| D03 | already removed — Manual VLQ numeric decoder; `d078e9f` | Strict admission, signed32 restoration, encoded order, raw sources/lookup/error guards |
| I02 | already removed — Bulk base64url and hex codec loops; `b9aafe90` | Final-sextet tail alias compatibility, exact bearer text hashing, strict malformed domain |
| I03 | already removed — TS XOR comparison loops; `ace2c0e8` | Length/domain/error order, host native availability, derivation boundaries |
| I04 | already removed — Cookie header split/scan and serialization mechanics; `b9aafe90` | One parse, first target, once-only decoding, secure/default/attribute order policy |
| C02/C03 | already removed — Two independent CSV parsing loops; `b9aafe90;694cd0c6` | Raw text/counts/error policy, authoritative validity/consent/CSRF; C04 export escape/formula guards; deployed durable/browser mount still open |
| H01 | already removed — Manual signal listener fan-in; `6686bc76` | Owned deadline timer, first winning reason, abort identity and cleanup |
| H02 | already removed — Unbounded redirect arrayBuffer body bypass; `e2cdef83` | Quota bytes, same-origin/method/hop limits, cleanup/errors |

`json_token` is used by real rows/linkage/receipt decisions and registered conformance; its dead-code allowance serves the recovery-only copied leaf harness. The CommonJS scanner has a real `scanModuleIssues` caller and a separate policy responsibility; the import lexer cannot replace scope/free-binding checks. The base64 alphabet is only a final-sextet compatibility lookup, not the removed bulk codec. CSV export quoting and formula neutralization belong to the separately retained export contract.

32 exact source/fixture/dependency pins remain equal to their accepted source (`source-equivalence.json`). The changed bundler uses its renewed focused source check, not old acceptance. Exact mechanical diff and caller switch were reviewed by root after the finite Luna dispatch hit the agent limit. No separate reviewer, blanket package test or new installed/native/Wasm qualification is claimed.
