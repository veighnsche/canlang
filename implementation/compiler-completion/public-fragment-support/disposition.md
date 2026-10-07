# Public descriptor/fix fragments: RETAIN

Submitted for root's independent review of `integration:public-descriptor-fix-fragments`. Retain all current public entrypoints and their implementation. **0 production lines added, 0 deleted, 0 net deleted; 0 supported mechanisms retired.** This resolves the finite packet under the root's preserve-current-public-interfaces policy. No source/API/dependency/package/Git/shared-decision change is selected. No new support release, serializer, wrapper, conditional-removal implementation or consequential design alternative is proposed.

The inherited Step 6 audit is explicitly historical: its compiler pin is `1fd07722090fe70228a6b661e3c6e136275ca84b`, not this checkout. Current `inventory.json` pins the inspected files and 107 compiler source/test/manifest inputs; `root-test-reuse.json` separately verifies **all 117** inputs in root's current admission-temporal freeze. Every root input matches. This does not turn an older audit execution into current execution.

## Exact surface and current callers

`inventory.py` reproduces exact helper bodies/ranges: eleven inherent JS `to_json` methods plus `models_json`, **12 helpers / 41 inclusive body lines** (eleven 3-line bodies plus the 8-line static initializer), and three lint string wrappers, **9 body lines**. Public exports are `lib.rs::codegen` → `codegen/mod.rs::js` and `lib.rs::lint` → `lint/mod.rs::driver`. `publish=false` does not retract these reachable Rust interfaces. Here “unused” means no current compiler production caller to the helper, not no tests or no supported public contract.

| Entry | Current internal direct caller/control |
| --- | --- |
| JsNominalLeaf::to_json | None found; nominal leaves serialized as nested typed data in delivery controls |
| JsNominalResult::to_json | None found; nested typed data in delivery controls |
| JsDeliveryDescriptor::to_json | typed_descriptors::nested_delivery_and_nominal_order; codegen delivery helper/model/input tests |
| JsMcpField::to_json | typed_descriptors delivery/tag controls; codegen typed input field tests |
| JsServerInit::to_json | typed_descriptors::all_tags_and_defaults_are_closed; all four static tokens compared with typed enum output |
| JsFieldDefault::to_json | typed_descriptors tag/default controls; codegen literal/parent/server/structural-default/server-init tests |
| JsOperationField::to_json | typed_descriptors::operation_order_omissions_and_present_empty_metadata; codegen D03 metadata tests |
| JsOperation::to_json | None found; typed operation slice controls invoke live operations_json instead |
| JsModelFieldType::to_json | typed_descriptors tag/delivery controls; codegen typed stored-field tests |
| JsModelField::to_json | None found; nested typed model controls cover field shape |
| JsModel::to_json | typed_descriptors::model_order_optional_members_and_array_false |
| models_json | typed_descriptors::model_order_optional_members_and_array_false only |
| fix_to_json | typed_fixes::fix_field_order_controls_unicode_and_u32_bounds; b3_s4 safe-fix contract control |
| fixes_to_json | typed_fixes::fix_list_is_ordered_and_empty_is_brackets; b3_s4 safe-fix control |
| rejected_to_json | typed_fixes::every_rejection_variant_has_fixed_order_and_span_shape; b3_s4 stale refusal control |

No target helper has a current production caller. The complete bounded search is saved in `caller-search.txt`: every owning-type reference, free-helper/import reference, and `.to_json(` candidate in compiler Rust code. Owning JS types occur in production only in js.rs/artifact.rs; their bodies serialize directly and never call the eleven methods/models_json. All target method callers are in typed_descriptors.rs/codegen.rs; `.to_json` candidates in docs/foundation/typed_references belong to other types. Fix wrappers occur only at their declarations and the two named test files. This is a source-challenged lexical inventory, not a compiler-generated call graph or evidence that unknown external users do not exist. Exact call-site line evidence is retained rather than equating nested serializer callbacks with calls to a public string helper.

## Owning typed routes that stay live

Ten JS methods and models_json call private `descriptor_json` → `json::to_compact_string` → shared Serde compact formatter/compatible string escaping. JsServerInit::to_json returns the four quoted tokens directly. Typed derives/manual Serialize implementations own field order, enum tags and omission. JsFieldDefault::Literal parses its supplied string to RawValue before serializing; invalid public literal fragments produce serialization failure, and the infallible descriptor adapter panics with `descriptor JSON serialization invariant`. There is no silent empty/null fallback.

The same serializers serve real typed routes: `codegen::emit` → IR build → js::emit_program → artifact::assemble, which clones operation DTOs and collects model DTOs. `cli::run_compile` → codegen::to_json_string → artifact::to_json constructs ArtifactWire borrowing `artifact.operations` and `artifact.models`, then serializes the entire envelope directly. Emitter::emit_can_app invokes **operations_json** at js.rs:5735 for its runtime registry literal; that helper is live and outside this target. `literal_json`, machine serialization, domain DTOs, manual Serialize implementations and the default representation bridge are also outside this target. The public models_json comment's “rendered only by the artifact envelope” is a shape/ownership description: the current envelope borrows typed models and does not call models_json.

