# Candidate list with caller evidence

Source `4659b9477173e9ff423d2b4d8f1d1a19c8c2d007`; planning only. All changes require future implementation authorization and the stated qualification. These are review families, not a new accepted task ledger. DR08 is an alias of DC-01. Full structured details, negative witnesses and limits are in [candidates.jsonl](candidates.jsonl).

## DC-01 — Identical interfaces sorted JSON serializers

Disposition: **consolidate**. Source: [packages/interfaces/src/http/csv.ts:165–174](../../../../packages/interfaces/src/http/csv.ts).

Caller evidence: HTTP optional csv route (http/routes.ts:151-152) -> csv handler -> reviewCsvRows(http/csv.ts:232-273) -> canonicalJson for duplicate inputs and consent digest HTTP optional exports route (http/routes.ts:155-156) -> export handler -> projectExportCell(http/export.ts:148-156), export review digest(:429) -> canonicalJson Comfy mapping substituteGraph(media/mapping.ts:125) -> digestGraph(:74) -> stableStringify; state replay hashing -> hashInputs(invocation/replay.ts:65) -> stableStringify

Maintenance effect: One interfaces-owned pure helper removes exact parallel recursive implementations and makes fixes singular. Cross-package sharing offers further scan reuse only after separate domains qualify.

Qualification/retirement gates: Preserve exact existing supported-domain bytes, comparison order and UTF8/hash namespaces; qualify inputs for each owner; unresolved historical/getter/toJSON policy is future design gate. Prefer same-package helper first; no selected new serialization contract.

## DR01 — Private shared SQLite query and row leaves; keep backend execution separate

Disposition: **consolidate**. Source: [packages/state/src/storage/d1.ts:96–114](../../../../packages/state/src/storage/d1.ts); [packages/state/src/storage/durable-object.ts:106–124](../../../../packages/state/src/storage/durable-object.ts); [packages/state/src/storage/d1.ts:127–136](../../../../packages/state/src/storage/d1.ts). Other exact sites remain in the structured record.

Caller evidence: D1 createD1Storage:630 -> read/query:641,658-667 -> toStoredRow/compilePredicate/compileOrder. DO read/query:1151,1168-1177 uses corresponding leaves. D1 receipt/outbox/history/progress/staging/failure reads:901,913,945,964,983,1403; DO:1227,1239,1273,1295,1314,1497. Publish merge D1:1072/DO:893. state storage/d1 and storage/durable-object package subpaths; migration adapter/storage suites exercise owning adapters; Cloudflare buildProductionDeps loads real D1 producer.

Maintenance effect: Two maintained SQL predicate/order and record codecs plus corresponding receipt/outbox/history/migration decoders and metadata merge. Each backend keeps own factory/IO/transaction implementation and imports same small pure storage leaves; less drift without reducing runtime backend obligations.

Qualification/retirement gates: Keep exported factory/ensure/schema APIs; private shared storage leaves do not require new public query framework. Check row structural signatures, column constants, COLUMN_FIELDS, FIELD_NAME and bindValue together, not bodies alone. All used constants match in inspected query excerpts; backend transaction/IO domain not claimed equivalent.

## DR03 — One UI appearance projection rather than ten private copies

Disposition: **consolidate**. Source: [packages/ui/src/collections.ts:819–840](../../../../packages/ui/src/collections.ts); [packages/ui/src/controls.ts:100–121](../../../../packages/ui/src/controls.ts); [packages/ui/src/groups.ts:74–95](../../../../packages/ui/src/groups.ts). Other exact sites remain in the structured record.

Caller evidence: Ten word modules pick tone/size/variant/orientation then call appearanceClasses(word, class, picked); controls:385 onward; collections:853,976. appearance.ts:29 owns catalog matrix validation. groups/panels idAttr also exact token seed (115-123 /108-116); uses escapeAttr and optional ID context.

Maintenance effect: Ten ~22-line projection functions require repeated maintenance. Single projection import, same caller argument and validation owner. Strong maintenance decrease; per-call runtime complexity unchanged.

Qualification/retirement gates: Private helper near appearance owner; retain per-word catalog IDs/class names/public renderer props. For optional idAttr seed keep tiny helper local unless renderer import graph/caller benefit warrants sharing; do not turn projection family into utility framework. Repeated props[key] reads invoke getters twice for defined tokens; preserve read count/order/inherited access and error propagation. Typed props are not proof all runtime inputs plain. Projection adds no sanitization/descriptor stripping.

## DR04 — Share control/form draft value leaves; retain render composition

Disposition: **consolidate**. Source: [packages/ui/src/controls.ts:128–144](../../../../packages/ui/src/controls.ts); [packages/ui/src/forms.ts:216–232](../../../../packages/ui/src/forms.ts); [packages/ui/src/controls.ts:188–210](../../../../packages/ui/src/controls.ts). Other exact sites remain in the structured record.

Caller evidence: controls int/decimal/money -> numericFieldValue:252-259 -> input control; dateFieldValue used input/calendar:412,899. forms equivalent leaves consumed renderField; rawText appears in field/outcome display. Both types are FormFieldDef imported through same UI owner; same current regex names need exact constants checked before extraction.

Maintenance effect: Duplicate conversion/date validity/raw display implementation across complete forms and individual controls. Private draft-value module exports selected exact leaves; both render routes keep current calls/layout/error outlets. Caller structure unchanged, maintenance body count reduced.

Qualification/retirement gates: Keep public renderer exports and FormFieldDef contract, messages naming field.path, submitted names/IDs and draft ownership. Primitive leaf consolidation is separate from formatter/date timezone policy or forms composition; no generic field renderer framework. Both current INT_RE/DECIMAL_RE/DATE_RE definitions match source; preserve getters on field.value/path, conversion side effects and exact TypeError identity/message. rawText catches stringify failure but fallback String can itself throw; no universal no-throw claim.

## DR05 — One safe UI business-error digest with public compatibility names

Disposition: **consolidate**. Source: [packages/ui/src/browser/export.ts:71–100](../../../../packages/ui/src/browser/export.ts); [packages/ui/src/csv/parse.ts:66–95](../../../../packages/ui/src/csv/parse.ts).

Caller evidence: UI export:334 and print:84 call digestExportError; CSV preview:132,400 and confirm:175,444 call digestBusinessError. UI index.ts:387 exports CSV digest; browser/export subpath exposes export digest; both interfaces structurally code/message/fields/retryable.

Maintenance effect: Two identical ~30-line input digests and local isRecord predicates. Small browser-safe digest owner; callers/public names unchanged, duplicate implementation retired.

Qualification/retirement gates: Keep both exported function/type names as aliases/delegates and browser-safe dependency closure. Place shared leaf away from full CSV parser/browser IO to avoid pulling csv-parse or network handlers into export browser path.

## DC-02 — Playback mirrors services script admission and types

