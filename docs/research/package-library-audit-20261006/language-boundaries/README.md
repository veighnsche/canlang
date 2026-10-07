# TS, Rust and Wasm ownership audit

Planning-only audit at `b40b59e32381465faacb387df4a2ae73b0654b74`.
Implementation remains deferred. The package inventory is fully crosswalked;
finite native surfaces are enumerated rather than inferred from package names,
Cargo registration, `cdylib`, generated assets or test counts.

The current product owners remain TS. Values has a real opt-in exact Wasm path;
Work has implemented, registered Rust decision candidates without a product ABI;
native preparation has a real decision prefix beside a scaffold driver, while the
normal CLI remains TS. These are different stages, with different acceptance.

## Defining implementations and the smallest supported boundary

| Responsibility | Defining implementation and current caller | Smallest source-supported boundary | Unfinished consumer gates |
| --- | --- | --- | --- |
| Exact values arithmetic, aggregates, scalar codecs and temporal decisions | Public values/stdlib operations still use `values/src`. `semantics/src/transport/exact.rs` dispatches 69 implemented Rust operations. The explicit host TS registry covers six, not 69. | Caller-selected `ExactBackend.call(op,args)` over admitted owned values, private tagged marshalling and wasm-bindgen; common qualified host vocabulary is six operations. No automatic public API delegation. | Complete selected registry/family coverage, arbitrary-input admission and error projection; actual application consumers, whole-call benefit, migration/rollback and adoption. A04.5/A05.3/A07/V residuals remain. |
| Contract/default/update/disclosure/operation validation | Canonical validation remains in `values/src/internal/schema-core.ts` and its TS prepared consumers. Native input/owner/plan lifecycle functions are implemented scaffolds. | There is no complete native validation boundary. Host owned input and TS prepared plans are separate from native frame/registry scaffolds. | Real owned-token-to-frame producer, factory-lineage plan serialization, selected native validators, output/error materialization and real consumer authority/default/order gates. |
| Work decisions and state joins | Live TS work/state donors define product behavior. Seven Cargo-registered Rust families expose 86 public functions grouped into 27 finite responsibilities. Extracted TS kernel algorithms are comparison/reference copies; its main export is facts only. | Rust crate-level candidates with distinct leaf value/error profiles. No Work JS/Wasm semantic ABI, generated glue, bootstrap, selected backend or product native route exists. | Demand-shell/provenance and W03.4/W04.4 joins; W05 ABI/installed delivery, W06 real drivers/durable consumers, W07 measurement and W08 migration/rollback. Registration is partial assembly, not whole-port acceptance. |
| Preparation artifact, compatibility and lockstep decisions | The TS build/deploy CLI remains the selected owner. Native `artifact_path` jobs implement artifact acceptance and build lockstep/deploy compatibility+activation prefixes. | Held native process/job prefix over the lossless admitted-tree carrier. Public TS `runNativeJob` sends mode only and reaches the scaffold branch; it does not supply `artifact_path`. | Real Begin/host handlers, retained full stage/refusal order, bundle/plan/review/publication, CLI errors, installed binary integrity/host budgets and explicit release of HUMAN HOLD. |
| JS import rewriting, maps, plan/review and publication | Current TS import/map libraries and TS deploy pipeline own real preparation. Native modules/plan/render/review algorithms exist but the native job does not call them. | Keep the complete JS import/edit/map mechanism together in TS. Native algorithm presence creates no new consumer. | Any future host-derived fact/native decision seam needs exact stage/bytes/order parity. Publication helpers need reviewed-to-published immutable bytes/exact-set/lifetime gates; their API presence is insufficient. |
| Glue and asset delivery | Values owns its generated glue/bootstrap; Cloudflare owns opt-in asset collection, typed binary staging and local host delivery. | Asset collection/staging transports bytes; only an explicit owning bootstrap initializes a backend. | Selected package/archive/application routes, exact source/glue/binary identity and supported host claims. Asset availability does not select a backend. |
| UI and testkit | UI renderer/browser code and testkit runner remain TS. Testkit's dependency-free Rust version/add fixture is loader capability evidence. | No UI native renderer or testkit native semantic core is implemented. | Real browser mount/start/lifecycle and emitted-suite consumers retain their own product gates. Fixture Wasm cannot qualify values, validation, Work or renderer adoption. |
| Remaining package duties | Contracts, files, interfaces, identity, services, state and stdlib retain their recorded TS/type/host owners, with caller stages carried forward. | No additional Can-owned Rust backend was found. Native host primitives/libraries do not constitute a package port. | Existing authority, durable, installed and application gates remain at their declared scope. No no-caller result authorizes public API removal. |

See [values](values.json), [Work](work.json) and
[preparation/UI/testkit](preparation.json) for operation-level defining sources,
registration, representations, caller anchors and original gate crosswalks.
[Responsibility coverage](coverage.jsonl) maps all 316 prior responsibility IDs;
[file coverage](file-coverage.tsv) preserves the 395-file inventory. This is not a
claim that every possible JS input or every branch has been runtime qualified.

## Conversion and error costs that cannot be hidden

- The exact JSON channel and the structural lossless channel are different.
  Exact bigint parts use decimal strings; scalar carriers reconstruct through
  public TS constructors. Ordinary numeric `-0` is erased by JSON, Decimal
  scale `-0` is explicitly refused, and Rust `String` cannot carry lone UTF-16
  surrogates. Structural frames preserve UTF-16 units and f64 bits but reject
  NaN and do not execute validation. One generic serializer would conceal these
  domain differences.
