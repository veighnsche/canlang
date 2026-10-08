# C05P-policy: released policy

Defining writer: compiler/src/policy.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Typed records and a small layout-only Serde Formatter preserve root/row/nested indentation, inline arrays/objects, key order, omissions and verbatim predicates/source. The serializer retains one newline and the CLI retains its existing second newline. Extraction/authorization decisions remain unchanged. HTML embedding stays UI-owned.

## Qualification

Sol medium writer/review. Four fixed complete layout/CLI fixtures plus two unit tests pass. Fresh CLI output passes actual UI policyDumpSections and policyPage with independent role/model/invariant/operation/source expectations and HTML escaping; no skip occurred.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