Disposition: **consolidate**. Source: [packages/testkit/src/fixtures/playback.ts:45–125](../../../../packages/testkit/src/fixtures/playback.ts); [packages/testkit/src/fixtures/playback.ts:203–566](../../../../packages/testkit/src/fixtures/playback.ts); [packages/testkit/src/fixtures/playback.ts:601–688](../../../../packages/testkit/src/fixtures/playback.ts).

Caller evidence: testkit fixture playback-worker.ts:26,43 -> createPlaybackHandler(playback.ts:1158-1164) -> checkSeedTable(:616) -> mirrored mail/models/judgments/media checkers services/test/scenarios.test.ts:69 and testkit/test/playback.test.ts:516 -> services parseScenarioTable(scenarios.ts:480) -> provider script validators; scenarios.ts:942 only freezes authored tables. testkit/test/playback.test.ts:515 -> controlled services endpoint, differential suite; existing tests preserve adapter-vs-playback parity

Maintenance effect: Remove independently maintained mirror types, provider/key grammar and script validators (~400 lines) while retaining distinct transport implementations. Shared pure admission saves actual duplicate per-consumer rules.

Qualification/retirement gates: Factor/qualify portable script-admission slice or prove existing emitted subpath Worker-safe; retain public error mapping. Check dependency/distribution ownership before adopting runtime import; no build/install run in audit.

## DD-001 — Retire duplicate host Bun/catalog bodies behind existing bundle exports

Disposition: **consolidate**. Source: [packages/cloudflare/src/preparation/build-adapter.ts:60–168](../../../../packages/cloudflare/src/preparation/build-adapter.ts); [packages/cloudflare/src/preparation/build-adapter.ts:195–208](../../../../packages/cloudflare/src/preparation/build-adapter.ts).

Caller evidence: TS CLI deploy -> host.runPreparedDeploy (host.ts:362) -> buildBundleWithHostPhases -> buildDeployBundle -> exported buildMcpBundle/buildHttpOperationsBundle/buildDerivedInputsModule (bundle.ts:961-968). Explicit adapter runMcpBunPhase/runCatalogPhase observed in preparation-protocol.test.ts:186-200; no normal CLI explicit-phase caller. build-adapter imports bundle already.

Maintenance effect: Three copied selected adapter bodies spanning 123 physical source lines including syntax (60-168 and195-208), plus two distinct phase wrappers. This is source-range accounting, not projected savings. Adapter delegates to three existing exports; keep phase pairing and stage order. No generic new bundler layer needed.

Qualification/retirement gates: Confirm C04.preparation-join acceptance/ownership of existing exports; separate consolidation authorization from native adoption. Preserve shell-free flags, exact errors, marker checks, no phase before worker gate, catalog after artifact render, cleanup and installed producer resolution.

## DR11 — Consolidate private violation append mechanics

Disposition: **consolidate**. Source: [packages/values/src/internal/schema-core.ts:260–282](../../../../packages/values/src/internal/schema-core.ts); [packages/values/src/internal/wire-core.ts:148–175](../../../../packages/values/src/internal/wire-core.ts).

Caller evidence: [packages/values/src/internal/schema-core.ts:437–453](../../../../packages/values/src/internal/schema-core.ts): ordered schema field failures append in traversal [packages/values/src/internal/wire-core.ts:248–275](../../../../packages/values/src/internal/wire-core.ts): required/unknown/type appends at owning validation sites [packages/values/src/schema.ts:26](../../../../packages/values/src/schema.ts): public facade -> canonical schema core [packages/values/src/wire.ts:6–12](../../../../packages/values/src/wire.ts): public conversion -> wire core

Maintenance effect: One small internal helper with structural {readonly violations: Violation[]} input keeps both call signatures while removing exact duplicate object construction/frozen-path logic. It does not create a new validator, collector registry, or error framework.

Qualification/retirement gates: Keep append synchronous at same owning call sites, with no sorting/deduplication/early throwing. Preserve frozen path copy, field insertion order, absent optional properties, exact condition: actual is omitted if expected is undefined even if actual supplied. Shared helper must import types only and no schema/wire runtime to avoid cycle.

## DR12 — Share Gregorian calendar leaves without an import cycle

Disposition: **consolidate**. Source: [packages/values/src/kinds.ts:82–106](../../../../packages/values/src/kinds.ts); [packages/values/src/temporal.ts:58–82](../../../../packages/values/src/temporal.ts); [packages/values/src/kinds.ts:154–159](../../../../packages/values/src/kinds.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/values/src/kinds.ts:108–136](../../../../packages/values/src/kinds.ts): date admission/makeDate uses bounds [packages/values/src/temporal.ts:203](../../../../packages/values/src/temporal.ts): date parse checks month/day [packages/values/src/temporal.ts:242](../../../../packages/values/src/temporal.ts): datetime parse checks calendar [packages/values/src/temporal.ts:321](../../../../packages/values/src/temporal.ts): add_months clamps to month length

Maintenance effect: Import two no-dependency functions from one internal civil-calendar leaf; caller argument lists unchanged, one table/leap rule maintained. Do not import temporal into kinds or add constructor/error policy to helper.

Qualification/retirement gates: Preserve proleptic Gregorian arithmetic and default invalid-month result 0, including numeric coercion/NaN behavior if internal misuse remains observable. Leaf has no runtime import of kinds/temporal/errors; preserve caller-owned range/integer checks and month-clamping order. Existing duplicated datetime constants may be separately reviewed, not silently included in this bounded helper move.

## DR06 — Share prepared binding-entry projection; retain HTTP/MCP orchestration

Disposition: **consolidate**. Source: [packages/interfaces/src/envelope/prepared.ts:90–101](../../../../packages/interfaces/src/envelope/prepared.ts); [packages/interfaces/src/mcp/prepared.ts:95–106](../../../../packages/interfaces/src/mcp/prepared.ts).

Caller evidence: envelope.prepareHttpPlan:125 maps derived inputs; CSV review/http.csv:232 uses prepared HTTP plan. mcp.prepareMcpPlan:145 maps derived inputs; owned-mcp tests observed, current server ordinary orchestration still live; DD-010 covers adoption/relocation.

Maintenance effect: Exact freeze projection + same four-way deferralFor duplicated. One projection helper; both profile builders retain allowed/ref/order/mutation behavior. Small reduction with no new executable validator.

Qualification/retirement gates: Extract private common preparation leaf; keep profile/type public obligations and same derived identity. MCP SDK provenance stays deferred; sharing projection does not adopt prepared MCP in server.

## DR07 — Share exact request object/Bearer lexical leaves; keep route auth policies

Disposition: **consolidate**. Source: [packages/interfaces/src/http/csv.ts:311–321](../../../../packages/interfaces/src/http/csv.ts); [packages/interfaces/src/http/export.ts:284–294](../../../../packages/interfaces/src/http/export.ts); [packages/interfaces/src/mcp/server.ts:94–101](../../../../packages/interfaces/src/mcp/server.ts). Other exact sites remain in the structured record.