- Host tagging reads guards/properties/entries and visits arrays. It does not
  reproduce arbitrary prototypes, proxies, getters, cycles, sparse arrays,
  symbols or alias identity. The ordinary host producer emits unique record keys;
  direct exact transport permits duplicate entries with first-read/native versus
  last-reconstructed/JS behavior. Treat those profiles separately.
- Six shared operation names are an intersection, not an equal arbitrary-input
  interface. TS may ignore surplus arguments; native dispatch checks arity, and
  Wasm tags all arguments before native evaluation. Exact arities and admitted
  plain-owned carriers delimit the existing proof; a token admission gate does
  not enforce that whole profile in this adapter today.
- The Wasm host adapter projects native scalar decode violations to a generic
  construction error. Glue traps, JSON parse failures and some coercion/startup
  failures remain raw; comments promising universal typed startup errors are
  broader than the implementation. Selection/refusal and exception propagation
  require their own witnesses; there is no automatic retry into TS after a job.
- TS prepared-plan registration and native owner/plan registration are separate
  registries. Native supplied factory/revision strings do not prove TS factory
  lineage. Retirement/live-count behavior differs. Lifecycle scaffolding cannot
  be credited as validation or request authority.
- Work families intentionally use different clone/value/error profiles.
  Random, derivation, supplier and evidence callbacks are demand-ordered. Native
  `Fn`/trait signatures are not a JS/Wasm callback or thrown-value contract.
  Already-demanded planning facts cannot replace later act-time evidence,
  membership, revision, authority or conditional commit checks.
- Native preparation preserves a tagged UTF-16/number-bit tree through framed
  IPC, but its current deploy prefix refuses at a different stage from the full
  TS pipeline. Resolver executable checks are separate from manifest verification;
  the resolver does not call that verifier. Native helpers cannot certify installed
  executable integrity or reviewed/published bytes by existing.

## Retained evidence and corrections

The current committed values Wasm is `f5870905…` (653133 bytes). The older
`bootstrap-current.json` receipt names `b0d44d9…` (622216 bytes); it retains only
its old finite credit. Later Step9 exact-source regeneration, reproducibility,
installed consumer and workerd receipts name the current binary, and Step12
independent review reconciles them. Retain that **finite six-operation opt-in
consumer and structural scaffold** credit. No fresh runtime was run here; prior
private raw runtime paths are not assumed available for replay. The BUILD
inventory alone contains source filenames without source-content/Cargo digests;
separate matching source receipts supply the narrow historical correspondence.

The Work registration/conformance receipt retains its finite Rust/TS comparison
credit. It is not a production Wasm, durable driver, installed or default selection
receipt. Actual selected-receipt consumption now uses the public Work receipt
loader on an exact observer-absence fallback; historical state source-loader
paths are stale. This is a real conditional TS source route, with packaged fallback
closure still unproved: the vendored trees omit Work.

Earlier preparation responsibility chains overstate reach. The real native job
does not invoke native modules/plan/render/review, and only its lockstep release
decision is called; other integrity algorithms are separate. The current executable
resolver is not integrity-checked by the manifest helper. These corrections narrow
caller claims without deleting code or changing any canonical task status.

[Evidence reconciliation](evidence-reconciliation.json) and the independent
[values/preparation](review-values-preparation.json) and [Work](review-work.json)
reviews preserve accepted scope and opposing evidence. Reviews had access to the
initial conclusions; they are independent source challenges, not clean-room audits.

## Conditional simplification direction

For future qualified work, keep one package-owned public TS surface and one selected
semantic implementation per admitted operation. Keep conversion, selection, registry,
initialization and failure projection beside that owner, shared by its real callers.
Choose a synchronous, already-supported operation family before considering a wider
bridge. Do not create a generic cross-package value framework or an adapter per caller.

Values is the first real exact backend seam. Work's first possible native slice is
a small decision over inert, already-demanded facts, while host demand/effects and
live fences remain TS. Preparation should retain the current JS parser/edit/map and
host IO mechanism together; a future native parsed-tree decision seam remains held
and conditional. A completed validation core must precede any native validation
adoption claim. These are proposals, not new accepted designs or mandatory Rust cuts.

Future acceptance must show fewer independently maintained semantics and simpler
real caller paths, not merely more native functions. Measure conversions, calls,
registries, error paths, lifecycle and production code removed against the direct
TS alternative. Keep the existing compatible TS backend until its own retirement
and rollback gates pass. Consequential domain/security/ownership changes require
affected-owner handoff and the repository's balanced JEV process.

## Checks and scope

The three family audits and two finite independent challenges use the user-selected
Sol high. This is justified by ABI, representation, callback-order and source/consumer
joins; there is no model-price or runtime benchmark claim. Codex retains synthesis,
source correspondence checks and Git. Compiler work and shared decisions are preserved.

```sh
python3 docs/research/package-library-audit-20261006/language-boundaries/verify.py --write
python3 docs/research/package-library-audit-20261006/language-boundaries/inspect_artifacts.py
```

Verification reads pinned source, hashes/anchors, maps/registries and static binary
export metadata only. It does not execute package code, compile or instantiate Wasm,
run builds/tests/CI, install, deploy, switch a backend or retire TS. The audit authorizes
no implementation, changes no canonical completion status and advances no filetree
checkpoint. See the [proposal decision record](decision-record.md).
