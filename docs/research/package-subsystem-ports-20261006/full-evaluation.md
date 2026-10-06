# Full evaluation of package subsystem ports

October 6, 2026. Evaluation checkpoint: `011fced78cbb3762ce838066295468bdd23e5b8a`. Values verification started at `2c9da87f6a20b74020f5a63e7abe465189633a93`; the inspected sources were unchanged through the checkpoint. Concurrent work subsequently advanced HEAD; [the source snapshot](evidence/full-evaluation/source-snapshot.json) records file hashes and confirms no changes to the inspected files through `96cf12f5509f96286f171a13e5a1e372f857959f`.

All four candidates are technically credible, but a complete port is more work than translating their algorithms. Arithmetic is the best first Rust experiment. Full wire/schema API parity is the hardest candidate. Work decisions and artifact calculations are smaller cores with less demonstrated payoff. No inspected evidence establishes that any of these is currently a performance bottleneck.

This evaluates existing functionality under `packages/` only. The compiler is outside the migration scope. No Rust implementation, target-runtime prototype or comparative performance benchmark was produced. The work added research and reproducible baseline evidence.

## Comparable ratings

These are engineering judgments about completing a compatible package migration, including the existing synchronous TypeScript interface, host behavior and shipping integration. They are neither success probabilities nor speedup estimates. A plausible design alone does not establish compatibility. Scores 7–8 indicate a tractable bounded port with material integration work; 5–6 indicate substantial unresolved boundary work. Confidence and likely benefit are separate.

| Candidate | Complete package feasibility | Plausible range | Main difficulty | Benefit supported by inspection |
| --- | --- | --- | --- | --- |
| Exact arithmetic, `packages/values` | **7/10** | 6–7 | Raw BigInt domain, carrier/error reconstruction, synchronous Wasm delivery | Clear reusable exact semantics; batched performance is a hypothesis |
| Wire/schema validation, `packages/values` | **5/10** | 4–6 | Observable JS input evaluation, lossless values, defaults/identity and error order | Potential semantic reuse; repeated parsing is real but its workload cost is unknown |
| Recurrence/retry/recovery decisions, `packages/work` | **7/10** | 6–8 | Callback timing, policy mirrors, fenced host integration | Portable decision policies; small calculations offer an uncertain speed benefit |
| Artifact/provenance/compatibility/plans, `packages/cloudflare` | **7/10** | 6–8 | Exact parsing/metadata compatibility and package-owned distribution | Useful if another native tool needs the checks; little evidence of a speed problem |

The earlier 9/7/8/8 estimates were too optimistic about unproved adapters and release integration. Native arithmetic algorithms alone are closer to 8–9; an ordinary inert-DTO validation interpreter is closer to 7–8. Those narrower scopes must not stand in for full exported behavior. The moderate candidates remain package-owned; their label described expected payoff, not implementation difficulty.

Semantic understanding is strongest for arithmetic and the metadata checks. Confidence in target integration is medium at best for every candidate; confidence in speed gains is low for all four. Full unknown-input validation has the greatest design uncertainty.

## Exact arithmetic

**Port boundary.** Move integer algorithms in [int.ts](../../../packages/values/src/int.ts), coefficient/scale algorithms in [decimal.ts](../../../packages/values/src/decimal.ts), money operations in [money.ts](../../../packages/values/src/money.ts), UTC civil-date/duration operations in [temporal.ts](../../../packages/values/src/temporal.ts), numeric aggregates in [array.ts](../../../packages/values/src/array.ts) and their numeric equality rules in [equality.ts](../../../packages/values/src/equality.ts). Locale/ICU, callback-based array helpers and unrelated text operations are separate responsibilities.

The TypeScript façade should keep public signatures, branded carriers, freezing and existing error classes/codes. [The stdlib barrel](../../../packages/stdlib/src/index.ts) reexports these values APIs; MCP schemas also use Decimal parsing and integer bounds. This does not automatically consolidate numeric semantics already implemented in the compiler, because compiler changes are excluded.