Caller evidence: HTTP CSV body parser invoked request handlers; export body parser used export route; uploads parser:184-194 has same policy with literal application/json rather than shared constant. MCP resolveGrantIdentity calls bearerToken; uploads resolveCaller:144 uses same extractor before grant-versus-cookie selection.

Maintenance effect: Duplicate ~10-line body gate and ~8-line bearer split. Two private HTTP/auth leaves called at existing positions. Removes duplicate parsing implementations; no unified auth/router framework.

Qualification/retirement gates: Preserve IdentityError instance from owning import, content-type then bounded parseJsonBody then object-shape order. Keep upload caller grant/cookie/CSRF/audience policy and MCP 401/challenge independently; shared extractor only returns token/null.

## DC-03 — Services mail harness resides in production port module

Disposition: **simplify**. Source: [packages/services/src/ports.ts:173–466](../../../../packages/services/src/ports.ts).

Caller evidence: services/test/http-client.test.ts:30, mail-adapter.test.ts:73, mail-redaction.test.ts:32, scenarios.test.ts:279 -> startControlledMailServer(ports.ts:275) testkit/test/playback.test.ts:515 -> controlled mail server for differential verification services root index.ts:11 -> ports.ts -> static node:http import(:31); ports also supplies adapter seams/runtime defaults

Maintenance effect: Separate mail harness like other provider harness modules; reduces Node test-support reachability and cognitive load of runtime port file, without redesigning provider APIs.

Qualification/retirement gates: Determine supported public export/distribution obligations and whether a compatibility shim reduces actual emitted closure; retain controlled localhost transport and socket/body limits.

## DC-04 — Files ports mix public storage seams and predictable doubles

Disposition: **simplify**. Source: [packages/files/src/ports.ts:177–337](../../../../packages/files/src/ports.ts).

Caller evidence: files/test/helpers.ts:15 -> TestOnlyManualClock/counter/memory stores/fixed principal -> upload/finalize/retention workflow files index.ts:4 -> ports.ts exposes TestOnly classes through public root FS store(upload/fs-blob-store.ts) and upload kernel -> assertSafeBlobKey(ports.ts:165-175) packages/cloudflare/test/assembly.test.ts:730-733 also instantiates files doubles in an assembly test. Public root or compatibility reexport and compile-all source emission may preserve distribution bytes after a file move.

Maintenance effect: Separate test-only implementations into explicit testing surface like identity; avoid mixing unbounded non-atomic state/predictable IDs with runtime seams. No duplicate durable kernel removal proposed.

Qualification/retirement gates: Retain API compatibility until supported export review; verify distribution no longer includes doubles if production closure reduction is objective; never substitute these stores for owner-fenced durable writes.

## DC-06 — Prepared HTTP plan runner repeats metadata then copies shape per row

Disposition: **simplify**. Source: [packages/interfaces/src/envelope/prepared.ts:49–76](../../../../packages/interfaces/src/envelope/prepared.ts); [packages/interfaces/src/envelope/prepared.ts:109–145](../../../../packages/interfaces/src/envelope/prepared.ts).

Caller evidence: conditional csv route -> reviewCsvRows(csv.ts:232) prepare once -> per row runPreparedHttpPlan(:255) -> checkClosedInputs -> checkBoundArguments

Maintenance effect: Use already frozen allowed/required shape directly if compatible; avoid reallocating arrays for every CSV row. Larger removal of descriptive metadata would reduce duplicated representation but needs public consumer review.

Qualification/retirement gates: OperationInputShape already admits readonly arrays (interfaces/src/ports.ts:26-32); canonical checkClosedInputs reads includes/iteration only (envelope/validate.ts:98-122). Direct shape reuse is structurally compatible for prepareHttpPlan-produced ordinary frozen array snapshots. Public structurally supplied/proxy/custom-iterator plans need evaluation/error-order qualification before removing eager spreads. Exported metadata removal remains separately proposed.

## DD-002 — Remove forward-only buildBundleWithHostPhases indirection when its seam is retired

Disposition: **simplify**. Source: [packages/cloudflare/src/preparation/build-adapter.ts:211–221](../../../../packages/cloudflare/src/preparation/build-adapter.ts).

Caller evidence: host.ts:36,362 uses wrapper in real TS deploy; preparation-protocol.test.ts:9,186,211 names wrapper.

Maintenance effect: Caller crosses adapter solely to return buildDeployBundle with same args/result/errors. Direct owner call or temporary export alias; preserve explicit phase APIs separately.

Qualification/retirement gates: Resolve seam future obligation and source/deep-dist consumers; keep compatibility alias if needed. Do not claim removing wrapper removes duplicate phase execution: TS wrapper never calls explicit phases.

## DD-003 — Share held Rust ASCII node accessor prelude

Disposition: **consolidate**. Source: [packages/cloudflare/preparation/src/artifact.rs:88–139](../../../../packages/cloudflare/preparation/src/artifact.rs).

Caller evidence: lib.rs:5-15 registers modules; job.rs:11,469 calls artifact validator in real artifact_path route. Artifact tests import public validator. Modules/release use local ASCII comparison.

Maintenance effect: artifact redefines units_eq/get/as_text/as_num/as_arr/as_obj/as_bool despite canonical input accessors. Import canonical input accessors with local alias get=obj_get; preserve nonempty_text/num_value and domain policy.

Qualification/retirement gates: Preparation HUMAN HOLD: future held-source packet only. Compare lifetime/signature/domain and all prelude consumers; do not broaden ASCII units_eq to general Unicode. nonempty_text is also exact existing accessor reuse; keep num_value and owning validators/error order separate.

## DD-004 — Share held Rust UTF16 JSON string quote mechanism

Disposition: **consolidate**. Source: [packages/cloudflare/preparation/src/artifact.rs:154–207](../../../../packages/cloudflare/preparation/src/artifact.rs).

Caller evidence: artifact.stringify calls escape_json_string; artifact validation uses error JSON interpolation; input json_quote used by render/modules/release; lib crate exports both modules.

Maintenance effect: Two ~47-line match/UTF16 surrogate/control emitters. Canonical input.json_quote; public artifact escape_json_string compatibility alias.

Qualification/retirement gates: Held source authorization; compare exact string domain and public symbol compatibility.

## DD-007 — Consider job-local reuse of import records without merging policy passes

Disposition: **simplify**. Source: [packages/cloudflare/src/deploy/bundle.ts:533–565](../../../../packages/cloudflare/src/deploy/bundle.ts); [packages/cloudflare/src/deploy/bundle.ts:842–918](../../../../packages/cloudflare/src/deploy/bundle.ts).

Caller evidence: Artifact validation scans source, rewrite scans again; final assertWorkerdLoadable scans final staged JS then assertLinksResolve scans same final JS; buildDeployBundle:969-970 imposes whole-map loadability before links.

