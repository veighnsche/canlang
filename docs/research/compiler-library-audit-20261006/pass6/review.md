# Independent shared-input review

Sol high clean-room review received frozen requirements and actual source/callers/tests, without implementer conclusions or JEV verdicts. It inspected pinned library source and independently generated scratch probes. No repository writes by reviewer.

Initial P2: mapping final reader cursor/EOF after Serde container cleanup misanchored nested malformed strings (array raw LF12vs4, object16vs8, invalid escape11vs3, truncated invalid escape4vs3). Permanent regression first failed, then passed after first-error capture at seed/access/end boundaries. Native reason remains original; immediate EOF and custom depth entry are captured without a grammar/reason table. Equivalent Clippy polish uses inspect_err rather than identity map_err.

Exact final source SHA256 `6f6b067e3a57c4cb50596712cab981eea199c1774150b1b946042492685f4244`. Final12 scratch tests pass: four originally failing offsets;27 independent key/delimiter/whitespace/EOF cases;1,147 malformed mutations against original native error positions;1,440 prescribed legal numeric/context expectations;250,000 randomized baseline admission/render comparisons; mixed depths and200k-byte numeric text. Baseline differentials corroborate, not replace, independent expected admission/representation. Current permanent private tests also pass.

No actionable findings remain. Ordered decoded duplicates, first lookup, arbitrary raw legal numbers, strict key/value Unicode, separate lexical i64/exact signed-i32 IDs, real catalog/LSP mapping, unchanged features and parse-time depth protection hold. Glue is limited to cursor/first-error bookkeeping, representation visitors, numeric token classification/source slice and depth check; library owns grammar/Unicode.

Limits: Serde cleanup may scan whitespace/lookahead after rejection.65 object wrappers followed by1million spaces and1million-byte quoted payload consumed through openingquote while never visiting/materializing payload; erroroffset325 remains entry point. The66-byte bracket witness is specific, not a universal byte-consumption guarantee. Reader/lookahead/seed origins must be requalified on pinned-library upgrades. Changed public reason-field source users outside this unpublished crate remain unqualified.

Raw scratch source/log retained in `/private/tmp/pass6-independent-input-review/`; final log copied here, SHA256 `8432ac031adf85b4e0387de2a165e8b0369129fce25b1263d394f64a31aa96d9`. Native/Linux/footprint and production cost acceptance are root-owned and recorded separately.