**Required behavior.** Decimal coefficients have magnitude below `10^38`, with scale 0–18. Stored zeros and scale matter to construction/range checks even though numeric equality crosses scales. Addition/subtraction align exactly; multiplication rounds half-even only at the prescribed fractional limit; division retains a minimal terminating scale or rounds directly to 18 places. Money validates currency and rounds exact rational arithmetic once. Construction range errors differ from arithmetic overflow. Numeric sums narrow only their final result, allowing cancellation; binary expression chains keep per-operation checks. Minimum-int64 remainder by `-1` is zero. Duration division rejects inexact results.

The public domain is broader than the admitted carriers: `addInt(10^1000, -10^1000)` succeeds, comparisons need not narrow inputs, and Decimal BigInt operand branches accept arbitrary magnitudes. [Money construction](../../../packages/values/src/kinds.ts) also has a structural path that does not itself narrow minor units. Fixed `i64`/`i128` binding arguments would introduce earlier rejection or wrapping.

**Implementation options.** Use Can algorithms with bounded internal carriers and arbitrary-precision scratch/raw operands first. [num-bigint](https://docs.rs/num-bigint/latest/num_bigint/) provides signed arbitrary integers but requires allocation; copying JS BigInt work into Rust does not itself prove faster execution. A signed 256-bit backend such as [bnum](https://docs.rs/bnum/latest/bnum/) is a credible later admitted-value fast path, with an unrestricted compatibility route. The original [arithmetic analysis](README.md#arithmetic-library-comparison) derives the intermediate bounds. Pin and inspect the selected crate API during implementation.

[bigdecimal](https://docs.rs/bigdecimal/latest/bigdecimal/) can represent the domain but still needs custom Can grammar, scale, rounding, overflow and wire behavior. [rust_decimal](https://docs.rs/rust_decimal/latest/rust_decimal/) uses a 96-bit coefficient and cannot cover the full Can coefficient domain. Neither is a drop-in semantic replacement.

Retaining TS is a strong comparator: the algorithms are explicit and JS BigInt already handles exact arithmetic. A selective port of complete aggregates or substantial calculations may amortize conversion better than replacing every scalar operator. A Node native addon avoids Wasm instantiation but adds platform-specific distribution and does not serve Workers. A shared Wasm core has broader reuse and a common binary, with host-specific initialization.

**Migration and gate.** Extract language-neutral fixtures, implement/test the native core, then preserve carriers/errors through a private façade. Compare full scalar and batch calls against TS in Node/Bun and local workerd. Include small normal operands, full-range Decimal operations, wide cancellation, overflow/division failures and aggregates. Adopt only for a demonstrated workload improvement or concrete native reuse requirement. Do not publish a speed claim based on a Rust-only loop.

**Verdict.** Best first Rust prototype; credible complete port, substantial shared integration cost. Arithmetic is suitable because its semantics are explicit, not because Rust automatically beats JS BigInt.

## Wire/schema validation

**Port boundary.** [wire.ts](../../../packages/values/src/wire.ts) owns typed encoding/decoding; [schema.ts](../../../packages/values/src/schema.ts) owns normalization and contract/operation traversal; [types.ts](../../../packages/values/src/types.ts) parses runtime type IDs. These are package APIs used with supplied runtime values and dynamic invocation type strings. Their existence does not imply the compiler failed to parse source types.

An ordered Can validation-plan interpreter is a plausible Rust core. Generic Serde and JSON Schema machinery can transport data or supply primitives, but not replace create/update omission, default insertion, ref/version rules and ordered Can violations. JSON Schema's default is an annotation rather than an instruction to insert missing values. [JSON Schema documentation](https://json-schema.org/understanding-json-schema/reference/annotations).

**Lower-cost alternative.** Normalized fields already contain type ASTs. Nevertheless leaf validation prints a type ID and calls string-based decoding; union arms also reparse IDs. Package-private AST codec entry points, pre-resolved leaves/arms and schema-owned prepared plans can remove this work in TS without changing the compiler. Public string wrappers and genuinely dynamic invocation IDs must remain checked. Repeated parsing is verified; a meaningful production cost has not been measured.

Do not assume every structurally accepted `NormalizedSchema` came from the freezing factory. The current guard checks structure rather than provenance. Prepare/cache factory-produced immutable schemas internally, while retaining compatible behavior for other accepted inputs. An unbounded caller-controlled global type cache creates its own maintenance/resource problem.

**Full compatibility is the hard part.** Preserve exact numeric wire strings; missing/present-undefined/null distinctions; create-only defaults; update omission and engine-resolved sentinels; trim before bounds; complete array/union elements; recursive mutation-ref versions; secret refusal; unknown-field versus unknown-argument errors; ordered violations and no returned partial result. Preserve shared frozen defaults and empty-array identity, plus carrier/error shapes.

The public `unknown` domain is not merely ordinary parsed JSON. The [source probe](evidence/full-evaluation/values-boundary-probe.mjs) confirms that a known contract getter is read twice and its second value is used; opaque JSON accepts `Date` as an empty object, preserves own `__proto__` data, rejects numeric values and throws `RangeError` on cycles. Text and keys can retain lone UTF-16 surrogates. Array holes, getters and proxies make evaluation order observable. Snapshotting an input once can change behavior even when the snapshot looks equivalent.

[Rust String](https://doc.rust-lang.org/std/string/struct.String.html) stores valid UTF-8; use lossless UTF-16 transport or host-held text where required. [serde-wasm-bindgen](https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/) is useful for controlled DTOs, but its default optional values and map/number conversions need explicit choices. A preserved JS handle alone does not reproduce traversal: the host-read protocol must preserve which reads happen and when. [serde_json::Value](https://docs.rs/serde_json/latest/serde_json/value/enum.Value.html) also needs ordered objects and explicit presence handling.

Host WHATWG URL and Intl/ICU predicates should remain host-mediated initially. Opaque JSON recursion/resource limits are explicitly unresolved in the existing module; changing them is a separate behavior decision. A Rust stack overflow or trap is not equivalent to the current recoverable JS exception.

**Consumer limitation.** Searches found no direct state-package calls to the exported values validators. [State admission](../../../packages/state/src/invocation/admission.ts) has its own generated-input checks. Porting values validation therefore does not automatically replace state admission or accelerate writes.

**Migration and gate.** Compare prepared TS first. Register ordered plans once for ordinary data; retain compatible public wrappers. Before calling this a full validation port, demonstrate host evaluation ordering, lossless values, identity and errors over the complete API. Retaining TS traversal with Rust leaves is a viable selective migration, but adds crossings and split ownership; it is not completion of the full candidate. If a narrower inert-data API is desired, declare that scope explicitly rather than silently restricting `unknown`.

**Verdict.** High potential for shared semantics, highest compatibility cost. Start with caller measurements and plan preparation; defer a full Rust commitment until the boundary protocol is specified and demonstrated.

## Recurrence, retry and recovery decisions

**Port boundary.** Select [schedule/every.ts](../../../packages/work/src/schedule/every.ts), pure rules in [receipt/index.ts](../../../packages/work/src/receipt/index.ts) and data-driven planners in [recovery/index.ts](../../../packages/work/src/recovery/index.ts): slot calculation/coalescing/identity, classification/backoff/outcomes, stale claims, recovery/fanout decisions and related-progress resume. Keep database suppliers, scan/drain orchestration, membership/authorization, dispatch execution and durable fenced application with their owners.

**Existing integration is mixed.** [Kernel commands](../../../packages/work/src/kernel/commands.ts) call `isClaimStale` directly, while parts of retry/every policy are mirrored in command stages instead of calling the corresponding helpers. [The recovery driver](../../../packages/cloudflare/src/runtime/invoke.ts) has an injected planner seam, then rereads evidence and applies fenced actions. Replacing one helper does not automatically consolidate the mirrors or change the full engine. Consolidation is additional package work requiring parity review, not a presumed consequence of Rust.

**Required behavior.** Accepted finite timestamps can be fractional. Keep JS number operations, horizon/expiry boundaries, UTF-16 sorting and exact SHA-256 input bytes, including number spelling and UTF-8 replacement of lone surrogates. New recurrence scopes do not admit an immediate tick; missed slots coalesce; root recurrence remains rejected in favor of explicit record-bound scheduling.

Backoff validates and checks exhaustion before calling randomness; valid non-exhausted calls consume one sample, clamping nonfinite samples to zero. Recovery accesses evidence only for uncertain rows, in input order, before sorting output lists; duplicate claims currently use the last entry. Fanout planning preserves settled/fresh-running/guard/lifecycle/exhaustion ordering. Results and frozen provider payloads can retain opaque host identity. The [work probe](evidence/full-evaluation/work-artifact-probe.mjs) verifies several of these boundary cases.

**Architecture and alternatives.** Use closed policy/time/row snapshots for a batch; retain opaque values as host handles. A staged request/result protocol or controlled host callbacks must preserve demand and exception ordering. Do not eagerly fetch all evidence or randomness merely to make a DTO. Keep storage scans and fenced commits in TS even after porting policy. A snapshot decision cannot prove that its inputs remain current at act time.

Keeping TS and consolidating policy mirrors can deliver the same consistency benefit with less tooling. A Rust policy core makes sense if multiple runtimes need the same decisions or measured large batches justify it. Moving tiny comparisons across Wasm individually is unlikely to be a useful optimization hypothesis. Native-only deployment is insufficient for Worker consumers; sharing the values Wasm delivery infrastructure could reduce later incremental cost.

**Migration and gate.** Start at the injected recovery seam, compare pure plans over identical snapshots and callback traces, then verify the real driver still rereads evidence and fences every mutation. Include stale boundaries, completed children, unknown lifecycle/evidence, duplicate claims, exhausted retries, callback exceptions and plan/action races. Keep existing durable restart/fence suites as required integration gates; the evaluation did not rerun those full durable suites.

**Verdict.** A feasible second-wave policy port with limited proven payoff. Prefer consolidation and a real reuse requirement before adding a second implementation.

## Artifact, provenance, compatibility and plan calculations

**Port boundary.** [runtime/artifact.ts](../../../packages/cloudflare/src/runtime/artifact.ts) validates parsed artifacts/crossrefs and compiled identity. [deploy/compat.ts](../../../packages/cloudflare/src/deploy/compat.ts) computes compatibility and compiler-release comparisons. [deploy/plan.ts](../../../packages/cloudflare/src/deploy/plan.ts) transforms selected resources into a deterministic plan. Existing CLI callers provide a concrete integration point. Reading compiler-produced artifacts does not make this a compiler port.

Keep filesystem/probe wrappers, bundling, installed-runtime discovery, activation, deployment, Wrangler/Miniflare and runtime invocation outside this candidate. Later manifest/release calculations are related optional tranches; the initial score does not cover rewriting the whole platform CLI.

**Required behavior.** Keep first-error precedence, source-path attribution, artifact version/crossrefs, arbitrary JavaScript/source-map text and tolerated additive metadata. `parseArtifactText` returns the parsed object rather than a reconstructed closed DTO. The probe verifies lone-surrogate module text/metadata, artifact-version error precedence and inclusion of the current host JSON parser diagnostic. Rust deserialization errors or blanket unknown-field rejection would differ.

Keep ordered compatibility reasons: contracts, language, capabilities, resource bindings, required secrets, schedules. Preserve resource selection and descriptor order, plain environment variables, unresolved/mismatched-binding failures and bundle main selection. Schedule requirements remain unmapped because the backend selection is unresolved; a port must not invent a cron translation. Node crypto already handles hashing natively, so reimplementing its calls supplies no speed evidence.

**Architecture and alternatives.** Retain host JSON parsing and raw artifact ownership, then pass lossless metadata into a package-owned Rust core. This can preserve host diagnostics and additive output fields while moving semantic checks. A native library/binary is credible if a native consumer needs it; use a batched or persistent process rather than assume per-check subprocess startup is free. Native distribution must cover supported host platforms. A Wasm adapter is another route through the current synchronous TS APIs; it trades a common binary for conversion/loading work.

Pure TS remains the lowest-cost implementation for the existing Node-side CLI. The repository still needs Node/Bun, Miniflare and other package orchestration after these calculations move; this small port does not produce a standalone all-native platform tool. Rust's strongest case here is native reuse, not removal of the current toolchain.

**Migration and gate.** Implement metadata checks against existing fixtures and preserve error/reason/plan order. Compare tiny and large artifacts, valid and invalid multi-error inputs, source-map/generated-text size, host parsing, byte hashes, wrapper startup and actual CLI time. Verify distribution and version mismatch failures. Use plan generation only; do not deploy while testing a port. Adopt if a real native consumer or measured tooling bottleneck outweighs the extra release surface.

**Verdict.** A straightforward metadata core surrounded by meaningful compatibility/distribution work. Technically feasible, lower immediate priority without native tooling demand.

## Shared integration, ownership and upkeep

All ports need a private backend behind unchanged package exports. Select a backend at startup/build time; do not silently retry a failed semantic operation in the other backend. That could repeat getters/callbacks, conceal divergence or change error precedence. Retain a release/build switch to the current TS implementation for rollback until adoption is established. Dual implementations are transitional verification tools, not an assumed permanent maintenance saving.

For Worker-facing candidates, [Cloudflare supports precompiled WebAssembly modules](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/), and [wasm-bindgen supports synchronous initialization](https://wasm-bindgen.github.io/wasm-bindgen/examples/synchronous-instantiation.html). These references establish an available route, not compatibility with this repository's loader. Its current [vendor collection and bundle writer](../../../packages/cloudflare/src/deploy/bundle.ts) collect `.js` text and write UTF-8; [local development](../../../packages/cloudflare/src/dev/local-run.ts) registers every module as `ESModule`; [testkit options](../../../packages/testkit/src/scopes/local.ts) also expose text-only modules.

A shared delivery tranche therefore needs typed text/binary assets, byte-exact output and hashing, Wasm manifest coverage, JS-only import rewriting/source maps, module initialization and failure reporting, and real local workerd tests. Miniflare has a `CompiledWasm` module type. [Miniflare documentation](https://developers.cloudflare.com/workers/testing/miniflare/core/modules/). Native-only artifact tooling can avoid the Worker tranche, but still needs a host interface and supported-platform releases.

Validate raw numbers before fixed-width binding conversions: [wasm-bindgen documents truncation/wrapping conversions](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/numbers.html). JSON serialization is not a general transport for existing BigInts, sentinels or JS object evaluation. Make presence, text encoding, error transport and handle lifecycle explicit; do not treat a generic serializer as a parity proof.

Feature-based internal directories could be:

```text
packages/values/
  Cargo.toml
  semantics/       # exact value algorithms and optional validation plans
  bindings/        # host conversions and initialization
  src/            # current TS API and compatibility façade
  conformance/
  test/
packages/work/
  decisions/      # policy core, only if this candidate proceeds
  src/            # suppliers, commands and public adapters
packages/cloudflare/
  artifacts/      # metadata core, only if this candidate proceeds
  src/            # local tooling, delivery and runtime owners
```

These are proposals, not created source directories. Reconcile them with the living file-tree plan before implementation. Keep public contracts in `packages/contracts`, stdlib assembly in `packages/stdlib`, work policy in `packages/work` and platform assets in `packages/cloudflare`/`packages/testkit`. Rust modules should not become another authority for app composition; `.can` remains the authoring source. No merge or file-tree checkpoint update occurred during this evaluation.

Ongoing cost includes pinned Cargo/binding versions and lockfiles, generated glue and binary integrity, TypeScript declarations, multi-runtime error/debugging support, build/release checks, cross-platform artifacts where native delivery is chosen, and conformance updates whenever Can semantics evolve. Less agent typing does not remove these obligations. Avoid maintaining parallel currency/type/capability catalogs manually; derive or verify them against their current package owners.

## Evidence, limitations and adoption gates

The following selected existing tests passed, **431 tests total**. They validate the current TS baseline, not a port. Raw output is retained under [full-evaluation evidence](evidence/full-evaluation/).

| Verification | Result | Saved evidence |
| --- | --- | --- |
| Values build | Passed | [Build log](evidence/full-evaluation/values-build.log) |
| Values int/decimal/oracle/money/array/schema/wire/conformance | 284 passed, 59 suites | [Test log](evidence/full-evaluation/values-tests.log) |
| Work every/receipt/recovery/fanout decision scans | 69 passed, 19 suites | [Test log](evidence/full-evaluation/work-decision-tests.log) |
| Work related-progress resume | 5 passed | [Test log](evidence/full-evaluation/work-progress-tests.log) |
| Work typecheck | Passed | [Typecheck log](evidence/full-evaluation/work-typecheck.log) |
| Artifact/operations/additive descriptions/compatibility/plans/review/release | 73 passed, 7 files | [Test log](evidence/full-evaluation/artifact-tests.log) |
| Cloudflare package-wide typecheck | Failed with four diagnostics outside selected calculation files | [Typecheck log](evidence/full-evaluation/cloudflare-typecheck.log) |

The Cloudflare diagnostics are `invoke.ts:5911` (`kind` on `never`), `t34-f7-fanout-durable.test.ts:660` (not callable) and `t34-f7-fanout.test.ts:1879,1897` (missing `stageTriggerJoin`). No source changes were made to introduce or fix these baseline errors.

Reproduction commands from the repository root:

```sh
bun run --cwd packages/values build
node --test --test-reporter=spec packages/values/dist/values/test/{int,decimal,decimal-oracle,money,array,schema,wire,conformance}.test.js
node --test packages/work/test/every.test.ts packages/work/test/receipt.test.ts packages/work/test/recovery.test.ts packages/work/src/recovery/t34-f4-scan.test.ts
node --test packages/work/src/recovery/t26-resume.test.ts
bun run --cwd packages/work typecheck
./node_modules/.bin/vitest run packages/cloudflare/test/artifact.test.ts packages/cloudflare/test/artifact-operations.test.ts packages/cloudflare/test/artifact-field-descriptions.test.ts packages/cloudflare/test/compat.test.ts packages/cloudflare/test/plan.test.ts packages/cloudflare/test/review.test.ts packages/cloudflare/test/release.test.ts
bun run --cwd packages/cloudflare typecheck
bun docs/research/package-subsystem-ports-20261006/evidence/full-evaluation/values-boundary-probe.mjs
bun docs/research/package-subsystem-ports-20261006/evidence/full-evaluation/work-artifact-probe.mjs
```

The [values probe results](evidence/full-evaluation/values-boundary-probe.result.json), [work/artifact results](evidence/full-evaluation/work-artifact-probe.result.json) and earlier [wide arithmetic probe](evidence/arithmetic-probe.result.json) preserve targeted observations. These probes do not cover all proxies, malformed schemas, cycles, callback traces or loader behavior. Existing oracle tests check numeric agreement but do not alone prove scale, error or identity parity. Full durable restart/dispatch and compiler suites were not rerun. Values tests were a selected subset, not the entire package suite.

Observed local tools: Node `v24.21.0`, Bun `1.4.2`, Rust `1.99.0`; only `aarch64-apple-darwin` was installed as a Rust target. The absent Wasm target is routine setup, not evidence of a fundamental blocker. No target/tooling installation or production-source implementation was performed.

Every adoption decision needs native and actual-adapter differential checks, target loading/release tests, and representative complete-call measurements. Record TS and optimized-TS baselines, scalar versus batch behavior, cold initialization, steady-state time, conversion/allocation cost, error-heavy workloads, binary/compressed bundle size and memory. Use a suitable local harness for CPU comparison: production Worker performance timers do not advance during CPU execution. [Cloudflare timer behavior](https://developers.cloudflare.com/workers/runtime-apis/performance/).

Profile actual callers before selecting workloads or numeric acceptance thresholds. A claimed reusable Rust core needs an identified consumer; a claimed optimization needs a material workload improvement after all boundary costs. If neither holds, retaining TS is a successful evaluation outcome.

## JEV advice and disagreement review

Three fresh independently worded consultations assessed all four candidates using the same bounded scopes, inspected source facts, baseline tests and alternative next steps. The `score` primitive was appropriate for feasibility and `choice` for ordering the next investigation. Exact [requests](evidence/full-evaluation/request-1.json) and [responses](evidence/full-evaluation/result-1.json), together with variants [2](evidence/full-evaluation/result-2.json) and [3](evidence/full-evaluation/result-3.json), retain full rubrics, distributions and uncertainty. The earlier arithmetic/backend consultations remain separate historical evidence.

The API uses zero-based score levels; the following table adds one to the reported score to display the requested 1–10 scale. These are advisory outputs, not the final engineering ratings or calibrated probabilities of success. Recomputing scores from returned probability entries differs by up to .04, and two returned distributions sum to .99. The table preserves reported values; raw evidence is unchanged. Rounding is a possible explanation, not verified. [TypeSafe score/choice semantics](https://docs.typesafe.ai/api).

| Advisory result | Consultation 1 | Consultation 2 | Consultation 3 |
| --- | --- | --- | --- |
| Arithmetic feasibility | 5.31 | 6.21 | 5.57 |
| Full validation feasibility | 4.44 | 4.71 | 3.68 |
| Work decisions feasibility | 5.63 | 5.67 | 5.35 |
| Artifact calculations feasibility | 6.03 | 5.89 | 6.08 |
| Selected first investigation | TS baseline/profile | Arithmetic prototype | TS baseline/profile |
| Choice probability / confidence | .80 / .74 | .51 / .38 | .67 / .59 |

The consultations were substantially more pessimistic than the initial human estimates. Independent source review agreed that a plausible architecture had been credited too much like demonstrated integration, and revised arithmetic to 6–7 and validation to 4–6 end-to-end. The final table reflects that concern, while recognizing explicit algorithms and known bounded metadata/policy routes. The uncertainty ranges deliberately remain visible; scores should be revised after a real adapter prototype.

We also investigated wording sensitivity rather than presenting consensus. Request 2's high-score wording asks for stronger implementation evidence than the others, partly mixing maturity with difficulty. The top scores received little probability in all three, so that variation does not alone explain the pessimism. The alternatives' emphasis also changes which uncertainty seems most urgent: profiling identifies whether a port is useful, whereas arithmetic prototyping tests binary integration and full-call economics. Repeated TS parsing is verified; its performance benefit from removal is still hypothetical. Neither branch of advice establishes a proven speedup or an obligatory migration order.

No explanatory rationale was returned by JEV, so attributing its scores to a particular loader or JS behavior would be inference. The investigation used source call graphs, existing tests, boundary probes and a second review; probabilities were not averaged or used as an approval threshold. The model was `jev-1.13.0`, with 7,434 reported input and 387 output tokens across this fresh round.

## Recommended next work

1. Identify representative package callers and any concrete native reuse need; establish current and prepared-TS comparators. Do not infer bottlenecks from code size or the presence of parsing.
2. If useful workloads/reuse exist, prototype arithmetic natively and through the actual Wasm façade. Use this to resolve common delivery/conversion costs before committing to other Worker-facing ports.
3. Evaluate validation as a separate compatibility project. Prepared plans are useful in either language; full JS input semantics need a demonstrated host protocol. Do not silently downgrade the public input contract.
4. Consider work decisions after policy mirrors and real consumers are mapped. Consider artifact calculations when native tooling demand or measured CLI cost justifies their distribution. Their order depends on that evidence.

This is a completed evaluation of all four candidates. Migration layouts, Rust APIs, performance gains and adoption remain proposed; the preserved tests and probes verify only the current package behavior.