Named first-consumer source boundary is cloudflare/runtime/artifact.ts::loadArtifactFile → parseArtifactText, with operation input admission and model machine checks against contracts/artifact.ts. It consumes the full artifact, not Rust helper entrypoints. Source routing alone does not prove every model/default/runtime workflow executes. No new package source or bundle was produced or qualified here.

The fix wrappers independently serialize LintFix, `[LintFix]` and FixRejected through the same JSON owner, with their respective existing expect messages. LintFix's typed wire owns rule/title/file/span/expected_sha256/replacement order and omits the span's SourceId from its nested range. FixRejected owns status/reason plus stale hashes, invalid bounds or overlap ranges. `cli::run_lint` reads/analyzes before lint/collect_fixes, returns early for analysis errors/missing program, and serializes a typed LintOutput with flattened diagnostics and borrowed fixes only when `--fix --format=json`; one final newline is added by CLI. No fix wrapper participates in that path. Collection ordering, content-hash/range/overlap refusal and application behavior are existing owning policies; neither serializers nor this disposition revise them.

## Same-outcome comparison

| Alternative | Public and owning-contract result | Complete target result |
| --- | --- | --- |
| Retain (selected) | All 15 entrypoints, exact bytes and error policy remain; live typed routes keep the same owner | 50 target body lines remain; added/deleted/net0; no support change |
| Remove methods and free wrappers | Typed production routes can remain, but 15 reachable supported functions disappear and test callers break | Nominal target deletes50 body lines before surrounding cleanup, but fails the frozen compatibility gate; no accepted net saving |
| Keep compatible forwarding methods or move them to another owner | Preserves current syntax/signatures, static return type and failure behavior | Supported entrypoints remain; moving bodies is not retirement, replacement/import/facade lines count across owners; no qualified mechanism reduction |
| Replace serializers or remove domain DTOs | Must reproduce complete live artifact, registry, fix envelope, exact default and public fragment contracts | Broader than this target; no compatible qualified candidate exists; deleting necessary typed owners is not a support-helper saving |

The inherited gate is conditional retirement of the named public helpers. Its current target is **unattainable under the selected stable interface contract without an unapproved public break/API support release**. Minifying or macro-generating declarations could alter physical text but would leave the same supported helper mechanisms, and no such candidate is selected. The existing implementation already uses a single shared serializer; inventing another serializer or compatibility layer cannot qualify retirement merely by relocating these lines. This is a finite retain disposition, not an indefinite plan to delete allegedly unused code.

## Evidence reuse, checks and gaps

Existing docs-support and map-support retention packets were compared to avoid another generic serializer/profile investigation. Step 6 supplies the historic target and Step 10 serialization notes supply earlier scoped findings, not current executable results. Root's **current matched-input** suite already exercised the actual public controls: typed_descriptors **6/6**, typed_fixes **4/4**, typed_fixes_cli **1/1**. `reuse-evidence.py` asserts every root input hash and extracts only those raw result blocks into `root-test-excerpt.log`. No cargo command, build, suite, new harness, network or price query ran for this packet. No whole-suite result is inferred from this excerpt; root owns integration acceptance.

Descriptor fixed strings cover nested nominal order, all closed tags and four initializer tokens, Unicode/control/quote/backslash escaping, exact integer/decimal/duration/money strings, object/array order and null, false nullable omission versus required false and array.required=false presence, absent versus empty descriptions/parent, model uniqueKeys/scope omission, and invalid raw literal typed serialization rejection. Leaf nominal, operation, and model-field helpers without direct controls remain explicitly identified; nested typed tests are not claimed as direct invocation of those wrappers.

Fix fixed strings cover every refusal variant/key order, Unicode/controls, empty strings/list, preserved slice order and u32 boundaries. The real lint CLI test uses the built CLI on a clean empty app, checks exact envelope key order, empty diagnostics, absent versus present-empty fixes and one newline, then checks the full `--fix` bytes equal the observed no-fix envelope plus the final fixes member. This is an actual consuming-route control with empty fixes, not an independent fixed golden for every envelope member or a nonempty CLI fix witness. The constructed Envelope in typed_fixes is only a typed serialization control, not a substitute CLI/product consumer.

These are exact helper/typed-owner controls plus the named real lint CLI consumer. They do not qualify a full original application, arbitrary external clients, generated artifact runtime/UI acceptance, every malformed public carrier, other hosts, performance/size or every downstream consumer. Retention needs no new API alternative or JEV support-policy choice. Root owns independent medium review and shared coverage/DECISIONS bookkeeping after acceptance.
