# C05R: released references

Defining writer: compiler/src/docs.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Typed ReferenceModel and nested reference values retain explicit camelCase keys and field order. catalogVersion and missing translation text remain explicit null; other absent options omit, while empty/false values remain. Defaults, constraints, examples and types remain authored source strings. Public to_json compatibility adapters use the existing parser on serialized output; production to_json_string serializes directly. Extraction, portable identity and hashing are unchanged.

## Qualification

Sol low writer; Sol medium independent and consumer review. Three fixed full-byte fixtures plus 29 extraction tests pass. Two integrated actual consumer tests pass without skips: fresh docs CLI launches actual built can-platform, localization/empty/null fallback/default spelling pass, and extracted typed JSON reaches the public reference Markdown renderer. The same test file also qualifies the policy family separately.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