Maintenance effect: Repeated parse calls but a single parser algorithm; public validators independently decode. Optionally private job-local parsed records for unchanged exact string/path pairs; preserve standalone APIs and full pass order. New cache plumbing may cost more than it saves.

Qualification/retirement gates: Measure parse/caller cost before adding records APIs/cache; no global cache/getter semantic change. Finish all loadability checks before any link check as current; no stale map reuse.

## DD-009 — Prune stale test-only vendor exclusions after relocation verification

Disposition: **delete**. Source: [packages/cloudflare/src/deploy/bundle.ts:184–194](../../../../packages/cloudflare/src/deploy/bundle.ts); [packages/cloudflare/src/deploy/bundle.ts:405–415](../../../../packages/cloudflare/src/deploy/bundle.ts).

Caller evidence: Tracked source inventory contains no packages/state/src/*/work-loader.ts. Fanout test bridge is now packages/work/test/state-fanout/work-loader.ts; receipt test work-loader.ts:1 re-exports the real work/src/receipt/index.ts owning producer, not a standalone relocated test implementation. Both are imported by owning tests. Vendor walk uses state distribution dist tree.

Maintenance effect: Dead-key set/comment consulted for every vendor file despite relocated sources. Delete obsolete set/check/comment only after emitted/installed package closure confirms stale dist cannot introduce historical helpers.

Qualification/retirement gates: Verify TS cleanup/packaged emission does not retain old state dist loader files; other test-only keys remain filtered separately. Do not delete work production observer loader or generic Node-only host exclusion.

## DD-010 — Audit prepared MCP test-only production plan before adoption or relocation

Disposition: **simplify**. Source: [packages/interfaces/src/mcp/prepared.ts:51–201](../../../../packages/interfaces/src/mcp/prepared.ts).

Caller evidence: Only observed prepareMcpPlan/runPreparedMcpPlan consumers are owned-mcp.test.ts. interfaces index/package exports do not expose mcp/prepared subpath. interfaces tsconfig includes source and tests; emitted prototype remains package dist content. Cloudflare VENDOR_TREES does NOT include interfaces; MCP is bundled from mcp/server. No evidence this unimported prepared prototype reaches the staged worker.

Maintenance effect: Plan creates frozen allowed/required/refs/binding metadata, then runner rebuilds shape/set and delegates canonical validators; live ordinary server repeats orchestration and supports derived=null. Either relocate private prototype with tests after obligation review, or use one canonical owned ordinary framing runner after SDK provenance/adoption gates; no performance/caller reduction proven by current layer.

Qualification/retirement gates: Confirm V02.5 programme/source/internal consumer obligation before relocation; SDK provenance before live routing. Preserve shape-only catalog path, derived identity, no defaults, handle separation and error projection.

## DD-012 — Consider sharing environment keyed rejected-promise eviction primitive

Disposition: **simplify**. Source: [packages/cloudflare/src/worker/main.ts:507–522](../../../../packages/cloudflare/src/worker/main.ts); [packages/cloudflare/src/worker/main.ts:563–575](../../../../packages/cloudflare/src/worker/main.ts).

Caller evidence: createMainFetch builds WeakMap store and worker caches; grants uses prodDepsFor, ordinary fetch uses workerFor/buildWorker; memoize used for sibling loads.

Maintenance effect: Two identical WeakMap get/create/identity eviction mechanics; single memoize helper covers non-env promises only. Private keyed memoizer may reduce repeated ~12-line implementation; two named policy callers remain. Benefit small and unmeasured.

Qualification/retirement gates: Inspect factory sync throw domains; maintain promise identity and initialization order; no global env cache. Preserve two distinct WeakMaps and policy-named accessors. Do not Promise.resolve().then(factory): direct sync throws, invocation timing and promise identity change. Extract only if drift reduction exceeds added indirection; no measured benefit.

## DD-015 — Remove statically dominated publication key predicates without dropping gate

Disposition: **delete**. Source: [packages/cloudflare/src/preparation/publication.ts:103–117](../../../../packages/cloudflare/src/preparation/publication.ts).

Caller evidence: PublicationSession stage methods call validateRelativeKey; preparation-publication tests exercise API; no normal prepared deploy call to session at freeze.

Maintenance effect: Backslash rejection happens before absolute gate. Absolute regex /^[A-Za-z]:/ dominates later drive slash regex. Remove key.startsWith(backslash-backslash) and /^[A-Za-z]:[backslash/slash]/ alternatives; retain earlier backslash and broad drive gate.

Qualification/retirement gates: Authorization for held publication helper cleanup; compare error order on all path spellings. Separate existing unresolved metadata/exact-set/verified-state barrier correctness findings from this factual removal.

## DR02 — State owned deep-freeze and data-only path utilities

Disposition: **consolidate**. Source: [packages/state/src/migration/validate.ts:155–168](../../../../packages/state/src/migration/validate.ts); [packages/state/src/mutation/pipeline.ts:231–244](../../../../packages/state/src/mutation/pipeline.ts); [packages/state/src/mutation/crud.ts:51–66](../../../../packages/state/src/mutation/crud.ts). Other exact sites remain in the structured record.

Caller evidence: crud:96-104 freezes definition inputs/by/when; models:611-618 freezes lock/fields/refs; grants:180-182 freezes policy; pipeline:660,1128,1213,1328,1400 freezes hooks/staged/invariant views. Pipeline getDataPath:757,761,822 checks reference paths; migration.validate:356,543,575,727,769 checks staged/live reference rewrites.

Maintenance effect: Four exact freeze implementations and two path readers. Same caller expression/imported helper; one owning implementation per utility removes three freeze and one path body.

Qualification/retirement gates: Introduce private state internal helpers, retain public mutation/policy/migration signatures and caller positions. Keep freeze-after-clone callsites; helper does not authorize freezing arbitrary inputs earlier. Property descriptors/accessors/proxies, exotic objects and Object.freeze errors remain current domain. Do not replace Object.values with descriptor filtering, broaden traversal, or change getter invocation/identity/clone-before-freeze timing. Shared helper preserves actual throw objects and caller namespace.

## DR09 — Shared Node controlled-harness IO leaves; retain scenario state

Disposition: **consolidate**. Source: [packages/services/src/judgments/harness.ts:43–61](../../../../packages/services/src/judgments/harness.ts); [packages/services/src/media/harness.ts:67–85](../../../../packages/services/src/media/harness.ts); [packages/services/src/models/harness.ts:53–71](../../../../packages/services/src/models/harness.ts). Other exact sites remain in the structured record.

Caller evidence: startControlledMailServer in ports:275, SystemOne judgments harness, Ollama models harness and Comfy media harness exported source factories; services scenarios.test.ts:279 onward starts real controlled servers. All four readTextBody bounded at 4,000,000 bytes; sendBody exact among mail/judgments/models, Comfy sendJson string input serializes JSON rather than plain text.

Maintenance effect: Four ~19-line body readers; three sendBody copies; two exact bind/close blocks. Share bounded reader/sendBody leaf; optional common socket shutdown helper only if return log/scenario state remains explicit. Eliminate nested anonymous seed double-counts.

Qualification/retirement gates: Keep available harness exports/subpaths and provider scenario contracts even though observed consumers tests; test-only call is not proof dead. Private Node-only helper imports must stay out of public portable provider adapter/browser graph; ports.ts currently owns harness support too.

## DV01 — Delegate numeric special cases to the existing ryu-js formatter

Disposition: **simplify**. Source: [packages/values/semantics/src/representations/numeric.rs:319–334](../../../../packages/values/semantics/src/representations/numeric.rs); [packages/work-kernel/decisions/numeric_text.rs:5–19](../../../../packages/work-kernel/decisions/numeric_text.rs).

Caller evidence: [packages/values/semantics/src/numeric/decimal.rs:200](../../../../packages/values/semantics/src/numeric/decimal.rs): format_scale -> shared formatter [packages/values/semantics/src/numeric/money.rs:268](../../../../packages/values/semantics/src/numeric/money.rs): format_non_string -> formatter [packages/values/semantics/src/representations/numeric.rs:309](../../../../packages/values/semantics/src/representations/numeric.rs): make_date invalid number diagnostic [packages/work-kernel/decisions/rows.rs:236](../../../../packages/work-kernel/decisions/rows.rs): js_num -> numeric_text::string [packages/work-kernel/conformance/registered-native.rs:16](../../../../packages/work-kernel/conformance/registered-native.rs): registered conformance consumes string

Maintenance effect: Same pinned ryu-js already owns signed zero/nonfinite String text. Minimum wrapper removes duplicate branches without moving host calls or introducing shared cross-package runtime.

Qualification/retirement gates: Switch to Buffer::format, preserve allocation/String versus JSON distinction; finite exact corpus and supported target qualification before removal.

## DV02 — Replace private number forwarding functions with channel-specific imports

Disposition: **simplify**. Source: [packages/work-kernel/decisions/rows.rs:235–242](../../../../packages/work-kernel/decisions/rows.rs); [packages/work-kernel/decisions/receipt.rs:212–219](../../../../packages/work-kernel/decisions/receipt.rs); [packages/work-kernel/decisions/linkage.rs:213–220](../../../../packages/work-kernel/decisions/linkage.rs). Other exact sites remain in the structured record.

Caller evidence: [packages/work-kernel/decisions/rows.rs:250](../../../../packages/work-kernel/decisions/rows.rs): js_stringify number -> JSON-channel alias [packages/work-kernel/decisions/receipt.rs:919](../../../../packages/work-kernel/decisions/receipt.rs): receipt revision diagnostic -> String alias [packages/work-kernel/decisions/linkage.rs:1341](../../../../packages/work-kernel/decisions/linkage.rs): receipt join mismatch String [packages/work-kernel/decisions/recovery.rs:1236](../../../../packages/work-kernel/decisions/recovery.rs): related-progress revision diagnostic String

Maintenance effect: Replacing zero-policy aliases with imports named string/json_token removes forwarding definitions; no reduction in caller parameter count, modest navigation benefit only.

Qualification/retirement gates: Keep two clearly named channels and module-local name collisions/errors; use alias import if clearer.

## DV03 — Consolidate only qualified same-domain Work UTF16 leaf helpers

Disposition: **consolidate**. Source: [packages/work-kernel/decisions/rows.rs:43–234](../../../../packages/work-kernel/decisions/rows.rs); [packages/work-kernel/decisions/receipt.rs:19–210](../../../../packages/work-kernel/decisions/receipt.rs); [packages/work-kernel/decisions/linkage.rs:49–211](../../../../packages/work-kernel/decisions/linkage.rs). Other exact sites remain in the structured record.

Caller evidence: [packages/work-kernel/decisions/rows.rs:253](../../../../packages/work-kernel/decisions/rows.rs): js_stringify uses escape helper [packages/work-kernel/decisions/lib.rs:3](../../../../packages/work-kernel/decisions/lib.rs): package registration explicitly retains namespaced profiles [packages/work-kernel/rust/lib.rs:5](../../../../packages/work-kernel/rust/lib.rs): public decisions registration

Maintenance effect: Candidate shared code-unit escaping/enumeration helper would reduce copied mechanism drift while leaf value/error wrappers preserve caller signatures. Whole value-model merge would add conversion burden and is HOLD.

Qualification/retirement gates: HOLD type unification; isolate only same-input/output helpers after corpus profile comparison; retain lossless UTF16, numeric bit semantics, key ordering, failure layer, clone/reference identity.

## DV04 — Consider one retry predicate with leaf-owned errors and public types

Disposition: **consolidate**. Source: [packages/work-kernel/decisions/retry.rs:55–116](../../../../packages/work-kernel/decisions/retry.rs); [packages/work-kernel/decisions/lifecycle.rs:89–132](../../../../packages/work-kernel/decisions/lifecycle.rs); [packages/work-kernel/decisions/recovery.rs:128–173](../../../../packages/work-kernel/decisions/recovery.rs).

Caller evidence: [packages/work-kernel/decisions/retry.rs:173](../../../../packages/work-kernel/decisions/retry.rs): compute_backoff -> policy validation [packages/work-kernel/decisions/lifecycle.rs:229](../../../../packages/work-kernel/decisions/lifecycle.rs): record_outcome -> validation [packages/work-kernel/decisions/recovery.rs:654](../../../../packages/work-kernel/decisions/recovery.rs): recovery scan -> contextual validation

Maintenance effect: Same numeric predicate can have one internal semantic core with leaf-owned adapters; caller ergonomics only improve if existing policy signatures/errors remain intact. No adapter framework warranted.

Qualification/retirement gates: HOLD until exact field/default/failure classification equivalence reviewed; preserve first failure order and what-prefix RecoveryError versus receipt PolicyError/LifecycleError.

## DV05 — Consider aliasing the public wire forwarding facade

Disposition: **simplify**. Source: [packages/values/src/wire.ts:1–13](../../../../packages/values/src/wire.ts).

Caller evidence: [packages/values/src/internal/schema-core.ts:104](../../../../packages/values/src/internal/schema-core.ts): schema reuses private conversion core [packages/values/src/prepared/codec.ts:119](../../../../packages/values/src/prepared/codec.ts): prepared gate delegates to same core [packages/values/src/prepared/validation.ts:32](../../../../packages/values/src/prepared/validation.ts): comparator calls public legacy facade

Maintenance effect: Conditional export aliases could remove one forwarding frame while keeping module boundary; consumers keep public names/import paths. Benefit is small and public function identity/name/error stacks may matter.

Qualification/retirement gates: Retain public names, signatures, import paths, freeze/error/evaluation behavior. HOLD until function-name/identity/stack observation scope resolved.

## DV08 — Retire schema lineage WeakSet only after its test/future gate is retired

Disposition: **delete**. Source: [packages/values/src/internal/schema-core.ts:110–115](../../../../packages/values/src/internal/schema-core.ts); [packages/values/src/internal/schema-core.ts:1809–1812](../../../../packages/values/src/internal/schema-core.ts).

Caller evidence: [packages/values/src/internal/schema-core.ts:1811](../../../../packages/values/src/internal/schema-core.ts): every normalizeSchema stores identity [packages/values/test/prepared-hook.test.ts:10](../../../../packages/values/test/prepared-hook.test.ts): imports lineage query

Maintenance effect: Candidate remove unused runtime WeakSet/write if lineage assertion is no longer a future gate; live normalizeSchema has bookkeeping for test-only query. This is a genuine unnecessary state candidate, not plan registry removal.

Qualification/retirement gates: HOLD until explicitly retired lineage gate; preserve normalizeSchema output, owner provenance registry separately; public/external internal-path consumers unresolved.

## DV09 — Separate public Work test doubles from runtime port modules

Disposition: **simplify**. Source: [packages/work/src/ports.ts:139–235](../../../../packages/work/src/ports.ts); [packages/work/src/observation/ports.ts:71–153](../../../../packages/work/src/observation/ports.ts).

Caller evidence: [packages/work/test/schedule.test.ts:24](../../../../packages/work/test/schedule.test.ts): injected memory outbox [packages/work/test/event.test.ts:14](../../../../packages/work/test/event.test.ts): memory occurrence port injection [packages/work/src/dispatch/t32b-fence.test.ts:38](../../../../packages/work/src/dispatch/t32b-fence.test.ts): fence memory supersession

Maintenance effect: Move implementation to explicit test-support module only if public compatibility permits; clarifies shipped ownership while preserving consumer tests via reexport/deprecation. No reason to merge different stores/grant behaviors into generic engine.

Qualification/retirement gates: HOLD export retirement; determine package entry export reach and external consumers; keep port interfaces in owner.

## DC-05 — Three deep JSON walkers and weaker staging probe

Disposition: **retain**. Source: [packages/state/src/receipt/tables.ts:172–214](../../../../packages/state/src/receipt/tables.ts).

Caller evidence: receipt tables.ts:335,376 -> checkJsonSafe for durable receipt data services script admission(:217,:288,:339,:408) -> checkJsonSafe; playback script admission(:329,:419,:495,:547) -> playbackJsonSafe state effects/staging.ts:114,177 and mutation/pipeline.ts:1098,1172,1275 -> internal checkJsonSafe after clone

Maintenance effect: Scenario/playback walker reuse is part of DC-02. Extracting a universal JSON policy would reduce line duplication but adds error/profile plumbing and risks domain conflation; retain owner checks pending domain evidence.

Qualification/retirement gates: Inventory persisted/sink inputs and expected observations before changing any policy. Do not mechanically replace internal probe with replay serializer or receipt validator.

## DC-07 — Transaction/invoker forwarding wrappers and separate join ports

Disposition: **retain**. Source: [packages/state/src/ports/transact.ts:53–106](../../../../packages/state/src/ports/transact.ts); [packages/state/src/ports/transact.ts:132–146](../../../../packages/state/src/ports/transact.ts).

Caller evidence: cloudflare/runtime/invoke.ts:3493 -> createReadInvoker -> invokeRead cloudflare/runtime/invoke.ts:3674 -> createDispatchJoinPort -> assertDispatchJoin -> storage.commit state/test/ports/transact.test.ts:29,92 -> createTransactionPort/createInvoker; state/test/fanout/test-driver.ts:149 and work/test/state-fanout/t34-f5-progress.test.ts:148 -> createFanoutChildJoinPort

Maintenance effect: Binding store/registry/membership/clock once removes per-call plumbing. Join ports enforce batch co-commit at authority boundary. Deduplicating small try/catch forwarding adds closure/helper indirection with little caller simplification.

Qualification/retirement gates: Future wrapper removal needs supported API retirement review and actual call-site complexity comparison. Preserve public types and owning transaction boundary.

## DC-08 — CSV wrappers retain advisory and authoritative outcomes around one library parser

Disposition: **retain**. Source: [packages/ui/src/csv/grammar.ts:1–71](../../../../packages/ui/src/csv/grammar.ts); [packages/ui/src/csv/parse.ts:114–124](../../../../packages/ui/src/csv/parse.ts).

Caller evidence: ui advisory parseCsvText -> parseCsvGrammar -> csv-parse/browser/esm/sync HTTP csv handler(csv.ts:440) -> authoritative parseCsvText -> same grammar; route injection(http/routes.ts:151-152)

Maintenance effect: Already removed duplicate handwritten CSV scanner; thin adapters map errors and preserve authority. Removing wrappers would save few lines while expanding caller error branching.

Qualification/retirement gates: Retain authoritative server reparse and outcome classes; no further parser abstraction without demonstrated caller duplication.

## DC-09 — Log-object and provider-message redaction are different sink policies

Disposition: **retain**. Source: [packages/interfaces/src/errors/redact.ts:21–84](../../../../packages/interfaces/src/errors/redact.ts).

Caller evidence: interfaces errors/logging.ts:48,74 -> redactForLog -> keyed clone before logger mail/adapter.ts:36, models/ollama.ts:50, media/comfyui.ts:51 -> specificOrGeneric/deliveryError -> safe provider-facing completion

Maintenance effect: One shared generic redactor would add input/sink profile switches and may weaken privacy; retain reusable helper per actual sink.

Qualification/retirement gates: Any consolidated privacy API requires explicit sink-domain proof and independent negative secret traces; no new policy adopted.

## DC-10 — Native comparison and AbortSignal.any adapters contain required policy only

Disposition: **retain**. Source: [packages/identity/src/sessions/comparison.ts:1–7](../../../../packages/identity/src/sessions/comparison.ts).

Caller evidence: tokens.ts:74 -> timingSafeEqualBytes -> conditional package #identity-byte-compare native host leaf services HTTP client.ts:292,355,427 -> startDeadline -> AbortSignal.any and private timeout controller

Maintenance effect: Old handwritten native-comparison/abort listener algorithms have already been replaced. Minimal wrappers carry length admission/host selection and deadline classification, not duplicate primitives.

Qualification/retirement gates: Retain source-qualified host receipts boundaries; source audit does not claim fresh runtime qualification.

## DD-005 — Retain current raw source-map compatibility adapter after codec adoption

Disposition: **retain**. Source: [packages/cloudflare/src/runtime/sourcemap.ts:50–161](../../../../packages/cloudflare/src/runtime/sourcemap.ts).

Caller evidence: runtime.sourcemap lookup consumed by invoke diagnostics; deploy.composeModuleMap uses decodeMappings then remapping; compiler decoder independently uses sourcemap crate.

Maintenance effect: Library owns numeric VLQ parse; adapter validates envelope/error namespace, per-segment source order, signed overflow, cumulative coordinates and raw last-duplicate lookup. Whole-line codec/trace replacement removes adapter lines but changes sorting/overflow/lookup; not currently equivalent.

Qualification/retirement gates: A changed raw-map profile would be a separate consequential choice with evidence; not selected. Preserve installed codec worker staging and host-only remapping separation.

## DD-006 — Retain import policy adapter and distinct CommonJS loadability scanner

Disposition: **retain**. Source: [packages/cloudflare/src/deploy/module-imports.ts:62–243](../../../../packages/cloudflare/src/deploy/module-imports.ts).

Caller evidence: bundle artifact/runtime/vendor rewriting and link/fileURL validation call same scanModuleImports; assembleModules imports shared rewrite/validation; CLI uses buildDeployBundle.

Maintenance effect: One es-module-lexer import record route; local masking scanner remains for free require/module.exports/exports and Bun __commonJS wrappers. Using import lexer alone would delete executable CommonJS validation; generic AST parser could remove masking only after finite producer/runtime qualification.

Qualification/retirement gates: Retain accepted import adapter; any AST replacement requires measured benefit versus added parser/projection cost. Do not conflate local CommonJS scanner with duplicate ESM scanner.

## DD-008 — Keep TS/native preparation coexistence while native remains held

Disposition: **retain**. Source: [packages/cloudflare/src/preparation/host.ts:492–647](../../../../packages/cloudflare/src/preparation/host.ts).

Caller evidence: CLI platform.ts:394,404 explicitly runs TS prepared helpers. Native helpers only observed in preparation-protocol tests. driveSession Begin supplies mode; job artifact_path absence uses scaffold. Rust modules are public lib members/integration-test algorithm paths, not called by current job stages.

Maintenance effect: Rust older import scans/rewrite coexist with accepted TS lexer/MagicString/map composition; real Rust job handles artifact/compatibility/release stages but lacks full TS delivery closure. Do not remove TS or auto-select native. Future retire or port legacy Rust modules only after native policy/adoption decision and exact shared behavior qualification.

Qualification/retirement gates: Human releases HOLD; complete real Begin artifact_path host driver and stage handlers, full build/deploy/render/publication closure. Native uses accepted decoded import ranges/dynamic policies and transformed map semantics or separately selected compatible design. Differential fixtures and actual native/package/installed/host/CLI consumer qualification; no replay/fallback after effects; release/readiness provenance and publication barrier.

## DD-011 — Retain Worker production loaders/injected seams; avoid generic loader framework

Disposition: **retain**. Source: [packages/cloudflare/src/worker/main.ts:162–181](../../../../packages/cloudflare/src/worker/main.ts); [packages/cloudflare/src/worker/main.ts:254–454](../../../../packages/cloudflare/src/worker/main.ts).

Caller evidence: worker/main default export creates createMainFetch; default loaders import staged artifact/MCP/HTTP/derived inputs/runtime deps; tests inject MainLoaders. Env loaders used by real buildProductionDeps then ensure state/identity schemas.

Maintenance effect: Several similar import+shape/error helpers with source-relative import semantics and distinct required/optional/fallback obligations. Tiny shared formatting/shape primitive possible, but transferring dynamic import into helper changes relative base. Table-driven generic loader expands configuration and hides policy.

Qualification/retirement gates: Any consolidation must import at caller module or use explicit absolute URL and retain lazy stage/error contract. Do not infer defaultLoadProductionDeps or mirror interfaces speculative from injection alone.

## DD-013 — Retain staged validation and serve-time compatibility at distinct ingress boundaries

Disposition: **retain**. Source: [packages/cloudflare/src/worker/main.ts:429–453](../../../../packages/cloudflare/src/worker/main.ts); [packages/cloudflare/src/worker/main.ts:525–528](../../../../packages/cloudflare/src/worker/main.ts).

Caller evidence: default or injected staged loader -> validateStagedDeployment before buildProductionDeps/DDL -> assembleWorker deep compatibility/serving gate. assembleWorker also exported directly and used by local run.

Maintenance effect: Repeated object/array checks at outer stage and deeper artifact boundary. Deleting outer checks permits effects before malformed stage detection; deleting inner checks loses direct-public-caller protection.

Qualification/retirement gates: Consolidate only truly exact structural leaf predicates with unchanged call locations; no validation omission.

## DD-014 — Retain structural dispatch/fanout seams as conditional exported obligations

Disposition: **retain**. Source: [packages/cloudflare/src/worker/assembly.ts:1462–1512](../../../../packages/cloudflare/src/worker/assembly.ts); [packages/cloudflare/src/worker/assembly.ts:1530–1570](../../../../packages/cloudflare/src/worker/assembly.ts).

Caller evidence: Direct uses of assembleDispatchCommands and assembleFanoutServingSurface observed in colocated Cloudflare runtime conformance tests. Runtime invoke documents seam but does not call function. worker/assembly package export exposes them; injected real state/work producers underlie tests.

Maintenance effect: Commands adds ordering/empty/duplicate guards/freeze; fanout seam validates six functions/freeze. Relocate only after owning programme/API obligation retirement; inline would duplicate gate in each injected caller. Do not describe current tests as live production driver wiring.

Qualification/retirement gates: Trace future deploy driver wiring and public ABI obligations; keep source-ready distinct from live/default serving.

## DD-016 — Retain finite CLI parser until builtin adapter demonstrates actual complexity reduction

Disposition: **retain**. Source: [packages/cloudflare/src/cli/platform.ts:118–197](../../../../packages/cloudflare/src/cli/platform.ts).

Caller evidence: can-platform package bin -> platform main parser -> command-specific TS host handlers; no native backend parser selection. Parse is private but CLI spellings/error envelopes public.

Maintenance effect: ~80-line hand syntax parser plus separate command policy; no adopted util.parseArgs duplicate engine. Builtin util.parseArgs adapter needs token spelling/group/terminator/value/error restrictions and command policy; lines saved and caller complexity unmeasured.

Qualification/retirement gates: Finite util.parseArgs comparison using pinned runtime with exact syntax/error profile; replace old parser only after selection, do not layer live engines.

## DR10 — Retain Work TS donor/oracle copies until adoption or explicit cancellation

Disposition: **retain**. Source: [packages/work-kernel/src/rows.ts:1–21](../../../../packages/work-kernel/src/rows.ts); [packages/work-kernel/src/retry.ts:1–8](../../../../packages/work-kernel/src/retry.ts); [packages/work-kernel/src/linkage.ts:1–11](../../../../packages/work-kernel/src/linkage.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/work-kernel/conformance/rows.test.ts:50](../../../../packages/work-kernel/conformance/rows.test.ts): test direct import TS candidate [packages/work-kernel/conformance/retry.test.ts:19](../../../../packages/work-kernel/conformance/retry.test.ts): test direct import [packages/work-kernel/conformance/lifecycle.test.ts:16](../../../../packages/work-kernel/conformance/lifecycle.test.ts): test import [packages/state/src/receipt/join.ts:301](../../../../packages/state/src/receipt/join.ts): real donor reader use after store load [packages/state/src/receipt/tables.ts:409](../../../../packages/state/src/receipt/tables.ts): donor writer validates row [packages/cloudflare/src/deploy/activate.ts:237–251](../../../../packages/cloudflare/src/deploy/activate.ts): conditional injected gates.buildWorkInventory; not kernel import

Maintenance effect: Eliminating two maintained copies eventually reduces drift, but immediately redirecting donors adds direction/error/backend adaptation and removes independent oracle. Exact token matches alone do not make callers simpler. Kernel lifecycle already uses shared retry core internally.

Qualification/retirement gates: Keep donor serving routes until finite profile equivalence, instanceof/error mapping, producer routing, transport/backend/installed joins and retirement notice qualify. If prototype cancelled, review built-file/direct-path consumers and conformance ownership before candidate removal. Preserve state structuredClone-only versus work JSON-safety admission, module-specific errors, UTF16 identity sorting/URI failures, first-fault order.

## DR13 — Retain owning shared contracts and erased type imports

Disposition: **retain**. Source: [packages/contracts/src/values.ts:1–29](../../../../packages/contracts/src/values.ts); [packages/values/src/index.ts:6–7](../../../../packages/values/src/index.ts); [packages/work-kernel/src/rows.ts:23–30](../../../../packages/work-kernel/src/rows.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/work-kernel/src/retry.ts:8](../../../../packages/work-kernel/src/retry.ts): type boundary RetryClass/RetryPolicy [packages/work-kernel/src/lifecycle.ts:8–16](../../../../packages/work-kernel/src/lifecycle.ts): shared erased contract + own retry runtime import

Maintenance effect: Single type owner reduces declarations consumers must maintain; removing shared contract package would duplicate shapes or redirect dependencies. These are not runtime wrappers or duplicate executable state.

Qualification/retirement gates: Keep ownership derived from declarations; assess declarations at draft/adopted stage and do not equate type erasure with dead public API. Preserve runtime const/version checks if changing source packaging.

## DV06 — Retain stdlib explicit public assembly

Disposition: **retain**. Source: [packages/stdlib/src/index.ts:22–251](../../../../packages/stdlib/src/index.ts).

Caller evidence: [compiler/src/codegen/js.rs:1357](../../../../compiler/src/codegen/js.rs): generated source imports selected builtins [packages/cloudflare/src/runtime/modules.ts:66](../../../../packages/cloudflare/src/runtime/modules.ts): runtime stdlib URL mapping [packages/cloudflare/src/deploy/bundle.ts:179](../../../../packages/cloudflare/src/deploy/bundle.ts): vendor stdlib staging

Maintenance effect: One generated import surface reduces compiler/caller package knowledge. Reexports are assembly, not duplicate arithmetic. Missing choose/invocation/state assembly remains separate gap.

Qualification/retirement gates: Keep owning producer declarations and actual emitted name contract; no runtime algorithm or extra synonym layer.

## DV07 — Retain prepared admission and whole-call oracle traces

Disposition: **retain**. Source: [packages/values/src/prepared/validation.ts:49–232](../../../../packages/values/src/prepared/validation.ts); [packages/values/src/prepared/validation.ts:434–456](../../../../packages/values/src/prepared/validation.ts); [packages/values/src/prepared/validation.ts:506–604](../../../../packages/values/src/prepared/validation.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/values/src/prepared/validation.ts:456](../../../../packages/values/src/prepared/validation.ts): one canonical validation core after admission [packages/values/src/prepared/validation.ts:518](../../../../packages/values/src/prepared/validation.ts): prepared comparator executes prepared route [packages/values/test/legacy-validation-traces.test.ts:124](../../../../packages/values/test/legacy-validation-traces.test.ts): whole-call comparison witness

Maintenance effect: Owner/liveness/coverage admission and getter-safe trace comparison add different outcomes, not second arithmetic/validation implementation. They do not reduce production caller complexity currently; retirement requires gate decision.

Qualification/retirement gates: No default adoption claim. Keep one canonical core; retain comparison/oracle while replacement requires whole-call evidence.

## DV10 — Retain transport admission separately from semantic validation

Disposition: **retain**. Source: [packages/values/semantics/src/transport/exact.rs:49–183](../../../../packages/values/semantics/src/transport/exact.rs); [packages/values/semantics/src/transport/exact.rs:271–286](../../../../packages/values/semantics/src/transport/exact.rs); [packages/values/bindings/validation.ts:43–68](../../../../packages/values/bindings/validation.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/values/semantics/src/transport/exact.rs:872](../../../../packages/values/semantics/src/transport/exact.rs): handle_line decodes carriers [packages/values/bindings/backend.ts:99](../../../../packages/values/bindings/backend.ts): host serializes tagged args to caller-supplied exact glue [packages/values/test/validation-binding.test.ts:30](../../../../packages/values/test/validation-binding.test.ts): injected structural glue

Maintenance effect: ABI/shape checks protect transport; semantic core owns numeric/currency/range validation. They are different rejection layers and callers. Coalescing exact/scaffold generic backend obscures distinct error envelopes and operation profiles.

Qualification/retirement gates: Keep one arithmetic/validation semantic core per selected route and explicit transport admission; preserve malformed-carrier versus native failure distinctions, finite f64 bits.

## DV11 — Retain explicit TS/native alternatives until original retirement gates pass

Disposition: **retain**. Source: [packages/values/src/int.ts:1–93](../../../../packages/values/src/int.ts); [packages/values/semantics/src/numeric/integer.rs:1–86](../../../../packages/values/semantics/src/numeric/integer.rs); [packages/work-kernel/src/rows.ts:1–55](../../../../packages/work-kernel/src/rows.ts). Other exact sites remain in the structured record.

Caller evidence: [packages/values/bindings/backend.ts:46](../../../../packages/values/bindings/backend.ts): explicit no-bootstrap TS route [packages/values/bindings/backend.ts:88](../../../../packages/values/bindings/backend.ts): explicit Wasm route [packages/work-kernel/rust/lib.rs:1](../../../../packages/work-kernel/rust/lib.rs): producer/backend joins retain release gates

Maintenance effect: TS/Rust duplication is deliberate oracle/backend coexistence. Deleting TS now would break public/default route; Work prototype has no implemented producer transport to take over. One canonical arithmetic implementation per adopted route remains goal after qualification.

Qualification/retirement gates: HOLD retirement until matched registry/profile/whole-call tests, owner routing/bootstrap/installed deployment and release notices; retained oracles remain until replacement proves outcomes.
